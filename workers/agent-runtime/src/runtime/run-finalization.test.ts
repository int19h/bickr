import type { AgentLogEntry, BotLoopMessagesResponse } from '@bickr/shared/model';
import { testResultContext } from './result-render-context.test-support';
import { botText } from '../localization';
const text = botText('en');
import { SelfCorrectingToolCallError } from '../errors';
import { RepositoryError } from '@bickr/shared/repository';
import { toolDefinitionsForProviderRound } from '../prompt-and-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLogStore } from './agent-log-store';
import { BotRuntime } from './bot-runtime';
import { createRuntimeTestStorage } from './sqlite-test-helper';
import { RunLiveness, cleanupTimeoutMs, transitionTimeoutMs } from './run-liveness';
import type { AdmittedTick, RuntimeBotDocument } from '../types';

afterEach(() => vi.useRealTimers());
const bot = { text, instructionLocale: 'en', id: 'bot', type: 'bot', schemaVersion: 1, revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01', homeWorldId: 'world', homeWorldHandle: 'world', ownerUserId: 'owner', handle: 'participant', language: null, includeLanguageInSystemPrompt: false, displayName: { lang: null, text: 'Participant' }, shortBio: { lang: null, text: '' }, prompt: { lang: null, text: '' }, inferenceSettings: {}, toolSettings: {}, tickSettings: { enabled: true, intervalSeconds: 60, allowEarlyLogOff: true, compactionThreshold: 0.75 } } satisfies RuntimeBotDocument;

async function harness() {
	const storage = { ...createRuntimeTestStorage(), setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}) };
	const controller = new AbortController();
	const release = vi.fn(async () => ({ success: true, meta: { changes: 1 } }));
	const statement = { bind: () => statement, run: release };
	const runtime = Object.assign(Object.create(BotRuntime.prototype), {
		state: { storage, getWebSockets: () => [], abort: vi.fn() },
		resultRenderContextForRows: async () => testResultContext,
		env: { BICKR_D1: { prepare: () => statement } },
		liveness: new RunLiveness(storage), activeRunId: 'run', activeAbortController: controller,
		runtimeStorageClearedAt: null,
		renewProgressLease: async () => {},
		exportRecentProviderUsage: vi.fn(async () => {}), startQueuedSpotlightTick: vi.fn(),
		pruneRuntimeStorageAfterTick: () => ({ events: 0, providerUsage: 0, loopMessages: { deletedMessages: 0, deletedLogs: 0, stampedSummaries: 0 }, injections: { deletedInjections: 0, droppedQueueEntries: 0 } }),
	});
	await runtime.liveness.begin({ botId: 'bot', runId: 'run', trigger: 'spotlight', intervalMs: 60_000, claimToken: null });
	const admitted: AdmittedTick = { bot, runId: 'run', abortController: controller, mode: 'spotlight', setupMode: 'spotlight', providerSettings: {} as AdmittedTick['providerSettings'] };
	return { runtime, storage, release, run: () => runtime.runAdmittedTick('bot', 'spotlight', {}, admitted) as Promise<{ status: string }> };
}

describe('run finalization fault injection', () => {
	it('clears the active slot before a hung export and bounds the finally block', async () => {
		vi.useFakeTimers();
		const h = await harness();
		h.runtime.exportRecentProviderUsage.mockImplementation(() => new Promise(() => {}));
		const run = h.run();
		await vi.advanceTimersByTimeAsync(1);
		expect(h.runtime.activeRunId).toBeNull();
		expect(h.runtime.liveness.read()).toBeNull();
		// A successor can take the slot while old accounting is suspended.
		h.runtime.activeRunId = 'successor';
		await vi.advanceTimersByTimeAsync(cleanupTimeoutMs);
		expect(await run).toEqual({ runId: 'run', status: 'completed' });
		expect(h.runtime.activeRunId).toBe('successor');
		expect(h.storage.database.prepare("SELECT payload_json FROM events WHERE type = 'tick_completed'").get()).toMatchObject({ payload_json: expect.stringContaining('provider_usage_export') });
		h.storage.database.close();
	});
	it('releases the active slot and bounds a stalled follower acknowledgement', async () => {
		vi.useFakeTimers();
		const h = await harness();
		h.storage.sql.exec("INSERT INTO runtime_state (key,value_json) VALUES ('follower_activity_receipts_v1',?)",
			JSON.stringify([{kind:'follower_activity',version:1,followerBotId:'bot',followedBotId:'writer',fromSequence:0,throughSequence:7}]));
		const batch = vi.fn(() => new Promise(() => {})).mockRejectedValueOnce(new Error('Injected initial D1 failure'));
		h.runtime.env.BICKR_D1.batch = batch;
		const run = h.run();
		await vi.advanceTimersByTimeAsync(1);
		expect(h.runtime.activeRunId).toBeNull(); expect(batch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(cleanupTimeoutMs);
		expect(await run).toMatchObject({ status:'completed' });
		expect(h.storage.sql.exec("SELECT value_json FROM runtime_state WHERE key='follower_activity_receipts_v1'").toArray()).toHaveLength(1);
		h.storage.database.close();
	});

	it('persists terminal success while release hangs and retries without rewriting the outcome', async () => {
		vi.useFakeTimers();
		const h = await harness();
		h.release.mockImplementation(() => new Promise(() => {}));
		const run = h.run();
		await vi.advanceTimersByTimeAsync(1);
		expect(h.storage.database.prepare("SELECT count(*) AS n FROM events WHERE type = 'tick_completed'").get()).toMatchObject({ n: 1 });
		await vi.advanceTimersByTimeAsync(cleanupTimeoutMs);
		expect(await run).toMatchObject({ status: 'completed' });
		expect(h.runtime.liveness.read()?.kind).toBe('finalizing');
		h.release.mockResolvedValue({ success: true, meta: { changes: 1 } });
		await h.runtime.alarm();
		expect(h.runtime.liveness.read()).toBeNull();
		expect(h.storage.database.prepare("SELECT count(*) AS n FROM events WHERE type = 'tick_completed'").get()).toMatchObject({ n: 1 });
		h.storage.database.close();
	});
	it('journals failure before reset of a hung transition and does not unlock its successor', async () => {
		vi.useFakeTimers();
		const h = await harness();
		const successor = vi.fn(async () => {});
		h.runtime.setPendingTool(text, 'run', { id: 'pending', type: 'function', function: { name: 'read_note', arguments: '{}' } }, {}, { role: 'assistant' }, null, { id: 'request', eventSeq: 1 });
		void h.runtime.runtimeTransitionQueue().run(() => new Promise(() => {}));
		void h.runtime.runtimeTransitionQueue().run(successor);
		await vi.advanceTimersByTimeAsync(transitionTimeoutMs);
		expect(h.runtime.liveness.read()).toMatchObject({ kind: 'finalizing', terminalType: 'tick_failed' });
		expect(h.runtime.state.abort).toHaveBeenCalledTimes(1);
		expect(successor).not.toHaveBeenCalled();
		expect(h.storage.setAlarm).toHaveBeenCalled();
		expect(h.storage.sql.exec("SELECT seq FROM events WHERE type = 'tick_failed'").toArray()).toHaveLength(0);
		const current = { ...testResultContext, text: botText('fr') };
		h.runtime.resultRenderContextForRows = vi.fn(async () => current);
		await h.runtime.alarm();
		expect(h.runtime.resultRenderContextForRows).toHaveBeenCalledOnce();
		expect(h.storage.sql.exec("SELECT seq FROM events WHERE type = 'tick_failed'").toArray()).toHaveLength(1);
		expect(h.runtime.activeLoopMessagesForProvider(current).at(-1)?.content).toContain(botText('fr').format('recovery.notDispatched'));
		await h.runtime.alarm();
		expect(h.storage.sql.exec("SELECT seq FROM events WHERE type = 'tick_failed'").toArray()).toHaveLength(1);
		h.storage.database.close();
	});
});

it('classifies a timed-out website response as unknown, never a retryable refusal', async () => {
	vi.useFakeTimers();
	const fetch = vi.fn(() => new Promise<Response>(() => {}));
	const runtime = Object.assign(Object.create(BotRuntime.prototype), { env: { INTERNAL_SERVICE_SECRET: 'test', FORUM_COORDINATOR_SERVICE: { fetch } } });
	const result = runtime.forumService('/comments/cmt_target/replies', 'bot', {}, new AbortController().signal, () => {}).catch((error: unknown) => error);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(await result).toMatchObject({ kind: 'tool_outcome_unknown' });
	expect(fetch).toHaveBeenCalledTimes(1);
});

it('settles a cancelled run caller even when an external await never resolves', async () => {
	const h = await harness();
	h.runtime.renewProgressLease = () => new Promise(() => {});
	const run = h.run();
	await Promise.resolve();
	await h.runtime.stopTick('bot');
	expect(await run).toMatchObject({ status: 'stopped' });
	expect(h.runtime.activeRunId).toBeNull();
	h.storage.database.close();
});


it.each([
	new SelfCorrectingToolCallError('That action is already satisfied.'),
	new RepositoryError('conflict', 'Forum is read-only.', 409, { forumWriteCause: 'forum_read_only' }),
])('retires a known self-correction before a later provider failure and Stop: %s', async (correction) => {
	const h = await harness();
	let responses = 0;
	Object.assign(h.runtime, {
		providerLoopInitialSuccessfulToolCallCount: () => 0,
		successfulMutatingToolCallSinceLastLogOff: () => true,
		prematureLogOffCorrectedSinceLastLogOff: () => false,
		loopGeneratedTokenCountSinceLastLogOff: () => 0,
		appendProviderMessages: async () => {}, recordInferenceSubmission: () => {},
		ensureProviderPromptWithinBudget: async () => ({renderContext: testResultContext,  allowedPromptTokens: 13_500, providerTools: toolDefinitionsForProviderRound(text), promptTokens: 100, requestMessages: [] }),
		callProvider: async () => {
			if (responses++ > 0) throw new Error('later provider failure');
			return { content: '', reasoning: '', reasoningDetails: [], toolCalls: [{ id: 'refused-call', type: 'function', function: { name: 'reply_to_comment', arguments: JSON.stringify({ commentId: 'cmt_parent', body: { lang: 'en', text: 'hello' } }) } }] };
		},
		executeTool: async () => { throw correction; },
	});
	await expect(h.runtime.runProviderLoop(bot, { baseUrl: 'https://provider.test', model: 'test-model', temperature: 0.2, toolCalls: 'at_will' }, 'run', [], { mode: 'normal', signal: h.runtime.activeAbortController.signal })).rejects.toThrow('later provider failure');
	expect(h.storage.database.prepare("SELECT value_json FROM runtime_state WHERE key = 'pending_tool_v1'").get()).toBeUndefined();
	await h.runtime.stopTick('bot');
	expect(h.storage.database.prepare("SELECT seq FROM loop_messages WHERE role = 'tool'").all()).toHaveLength(0);
	h.storage.database.close();
});

it.each(['stop', 'restart'] as const)('links the first recovered assistant to its exact request after %s', async (mode) => {
	const h = await harness();
	h.runtime.initializeRuntimeStorage();
	const logs = new AgentLogStore(h.storage);
	const event = h.runtime.appendEvent('run', 'provider_request', {});
	const id = logs.begin({ runId: 'run', eventSeq: event.seq, purpose: 'loop' });
	logs.settle(logs.startAttempt(id, '{"attempt":1}'), { kind: 'timeout' });
	const body = '{"messages":[{"role":"user","content":"Exact request"}]}';
	logs.settle(logs.startAttempt(id, body), { kind: 'success', response: 'Original response' });
	logs.finish(id, 'succeeded');
	const call = { id: 'pending', type: 'function', function: { name: 'view_profiles', arguments: '{}' } };
	h.runtime.setPendingTool(text, 'run', call, {}, { role: 'assistant', content: 'I will read.', tool_calls: [call] }, null, { id, eventSeq: event.seq });
	h.runtime.markPendingToolReading('run', 'pending');
	let runtime = h.runtime;
	if (mode === 'restart') {
		h.runtime.setStopRequest('run');
		runtime = Object.assign(Object.create(BotRuntime.prototype), { ...h.runtime, liveness: new RunLiveness(h.storage), activeRunId: null, activeAbortController: null, agentLogs: undefined });
		await runtime.reconcileRunJournal();
	} else await runtime.stopTick('bot');
	const page: BotLoopMessagesResponse = runtime.loopMessagesPage(testResultContext, { page: 1 });
	const entry = page.entries.find(entry => entry.kind === 'message' && entry.message.role === 'assistant');
	expect(entry).toMatchObject({ kind: 'message', requestId: id, attempts: { count: 2, failures: [{ outcome: { kind: 'timeout' } }] } });
	if (entry?.kind !== 'message') throw new Error('The recovered response is missing.');
	expect(entry.message.streamSeq).toBe(event.seq);
	expect(runtime.loopMessageLogsForSeq(testResultContext, entry.message.seq).request).toMatchObject({ id, messageSeq: entry.message.seq, attempts: [{ body: '{"attempt":1}' }, { body }] });
	expect(h.storage.sql.exec("SELECT key FROM runtime_state WHERE key = 'pending_tool_v3'").toArray()).toEqual([]);
	h.storage.database.close();
});

it('keeps a completed response visible while its first tool waits', async () => {
	const h = await harness();
	h.runtime.initializeRuntimeStorage();
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let id = '';
	let calls = 0;
	const logs = new AgentLogStore(h.storage);
	Object.assign(h.runtime, {
		providerLoopInitialSuccessfulToolCallCount: () => 0,
		successfulMutatingToolCallSinceLastLogOff: () => true,
		prematureLogOffCorrectedSinceLastLogOff: () => false,
		loopGeneratedTokenCountSinceLastLogOff: () => 0,
		appendProviderMessages: async () => {}, finishToolBookkeeping: async () => {},
		ensureProviderPromptWithinBudget: async () => ({ renderContext: testResultContext, allowedPromptTokens: 13_500, providerTools: toolDefinitionsForProviderRound(text), promptTokens: 100, requestMessages: [] }),
		callProvider: async (_settings: unknown, _messages: unknown, _tools: unknown, runId: string, requestSeq: number) => {
			if (calls++) throw new Error('The test visit ended.');
			id = logs.byEvent(runId, requestSeq)!.id;
			logs.startAttempt(id, '{"exact":"body"}');
			return { content: 'I will read the profile.', reasoning: '', reasoningDetails: [], toolCalls: [{ id: 'delayed', type: 'function', function: { name: 'view_profiles', arguments: '{}' } }] };
		},
		executeTool: vi.fn(async (_bot, _runId, _name, _args, _context, publish) => {
			await gate;
			const result = { name: 'view_profiles', result: '{}', providerResult: '{}' };
			publish(result);
			return result;
		}),
	});
	const pending = h.runtime.runProviderLoop(bot, { baseUrl: 'https://provider.test', model: 'test', temperature: 0.2, toolCalls: 'at_will' }, 'run', [], { mode: 'normal', signal: h.runtime.activeAbortController.signal }).catch((error: unknown) => error);
	await vi.waitFor(() => expect(h.runtime.executeTool).toHaveBeenCalledOnce());
	const waiting = h.runtime.loopMessagesPage(testResultContext, { page: 1 });
	expect(waiting.messages).toEqual([]);
	expect(waiting.entries).toMatchObject([{ kind: 'live', requestId: id, attempts: { count: 1 }, response: expect.stringContaining('I will read the profile.') }]);
	expect(logs.request(id)).toMatchObject({ state: 'succeeded', attempts: [{ body: '{"exact":"body"}' }] });
	release();
	expect(await pending).toMatchObject({ message: 'The test visit ended.' });
	const settled: AgentLogEntry[] = h.runtime.loopMessagesPage(testResultContext, { page: 1 }).entries;
	expect(settled.some(entry => entry.kind === 'live' && entry.requestId === id)).toBe(false);
	expect(settled).toContainEqual(expect.objectContaining({ kind: 'message', requestId: id }));
	h.storage.database.close();
});

it('removes an empty completed response from live entries when its run ends', async () => {
	const h = await harness();
	h.runtime.initializeRuntimeStorage();
	const logs = new AgentLogStore(h.storage);
	const id = logs.begin({ runId: 'run', eventSeq: 1, purpose: 'loop' });
	logs.settle(logs.startAttempt(id, '{}'), { kind: 'success', response: '{"message":{"role":"assistant","content":null}}' });
	logs.finish(id, 'succeeded');
	expect(h.runtime.loopMessagesPage(testResultContext, { page: 1 }).entries).toMatchObject([{ kind: 'live', requestId: id }]);
	await h.runtime.stopTick('bot');
	expect(h.runtime.loopMessagesPage(testResultContext, { page: 1 }).entries).toEqual([]);
	h.storage.database.close();
});

it.each(['lease', 'usage', 'events'] as const)('retains a completed response when Stop arrives during the %s wait', async (window) => {
	await completedResponseWait(window, false);
});

it.each(['lease', 'usage', 'events'] as const)('recovers a completed response after restart during the %s wait', async (window) => {
	await completedResponseWait(window, true);
});

it.each(['usage', 'events'] as const)('retains a text response when Stop arrives during the %s wait', async window => {
	await completedResponseWait(window, false, false);
});

it.each(['usage', 'events'] as const)('recovers a text response after restart during the %s wait', async window => {
	await completedResponseWait(window, true, false);
});

async function completedResponseWait(window: 'lease' | 'usage' | 'events', restart: boolean, withTools = true): Promise<void> {
	const h = await harness();
	h.runtime.initializeRuntimeStorage();
	const logs = new AgentLogStore(h.storage);
	let reached = false;
	let resume!: () => void;
	const gate = new Promise<void>(resolve => { resume = resolve; });
	const wait = async () => { reached = true; await gate; };
	const calls = (withTools ? ['first', 'second'] : []).map(id => ({ id, type: 'function', function: { name: 'view_profiles', arguments: '{}' } }));
	let requestId = '';
	Object.assign(h.runtime, {
		providerLoopInitialSuccessfulToolCallCount: () => 0,
		successfulMutatingToolCallSinceLastLogOff: () => true,
		prematureLogOffCorrectedSinceLastLogOff: () => false,
		loopGeneratedTokenCountSinceLastLogOff: () => 0,
		ensureProviderPromptWithinBudget: async () => ({ renderContext: testResultContext, allowedPromptTokens: 13_500, providerTools: toolDefinitionsForProviderRound(text), promptTokens: 100, requestMessages: [] }),
		callProvider: async (_settings: unknown, _messages: unknown, _tools: unknown, runId: string, eventSeq: number) => {
			requestId = logs.byEvent(runId, eventSeq)!.id;
			const inferenceAttemptId = logs.startAttempt(requestId, '{"exact":"completed request"}');
			return { inferenceAttemptId, content: 'The completed response before either tool.', reasoning: 'Retained reasoning.', reasoningDetails: [], toolCalls: calls, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 1, reasoningTokens: 0, cost: null, raw: {} } };
		},
		providerUsageProviderName: window === 'usage' ? async () => { await wait(); return 'Provider'; } : async () => null,
		appendProviderMessages: window === 'events' ? wait : async () => {},
		renewProgressLease: async () => { if (window === 'lease' && logs.responsePublication('run')) await wait(); },
		executeTool: vi.fn(),
	});
	const pending = h.runtime.withRunExecution('run', () => h.runtime.runProviderLoop(bot, { baseUrl: 'https://openrouter.ai/api/v1', model: 'test', temperature: 0.2, toolCalls: 'at_will' }, 'run', [], { mode: 'normal', signal: h.runtime.activeAbortController.signal })).catch((error: unknown) => error);
	await vi.waitFor(() => expect(reached).toBe(true));
	const completed = logs.request(requestId);
	expect(completed).toMatchObject({ state: 'succeeded', messageSeq: null, attempts: [{ usage: { promptTokens: 1, cachedInputTokens: 1, totalTokens: 2 } }] });
	expect(h.storage.sql.exec("SELECT key FROM runtime_state WHERE key = 'pending_tool_v3'").toArray()).toEqual([]);
	let recovery = h.runtime;
	if (restart) {
		recovery = Object.assign(Object.create(BotRuntime.prototype), { ...h.runtime, liveness: new RunLiveness(h.storage), agentLogs: undefined, activeRunId: null, activeAbortController: null });
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000);
		await recovery.reconcileRunJournal();
		vi.mocked(Date.now).mockRestore();
	} else await recovery.stopTick('bot');
	const page: BotLoopMessagesResponse = recovery.loopMessagesPage(testResultContext, { page: 1 });
	expect(page.messages.slice(0, withTools ? 3 : 1).map(row => row.role)).toEqual(withTools ? ['assistant', 'tool', 'tool'] : ['assistant']);
	expect(page.messages[0]).toMatchObject({ status: 'interrupted', message: { content: 'The completed response before either tool.', reasoning: 'Retained reasoning.', ...(withTools ? { tool_calls: [{ id: 'first' }, { id: 'second' }] } : {}) } });
	expect(page.entries[0]).toMatchObject({ kind: 'message', requestId, attempts: { count: 1 } });
	for (const row of page.messages.slice(1, withTools ? 3 : 1)) expect(row.message.content).toBe(text.format('recovery.notDispatched'));
	expect(recovery.loopMessageLogsForSeq(testResultContext, page.messages[0]!.seq).request).toMatchObject({ id: requestId, attempts: [{ body: '{"exact":"completed request"}' }] });
	expect(logs.responsePublication('run')).toBeNull();
	expect(h.runtime.executeTool).not.toHaveBeenCalled();
	resume();
	expect(await pending).toMatchObject({ name: 'TickStoppedError' });
	expect(logs.request(requestId).attempts[0]?.usage).toEqual(completed.attempts[0]?.usage);
	expect(recovery.loopMessagesPage(testResultContext, { page: 1 }).messages).toHaveLength((withTools ? 3 : 1) + (restart ? 1 : 0));
	h.storage.database.close();
}

it('rolls back the response, request link, and journal together if recovery fails', async () => {
	const h = await harness();
	h.runtime.initializeRuntimeStorage();
	const logs = new AgentLogStore(h.storage);
	const id = logs.begin({ runId: 'run', eventSeq: 1, purpose: 'loop' });
	const attemptId = logs.startAttempt(id, '{}');
	const calls = ['first', 'second'].map(id => ({ id, type: 'function', function: { name: 'view_profiles', arguments: '{}' } }));
	logs.settle(attemptId, { kind: 'success', response: JSON.stringify({ message: { role: 'assistant', content: 'Completed response', tool_calls: calls } }) });
	logs.stageResponsePublication({ kind: 'provider_response', runId: 'run', requestId: id, eventSeq: 1, attemptId, assistantSeq: null, pendingCallIds: calls.map(call => call.id) });
	logs.finish(id, 'succeeded');
	h.storage.database.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON loop_messages WHEN NEW.role = 'tool' AND json_extract(NEW.message_json, '$.tool_call_id') = 'second' BEGIN SELECT RAISE(ABORT, 'recovery failed'); END");
	expect(() => h.runtime.settlePendingTool(testResultContext, 'run')).toThrow('recovery failed');
	expect(h.runtime.loopMessagesPage(testResultContext, { page: 1 }).messages).toEqual([]);
	expect(logs.request(id)).toMatchObject({ state: 'succeeded', messageSeq: null });
	expect(logs.responsePublication('run')).toMatchObject({ assistantSeq: null, pendingCallIds: ['first', 'second'] });
	h.storage.database.exec('DROP TRIGGER fail_recovery');
	h.runtime.settlePendingTool(testResultContext, 'run');
	const page = h.runtime.loopMessagesPage(testResultContext, { page: 1 });
	expect(page.messages).toHaveLength(3);
	expect(page.entries[0]).toMatchObject({ kind: 'message', requestId: id });
	expect(logs.responsePublication('run')).toBeNull();
	h.storage.database.close();
});

it('retains required pause before release through timeout and retires a superseded retry', async () => {
 vi.useFakeTimers();
 const h = await harness();
 const requests: Request[] = [];
 let complete!: (response: Response) => void;
 h.runtime.env.USER_BOTS = { idFromName: () => 'owner', get: () => ({ fetch: (request: Request) => {
  requests.push(request);
  return requests.length === 1 ? new Promise<Response>((resolve) => { complete = resolve; }) : Promise.resolve(new Response(null, { status: 412 }));
 } }) };
	const finalizing = h.runtime.finalizeRun(testResultContext, 'run', 'tick_failed', { message: 'Compaction failed', pauseRequested: true }, undefined, [], { ownerUserId: 'owner', revision: 1 });
 await vi.advanceTimersByTimeAsync(1);
 expect(h.release).not.toHaveBeenCalled();
 expect(h.runtime.liveness.read()).toMatchObject({ kind: 'finalizing', pause: { revision: 1 } });
 await vi.advanceTimersByTimeAsync(cleanupTimeoutMs);
 expect(await finalizing).toBe(true);
 expect(h.runtime.liveness.read()?.kind).toBe('finalizing');
 expect(h.release).not.toHaveBeenCalled();
 // Retry is settled only by the serialized coordinator: the changed revision
 // proves either a prior applied pause or a newer owner edit superseded it.
 await h.runtime.alarm();
 expect(h.runtime.liveness.read()).toBeNull();
 expect(requests.map((request) => request.headers.get('idempotency-key'))).toEqual(['runtime-pause:bot:run', 'runtime-pause:bot:run']);
 expect(requests[0].headers.get('if-match')).toBe('1');
 h.runtime.activeRunId = 'successor';
 complete(new Response(null, { status: 200 }));
 await Promise.resolve();
 expect(h.runtime.activeRunId).toBe('successor');
 h.storage.database.close();
});

it('does not recreate erased history when a detached execution resumes after Stop', async () => {
	const h = await harness();
	h.runtime.initializeRuntimeStorage();
	h.runtime.reapStaleRun = async () => false;
	h.runtime.readStatus = async () => ({ status: 'idle' });
	let resume!: () => void;
	let finished!: () => void;
	const lateFinished = new Promise<void>((resolve) => { finished = resolve; });
	let lateError: unknown;
	h.runtime.renewProgressLease = async () => {
		await new Promise<void>((resolve) => { resume = resolve; });
		try {
			h.runtime.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'stale' }, 'provider_response');
			h.runtime.appendEvent('run', 'assistant_message', { content: 'stale' });
		} catch (error) {
			lateError = error;
			throw error;
		} finally { finished(); }
	};
	const run = h.run();
	await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
	await h.runtime.stopTick('bot');
	expect(await run).toMatchObject({ status: 'stopped' });
	await h.runtime.clearHistory('bot');
	resume();
	await lateFinished;
	expect(lateError).toMatchObject({ name: 'TickStoppedError' });
	for (const table of ['events', 'loop_messages', 'loop_message_logs', 'runtime_state']) {
		expect(h.storage.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toMatchObject({ n: 0 });
	}
	h.storage.database.close();
});

it('constructs a dormant runtime and migrates tool pairs belonging to terminal history', async () => {
	const h = await harness();
	h.runtime.liveness.clear('run');
	h.runtime.appendEvent('historical', 'tick_completed', {});
	const calls = ['first', 'second'].map((id) => ({ id, type: 'function', function: { name: 'read_feed', arguments: '{}' } }));
	h.runtime.appendLoopMessage(testResultContext, 'historical', { role: 'assistant', tool_calls: calls }, 'provider_response');
	for (const call of calls) h.runtime.appendLoopMessage(testResultContext, 'historical', { role: 'tool', tool_call_id: call.id, content: '{}' }, 'tool_result');
	let initialized!: Promise<void>;
	h.runtime.state.blockConcurrencyWhile = (initialize: () => Promise<void>) => { initialized = initialize(); return initialized; };
	new BotRuntime(h.runtime.state, h.runtime.env);
	await initialized;
	const rows = h.storage.database.prepare("SELECT message_json FROM loop_messages WHERE deleted_at IS NULL ORDER BY position").all();
	expect(rows).toHaveLength(3);
	expect(h.storage.database.prepare("SELECT count(*) AS n FROM events WHERE type = 'tick_completed'").get()).toMatchObject({ n: 1 });
	h.storage.database.close();
});

it('refuses duplicate admission locally without touching a suspended status service', async () => {
	const h = await harness();
	const readStatus = vi.fn(() => new Promise(() => {}));
	h.runtime.readStatus = readStatus;
	expect(await h.runtime.admitTick('bot', 'manual', {})).toMatchObject({ admitted: false, result: { status: 'already_running', runId: 'run' } });
	expect(readStatus).not.toHaveBeenCalled();
	expect(h.runtime.liveness.read()).toMatchObject({ kind: 'active', runId: 'run' });
	h.storage.database.close();
});
