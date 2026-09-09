import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeTestStorage } from './sqlite-test-helper';
import { RunLiveness, boundedCleanup, cleanupTimeoutMs, isRunProgressEvent, runInactivityMs } from './run-liveness';
import { RuntimeOperationTimeoutError } from '../errors';

afterEach(() => vi.useRealTimers());

describe('durable run journal and cleanup bounds', () => {
	it('persists progress and terminal intent across instances and retires only its own row', async () => {
		const storage = { ...createRuntimeTestStorage(), setAlarm: vi.fn(async () => {}) };
		const first = new RunLiveness(storage);
		await first.begin({ botId: 'bot', runId: 'old', trigger: 'spotlight', intervalMs: 10, claimToken: null }, 100);
		expect(storage.setAlarm).toHaveBeenCalledWith(100 + runInactivityMs);
		first.progress('injection', 1000);
		expect(first.read()).toMatchObject({ lastProgressAt: 100 });
		first.progress('old', 200);
		const rebuilt = new RunLiveness(storage);
		expect(rebuilt.read()).toMatchObject({ lastProgressAt: 200 });
		expect(rebuilt.finish('old', 'failed', 'failure', 'tick_failed', 300)).toMatchObject({ kind: 'finalizing', message: 'failure', nextDueAt: null });
		first.progress('old', 400);
		expect(rebuilt.read()).toMatchObject({ kind: 'finalizing' });
		await rebuilt.begin({ botId: 'bot', runId: 'new', trigger: 'cron', intervalMs: 10, claimToken: null }, 500);
		first.clear('old');
		expect(rebuilt.read()).toMatchObject({ runId: 'new' });
		storage.database.close();
	});
	it('bounds a hung cleanup independently of an aborted run and ignores late completion', async () => {
		vi.useFakeTimers();
		let finish!: () => void;
		const cleanup = boundedCleanup('export', () => new Promise<void>((resolve) => { finish = resolve; }));
		const observed = cleanup.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(cleanupTimeoutMs);
		expect(await observed).toBeInstanceOf(RuntimeOperationTimeoutError);
		finish();
		await Promise.resolve();
		expect(await observed).toMatchObject({ kind: 'runtime_operation_timeout', operation: 'export' });
	});
	it('uses an explicit progress allowlist', () => {
		for (const type of ['tool_result', 'tool_call', 'provider_request', 'compaction'] as const) expect(isRunProgressEvent(type)).toBe(true);
		for (const type of ['thought_injected', 'provider_retry', 'provider_token_estimate', 'provider_history_repaired', 'tick_stop_requested'] as const) expect(isRunProgressEvent(type)).toBe(false);
	});
});
