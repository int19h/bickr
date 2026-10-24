import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotLoopMessagesResponse } from '@bickr/shared/model';
import { AgentLogStore } from './agent-log-store';
import { BotRuntime, runtimeSchema } from './bot-runtime';
import { RuntimeMessageStore } from './message-store';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
import { testResultContext } from './result-render-context.test-support';

let storage: RuntimeTestStorage;
let logs: AgentLogStore;
let messages: RuntimeMessageStore;
beforeEach(() => {
	storage = createRuntimeTestStorage();
	storage.database.exec(runtimeSchema);
	logs = new AgentLogStore(storage);
	messages = new RuntimeMessageStore(storage);
});
afterEach(() => storage.database.close());
function runtime() {
	return Object.assign(Object.create(BotRuntime.prototype), {
		state: { storage }, agentLogs: logs, requireOwnerOrInternal: vi.fn(),
	});
}
async function endpoint(instance: ReturnType<typeof runtime>, path: string) {
	const url = new URL(`https://internal/bots/participant/${path}`);
	const response = await instance.handleRuntimeReadRequest(new Request(url), url, 'participant');
	expect(response.status).toBe(200);
	return (await response.json()).data;
}
function replaceOutcome(attempt: number, value: string) {
	storage.sql.exec('UPDATE inference_attempts SET outcome_json = ? WHERE id = ?', value, attempt);
	storage.sql.exec('UPDATE inference_body_chunks SET text = ? WHERE attempt_id = ? AND kind = ?', value, attempt, 'outcome');
}

it.each(['{"kind":"future_failure","internalSecret":"private"}', '{"kind":"validation","issue":42}', 'invalid JSON', ''])('loads a page and request with an unsupported attempt: %s', stored => {
	const id = logs.begin({ runId: 'run', eventSeq: 1, purpose: 'loop' });
	const first = logs.startAttempt(id, '{"exact":1}');
	logs.settle(first, { kind: 'timeout' });
	const second = logs.startAttempt(id, '{"exact":2}');
	logs.settle(second, { kind: 'success', response: 'Good response' });
	logs.finish(id, 'succeeded');
	messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'First message' }, 'provider_response', 'complete', { streamSeq: 1 });
	messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Other message' }, 'provider_response', 'complete', { streamSeq: 2 });
	replaceOutcome(first, stored);
	const instance = runtime();
	const page: BotLoopMessagesResponse = instance.loopMessagesPage(testResultContext, { page: 1 });
	expect(page.messages.map(row => row.message.content)).toEqual(['First message', 'Other message']);
	expect(page.entries).toMatchObject([
		{ kind: 'message', requestId: id, attempts: { count: 2, failures: [{ attemptId: first, outcome: { kind: 'unknown' } }] } },
		{ kind: 'message', requestId: null, attempts: null },
	]);
	expect(logs.request(id).attempts).toMatchObject([{ body: '{"exact":1}', outcome: { kind: 'unknown' } }, { body: '{"exact":2}', outcome: { kind: 'success', response: 'Good response' } }]);
	return endpoint(instance, `requests/${id}`).then(data => {
		expect(data.request.attempts).toMatchObject([{ outcome: { kind: 'unknown' } }, { outcome: { kind: 'success', response: 'Good response' } }]);
		expect(JSON.stringify(data)).not.toContain('private');
		expect(storage.sql.exec<{ outcome_json: string }>('SELECT outcome_json FROM inference_attempts WHERE id = ?', first).one().outcome_json).toBe(stored);
	});
});

it.each(['{"kind":"failed","error":{"kind":"future_failure","internalSecret":"private"}}', '{"kind":"future_outcome"}', 'invalid JSON', ''])('loads the page and session endpoint with an unsupported session outcome: %s', stored => {
	messages.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Kept message' }, 'provider_response');
	const good = logs.startSession('run', { kind: 'visit' });
	logs.settleSession(good, { kind: 'failed', error: { kind: 'timeout' } });
	const bad = logs.startSession('run', { kind: 'manual' });
	storage.sql.exec('UPDATE compaction_sessions SET outcome_json = ? WHERE id = ?', stored, bad);
	const requestId = logs.begin({ runId: 'run', eventSeq: 7, purpose: 'compaction', sessionId: bad });
	const attempt = logs.startAttempt(requestId, '{}');
	logs.settle(attempt, { kind: 'timeout' });
	logs.finish(requestId, 'failed');
	replaceOutcome(attempt, '{"kind":"future_failure"}');
	const instance = runtime();
	const page: BotLoopMessagesResponse = instance.loopMessagesPage(testResultContext, { page: 1 });
	expect(page.messages).toMatchObject([{ message: { content: 'Kept message' } }]);
	expect(page.entries).toContainEqual(expect.objectContaining({ kind: 'notice', notice: expect.objectContaining({ sessionId: good, outcome: { kind: 'failed', error: { kind: 'timeout' } } }) }));
	expect(page.entries).toContainEqual(expect.objectContaining({ kind: 'notice', notice: expect.objectContaining({ sessionId: bad, outcome: { kind: 'failed', error: { kind: 'unknown' } } }) }));
	return endpoint(instance, `compaction-sessions/${bad}`).then(data => {
		expect(data.session.outcome).toEqual({ kind: 'failed', error: { kind: 'unknown' } });
		expect(data.session.requests[0].attempts[0].outcome).toEqual({ kind: 'unknown' });
		expect(JSON.stringify(data)).not.toContain('private');
	});
});

it('rejects unsupported failures on write without storing an unknown value', () => {
	const id = logs.begin({ runId: 'run', eventSeq: 1, purpose: 'loop' });
	const attempt = logs.startAttempt(id, '{}');
	const session = logs.startSession('run', { kind: 'manual' });
	expect(() => logs.settle(attempt, { kind: 'unknown' })).toThrow('unsupported shape');
	expect(() => logs.settleSession(session, { kind: 'failed', error: { kind: 'unknown' } })).toThrow('unsupported shape');
	expect(logs.request(id).attempts[0]?.outcome).toBeNull();
	expect(logs.session(session).outcome).toEqual({ kind: 'pending' });
});


it('recovers valid sessions beside malformed stored outcomes without rewriting the malformed row', () => {
	const bad = logs.startSession('run', { kind: 'manual' });
	const good = logs.startSession('run', { kind: 'visit' });
	storage.sql.exec('UPDATE compaction_sessions SET outcome_json = ? WHERE id = ?', 'invalid JSON', bad);
	const cold = new AgentLogStore(storage);
	expect(() => cold.recoverInterrupted()).not.toThrow();
	expect(cold.session(good).outcome).toEqual({ kind: 'failed', error: { kind: 'interrupted' } });
	expect(cold.session(bad).outcome).toEqual({ kind: 'failed', error: { kind: 'unknown' } });
	const pending = cold.startSession('run', { kind: 'visit' });
	expect(() => cold.failPending('run', { kind: 'timeout' })).not.toThrow();
	expect(cold.session(pending).outcome).toEqual({ kind: 'failed', error: { kind: 'timeout' } });
	expect(() => cold.prune(messages)).not.toThrow();
	expect(storage.sql.exec<{ outcome_json: string }>('SELECT outcome_json FROM compaction_sessions WHERE id = ?', bad).one().outcome_json).toBe('invalid JSON');
});
