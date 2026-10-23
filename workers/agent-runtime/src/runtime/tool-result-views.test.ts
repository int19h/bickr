import { testViewRenderContext } from './result-render-context.test-support';
import { botServiceIssue } from '@bickr/shared/bot-service-issues';
import { providerBatchOutcome } from './batch-outcomes.test-support';
import { toolFailurePayload } from './bot-runtime';
import { interruptedToolSettlement } from './tool-dispatch';
import { resultMessage, unknownOutcomeText } from './result-text';
import { describe, expect, it, vi } from 'vitest';
import type { BotProfileRelationshipSummary, ForumSummary, LanguageTag, ThreadDocument, ThreadSummary } from '@bickr/shared/model';
import type { ToolResultEnvelope, ToolResultReadContentItem } from '@bickr/shared/tool-results';
import { botText } from '../localization';
import { providerSerializationContext as oldSerializationContext, providerToolResultPayload, pruneReadContentTreeForProviderBudget, readResultContext } from './tool-result-golden-builders.test-support';
import { buildToolResultView, renderToolResultView, failureResultView, settlementResultView, batchResultView, type ViewBuildContext } from './tool-result-views';
import { ResultContextScope } from './result-context-scope';

const text = botText('en');
const time = { settings: { mode: 'relative' as const, timezone: 'UTC' }, createdAt: '2026-10-01T00:00:00Z' };
const providerSerializationContext = (text: Parameters<typeof oldSerializationContext>[0], self: Parameters<typeof oldSerializationContext>[1]) => oldSerializationContext(text, self, undefined, time);
const writtenAt = '2026-10-23T10:00:00.000Z';
const en = 'en' as LanguageTag;
const authored = (text: string) => ({ text, lang: en });
const privateData = { futurePrivateField: 'SECRET', ownerUserId: 'SECRET', credentials: 'SECRET' };
const profile: BotProfileRelationshipSummary = { id: 'bot_alice', handle: 'alice', homeWorldId: 'world', homeWorldHandle: 'world', language: null, displayName: authored('Alice'), shortBio: authored('Hello'), createdAt: writtenAt, updatedAt: writtenAt, isFollowedByMe: true, isFollowingMe: false, followers: 3, ...privateData };
const forum: ForumSummary = { id: 'frm_general', worldId: 'world', worldHandle: 'world', handle: 'general', language: null, description: authored('A forum'), createdByUserId: 'SECRET', readOnly: false, createdAt: writtenAt, updatedAt: writtenAt, ...privateData };
const summary: ThreadSummary = { id: 'thr_abc', rootCommentId: 'cmt_root', worldId: 'world', worldHandle: 'world', forumId: forum.id, forumHandle: forum.handle, authorBotId: profile.id, authorHandle: profile.handle, authorDisplayName: profile.displayName, title: authored('A topic'), bodyPreview: authored('A body'), voteScore: 4, commentCount: 2, createdAt: writtenAt, lastActivityAt: '2026-10-23T08:00:00.000Z', ...privateData };
const comment: ToolResultReadContentItem = { type: 'comment', id: 'cmt_root', commentId: 'cmt_root', threadId: summary.id, worldId: 'world', worldHandle: 'world', forumId: forum.id, forumHandle: forum.handle, authorBotId: profile.id, authorHandle: profile.handle, authorDisplayName: profile.displayName, body: authored('The opening body'), createdAt: writtenAt, replies: [], ...privateData };
const read = { operation: 'read_thread_by_id', context: 'Result of my read operation.', contextGuidance: { collapsedReplies: false, trimmedBodies: false }, thread: summary, content: [comment] };
const thread: ThreadDocument = { ...summary, type: 'thread', schemaVersion: 1, revision: 1, comments: [], body: authored('The opening body'), updatedAt: writtenAt } as unknown as ThreadDocument;
const viewed = { ...profile, associatedNoteReaderBotId: 'reader', associatedNoteIds: ['own note'], associatedNoteCount: 1 };
const links = [{ kind: 'participant' as const, entityId: profile.id, handle: profile.handle, deleted: false, ...privateData }];
const cases: { name: string; raw: unknown; envelope: ToolResultEnvelope }[] = [
	{ name: 'list_accessible_forums', raw: [forum], envelope: { kind: 'forums_listed', forums: [forum] } },
	...(['recent', 'hot'] as const).map(order => ({ name: `list_${order}_threads`, raw: [summary], envelope: { kind: 'threads_listed' as const, order, threads: [summary], items: [] } })),
	...['read_thread', 'read_thread_by_id', 'read_comment_by_id'].map(name => ({ name, raw: { ...read, operation: name }, envelope: { kind: 'posts_read' as const, read: { ...read, operation: name }, items: [] } })),
	...['search_threads', 'search_threads_semantic'].map(name => { const post = { threadId: summary.id, commentId: comment.id, forumHandle: forum.handle, title: summary.title, snippet: authored('A snippet'), authorBotId: profile.id, authorHandle: profile.handle, authorDisplayName: profile.displayName, createdAt: writtenAt, score: 1, ...privateData }; return { name, raw: [post], envelope: { kind: 'posts_searched' as const, posts: [post], items: [] } }; }),
	{ name: 'search_profiles', raw: [profile], envelope: { kind: 'profiles_searched', profiles: [profile] } },
	{ name: 'list_profiles', raw: { mode: 'window', offset: 0, limit: 10, total: 1, hasMore: false, profiles: [profile] }, envelope: { kind: 'profiles_listed', page: { mode: 'window', offset: 0, limit: 10, total: 1, hasMore: false, profiles: [profile] } } },
	{ name: 'view_profiles', raw: { profiles: [viewed] }, envelope: { kind: 'profile_viewed', profiles: [viewed] } },
	{ name: 'list_notes', raw: null, envelope: { kind: 'note_listed', ids: ['one'], nextCursor: null, total: 1, unknownFilters: [] } },
	{ name: 'read_note', raw: null, envelope: { kind: 'note_read', id: 'one', content: 'My content', links } },
	{ name: 'write_note', raw: null, envelope: { kind: 'note_written', outcome: 'created', id: 'one', content: 'My content', links, unknownReferences: [] } },
	{ name: 'delete_note', raw: null, envelope: { kind: 'note_deleted', id: 'one' } },
	{ name: 'delete_note', raw: null, envelope: { kind: 'note_reset', id: 'PLAN', content: 'A plan' } },
	{ name: 'create_thread', raw: null, envelope: { kind: 'thread_created', thread } },
	{ name: 'reply_to_comment', raw: null, envelope: { kind: 'comment_created', thread, comment: { id: comment.id, threadId: summary.id } as never } },
	{ name: 'vote', raw: null, envelope: { kind: 'vote_set', votes: [{ commentId: comment.id, value: 1, thread }] } },
	{ name: 'follow_profile', raw: null, envelope: { kind: 'profile_followed', profiles: [{ username: profile.handle, following: true, profile, reason: authored('A reason') }] } },
	{ name: 'unfollow_profile', raw: null, envelope: { kind: 'profile_unfollowed', profiles: [{ username: profile.handle, following: false, profile }] } },
	{ name: 'draw_random_integers', raw: [7], envelope: { kind: 'random_integers_drawn', ranges: [{ min: 1, max: 9 }], numbers: [7] } },
	{ name: 'log_off', raw: { ok: true, status: 'finished' }, envelope: { kind: 'logged_off' } },
	{ name: 'check_notifications', raw: { events: [] }, envelope: { kind: 'notifications_checked', events: [] } },
	{ name: 'view_activity', raw: { bot: profile, activities: [] }, envelope: { kind: 'activity_viewed', feed: { bot: profile, activities: [] } } },
	{ name: 'query_followers', raw: { total: 1, usernames: ['alice'] }, envelope: { kind: 'followers_queried', result: { total: 1, usernames: ['alice'], profile: { id: profile.id, handle: profile.handle }, direction: 'followers', participants: [{ id: profile.id, handle: profile.handle }] } } },
];
const nestedRead = { ...read, content: [{ ...comment, replies: [{ ...comment, id: 'cmt_child', commentId: 'cmt_child', parentCommentId: comment.id, body: authored('A nested reply'), replies: [] }] }] };
cases.push({ name: 'read_thread_by_id', raw: nestedRead, envelope: { kind: 'posts_read', read: nestedRead, items: [] } });
const actor = { id: profile.id, username: 'u/alice', displayName: profile.displayName, ...privateData };
const threadRef = { id: summary.id, title: summary.title, ...privateData };
const commentRef = { id: comment.id, threadId: summary.id, ...privateData };
const post = { ...commentRef, author: actor, text: authored('A reply body'), ...privateData };
const notificationBase = { id: 'notification', createdAt: writtenAt, deliveryReasons: ['direct_reply'] as const };
const notificationPayloads: import('@bickr/shared/model').StoredNotificationEvent[] = [
	{ ...notificationBase, deliveryReasons: ['bootstrap'], kind: 'bootstrap', type: 'bootstrap', bootstrapVersion: 2, world: { id: 'world', handle: 'world' }, customMessage: null, introForum: 'f/general' },
	{ ...notificationBase, deliveryReasons: ['bootstrap'], kind: 'bootstrap', type: 'bootstrap', bootstrapVersion: 1, composedMessage: authored('Welcome') },
	{ ...notificationBase, deliveryReasons: ['personal_forum_post'], kind: 'thread_post', type: 'thread_created', actor, thread: { ...threadRef, author: actor, text: authored('The thread body') } },
	{ ...notificationBase, deliveryReasons: ['direct_reply'], kind: 'reply', type: 'comment_created', actor, thread: threadRef, comment: post, replyTo: { ...post, id: 'cmt_parent', text: authored('The parent body') } },
	{ ...notificationBase, deliveryReasons: ['mention'], kind: 'mention', type: 'comment_created', actor, thread: threadRef, comment: post },
	{ ...notificationBase, deliveryReasons: ['followed_profile_activity'], kind: 'comment_notice', type: 'comment_created', actor, thread: threadRef, comment: commentRef },
	{ ...notificationBase, deliveryReasons: ['vote_on_your_content'], kind: 'vote', type: 'vote_cast', actor, target: commentRef, value: -1 },
	{ ...notificationBase, deliveryReasons: ['profile_followed_you'], kind: 'follow', type: 'profile_followed', actor },
	{ ...notificationBase, deliveryReasons: ['profile_unfollowed_you'], kind: 'unfollow', type: 'profile_unfollowed', actor },
	{ ...notificationBase, deliveryReasons: ['followed_profile_activity'], kind: 'follower_activity_digest', type: 'followed_activity', actor, olderActivityOmitted: false, activities: [{ kind: 'thread', createdAt: writtenAt, thread: threadRef }, { kind: 'comment', createdAt: writtenAt, thread: threadRef, comment: commentRef }] },
	{ ...notificationBase, deliveryReasons: ['direct_reply'], kind: 'legacy', type: 'comment_created', actor, thread: { ...threadRef, text: authored('Old thread body') }, comment: post, target: { ...commentRef, id: 'cmt_target', author: actor, body: authored('Target body') }, ...privateData },
];
for (const event of notificationPayloads) cases.push({ name: 'check_notifications', raw: { events: [event] }, envelope: { kind: 'notifications_checked', events: [event] } });
const activities: import('@bickr/shared/model').BotActivityItem[] = [
	{ type: 'thread', id: 'thread-activity', threadId: summary.id, rootCommentId: comment.id, worldHandle: 'world', forumHandle: 'general', title: summary.title, bodyPreview: authored('A thread preview'), voteScore: 4, commentCount: 2, createdAt: writtenAt },
	{ type: 'comment', id: 'comment-activity', threadId: summary.id, commentId: comment.id, worldHandle: 'world', forumHandle: 'general', threadTitle: summary.title, bodyPreview: authored('A comment preview'), parentComment: { commentId: 'cmt_parent', authorHandle: profile.handle, bodyPreview: authored('A parent preview') }, voteScore: 1, createdAt: writtenAt },
	{ type: 'vote', id: 'vote-activity', targetType: 'comment', commentId: comment.id, threadId: summary.id, forumHandle: forum.handle, value: 1, reason: authored('A reason'), targetComment: { commentId: comment.id, authorHandle: profile.handle, bodyPreview: authored('A target preview') }, updatedAt: writtenAt },
	{ type: 'follow', id: 'follow-activity', bot: profile, reason: authored('A reason'), createdAt: writtenAt },
	{ type: 'unfollow', id: 'unfollow-activity', bot: profile, createdAt: writtenAt },
];
for (const activity of activities) cases.push({ name: 'view_activity', raw: { bot: profile, activities: [activity] }, envelope: { kind: 'activity_viewed', feed: { bot: profile, activities: [activity] } } });
function context(scope = new ResultContextScope()): ViewBuildContext { return { time, text, selfId: 'reader', scope, writtenAt, references: new Map([['f/general', forum.id], ['u/alice', profile.id]]) }; }
describe('JSON result views', () => {
	it.each(cases.flatMap(test => [undefined, 1, 30, 100].map(budget => ({ ...test, budget }))))('matches the old $name builder with budget $budget', async ({ name, raw, envelope, budget }) => {
		vi.useFakeTimers(); vi.setSystemTime(new Date(writtenAt));
		try {
			const oldKinds = ['profile_viewed', 'note_listed', 'note_read', 'note_written', 'note_deleted', 'note_reset', 'thread_created', 'comment_created', 'vote_set', 'profile_followed', 'profile_unfollowed', 'random_integers_drawn'];
			const old = JSON.stringify(providerToolResultPayload(name, raw, {}, providerSerializationContext(text, { botId: 'reader' }), { tokenBudget: budget }, oldKinds.includes(envelope.kind) ? envelope : undefined));
			const view = await buildToolResultView(envelope, context(), budget);
			expect(view).not.toBeNull();
			const serialized = JSON.stringify(view);
			expect(serialized).not.toContain('SECRET');
			expect(serialized).not.toContain('futurePrivateField');
			expect(renderToolResultView(view!, testViewRenderContext(view!, text))).toBe(old);
			expect(renderToolResultView(JSON.parse(serialized), testViewRenderContext(JSON.parse(serialized), text))).toBe(old);
		} finally { vi.useRealTimers(); }
	});
	it.each([1, 70, 150, 300, 1000, 10000])('matches the old read pruning with budget %s', async budget => {
		vi.useFakeTimers(); vi.setSystemTime(new Date(writtenAt));
		try {
		const leaf = { ...comment, id: 'cmt_leaf', commentId: 'cmt_leaf', body: authored('A deep reply '.repeat(100)), replies: [] };
		const child = { ...comment, id: 'cmt_child', commentId: 'cmt_child', body: authored('A child reply '.repeat(100)), replies: [leaf] };
		const content = [{ ...comment, body: authored('The protected root…'), replies: [child, { ...child, id: 'cmt_focus', commentId: 'cmt_focus', focused: true as const, replies: [] }] }];
		const pruned = pruneReadContentTreeForProviderBudget(text, content, budget, { botId: 'reader' });
		const old = JSON.stringify(providerToolResultPayload('read_thread_by_id', { ...read, content: pruned.content, context: readResultContext(text, read.operation, pruned, budget), contextGuidance: { collapsedReplies: pruned.omittedReplyCount > 0, trimmedBodies: pruned.trimmedBodyCount > 0 } }, {}, providerSerializationContext(text, { botId: 'reader' })));
		const view = await buildToolResultView({ kind: 'posts_read', items: [], read: { ...read, content, contextDecision: { operation: read.operation, tokenBudget: budget, omittedReplyCount: 0, trimmedBodyCount: 0 } } }, context());
		expect(renderToolResultView(view!, testViewRenderContext(view!, text))).toBe(old);
		expect(view?.kind === 'read_thread' && view.pruning?.omittedReplyCount).toBe(pruned.omittedReplyCount);
		} finally { vi.useRealTimers(); }
	});
	it('re-renders generated bootstrap forum advice after a rename', async () => {
		const view = await buildToolResultView({ kind: 'notifications_checked', events: [notificationPayloads[0]!] }, context());
		const handle = new Map([[JSON.stringify(['forum', forum.id]), { kind: 'current' as const, handle: 'renamed' }]]);
		expect(renderToolResultView(view!, testViewRenderContext(view!, text, handle))).toContain('f/renamed');
		expect(JSON.stringify(view)).not.toContain('SECRET');
	});
	it('returns a bounded result when an old bootstrap forum has no ID', async () => {
		const view = await buildToolResultView({ kind: 'notifications_checked', events: [notificationPayloads[0]!] }, { ...context(), references: new Map() });
		expect(renderToolResultView(view!, testViewRenderContext(view!, text))).not.toContain('f/general');
		expect(view?.kind === 'check_notifications' && view.events[0]?.kind).toBe('unavailable');
	});
	it('shows edited bodies again and omits repeated bodies across results', async () => {
		const scope = new ResultContextScope();
		const envelope: ToolResultEnvelope = { kind: 'posts_read', read, items: [] };
		const first = await buildToolResultView(envelope, context(scope));
		const second = await buildToolResultView(envelope, context(scope));
		const edited = await buildToolResultView({ ...envelope, read: { ...read, content: [{ ...comment, body: authored('Edited body') }] } }, context(scope));
		expect(renderToolResultView(first!, testViewRenderContext(first!, text))).toContain('The opening body');
		expect(renderToolResultView(second!, testViewRenderContext(second!, text))).not.toContain('The opening body');
		expect(renderToolResultView(edited!, testViewRenderContext(edited!, text))).toContain('Edited body');
	});
});


describe('failure and settlement views', () => {
	it('projects failure fields and arguments without new internal data', () => {
		const original = toolFailurePayload(text, 'read_note', { id: 'one' }, new Error('Internal details'));
		const view = failureResultView({ ...original, ...privateData, args: { id: 'one', ...privateData } }, text, { message: resultMessage('recovery.genericError') });
		expect(JSON.stringify(view)).not.toContain('SECRET');
		expect(renderToolResultView(view, testViewRenderContext(view, text))).toBe(JSON.stringify(original));
		expect(renderToolResultView(view, testViewRenderContext(view, botText('fr')))).toBe(JSON.stringify(toolFailurePayload(botText('fr'), 'read_note', { id: 'one' }, new Error('Internal details'))));
	});
	it('uses the current forum handle in duplicate-title failures', () => {
		const original = toolFailurePayload(text, 'create_thread', { forumHandle: 'old', title: authored('Title'), body: authored('Body') }, new Error('Internal details'));
		original.existingForumHandle = 'old';
		const view = failureResultView(original, text, { message: resultMessage('recovery.genericError') });
		view.existingForum = { kind: 'forum', entityId: forum.id, handle: 'old' };
		const handles = new Map([[JSON.stringify(['forum', forum.id]), { kind: 'deleted' as const, handle: 'new' }]]);
		expect(JSON.parse(renderToolResultView(view, testViewRenderContext(view, text, handles))).existingForumHandle).toBe('new (deleted)');
		expect(JSON.parse(renderToolResultView(view, testViewRenderContext(view, text, handles))).args.forumHandle).toBe('old');
	});
	it.each(['prepared', 'reading', 'dispatched'] as const)('matches interrupted settlement at %s', stage => {
		const old = interruptedToolSettlement(text, 'create_thread', stage);
		const kind = old.outcome === 'unknown' ? 'outcome_unknown' : old.outcome;
		const recipe = stage === 'prepared' ? resultMessage('recovery.notDispatched') : stage === 'reading' ? resultMessage('recovery.interrupted') : unknownOutcomeText('create_thread');
		expect(renderToolResultView(settlementResultView(kind, recipe, text), testViewRenderContext(settlementResultView(kind, recipe, text), text))).toBe(JSON.stringify(old.result));
	});
	it.each(['not_attempted', 'completed_result_unavailable', 'outcome_unknown', 'result_unavailable'] as const)('keeps the %s result shape', kind => {
		const view = settlementResultView(kind, resultMessage('recovery.genericError'), text);
		const old = kind === 'result_unavailable' ? { ok: false, code: kind, message: text.format('recovery.genericError') } : { kind, message: text.format('recovery.genericError') };
		expect(renderToolResultView(view, testViewRenderContext(view, text))).toBe(JSON.stringify(old));
	});
	it('re-renders participant targets for every batch outcome', async () => {
		const targetParticipant = { id: profile.id, handle: profile.handle, ...privateData };
		const items: import('../errors').ToolBatchOutcomeItem[] = [
			{ kind: 'recorded', target: 'u/alice', targetParticipant, envelope: { kind: 'profile_followed', profiles: [{ username: 'alice', following: true, profile }] }, scope: { related: false, unrelated: false } },
			{ kind: 'unknown', target: 'u/alice', targetParticipant, error: new Error('Private'), scope: { related: false, unrelated: false } },
			{ kind: 'not_attempted', target: 'u/alice', targetParticipant },
		];
		const view = await batchResultView('follow_profile', items, context(), () => { throw new Error('Unexpected refusal'); });
		const handles = new Map([[JSON.stringify(['participant', profile.id]), { kind: 'current' as const, handle: 'renamed' }]]);
		expect(JSON.parse(renderToolResultView(view, testViewRenderContext(view, text, handles))).items.map((item: { target: string }) => item.target)).toEqual(['u/renamed', 'u/renamed', 'u/renamed']);
		expect(JSON.stringify(view)).not.toContain('SECRET');
	});
	it('matches every batch outcome without reading nested result text', async () => {
		const scope = { related: false, unrelated: false };
		const vote = { kind: 'vote_set' as const, votes: [{ commentId: comment.id, value: 1 as const, thread }] };
		const items: import('../errors').ToolBatchOutcomeItem[] = [
			{ kind: 'recorded', target: 'c/cmt_root', envelope: vote, scope },
			{ kind: 'committed', target: 'c/cmt_two', issue: botServiceIssue('issue.service.mutationReceiptUnavailable', {}), scope },
			{ kind: 'refused', target: 'c/cmt_three', args: {}, error: new Error('Internal details') },
			{ kind: 'unknown', target: 'c/cmt_four', error: new Error('Internal details'), scope },
			{ kind: 'not_attempted', target: 'c/cmt_five' },
		];
		const failure = (args: Record<string, unknown>, cause: unknown) => toolFailurePayload(text, 'vote', args, cause);
		const old = providerBatchOutcome(text, 'vote', items, providerSerializationContext(text, { botId: 'reader' }), failure);
		const view = await batchResultView('vote', items, context(), (args, cause) => failureResultView(failure(args, cause), text, { message: resultMessage('recovery.genericError') }));
		expect(renderToolResultView(view, testViewRenderContext(view, text))).toBe(JSON.stringify(old));
		expect(JSON.stringify(view)).not.toContain('Internal details');
	});
});
