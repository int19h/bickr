import { afterEach, describe, expect, it, vi } from 'vitest';
import { runScheduledAgentRuntimeTasks } from '../routes';

describe('scheduled provider-default barrier maintenance', () => {
	afterEach(() => vi.restoreAllMocks());

	const pendingOwner = { ownerUserId: 'usr_pending_sweep' } as const;

	function maintenanceEnv(
		rows: readonly (typeof pendingOwner)[],
		fetchCoordinator: (request: Request) => Promise<Response>,
	) {
		const ordinaryDispatch = vi.fn((name: string) => name);
		const coordinatorDispatch = vi.fn(fetchCoordinator);
		const claimedAttempts: string[] = [];
		const env = {
			INTERNAL_SERVICE_SECRET: 'test-secret',
			BICKR_D1: {
				prepare(sql: string) {
					if (sql.includes('FROM maintenance_control')) {
						const statement = {
							bind() {
								return statement;
							},
							async first<T>() {
								return {
									enabled: 1,
									message: 'Scheduled maintenance.',
									activatedAt: '2026-08-14T00:00:00.000Z',
									updatedAt: '2026-08-14T00:00:00.000Z',
								} as T;
							},
						};
						return statement;
					}
					// Selecting and claiming are one statement, so the claim is a single
					// prepare that both reads the pending owners and records the attempt.
					if (sql.includes('INTO inference_provider_default_barrier_fleet_attempts')
						&& sql.includes('FROM inference_provider_default_barrier_sweeps')) {
						return {
							bind(attemptedAt: string) {
								for (const row of rows) claimedAttempts.push(`${row.ownerUserId}@${attemptedAt}`);
								return {
									async all<T>() {
										return { success: true, results: rows.map((row) => ({ ...row }) as T) };
									},
								};
							},
						};
					}
					throw new Error(`Unexpected scheduled-maintenance query: ${sql}`);
				},
			},
			BOT_RUNTIME: {
				idFromName: ordinaryDispatch,
				get: () => ({ fetch: async () => Response.json({ ok: true }) }),
			},
			USER_BOTS: {
				idFromName: (ownerUserId: string) => ownerUserId,
				get: () => ({ fetch: coordinatorDispatch }),
			},
		};
		return {
			env: env as unknown as Parameters<typeof runScheduledAgentRuntimeTasks>[0],
			ordinaryDispatch,
			coordinatorDispatch,
			claimedAttempts,
		};
	}

	it('defers ordinary tasks and advances a pending sweep through its user coordinator', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const { env, ordinaryDispatch, coordinatorDispatch, claimedAttempts } = maintenanceEnv([pendingOwner], async (request) => {
			expect(new URL(request.url).pathname).toBe(
				`/users/${pendingOwner.ownerUserId}/inference-graph/provider-default-barrier-sweep`,
			);
			// The coordinator request is built from scratch, so it carries the
			// internal header set and nothing an operator request could contribute.
			expect([...request.headers.keys()].sort()).toEqual(
				['x-bickr-internal-auth', 'x-bickr-scheduler', 'x-bickr-user-id'],
			);
			expect(request.headers.get('x-bickr-scheduler')).toBe('1');
			expect(request.headers.get('x-bickr-user-id')).toBe(pendingOwner.ownerUserId);
			return Response.json({ ok: true });
		});

		const result = await runScheduledAgentRuntimeTasks(env, Date.parse('2026-08-14T00:00:00.000Z'));

		expect(result).toMatchObject({
			kind: 'maintenance',
			sweep: {
				processedOwners: 1,
				complete: false,
				attempts: [{ ownerUserId: pendingOwner.ownerUserId, status: 'accepted', httpStatus: 200 }],
			},
		});
		expect(coordinatorDispatch).toHaveBeenCalledOnce();
		// The claim records the attempt, so the next tick starts behind this owner
		// instead of restarting at the front of the owner-id order.
		expect(claimedAttempts).toEqual([`${pendingOwner.ownerUserId}@2026-08-14T00:00:00.000Z`]);
		expect(ordinaryDispatch).not.toHaveBeenCalled();
		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			event: 'scheduled_provider_default_barrier_sweep',
			outcome: 'progress',
		});
	});

	it('no-ops without pending work and leaves failed owners observable and retryable', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const noWork = maintenanceEnv([], async () => Response.json({ ok: true }));
		const terminalResult = await runScheduledAgentRuntimeTasks(noWork.env, Date.parse('2026-08-14T00:05:00.000Z'));
		expect(terminalResult).toMatchObject({
			kind: 'maintenance',
			sweep: { processedOwners: 0, complete: true, attempts: [] },
		});
		expect(noWork.coordinatorDispatch).not.toHaveBeenCalled();

		let attempt = 0;
		const retry = maintenanceEnv([pendingOwner], async () => {
			attempt += 1;
			return attempt === 1 ? new Response('retry', { status: 503 }) : Response.json({ ok: true });
		});
		const failed = await runScheduledAgentRuntimeTasks(retry.env, Date.parse('2026-08-14T00:10:00.000Z'));
		expect(failed).toMatchObject({
			kind: 'maintenance',
			sweep: {
				attempts: [{
					ownerUserId: pendingOwner.ownerUserId,
					status: 'failed',
					httpStatus: 503,
					failure: { kind: 'http_response' },
				}],
			},
		});
		expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
			event: 'scheduled_provider_default_barrier_sweep',
			outcome: 'partial_failure',
			failedOwners: 1,
		});
		const retried = await runScheduledAgentRuntimeTasks(retry.env, Date.parse('2026-08-14T00:15:00.000Z'));
		expect(retried).toMatchObject({
			kind: 'maintenance',
			sweep: { attempts: [{ ownerUserId: pendingOwner.ownerUserId, status: 'accepted' }] },
		});
		expect(retry.coordinatorDispatch).toHaveBeenCalledTimes(2);
	});
});
