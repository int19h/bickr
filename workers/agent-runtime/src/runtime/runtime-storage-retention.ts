import { addInternalServiceAuthHeader, internalServiceUrl } from '@bickr/shared/internal-service';
import {
	chunks,
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

/**
 * Participants the retry backlog carries between runs.
 *
 * The chunks select strictly `bot_id > cursor`, so a participant that failed
 * once is otherwise not seen again until the walk wraps the whole fleet — a
 * clear refused with 409 because a visit was running would sit unreclaimed for
 * a full cycle. The backlog is what makes the next run retry it instead. It is
 * bounded because a fleet-wide outage would otherwise persist every failure of
 * every run: past this many, the excess is dropped and counted, and those
 * participants fall back to the wrap-around they had before.
 */
export const botRuntimeRetentionSweepMaxRetryBacklog = 100;

export type BotRuntimeRetentionSweepResult = {
	kind: 'bot_runtime_retention_sweep';
	scanned: number;
	pruned: number;
	cleared: number;
	failed: number;
	/** The pass reached the end of bot_runtime_index. */
	complete: boolean;
	/** Participants revisited out of a previous run's retry backlog. */
	retried: number;
	/** Failures this run handed to the next one's retry backlog. */
	retryBacklog: number;
	/** Failures the bounded backlog could not carry. */
	retriesDropped: number;
	failures: BotRuntimeMaintenanceDispatch[];
	failuresOmitted: number;
};

type BotRuntimeRetentionRow = {
	botId: string;
	botDeletedAt: string | null;
	botMissing: number;
};

type BotRuntimeRetentionSweepCursor = {
	/** Keyset position in `bot_runtime_index`; absent once the walk has wrapped. */
	afterBotId?: string;
	/**
	 * Participants an earlier run dispatched to and could not confirm. The next
	 * run revisits these before resuming the walk, because the walk itself has
	 * already moved past them.
	 */
	retryBotIds?: string[];
};

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
 *
 * A participant the object refused or that timed out is not left to the
 * wrap-around, because the walk only ever moves forward: its id rides the same
 * cursor as a bounded retry backlog, which the next run spends before resuming
 * the walk and out of the same wake-up budget.
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
	let retriesDropped = 0;
	const failures: BotRuntimeMaintenanceDispatch[] = [];
	// Ordered and deduplicated: a participant that fails in both the retry pass
	// and the walk of the same run is one entry, and the oldest failures stay at
	// the front so the bound drops the newest rather than starving the oldest.
	const pendingRetries: string[] = [];
	let walkCursor = storedCursor?.afterBotId;
	// Only `complete` sets this. A run whose budget the retry pass consumed
	// entirely never walks at all, and must not be mistaken for one that reached
	// the end of the fleet and may drop its position.
	let walkComplete = false;

	const persistCursor = async (): Promise<void> => {
		const cursor: BotRuntimeRetentionSweepCursor = {
			...(walkComplete || !walkCursor ? {} : { afterBotId: walkCursor }),
			...(pendingRetries.length > 0 ? { retryBotIds: [...pendingRetries] } : {}),
		};
		if (cursor.afterBotId === undefined && cursor.retryBotIds === undefined) {
			await deleteKey(env.BICKR_KV, kvKeys.botRuntimeRetentionSweepCursor);
			return;
		}
		await writeJson(env.BICKR_KV, kvKeys.botRuntimeRetentionSweepCursor, cursor);
	};

	const recordAttempts = (attempts: readonly BotRuntimeMaintenanceDispatch[]): void => {
		for (const attempt of attempts) {
			if (attempt.status === 'failed') {
				failed += 1;
				if (failures.length < botRuntimeRetentionSweepReportedFailureLimit) {
					failures.push(attempt);
				}
				if (pendingRetries.includes(attempt.botId)) {
					continue;
				}
				if (pendingRetries.length >= botRuntimeRetentionSweepMaxRetryBacklog) {
					retriesDropped += 1;
					continue;
				}
				pendingRetries.push(attempt.botId);
				continue;
			}
			if (attempt.status === 'cleared') {
				cleared += 1;
			} else {
				pruned += 1;
			}
		}
	};

	const dispatchRows = async (rows: readonly BotRuntimeRetentionRow[]): Promise<void> => {
		recordAttempts(await Promise.all(rows.map((row) =>
			row.botDeletedAt === null && row.botMissing === 0
				? pruneBotRuntimeStorage(env, row.botId)
				: clearBotRuntimeStorage(env, row.botId, { now }),
		)));
	};

	// The retry backlog runs first and out of the same budget, so revisiting
	// failures can never push a run past its wake-up allowance — it only shifts
	// how much of the walk this run gets to.
	let retried = 0;
	for (const chunk of chunks(storedCursor?.retryBotIds ?? [], chunkSize)) {
		if (retried >= maxBotsPerRun) {
			break;
		}
		// A participant whose marker was set in the meantime, or whose index row is
		// gone, drops out of the backlog here rather than costing a wake-up.
		const rows = (await loadRuntimeIndexRows(env.BICKR_D1, chunk)).slice(0, maxBotsPerRun - retried);
		retried += rows.length;
		await dispatchRows(rows);
	}

	const iteration = await runBoundedSweep<BotRuntimeRetentionRow, string>({
		chunkSize,
		maxItemsPerRun: Math.max(0, maxBotsPerRun - retried),
		...(walkCursor ? { initialCursor: walkCursor } : {}),
		loadChunk: (cursor, limit) => loadRuntimeIndexChunk(env.BICKR_D1, cursor, limit),
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
	// The walk's own checkpoints cannot cover a run that never entered the loop
	// because the retry pass spent its budget, nor failures recorded after the
	// last checkpoint. One reconciling write closes both.
	await persistCursor();

	return {
		kind: 'bot_runtime_retention_sweep',
		scanned: retried + iteration.scanned,
		pruned,
		cleared,
		failed,
		complete: walkComplete,
		retried,
		retryBacklog: pendingRetries.length,
		retriesDropped,
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

/**
 * The retry backlog's participants, as the walk would have loaded them.
 *
 * Ids whose row has since been marked cleared, or whose row is gone, simply do
 * not come back: the backlog is a list of ids rather than a snapshot of rows,
 * so their disposition is re-decided here against current state.
 */
async function loadRuntimeIndexRows(db: D1DatabaseLike, botIds: readonly string[]): Promise<BotRuntimeRetentionRow[]> {
	if (botIds.length === 0) {
		return [];
	}
	const result = await db
		.prepare(`${runtimeIndexSelection} AND runtime.bot_id IN (${botIds.map(() => '?').join(', ')}) ORDER BY runtime.bot_id ASC`)
		.bind(...botIds)
		.all<BotRuntimeRetentionRow>();
	return result.results ?? [];
}

// A runtime row with no bots_index row at all is orphaned runtime state, which
// has the same disposition as a tombstoned participant: nothing can read it.
const runtimeIndexSelection = `SELECT runtime.bot_id AS botId,
		bots.deleted_at AS botDeletedAt,
		CASE WHEN bots.bot_id IS NULL THEN 1 ELSE 0 END AS botMissing
	 FROM bot_runtime_index runtime
	 LEFT JOIN bots_index bots ON bots.bot_id = runtime.bot_id
	 WHERE runtime.runtime_storage_cleared_at IS NULL`;

async function loadRuntimeIndexChunk(
	db: D1DatabaseLike,
	cursor: string | undefined,
	limit: number,
) {
	const selection = runtimeIndexSelection;
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
	const record = value as Record<string, unknown>;
	const afterBotId = record.afterBotId;
	const retryBotIds = [
		...new Set(
			(Array.isArray(record.retryBotIds) ? record.retryBotIds : [])
				.filter((botId): botId is string => typeof botId === 'string' && botId.length > 0),
		),
	].slice(0, botRuntimeRetentionSweepMaxRetryBacklog);
	const cursor: BotRuntimeRetentionSweepCursor = {
		...(typeof afterBotId === 'string' && afterBotId.length > 0 ? { afterBotId } : {}),
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
