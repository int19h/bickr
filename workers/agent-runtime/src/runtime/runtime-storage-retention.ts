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
import { scheduledDispatchTimeoutMs } from '../constants';
import { RuntimeOperationTimeoutError } from '../errors';
import { withAbortableTimeout } from '../provider/sse';

/**
 * One D1 page of the keyset walk. Each participant in a chunk is woken
 * concurrently, so this is also the fan-out width.
 */
export const botRuntimeRetentionSweepChunkSize = 25;

/**
 * Durable Object wake-ups allowed per invocation. Each wake-up is one
 * subrequest, so a full run stays two orders of magnitude below the paid
 * per-invocation subrequest allowance; the persisted cursor carries the rest of
 * the fleet into the following days.
 */
export const botRuntimeRetentionSweepMaxBotsPerRun = 250;

type BotRuntimeNamespace<ObjectId> = {
	idFromName(name: string): ObjectId;
	get(id: ObjectId): { fetch(request: Request): Promise<Response> };
};

export type BotRuntimeRetentionSweepEnv<ObjectId> = {
	BICKR_D1: D1DatabaseLike;
	BICKR_KV: KVNamespaceLike;
	BOT_RUNTIME: BotRuntimeNamespace<ObjectId>;
	INTERNAL_SERVICE_SECRET?: string;
};

export type BotRuntimeStorageClearEnv<ObjectId> = Omit<BotRuntimeRetentionSweepEnv<ObjectId>, 'BICKR_KV'>;

type RuntimeMaintenanceFailure =
	| { kind: 'http_response'; httpStatus: number }
	| { kind: 'timeout'; timeoutMs: number }
	| { kind: 'dispatch_error'; errorName: string };

export type BotRuntimeMaintenanceDispatch =
	| { kind: 'runtime_retention_prune'; botId: string; status: 'pruned' }
	| { kind: 'runtime_retention_prune'; botId: string; status: 'failed'; failure: RuntimeMaintenanceFailure }
	| { kind: 'runtime_storage_clear'; botId: string; status: 'cleared' }
	| { kind: 'runtime_storage_clear'; botId: string; status: 'failed'; failure: RuntimeMaintenanceFailure };

/**
 * Failure detail is reported for at most this many participants per run; the
 * `failed` count and `failuresOmitted` still account for the rest, so a fleet-wide
 * outage cannot silently shrink to a handful of examples or blow up one log line.
 */
export const botRuntimeRetentionSweepReportedFailureLimit = 20;

export type BotRuntimeRetentionSweepResult = {
	kind: 'bot_runtime_retention_sweep';
	scanned: number;
	pruned: number;
	cleared: number;
	failed: number;
	/** The pass reached the end of bot_runtime_index and reset its cursor. */
	complete: boolean;
	failures: BotRuntimeMaintenanceDispatch[];
	failuresOmitted: number;
};

type BotRuntimeRetentionRow = {
	botId: string;
	botDeletedAt: string | null;
	botMissing: number;
};

type BotRuntimeRetentionSweepCursor = { afterBotId: string };

/**
 * Daily retention pass over the whole runtime fleet (design §2.4).
 *
 * Every `bot_runtime_index` row is eligible, including disabled ones: a paused
 * participant stops ticking but keeps its history, and a deleted participant
 * keeps the row after `disableBotRuntime`. Participants whose index row is gone
 * or tombstoned are full-clear targets — their loop history has no reader left —
 * and a confirmed clear stamps `runtime_storage_cleared_at` so the next pass
 * skips them instead of waking every participant ever deleted, forever.
 *
 * The walk is a real keyset cursor persisted in KV: a pass that runs out of
 * budget resumes at the participant after the last one it handled, and only a
 * pass that reaches the end clears the cursor.
 */
export async function runBotRuntimeRetentionSweep<ObjectId>(
	env: BotRuntimeRetentionSweepEnv<ObjectId>,
	options: { now?: string; maxBotsPerRun?: number; chunkSize?: number } = {},
): Promise<BotRuntimeRetentionSweepResult> {
	const now = options.now ?? new Date().toISOString();
	const maxBotsPerRun = boundedPositiveInteger(
		options.maxBotsPerRun ?? botRuntimeRetentionSweepMaxBotsPerRun,
		'maxBotsPerRun',
		botRuntimeRetentionSweepMaxBotsPerRun,
	);
	const chunkSize = boundedPositiveInteger(
		options.chunkSize ?? botRuntimeRetentionSweepChunkSize,
		'chunkSize',
		botRuntimeRetentionSweepChunkSize,
	);
	const storedCursor = await readSweepCursor(env.BICKR_KV);
	let pruned = 0;
	let cleared = 0;
	let failed = 0;
	const failures: BotRuntimeMaintenanceDispatch[] = [];
	const iteration = await runBoundedSweep<BotRuntimeRetentionRow, string>({
		chunkSize,
		maxItemsPerRun: maxBotsPerRun,
		...(storedCursor ? { initialCursor: storedCursor.afterBotId } : {}),
		loadChunk: (cursor, limit) => loadRuntimeIndexChunk(env.BICKR_D1, cursor, limit),
		processChunk: async (rows) => {
			const attempts = await Promise.all(rows.map((row) =>
				row.botDeletedAt === null && row.botMissing === 0
					? pruneBotRuntimeStorage(env, row.botId)
					: clearBotRuntimeStorage(env, row.botId, { now }),
			));
			for (const attempt of attempts) {
				if (attempt.status === 'failed') {
					failed += 1;
					if (failures.length < botRuntimeRetentionSweepReportedFailureLimit) {
						failures.push(attempt);
					}
					continue;
				}
				if (attempt.status === 'cleared') {
					cleared += 1;
				} else {
					pruned += 1;
				}
			}
			return { kind: 'continue' };
		},
		checkpoint: (afterBotId) => writeJson(
			env.BICKR_KV,
			kvKeys.botRuntimeRetentionSweepCursor,
			{ afterBotId } satisfies BotRuntimeRetentionSweepCursor,
		),
		complete: () => deleteKey(env.BICKR_KV, kvKeys.botRuntimeRetentionSweepCursor),
	});
	return {
		kind: 'bot_runtime_retention_sweep',
		scanned: iteration.scanned,
		pruned,
		cleared,
		failed,
		complete: !iteration.budgetExhausted,
		failures,
		failuresOmitted: failed - failures.length,
	};
}

/** Run one participant's retention pass inside its own Durable Object. */
export async function pruneBotRuntimeStorage<ObjectId>(
	env: Pick<BotRuntimeRetentionSweepEnv<ObjectId>, 'BOT_RUNTIME' | 'INTERNAL_SERVICE_SECRET'>,
	botId: string,
): Promise<BotRuntimeMaintenanceDispatch> {
	const failure = await dispatchRuntimeMaintenance(env, botId, 'POST', 'retention');
	return failure === null
		? { kind: 'runtime_retention_prune', botId, status: 'pruned' }
		: { kind: 'runtime_retention_prune', botId, status: 'failed', failure };
}

/**
 * Erase a participant's whole runtime storage and record that it happened.
 *
 * The marker is written only after the object confirms the clear, so a failed
 * or refused clear is retried by the next pass rather than remembered as done.
 * Used by both the bot-delete lifecycle and the sweep's backlog of participants
 * deleted before that step existed.
 */
export async function clearBotRuntimeStorage<ObjectId>(
	env: BotRuntimeStorageClearEnv<ObjectId>,
	botId: string,
	options: { now?: string } = {},
): Promise<BotRuntimeMaintenanceDispatch> {
	const failure = await dispatchRuntimeMaintenance(env, botId, 'DELETE', 'storage');
	if (failure !== null) {
		return { kind: 'runtime_storage_clear', botId, status: 'failed', failure };
	}
	const clearedAt = options.now ?? new Date().toISOString();
	await env.BICKR_D1
		.prepare(
			`UPDATE bot_runtime_index
			 SET runtime_storage_cleared_at = ?, updated_at = ?
			 WHERE bot_id = ?
			   AND runtime_storage_cleared_at IS NULL`,
		)
		.bind(clearedAt, clearedAt, botId)
		.run();
	return { kind: 'runtime_storage_clear', botId, status: 'cleared' };
}

async function dispatchRuntimeMaintenance<ObjectId>(
	env: Pick<BotRuntimeRetentionSweepEnv<ObjectId>, 'BOT_RUNTIME' | 'INTERNAL_SERVICE_SECRET'>,
	botId: string,
	method: 'POST' | 'DELETE',
	path: 'retention' | 'storage',
): Promise<RuntimeMaintenanceFailure | null> {
	// A fresh bodyless internal request, never a forwarded one: nothing from an
	// operator's or owner's request belongs on a fleet maintenance call.
	const headers = new Headers();
	headers.set('x-bickr-scheduler', '1');
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	const objectId = env.BOT_RUNTIME.idFromName(botId);
	try {
		const parentSignal = new AbortController().signal;
		const response = await withAbortableTimeout(
			parentSignal,
			scheduledDispatchTimeoutMs,
			() => new RuntimeOperationTimeoutError('Runtime storage maintenance dispatch', scheduledDispatchTimeoutMs),
			(signal) => env.BOT_RUNTIME.get(objectId).fetch(new Request(
				internalServiceUrl(`/bots/${encodeURIComponent(botId)}/${path}`),
				{ method, headers, signal },
			)),
		);
		return response.ok ? null : { kind: 'http_response', httpStatus: response.status };
	} catch (error) {
		return error instanceof RuntimeOperationTimeoutError
			? { kind: 'timeout', timeoutMs: error.timeoutMs }
			: { kind: 'dispatch_error', errorName: error instanceof Error ? error.name : 'UnknownError' };
	}
}

async function loadRuntimeIndexChunk(
	db: D1DatabaseLike,
	cursor: string | undefined,
	limit: number,
) {
	// A runtime row with no bots_index row at all is orphaned runtime state, which
	// has the same disposition as a tombstoned participant: nothing can read it.
	const selection = `SELECT runtime.bot_id AS botId,
			bots.deleted_at AS botDeletedAt,
			CASE WHEN bots.bot_id IS NULL THEN 1 ELSE 0 END AS botMissing
		 FROM bot_runtime_index runtime
		 LEFT JOIN bots_index bots ON bots.bot_id = runtime.bot_id
		 WHERE runtime.runtime_storage_cleared_at IS NULL`;
	const statement = cursor
		? db.prepare(`${selection} AND runtime.bot_id > ? ORDER BY runtime.bot_id ASC LIMIT ?`).bind(cursor, limit)
		: db.prepare(`${selection} ORDER BY runtime.bot_id ASC LIMIT ?`).bind(limit);
	const result = await statement.all<BotRuntimeRetentionRow>();
	const items = result.results ?? [];
	const nextCursor = items.at(-1)?.botId;
	return {
		items,
		done: items.length < limit,
		...(nextCursor ? { nextCursor } : {}),
	};
}

async function readSweepCursor(kv: KVNamespaceLike): Promise<BotRuntimeRetentionSweepCursor | null> {
	const value = await readJson<unknown>(kv, kvKeys.botRuntimeRetentionSweepCursor);
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const afterBotId = (value as Record<string, unknown>).afterBotId;
	return typeof afterBotId === 'string' && afterBotId.length > 0 ? { afterBotId } : null;
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
	if (!Number.isInteger(value) || value <= 0 || value > maximum) {
		throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
	}
	return value;
}
