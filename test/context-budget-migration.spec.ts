import { authCookie, createBotForTest, describe, expect, it, kvKeys, seedWorld, testEnv, testCoordinatorEnv } from './helpers/index-harness';
import { contextWindowTokensMin, type BotDocument } from '@bickr/shared/model';
import { defaultTickSettings } from '@bickr/shared/repository';
import { handleAgentRuntimeRequest, handleAgentRuntimeWorkerRequest } from '../workers/agent-runtime/src/routes';
import { ExclusiveOperationQueue } from '@bickr/shared/exclusive-operation-queue';
import { contextBudgetMigrationBatchSize, type migrateContextBudgetPage } from '../workers/agent-runtime/src/context-budget-migration';
import { internalServiceTestHeaders } from './helpers/internal-service-auth';

function sweep(cursor = '', headers: Record<string, string> = internalServiceTestHeaders) {
	return handleAgentRuntimeWorkerRequest(new Request('https://internal.bickr/maintenance/context-budget', {
		method: 'POST', headers: { ...headers, 'x-bickr-scheduler': '1', 'content-type': 'application/json' }, body: JSON.stringify({ cursor }),
	}), { ...testEnv, ...testCoordinatorEnv() });
}
async function stored(id: string) { return (await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(id), { type: 'json' }))!; }
async function migrationPage(response: Response): Promise<Awaited<ReturnType<typeof migrateContextBudgetPage>>> {
	const payload = await response.json() as { data: { page: Awaited<ReturnType<typeof migrateContextBudgetPage>> } };
	return payload.data.page;
}
async function contextIndex(id: string) {
	return testEnv.BICKR_D1.prepare('SELECT context_window_tokens AS budget, next_due_at AS dueAt, status, active_run_id AS runId FROM bot_runtime_index WHERE bot_id = ?').bind(id).first();
}
async function legacyBot() {
	const cookie = await authCookie();
	await seedWorld(cookie);
	const bot = await createBotForTest(cookie, 'legacy-budget', { enabled: false });
	const document = await stored(bot.id);
	await testEnv.BICKR_KV.put(kvKeys.bot(bot.id), JSON.stringify({ ...document, tickSettings: { ...document.tickSettings, contextWindowTokens: contextWindowTokensMin - 1 } }));
	await testEnv.BICKR_D1.prepare('UPDATE bot_runtime_index SET context_window_tokens = ? WHERE bot_id = ?').bind(contextWindowTokensMin - 1, bot.id).run();
	await testEnv.BICKR_D1.prepare("UPDATE maintenance_control SET enabled = 1, activated_at = '2026-10-24T00:00:00Z' WHERE id = 1").run();
	return { ...bot, ownerUserId: document.ownerUserId };
}
function ownerRequest(bot: { ownerUserId: string; id: string }) {
	return new Request(`https://internal.bickr/users/${bot.ownerUserId}/bots/${bot.id}/context-budget-migration`, {
		method: 'POST', headers: { ...internalServiceTestHeaders, 'x-bickr-scheduler': '1', 'x-bickr-user-id': bot.ownerUserId },
	});
}

describe('context-budget-minimum-v1 migration', () => {
	it('finishes a failed index write without changing the document twice', async () => {
		const bot = await legacyBot();
		const before = await stored(bot.id);
		let fail = true;
		const db = {
			prepare: (sql: string) => testEnv.BICKR_D1.prepare(sql),
			batch: (statements: D1PreparedStatement[]) => {
				if (fail) { fail = false; throw new Error('Test index failure'); }
				return testEnv.BICKR_D1.batch(statements);
			},
		} as D1Database;
		const env = { ...testEnv, BICKR_D1: db };
		const coordinator = { ownerUserId: bot.ownerUserId, objectId: 'test', queue: new ExclusiveOperationQueue() };
		expect((await handleAgentRuntimeRequest(ownerRequest(bot), env, coordinator)).status).toBe(500);
		const changed = await stored(bot.id);
		expect(changed.revision).toBe(before.revision + 1);
		expect(changed.tickSettings.contextWindowTokens).toBe(contextWindowTokensMin);
		expect(await contextIndex(bot.id)).toMatchObject({ budget: contextWindowTokensMin - 1 });
		const retry = await handleAgentRuntimeRequest(ownerRequest(bot), env, coordinator);
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({ data: { migration: { kind: 'migrated', documentChanged: false, indexChanged: true } } });
		expect(await stored(bot.id)).toEqual(changed);
		expect(await contextIndex(bot.id)).toMatchObject({ budget: contextWindowTokensMin });
	});
	it('serializes migration writes with another request on the owner queue', async () => {
		const bot = await legacyBot();
		let release!: () => void;
		let started!: () => void;
		const waiting = new Promise<void>(resolve => { started = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const kv = {
			get: testEnv.BICKR_KV.get.bind(testEnv.BICKR_KV),
			put: async (key: string, value: string) => { started(); await gate; await testEnv.BICKR_KV.put(key, value); },
		} as KVNamespace;
		const env = { ...testEnv, BICKR_KV: kv };
		const coordinator = { ownerUserId: bot.ownerUserId, objectId: 'test', queue: new ExclusiveOperationQueue() };
		const first = handleAgentRuntimeRequest(ownerRequest(bot), env, coordinator);
		await waiting;
		const second = handleAgentRuntimeRequest(ownerRequest(bot), env, coordinator);
		release();
		expect((await first).status).toBe(200);
		const response = await second;
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ data: { migration: { kind: 'unchanged', documentChanged: false, indexChanged: false } } });
	});
	it('keeps the cursor before a missing document and resumes after the document returns', async () => {
		const bot = await legacyBot();
		const document = await stored(bot.id);
		await testEnv.BICKR_KV.delete(kvKeys.bot(bot.id));
		const response = await sweep();
		expect(response.status).toBe(200);
		const page = await migrationPage(response);
		expect(page.done).toBe(false);
		expect(page.nextCursor).not.toBeNull();
		expect(page.nextCursor! < bot.id).toBe(true);
		expect(page.results.at(-1)).toEqual({ botId: bot.id, result: { kind: 'missing' } });
		await testEnv.BICKR_KV.put(kvKeys.bot(bot.id), JSON.stringify(document));
		const resumed = await sweep(page.nextCursor!);
		expect(resumed.status).toBe(200);
		expect((await migrationPage(resumed)).results).toContainEqual({ botId: bot.id, result: { kind: 'migrated', documentChanged: true, indexChanged: true } });
	});
	it('requires internal authentication, scheduler authority, and maintenance mode', async () => {
		expect((await sweep('', {})).status).toBe(404);
		expect((await sweep()).status).toBe(409);
		const response = await handleAgentRuntimeWorkerRequest(new Request('https://internal.bickr/maintenance/context-budget', { method: 'POST', headers: internalServiceTestHeaders }), { ...testEnv, ...testCoordinatorEnv() });
		expect(response.status).toBe(401);
	});
	it('resumes bounded pages, raises only low overrides, restores NULL defaults, and is idempotent', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bots = [];
		for (let i = 0; i <= contextBudgetMigrationBatchSize; i++) bots.push(await createBotForTest(cookie, `budget-${i}`, { enabled: false }));
		const [below, at, above, inherited] = bots;
		for (const [bot, value] of [[below!, contextWindowTokensMin - 1], [at!, contextWindowTokensMin], [above!, contextWindowTokensMin + 1]] as const) {
			const document = await stored(bot.id);
			// Seed the old shape that the deployed writer can no longer create.
			await testEnv.BICKR_KV.put(kvKeys.bot(bot.id), JSON.stringify({ ...document, tickSettings: { ...document.tickSettings, contextWindowTokens: value } }));
			await testEnv.BICKR_D1.prepare('UPDATE bot_runtime_index SET context_window_tokens = ? WHERE bot_id = ?').bind(value, bot.id).run();
		}
		// A stale projection must not turn the old effective default into an override.
		await testEnv.BICKR_D1.prepare('UPDATE bot_runtime_index SET context_window_tokens = ? WHERE bot_id = ?').bind(contextWindowTokensMin - 1, inherited!.id).run();
		const before = new Map(await Promise.all(bots.map(async bot => [bot.id, { document: await stored(bot.id), index: await contextIndex(bot.id) }] as const)));
		await testEnv.BICKR_D1.prepare("UPDATE maintenance_control SET enabled = 1, activated_at = '2026-10-24T00:00:00Z' WHERE id = 1").run();
		const firstResponse = await sweep();
		expect(firstResponse.status).toBe(200);
		const first = await migrationPage(firstResponse);
		expect(first.schemaVersion).toBe(1);
		expect(first.results).toHaveLength(contextBudgetMigrationBatchSize);
		expect(first.done).toBe(false);
		expect(first.nextCursor).toBe(first.results.at(-1)?.botId);
		let cursor = first.nextCursor;
		while (cursor !== null) {
			const response = await sweep(cursor);
			expect(response.status).toBe(200);
			cursor = (await migrationPage(response)).nextCursor;
		}
		for (const bot of bots) {
			const document = await stored(bot.id);
			const old = before.get(bot.id)!;
			const index = await contextIndex(bot.id);
			if (bot.id === below!.id) {
				expect(document.tickSettings.contextWindowTokens).toBe(contextWindowTokensMin);
				expect(document.revision).toBe(old.document.revision + 1);
				expect(index).toEqual({ ...old.index, budget: contextWindowTokensMin });
			} else {
				expect(document).toEqual(old.document);
				expect(index).toEqual({ ...old.index, budget: document.tickSettings.contextWindowTokens ?? null });
			}
		}
		expect((await stored(inherited!.id)).tickSettings).not.toHaveProperty('contextWindowTokens');
		expect(defaultTickSettings.contextWindowTokens).toBe(contextWindowTokensMin * 2);
		const after = new Map(await Promise.all(bots.map(async bot => [bot.id, await stored(bot.id)] as const)));
		cursor = '';
		while (cursor !== null) {
			const response = await sweep(cursor);
			expect(response.status).toBe(200);
			const page = await migrationPage(response);
			expect(page.results.every((entry: { result: { kind: string } }) => entry.result.kind === 'unchanged')).toBe(true);
			cursor = page.nextCursor;
		}
		for (const bot of bots) expect(await stored(bot.id)).toEqual(after.get(bot.id));
	});
});
