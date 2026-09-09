import { SelfCorrectingToolCallError } from '../errors';
import { RepositoryError } from '@bickr/shared/repository';
import { toolDefinitionsForProviderRound } from '../prompt-and-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotRuntime } from './bot-runtime';
import { createRuntimeTestStorage } from './sqlite-test-helper';
import { RunLiveness, cleanupTimeoutMs, transitionTimeoutMs } from './run-liveness';
import type { AdmittedTick, RuntimeBotDocument } from '../types';

afterEach(() => vi.useRealTimers());
const bot = { id: 'bot', type: 'bot', schemaVersion: 1, revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01', homeWorldId: 'world', homeWorldHandle: 'world', ownerUserId: 'owner', handle: 'participant', language: null, includeLanguageInSystemPrompt: false, displayName: { lang: null, text: 'Participant' }, shortBio: { lang: null, text: '' }, prompt: { lang: null, text: '' }, inferenceSettings: {}, toolSettings: {}, tickSettings: { enabled: true, intervalSeconds: 60, allowEarlyLogOff: true, compactionThreshold: 0.75 } } satisfies RuntimeBotDocument;

async function harness() {
	const storage = { ...createRuntimeTestStorage(), setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}) };
	const controller = new AbortController();
	const release = vi.fn(async () => ({ success: true, meta: { changes: 1 } }));
	const statement = { bind: () => statement, run: release };
	const runtime = Object.assign(Object.create(BotRuntime.prototype), {
		state: { storage, getWebSockets: () => [], abort: vi.fn() },
		env: { BICKR_D1: { prepare: () => statement } },
		liveness: new RunLiveness(storage), activeRunId: 'run', activeAbortController: controller,
		runtimeStorageClearedAt: null,
		consumeInjections: () => [], renewProgressLease: async () => {},
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
		void h.runtime.runtimeTransitionQueue().run(() => new Promise(() => {}));
		void h.runtime.runtimeTransitionQueue().run(successor);
		await vi.advanceTimersByTimeAsync(transitionTimeoutMs);
		expect(h.runtime.liveness.read()).toMatchObject({ kind: 'finalizing', terminalType: 'tick_failed' });
		expect(h.runtime.state.abort).toHaveBeenCalledTimes(1);
		expect(successor).not.toHaveBeenCalled();
		expect(h.storage.setAlarm).toHaveBeenCalled();
		h.storage.database.close();
	});
});

it('classifies a timed-out website response as unknown, never a retryable refusal', async () => {
	vi.useFakeTimers();
	const fetch = vi.fn(() => new Promise<Response>(() => {}));
	const runtime = Object.assign(Object.create(BotRuntime.prototype), { env: { INTERNAL_SERVICE_SECRET: 'test', FORUM_COORDINATOR_SERVICE: { fetch } } });
	const result = runtime.forumService('/comments/cmt_target/replies', 'bot', {}, new AbortController().signal).catch((error: unknown) => error);
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
		ensureProviderPromptWithinBudget: async () => ({ allowedPromptTokens: 13_500, providerTools: toolDefinitionsForProviderRound(), promptTokens: 100, requestMessages: [] }),
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

it('retains required pause before release through timeout and retires a superseded retry', async () => {
 vi.useFakeTimers();
 const h = await harness();
 const requests: Request[] = [];
 let complete!: (response: Response) => void;
 h.runtime.env.USER_BOTS = { idFromName: () => 'owner', get: () => ({ fetch: (request: Request) => {
  requests.push(request);
  return requests.length === 1 ? new Promise<Response>((resolve) => { complete = resolve; }) : Promise.resolve(new Response(null, { status: 412 }));
 } }) };
 const finalizing = h.runtime.finalizeRun('run', 'tick_failed', { message: 'Compaction failed', pauseRequested: true }, undefined, [], { ownerUserId: 'owner', revision: 1 });
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
			h.runtime.appendLoopMessage('run', { role: 'assistant', content: 'stale' }, 'provider_response');
			h.runtime.appendEvent('run', 'assistant_message', { content: 'stale' });
		} catch (error) {
			lateError = error;
			throw error;
		} finally { finished(); }
	};
	const run = h.run();
	await Promise.resolve();
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
	h.runtime.appendLoopMessage('historical', { role: 'assistant', tool_calls: calls }, 'provider_response');
	for (const call of calls) h.runtime.appendLoopMessage('historical', { role: 'tool', tool_call_id: call.id, content: '{}' }, 'tool_result');
	let initialized!: Promise<void>;
	h.runtime.state.blockConcurrencyWhile = (initialize: () => Promise<void>) => { initialized = initialize(); return initialized; };
	new BotRuntime(h.runtime.state, h.runtime.env);
	await initialized;
	const rows = h.storage.database.prepare("SELECT message_json FROM loop_messages WHERE deleted_at IS NULL ORDER BY position").all();
	expect(rows).toHaveLength(4);
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
