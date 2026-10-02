import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotRuntime } from './bot-runtime';
import { RuntimeInjectionStore } from './injections';
import { RuntimeMessageStore } from './message-store';
import { RuntimeInputHistory } from './input-history';
import { RunLiveness } from './run-liveness';
import { botById, userById } from '@bickr/shared/repository';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
import type { LoopMessageGroupEntry } from '../types';

vi.mock('@bickr/shared/repository', async (original) => ({
	...await original<typeof import('@bickr/shared/repository')>(),
	botById: vi.fn(), userById: vi.fn(),
}));

let storage: RuntimeTestStorage;
beforeEach(() => {
	storage = createRuntimeTestStorage();
	storage.sql.exec("INSERT INTO injections (id,text,created_at) VALUES ('thought','Remember this','2026-10-02')");
});
afterEach(() => storage.database.close());

function fixture() {
	const injections = new RuntimeInjectionStore(storage);
	const store = new RuntimeMessageStore(storage);
	const prepareContext = vi.fn(async (...args: unknown[]) => {
		const collect = args.at(-1) as (entries: LoopMessageGroupEntry[]) => void;
		collect([{ runId: 'run', origin: 'synthetic_context', message: { role: 'user', content: 'Prepared context' } }]);
		return [];
	});
	const runtime = Object.assign(Object.create(BotRuntime.prototype), {
		state: { storage }, runtimeMessageStore: () => store,
		previousTerminalTickEvent: () => null,
		profileUsernamesInActiveContext: () => new Set(), providerContentInActiveContext: () => ({}),
		appendNotificationSyntheticContext: prepareContext,
		activeLoopMessagesForProvider: () => store.activeLoopMessageRows(),
	});
	const build = () => {
		const pending = injections.pending();
		return runtime.buildMessages({ tickSettings: {}, inferenceSettings: { recurringPromptEnabled: false } }, { spotlightContexts: [], notifications: [], injections: pending.map(row => row.text) }, 'run', { seq: 1, createdAt: '2026-10-02' }, { pendingInjections: pending });
	};
	return { injections, store, prepareContext, build, runtime };
}

describe('durable thought delivery', () => {
	it.each(['preparation', 'history', 'marker'])('retries opening context after failed %s, then admits continuation only after commit', async (failure) => {
		const f = fixture();
		const bot = { id: 'bot', ownerUserId: 'owner', tickSettings: { intervalSeconds: 60 }, inferenceSettings: { recurringPromptEnabled: false } };
		vi.mocked(botById).mockResolvedValue(bot as Awaited<ReturnType<typeof botById>>);
		vi.mocked(userById).mockResolvedValue({ id: 'owner' } as Awaited<ReturnType<typeof userById>>);
		const statement = { bind: () => statement, run: async () => ({ success: true, meta: { changes: 1 } }) };
		const liveness = new RunLiveness({ ...storage, setAlarm: vi.fn(async () => {}) });
		Object.assign(f.runtime, {
			env: { BICKR_D1: { prepare: () => statement } }, liveness,
			reconcileRunJournal: async () => {}, reapStaleRun: async () => {},
			readStatus: async () => ({ status: 'idle', enabled: true }),
			botWithEffectivePostingSettings: async (value: unknown) => value,
			effectiveProviderSettings: async () => ({}), runtimeStatusIndexRow: async () => ({ admissionToken: null }),
			latestSuccessfulLogOffToolResultSeq: () => 0,
		});
		const admit = async () => {
			const admission = await f.runtime.admitTick('bot', 'scheduled', {});
			expect(admission.admitted).toBe(true);
			return admission.tick;
		};
		const finish = (runId: string) => {
			liveness.clear(runId);
			f.runtime.activeRunId = null;
			f.runtime.activeAbortController = null;
		};
		const build = async (tick: { runId: string; setupMode: string }) => {
			// runAdmittedTick writes the audit record before it prepares input.
			// Only the committed history group proves that preparation succeeded.
			const input = storage.sql.exec<{ seq: number }>("INSERT INTO events (run_id,type,payload_json,token_estimate,created_at) VALUES (?, 'input', '{}', 0, '2026-10-02') RETURNING seq", tick.runId).toArray()[0]!;
			const pending = f.injections.pending();
			return f.runtime.buildMessages(bot, { spotlightContexts: [], notifications: [], injections: pending.map(row => row.text) }, tick.runId, { seq: input.seq, createdAt: '2026-10-02' }, { setupMode: tick.setupMode, pendingInjections: pending });
		};
		const first = await admit();
		expect(first.setupMode).toBe('new_iteration');
		if (failure === 'preparation') f.prepareContext.mockRejectedValueOnce(new Error('injected failure'));
		else storage.database.exec(failure === 'history'
			? "CREATE TRIGGER fail_commit BEFORE INSERT ON loop_messages WHEN NEW.origin = 'injection' BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
			: "CREATE TRIGGER fail_commit BEFORE INSERT ON runtime_state WHEN NEW.key = 'last_committed_input_seq_v1' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
		await expect(build(first)).rejects.toThrow('injected failure');
		expect(f.store.activeLoopMessageRows()).toHaveLength(0);
		expect(f.injections.pending()).toHaveLength(1);
		expect(new RuntimeInputHistory(storage).startedAfter(0)).toBe(false);
		finish(first.runId);
		if (failure !== 'preparation') storage.database.exec('DROP TRIGGER fail_commit');
		const retry = await admit();
		expect(retry.setupMode).toBe('new_iteration');
		await build(retry);
		expect(f.prepareContext).toHaveBeenCalledTimes(2);
		expect(f.injections.pending()).toHaveLength(0);
		expect(new RuntimeInputHistory(storage).startedAfter(0)).toBe(true);
		finish(retry.runId);
		const continuation = await admit();
		expect(continuation.setupMode).toBe('continuation');
		await build(continuation);
		expect(f.prepareContext).toHaveBeenCalledTimes(2);
		expect(f.store.activeLoopMessageRows().filter(row => row.origin === 'injection')).toHaveLength(1);
		finish(continuation.runId);
	});
	it('keeps a thought pending if context preparation fails, then commits it once on retry', async () => {
		const f = fixture();
		f.prepareContext.mockRejectedValueOnce(new Error('Provider setup failed'));
		await expect(f.build()).rejects.toThrow('Provider setup failed');
		expect(f.injections.pending()).toHaveLength(1);
		expect(f.store.activeLoopMessageRows()).toHaveLength(0);
		await f.build();
		expect(f.injections.pending()).toHaveLength(0);
		await f.build();
		expect(f.store.activeLoopMessageRows().filter(row => row.origin === 'injection')).toHaveLength(1);
	});
	it('rolls back history and consumption if the history write fails after preparation', async () => {
		const f = fixture();
		storage.database.exec("CREATE TRIGGER fail_history BEFORE INSERT ON loop_messages WHEN NEW.origin = 'injection' BEGIN SELECT RAISE(ABORT, 'history write failed'); END");
		await expect(f.build()).rejects.toThrow('history write failed');
		expect(f.prepareContext).toHaveBeenCalledOnce();
		expect(f.store.activeLoopMessageRows()).toHaveLength(0);
		expect(f.injections.pending()).toHaveLength(1);
		storage.database.exec('DROP TRIGGER fail_history');
		await f.build();
		await f.build();
		expect(f.injections.pending()).toHaveLength(0);
		expect(f.store.activeLoopMessageRows().filter(row => row.origin === 'injection')).toHaveLength(1);
	});
	it('rolls back publication if the selected thought was consumed by a competing commit', async () => {
		const f = fixture();
		const selected = f.injections.pending();
		f.injections.acknowledge(selected);
		expect(() => f.store.appendLoopMessageGroup([{ runId: 'run', origin: 'injection', message: { role: 'assistant', content: 'Remember this' } }], () => f.injections.acknowledge(selected))).toThrow('Pending input changed');
		expect(f.store.activeLoopMessageRows()).toHaveLength(0);
	});
});
