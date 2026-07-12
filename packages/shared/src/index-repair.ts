import { entityIndexVersions, type IndexedEntityType } from "./index-versions";
import { type ObjectIndexRepairScope } from "./object-index-scope";
import {
	type BotDocument,
	type ForumDocument,
	localizedTextFromStored,
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
import { parseLanguageTag } from "./validation";

export type { ObjectIndexRepairScope } from "./object-index-scope";

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
	afterObjectId?: string;
};

export type ObjectIndexConvergenceTask = {
	kind: "object_index_convergence";
	scope: ObjectIndexRepairScope;
	updatedAt: string;
	afterObjectId?: string;
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
	canonicalWorldHandle: string | null;
	canonicalForumHandle: string | null;
	indexedForumHandle: string | null;
	indexedForumLanguage: string | null;
	indexedForumDescription: string | null;
	indexedForumDescriptionLang: string | null;
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
		scope?: ObjectIndexRepairScope;
		afterObjectId?: string;
		documentUpdatedAt?: string;
	} = {},
): Promise<ObjectIndexRepairResult> {
	const storedCursor = options.scope ? null : await readObjectIndexRepairCursor(env.BICKR_KV);
	const initialCursor = options.afterObjectId ?? storedCursor?.afterObjectId;
	const maxRepairsPerRun = positiveInteger(
		options.maxRepairsPerRun ?? objectIndexRepairMaxRepairsPerRun,
		"maxRepairsPerRun",
	);
	let repaired = 0;
	let afterObjectId: string | undefined;
	const iteration = await runBoundedSweep<ObjectIndexRow, string>({
		chunkSize: options.chunkSize ?? objectIndexRepairChunkSize,
		maxItemsPerRun: options.maxRowsPerRun ?? objectIndexRepairMaxRowsPerRun,
		...(initialCursor ? { initialCursor } : {}),
		loadChunk: (cursor, limit) => loadObjectIndexChunk(env.BICKR_D1, cursor, limit, options.scope),
		processChunk: async (rows) => {
			const documents = await Promise.all(rows.map((row) => readIndexedDocument(env.BICKR_KV, row)));
			for (let index = 0; index < rows.length; index += 1) {
				const row = rows[index];
				const storedDocument = documents[index];
				if (!row || !storedDocument || !isIndexedEntityType(row.objectType)) {
					continue;
				}
				const currentIndexVersion = entityIndexVersions[row.objectType];
				if (storedDocument.revision <= row.revision && row.indexVersion >= currentIndexVersion) {
					continue;
				}
				const document = await convergeDerivedRouteFields(
					env.BICKR_KV,
					storedDocument,
					row,
					options.documentUpdatedAt,
				);
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
		checkpoint: async (cursor) => {
			afterObjectId = cursor;
			if (!options.scope) {
				await writeJson(
					env.BICKR_KV,
					kvKeys.objectIndexRepairCursor,
					{ afterObjectId: cursor } satisfies ObjectIndexRepairCursor,
				);
			}
		},
		complete: async () => {
			afterObjectId = undefined;
			if (!options.scope) {
				await deleteKey(env.BICKR_KV, kvKeys.objectIndexRepairCursor);
			}
		},
	});

	return {
		scanned: iteration.scanned,
		repaired,
		budgetExhausted: iteration.budgetExhausted,
		...(options.scope && afterObjectId ? { afterObjectId } : {}),
	};
}

export async function runObjectIndexConvergenceBatch(
	env: ObjectIndexRepairEnv,
	task: ObjectIndexConvergenceTask,
	options: {
		chunkSize?: number;
		maxRowsPerRun?: number;
		maxRepairsPerRun?: number;
	} = {},
): Promise<ObjectIndexConvergenceTask | null> {
	assertObjectIndexConvergenceTask(task);
	const result = await repairObjectIndexes(env, {
		...options,
		scope: task.scope,
		...(task.afterObjectId ? { afterObjectId: task.afterObjectId } : {}),
		documentUpdatedAt: task.updatedAt,
	});
	if (!result.budgetExhausted) {
		return null;
	}
	if (!result.afterObjectId) {
		throw new Error("Scoped object-index repair exhausted its budget without a continuation cursor.");
	}
	return { ...task, afterObjectId: result.afterObjectId };
}

async function loadObjectIndexChunk(
	db: D1DatabaseLike,
	cursor: string | undefined,
	limit: number,
	scope?: ObjectIndexRepairScope,
) {
	const { clause, values } = objectIndexScopeClause(scope);
	const cursorClause = cursor ? " AND oi.object_id > ?" : "";
	const statement = db
		.prepare(
			`SELECT oi.object_id AS objectId,
			        oi.object_type AS objectType,
			        oi.revision,
			        oi.index_version AS indexVersion,
			        canonical_world.handle AS canonicalWorldHandle,
			        canonical_forum.handle AS canonicalForumHandle,
			        object_forum.handle AS indexedForumHandle,
			        object_forum.language AS indexedForumLanguage,
			        object_forum.description AS indexedForumDescription,
			        object_forum.description_lang AS indexedForumDescriptionLang
			 FROM objects_index oi
			 LEFT JOIN forums_index object_forum
			   ON oi.object_type = 'forum' AND object_forum.forum_id = oi.object_id
			 LEFT JOIN bots_index object_bot
			   ON oi.object_type = 'bot' AND object_bot.bot_id = oi.object_id
			 LEFT JOIN threads_index object_thread
			   ON oi.object_type = 'thread' AND object_thread.thread_id = oi.object_id
			 LEFT JOIN worlds_index canonical_world
			   ON canonical_world.world_id = COALESCE(object_forum.world_id, object_bot.home_world_id, object_thread.world_id)
			 LEFT JOIN forums_index canonical_forum
			   ON canonical_forum.forum_id = object_thread.forum_id
			 WHERE (${clause})${cursorClause}
			 ORDER BY oi.object_id ASC
			 LIMIT ?`,
		)
		.bind(...values, ...(cursor ? [cursor] : []), limit);
	const result = await statement.all<ObjectIndexRow>();
	const items = result.results ?? [];
	const nextCursor = items.at(-1)?.objectId;
	return {
		items,
		done: items.length < limit,
		...(nextCursor ? { nextCursor } : {}),
	};
}

function objectIndexScopeClause(scope: ObjectIndexRepairScope | undefined): {
	clause: string;
	values: string[];
} {
	if (!scope) {
		return { clause: "1 = 1", values: [] };
	}
	if (scope.kind === "world") {
		return { clause: "oi.world_id = ?", values: [scope.worldId] };
	}
	return {
		clause: `(oi.object_type = 'forum' AND oi.object_id = ?)
			OR (oi.object_type = 'thread' AND object_thread.forum_id = ?)`,
		values: [scope.forumId, scope.forumId],
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

async function convergeDerivedRouteFields(
	kv: KVNamespaceLike,
	document: IndexedDocument,
	row: ObjectIndexRow,
	updatedAt = new Date().toISOString(),
): Promise<IndexedDocument> {
	// KV remains authoritative for entity-owned content. These route fields are
	// different: they are denormalized from a parent whose rename batch already
	// committed in D1. Personal-forum profile fields are likewise derived from
	// their participant. Reconcile only those fields before projecting the now-
	// canonical document back into D1, FTS, and Vectorize.
	let converged: IndexedDocument = document;
	switch (document.type) {
		case "forum": {
			const worldHandle = row.canonicalWorldHandle ?? document.worldHandle;
			const handle = document.personalBotId ? row.indexedForumHandle ?? document.handle : document.handle;
			const language = document.personalBotId && row.indexedForumLanguage !== null ?
				parseLanguageTag(row.indexedForumLanguage)
			: document.language;
			const description = document.personalBotId && row.indexedForumDescription !== null ?
				localizedTextFromStored({
					text: row.indexedForumDescription,
					lang: row.indexedForumDescriptionLang,
				})
			: document.description;
			if (
				worldHandle !== document.worldHandle ||
				handle !== document.handle ||
				language !== document.language ||
				description.text !== document.description.text ||
				description.lang !== document.description.lang
			) {
				converged = {
					...document,
					worldHandle,
					handle,
					language,
					description,
					revision: document.revision + 1,
					updatedAt,
				};
			}
			break;
		}
		case "bot": {
			const homeWorldHandle = row.canonicalWorldHandle ?? document.homeWorldHandle;
			if (homeWorldHandle !== document.homeWorldHandle) {
				converged = { ...document, homeWorldHandle, revision: document.revision + 1, updatedAt };
			}
			break;
		}
		case "thread": {
			const worldHandle = row.canonicalWorldHandle ?? document.worldHandle;
			const forumHandle = row.canonicalForumHandle ?? document.forumHandle;
			if (worldHandle !== document.worldHandle || forumHandle !== document.forumHandle) {
				converged = { ...document, worldHandle, forumHandle, revision: document.revision + 1, updatedAt };
			}
			break;
		}
		case "user":
		case "world":
			break;
		default: {
			const exhaustive: never = document;
			return exhaustive;
		}
	}
	if (converged !== document) {
		await writeJson(kv, indexedDocumentKey(converged.type, converged.id), converged);
	}
	return converged;
}

function assertObjectIndexConvergenceTask(task: ObjectIndexConvergenceTask): void {
	if (
		task.kind !== "object_index_convergence" ||
		!Number.isFinite(Date.parse(task.updatedAt)) ||
		(task.afterObjectId !== undefined && !task.afterObjectId)
	) {
		throw new Error("Invalid persisted object-index convergence task.");
	}
	if (
		(task.scope.kind === "world" && task.scope.worldId) ||
		(task.scope.kind === "forum" && task.scope.forumId)
	) {
		return;
	}
	throw new Error("Invalid persisted object-index convergence task scope.");
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
