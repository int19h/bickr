import type { BotDocument, InferenceAttribution, ThreadDocument } from '@bickr/shared/model';
import type { RunContext, ToolResult } from '../workers/agent-runtime/src/types';
import { onRequestGet as inferenceRedirect } from '../apps/web/functions/inference/[botId]/[runId]/[seq]';
import { serviceRequest } from '../apps/web/functions/api/_proxy';
import { updateBot } from './helpers/coordinator-mutations';
import {
 authCookie, seedWorld, createBotForTest, createForumForTest, botById, readThread,
 botActivityFeedByHandle, worldActivityFeedByHandle, testEnv, testRuntimeForToolExecution,
 createThreadForTest, listThreads, describe, expect, it,
} from './helpers/index-harness';

it('records the originating request for posts, replies, votes, follows, and unfollows through runtime tools', async () => {
 const cookie = await authCookie(); await seedWorld(cookie);
 const actor = await createBotForTest(cookie, 'attributed');
 const other = await createBotForTest(cookie, 'target');
 const forum = await createForumForTest(cookie, 'attribution');
 const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id);
 const runtime = testRuntimeForToolExecution();
 const execute = (runtime as unknown as { executeTool(bot: BotDocument, runId: string, name: string, args: Record<string, unknown>, context: RunContext): Promise<ToolResult> }).executeTool.bind(runtime);
 const attribution: InferenceAttribution = { model: 'vendor/model-a', parameters: { temperature: 0.6, max_completion_tokens: 4000 }, source: { botId: actor.id, botHandle: actor.handle, worldHandle: 'primary', runId: 'run-a', requestSeq: 42 } };
 const context: RunContext = { mode: 'normal', setupMode: 'new_iteration', signal: new AbortController().signal, inferenceAttribution: attribution };
 const text = (text: string) => ({ text, lang: 'en' });
 const post = await execute(bot, 'run-a', 'create_thread', { forumHandle: forum.handle, title: text('Recorded post'), body: text('Generated post.') }, context);
 const thread = (post.result as { thread: ThreadDocument }).thread;
 expect(thread.comments[0]?.inferenceAttribution).toEqual(attribution);
 const reply = await execute(bot, 'run-a', 'reply_to_comment', { commentId: thread.rootCommentId, body: text('Generated reply.') }, context);
 const comment = (reply.result as { comment: { id: string } }).comment;
 await execute(bot, 'run-a', 'vote', { votes: [{ commentId: thread.rootCommentId, value: 1 }], reason: text('Good post.') }, context);
 await execute(bot, 'run-a', 'follow_profile', { targets: [{ username: other.handle, reason: text('Interesting.') }] }, context);
 await execute(bot, 'run-a', 'unfollow_profile', { targets: [{ username: other.handle, reason: text('Changed mind.') }] }, context);
 const stored = await readThread(testEnv.BICKR_KV, thread.id);
 expect(stored.comments.find(item => item.id === comment.id)?.inferenceAttribution).toEqual(attribution);
 expect((await listThreads(testEnv.BICKR_D1, forum.id))[0]?.inferenceAttribution).toEqual(attribution);
 const feed = await botActivityFeedByHandle(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.homeWorldId, actor.handle);
 expect(feed.activities.map(item => item.type).sort()).toEqual(['comment', 'follow', 'thread', 'unfollow', 'vote']);
 for (const activity of feed.activities) expect(activity.inferenceAttribution, activity.type).toEqual(attribution);
 const worldFeed = await worldActivityFeedByHandle(testEnv.BICKR_D1, actor.homeWorldId, 'primary');
 expect(worldFeed.activities.filter(item => item.actor.id === actor.id).every(item => item.inferenceAttribution?.model === attribution.model)).toBe(true);
 // A later configuration change must not rewrite any existing artifact.
 await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id, bot.ownerUserId, { handle: 'renamed-author' });
 const redirect = await inferenceRedirect({ env: testEnv, request: new Request('https://bickr.social/inference/source'), params: { botId: actor.id, runId: 'run-a', seq: '42' } } as never);
 expect(redirect.headers.get('location')).toContain('/u/renamed-author/loop?inference=42');
 expect((await readThread(testEnv.BICKR_KV, thread.id)).comments[0]?.inferenceAttribution).toEqual(attribution);
 const manual = await createThreadForTest(forum.id, actor.id, 'Manual post', 'Manual body');
 expect((await readThread(testEnv.BICKR_KV, manual.id)).comments[0]).not.toHaveProperty('inferenceAttribution');
});

describe('manual service boundary', () => {
 it('does not forward a spoofed attribution header from the browser', () => {
  const request = new Request('https://bickr.social/api/foo', { headers: { 'x-bickr-inference-attribution': '{"model":"spoofed"}' } });
  const proxied = serviceRequest({ INTERNAL_SERVICE_SECRET: 'test' }, request, '/foo', 'user-a');
  expect(proxied.headers.has('x-bickr-inference-attribution')).toBe(false);
 });
});
