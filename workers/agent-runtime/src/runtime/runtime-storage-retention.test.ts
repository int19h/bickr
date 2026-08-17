import { describe, expect, it } from 'vitest';
import { kvKeys } from '@bickr/shared/storage';
import {
	botRuntimeRetentionSweepMaxRetryBacklog,
	botRuntimeRetentionSweepReportedFailureLimit,
	runBotRuntimeRetentionSweep,
} from './runtime-storage-retention';

type FleetRow = { botId: string; botDeletedAt: string | null; botMissing: number };

type SweepEnv = Parameters<typeof runBotRuntimeRetentionSweep>[0] & {
	requests: string[];
	rows: FleetRow[];
	kvValues: Map<string, string>;
};

const now = '2026-08-17T03:23:00.000Z';

function sweepEnv(
	rows: FleetRow[],
	options: { fail?: (botId: string, path: string) => boolean; cursor?: string } = {},
): SweepEnv {
	// `fail` is read per dispatch rather than captured, so a test can make a
	// participant fail in one pass and succeed in the next.
	const requests: string[] = [];
	const kvValues = new Map<string, string>();
	if (options.cursor) {
		kvValues.set(kvKeys.botRuntimeRetentionSweepCursor, JSON.stringify({ afterBotId: options.cursor }));
	}
	const env = {
		INTERNAL_SERVICE_SECRET: 'test-secret',
		requests,
		rows,
		kvValues,
		BICKR_KV: {
			async get(key: string) {
				const value = kvValues.get(key);
				return value === undefined ? null : (JSON.parse(value) as unknown);
			},
			async put(key: string, value: string) {
				kvValues.set(key, value);
			},
			async delete(key: string) {
				kvValues.delete(key);
			},
		},
		BICKR_D1: {
			prepare(sql: string) {
				if (sql.includes('UPDATE bot_runtime_index')) {
					return {
						bind(clearedAt: string, _updatedAt: string, botId: string) {
							return {
								async run() {
									requests.push(`mark:${botId}@${clearedAt}`);
									const row = rows.find((candidate) => candidate.botId === botId);
									if (row) {
										// The marker is what excludes the row from later passes.
										rows.splice(rows.indexOf(row), 1);
									}
									return { success: true };
								},
							};
						},
					};
				}
				// Checked before the keyset branch: both mention the same table, and
				// this is the retry backlog's re-read of specific ids.
				if (sql.includes('runtime.bot_id IN (')) {
					return {
						bind(...botIds: unknown[]) {
							return {
								async all<T>() {
									const wanted = new Set(botIds.map(String));
									const page = [...rows]
										.filter((row) => wanted.has(row.botId))
										.sort((left, right) => left.botId.localeCompare(right.botId));
									return { success: true, results: page as T[] };
								},
							};
						},
					};
				}
				if (sql.includes('FROM bot_runtime_index runtime')) {
					const keyed = sql.includes('runtime.bot_id > ?');
					return {
						bind(...values: unknown[]) {
							const after = keyed ? String(values[0]) : '';
							const limit = Number(values[keyed ? 1 : 0]);
							return {
								async all<T>() {
									const page = [...rows]
										.sort((left, right) => left.botId.localeCompare(right.botId))
										.filter((row) => row.botId > after)
										.slice(0, limit);
									return { success: true, results: page as T[] };
								},
							};
						},
					};
				}
				throw new Error(`Unexpected sweep query: ${sql}`);
			},
		},
		BOT_RUNTIME: {
			idFromName: (botId: string) => botId,
			get: (botId: string) => ({
				async fetch(request: Request) {
					const path = new URL(request.url).pathname.split('/').at(-1) ?? '';
					requests.push(`${request.method} ${botId}/${path}`);
					expect(request.headers.get('x-bickr-scheduler')).toBe('1');
					return options.fail?.(botId, path)
						? new Response('busy', { status: 409 })
						: Response.json({ ok: true });
				},
			}),
		},
	};
	return env as unknown as SweepEnv;
}

function liveBot(botId: string): FleetRow {
	return { botId, botDeletedAt: null, botMissing: 0 };
}

describe('BotRuntime retention fleet sweep', () => {
	it('prunes live participants and full-clears tombstoned and orphaned ones', async () => {
		const env = sweepEnv([
			liveBot('bot-a'),
			{ botId: 'bot-b', botDeletedAt: '2026-07-01T00:00:00.000Z', botMissing: 0 },
			{ botId: 'bot-c', botDeletedAt: null, botMissing: 1 },
		]);

		const result = await runBotRuntimeRetentionSweep(env, { now });

		expect(result).toMatchObject({ scanned: 3, pruned: 1, cleared: 2, failed: 0, complete: true });
		expect(env.requests).toContain('POST bot-a/retention');
		expect(env.requests).toContain('DELETE bot-b/storage');
		expect(env.requests).toContain('DELETE bot-c/storage');
		expect(env.requests).toContain(`mark:bot-b@${now}`);
		expect(env.requests).toContain(`mark:bot-c@${now}`);
		// A completed pass leaves no cursor, so the next one starts at the front.
		expect(env.kvValues.get(kvKeys.botRuntimeRetentionSweepCursor)).toBeUndefined();
	});

	it('stops at its wake-up budget, persists a keyset cursor, and resumes behind it', async () => {
		const rows = ['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5'].map(liveBot);
		const env = sweepEnv(rows);

		const first = await runBotRuntimeRetentionSweep(env, { now, maxBotsPerRun: 2, chunkSize: 2 });

		expect(first).toMatchObject({ scanned: 2, pruned: 2, complete: false });
		expect(env.requests).toEqual(['POST bot-1/retention', 'POST bot-2/retention']);
		expect(JSON.parse(String(env.kvValues.get(kvKeys.botRuntimeRetentionSweepCursor)))).toEqual({ afterBotId: 'bot-2' });

		env.requests.length = 0;
		const second = await runBotRuntimeRetentionSweep(env, { now, maxBotsPerRun: 2, chunkSize: 2 });

		expect(second).toMatchObject({ scanned: 2, complete: false });
		expect(env.requests).toEqual(['POST bot-3/retention', 'POST bot-4/retention']);

		env.requests.length = 0;
		const third = await runBotRuntimeRetentionSweep(env, { now, maxBotsPerRun: 2, chunkSize: 2 });

		expect(third).toMatchObject({ scanned: 1, complete: true });
		expect(env.requests).toEqual(['POST bot-5/retention']);
		expect(env.kvValues.get(kvKeys.botRuntimeRetentionSweepCursor)).toBeUndefined();
	});

	it('leaves a refused clear unmarked so the next pass retries it', async () => {
		const env = sweepEnv(
			[{ botId: 'bot-busy', botDeletedAt: '2026-07-01T00:00:00.000Z', botMissing: 0 }],
			{ fail: (_botId, path) => path === 'storage' },
		);

		const result = await runBotRuntimeRetentionSweep(env, { now });

		expect(result).toMatchObject({
			scanned: 1,
			cleared: 0,
			failed: 1,
			failures: [{
				kind: 'runtime_storage_clear',
				botId: 'bot-busy',
				status: 'failed',
				failure: { kind: 'http_response', httpStatus: 409 },
			}],
		});
		expect(env.requests).not.toContain(`mark:bot-busy@${now}`);
		expect(env.rows.map((row) => row.botId)).toEqual(['bot-busy']);
		// The id is carried rather than left to the next wrap of the whole fleet.
		expect(result.retryBacklog).toBe(1);
		expect(JSON.parse(String(env.kvValues.get(kvKeys.botRuntimeRetentionSweepCursor)))).toEqual({ retryBotIds: ['bot-busy'] });
	});

	it('retries a participant that failed in an earlier pass before resuming the walk', async () => {
		// The keyset walk selects strictly bot_id > cursor, so bot-1 is behind the
		// cursor from the moment its chunk is checkpointed. Only the retry backlog
		// can bring it back before the walk wraps the entire fleet.
		const rows: FleetRow[] = [
			{ botId: 'bot-1', botDeletedAt: '2026-07-01T00:00:00.000Z', botMissing: 0 },
			...['bot-2', 'bot-3', 'bot-4', 'bot-5'].map(liveBot),
		];
		let refuseClear = true;
		const env = sweepEnv(rows, { fail: (botId, path) => refuseClear && botId === 'bot-1' && path === 'storage' });

		const first = await runBotRuntimeRetentionSweep(env, { now, maxBotsPerRun: 2, chunkSize: 2 });

		expect(first).toMatchObject({ scanned: 2, pruned: 1, cleared: 0, failed: 1, retried: 0, retryBacklog: 1, complete: false });
		expect(env.requests).toEqual(['DELETE bot-1/storage', 'POST bot-2/retention']);
		expect(JSON.parse(String(env.kvValues.get(kvKeys.botRuntimeRetentionSweepCursor))))
			.toEqual({ afterBotId: 'bot-2', retryBotIds: ['bot-1'] });

		env.requests.length = 0;
		refuseClear = false;
		const second = await runBotRuntimeRetentionSweep(env, { now, maxBotsPerRun: 2, chunkSize: 2 });

		// The retry runs first and out of the same budget, so this pass reaches one
		// new participant rather than two — the walk is delayed, never skipped.
		expect(second).toMatchObject({ scanned: 2, pruned: 1, cleared: 1, failed: 0, retried: 1, retryBacklog: 0 });
		expect(env.requests).toEqual(['DELETE bot-1/storage', `mark:bot-1@${now}`, 'POST bot-3/retention']);
		expect(JSON.parse(String(env.kvValues.get(kvKeys.botRuntimeRetentionSweepCursor)))).toEqual({ afterBotId: 'bot-3' });

		env.requests.length = 0;
		const third = await runBotRuntimeRetentionSweep(env, { now, maxBotsPerRun: 2, chunkSize: 2 });

		expect(third).toMatchObject({ scanned: 2, retried: 0, failed: 0, complete: false });
		expect(env.requests).toEqual(['POST bot-4/retention', 'POST bot-5/retention']);
		expect(JSON.parse(String(env.kvValues.get(kvKeys.botRuntimeRetentionSweepCursor)))).toEqual({ afterBotId: 'bot-5' });

		env.requests.length = 0;
		const fourth = await runBotRuntimeRetentionSweep(env, { now, maxBotsPerRun: 2, chunkSize: 2 });

		expect(fourth).toMatchObject({ scanned: 0, complete: true });
		expect(env.requests).toEqual([]);
		expect(env.kvValues.get(kvKeys.botRuntimeRetentionSweepCursor)).toBeUndefined();
	});

	it('drops a backlog entry whose participant no longer needs the work', async () => {
		// The backlog carries ids, not rows, so a participant another path already
		// cleared and marked simply does not come back and costs no wake-up.
		const env = sweepEnv([liveBot('bot-live')], { cursor: 'bot-live' });
		env.kvValues.set(
			kvKeys.botRuntimeRetentionSweepCursor,
			JSON.stringify({ afterBotId: 'bot-live', retryBotIds: ['bot-gone'] }),
		);

		const result = await runBotRuntimeRetentionSweep(env, { now });

		expect(result).toMatchObject({ scanned: 0, retried: 0, failed: 0, retryBacklog: 0, complete: true });
		expect(env.requests).toEqual([]);
		expect(env.kvValues.get(kvKeys.botRuntimeRetentionSweepCursor)).toBeUndefined();
	});

	it('bounds the retry backlog it carries and counts what it dropped', async () => {
		const overflow = 20;
		const rows = Array.from(
			{ length: botRuntimeRetentionSweepMaxRetryBacklog + overflow },
			(_, index) => liveBot(`bot-${String(index).padStart(3, '0')}`),
		);
		const env = sweepEnv(rows, { fail: () => true });

		const result = await runBotRuntimeRetentionSweep(env, { now });

		expect(result).toMatchObject({
			failed: rows.length,
			retryBacklog: botRuntimeRetentionSweepMaxRetryBacklog,
			retriesDropped: overflow,
		});
		const cursor = JSON.parse(String(env.kvValues.get(kvKeys.botRuntimeRetentionSweepCursor))) as { retryBotIds: string[] };
		// Oldest failures are kept: the bound drops the newest so nothing starves.
		expect(cursor.retryBotIds).toEqual(rows.slice(0, botRuntimeRetentionSweepMaxRetryBacklog).map((row) => row.botId));
	});

	it('reports a failed prune without losing the rest of the chunk', async () => {
		const env = sweepEnv([liveBot('bot-ok'), liveBot('bot-sad')], { fail: (botId) => botId === 'bot-sad' });

		const result = await runBotRuntimeRetentionSweep(env, { now });

		expect(result).toMatchObject({ scanned: 2, pruned: 1, failed: 1 });
		expect(result.failures).toEqual([{
			kind: 'runtime_retention_prune',
			botId: 'bot-sad',
			status: 'failed',
			failure: { kind: 'http_response', httpStatus: 409 },
		}]);
	});

	it('counts every failure even when it reports detail for only the first few', async () => {
		const rows = Array.from({ length: 30 }, (_, index) => liveBot(`bot-${String(index).padStart(2, '0')}`));
		const env = sweepEnv(rows, { fail: () => true });

		const result = await runBotRuntimeRetentionSweep(env, { now });

		expect(result).toMatchObject({ scanned: 30, pruned: 0, failed: 30, failuresOmitted: 10 });
		expect(result.failures).toHaveLength(botRuntimeRetentionSweepReportedFailureLimit);
	});

	it('refuses a per-run budget above the configured cap', async () => {
		await expect(runBotRuntimeRetentionSweep(sweepEnv([]), { now, maxBotsPerRun: 10_000 }))
			.rejects.toThrow(/maxBotsPerRun/);
	});
});
