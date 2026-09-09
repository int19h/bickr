import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { RunLiveness, runInactivityMs } from '../workers/agent-runtime/src/runtime/run-liveness';
import type { BotRuntimeEvent, BotRuntimeEventType } from '@bickr/shared/model';
import { authCookie, createBotForTest, seedWorld, testEnv } from './helpers/index-harness';

const namespace = (env as unknown as { BOT_RUNTIME: DurableObjectNamespace }).BOT_RUNTIME;
type InspectRuntime = {
	withRunExecution<T>(runId: string, operation: () => T): T;
	env: { BICKR_D1: D1Database };
	admitTick(botId: string, trigger: 'manual', options: object): Promise<{ admitted: boolean; result?: { status: string } }>;
	effectiveProviderSettings: () => Promise<object>;
	activeRunId: string | null;
	activeAbortController: AbortController | null;
	appendEvent(runId: string, type: BotRuntimeEventType, payload: unknown): BotRuntimeEvent;
	broadcastProviderDelta(runId: string, seq: number, payload: object): void;
	finalizeRun(runId: string, type: 'tick_failed', payload: object): Promise<boolean>;
	stopTick(botId: string): Promise<{ kind: string }>;
	setPendingTool(runId: string, call: { id: string; type: 'function'; function: { name: string; arguments: string } }): void;
};

async function running(handle: string) {
	const cookie = await authCookie();
	await seedWorld(cookie);
	const bot = await createBotForTest(cookie, handle, { enabled: true });
	const runId = crypto.randomUUID();
	await testEnv.BICKR_D1.prepare(`UPDATE bot_runtime_index SET status = 'running', active_run_id = ?, active_run_trigger = 'spotlight', lease_expires_at = ? WHERE bot_id = ?`)
		.bind(runId, new Date(Date.now() + runInactivityMs).toISOString(), bot.id).run();
	const stub = namespace.get(namespace.idFromName(bot.id));
	await runInDurableObject(stub, async (instance, state) => {
		await new RunLiveness(state.storage).begin({ botId: bot.id, runId, trigger: 'spotlight', intervalMs: 60_000, claimToken: null });
		const runtime = instance as unknown as InspectRuntime;
		runtime.activeRunId = runId;
		runtime.activeAbortController = new AbortController();
	});
	return { bot, runId, stub };
}

describe('runtime liveness in a real SQLite Durable Object', () => {
	it('uses active-run events and meaningful streaming, excluding injections and retries', async () => {
		const { stub, runId } = await running('liveness-progress');
		await runInDurableObject(stub, (instance, state) => {
			const journal = new RunLiveness(state.storage);
			const current = journal.read()!;
			if (current.kind !== 'active') throw new Error('Expected active run');
			journal.write({ ...current, lastProgressAt: 1000 });
			const runtime = instance as unknown as InspectRuntime;
			runtime.appendEvent('injection', 'thought_injected', { text: 'another spotlight' });
			runtime.appendEvent(runId, 'provider_retry', {});
			expect(journal.read()).toMatchObject({ lastProgressAt: 1000 });
			runtime.appendEvent(runId, 'tool_result', { result: { ok: true } });
			expect(journal.read()).toMatchObject({ lastProgressAt: expect.any(Number) });
			const time = journal.read();
			if (time?.kind !== 'active') throw new Error('Expected active');
			expect(time.lastProgressAt).toBeGreaterThan(1000);
			journal.write({ ...current, lastProgressAt: 1000 });
			runtime.broadcastProviderDelta(runId, 1, { kind: 'content', text: 'thinking' });
			expect(journal.read()).not.toMatchObject({ lastProgressAt: 1000 });
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, (_, state) => {
			expect(new RunLiveness(state.storage).read()?.kind).toBe('active');
		});
	});

	it('settles at its deadline, fences late publication, and does not release a successor', async () => {
		const { stub, bot, runId } = await running('liveness-deadline');
		await runInDurableObject(stub, (_, state) => {
			const journal = new RunLiveness(state.storage);
			const current = journal.read()!;
			if (current.kind !== 'active') throw new Error('Expected active');
			journal.write({ ...current, lastProgressAt: Date.now() - runInactivityMs - 1 });
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, (instance, state) => {
			const runtime = instance as unknown as InspectRuntime;
			expect(runtime.activeRunId).toBeNull();
			expect(() => runtime.withRunExecution(runId, () => runtime.appendEvent(runId, 'tool_result', {}))).toThrow();
			expect(new RunLiveness(state.storage).read()).toBeNull();
			expect(state.storage.sql.exec<{ type: string }>('SELECT type FROM events WHERE run_id = ? AND type = ?', runId, 'tick_failed').toArray()).toHaveLength(1);
		});
		const index = await testEnv.BICKR_D1.prepare('SELECT status FROM bot_runtime_index WHERE bot_id = ?').bind(bot.id).first<{status: string}>();
		expect(index?.status).toBe('failed');
		await testEnv.BICKR_D1.prepare("UPDATE bot_runtime_index SET status = 'running', active_run_id = 'successor' WHERE bot_id = ?").bind(bot.id).run();
		await runDurableObjectAlarm(stub);
		expect(await testEnv.BICKR_D1.prepare('SELECT active_run_id FROM bot_runtime_index WHERE bot_id = ?').bind(bot.id).first()).toMatchObject({ active_run_id: 'successor' });
	});

	it('keeps terminal failure durable when release rejects, then alarm retries its CAS', async () => {
		const { stub, runId } = await running('liveness-release');
		await runInDurableObject(stub, async (instance, state) => {
			const runtime = instance as unknown as InspectRuntime;
			const original = runtime.env;
			runtime.env = { ...original, BICKR_D1: { prepare: () => { throw new Error('injected D1 outage'); } } as unknown as D1Database };
			try {
				expect(await runtime.finalizeRun(runId, 'tick_failed', { message: 'original run failure' })).toBe(true);
				expect(new RunLiveness(state.storage).read()?.kind).toBe('finalizing');
				expect(state.storage.sql.exec<{payload_json: string}>('SELECT payload_json FROM events WHERE type = ?', 'tick_failed').one().payload_json).toContain('runtime_release');
			} finally { runtime.env = original; }
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, (_, state) => expect(new RunLiveness(state.storage).read()).toBeNull());
	});

	it('stops independently of the transition queue and preserves a single terminal outcome', async () => {
		const { stub, bot, runId } = await running('liveness-stop');
		await runInDurableObject(stub, async (instance, state) => {
			const runtime = instance as unknown as InspectRuntime;
			runtime.setPendingTool(runId, { id: 'call-pending', type: 'function', function: { name: 'reply_to_comment', arguments: '{}' } });
			expect(await runtime.stopTick(bot.id)).toMatchObject({ kind: 'stopped' });
			const messages = state.storage.sql.exec<{ role: string; message_json: string }>('SELECT role, message_json FROM loop_messages ORDER BY seq').toArray();
			expect(messages.map((message) => message.role)).toEqual(['assistant', 'tool']);
			expect(messages[1]?.message_json).toContain('outcome_unknown');
			expect(runtime.activeRunId).toBeNull();
			expect(() => runtime.withRunExecution(runId, () => runtime.appendEvent(runId, 'assistant_message', {}))).toThrow();
			expect(state.storage.sql.exec('SELECT seq FROM events WHERE type = ?', 'tick_stopped').toArray()).toHaveLength(1);
		});
	});
});

describe('admission cancellation fence in real D1', () => {
	it('permanently refuses a delayed claim after Stop, even after a successor releases', async () => {
		const { bot, runId, stub } = await running('claim-fence');
		// The local journal exists, but the pending claim has not reached D1.
		await testEnv.BICKR_D1.prepare("UPDATE bot_runtime_index SET status = 'idle', active_run_id = NULL, admission_token = NULL WHERE bot_id = ?").bind(bot.id).run();
		await runInDurableObject(stub, async (instance) => {
			expect(await (instance as unknown as InspectRuntime).stopTick(bot.id)).toMatchObject({ kind: 'stopped' });
		});
		const { claimRuntimeRun, releaseRuntimeRun } = await import('../workers/agent-runtime/src/runtime/bot-runtime');
		const now = new Date().toISOString();
		const lease = new Date(Date.now() + runInactivityMs).toISOString();
		expect(await claimRuntimeRun(testEnv.BICKR_D1, bot.id, runId, lease, now, 'spotlight', null)).toBe(false);
		expect(await claimRuntimeRun(testEnv.BICKR_D1, bot.id, 'successor-fence', lease, now, 'spotlight', runId)).toBe(true);
		expect(await releaseRuntimeRun(testEnv.BICKR_D1, { botId: bot.id, runId: 'successor-fence', status: 'idle', nextDueAt: null, lastError: null, now })).toBe(true);
		expect(await claimRuntimeRun(testEnv.BICKR_D1, bot.id, runId, lease, now, 'spotlight', null)).toBe(false);
	});
});


it('finalizes a rejected admission claim immediately with the original cause', async () => {
	const { stub, bot } = await running('claim-rejection');
	await runInDurableObject(stub, async (instance, state) => {
		const runtime = instance as unknown as InspectRuntime;
		await runtime.stopTick(bot.id);
		const original = runtime.env;
		const settings = runtime.effectiveProviderSettings;
		runtime.effectiveProviderSettings = async () => ({});
		runtime.env = { ...original, BICKR_D1: new Proxy(original.BICKR_D1, {
			get(target, property) {
				if (property === 'prepare') return (sql: string) => {
					if (sql.includes("SET status = 'running'")) throw new Error('Injected admission failure');
					return target.prepare(sql);
				};
				return Reflect.get(target, property, target);
			},
		}) };
		try {
			expect(await runtime.admitTick(bot.id, 'manual', {})).toMatchObject({ admitted: false, result: { status: 'failed' } });
			expect(new RunLiveness(state.storage).read()).toBeNull();
			const event = state.storage.sql.exec<{ payload_json: string }>("SELECT payload_json FROM events WHERE type = 'tick_failed'").one();
			expect(event.payload_json).toContain('Injected admission failure');
			expect(event.payload_json).toContain('admission_failure');
		} finally {
			runtime.env = original;
			runtime.effectiveProviderSettings = settings;
		}
	});
});
