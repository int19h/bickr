import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markBotSeenContent, recordSpotlightToolHumanNotification } from '@bickr/shared/social';
import type { BotRuntimeEvent, ThreadDocument, CommentDocument, LanguageTag } from '@bickr/shared/model';
import { RuntimeTools, completeToolBookkeeping, type RuntimeToolsRuntime } from './tools';
import type { RuntimeBotDocument } from '../types';
import { cleanupTimeoutMs } from './run-liveness';
import { TickStoppedError } from '../errors';

vi.mock('@bickr/shared/social', async (original) => ({
	...await original<object>(), markBotSeenContent: vi.fn(), recordSpotlightToolHumanNotification: vi.fn(),
}));
beforeEach(() => { vi.mocked(markBotSeenContent).mockResolvedValue(); vi.mocked(recordSpotlightToolHumanNotification).mockResolvedValue(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

const language = 'en' as LanguageTag;
const bot = {
	id: 'bot', type: 'bot', schemaVersion: 1, revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01',
	homeWorldId: 'world', homeWorldHandle: 'world', ownerUserId: 'owner', handle: 'participant', language,
	includeLanguageInSystemPrompt: false, displayName: { lang: language, text: 'Participant' }, shortBio: { lang: language, text: '' },
	prompt: { lang: language, text: '' }, inferenceSettings: {}, toolSettings: {},
	tickSettings: { enabled: true, intervalSeconds: 60, allowEarlyLogOff: true, compactionThreshold: 0.75 },
} satisfies RuntimeBotDocument;
const comment: CommentDocument = { id: 'cmt_reply', parentCommentId: 'cmt_parent', threadId: 'thr_thread', worldId: 'world', forumId: 'forum', authorBotId: 'bot', authorHandle: 'participant', authorDisplayName: bot.displayName, body: { lang: language, text: 'A reply' }, voteScore: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const thread: ThreadDocument = { id: 'thr_thread', type: 'thread', schemaVersion: 1, revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01', worldId: 'world', worldHandle: 'world', forumId: 'forum', forumHandle: 'forum', title: { lang: language, text: 'Thread' }, rootCommentId: 'cmt_parent', comments: [comment], commentCount: 1, voteScore: 0, recentCommentCount: 1, lastActivityAt: '2026-01-01' };

function harness() {
	const events: BotRuntimeEvent[] = [];
	const service = vi.fn(async () => ({ thread, comment }));
	const signal = new AbortController();
	const runtime: RuntimeToolsRuntime = {
		env: { BICKR_D1: { prepare: () => ({ bind: () => ({ first: async () => ({ threadId: 'thr_thread' }) }) }) } } as unknown as RuntimeToolsRuntime['env'],
		appendEvent(runId, type, payload) { const event = { runId, type, payload, seq: events.length + 1, tokenEstimate: 0, createdAt: '2026-01-01' }; events.push(event); return event; },
		replaceEventPayload: (event, payload) => ({ ...event, payload }),
		throwIfStopped: () => { if (signal.signal.aborted) throw new TickStoppedError(); },
		forumService: async <T>() => await service() as T,
		vectorSearchBots: async () => [], readCommentTreeTokenBudget: async () => 10_000,
		providerContentInActiveContext: () => ({ commentsWithText: new Set(), threadsWithText: new Set() }),
		recentToolResultRows: () => [], setLastSuccessfulLogOffSeq: () => {},
	};
	const pair = vi.fn();
	const execute = () => new RuntimeTools(runtime).executeTool(bot, 'run', 'make_additional_reply_to_the_same_comment',
		{ commentId: 'cmt_parent', body: comment.body }, { mode: 'normal', setupMode: 'new_iteration', signal: signal.signal }, pair);
	return { events, runtime, pair, execute, service, signal };
}

describe('committed tool bookkeeping', () => {
	it('records success and its protocol callback before any bookkeeping, even when seen rejects', async () => {
		vi.mocked(markBotSeenContent).mockRejectedValue(new Error('seen outage'));
		const h = harness();
		const result = await h.execute();
		expect(h.events.at(-1)).toMatchObject({ type: 'tool_result', payload: { envelope: { kind: 'comment_created' } } });
		expect(h.pair).toHaveBeenCalledWith(result);
		expect(markBotSeenContent).not.toHaveBeenCalled();
		expect(await completeToolBookkeeping(h.runtime.env.BICKR_D1, bot, 'run', result)).toMatchObject([{ operation: 'seen_content' }]);
		expect(h.service).toHaveBeenCalledTimes(1);
	});
	it('bounds hung seen and notification work without replaying a committed reply, including Stop', async () => {
		vi.useFakeTimers();
		vi.mocked(markBotSeenContent).mockImplementation(() => new Promise(() => {}));
		vi.mocked(recordSpotlightToolHumanNotification).mockImplementation(() => new Promise(() => {}));
		const h = harness();
		const result = await h.execute();
		result.bookkeeping!.spotlightId = 'spotlight';
		const cleanup = completeToolBookkeeping(h.runtime.env.BICKR_D1, bot, 'run', result);
		h.signal.abort();
		await vi.advanceTimersByTimeAsync(cleanupTimeoutMs * 2);
		expect(await cleanup).toMatchObject([
			{ operation: 'seen_content', cause: { kind: 'runtime_operation_timeout' } },
			{ operation: 'spotlight_notification', cause: { kind: 'runtime_operation_timeout' } },
		]);
		expect(h.events).toHaveLength(2);
		expect(h.service).toHaveBeenCalledTimes(1);
		expect(h.pair).toHaveBeenCalledTimes(1);
	});
});
