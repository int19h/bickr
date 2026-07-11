import { runBoundedSweep } from "./sweep";
import {
	deleteKey,
	type D1DatabaseLike,
	kvKeys,
	type KVNamespaceLike,
	readJson,
	writeJson,
} from "./storage";

export const governanceDeletionSweepChunkSize = 25;
export const governanceDeletionSweepMaxRowsPerRun = 100;

export type ForumThreadDeletionRequest = {
	deletedAt: string;
	forumId: string;
	threadId: string;
};

export type WorldForumDeletionRequest = {
	deletedAt: string;
	forumId: string;
	worldId: string;
};

export type GovernanceDeletionSweepResult = {
	done: boolean;
	processed: number;
};

type DeletionSweepCursor = {
	afterId: string;
};

type IdRow = {
	id: string;
};

export async function runForumThreadDeletionSweep(
	env: {
		BICKR_D1: D1DatabaseLike;
		BICKR_KV: KVNamespaceLike;
		deleteThread: (request: ForumThreadDeletionRequest) => Promise<void>;
	},
	input: { deletedAt: string; forumId: string },
	options: { maxRowsPerRun?: number } = {},
): Promise<GovernanceDeletionSweepResult> {
	const cursorKey = kvKeys.forumThreadDeletionSweepCursor(input.forumId);
	const cursor = await readDeletionSweepCursor(env.BICKR_KV, cursorKey);
	const result = await runBoundedSweep<IdRow, string>({
		chunkSize: governanceDeletionSweepChunkSize,
		maxItemsPerRun: boundedRows(options.maxRowsPerRun),
		...(cursor ? { initialCursor: cursor.afterId } : {}),
		loadChunk: (afterId, limit) => loadThreadChunk(env.BICKR_D1, input.forumId, afterId, limit),
		processChunk: async (rows) => {
			for (const row of rows) {
				await env.deleteThread({
					deletedAt: input.deletedAt,
					forumId: input.forumId,
					threadId: row.id,
				});
			}
			return { kind: "continue" };
		},
		checkpoint: (afterId) => writeJson(env.BICKR_KV, cursorKey, { afterId } satisfies DeletionSweepCursor),
		complete: () => deleteKey(env.BICKR_KV, cursorKey),
	});
	return { done: !result.budgetExhausted, processed: result.scanned };
}

export async function runWorldForumDeletionSweep(
	env: {
		BICKR_D1: D1DatabaseLike;
		BICKR_KV: KVNamespaceLike;
		deleteForum: (request: WorldForumDeletionRequest) => Promise<void>;
	},
	input: { deletedAt: string; worldId: string },
	options: { maxRowsPerRun?: number } = {},
): Promise<GovernanceDeletionSweepResult> {
	const cursorKey = kvKeys.worldForumDeletionSweepCursor(input.worldId);
	const cursor = await readDeletionSweepCursor(env.BICKR_KV, cursorKey);
	const result = await runBoundedSweep<IdRow, string>({
		chunkSize: governanceDeletionSweepChunkSize,
		maxItemsPerRun: boundedRows(options.maxRowsPerRun),
		...(cursor ? { initialCursor: cursor.afterId } : {}),
		loadChunk: (afterId, limit) => loadForumChunk(env.BICKR_D1, input.worldId, afterId, limit),
		processChunk: async (rows) => {
			for (const row of rows) {
				await env.deleteForum({
					deletedAt: input.deletedAt,
					forumId: row.id,
					worldId: input.worldId,
				});
			}
			return { kind: "continue" };
		},
		checkpoint: (afterId) => writeJson(env.BICKR_KV, cursorKey, { afterId } satisfies DeletionSweepCursor),
		complete: () => deleteKey(env.BICKR_KV, cursorKey),
	});
	return { done: !result.budgetExhausted, processed: result.scanned };
}

async function loadThreadChunk(
	db: D1DatabaseLike,
	forumId: string,
	afterId: string | undefined,
	limit: number,
) {
	const statement = afterId ?
		db.prepare(
			`SELECT thread_id AS id
			 FROM threads_index
			 WHERE forum_id = ? AND thread_id > ?
			 ORDER BY thread_id ASC
			 LIMIT ?`,
		).bind(forumId, afterId, limit)
	:	db.prepare(
			`SELECT thread_id AS id
			 FROM threads_index
			 WHERE forum_id = ?
			 ORDER BY thread_id ASC
			 LIMIT ?`,
		).bind(forumId, limit);
	const rows = await statement.all<IdRow>();
	const items = rows.results ?? [];
	return {
		items,
		done: items.length < limit,
		...(items.length === limit ? { nextCursor: items[items.length - 1]?.id } : {}),
	};
}

async function loadForumChunk(
	db: D1DatabaseLike,
	worldId: string,
	afterId: string | undefined,
	limit: number,
) {
	const statement = afterId ?
		db.prepare(
			`SELECT forum_id AS id
			 FROM forums_index
			 WHERE world_id = ? AND deleted_at IS NULL AND forum_id > ?
			 ORDER BY forum_id ASC
			 LIMIT ?`,
		).bind(worldId, afterId, limit)
	:	db.prepare(
			`SELECT forum_id AS id
			 FROM forums_index
			 WHERE world_id = ? AND deleted_at IS NULL
			 ORDER BY forum_id ASC
			 LIMIT ?`,
		).bind(worldId, limit);
	const rows = await statement.all<IdRow>();
	const items = rows.results ?? [];
	return {
		items,
		done: items.length < limit,
		...(items.length === limit ? { nextCursor: items[items.length - 1]?.id } : {}),
	};
}

async function readDeletionSweepCursor(
	kv: KVNamespaceLike,
	key: string,
): Promise<DeletionSweepCursor | null> {
	const value = await readJson<DeletionSweepCursor>(kv, key);
	if (!value) {
		return null;
	}
	if (typeof value.afterId !== "string" || !value.afterId) {
		throw new Error(`Invalid governance deletion cursor at ${key}.`);
	}
	return value;
}

function boundedRows(value = governanceDeletionSweepMaxRowsPerRun): number {
	if (!Number.isInteger(value) || value <= 0 || value > governanceDeletionSweepMaxRowsPerRun) {
		throw new Error(`maxRowsPerRun must be between 1 and ${governanceDeletionSweepMaxRowsPerRun}.`);
	}
	return value;
}
