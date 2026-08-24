import { addInternalServiceAuthHeader, internalServiceUrl } from '@bickr/shared/internal-service';
import {
	deleteKey,
	kvKeys,
	readJson,
	writeJson,
	type D1DatabaseLike,
	type KVNamespaceLike,
} from '@bickr/shared/storage';
import { runBoundedSweep } from '@bickr/shared/sweep';
import { RuntimeOperationTimeoutError } from '../errors';
import { withAbortableTimeout } from '../provider/sse';

/** One D1 page and one concurrent Durable Object fan-out group. */
export const staleRunRecoveryChunkSize = 10;
/**
 * Recovery wake-ups reserved inside one frequent-cron invocation. Together
 * with the 2,000 visit-dispatch budget this remains far below the Workers paid
 * plan's 10,000-subrequest allowance, leaving headroom for the other bounded
 * frequent tasks and D1/KV operations.
 */
export const staleRunRecoveryMaxBotsPerRun = 100;
export const staleRunRecoveryDispatchTimeoutMs = 10_000;
export const staleRunRecoveryMaxRetryBacklog = 100;
export const staleRunRecoveryReportedFailureLimit = 20;

type BotRuntimeNamespace<ObjectId> = {
	idFromName(name: string): ObjectId;
	get(id: ObjectId): { fetch(request: Request): Promise<Response> };
};

export type StaleRunRecoveryEnv<ObjectId> = {
	BICKR_D1: D1DatabaseLike;
	BICKR_KV: KVNamespaceLike;
	BOT_RUNTIME: BotRuntimeNamespace<ObjectId>;
	INTERNAL_SERVICE_SECRET?: string;
};

export type RuntimeStaleRunRecoveryResult =
	| { kind: 'not_running'; botId: string }
	| { kind: 'current'; botId: string; runId: string | null; leaseExpiresAt: string | null }
	| { kind: 'reaped'; botId: string; runId: string | null }
	| { kind: 'released_storage_cleared'; botId: string; runId: string | null };

type StaleRunRecoveryFailure =
	| { kind: 'http_response'; httpStatus: number }
	| { kind: 'invalid_response' }
	| { kind: 'timeout'; timeoutMs: number }
	| { kind: 'dispatch_error'; errorName: string };

export type StaleRunRecoveryAttempt =
	| { kind: 'runtime_stale_run_recovery'; botId: string; status: 'completed'; result: RuntimeStaleRunRecoveryResult }
	| { kind: 'runtime_stale_run_recovery'; botId: string; status: 'failed'; failure: StaleRunRecoveryFailure };

export type StaleRunRecoverySweepResult = {
	kind: 'stale_run_recovery_sweep';
	selected: number;
	scanned: number;
	reaped: number;
	current: number;
	notRunning: number;
	releasedStorageCleared: number;
	skippedNonLive: number;
	failed: number;
	retried: number;
	retryBacklog: number;
	retriesDropped: number;
	budgetExhausted: boolean;
	failures: StaleRunRecoveryAttempt[];
	failuresOmitted: number;
};

type StaleRunRow = {
	botId: string;
	status: string;
	leaseExpiresAt: string | null;
	botDeletedAt: string | null;
	botLifecycleState: string | null;
	botMissing: number;
};

type StaleRunRecoveryCursor = {
	afterBotId?: string;
	retryBotIds?: string[];
};

export async function runStaleRunRecoverySweep<ObjectId>(
	env: StaleRunRecoveryEnv<ObjectId>,
	options: { now?: string; maxBotsPerRun?: number; chunkSize?: number } = {},
): Promise<StaleRunRecoverySweepResult> {
	const now = options.now ?? new Date().toISOString();
	const maxBotsPerRun = boundedPositiveInteger(
		options.maxBotsPerRun ?? staleRunRecoveryMaxBotsPerRun,
		'maxBotsPerRun',
		staleRunRecoveryMaxBotsPerRun,
	);
	const chunkSize = boundedPositiveInteger(
		options.chunkSize ?? staleRunRecoveryChunkSize,
		'chunkSize',
		staleRunRecoveryChunkSize,
	);
	const storedCursor = await readSweepCursor(env.BICKR_KV);
	let walkCursor = storedCursor?.afterBotId;
	let walkComplete = false;
	let selected = 0;
	let reaped = 0;
	let current = 0;
	let notRunning = 0;
	let releasedStorageCleared = 0;
	let skippedNonLive = 0;
	let failed = 0;
	let retriesDropped = 0;
	const failures: StaleRunRecoveryAttempt[] = [];
	const pendingRetries: string[] = [];

	const persistCursor = async (): Promise<void> => {
		const cursor: StaleRunRecoveryCursor = {
			...(walkComplete || !walkCursor ? {} : { afterBotId: walkCursor }),
			...(pendingRetries.length > 0 ? { retryBotIds: [...pendingRetries] } : {}),
		};
		if (cursor.afterBotId === undefined && cursor.retryBotIds === undefined) {
			await deleteKey(env.BICKR_KV, kvKeys.botRuntimeStaleRunRecoveryCursor);
			return;
		}
		await writeJson(env.BICKR_KV, kvKeys.botRuntimeStaleRunRecoveryCursor, cursor);
	};

	const recordAttempt = (attempt: StaleRunRecoveryAttempt): void => {
		if (attempt.status === 'failed') {
			failed += 1;
			if (failures.length < staleRunRecoveryReportedFailureLimit) {
				failures.push(attempt);
			}
			if (!pendingRetries.includes(attempt.botId)) {
				if (pendingRetries.length < staleRunRecoveryMaxRetryBacklog) {
					pendingRetries.push(attempt.botId);
				} else {
					retriesDropped += 1;
				}
			}
			return;
		}
		switch (attempt.result.kind) {
			case 'reaped':
				reaped += 1;
				return;
			case 'current':
				current += 1;
				return;
			case 'not_running':
				notRunning += 1;
				return;
			case 'released_storage_cleared':
				releasedStorageCleared += 1;
				return;
		}
	};

	const dispatchRows = async (rows: readonly StaleRunRow[]): Promise<void> => {
		selected += rows.length;
		const liveRows: StaleRunRow[] = [];
		for (const row of rows) {
			if (row.botMissing === 1 || row.botDeletedAt !== null || row.botLifecycleState !== 'active') {
				skippedNonLive += 1;
				continue;
			}
			liveRows.push(row);
		}
		const attempts = await Promise.all(liveRows.map((row) => dispatchRecovery(env, row.botId)));
		for (const attempt of attempts) {
			recordAttempt(attempt);
		}
	};

	let retried = 0;
	// Always reserve one slot for the stable keyset walk. Otherwise a full
	// permanently failing retry backlog could consume every invocation forever
	// and starve stale rows that sort after it.
	const maxRetriesPerRun = Math.max(0, maxBotsPerRun - 1);
	const storedRetryBotIds = storedCursor?.retryBotIds ?? [];
	let retryIndex = 0;
	while (retryIndex < storedRetryBotIds.length && retried < maxRetriesPerRun) {
		const retryChunk = storedRetryBotIds.slice(
			retryIndex,
			Math.min(storedRetryBotIds.length, retryIndex + chunkSize, retryIndex + maxRetriesPerRun - retried),
		);
		retryIndex += retryChunk.length;
		retried += retryChunk.length;
		const rows = await loadRowsById(env.BICKR_D1, retryChunk);
		await dispatchRows(rows);
	}
	for (const botId of storedRetryBotIds.slice(retryIndex)) {
		if (pendingRetries.length < staleRunRecoveryMaxRetryBacklog && !pendingRetries.includes(botId)) {
			pendingRetries.push(botId);
		} else if (!pendingRetries.includes(botId)) {
			retriesDropped += 1;
		}
	}

	const iteration = await runBoundedSweep<StaleRunRow, string>({
		chunkSize,
		maxItemsPerRun: Math.max(0, maxBotsPerRun - retried),
		...(walkCursor ? { initialCursor: walkCursor } : {}),
		loadChunk: (cursor, limit) => loadStaleRunChunk(env.BICKR_D1, now, cursor, limit),
		processChunk: async (rows) => {
			await dispatchRows(rows);
			return { kind: 'continue' };
		},
		checkpoint: async (afterBotId) => {
			walkCursor = afterBotId;
			await persistCursor();
		},
		complete: async () => {
			walkComplete = true;
			await persistCursor();
		},
	});
	await persistCursor();

	return {
		kind: 'stale_run_recovery_sweep',
		selected,
		scanned: retried + iteration.scanned,
		reaped,
		current,
		notRunning,
		releasedStorageCleared,
		skippedNonLive,
		failed,
		retried,
		retryBacklog: pendingRetries.length,
		retriesDropped,
		budgetExhausted: !walkComplete,
		failures,
		failuresOmitted: failed - failures.length,
	};
}

async function dispatchRecovery<ObjectId>(
	env: StaleRunRecoveryEnv<ObjectId>,
	botId: string,
): Promise<StaleRunRecoveryAttempt> {
	const headers = new Headers({ 'x-bickr-scheduler': '1' });
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	try {
		const response = await withAbortableTimeout(
			new AbortController().signal,
			staleRunRecoveryDispatchTimeoutMs,
			() => new RuntimeOperationTimeoutError('Stale Bickr visit recovery dispatch', staleRunRecoveryDispatchTimeoutMs),
			(signal) => env.BOT_RUNTIME.get(env.BOT_RUNTIME.idFromName(botId)).fetch(new Request(
				internalServiceUrl(`/bots/${encodeURIComponent(botId)}/recover-stale-run`),
				{ method: 'POST', headers, signal },
			)),
		);
		if (!response.ok) {
			return { kind: 'runtime_stale_run_recovery', botId, status: 'failed', failure: { kind: 'http_response', httpStatus: response.status } };
		}
		const result = recoveryResultFromUnknown(await response.json(), botId);
		return result
			? { kind: 'runtime_stale_run_recovery', botId, status: 'completed', result }
			: { kind: 'runtime_stale_run_recovery', botId, status: 'failed', failure: { kind: 'invalid_response' } };
	} catch (error) {
		return {
			kind: 'runtime_stale_run_recovery',
			botId,
			status: 'failed',
			failure: error instanceof RuntimeOperationTimeoutError
				? { kind: 'timeout', timeoutMs: error.timeoutMs }
				: { kind: 'dispatch_error', errorName: error instanceof Error ? error.name : 'UnknownError' },
		};
	}
}

function recoveryResultFromUnknown(value: unknown, botId: string): RuntimeStaleRunRecoveryResult | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const data = (value as { data?: unknown }).data;
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		return null;
	}
	const recovery = (data as { recovery?: unknown }).recovery;
	if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) {
		return null;
	}
	const record = recovery as Record<string, unknown>;
	if (record.botId !== botId || typeof record.kind !== 'string') {
		return null;
	}
	const runId = typeof record.runId === 'string' ? record.runId : record.runId === null ? null : undefined;
	if (record.kind === 'not_running') {
		return { kind: 'not_running', botId };
	}
	if (record.kind === 'current' && runId !== undefined) {
		const leaseExpiresAt = typeof record.leaseExpiresAt === 'string' ? record.leaseExpiresAt : record.leaseExpiresAt === null ? null : undefined;
		return leaseExpiresAt === undefined ? null : { kind: 'current', botId, runId, leaseExpiresAt };
	}
	if ((record.kind === 'reaped' || record.kind === 'released_storage_cleared') && runId !== undefined) {
		return record.kind === 'reaped'
			? { kind: 'reaped', botId, runId }
			: { kind: 'released_storage_cleared', botId, runId };
	}
	return null;
}

const runtimeRowSelection = `SELECT runtime.bot_id AS botId,
		runtime.status,
		runtime.lease_expires_at AS leaseExpiresAt,
		bots.deleted_at AS botDeletedAt,
		bots.lifecycle_state AS botLifecycleState,
		CASE WHEN bots.bot_id IS NULL THEN 1 ELSE 0 END AS botMissing
	 FROM bot_runtime_index runtime
	 LEFT JOIN bots_index bots ON bots.bot_id = runtime.bot_id`;

async function loadStaleRunChunk(
	db: D1DatabaseLike,
	now: string,
	cursor: string | undefined,
	limit: number,
) {
	const predicate = `WHERE runtime.status = 'running'
	   AND (runtime.lease_expires_at IS NULL OR runtime.lease_expires_at <= ?)`;
	const statement = cursor
		? db.prepare(`${runtimeRowSelection} ${predicate} AND runtime.bot_id > ? ORDER BY runtime.bot_id ASC LIMIT ?`).bind(now, cursor, limit)
		: db.prepare(`${runtimeRowSelection} ${predicate} ORDER BY runtime.bot_id ASC LIMIT ?`).bind(now, limit);
	const result = await statement.all<StaleRunRow>();
	const items = result.results ?? [];
	const nextCursor = items.at(-1)?.botId;
	return { items, done: items.length < limit, ...(nextCursor ? { nextCursor } : {}) };
}

async function loadRowsById(db: D1DatabaseLike, botIds: readonly string[]): Promise<StaleRunRow[]> {
	if (botIds.length === 0) {
		return [];
	}
	const result = await db
		.prepare(`${runtimeRowSelection} WHERE runtime.bot_id IN (${botIds.map(() => '?').join(', ')}) ORDER BY runtime.bot_id ASC`)
		.bind(...botIds)
		.all<StaleRunRow>();
	return result.results ?? [];
}

async function readSweepCursor(kv: KVNamespaceLike): Promise<StaleRunRecoveryCursor | null> {
	const value = await readJson<unknown>(kv, kvKeys.botRuntimeStaleRunRecoveryCursor);
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const retryBotIds = [...new Set(
		(Array.isArray(record.retryBotIds) ? record.retryBotIds : [])
			.filter((botId): botId is string => typeof botId === 'string' && botId.length > 0),
	)].slice(0, staleRunRecoveryMaxRetryBacklog);
	const cursor: StaleRunRecoveryCursor = {
		...(typeof record.afterBotId === 'string' && record.afterBotId.length > 0 ? { afterBotId: record.afterBotId } : {}),
		...(retryBotIds.length > 0 ? { retryBotIds } : {}),
	};
	return cursor.afterBotId === undefined && cursor.retryBotIds === undefined ? null : cursor;
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
	if (!Number.isInteger(value) || value <= 0 || value > maximum) {
		throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
	}
	return value;
}
