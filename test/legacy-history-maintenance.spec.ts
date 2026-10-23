import { runInDurableObject } from 'cloudflare:test';
import { authCookie, createBotForTest, describe, expect, it, seedWorld, testEnv } from './helpers/index-harness';
import { handleAgentRuntimeWorkerRequest } from '../workers/agent-runtime/src/routes';
import { internalServiceTestHeaders } from './helpers/internal-service-auth';

function request(path: string, headers: Record<string, string> = { ...internalServiceTestHeaders, 'x-bickr-scheduler': '1' }, body = '{}') {
	return handleAgentRuntimeWorkerRequest(new Request(`https://internal.bickr${path}`, {
		method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body,
	}), testEnv);
}

describe('legacy history maintenance routes', () => {
	it('requires internal authentication and scheduler authority', async () => {
		expect((await request('/maintenance/legacy-history/census', {})).status).toBe(404);
		expect((await request('/maintenance/legacy-history/compact', internalServiceTestHeaders)).status).toBe(401);
		expect((await request('/maintenance/legacy-history/census', undefined, '{"cursor":7}')).status).toBe(400);
		expect((await request('/maintenance/legacy-history/compact', undefined, '{"limit":6}')).status).toBe(400);
	});

	it('counts retained history and defers an indexed run during site maintenance without reclaiming it', async () => {
		const cookie = await authCookie(); await seedWorld(cookie);
		const bot = await createBotForTest(cookie, 'legacy-history', { enabled: false });
		const stub = testEnv.BOT_RUNTIME.get(testEnv.BOT_RUNTIME.idFromName(bot.id));
		await runInDurableObject(stub, (_, state) => {
			state.storage.sql.exec(`INSERT INTO loop_messages
				(position, run_id, role, message_json, origin, token_estimate, created_at)
				VALUES (1, 'old', 'tool', ?, 'tool_result', 1, '2026-10-23')`, JSON.stringify({ role: 'tool', tool_call_id: 'old', content: '{}' }));
		});
		await testEnv.BICKR_D1.prepare("UPDATE bot_runtime_index SET status = 'running', active_run_id = 'retained-run', lease_expires_at = '2000-01-01' WHERE bot_id = ?").bind(bot.id).run();
		await testEnv.BICKR_D1.prepare("UPDATE maintenance_control SET enabled = 1, activated_at = '2026-10-23' WHERE id = 1").run();
		const census = await request('/maintenance/legacy-history/census');
		expect(census.status).toBe(200);
		expect(await census.json()).toMatchObject({ data: { page: { done: true, legacyRuntimes: [{ botId: bot.id, legacyToolRows: 1 }] } } });
		const direct = await request(`/bots/${bot.id}/maintenance/legacy-history/compact`);
		expect(direct.status).toBe(200);
		expect(await direct.json()).toMatchObject({ data: { compaction: { kind: 'deferred', remaining: 1, providerCalls: 0 } } });
		const fleet = await request('/maintenance/legacy-history/compact');
		expect(fleet.status).toBe(200);
		expect(await fleet.json()).toMatchObject({ data: { page: { results: [{ botId: bot.id, kind: 'compaction', result: { kind: 'deferred', remaining: 1 } }] } } });
		expect(await testEnv.BICKR_D1.prepare('SELECT status, active_run_id AS runId FROM bot_runtime_index WHERE bot_id = ?').bind(bot.id).first()).toEqual({ status: 'running', runId: 'retained-run' });
	});
});
