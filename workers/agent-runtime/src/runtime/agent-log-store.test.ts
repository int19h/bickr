import type { ProviderResponse } from '../types';
import { ProviderResponseInterruptedError } from '../errors';
import { reasoningTextFromDetails } from '../provider/reasoning-stream';
import type { AgentLogStreamDelta } from '@bickr/shared/model';
import { attachToolResultView } from './result-messages';
import { resultViewBase, type ToolResultView } from './tool-result-views';
import { hydrateResultFacets } from './result-context-scope';
import { resultHandleKey } from './result-handles';
import { withRunExecution, settleOutsideExecution } from './execution-scope';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentLogAuthor, type AgentLogSource, type BotLoopMessageOrigin } from '@bickr/shared/model';
import { AgentLogStore, agentLogFailure, agentLogDeltaDepthLimit } from './agent-log-store';
import { RuntimeMessageStore } from './message-store';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
import { testResultContext } from './result-render-context.test-support';
import { BotRuntime, runtimeSchema } from './bot-runtime';
import { botText } from '../localization';
import { ProviderRequestError, ProviderStructuredOutputValidationError } from '../errors';

let storage: RuntimeTestStorage;
let store: AgentLogStore;
let messages: RuntimeMessageStore;
beforeEach(() => { storage = createRuntimeTestStorage(); storage.database.exec(runtimeSchema); store = new AgentLogStore(storage); messages = new RuntimeMessageStore(storage); });
afterEach(() => { storage.database.close(); vi.restoreAllMocks(); });
const response = { content: 'Reply', reasoning: '', reasoningDetails: [], toolCalls: [] };
function request(eventSeq = 1) { return store.begin({ runId: 'run', eventSeq, purpose: 'loop' }); }
function append() { return messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Reply' }, 'provider_response', 'complete', { streamSeq: 1 }); }

describe('agent log storage', () => {
	it('stores the exact outgoing body before fetch resolves and returns partial text through the endpoint', async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		let sent = '';
		const ref = { kind: 'participant' as const, entityId: 'actor', handle: 'before-rename' };
		const view: ToolResultView = { ...resultViewBase(botText('en')), kind: 'profiles', source: 'view', facets: [{ entityId: 'actor', facet: 'profile_bio', state: 'known', fingerprint: 'same' }], profiles: [{ ref, bio: 0, isFollowedByMe: false, isFollowingMe: false, followers: 0 }] };
		messages.appendLoopMessage(testResultContext, 'earlier', { role: 'assistant', tool_calls: [{ id: 'profile-call', type: 'function', function: { name: 'view_profiles', arguments: '{}' } }] }, 'provider_response');
		const toolRow = messages.appendLoopMessage(testResultContext, 'earlier', attachToolResultView({ role: 'tool', tool_call_id: 'profile-call', content: '' }, view), 'tool_result');
		const history = messages.loopMessagesAfter(testResultContext, 0).map(row => row.message);
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage }, agentLogs: store, env: {}, renewProgressLease: vi.fn(), throwIfStopped: vi.fn(),
			requireOwnerOrInternal: vi.fn(), recordProviderTokenCalibrationSampleFromError: vi.fn(),
			fetchProviderResponse: vi.fn(async (_settings, _endpoint, body: string) => { sent = body; await gate; return new ReadableStream(); }),
			consumeProviderResponse: vi.fn(async () => response),
		});
		const pending = runtime.callProvider({ text: botText('en'), model: 'test', baseUrl: 'https://example.test/v1' }, history, [], 'run', 1, new AbortController().signal, 'participant', undefined, '2026-10-24');
		await vi.waitFor(() => expect(sent).not.toBe(''));
		const id = store.byEvent('run', 1)!.id;
		expect(store.request(id).attempts[0]?.body).toBe(sent);
		store.partial('run', 1, { kind: 'content', text: 'Par' });
		store.partial('run', 1, { kind: 'content', text: 'tial' });
		const url = new URL(`https://internal/bots/participant/requests/${id}`);
		const details = await runtime.handleRuntimeReadRequest(new Request(url), url, 'participant');
		expect((await details.json()).data.request.attempts[0]).toMatchObject({ body: sent, partialResponse: JSON.stringify({ content: 'Partial', reasoning: '', reasoningParts: [], toolCalls: [] }) });
		expect(store.entries([], null)).toMatchObject([{ kind: 'live', requestId: id }]);
		release();
		await pending;
		const row = append();
		expect(hydrateResultFacets([{ entityId: 'actor', facet: 'profile_bio', state: 'shown', fingerprint: 'same', value: 'The hydrated biography.' }], [view.facets])).toBe(1);
		storage.sql.exec('UPDATE loop_messages SET tool_result_view_json = ? WHERE seq = ?', JSON.stringify(view), toolRow.seq);
		const changedContext = { ...testResultContext, handles: new Map([[resultHandleKey(ref), { kind: 'current' as const, handle: 'after-rename' }]]) };
		const rendered = messages.loopMessagesPage(changedContext, { page: 1 }).messages.find(message => message.seq === toolRow.seq)?.message.content;
		expect(rendered).toContain('after-rename');
		expect(rendered).toContain('The hydrated biography.');
		expect(sent).toContain('before-rename');
		expect(sent).not.toContain('The hydrated biography.');
		expect(store.requestForMessage(row.seq)?.attempts[0]?.body).toBe(sent);
	});

	it('returns one response entry for two provider errors and one success', () => {
		const id = request();
		for (let index = 0; index < 3; index++) {
			const attempt = store.startAttempt(id, JSON.stringify({ messages: [], attempt: index }));
			store.settle(attempt, index < 2 ? { kind: 'provider_error', status: 503, errorType: 'unavailable', message: 'Unavailable.' } : { kind: 'success', response: 'Reply' });
		}
		store.finish(id, 'succeeded');
		const row = append();
		expect(store.entries([row], null)).toMatchObject([{ kind: 'message', requestId: id, attempts: { count: 3, failures: [{ outcome: { kind: 'provider_error' } }, { outcome: { kind: 'provider_error' } }] } }]);
	});

	it('returns a failed notice and hides invalid output covered by its retry', () => {
		const id = request();
		const attempt = store.startAttempt(id, '{"messages":[]}');
		store.settle(attempt, { kind: 'dropped_invalid_output', droppedCalls: [{ id: 'call', name: 'action', reason: 'invalid_arguments_json', argumentsPreview: '{' }] });
		const dropped = messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Invalid' }, 'dropped_provider_response', 'invalid', { streamSeq: 1 });
		store.begin({ runId: 'run', eventSeq: 2, purpose: 'loop', existingId: id });
		const retry = store.startAttempt(id, '{"messages":[{"role":"assistant","content":"Correction"}]}');
		store.settle(retry, { kind: 'timeout' });
		store.finish(id, 'failed');
		expect(store.entries([dropped], null)).toMatchObject([{ kind: 'notice', notice: { kind: 'request_failed', requestId: id, attempts: { count: 2 } } }]);
	});

	it('keeps split requests in one compaction session and retains validation issues', () => {
		const sessionId = store.startSession('run', { kind: 'manual' });
		for (let seq = 1; seq <= 2; seq++) {
			const id = store.begin({ runId: 'run', eventSeq: seq, purpose: 'compaction', sessionId });
			const attempt = store.startAttempt(id, JSON.stringify({ batch: seq }));
			store.settle(attempt, seq === 1 ? { kind: 'provider_error', status: 400, errorType: 'output_limit', message: 'Output limit.' } : { kind: 'success', response: 'Summary' });
			store.finish(id, seq === 1 ? 'failed' : 'succeeded');
		}
		const issue = agentLogFailure(new ProviderStructuredOutputValidationError(botText('en'), 'compaction', { message: 'Invalid', ownerMessage: 'Invalid' } as never, { validationIssue: 'transcript_like_compaction' }));
		store.settleSession(sessionId, { kind: 'failed', error: issue });
		expect(store.session(sessionId)).toMatchObject({ requests: [{ state: 'failed' }, { state: 'succeeded' }], outcome: { kind: 'failed', error: { kind: 'validation', issue: 'transcript_like_compaction' } } });
	});

	it('assigns every origin and each synthetic source without reading the text', () => {
		const expected: Record<BotLoopMessageOrigin, string> = { input: 'bickr_report', injection: 'owner_injection', reminder: 'reminder', synthetic_context: 'legacy_synthetic', provider_response: 'model', dropped_provider_response: 'bickr_report', self_correction: 'self_correction', tool_result: 'bickr_report', tool_failure: 'bickr_report', runtime_error: 'bickr_report', compaction: 'compaction_summary', legacy_migration: 'legacy_summary', local_simulation: 'local_simulation' };
		for (const [origin, author] of Object.entries(expected)) expect(agentLogAuthor(origin as BotLoopMessageOrigin, 'assistant')).toEqual({ kind: author });
		for (const source of ['recurring_prompt', 'spotlight_focus', 'synthetic_tool_call'] satisfies AgentLogSource[]) {
			const row = messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Same text' }, 'synthetic_context', 'complete', { source });
			expect(store.entries([row], null)).toMatchObject([{ author: { kind: source } }]);
		}
		expect(agentLogAuthor('synthetic_context', 'tool')).toEqual({ kind: 'tool_result', synthetic: true });
		expect(agentLogAuthor('tool_failure', 'tool')).toEqual({ kind: 'tool_result', synthetic: false });
	});

	it('moves exact legacy logs once and leaves messages-only submissions to expire', () => {
		const row = append();
		const body = JSON.stringify({ messages: [{ role: 'user', content: 'Original' }], tools: [] });
		messages.recordLoopMessageLog(row.seq, 'provider_request', body);
		messages.recordLoopMessageLog(row.seq, 'provider_response', 'Reply');
		storage.sql.exec("UPDATE loop_messages SET author_json = NULL WHERE seq = ?", row.seq);
		store.migrate(messages);
		store.migrate(messages);
		expect(store.requestForMessage(row.seq)?.attempts.map(attempt => attempt.body)).toEqual([body]);
		expect(storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM loop_message_logs WHERE kind = 'provider_request'").one().n).toBe(0);
	});

	it('exempts the newest three pages and drops older request bodies after seven days without losing a retained delta', () => {
		const old = '2026-09-01';
		const ids: string[] = [];
		for (let seq = 1; seq <= 4; seq++) {
			const id = store.begin({ runId: 'run', eventSeq: seq, purpose: 'loop', createdAt: old }); ids.push(id);
			const attempt = store.startAttempt(id, 'A'.repeat(500) + seq);
			store.settle(attempt, { kind: 'success', response: 'Reply' }); store.finish(id, 'succeeded');
			const row = messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Reply' }, 'provider_response', 'complete', { streamSeq: seq });
			storage.sql.exec('UPDATE loop_messages SET created_at = ? WHERE seq = ?', old, row.seq);
			if (seq < 4) {
				const summary = messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Summary' }, 'compaction');
				storage.sql.exec('UPDATE loop_messages SET compacted_by = ? WHERE compacted_by IS NULL AND seq != ?', summary.seq, summary.seq);
			}
		}
		store.prune(messages, new Date('2026-10-24'));
		expect(() => store.request(ids[0]!)).toThrow('not retained');
		for (const id of ids.slice(1)) expect(store.request(id).attempts[0]?.body).toMatch(/^A{500}[234]$/);
		const result = messages.pruneExpiredLoopMessages({ now: new Date('2026-10-24') });
		expect(result.deletedMessages).toBe(1);
	});

	it('settles interrupted work after a restart and removes it when history is cleared', () => {
		const id = request();
		store.startAttempt(id, '{"messages":[]}');
		const sessionId = store.startSession('run', { kind: 'admission' });
		store.recoverInterrupted();
		expect(store.request(id)).toMatchObject({ state: 'failed', attempts: [{ outcome: { kind: 'interrupted' } }] });
		expect(store.session(sessionId).outcome).toEqual({ kind: 'failed', error: { kind: 'interrupted' } });
		store.clear();
		expect(store.entries([], null)).toEqual([]);
	});

	it('deletes an archived summary without restoring its children to the model context', () => {
		const child = messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Old' }, 'provider_response');
		const first = messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'First summary' }, 'compaction');
		const second = messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Second summary' }, 'compaction');
		storage.sql.exec('UPDATE loop_messages SET compacted_by = ? WHERE seq = ?', first.seq, child.seq);
		storage.sql.exec('UPDATE loop_messages SET compacted_by = ? WHERE seq = ?', second.seq, first.seq);
		messages.softDeleteLoopMessage(first.seq);
		expect(messages.activeLoopMessageRows().map(row => row.seq)).toEqual([second.seq]);
		expect(messages.loopMessageRow(child.seq)?.compacted_by).toBe(second.seq);
	});

	it('keeps batch one when batch two of three fails and reports partial success', async () => {
		for (let index = 0; index < 3; index++) messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: `Batch ${index}` }, 'provider_response');
		const rows = messages.activeLoopMessageRows();
		const compact = vi.fn(async (_context, _bot, _settings, _runId, _signal, selected) => {
			if (compact.mock.calls.length === 2) {
				expect(JSON.parse(selected[0].message_json).content).toBe('Updated by batch one');
				throw new ProviderStructuredOutputValidationError(botText('en'), 'compaction', { message: 'Invalid', ownerMessage: 'The second batch failed.' } as never, { validationIssue: 'transcript_like_compaction' });
			}
			const sessionId = storage.sql.exec<{ id: string }>('SELECT id FROM compaction_sessions LIMIT 1').one().id;
			const summary = messages.insertLoopMessage(testResultContext, { runId: 'run', message: { role: 'assistant', content: 'Kept summary' }, origin: 'compaction', status: 'complete', position: selected[0].position, broadcast: false });
			storage.sql.exec('UPDATE loop_messages SET session_id = ? WHERE seq = ?', sessionId, summary.seq);
			storage.sql.exec('UPDATE loop_messages SET compacted_by = ? WHERE seq = ?', summary.seq, selected[0].seq);
			storage.sql.exec('UPDATE loop_messages SET message_json = ? WHERE seq = ?', JSON.stringify({ role: 'assistant', content: 'Updated by batch one' }), rows[1]!.seq);
			return selected;
		});
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage }, broadcastControl: vi.fn(), compactLoopMessageRowsForSession: compact,
			textTokenCalibration: () => ({ tokensPerCharacter: 1 }), renderLoopMessageRow: (_context: unknown, row: { message_json: string }) => JSON.parse(row.message_json),
			compactionPromptTokenLimit: () => 1, compactionRowsLeaveOutputBudget: () => true,
		});
		await expect(runtime.compactLoopMessageRowsInBatches(testResultContext, { text: botText('en') }, { model: 'test', text: botText('en') }, 'run', new AbortController().signal, rows, 'manual', {})).rejects.toThrow('second batch');
		expect(compact).toHaveBeenCalledTimes(2);
		const active = messages.activeLoopMessageRows();
		expect(active.map(row => JSON.parse(row.message_json).content)).toEqual(['Kept summary', 'Updated by batch one', 'Batch 2']);
		const sessionId = storage.sql.exec<{ id: string }>('SELECT id FROM compaction_sessions LIMIT 1').one().id;
		expect(store.session(sessionId).outcome).toEqual({ kind: 'partial', summarySeqs: [active[0]!.seq], failedBatchCount: 1, error: { kind: 'validation', issue: 'transcript_like_compaction', message: expect.stringContaining('The second batch failed.') } });
		expect(messages.loopMessagesPage(testResultContext, { page: 1 }).page.pages[0]?.compactionSessionId).toBe(sessionId);
	});

	it('rejects synthetic assistant writes that do not name their source', () => {
		expect(() => messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Unknown source' }, 'synthetic_context')).toThrow('requires a source');
		expect(messages.activeLoopMessageRows()).toEqual([]);
	});

	it('keeps a pending retry on the newest page after its original anchor is compacted', () => {
		const anchor = messages.appendLoopMessage(testResultContext, 'run', { role: 'user', content: 'Before retry' }, 'input');
		const id = request();
		const first = store.startAttempt(id, '{"messages":[]}');
		store.settle(first, { kind: 'dropped_invalid_output', droppedCalls: [] });
		const summary = messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Summary' }, 'compaction');
		storage.sql.exec('UPDATE loop_messages SET compacted_by = ? WHERE seq = ?', summary.seq, anchor.seq);
		store.begin({ runId: 'run', eventSeq: 2, purpose: 'loop', existingId: id });
		store.startAttempt(id, '{"messages":[{"role":"assistant","content":"Summary"}]}');
		expect(store.entries([], null)).toMatchObject([{ kind: 'live', requestId: id }]);
		expect(store.entries([], summary.seq)).toEqual([]);
	});

	it('reports the context changed by the deletion transaction after a concurrent compaction', async () => {
		const row = append();
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const runtime = Object.assign(Object.create(BotRuntime.prototype), { state: { storage }, readStatus: async () => { await gate; return { status: 'idle' }; }, broadcastControl: vi.fn() });
		const deleting = runtime.deleteLoopMessage('participant', row.seq);
		const summary = messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Summary' }, 'compaction');
		storage.sql.exec('UPDATE loop_messages SET compacted_by = ? WHERE seq = ?', summary.seq, row.seq);
		release();
		expect(await deleting).toMatchObject({ changedContext: false });
		expect(await runtime.deleteLoopMessage('participant', row.seq)).toMatchObject({ changedContext: false });
	});

	it('blocks a delayed provider rejection after a full storage clear', async () => {
		let rejectFetch!: (error: unknown) => void;
		let active = true;
		const fetchGate = new Promise<never>((_resolve, reject) => { rejectFetch = reject; });
		const deletingStorage = Object.assign(storage, { deleteAll: async () => {
			const tables = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray();
			for (const table of tables) storage.database.exec(`DROP TABLE ${table.name}`);
		} });
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage: deletingStorage, getWebSockets: () => [] }, env: {},
			renewProgressLease: vi.fn(), throwIfStopped: vi.fn(),
			beginMaintenanceOperation: vi.fn(), finishMaintenanceOperation: vi.fn(), broadcastControl: vi.fn(),
			fetchProviderResponse: vi.fn(async () => fetchGate),
		});
		const pending = withRunExecution(() => active, () => runtime.callProvider({ text: botText('en'), model: 'test', baseUrl: 'https://example.test/v1' }, [], [], 'run', 1, new AbortController().signal, 'participant')).catch((error: unknown) => error);
		await vi.waitFor(() => expect(runtime.fetchProviderResponse).toHaveBeenCalledOnce());
		settleOutsideExecution(() => store.failPending('run', { kind: 'interrupted' }));
		active = false;
		await runtime.clearRuntimeStorage('participant');
		rejectFetch(new Error('The old fetch failed.'));
		expect(await pending).toMatchObject({ name: 'TickStoppedError' });
		for (const table of ['inference_requests', 'inference_attempts', 'inference_body_chunks', 'compaction_sessions']) expect(storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n).toBe(0);
	});

	it('blocks unscoped writers after the stored clear marker', () => {
		storage.sql.exec("INSERT INTO runtime_state(key, value_json) VALUES ('runtime_storage_cleared_at', ?)", JSON.stringify('2026-10-24'));
		expect(() => request()).toThrow('was erased');
		expect(() => messages.insertLoopMessage(testResultContext, { runId: 'run', origin: 'provider_response', message: { role: 'assistant', content: 'Late' }, broadcast: false })).toThrow('was erased');
		expect(storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM loop_messages').one().n).toBe(0);
	});

	it('settles pending requests and sessions inside terminal finalization', async () => {
		const id = request();
		store.startAttempt(id, '{"messages":[]}');
		const sessionId = store.startSession('run', { kind: 'admission' });
		let active = true;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage }, liveness: { read: () => active ? { kind: 'active', runId: 'run' } : null, finish: () => { active = false; return { kind: 'finalizing' }; } },
			hasTerminalEvent: () => false, settlePendingTool: vi.fn(), markPendingCompactionEventsFailed: vi.fn(), appendEvent: vi.fn(), reconcileRunJournal: vi.fn(),
		});
		await runtime.finalizeRun(testResultContext, 'run', 'tick_stopped', { message: 'Stopped.' });
		expect(store.request(id)).toMatchObject({ state: 'failed', attempts: [{ outcome: { kind: 'interrupted' } }] });
		expect(store.session(sessionId).outcome).toEqual({ kind: 'failed', error: { kind: 'interrupted' } });
		expect(store.entries([], null).some(entry => entry.kind === 'live')).toBe(false);
	});

	it('keeps a large response in bounded chunks and reads it without loss', () => {
		const id = request();
		const attempt = store.startAttempt(id, '{"messages":[]}');
		const response = '"\\'.repeat(1_100_000);
		store.settle(attempt, { kind: 'success', response });
		expect(store.request(id).attempts[0]?.outcome).toEqual({ kind: 'success', response });
		expect(storage.sql.exec<{ n: number }>('SELECT MAX(length(text)) AS n FROM inference_body_chunks').one().n).toBeLessThan(2_000_000);
		expect(storage.sql.exec<{ n: number }>('SELECT length(outcome_json) AS n FROM inference_attempts WHERE id = ?', attempt).one().n).toBeLessThan(100);
	});

	it('preserves invalid outcomes when moving historical exact requests', () => {
		const row = messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Invalid' }, 'dropped_provider_response', 'invalid', { streamSeq: 1 });
		messages.recordLoopMessageLog(row.seq, 'provider_request', '{"messages":[]}');
		messages.recordLoopMessageLog(row.seq, 'provider_response', JSON.stringify({ droppedToolCalls: [{ id: 'bad', name: 'action', reason: 'invalid_arguments_json' }] }));
		store.migrate(messages);
		expect(store.requestForMessage(row.seq)).toMatchObject({ state: 'failed', attempts: [{ outcome: { kind: 'dropped_invalid_output', droppedCalls: [{ id: 'bad' }] } }] });
	});

	it('caps delta depth and reconstructs the body at the limit exactly', () => {
		const id = request();
		let atLimit = '';
		let atLimitId = 0;
		let last = 0;
		for (let index = 0; index < 300; index++) {
			const body = 'shared system prompt '.repeat(40) + index;
			last = store.startAttempt(id, body);
			let depth = 0;
			let next = storage.sql.exec<{ base_id: number | null }>('SELECT base_id FROM inference_attempts WHERE id = ?', last).one().base_id;
			while (next !== null) { depth++; next = storage.sql.exec<{ base_id: number | null }>('SELECT base_id FROM inference_attempts WHERE id = ?', next).one().base_id; }
			expect(depth).toBeLessThanOrEqual(agentLogDeltaDepthLimit);
			if (depth === agentLogDeltaDepthLimit) { atLimit = body; atLimitId = last; }
		}
		expect(atLimitId).toBeGreaterThan(0);
		expect(store.body(atLimitId)).toBe(atLimit);
		const sql = vi.spyOn(storage.sql, 'exec');
		store.startAttempt(id, 'shared system prompt '.repeat(40) + 'next');
		expect(sql.mock.calls.length).toBeLessThan(80);
	});

	it('keeps an emoji intact at a common-prefix cut', () => {
		const id = request();
		store.startAttempt(id, 'a'.repeat(100) + '😀 first');
		const body = 'a'.repeat(100) + '😁 next';
		const attempt = store.startAttempt(id, body);
		expect(store.body(attempt)).toBe(body);
		expect(storage.sql.exec<{ prefix_length: number }>('SELECT prefix_length FROM inference_attempts WHERE id = ?', attempt).one().prefix_length).toBe(100);
	});

	it('keeps an emoji intact at a fixed chunk cut', () => {
		const body = 'a'.repeat(63_999) + '😀 tail';
		const attempt = store.startAttempt(request(), body);
		expect(store.body(attempt)).toBe(body);
		expect(storage.sql.exec<{ text: string }>('SELECT text FROM inference_body_chunks WHERE attempt_id = ? ORDER BY chunk_index', attempt).toArray().map(row => row.text)).toEqual(['a'.repeat(63_999), '😀 tail']);
	});

	it('serves live text from memory and bounds stream flushes by bytes and time', () => {
		const id = request();
		const attempt = store.startAttempt(id, '{}');
		let now = 1_000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const writes = vi.spyOn(storage, 'transactionSync');
		for (let index = 0; index < 10_000; index++) store.partial('run', 1, { kind: 'content', text: 'x'.repeat(20) });
		expect(writes.mock.calls.length).toBeLessThanOrEqual(Math.floor(200_000 / 4_096));
		expect(JSON.parse(store.request(id).attempts[0]!.partialResponse!).content).toBe('x'.repeat(200_000));
		expect(store.entries([], null)).toMatchObject([{ kind: 'live', partialResponse: store.request(id).attempts[0]!.partialResponse }]);
		now = Date.now() + 1_000_000;
		store.partial('run', 1, { kind: 'reasoning', source: 'plain', text: 'Timed flush' });
		const recovered = new AgentLogStore(storage);
		recovered.recoverInterrupted();
		expect(recovered.request(id).attempts[0]).toMatchObject({ outcome: { kind: 'interrupted' } });
		expect(JSON.parse(recovered.request(id).attempts[0]!.partialResponse!).reasoning).toBe('Timed flush');
		store.settle(attempt, { kind: 'timeout' });
		expect(JSON.parse(new AgentLogStore(storage).request(id).attempts[0]!.partialResponse!).content).toHaveLength(200_000);
	});

	it('keeps typed partial reasoning in memory, on disk, and after recovery without opaque bytes', () => {
		const id = request();
		const attempt = store.startAttempt(id, '{}');
		const deltas: AgentLogStreamDelta[] = [
			{ kind: 'reasoning', source: 'plain', text: 'Plain' },
			{ kind: 'reasoning', source: 'detail', text: 'Sum', part: { kind: 'readable', type: 'reasoning.summary', index: 0, id: 'summary', text: 'Sum' } },
			{ kind: 'reasoning', source: 'detail', text: 'mary', part: { kind: 'readable', type: 'reasoning.summary', index: 0, id: 'summary', text: 'mary' } },
			{ kind: 'reasoning', source: 'detail', part: { kind: 'opaque', type: 'reasoning.encrypted', index: 1, id: 'secret' } },
			{ kind: 'reasoning', source: 'detail', part: { kind: 'opaque', type: 'future.type', id: 'future' } },
		];
		for (const delta of deltas) store.partial('run', 1, delta);
		store.partial('run', 1, deltas[3]!);
		store.partial('run', 1, { kind: 'reasoning', source: 'detail', part: { kind: 'readable', type: 'future.type', id: 'future', text: 'OPAQUE', data: 'OPAQUE' } } as unknown as AgentLogStreamDelta);
		const expected = {
			content: '', reasoning: 'PlainSummary', reasoningParts: [
				{ kind: 'text', text: 'Plain' },
				{ kind: 'readable', type: 'reasoning.summary', index: 0, id: 'summary', text: 'Summary' },
				{ kind: 'opaque', type: 'reasoning.encrypted', index: 1, id: 'secret' },
				{ kind: 'opaque', type: 'future.type', id: 'future' },
			], toolCalls: [],
		};
		const partial = store.request(id).attempts[0]!.partialResponse!;
		expect(JSON.parse(partial)).toEqual(expected);
		expect(store.entries([], null)).toMatchObject([{ kind: 'live', partialResponse: partial }]);
		expect(partial).not.toContain('OPAQUE');
		store.settle(attempt, { kind: 'interrupted' });
		const recovered = new AgentLogStore(storage);
		recovered.recoverInterrupted();
		expect(JSON.parse(recovered.request(id).attempts[0]!.partialResponse!)).toEqual(expected);
		const stored = storage.sql.exec<{ text: string }>("SELECT text FROM inference_body_chunks WHERE attempt_id = ? AND kind = 'partial' ORDER BY chunk_index", attempt).toArray().map(row => row.text).join('');
		expect(JSON.parse(stored)).toEqual(expected);
		expect(stored).not.toContain('OPAQUE');
	});

	it.each([true, false])('keeps settled reasoning safe in the outcome and recovered history when completed=%s', async completed => {
		const id = request();
		const attempt = store.startAttempt(id, '{}');
		const deltas: AgentLogStreamDelta[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			agentLogs: store, runtimeMessageStore: () => messages,
			clearPendingTool: () => {}, throwIfStopped: () => {},
			broadcastProviderDelta: (runId: string, seq: number, delta: AgentLogStreamDelta) => {
				deltas.push(delta);
				store.partial(runId, seq, delta);
			},
		});
		const details = [
			{ type: 'reasoning.text', index: 0, text: 'Text' },
			{ type: 'reasoning.summary', index: 1, summary: 'Summary' },
			{ type: 'reasoning.encrypted', index: 2, text: 'OPAQUE_ENCRYPTED', data: 'EXACT_SIGNATURE' },
			{ type: 'future.type', index: 3, text: 'OPAQUE_FUTURE' },
		];
		const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Reply', reasoning: 'Plain', reasoning_details: details } }] })}\n\n`;
		const body = new ReadableStream<Uint8Array>({ start(controller) {
			controller.enqueue(new TextEncoder().encode(frame + (completed ? 'data: [DONE]\n\n' : '')));
			controller.close();
		} });
		let response: ProviderResponse;
		try {
			response = await runtime.consumeProviderResponse('run', 1, body, new AbortController().signal);
			expect(completed).toBe(true);
		} catch (error) {
			expect(completed).toBe(false);
			expect(error).toBeInstanceOf(ProviderResponseInterruptedError);
			response = (error as ProviderResponseInterruptedError).response;
		}
		expect(response.reasoning).toBe('PlainTextSummary');
		expect(response.reasoningDetails).toEqual(details);
		expect(JSON.stringify(deltas)).not.toContain('OPAQUE');
		const raw = JSON.stringify({ message: { role: 'assistant', content: response.content, reasoning: response.reasoning, reasoning_details: response.reasoningDetails } });
		store.settle(attempt, { kind: completed ? 'success' : 'interrupted', response: raw });
		store.stageResponsePublication({ kind: 'provider_response', runId: 'run', requestId: id, eventSeq: 1, attemptId: attempt, assistantSeq: null, pendingCallIds: [] });
		runtime.settleResponsePublication(testResultContext, 'run', null);
		const saved = new AgentLogStore(storage).request(id).attempts[0]!;
		expect(saved.outcome).toMatchObject({ response: raw });
		expect(JSON.parse(raw).message.reasoning).toBe('PlainTextSummary');
		expect(JSON.parse(saved.partialResponse!).reasoning).toBe('PlainTextSummary');
		expect(saved.partialResponse).not.toContain('OPAQUE');
		const row = messages.loopMessagesAfter(testResultContext, 0)[0]!;
		expect(row.message.reasoning).toBeUndefined();
		expect(row.message.reasoning_details).toEqual(details);
		expect(reasoningTextFromDetails(row.message.reasoning_details!)).toBe('TextSummary');
		expect(store.requestForMessage(row.seq)?.id).toBe(id);
	});

	it('keeps interleaved readable parts in arrival order through a flush', () => {
		const id = request();
		const attempt = store.startAttempt(id, '{}');
		store.partial('run', 1, { kind: 'reasoning', source: 'detail', text: 'A', part: { kind: 'readable', type: 'reasoning.text', index: 0, text: 'A' } });
		store.partial('run', 1, { kind: 'reasoning', source: 'plain', text: 'B' });
		store.partial('run', 1, { kind: 'reasoning', source: 'detail', text: 'C', part: { kind: 'readable', type: 'reasoning.text', index: 0, text: 'C' } });
		const partial = store.request(id).attempts[0]!.partialResponse!;
		expect(JSON.parse(partial)).toMatchObject({ reasoning: 'ABC', reasoningParts: [
			{ kind: 'readable', text: 'A' }, { kind: 'text', text: 'B' }, { kind: 'readable', text: 'C' },
		] });
		store.settle(attempt, { kind: 'interrupted' });
		expect(new AgentLogStore(storage).request(id).attempts[0]!.partialResponse).toBe(partial);
	});

	it('flushes an opaque-only partial response at settlement', () => {
		const id = request();
		const attempt = store.startAttempt(id, '{}');
		store.partial('run', 1, { kind: 'reasoning', source: 'detail', part: { kind: 'opaque', type: 'future.type', index: 0 } });
		store.settle(attempt, { kind: 'timeout' });
		expect(JSON.parse(new AgentLogStore(storage).request(id).attempts[0]!.partialResponse!)).toEqual({
			content: '', reasoning: '', reasoningParts: [{ kind: 'opaque', type: 'future.type', index: 0 }], toolCalls: [],
		});
	});

	it('migrates legacy partial reasoning in resumable batches and never repairs on read', () => {
		let id = '';
		for (let eventSeq = 1; eventSeq <= 101; eventSeq++) {
			id = request(eventSeq);
			const attempt = store.startAttempt(id, '{}');
			store.settle(attempt, { kind: 'interrupted' });
			storage.sql.exec("INSERT INTO inference_body_chunks(attempt_id, kind, chunk_index, text) VALUES (?, 'partial', 0, ?)", attempt, JSON.stringify({ content: 'Reply', reasoning: 'OPAQUE_LEGACY', toolCalls: [] }));
			storage.sql.exec("UPDATE inference_attempts SET partial_response = 'retained' WHERE id = ?", attempt);
		}
		const original = storage.sql.exec<{ text: string }>("SELECT text FROM inference_body_chunks WHERE attempt_id = 101 AND kind = 'partial'").one().text;
		expect(store.request(id).attempts[0]!.partialResponse).not.toContain('OPAQUE_LEGACY');
		expect(storage.sql.exec<{ text: string }>("SELECT text FROM inference_body_chunks WHERE attempt_id = 101 AND kind = 'partial'").one().text).toBe(original);
		store.migrate(messages);
		expect(store.migrationStatus().partialReasoningPending).toBe(true);
		expect(storage.sql.exec<{ text: string }>("SELECT text FROM inference_body_chunks WHERE attempt_id = 101 AND kind = 'partial'").one().text).toBe(original);
		const restarted = new AgentLogStore(storage);
		restarted.migrate(messages);
		expect(restarted.migrationStatus().partialReasoningPending).toBe(false);
		const migrated = storage.sql.exec<{ text: string }>("SELECT text FROM inference_body_chunks WHERE attempt_id = 101 AND kind = 'partial'").one().text;
		expect(JSON.parse(migrated)).toEqual({ content: 'Reply', reasoning: '', reasoningParts: [{ kind: 'opaque', type: null }], toolCalls: [] });
		restarted.migrate(messages);
		expect(storage.sql.exec<{ text: string }>("SELECT text FROM inference_body_chunks WHERE attempt_id = 101 AND kind = 'partial'").one().text).toBe(migrated);
	});

	it('flushes the last partial text at settlement', () => {
		const id = request();
		const attempt = store.startAttempt(id, '{}');
		store.partial('run', 1, { kind: 'content', text: 'Last text' });
		expect(new AgentLogStore(storage).request(id).attempts[0]!.partialResponse).toBeNull();
		store.settle(attempt, { kind: 'interrupted' });
		expect(JSON.parse(new AgentLogStore(storage).request(id).attempts[0]!.partialResponse!).content).toBe('Last text');
	});

	it('selects nested fields from stored records through the public store methods', () => {
		const id = request();
		const attempt = store.startAttempt(id, '{}');
		store.settle(attempt, { kind: 'dropped_invalid_output', droppedCalls: [{ id: 'call', name: 'action', reason: 'invalid', argumentsPreview: '{}' }] });
		const leaked = { kind: 'dropped_invalid_output', internalSecret: 'private', droppedCalls: [{ id: 'call', name: 'action', reason: 'invalid', argumentsPreview: '{}', internalSecret: 'private' }] };
		storage.sql.exec("UPDATE inference_body_chunks SET text = ? WHERE attempt_id = ? AND kind = 'outcome'", JSON.stringify(leaked), attempt);
		const row = append();
		storage.sql.exec('UPDATE loop_messages SET author_json = ? WHERE seq = ?', JSON.stringify({ kind: 'model', internalSecret: 'private' }), row.seq);
		const sessionId = store.startSession('run', { kind: 'manual' });
		storage.sql.exec('UPDATE compaction_sessions SET trigger_json = ?, outcome_json = ? WHERE id = ?', JSON.stringify({ kind: 'manual', internalSecret: 'private' }), JSON.stringify({ kind: 'failed', error: leaked, internalSecret: 'private' }), sessionId);
		for (const value of [store.request(id), store.summary(id), store.entries([row], null), store.session(sessionId)]) expect(JSON.stringify(value)).not.toContain('internalSecret');
	});

	it('contains unknown outcomes and rejects unsupported trigger metadata', () => {
		const id = request();
		const attempt = store.startAttempt(id, '{}');
		store.settle(attempt, { kind: 'timeout' });
		storage.sql.exec("UPDATE inference_body_chunks SET text = ? WHERE attempt_id = ? AND kind = 'outcome'", '{"kind":"unknown","internalSecret":"private"}', attempt);
		expect(store.request(id).attempts[0]?.outcome).toEqual({ kind: 'unknown' });
		expect(store.summary(id).failures).toEqual([{ attemptId: attempt, outcome: { kind: 'unknown' } }]);
		const row = append();
		storage.sql.exec("UPDATE inference_body_chunks SET text = ? WHERE attempt_id = ? AND kind = 'outcome'", '{"kind":"timeout"}', attempt);
		storage.sql.exec('UPDATE loop_messages SET author_json = ? WHERE seq = ?', '{"kind":"unknown"}', row.seq);
		expect(store.entries([row], null)).toMatchObject([{ kind: 'message', author: { kind: 'unknown' } }]);
		const sessionId = store.startSession('other', { kind: 'manual' });
		storage.sql.exec('UPDATE compaction_sessions SET outcome_json = ? WHERE id = ?', '{"kind":"unknown"}', sessionId);
		expect(store.session(sessionId).outcome).toEqual({ kind: 'failed', error: { kind: 'unknown' } });
		storage.sql.exec('UPDATE compaction_sessions SET outcome_json = ?, trigger_json = ? WHERE id = ?', '{"kind":"pending"}', '{"kind":"unknown"}', sessionId);
		expect(() => store.session(sessionId)).toThrow('The stored agent log has an unsupported shape.');
	});

	it('contains one unknown author between valid entries', () => {
		const rows = [append(), append(), append()];
		storage.sql.exec('UPDATE loop_messages SET author_json = ? WHERE seq = ?', '{"kind":"future_author","internalSecret":"private"}', rows[1]!.seq);
		const entries = store.entries(rows, null);
		expect(entries).toMatchObject([{ kind: 'message', author: { kind: 'model' } }, { kind: 'message', author: { kind: 'unknown' } }, { kind: 'message', author: { kind: 'model' } }]);
		expect(JSON.stringify(entries)).not.toContain('internalSecret');
	});

	it('keeps page read counts flat across messages and failed attempts', () => {
		const rows = [];
		for (let seq = 1; seq <= 120; seq++) {
			const id = request(seq);
			store.settle(store.startAttempt(id, '{}'), { kind: 'provider_error', status: 429, errorType: 'busy', message: 'Retry.' });
			store.settle(store.startAttempt(id, '{}'), { kind: 'success', response: 'Reply' });
			store.finish(id, 'succeeded');
			rows.push(messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Reply' }, 'provider_response', 'complete', { streamSeq: seq }));
		}
		const sql = vi.spyOn(storage.sql, 'exec');
		const single = store.entries(rows.slice(0, 1), null);
		const singleReads = sql.mock.calls.length;
		sql.mockClear();
		const page = store.entries(rows, null);
		expect(page).toHaveLength(120);
		expect(page.every(entry => entry.kind === 'message' && entry.attempts?.count === 2 && entry.attempts.failures.length === 1)).toBe(true);
		expect(single).toHaveLength(1);
		expect(sql.mock.calls.length).toBe(singleReads);
		expect(singleReads).toBeLessThanOrEqual(6);
	});

	it('counts pending journals without request references for their removal sweep', () => {
		storage.sql.exec('INSERT INTO runtime_state(key, value_json) VALUES (?, ?)', 'pending_tool_v3', JSON.stringify({ kind: 'provider_group', runId: 'run' }));
		expect(store.migrationStatus().legacyPendingRequestsRemain).toBe(true);
		storage.sql.exec('UPDATE runtime_state SET value_json = ? WHERE key = ?', JSON.stringify({ kind: 'provider_group', runId: 'run', requestId: 'request', requestEventSeq: 1 }), 'pending_tool_v3');
		expect(store.migrationStatus().legacyPendingRequestsRemain).toBe(false);
	});

	it('identifies each stream attempt and counts its deltas in live entries', () => {
		const id = request();
		const first = store.startAttempt(id, '{}');
		store.partial('run', 1, { kind: 'content', text: 'A' });
		store.partial('run', 1, { kind: 'content', text: 'B' });
		expect(store.streamState('run', 1)).toEqual({ kind: 'stream', attemptId: first, revision: 2 });
		expect(store.entries([], null)).toMatchObject([{ kind: 'live', attemptId: first, deltaRevision: 2 }]);
		store.settle(first, { kind: 'provider_error', status: null, errorType: null, message: 'Retry' });
		const second = store.startAttempt(id, '{}');
		store.partial('run', 1, { kind: 'content', text: 'New attempt' });
		expect(store.streamState('run', 1)).toEqual({ kind: 'stream', attemptId: second, revision: 1 });
		expect(store.entries([], null)).toMatchObject([{ kind: 'live', attemptId: second, deltaRevision: 1 }]);
	});

	it('rolls back request completion if the response journal cannot be written', () => {
		const id = request();
		const attemptId = store.startAttempt(id, '{}');
		storage.database.exec("CREATE TRIGGER fail_publication BEFORE INSERT ON runtime_state WHEN NEW.key = 'pending_response_v1' BEGIN SELECT RAISE(ABORT, 'publication failed'); END");
		expect(() => storage.transactionSync(() => {
			store.settle(attemptId, { kind: 'success', response: '{"message":{"role":"assistant","content":"Retained"}}' });
			store.stageResponsePublication({ kind: 'provider_response', requestId: id, attemptId, runId: 'run', eventSeq: 1, assistantSeq: null, pendingCallIds: [] });
			store.finish(id, 'succeeded');
		})).toThrow('publication failed');
		expect(store.request(id)).toMatchObject({ state: 'pending', messageSeq: null, attempts: [{ outcome: null }] });
		expect(store.responsePublication('run')).toBeNull();
	});

	it('keeps structured provider status and error type', () => {
		expect(agentLogFailure(new ProviderRequestError(429, 'test', 'https://example.test', 'Refused', { providerError: { kind: 'provider_error', status: 429, errorType: 'rate_limit' } }))).toMatchObject({ kind: 'provider_error', status: 429, errorType: 'rate_limit' });
	});
});
