import { entityIndexVersions, type IndexedEntityType } from "./index-versions";
import {
	type BotDocument,
	type ForumDocument,
	type ThreadDocument,
	type UserDocument,
	type WorldDocument,
} from "./model";
import {
	upsertBotIndexProjection,
	upsertForumIndexProjection,
	upsertUserIndexProjection,
	upsertWorldIndexProjection,
} from "./repository";
import {
	deleteSearchVector,
	type SearchVectorEnv,
	upsertBotSearchVector,
	upsertForumSearchVector,
	upsertWorldSearchVector,
} from "./search";
import { upsertThreadIndexProjection } from "./social";
import {
	deleteKey,
	type D1DatabaseLike,
	kvKeys,
	type KVNamespaceLike,
	putObjectIndex,
	readJson,
	writeJson,
} from "./storage";
import { runBoundedSweep } from "./sweep";

// The notification prune can consume about 8.1k of the shared 10k-subrequest
// budget. This sweep's healthy path is about 540 subrequests (500 KV reads plus
// 20 D1 selects and cursor checkpoints); at most 150 repairs at an estimated
// worst case of 8 subrequests each keeps the combined total around 9.84k.
export const objectIndexRepairChunkSize = 25;
export const objectIndexRepairMaxRowsPerRun = 500;
export const objectIndexRepairMaxRepairsPerRun = 150;

export type ObjectIndexRepairResult = {
	scanned: number;
	repaired: number;
	budgetExhausted: boolean;
};

export type ObjectIndexRepairEnv = SearchVectorEnv & {
	BICKR_D1: D1DatabaseLike;
	BICKR_KV: KVNamespaceLike;
};

type ObjectIndexRow = {
	objectId: string;
	objectType: string;
	revision: number;
	indexVersion: number;
};

type ObjectIndexRepairCursor = {
	afterObjectId: string;
};

type IndexedDocument = BotDocument | ForumDocument | ThreadDocument | UserDocument | WorldDocument;

export async function repairObjectIndexes(
	env: ObjectIndexRepairEnv,
	options: {
		chunkSize?: number;
		maxRowsPerRun?: number;
		maxRepairsPerRun?: number;
	} = {},
): Promise<ObjectIndexRepairResult> {
	const storedCursor = await readObjectIndexRepairCursor(env.BICKR_KV);
	const maxRepairsPerRun = positiveInteger(
		options.maxRepairsPerRun ?? objectIndexRepairMaxRepairsPerRun,
		"maxRepairsPerRun",
	);
	let repaired = 0;
	const iteration = await runBoundedSweep<ObjectIndexRow, string>({
		chunkSize: options.chunkSize ?? objectIndexRepairChunkSize,
		maxItemsPerRun: options.maxRowsPerRun ?? objectIndexRepairMaxRowsPerRun,
		...(storedCursor ? { initialCursor: storedCursor.afterObjectId } : {}),
		loadChunk: (cursor, limit) => loadObjectIndexChunk(env.BICKR_D1, cursor, limit),
		processChunk: async (rows) => {
			const documents = await Promise.all(rows.map((row) => readIndexedDocument(env.BICKR_KV, row)));
			for (let index = 0; index < rows.length; index += 1) {
				const row = rows[index];
				const document = documents[index];
				if (!row || !document || !isIndexedEntityType(row.objectType)) {
					continue;
				}
				const currentIndexVersion = entityIndexVersions[row.objectType];
				if (document.revision <= row.revision && row.indexVersion >= currentIndexVersion) {
					continue;
				}
				await repairIndexProjection(env, document, currentIndexVersion);
				repaired += 1;
				if (repaired >= maxRepairsPerRun) {
					return {
						kind: "stop",
						processedItems: index + 1,
						cursor: row.objectId,
					};
				}
			}
			return { kind: "continue" };
		},
		checkpoint: (afterObjectId) => writeJson(
			env.BICKR_KV,
			kvKeys.objectIndexRepairCursor,
			{ afterObjectId } satisfies ObjectIndexRepairCursor,
		),
		complete: () => deleteKey(env.BICKR_KV, kvKeys.objectIndexRepairCursor),
	});

	return {
		scanned: iteration.scanned,
		repaired,
		budgetExhausted: iteration.budgetExhausted,
	};
}

async function loadObjectIndexChunk(
	db: D1DatabaseLike,
	cursor: string | undefined,
	limit: number,
) {
	const statement = cursor ?
		db
			.prepare(
				`SELECT object_id AS objectId, object_type AS objectType, revision,
				        index_version AS indexVersion
				 FROM objects_index
				 WHERE object_id > ?
				 ORDER BY object_id ASC
				 LIMIT ?`,
			)
			.bind(cursor, limit)
	:	db
			.prepare(
				`SELECT object_id AS objectId, object_type AS objectType, revision,
				        index_version AS indexVersion
				 FROM objects_index
				 ORDER BY object_id ASC
				 LIMIT ?`,
			)
			.bind(limit);
	const result = await statement.all<ObjectIndexRow>();
	const items = result.results ?? [];
	const nextCursor = items.at(-1)?.objectId;
	return {
		items,
		done: items.length < limit,
		...(nextCursor ? { nextCursor } : {}),
	};
}

async function readObjectIndexRepairCursor(kv: KVNamespaceLike): Promise<ObjectIndexRepairCursor | null> {
	const value = await readJson<unknown>(kv, kvKeys.objectIndexRepairCursor);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const afterObjectId = (value as Record<string, unknown>).afterObjectId;
	return typeof afterObjectId === "string" && afterObjectId.length > 0 ? { afterObjectId } : null;
}

async function readIndexedDocument(
	kv: KVNamespaceLike,
	row: ObjectIndexRow,
): Promise<IndexedDocument | null> {
	if (!isIndexedEntityType(row.objectType)) {
		return null;
	}
	const key = indexedDocumentKey(row.objectType, row.objectId);
	const value = await readJson<unknown>(kv, key);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const document = value as Record<string, unknown>;
	if (
		document.id !== row.objectId ||
		document.type !== row.objectType ||
		typeof document.revision !== "number"
	) {
		return null;
	}
	return value as IndexedDocument;
}

function indexedDocumentKey(type: IndexedEntityType, id: string): string {
	switch (type) {
		case "user": return kvKeys.user(id);
		case "world": return kvKeys.world(id);
		case "forum": return kvKeys.forum(id);
		case "bot": return kvKeys.bot(id);
		case "thread": return kvKeys.thread(id);
	}
}

async function repairIndexProjection(
	env: ObjectIndexRepairEnv,
	document: IndexedDocument,
	indexVersion: number,
): Promise<void> {
	switch (document.type) {
		case "user": {
			const projected = await upsertUserIndexProjection(env.BICKR_D1, document);
			await putObjectIndex(env.BICKR_D1, projected, "user", indexVersion);
			return;
		}
		case "world": {
			const projected = await upsertWorldIndexProjection(env.BICKR_D1, document);
			if (projected.deletedAt) {
				await deleteSearchVector(env, "world", projected.id);
			} else {
				await upsertWorldSearchVector(env, projected);
			}
			await putObjectIndex(env.BICKR_D1, projected, "world", indexVersion, projected.id);
			return;
		}
		case "forum": {
			const projected = await upsertForumIndexProjection(env.BICKR_D1, document);
			if (projected.deletedAt) {
				await deleteSearchVector(env, "forum", projected.id);
			} else {
				await upsertForumSearchVector(env, projected);
			}
			await putObjectIndex(env.BICKR_D1, projected, "forum", indexVersion, projected.worldId);
			return;
		}
		case "bot": {
			const projected = await upsertBotIndexProjection(env.BICKR_KV, env.BICKR_D1, document);
			if (projected.deletedAt) {
				await deleteSearchVector(env, "bot", projected.id);
			} else {
				await upsertBotSearchVector(env, projected);
			}
			await putObjectIndex(env.BICKR_D1, projected, "bot", indexVersion, projected.homeWorldId);
			return;
		}
		case "thread": {
			const projected = await upsertThreadIndexProjection(env.BICKR_D1, document);
			await putObjectIndex(env.BICKR_D1, projected, "thread", indexVersion, projected.worldId);
			return;
		}
		default: {
			const exhaustive: never = document;
			return exhaustive;
		}
	}
}

function isIndexedEntityType(value: string): value is IndexedEntityType {
	return Object.prototype.hasOwnProperty.call(entityIndexVersions, value);
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return value;
}
