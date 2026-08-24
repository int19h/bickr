import { describe, expect, it } from 'vitest';
import { kvKeys } from '@bickr/shared/storage';
import { runStaleRunRecoverySweep, type RuntimeStaleRunRecoveryResult } from './stale-run-recovery';

type RecoveryRow = {
	botId: string;
	status: string;
	leaseExpiresAt: string | null;
	botDeletedAt: string | null;
	botLifecycleState: string | null;
	botMissing: number;
};

function recoveryEnv(
	rows: RecoveryRow[],
	options: {
		cursor?: { afterBotId?: string; retryBotIds?: string[] };
		result?: (botId: string) => RuntimeStaleRunRecoveryResult | null;
	} = {},
) {
	const requests: string[] = [];
	const values = new Map<string, string>();
	if (options.cursor) values.set(kvKeys.botRuntimeStaleRunRecoveryCursor, JSON.stringify(options.cursor));
	const env = {
		INTERNAL_SERVICE_SECRET: 'test-secret',
		BICKR_KV: {
			async get(key: string) {
				const value = values.get(key);
				return value === undefined ? null : JSON.parse(value) as unknown;
			},
			async put(key: string, value: string) { values.set(key, value); },
			async delete(key: string) { values.delete(key); },
		},
		BICKR_D1: {
			prepare(sql: string) {
				const retry = sql.includes('runtime.bot_id IN (');
				const keyed = sql.includes('runtime.bot_id > ?');
				return {
					bind(...params: unknown[]) {
						return {
							async all<T>() {
								if (retry) {
									const wanted = new Set(params.map(String));
									return { success: true, results: rows.filter((row) => wanted.has(row.botId)) as T[] };
								}
								const after = keyed ? String(params[1]) : '';
								const limit = Number(params[keyed ? 2 : 1]);
								return {
									success: true,
									results: rows.filter((row) => row.botId > after).sort((a, b) => a.botId.localeCompare(b.botId)).slice(0, limit) as T[],
								};
							},
						};
					},
				};
			},
		},
		BOT_RUNTIME: {
			idFromName: (botId: string) => botId,
			get: (botId: string) => ({
				async fetch(request: Request) {
					requests.push(botId);
					expect(request.method).toBe('POST');
					expect(request.headers.get('x-bickr-scheduler')).toBe('1');
					const result = options.result ? options.result(botId) : { kind: 'reaped' as const, botId, runId: `run-${botId}` };
					return result ? Response.json({ ok: true, data: { recovery: result } }) : new Response('busy', { status: 503 });
				},
			}),
		},
	};
	return { env: env as Parameters<typeof runStaleRunRecoverySweep>[0], requests, values };
}

const liveRow = (botId: string, overrides: Partial<RecoveryRow> = {}): RecoveryRow => ({
	botId,
	status: 'running',
	leaseExpiresAt: null,
	botDeletedAt: null,
	botLifecycleState: 'active',
	botMissing: 0,
	...overrides,
});

describe('stale runtime lease recovery sweep', () => {
	it('spends retry budget first without letting a failing prefix starve the stable cursor', async () => {
		const failing = new Set(['bot-a']);
		const { env, requests, values } = recoveryEnv(
			['bot-a', 'bot-b', 'bot-c', 'bot-d'].map((botId) => liveRow(botId)),
			{ result: (botId) => failing.has(botId) ? null : { kind: 'reaped', botId, runId: `run-${botId}` } },
		);

		const first = await runStaleRunRecoverySweep(env, { maxBotsPerRun: 2, chunkSize: 1 });
		expect(first).toMatchObject({ scanned: 2, failed: 1, reaped: 1, retryBacklog: 1, budgetExhausted: true });
		expect(requests).toEqual(['bot-a', 'bot-b']);

		requests.length = 0;
		const second = await runStaleRunRecoverySweep(env, { maxBotsPerRun: 2, chunkSize: 1 });
		expect(second).toMatchObject({ retried: 1, failed: 1, reaped: 1, budgetExhausted: true });
		expect(requests).toEqual(['bot-a', 'bot-c']);
		expect(JSON.parse(values.get(kvKeys.botRuntimeStaleRunRecoveryCursor)!)).toMatchObject({ afterBotId: 'bot-c', retryBotIds: ['bot-a'] });
	});

	it('selects null-lease live rows regardless of scheduling state and skips non-live rows', async () => {
		const { env, requests } = recoveryEnv([
			liveRow('bot-null-paused'),
			liveRow('bot-future-spotlight'),
			liveRow('bot-cleared'),
			liveRow('bot-deleted', { botDeletedAt: '2026-08-01T00:00:00.000Z' }),
		], {
			result: (botId) => botId === 'bot-cleared'
				? { kind: 'released_storage_cleared', botId, runId: 'run-cleared' }
				: { kind: 'reaped', botId, runId: `run-${botId}` },
		});

		const result = await runStaleRunRecoverySweep(env, { maxBotsPerRun: 10, chunkSize: 10 });
		expect(result).toMatchObject({ selected: 4, scanned: 4, reaped: 2, releasedStorageCleared: 1, skippedNonLive: 1, failed: 0 });
		expect(requests.sort()).toEqual(['bot-cleared', 'bot-future-spotlight', 'bot-null-paused']);
	});

	it('persists retry entries that do not fit in the current bounded budget', async () => {
		const { env, values } = recoveryEnv(
			['bot-a', 'bot-b', 'bot-c'].map((botId) => liveRow(botId)),
			{ cursor: { retryBotIds: ['bot-a', 'bot-b', 'bot-c'] }, result: () => null },
		);

		const result = await runStaleRunRecoverySweep(env, { maxBotsPerRun: 1, chunkSize: 1 });
		expect(result).toMatchObject({ retried: 0, failed: 1, retryBacklog: 3, budgetExhausted: true });
		expect(JSON.parse(values.get(kvKeys.botRuntimeStaleRunRecoveryCursor)!)).toEqual({
			afterBotId: 'bot-a',
			retryBotIds: ['bot-a', 'bot-b', 'bot-c'],
		});
	});
});
