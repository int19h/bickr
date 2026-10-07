import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { botById, RepositoryError } from '@bickr/shared/repository';
import { forumByHandle, botPublicProfilesByHandles, followedBotIdSet, readThread, followBot, unfollowBot } from '@bickr/shared/social';
import { botServiceIssue } from '@bickr/shared/bot-service-issues';
import type { ThreadDocument, BotRuntimeEvent } from '@bickr/shared/model';
import type { RuntimeBotDocument, ChatMessage, ToolCall } from '../types';
import { botText } from '../localization';
import { BotRuntime, runtimeSchema } from './bot-runtime';
import { RuntimeTools, type RuntimeToolsRuntime } from './tools';
import { RuntimeMessageStore } from './message-store';
import { BotNotesStore, maxNotesPerBot } from './notes';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
import { TickStoppedError, ToolPreparationError, ToolOutcomeUnknownError } from '../errors';
import { serviceBindingTimeoutMs } from '../constants';
import { mutationIdentity, storedMutationIdentity } from './tool-dispatch';
import { normalizeToolArgs } from './tool-args';

vi.mock('@bickr/shared/repository', async (original) => ({ ...await original<object>(), botById: vi.fn() }));
vi.mock('@bickr/shared/social', async (original) => ({ ...await original<object>(), forumByHandle: vi.fn(), readThread: vi.fn(), botPublicProfilesByHandles: vi.fn(), followedBotIdSet: vi.fn() }));

const text = botText('ja');
const lt = (text: string) => ({ lang: 'en', text });
const bot = { id: 'bot_test', handle: 'actor', language: 'en', text, instructionLocale: 'ja', homeWorldId: 'world', homeWorldHandle: 'world', toolSettings: {}, displayName: { lang: 'en', text: 'Actor' } } as RuntimeBotDocument;
const thread = { id: 'thr_thread', worldId: 'world', worldHandle: 'world', forumId: 'forum', forumHandle: 'forum', title: { lang: 'en', text: 'Title' }, rootCommentId: 'cmt_root', comments: [], commentCount: 0, voteScore: 0 } as unknown as ThreadDocument;
const reasoning = [{ type: 'reasoning.encrypted', data: 'opaque', format: 'anthropic-claude-v1', index: 0 }];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
let storage: RuntimeTestStorage;
beforeEach(() => {
	storage = createRuntimeTestStorage(); storage.database.exec(runtimeSchema);
	vi.mocked(forumByHandle).mockResolvedValue({ id: 'forum', handle: 'forum' } as Awaited<ReturnType<typeof forumByHandle>>);
	vi.mocked(readThread).mockResolvedValue(thread);
	vi.mocked(botPublicProfilesByHandles).mockResolvedValue([{ ...bot, id: 'bot_target', handle: 'target' }] as Awaited<ReturnType<typeof botPublicProfilesByHandles>>);
	vi.mocked(followedBotIdSet).mockResolvedValue(new Set());
	vi.mocked(botById).mockImplementation(async (_kv, _db, id) => ({ ...bot, id }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); storage.database.close(); });

function harness(name: string, args: Record<string, unknown>) {
	const signal = new AbortController();
	const call: ToolCall = { id: 'call', type: 'function', function: { name, arguments: JSON.stringify(args) } };
	const assistant: ChatMessage = { role: 'assistant', content: 'Authored {{opaque}}.', reasoning_details: reasoning, tool_calls: [call] };
	const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { thread } }), { headers: { 'content-type': 'application/json' } }));
	const statement = { bind: () => statement, first: vi.fn(async () => ({ threadId: thread.id })), all: vi.fn(async () => ({ results: [] })), run: vi.fn(async () => ({})) };
	const env = { BICKR_D1: { prepare: () => statement }, BICKR_KV: {}, FORUM_COORDINATOR_SERVICE: { fetch }, INTERNAL_SERVICE_SECRET: 'test' } as unknown as RuntimeToolsRuntime['env'];
	const runtime = Object.assign(Object.create(BotRuntime.prototype), { state: { storage, getWebSockets: () => [] }, env });
	runtime.setPendingTool(text, 'run', call, args, assistant, null);
	const store = new RuntimeMessageStore(storage);
	const notes = new BotNotesStore(storage);
	const events: BotRuntimeEvent[] = [];
	const beforeWrite = () => { if (signal.signal.aborted) throw new TickStoppedError(); runtime.markPendingToolDispatched('run', call.id); };
	const capabilities: RuntimeToolsRuntime = {
		env, throwIfStopped: () => { if (signal.signal.aborted) throw new TickStoppedError(); },
		appendEvent: (runId, type, payload) => { const event = { runId, type, payload, seq: events.length + 1, createdAt: '', tokenEstimate: 0 }; events.push(event); return event; },
		replaceEventPayload: (event, payload) => ({ ...event, payload }),
		forumService: (path, id, body, abort, onDispatch) => runtime.forumService(path, id, body, abort, () => { beforeWrite(); onDispatch?.(); }, undefined, 'run:request:call'),
		markToolDispatched: beforeWrite, markToolReading: () => runtime.markPendingToolReading('run', call.id),
		recordMutationIdentity: (identity) => { if (identity) storage.sql.exec("UPDATE runtime_state SET value_json = json_set(value_json, '$.mutationIdentity', json(?)) WHERE key = 'pending_tool_v3'", JSON.stringify(identity)); },
		readCommentTreeTokenBudget: async () => 10_000, vectorSearchBots: async () => [],
		providerContentInActiveContext: () => ({ commentsWithText: new Set(), threadsWithText: new Set() }),
		recentToolResultRows: () => storage.sql.exec("SELECT * FROM events WHERE type = 'tool_result'").toArray() as ReturnType<RuntimeToolsRuntime['recentToolResultRows']>,
		setLastSuccessfulLogOffSeq: () => {},
		writeNote: (id, content, links) => notes.write(id, content, links, undefined, beforeWrite),
		deleteNote: (id) => notes.delete(text, id, beforeWrite), readNote: (id) => notes.read(text, id),
		listNotes: (cursor, limit, links, unknown, includePlan) => notes.list(cursor, limit, links, unknown, includePlan),
		viewProfiles: async () => { throw new Error('Unused.'); },
	};
	const tools = new RuntimeTools(capabilities);
	const execute = () => tools.executeTool(bot, 'run', name, args, { mode: 'normal', setupMode: 'new_iteration', signal: signal.signal }, (result) => store.appendProviderToolResult({ runId: 'run', message: assistant, origin: 'provider_response', status: 'complete' }, { runId: 'run', message: { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.providerResult) }, origin: 'tool_result', status: 'complete' }, null));
	const journal = () => JSON.parse(storage.sql.exec<{ value_json: string }>("SELECT value_json FROM runtime_state WHERE key = 'pending_tool_v3'").one().value_json);
	const settle = () => { runtime.settlePendingTool('run'); return JSON.parse(String(store.loopMessagesAfter(0).at(-1)?.message.content)); };
	return { runtime, capabilities, signal, call, assistant, statement, fetch, execute, journal, settle, store, notes, events };
}

describe('actual preparation and send boundaries', () => {
	it('recovers a pending forum lookup without banning an identical thread', async () => {
		const gate = deferred<Awaited<ReturnType<typeof forumByHandle>>>();
		vi.mocked(forumByHandle).mockReturnValueOnce(gate.promise);
		const h = harness('create_thread', { forumHandle: 'f/forum', title: lt('Title'), body: lt('Body') });
		const pending = h.execute().catch((error) => error);
		await vi.waitFor(() => expect(forumByHandle).toHaveBeenCalled());
		expect(h.journal().stage).toBe('prepared');
		expect(h.settle()).toMatchObject({ code: 'not_dispatched', message: text.format('recovery.notDispatched') });
		expect(h.fetch).not.toHaveBeenCalled();
		h.signal.abort(); gate.resolve({ id: 'forum', handle: 'forum' } as Awaited<ReturnType<typeof forumByHandle>>);
		await pending;
		// Real recovery events feed the guard on the next request.
		const next = new RuntimeTools(h.capabilities);
		h.capabilities.throwIfStopped = () => {};
		h.capabilities.forumService = async <T>() => ({ thread }) as T;
		await expect(next.executeTool(bot, 'retry', 'create_thread', { forumHandle: 'f/forum', title: lt('Title'), body: lt('Body') }, { mode: 'normal', setupMode: 'new_iteration', signal: new AbortController().signal })).resolves.toMatchObject({ name: 'create_thread' });
	});

	it('keeps note-link lookups before the local transaction and honors Stop', async () => {
		const gate = deferred<{ results: [] }>();
		const h = harness('write_note', { id: 'meeting', content: 'Met u/target.' });
		h.statement.all.mockReturnValueOnce(gate.promise);
		const pending = h.execute().catch((error) => error);
		await vi.waitFor(() => expect(h.statement.all).toHaveBeenCalled());
		expect(h.journal().stage).toBe('prepared');
		h.signal.abort(); gate.resolve({ results: [] });
		expect(await pending).toBeInstanceOf(TickStoppedError);
		expect(h.settle()).toMatchObject({ code: 'not_dispatched' });
		expect(h.notes.read(text, 'meeting')).toBeNull();
	});

	it('keeps profile preparation before the first follow write', async () => {
		const gate = deferred<Awaited<ReturnType<typeof botPublicProfilesByHandles>>>();
		vi.mocked(botPublicProfilesByHandles).mockReturnValueOnce(gate.promise);
		const h = harness('follow_profile', { targets: [{ username: 'u/target', reason: lt('Reason') }] });
		const pending = h.execute().catch((error) => error);
		await vi.waitFor(() => expect(botPublicProfilesByHandles).toHaveBeenCalled()).catch(async () => { throw await pending; });
		expect(h.journal().stage).toBe('prepared');
		expect(h.settle()).toMatchObject({ code: 'not_dispatched' });
		h.signal.abort(); gate.resolve([]); await pending;
		expect(h.statement.run).not.toHaveBeenCalled();
	});

	it('recovers an interrupted read without unknown-mutation guidance', async () => {
		const gate = deferred<ThreadDocument>(); vi.mocked(readThread).mockReturnValueOnce(gate.promise);
		const h = harness('read_thread', { threadRef: 't/thr_thread' });
		const pending = h.execute().catch((error) => error);
		await vi.waitFor(() => expect(readThread).toHaveBeenCalled()).catch(async () => { throw await pending; });
		expect(h.journal().stage).toBe('reading');
		expect(h.settle()).toEqual({ ok: false, code: 'interrupted', message: text.format('recovery.interrupted') });
		h.signal.abort(); gate.resolve(thread); await pending;
	});

	it.each(['create_thread', 'make_additional_reply_to_the_same_comment', 'vote'])('does not send %s when Stop arrives during idempotency hashing', async (name) => {
		const gate = deferred<ArrayBuffer>(); vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(gate.promise);
		const args = name === 'create_thread' ? { forumHandle: 'f/forum', title: lt('Title'), body: lt('Body') } : name === 'vote' ? { votes: [{ commentRef: 'c/cmt_root', value: 1 }], reason: lt('Reason') } : { commentRef: 'c/cmt_root', body: lt('Reply') };
		const h = harness(name, args);
		const pending = h.execute().catch((error) => error);
		await vi.waitFor(() => expect(crypto.subtle.digest).toHaveBeenCalled()).catch(async () => { throw await pending; });
		expect(h.journal().stage).toBe('prepared');
		h.signal.abort(); await pending;
		expect(h.settle()).toMatchObject({ code: 'not_dispatched' });
		gate.resolve(new Uint8Array(32).buffer); await Promise.resolve(); await Promise.resolve();
		expect(h.fetch).not.toHaveBeenCalled();
	});

	it('prevents a timed-out hash continuation from marking or sending the next call', async () => {
		vi.useFakeTimers();
		const gate = deferred<ArrayBuffer>(); vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(gate.promise);
		const h = harness('create_thread', { forumHandle: 'f/forum', title: lt('Title'), body: lt('Body') });
		const pending = h.execute().catch((error) => error);
		await vi.advanceTimersByTimeAsync(0);
		expect(crypto.subtle.digest).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(serviceBindingTimeoutMs);
		expect(await pending).toBeInstanceOf(ToolPreparationError);
		h.runtime.setPendingTool(text, 'run', { ...h.call, id: 'next' }, {}, h.assistant, null);
		gate.resolve(new Uint8Array(32).buffer); await vi.advanceTimersByTimeAsync(0);
		expect(h.journal()).toMatchObject({ stage: 'prepared', toolCall: { id: 'next' } });
		expect(h.fetch).not.toHaveBeenCalled();
	});

	it('keeps a sent request unknown after a lost response', async () => {
		const gate = deferred<Response>();
		const h = harness('create_thread', { forumHandle: 'f/forum', title: lt('Title'), body: lt('Body') }); h.fetch.mockReturnValueOnce(gate.promise);
		const pending = h.execute().catch((error) => error);
		await vi.waitFor(() => expect(h.fetch).toHaveBeenCalled());
		expect(h.journal()).toMatchObject({ stage: 'dispatched', mutationIdentity: { kind: 'thread', forumHandle: 'forum', title: 'Title' } });
		h.signal.abort(); expect(await pending).toBeInstanceOf(ToolOutcomeUnknownError);
		expect(h.settle()).toMatchObject({ kind: 'outcome_unknown' });
		gate.resolve(new Response('{}'));
	});

	it('keeps a received mutation result when a durable Stop arrives before the final gate', async () => {
		const h = harness('create_thread', { forumHandle: 'f/forum', title: lt('Title'), body: lt('Body') });
		let stopped = false;
		h.capabilities.throwIfStopped = () => { if (stopped) throw new TickStoppedError(); };
		h.fetch.mockImplementationOnce(async () => { stopped = true; return new Response(JSON.stringify({ ok: true, data: { thread } }), { headers: { 'content-type': 'application/json' } }); });
		await expect(h.execute()).resolves.toMatchObject({ name: 'create_thread', envelope: { kind: 'thread_created', thread: { id: thread.id } } });
		expect(h.store.loopMessagesAfter(0).at(-1)?.message.content).toContain('t/thr_thread');
		expect(storage.sql.exec("SELECT * FROM runtime_state WHERE key = 'pending_tool_v3'").toArray()).toEqual([]);
	});
});

it('records the same reply identity for model references and internal ids', () => {
	const expected = { kind: 'reply', commentId: 'cmt_root', body: 'Reply' };
	expect(mutationIdentity('reply_to_comment', normalizeToolArgs('reply_to_comment', { commentRef: 'c/cmt_root', body: lt('Reply') }))).toEqual(expected);
	expect(storedMutationIdentity({ name: 'reply_to_comment', args: { commentRef: 'c/cmt_root', body: lt('Reply') }, outcome: 'unknown' })).toEqual(expected);
});

it.each(['follow', 'unfollow'] as const)('runs the %s hook after lookups and reports post-write failures as committed', async (action) => {
	const cause = new RepositoryError('not_found', 'Notification lookup failed', 404, { botIssue: botServiceIssue('issue.service.participantMissing', {}) });
	const run = vi.fn(async () => ({})); let marked = false;
	const statement = { bind: () => statement, first: async () => action === 'unfollow' ? { createdAt: '' } : null, run };
	const db = { prepare: (query: string) => { if (query.includes('INSERT INTO bot_activity_events')) throw cause; return statement; } } as unknown as RuntimeToolsRuntime['env']['BICKR_D1'];
	const mutation = action === 'follow' ? followBot : unfollowBot;
	await expect(mutation({} as RuntimeToolsRuntime['env']['BICKR_KV'], db, bot.id, 'bot_target', undefined, { beforeWrite: () => { expect(botById).toHaveBeenCalledTimes(2); expect(run).not.toHaveBeenCalled(); marked = true; } })).rejects.toMatchObject({ details: { botIssue: { key: 'issue.service.mutationReceiptUnavailable' } }, cause });
	expect(marked).toBe(true); expect(run).toHaveBeenCalledTimes(1);
});

it('rolls back the note journal marker with a failed local transaction', () => {
	const h = harness('write_note', { id: 'meeting', content: 'Body' });
	storage.database.exec("CREATE TRIGGER fail_note BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'note write failed'); END");
	expect(() => h.capabilities.writeNote('meeting', 'Body', [])).toThrow('note write failed');
	expect(h.journal().stage).toBe('prepared');
	expect(h.notes.read(text, 'meeting')).toBeNull();
});

it.each(['write', 'delete'] as const)('leaves a known note %s refusal before dispatch', (action) => {
	const h = harness(action === 'write' ? 'write_note' : 'delete_note', {});
	if (action === 'write') {
		for (let i = 0; i < maxNotesPerBot; i++) h.notes.write(`note-${i}`, 'Body', []);
		expect(() => h.capabilities.writeNote('overflow', 'Body', [])).toThrow();
	} else expect(h.capabilities.deleteNote('missing')).toEqual({ kind: 'not_found' });
	expect(h.journal().stage).toBe('prepared');
});

it('blocks a model-shaped reply only after the request was sent', async () => {
	const gate = deferred<Response>();
	const args = { commentRef: 'c/cmt_root', body: lt('Reply') };
	const h = harness('make_additional_reply_to_the_same_comment', args); h.fetch.mockReturnValueOnce(gate.promise);
	const pending = h.execute().catch((error) => error);
	await vi.waitFor(() => expect(h.fetch).toHaveBeenCalled());
	expect(h.journal()).toMatchObject({ stage: 'dispatched', mutationIdentity: { kind: 'reply', commentId: 'cmt_root', body: 'Reply' } });
	h.signal.abort(); await pending; h.settle(); gate.resolve(new Response('{}'));
	h.capabilities.throwIfStopped = () => {};
	await expect(new RuntimeTools(h.capabilities).executeTool(bot, 'retry', 'make_additional_reply_to_the_same_comment', args, { mode: 'normal', setupMode: 'new_iteration', signal: new AbortController().signal })).rejects.toMatchObject({ name: 'SelfCorrectingToolCallError' });
	expect(h.fetch).toHaveBeenCalledTimes(1);
});

it('keeps the journal and both message rows when recovery event persistence fails', () => {
	const h = harness('create_thread', { forumHandle: 'f/forum', title: lt('Title'), body: lt('Body') });
	const broadcast = vi.fn(); h.runtime.broadcast = broadcast;
	storage.database.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'event write failed'); END");
	expect(() => h.settle()).toThrow('event write failed');
	expect(h.journal().stage).toBe('prepared');
	expect(h.store.loopMessagesAfter(0)).toEqual([]);
	expect(storage.sql.exec('SELECT * FROM loop_message_logs').toArray()).toEqual([]);
	expect(broadcast).not.toHaveBeenCalled();
});

it.each(['prepared', 'reading', 'dispatched'] as const)('uses a captured %s journal for live interruption and leaves siblings unsent', (stage) => {
	const h = harness('create_thread', { forumHandle: 'f/forum', title: lt('Title'), body: lt('Body') });
	if (stage === 'reading') h.runtime.markPendingToolReading('run', h.call.id);
	if (stage === 'dispatched') h.runtime.markPendingToolDispatched('run', h.call.id);
	const sibling: ToolCall = { id: 'sibling', type: 'function', function: { name: 'read_note', arguments: '{"id":"PLAN"}' } };
	let group: number | null = null;
	// The sibling is paired first to prove that the journal delete cannot lose
	// the active call's language or phase.
	h.runtime.appendInterruptedToolMessages(botText('en'), 'run', [sibling, h.call], new Set([sibling.id, h.call.id]), (call: ToolCall, message: ChatMessage, _content: string, commit: () => void) => {
		group = h.store.appendProviderToolResult({ runId: 'run', message: { ...h.assistant, tool_calls: [call] }, origin: 'provider_response', status: 'interrupted' }, { runId: 'run', message, origin: 'tool_failure', status: 'interrupted' }, group, commit).seq;
	});
	const messages = h.store.loopMessagesAfter(0).map((row) => row.message);
	expect(messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'tool']);
	expect(messages[0]?.reasoning_details).toEqual(reasoning);
	expect(JSON.parse(String(messages[1]?.content))).toMatchObject({ code: 'not_dispatched', message: botText('en').format('recovery.notDispatched') });
	const active = JSON.parse(String(messages[2]?.content));
	expect(active).toMatchObject(stage === 'dispatched' ? { kind: 'outcome_unknown' } : { code: stage === 'prepared' ? 'not_dispatched' : 'interrupted', message: text.format(stage === 'prepared' ? 'recovery.notDispatched' : 'recovery.interrupted') });
	const outcomes = storage.sql.exec<{ payload_json: string }>('SELECT payload_json FROM events ORDER BY seq').toArray().map((row) => JSON.parse(row.payload_json).outcome);
	expect(outcomes).toEqual(['not_dispatched', stage === 'dispatched' ? 'unknown' : stage === 'reading' ? 'interrupted' : 'not_dispatched']);
	expect(storage.sql.exec("SELECT * FROM runtime_state WHERE key = 'pending_tool_v3'").toArray()).toEqual([]);
});

it('keeps the first internal follow profile lookup before dispatch', async () => {
	const gate = deferred<Awaited<ReturnType<typeof botById>>>(); vi.mocked(botById).mockReturnValueOnce(gate.promise);
	const h = harness('follow_profile', { targets: [{ username: 'u/target', reason: lt('Reason') }] });
	h.statement.first.mockResolvedValue(null as unknown as { threadId: string });
	const pending = h.execute().catch((error) => error);
	await vi.waitFor(() => expect(botById).toHaveBeenCalled());
	expect(h.journal().stage).toBe('prepared');
	expect(h.settle()).toMatchObject({ code: 'not_dispatched' });
	h.signal.abort(); gate.resolve(bot); await pending;
	expect(h.statement.run).not.toHaveBeenCalled();
});

it('keeps an internal follow lookup refusal typed before dispatch', async () => {
	vi.mocked(botById).mockRejectedValueOnce(new RepositoryError('not_found', 'Profile disappeared.', 404, { botIssue: botServiceIssue('issue.service.participantMissing', {}) }));
	const h = harness('follow_profile', { targets: [{ username: 'u/target', reason: lt('Reason') }] });
	const error = await h.execute().catch((error) => error);
	expect(error).toMatchObject({ items: [{ kind: 'refused', error: { details: { botIssue: { key: 'issue.service.participantMissing' } } } }] });
	expect(h.journal().stage).toBe('prepared');
	expect(h.statement.run).not.toHaveBeenCalled();
});
