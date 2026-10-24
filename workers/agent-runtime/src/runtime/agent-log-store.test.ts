import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentLogAuthor, type AgentLogSource, type BotLoopMessageOrigin } from '@bickr/shared/model';
import { AgentLogStore, agentLogFailure } from './agent-log-store';
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
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage }, env: {}, renewProgressLease: vi.fn(), throwIfStopped: vi.fn(),
			requireOwnerOrInternal: vi.fn(), recordProviderTokenCalibrationSampleFromError: vi.fn(),
			fetchProviderResponse: vi.fn(async (_settings, _endpoint, body: string) => { sent = body; await gate; return new ReadableStream(); }),
			consumeProviderResponse: vi.fn(async () => response),
		});
		const pending = runtime.callProvider({ text: botText('en'), model: 'test', baseUrl: 'https://example.test/v1' }, [{ role: 'user', content: 'Before rename' }], [], 'run', 1, new AbortController().signal, 'participant', undefined, '2026-10-24');
		await vi.waitFor(() => expect(sent).not.toBe(''));
		const id = store.byEvent('run', 1)!.id;
		expect(store.request(id).attempts[0]?.body).toBe(sent);
		store.partial('run', 1, { kind: 'content', text: 'Par' });
		store.partial('run', 1, { kind: 'content', text: 'tial' });
		const url = new URL(`https://internal/bots/participant/requests/${id}`);
		const details = await runtime.handleRuntimeReadRequest(new Request(url), url, 'participant');
		expect((await details.json()).data.request.attempts[0]).toMatchObject({ body: sent, partialResponse: JSON.stringify({ content: 'Partial', reasoning: '', toolCalls: [] }) });
		expect(store.entries([], null)).toMatchObject([{ kind: 'live', requestId: id }]);
		release();
		await pending;
		const row = append();
		storage.sql.exec('UPDATE loop_messages SET message_json = ? WHERE seq = ?', JSON.stringify({ role: 'assistant', content: 'After rename and hydration' }), row.seq);
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

	it('commits no batch when a later compaction batch fails', async () => {
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage }, broadcastControl: vi.fn(),
			compactLoopMessageBatchesForSession: vi.fn(async () => {
				runtime.stagedCompactionCommits.push(() => messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Uncommitted summary' }, 'compaction'));
				throw new Error('The second batch failed.');
			}),
		});
		await expect(runtime.compactLoopMessageRowsInBatches(testResultContext, {}, {}, 'run', new AbortController().signal, [], 'manual', {})).rejects.toThrow('second batch');
		expect(messages.activeLoopMessageRows()).toEqual([]);
		const session = storage.sql.exec<{ id: string }>('SELECT id FROM compaction_sessions LIMIT 1').one();
		expect(store.session(session.id).outcome).toMatchObject({ kind: 'failed' });
	});

	it('rejects synthetic assistant writes that do not name their source', () => {
		expect(() => messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Unknown source' }, 'synthetic_context')).toThrow('requires a source');
		expect(messages.activeLoopMessageRows()).toEqual([]);
	});

	it('keeps structured provider status and error type', () => {
		expect(agentLogFailure(new ProviderRequestError(429, 'test', 'https://example.test', 'Refused', { providerError: { kind: 'provider_error', status: 429, errorType: 'rate_limit' } }))).toMatchObject({ kind: 'provider_error', status: 429, errorType: 'rate_limit' });
	});
});
