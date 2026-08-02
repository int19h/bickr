import { onRequest as pagesMiddleware } from '../apps/web/functions/_middleware';
import { onRequestGet as maintenanceStatus } from '../apps/web/functions/api/maintenance';
import {
	deferAlarmDuringMaintenance,
	MaintenanceModeEnabledError,
	readMaintenanceState,
	requireMaintenanceDisabled,
} from '../packages/shared/src/maintenance';
import { handleAgentRuntimeRequest } from '../workers/agent-runtime/src/routes';
import { handleForumCoordinatorRequest } from '../workers/forum-coordinator/src/index';
import { contextFor, describe, expect, it, jsonRequest, testEnv, testServiceProxy, vi } from './helpers/index-harness';

async function setMaintenance(enabled: boolean): Promise<void> {
	const now = '2026-08-02T00:00:00.000Z';
	await testEnv.BICKR_D1.prepare(
		`UPDATE maintenance_control
		 SET enabled = ?, activated_at = ?, updated_at = ?
		 WHERE id = 1`,
	)
		.bind(enabled ? 1 : 0, enabled ? now : null, now)
		.run();
}

describe('maintenance control', () => {
	it('starts disabled and reports a typed enabled state', async () => {
		expect(await readMaintenanceState(testEnv.BICKR_D1)).toMatchObject({ enabled: false, activatedAt: null });
		await setMaintenance(true);
		await expect(requireMaintenanceDisabled(testEnv.BICKR_D1)).rejects.toBeInstanceOf(MaintenanceModeEnabledError);
	});

	it('blocks Pages mutations while preserving reads, MCP dispatch, and runtime stop', async () => {
		await setMaintenance(true);
		const next = vi.fn(async () => new Response('next'));
		const invoke = (request: Request) =>
			pagesMiddleware({
				...contextFor<typeof pagesMiddleware>(request),
				next,
			} as Parameters<typeof pagesMiddleware>[0]);

		const blocked = await invoke(new Request('https://test.bickr.social/api/worlds', { method: 'POST' }));
		expect(blocked.status).toBe(503);
		expect(await blocked.json()).toMatchObject({ error: 'maintenance' });
		expect(next).not.toHaveBeenCalled();

		expect((await invoke(new Request('https://test.bickr.social/api/worlds'))).status).toBe(200);
		expect((await invoke(new Request('https://test.bickr.social/mcp', { method: 'POST' }))).status).toBe(200);
		expect((await invoke(new Request('https://test.bickr.social/api/__test__/service-proxy', { method: 'POST' }))).status).toBe(200);
		expect((await invoke(new Request('https://test.bickr.social/api/me/bots/bot_1/runtime/stop', { method: 'POST' }))).status).toBe(200);

		for (const pathname of [
			'/api/auth/github/start',
			'/api/auth/github/callback',
			'/api/auth/google/start',
			'/api/auth/google/callback',
		]) {
			expect((await invoke(new Request(`https://test.bickr.social${pathname}`))).status).toBe(503);
		}
	});

	it('gates the authenticated service proxy by its parsed inner request', async () => {
		await setMaintenance(true);
		const proxiedRequests: Request[] = [];
		const agentRuntime = {
			fetch: async (request: Request) => {
				proxiedRequests.push(request);
				return Response.json({ ok: true });
			},
		} as unknown as Fetcher;
		const invoke = (input: Record<string, unknown>) =>
			testServiceProxy(
				contextFor<typeof testServiceProxy>(
					jsonRequest(
						'https://test.bickr.social/api/__test__/service-proxy',
						'POST',
						input,
						undefined,
						{ 'x-test-auth-secret': 'secret' },
					),
					{},
					{
						AGENT_RUNTIME: agentRuntime,
						BICKR_D1: testEnv.BICKR_D1,
						INTERNAL_SERVICE_SECRET: 'service-secret',
						TEST_AUTH_ALLOWED_HOSTS: 'test.bickr.social,test.bickr.pages.dev',
						TEST_AUTH_SECRET: 'secret',
					},
				),
			);

		expect(await invoke({ service: 'agent-runtime', method: 'GET', path: '/health' })).toHaveProperty('status', 200);
		expect(await invoke({
			service: 'agent-runtime',
			method: 'POST',
			path: '/bots/bot_1/stop',
			headers: { 'x-bickr-scheduler': '1' },
		})).toHaveProperty('status', 200);
		const blocked = await invoke({
			service: 'agent-runtime',
			method: 'POST',
			path: '/bots/bot_1/tick',
			headers: { 'x-bickr-scheduler': '1' },
		});
		expect(blocked.status).toBe(503);
		expect(await blocked.json()).toMatchObject({ error: 'maintenance' });
		expect(proxiedRequests.map((request) => new URL(request.url).pathname)).toEqual([
			'/health',
			'/bots/bot_1/stop',
		]);
	});

	it('exposes a no-store public status response', async () => {
		await setMaintenance(true);
		const response = await maintenanceStatus(
			contextFor<typeof maintenanceStatus>(new Request('https://test.bickr.social/api/maintenance')),
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toMatchObject({
			ok: true,
			maintenance: { enabled: true },
		});
	});

	it('blocks direct service mutations and allows service reads', async () => {
		await setMaintenance(true);
		const agentEnv = { BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV };
		const forumEnv = { BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV };

		const agentMutation = await handleAgentRuntimeRequest(
			new Request('https://internal.bickr/users/usr_1/translate', { method: 'POST' }),
			agentEnv,
		);
		expect(agentMutation.status).toBe(503);
		const forumMutation = await handleForumCoordinatorRequest(new Request('https://internal.bickr/worlds', { method: 'POST' }), forumEnv);
		expect(forumMutation.status).toBe(503);

		const agentRead = await handleAgentRuntimeRequest(new Request('https://internal.bickr/health'), agentEnv);
		expect(agentRead.status).toBe(200);
	});

	it('defers Durable Object alarms without consuming their pending task', async () => {
		await setMaintenance(true);
		const setAlarm = vi.fn(async () => undefined);
		expect(await deferAlarmDuringMaintenance(testEnv.BICKR_D1, { setAlarm }, 1_000)).toBe(true);
		expect(setAlarm).toHaveBeenCalledOnce();

		await setMaintenance(false);
		setAlarm.mockClear();
		expect(await deferAlarmDuringMaintenance(testEnv.BICKR_D1, { setAlarm }, 1_000)).toBe(false);
		expect(setAlarm).not.toHaveBeenCalled();
	});
});
