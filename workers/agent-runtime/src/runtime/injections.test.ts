import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotRuntime } from './bot-runtime';
import { RuntimeInjectionStore } from './injections';
import { RuntimeMessageStore } from './message-store';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
import type { LoopMessageGroupEntry } from '../types';

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
		return runtime.buildMessages({ tickSettings: {}, inferenceSettings: { recurringPromptEnabled: false } }, { spotlightContexts: [], notifications: [], injections: pending.map(row => row.text) }, 'run', '2026-10-02', { pendingInjections: pending });
	};
	return { injections, store, prepareContext, build };
}

describe('durable thought delivery', () => {
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
