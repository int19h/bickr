import { runInDurableObject } from 'cloudflare:test';
import { authCookie, createBotForTest, describe, expect, it, kvKeys, seedWorld, testEnv } from './helpers/index-harness';
import { handleAgentRuntimeWorkerRequest } from '../workers/agent-runtime/src/routes';
import { internalServiceTestHeaders } from './helpers/internal-service-auth';

function sweep(kind: 'runtime' | 'bootstrap', headers = internalServiceTestHeaders) {
	return handleAgentRuntimeWorkerRequest(new Request(`https://internal.bickr/maintenance/instruction-localization/${kind}`, {
		method: 'POST', headers: { ...headers, 'x-bickr-scheduler': '1', 'content-type': 'application/json' }, body: '{"cursor":""}',
	}), testEnv);
}

describe('instruction localization fleet maintenance', () => {
	it('requires internal authentication, scheduler authority, and maintenance mode', async () => {
		expect((await sweep('bootstrap', {} as typeof internalServiceTestHeaders)).status).toBe(404);
		const noScheduler = await handleAgentRuntimeWorkerRequest(new Request('https://internal.bickr/maintenance/instruction-localization/bootstrap', {
			method: 'POST', headers: { ...internalServiceTestHeaders, 'content-type': 'application/json' }, body: '{}',
		}), testEnv);
		expect(noScheduler.status).toBe(401);
		expect((await sweep('bootstrap')).status).toBe(409);
	});
	it('censuses composed text without rewriting it and wakes runtime migrations without changing the schedule', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, 'locale-migration', { enabled: false });
		const id = 'ntf_old_localization';
		const text = '  {{message}}\n古い文章。  ';
		const stored = JSON.stringify({ id, botId: bot.id, notificationType: 'bootstrap', message: { lang: 'ja', text }, event: {
			kind: 'bootstrap', type: 'bootstrap', id, createdAt: '2026-01-01', deliveryReasons: ['bootstrap'], message: { lang: 'ja', text },
		} });
		await testEnv.BICKR_KV.put(kvKeys.notification(bot.id, id), stored);
		await testEnv.BICKR_D1.prepare("INSERT INTO notifications (notification_id, world_id, bot_id, type, status, message, created_at) VALUES (?, ?, ?, 'bootstrap', 'pending', ?, '2026-01-01')")
			.bind(id, bot.homeWorldId, bot.id, text).run();
		const before = await testEnv.BICKR_D1.prepare('SELECT next_due_at AS dueAt FROM bot_runtime_index WHERE bot_id = ?').bind(bot.id).first();
		await testEnv.BICKR_D1.prepare("UPDATE maintenance_control SET enabled = 1, activated_at = '2026-10-07T00:00:00.000Z' WHERE id = 1").run();
		const census = await sweep('bootstrap');
		expect(census.status).toBe(200);
		expect(await census.json()).toMatchObject({ data: { sweep: { results: expect.arrayContaining([{ id, botId: bot.id, kind: 'composed' }]) } } });
		expect(await testEnv.BICKR_KV.get(kvKeys.notification(bot.id, id))).toBe(stored);
		const migration = await sweep('runtime');
		expect(migration.status).toBe(200);
		expect(await migration.json()).toMatchObject({ data: { sweep: { results: expect.arrayContaining([
			{ id: bot.id, kind: 'success', status: { kind: 'empty', schemaVersion: 1, factoryPlanDone: true, legacyHistoryDone: true, legacyPendingTools: 0 } },
		]) } } });
		expect(await testEnv.BICKR_D1.prepare('SELECT next_due_at AS dueAt FROM bot_runtime_index WHERE bot_id = ?').bind(bot.id).first()).toEqual(before);
		const stub = testEnv.BOT_RUNTIME.get(testEnv.BOT_RUNTIME.idFromName(bot.id));
		await runInDurableObject(stub, (_, state) => {
			expect(state.storage.sql.exec<{ content: string; content_source: string }>("SELECT content, content_source FROM notes WHERE note_id = 'PLAN'").one()).toEqual({ content: '', content_source: 'factory' });
		});
	});
});
