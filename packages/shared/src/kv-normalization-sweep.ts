import {
	schemaVersion,
	type BotDocument,
	type ForumDocument,
	type LegacyThreadDocument,
	type ThreadDocument,
	type UserDocument,
	type WorldDocument,
} from "./model";
import {
	normalizeBotDefaults,
	normalizeForumDefaults,
	normalizeUserDefaults,
	normalizeWorldDefaults,
} from "./repository";
import { normalizeThreadDefaults } from "./social";
import {
	deleteKey,
	type D1DatabaseLike,
	kvKeys,
	type KVNamespaceLike,
	readJson,
	writeJson,
} from "./storage";
import { runBoundedSweep } from "./sweep";

export const kvNormalizationEntityTypes = ["thread", "bot", "user", "world", "forum"] as const;
export type KvNormalizationEntityType = (typeof kvNormalizationEntityTypes)[number];

// A run has this invocation to itself, but KV has a stricter 1,000-operation
// ceiling than the paid Worker's 10k subrequest ceiling. At the defaults, the
// healthy path uses at most 500 KV reads, 75 document writes, 10 D1 selects,
// and about 11 cursor operations. Even if every KV mutation takes all five
// retry attempts, the total remains below 1,000 external operations.
export const kvNormalizationSweepChunkSize = 50;
export const kvNormalizationSweepMaxRowsPerRun = 500;
export const kvNormalizationSweepMaxWritesPerRun = 75;

export type KvNormalizationSweepResult = {
	scanned: number;
	rewritten: number;
	budgetExhausted: boolean;
	done: boolean;
};

export type KvNormalizationSweepEnv = {
	BICKR_D1: D1DatabaseLike;
	BICKR_KV: KVNamespaceLike;
};

type ObjectIndexRow = {
	objectId: string;
};

type KvNormalizationSweepCursor = {
	afterObjectId: string;
};

type NormalizableDocument =
	| BotDocument
	| ForumDocument
	| LegacyThreadDocument
	| ThreadDocument
	| UserDocument
	| WorldDocument;

export async function normalizeKvDocuments(
	env: KvNormalizationSweepEnv,
	entityType: KvNormalizationEntityType,
	options: {
		maxRowsPerRun?: number;
		maxWritesPerRun?: number;
	} = {},
): Promise<KvNormalizationSweepResult> {
	const maxRowsPerRun = boundedPositiveInteger(
		options.maxRowsPerRun ?? kvNormalizationSweepMaxRowsPerRun,
		"maxRowsPerRun",
		kvNormalizationSweepMaxRowsPerRun,
	);
	const maxWritesPerRun = boundedPositiveInteger(
		options.maxWritesPerRun ?? kvNormalizationSweepMaxWritesPerRun,
		"maxWritesPerRun",
		kvNormalizationSweepMaxWritesPerRun,
	);
	const cursorKey = kvKeys.kvNormalizationSweepCursor(entityType);
	const storedCursor = await readKvNormalizationSweepCursor(env.BICKR_KV, cursorKey);
	let rewritten = 0;
	const iteration = await runBoundedSweep<ObjectIndexRow, string>({
		chunkSize: kvNormalizationSweepChunkSize,
		maxItemsPerRun: maxRowsPerRun,
		...(storedCursor ? { initialCursor: storedCursor.afterObjectId } : {}),
		// objects_index is already the bounded inventory of entity documents.
		// KV list-by-prefix would add an expensive namespace scan per type.
		loadChunk: (cursor, limit) => loadObjectIndexChunk(env.BICKR_D1, entityType, cursor, limit),
		processChunk: async (rows) => {
			const documents = await Promise.all(
				rows.map((row) => readNormalizableDocument(env.BICKR_KV, entityType, row.objectId)),
			);
			for (let index = 0; index < rows.length; index += 1) {
				const row = rows[index];
				const document = documents[index];
				if (!row || !document) {
					continue;
				}
				const normalized = normalizeDocument(document);
				const schemaLags = typeof document.schemaVersion !== "number" || document.schemaVersion < schemaVersion;
				if (!schemaLags && JSON.stringify(normalized) === JSON.stringify(document)) {
					continue;
				}
				await writeJson(env.BICKR_KV, documentKey(entityType, row.objectId), normalized);
				rewritten += 1;
				if (rewritten >= maxWritesPerRun) {
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
			cursorKey,
			{ afterObjectId } satisfies KvNormalizationSweepCursor,
		),
		complete: () => deleteKey(env.BICKR_KV, cursorKey),
	});

	return {
		scanned: iteration.scanned,
		rewritten,
		budgetExhausted: iteration.budgetExhausted,
		done: !iteration.budgetExhausted,
	};
}

async function loadObjectIndexChunk(
	db: D1DatabaseLike,
	entityType: KvNormalizationEntityType,
	cursor: string | undefined,
	limit: number,
) {
	const statement = cursor ?
		db
			.prepare(
				`SELECT object_id AS objectId
				 FROM objects_index
				 WHERE object_type = ? AND object_id > ?
				 ORDER BY object_id ASC
				 LIMIT ?`,
			)
			.bind(entityType, cursor, limit)
	:	db
			.prepare(
				`SELECT object_id AS objectId
				 FROM objects_index
				 WHERE object_type = ?
				 ORDER BY object_id ASC
				 LIMIT ?`,
			)
			.bind(entityType, limit);
	const result = await statement.all<ObjectIndexRow>();
	const items = result.results ?? [];
	const nextCursor = items.at(-1)?.objectId;
	return {
		items,
		done: items.length < limit,
		...(nextCursor ? { nextCursor } : {}),
	};
}

async function readKvNormalizationSweepCursor(
	kv: KVNamespaceLike,
	key: string,
): Promise<KvNormalizationSweepCursor | null> {
	const value = await readJson<unknown>(kv, key);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const afterObjectId = (value as Record<string, unknown>).afterObjectId;
	return typeof afterObjectId === "string" && afterObjectId.length > 0 ? { afterObjectId } : null;
}

async function readNormalizableDocument(
	kv: KVNamespaceLike,
	entityType: KvNormalizationEntityType,
	objectId: string,
): Promise<NormalizableDocument | null> {
	const value = await readJson<unknown>(kv, documentKey(entityType, objectId));
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const document = value as Record<string, unknown>;
	if (document.id !== objectId || document.type !== entityType) {
		return null;
	}
	return value as NormalizableDocument;
}

function normalizeDocument(document: NormalizableDocument): NormalizableDocument {
	switch (document.type) {
		case "user": return normalizeUserDefaults(document);
		case "world": return normalizeWorldDefaults(document);
		case "forum": return normalizeForumDefaults(document);
		case "bot": return normalizeBotDefaults(document);
		case "thread": return normalizeThreadDefaults(document);
		default: {
			const exhaustive: never = document;
			return exhaustive;
		}
	}
}

function documentKey(entityType: KvNormalizationEntityType, objectId: string): string {
	switch (entityType) {
		case "user": return kvKeys.user(objectId);
		case "world": return kvKeys.world(objectId);
		case "forum": return kvKeys.forum(objectId);
		case "bot": return kvKeys.bot(objectId);
		case "thread": return kvKeys.thread(objectId);
	}
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
	if (!Number.isInteger(value) || value <= 0 || value > maximum) {
		throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
	}
	return value;
}
