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
