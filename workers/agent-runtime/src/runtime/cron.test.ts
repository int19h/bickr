import { describe, expect, it, vi } from 'vitest';
import { unstable_readConfig as readConfig } from 'wrangler';
import {
	agentRuntimeCronExpressions,
	agentRuntimeCronTaskSet,
	agentRuntimeDailyCronExpression,
	agentRuntimeFrequentCronExpression,
} from './cron';
import { runScheduledAgentRuntimeTasks } from '../routes';

// Every agent-runtime Wrangler configuration that declares triggers, and the
// environment it declares them for. A trigger set that drifts from the task-set
// map would deploy a cron the scheduled handler cannot route.
const triggerConfigurations = [
	{ label: 'local/production default', path: 'workers/agent-runtime/wrangler.jsonc' },
	{ label: 'test environment', path: 'workers/agent-runtime/wrangler.jsonc', environment: 'test' },
	{ label: 'production deploy', path: 'workers/agent-runtime/wrangler.deploy.jsonc' },
	{ label: 'post-transfer test recreate', path: 'workers/agent-runtime/wrangler.recreate-test.jsonc' },
] as const;

describe('agent-runtime cron triggers', () => {
	it.each(triggerConfigurations)('declares exactly the known task sets in the $label configuration', ({ path, ...rest }) => {
		const environment = 'environment' in rest ? rest.environment : undefined;
		const config = readConfig({ config: path, ...(environment ? { env: environment } : {}) }, { hideWarnings: true });

		expect(config.triggers?.crons).toEqual(agentRuntimeCronExpressions);
	});

	it('maps each declared expression to its task set and nothing else', () => {
		expect(agentRuntimeCronTaskSet(agentRuntimeFrequentCronExpression)).toBe('frequent');
		expect(agentRuntimeCronTaskSet(agentRuntimeDailyCronExpression)).toBe('daily');
		expect(agentRuntimeCronTaskSet('  */5   *  *  *  * ')).toBe('frequent');
		expect(agentRuntimeCronTaskSet('0 0 * * *')).toBeNull();
		expect(agentRuntimeCronTaskSet(undefined)).toBeNull();
	});

	it('keeps the daily trigger clear of the frequent trigger and the other Worker daily cron', () => {
		const [minute, hour] = agentRuntimeDailyCronExpression.split(' ');
		expect(Number(minute) % 5).not.toBe(0);
		// The forum-coordinator daily cron runs at 0 0 * * *.
		expect(`${minute} ${hour}`).not.toBe('0 0');
	});
});

describe('scheduled cron dispatch', () => {
	function dispatchEnv() {
		const calls: string[] = [];
		const env = {
			INTERNAL_SERVICE_SECRET: 'test-secret',
			BICKR_KV: {
				async get() {
					return null;
				},
				async put() {},
				async delete() {},
			},
			BICKR_D1: {
				prepare(sql: string) {
					if (sql.includes('FROM maintenance_control')) {
						const statement = {
							bind: () => statement,
							async first<T>() {
								return {
									enabled: 0,
									message: 'Bickr is briefly offline for maintenance.',
									activatedAt: null,
									updatedAt: '2026-08-17T00:00:00.000Z',
								} as T;
							},
						};
						return statement;
					}
					if (sql.includes('runtime.runtime_storage_cleared_at IS NULL')) {
						calls.push('retention_sweep_query');
						return {
							bind: () => ({ async all<T>() {
								return { success: true, results: [] as T[] };
							} }),
						};
					}
					if (sql.includes('runtime.next_due_at <= ?')) {
						calls.push('due_dispatch_query');
						return {
							bind: () => ({ async all<T>() {
								return { success: true, results: [] as T[] };
							} }),
						};
					}
					if (sql.includes('entity_lifecycle_operations')) {
						calls.push('lifecycle_query');
						const statement = {
							bind: () => statement,
							async all<T>() {
								return { success: true, results: [] as T[] };
							},
							async run() {
								return { success: true };
							},
							async first<T>() {
								return null as T;
							},
						};
						return statement;
					}
					const statement = {
						bind: () => statement,
						async all<T>() {
							return { success: true, results: [] as T[] };
						},
						async run() {
							return { success: true };
						},
						async first<T>() {
							return null as T;
						},
					};
					return statement;
				},
			},
			BOT_RUNTIME: { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ ok: true }) }) },
			USER_BOTS: { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ ok: true }) }) },
		};
		return { env: env as unknown as Parameters<typeof runScheduledAgentRuntimeTasks>[0], calls };
	}

	it('routes the daily trigger to the retention sweep and never to bot dispatch', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const { env, calls } = dispatchEnv();

		const result = await runScheduledAgentRuntimeTasks(
			env,
			Date.parse('2026-08-17T03:23:00.000Z'),
			agentRuntimeDailyCronExpression,
		);

		expect(result).toMatchObject({ kind: 'daily', retention: { kind: 'bot_runtime_retention_sweep', scanned: 0 } });
		expect(calls).toContain('retention_sweep_query');
		expect(calls).not.toContain('due_dispatch_query');
		vi.restoreAllMocks();
	});

	it('routes the frequent trigger to bot dispatch and never to the retention sweep', async () => {
		const { env, calls } = dispatchEnv();

		const result = await runScheduledAgentRuntimeTasks(
			env,
			Date.parse('2026-08-17T00:05:00.000Z'),
			agentRuntimeFrequentCronExpression,
		);

		expect(result).toEqual({ kind: 'ordinary' });
		expect(calls).toContain('due_dispatch_query');
		expect(calls).not.toContain('retention_sweep_query');
	});

	it('falls back to the frequent set for an unrecognized expression and says so', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { env, calls } = dispatchEnv();

		const result = await runScheduledAgentRuntimeTasks(env, Date.parse('2026-08-17T00:05:00.000Z'), '7 7 7 7 7');

		expect(result).toEqual({ kind: 'ordinary' });
		expect(calls).toContain('due_dispatch_query');
		expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
			event: 'scheduled_unrecognized_cron',
			cron: '7 7 7 7 7',
		});
		vi.restoreAllMocks();
	});

	it('defers the daily set while maintenance mode is on', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const { env, calls } = dispatchEnv();
		vi.spyOn(env.BICKR_D1, 'prepare').mockImplementation(((sql: string) => {
			if (!sql.includes('FROM maintenance_control')) {
				throw new Error(`Unexpected query while maintenance is on: ${sql}`);
			}
			const statement = {
				bind: () => statement,
				async first<T>() {
					return {
						enabled: 1,
						message: 'Scheduled maintenance.',
						activatedAt: '2026-08-17T00:00:00.000Z',
						updatedAt: '2026-08-17T00:00:00.000Z',
					} as T;
				},
			};
			return statement;
		}) as typeof env.BICKR_D1.prepare);

		const result = await runScheduledAgentRuntimeTasks(
			env,
			Date.parse('2026-08-17T03:23:00.000Z'),
			agentRuntimeDailyCronExpression,
		);

		expect(result).toEqual({ kind: 'daily_deferred' });
		expect(calls).not.toContain('retention_sweep_query');
		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			event: 'scheduled_daily_tasks_deferred',
			reason: 'maintenance',
		});
		vi.restoreAllMocks();
	});
});
