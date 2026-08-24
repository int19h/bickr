import { describe, expect, it, vi } from 'vitest';
import type { BotRuntimeStopResult } from '@bickr/shared/model';
import { BotRuntime } from './bot-runtime';

type StopRuntime = { stopTick(botId: string): Promise<BotRuntimeStopResult> };
type MarkRuntime = { markRunStopped(bot: object, runId: string, trigger: 'cron'): Promise<{ released: boolean; confirmed: boolean }> };
type StatusRuntime = { readStatus(botId: string): Promise<Record<string, unknown>> };

function stopMethod(runtime: object): StopRuntime {
	return {
		stopTick: (BotRuntime.prototype as unknown as StopRuntime).stopTick.bind(runtime),
	};
}

describe('runtime stop transitions', () => {
	it('makes concurrent double Stop run-scoped and emits one request event', async () => {
		const controller = new AbortController();
		let requested = false;
		const appendEvent = vi.fn();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeRunId: 'run-current',
			activeAbortController: controller,
			runtimeTransitionQueue: () => ({ run: <T,>(closure: () => Promise<T>) => closure() }),
			runtimeStatusIndexRow: async () => ({ status: 'running', activeRunId: 'run-current', activeRunTrigger: 'manual' }),
			setStopRequest: () => {
				if (requested) return false;
				requested = true;
				return true;
			},
			appendEvent,
		});
		const stop = stopMethod(runtime);

		await expect(stop.stopTick('bot-stop')).resolves.toEqual({
			kind: 'stop_requested', stopped: false, runId: 'run-current', status: 'running',
		});
		await expect(stop.stopTick('bot-stop')).resolves.toEqual({
			kind: 'stop_requested', stopped: false, runId: 'run-current', status: 'running',
		});
		expect(controller.signal.aborted).toBe(true);
		expect(appendEvent).toHaveBeenCalledTimes(1);
		expect(appendEvent).toHaveBeenCalledWith('run-current', 'tick_stop_requested', expect.anything());
	});

	it('does not publish stop events when the ownership release CAS loses', async () => {
		const appendEvent = vi.fn();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			setRuntimeIndex: async () => ({ released: false, nextDueAt: null }),
			hasTerminalEvent: () => false,
			appendEvent,
			markPendingCompactionEventsFailed: vi.fn(),
			setStopRequest: vi.fn(),
			clearStopRequest: vi.fn(),
		});
		const mark = (BotRuntime.prototype as unknown as MarkRuntime).markRunStopped.bind(runtime);
		await expect(mark({}, 'run-old', 'cron')).resolves.toEqual({ released: false, confirmed: false });
		expect(appendEvent).not.toHaveBeenCalled();
		expect(runtime.setStopRequest).not.toHaveBeenCalled();
	});

	it('confirms an already-terminal same run without emitting a duplicate terminal event', async () => {
		const appendEvent = vi.fn();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			setRuntimeIndex: async () => ({ released: false, nextDueAt: null }),
			hasTerminalEvent: () => true,
			appendEvent,
			markPendingCompactionEventsFailed: vi.fn(),
			setStopRequest: vi.fn(),
			clearStopRequest: vi.fn(),
		});
		const mark = (BotRuntime.prototype as unknown as MarkRuntime).markRunStopped.bind(runtime);
		await expect(mark({}, 'run-old', 'cron')).resolves.toEqual({ released: false, confirmed: true });
		expect(appendEvent).not.toHaveBeenCalled();
	});

	it('surfaces an evicted run-scoped stop request as bounded recovery pending state', async () => {
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeRunId: null,
			runtimeStatusIndexRow: async () => ({
				enabled: 1,
				status: 'running',
				activeRunId: 'run-pending',
				nextDueAt: null,
				lastError: null,
			}),
			stopRequestState: () => ({ runId: 'run-pending', requestedAt: '2026-08-23T00:00:00.000Z' }),
		});
		const readStatus = (BotRuntime.prototype as unknown as StatusRuntime).readStatus.bind(runtime);

		await expect(readStatus('bot-stop')).resolves.toMatchObject({
			status: 'running',
			activeRunId: 'run-pending',
			pendingStopRunId: 'run-pending',
			stopState: 'recovery_pending',
		});
	});
});
