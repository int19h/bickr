import { onRequest as pagesMiddleware } from '../apps/web/functions/_middleware';
import { onRequestGet as maintenanceStatus } from '../apps/web/functions/api/maintenance';
import {
	deferAlarmDuringMaintenance,
	MaintenanceModeEnabledError,
	readMaintenanceState,
	requireMaintenanceDisabled,
} from '../packages/shared/src/maintenance';
import { internalServiceUrl } from '../packages/shared/src/internal-service';
import { localizedText, schemaVersion } from '../packages/shared/src/model';
import { upsertUserIndexProjection } from '../packages/shared/src/repository';
import agentRuntimeWorker, { handleAgentRuntimeRequest } from '../workers/agent-runtime/src/routes';
import { handleForumCoordinatorRequest } from '../workers/forum-coordinator/src/index';
import { contextFor, describe, expect, it, jsonRequest, testEnv, testServiceProxy, vi } from './helpers/index-harness';

const maintenanceOwnerId = 'usr_maintenance_gate';

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
		expect(await invoke({
			service: 'agent-runtime',
			method: 'POST',
			path: '/bots/bot_1/recover-stale-run',
			headers: { 'x-bickr-scheduler': '1' },
		})).toHaveProperty('status', 200);
		for (const path of [
			`/users/${maintenanceOwnerId}/inference-graph/provider-default-barrier-sweep`,
			'/inference-graph/provider-default-barrier-sweep',
		]) {
			expect(await invoke({
				service: 'agent-runtime',
				method: 'POST',
				path,
				headers: {
					'x-bickr-scheduler': '1',
					'x-bickr-user-id': maintenanceOwnerId,
				},
			})).toHaveProperty('status', 200);
		}
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
			'/bots/bot_1/recover-stale-run',
			`/users/${maintenanceOwnerId}/inference-graph/provider-default-barrier-sweep`,
			'/inference-graph/provider-default-barrier-sweep',
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

	it('routes scheduler inference graph maintenance operations through the agent worker entry', async () => {
		await setMaintenance(true);
		const dispatched: { method: string; path: string; userId: string }[] = [];
		const userBots = {
			idFromName(name: string): DurableObjectId {
				return name as unknown as DurableObjectId;
			},
			get(objectId: DurableObjectId): Fetcher {
				return {
					fetch: async (request: Request) => {
						dispatched.push({
							method: request.method,
							path: new URL(request.url).pathname,
							userId: objectId as unknown as string,
						});
						return Response.json({ ok: true, data: { coordinator: objectId } });
					},
				} as unknown as Fetcher;
			},
		};
		const workerEnv = {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			USER_BOTS: userBots,
		} as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1];
		const schedulerRequest = (path: string, body?: unknown) =>
			new Request(internalServiceUrl(path), {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-bickr-scheduler': '1',
					'x-bickr-user-id': maintenanceOwnerId,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}) as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0];

		for (const operation of ['migrate', 'provider-default-barrier-sweep', 'rollback', 'reactivate']) {
			const response = await agentRuntimeWorker.fetch(
				schedulerRequest(`/users/${maintenanceOwnerId}/inference-graph/${operation}`),
				workerEnv,
			);
			expect(response.status).toBe(200);
		}
		expect(dispatched).toEqual(['migrate', 'provider-default-barrier-sweep', 'rollback', 'reactivate'].map((operation) => ({
			method: 'POST',
			path: `/users/${maintenanceOwnerId}/inference-graph/${operation}`,
			userId: maintenanceOwnerId,
		})));

		const sweepNow = '2026-08-02T00:00:00.000Z';
		const cleanupAt = '2099-08-02T00:00:00.000Z';
		await upsertUserIndexProjection(testEnv.BICKR_D1, {
			id: maintenanceOwnerId,
			type: 'user',
			schemaVersion,
			revision: 1,
			handle: 'maintenance-sweep',
			language: null,
			displayName: localizedText('Maintenance Sweep', null),
			createdAt: sweepNow,
			updatedAt: sweepNow,
		});
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare(
				`INSERT INTO inference_graph_users (
					owner_user_id, writer_version, cutover_version, verified_cutover_at, created_at, updated_at
				 ) VALUES (?, 1, 1, ?, ?, ?)`,
			).bind(maintenanceOwnerId, sweepNow, sweepNow, sweepNow),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO inference_graph_migration_operations (
					owner_user_id, migration_version, phase, revision,
					created_at, updated_at, terminal_at, terminal_cleanup_at
				 ) VALUES (?, 1, 'terminal', 1, ?, ?, ?, ?)`,
			).bind(maintenanceOwnerId, sweepNow, sweepNow, sweepNow, cleanupAt),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO inference_graph_convergence (
					owner_user_id, phase, d1_revision, kv_revision,
					created_at, updated_at, terminal_cleanup_at
				 ) VALUES (?, 'terminal', 0, 0, ?, ?, ?)`,
			).bind(maintenanceOwnerId, sweepNow, sweepNow, cleanupAt),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO inference_provider_default_barrier_sweeps
				 (owner_user_id, phase, stage, created_at, updated_at) VALUES (?, 'pending', 'account', ?, ?)`,
			).bind(maintenanceOwnerId, sweepNow, sweepNow),
		]);

		const statusRequest = new Request(internalServiceUrl('/inference-graph/provider-default-barrier-sweep/status?limit=1'), {
			headers: { 'x-bickr-scheduler': '1' },
		}) as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0];
		const sweepStatus = await agentRuntimeWorker.fetch(statusRequest, workerEnv);
		expect(sweepStatus.status).toBe(200);
		expect(await sweepStatus.json()).toMatchObject({ data: { status: { items: [{ ownerUserId: maintenanceOwnerId, phase: 'pending' }] } } });
		const fleetSweep = await agentRuntimeWorker.fetch(
			schedulerRequest('/inference-graph/provider-default-barrier-sweep', { limit: 1 }),
			workerEnv,
		);
		expect(fleetSweep.status).toBe(200);
		expect(await fleetSweep.json()).toMatchObject({ data: { sweep: {
			kind: 'inference_provider_default_barrier_fleet_sweep', processedOwners: 1, complete: false,
			attempts: [{ ownerUserId: maintenanceOwnerId, status: 'accepted' }],
		} } });

		// The remaining fleet operations dispatch directly, so a maintenance-enabled worker
		// entry must reach their handlers rather than the shared mutation gate.
		const cleanup = await agentRuntimeWorker.fetch(schedulerRequest('/inference-graph/cleanup', { limit: 1 }), workerEnv);
		expect(cleanup.status).toBe(200);
		expect(await cleanup.json()).toMatchObject({ data: { cleanup: { convergence: 0, operations: 0, projections: 0 } } });
		const activation = await agentRuntimeWorker.fetch(schedulerRequest('/inference-graph/activate-lifecycle'), workerEnv);
		expect(activation.status).toBe(200);
		expect(await activation.json()).toMatchObject({ data: { activationMode: 'inference_graph_required' } });

		for (const path of [
			`/users/${maintenanceOwnerId}/translate`,
			'/bots/bot_1/tick',
			// Only the designated maintenance operations are exempt; a neighboring
			// inference graph path keeps the shared maintenance rejection.
			'/inference-graph/fleet-status',
		]) {
			const blocked = await agentRuntimeWorker.fetch(schedulerRequest(path), workerEnv);
			expect(blocked.status).toBe(503);
			expect(await blocked.json()).toMatchObject({ error: 'maintenance' });
		}
		expect(dispatched).toHaveLength(5);
	});

	it('runs the inference graph cleanup with maintenance disabled, still behind internal-service auth', async () => {
		// #190 lifted the cleanup route's maintenance requirement so the daily cron
		// — which only runs while maintenance is OFF — can call it. Everything it
		// deletes is terminal-phase and past its recorded cleanup timestamp, so no
		// live write can reach those rows.
		await setMaintenance(false);
		const workerEnv = {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		} as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1];
		const cleanupRequest = (headers: Record<string, string>) =>
			new Request(internalServiceUrl('/inference-graph/cleanup'), {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: JSON.stringify({ limit: 1 }),
			}) as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0];

		const cleanup = await agentRuntimeWorker.fetch(cleanupRequest({ 'x-bickr-scheduler': '1' }), workerEnv);
		expect(cleanup.status).toBe(200);
		expect(await cleanup.json()).toMatchObject({ data: { cleanup: { convergence: 0, operations: 0, projections: 0 } } });

		// Lifting the maintenance gate did not loosen anything else: the route is
		// still internal-secret and scheduler-service only.
		const unauthenticated = await handleAgentRuntimeRequest(
			new Request(internalServiceUrl('/inference-graph/cleanup'), { method: 'POST' }),
			{ BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV },
		);
		expect(unauthenticated.status).toBe(401);
		expect(await unauthenticated.json()).toMatchObject({ error: 'unauthorized' });
	});

	it('gates the coordinator entry with the same maintenance operation classification', async () => {
		await setMaintenance(true);
		const agentEnv = { BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV };
		// Without scheduler auth each maintenance operation answers from its own
		// handler, which only runs once the shared mutation gate has let it past.
		for (const path of [
			`/users/${maintenanceOwnerId}/inference-graph/migrate`,
			`/users/${maintenanceOwnerId}/inference-graph/provider-default-barrier-sweep`,
			`/users/${maintenanceOwnerId}/inference-graph/rollback`,
			`/users/${maintenanceOwnerId}/inference-graph/reactivate`,
			'/inference-graph/provider-default-barrier-sweep',
			'/inference-graph/cleanup',
			'/inference-graph/activate-lifecycle',
		]) {
			const response = await handleAgentRuntimeRequest(new Request(internalServiceUrl(path), { method: 'POST' }), agentEnv);
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ error: 'unauthorized' });
		}

		const blocked = await handleAgentRuntimeRequest(
			new Request(internalServiceUrl(`/users/${maintenanceOwnerId}/inference-graph/migration`), { method: 'POST' }),
			agentEnv,
		);
		expect(blocked.status).toBe(503);
		expect(await blocked.json()).toMatchObject({ error: 'maintenance' });
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
