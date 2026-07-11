import {
	schemaVersion,
	type BotDocument,
	type ForumDocument,
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
export type KvNormalizationNonThreadEntityType = Exclude<KvNormalizationEntityType, "thread">;

export const threadNormalizationOutcomeKinds = [
	"rewritten",
	"unchanged",
	"skipped_recently_updated",
	"skipped_changed",
] as const;
export type ThreadNormalizationOutcome =
	| { kind: "rewritten" }
	| { kind: "unchanged" }
	| { kind: "skipped_recently_updated" }
	| { kind: "skipped_changed" };
export type ThreadNormalizationRequest = {
	threadId: string;
	expectedRevision: number;
	expectedUpdatedAt: string;
};

// A run has this invocation to itself, but KV has a stricter 1,000-operation
// ceiling than the paid Worker's 10k subrequest ceiling. At the defaults, the
// non-thread worst case uses 250 initial KV reads, 250 pre-write rereads, 75
// document writes, 5 D1 selects, and about 6 cursor operations. Even if every
// KV mutation takes all five retry attempts, the total remains below 1,000
// external operations. Thread candidates replace rereads/writes with bounded
// calls to their coordinator DO, whose KV work runs in separate invocations.
export const kvNormalizationSweepChunkSize = 50;
export const kvNormalizationSweepMaxRowsPerRun = 250;
export const kvNormalizationSweepMaxWritesPerRun = 75;
export const kvNormalizationQuietPeriodMs = 6 * 60 * 60 * 1_000;

export type KvNormalizationSweepResult = {
	scanned: number;
	rewritten: number;
	skippedRecentlyUpdated: number;
	skippedChangedDuringSweep: number;
	budgetExhausted: boolean;
	done: boolean;
};

export type KvNormalizationSweepBaseEnv = {
	BICKR_D1: D1DatabaseLike;
	BICKR_KV: KVNamespaceLike;
};
export type KvNormalizationSweepEnv = KvNormalizationSweepBaseEnv & {
	normalizeThread: (request: ThreadNormalizationRequest) => Promise<ThreadNormalizationOutcome>;
};

export type KvNormalizationSweepOptions = {
	maxRowsPerRun?: number;
	maxWritesPerRun?: number;
	now?: string;
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
	| ThreadDocument
	| UserDocument
	| WorldDocument;

export function normalizeKvDocuments(
	env: KvNormalizationSweepEnv,
	entityType: KvNormalizationEntityType,
	options?: KvNormalizationSweepOptions,
): Promise<KvNormalizationSweepResult>;
export function normalizeKvDocuments(
	env: KvNormalizationSweepBaseEnv,
	entityType: KvNormalizationNonThreadEntityType,
	options?: KvNormalizationSweepOptions,
): Promise<KvNormalizationSweepResult>;
export async function normalizeKvDocuments(
	env: KvNormalizationSweepBaseEnv & Partial<Pick<KvNormalizationSweepEnv, "normalizeThread">>,
	entityType: KvNormalizationEntityType,
	options: KvNormalizationSweepOptions = {},
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
	const nowMs = options.now === undefined ? Date.now() : requiredTimestamp(options.now, "now");
	let rewritten = 0;
	let skippedRecentlyUpdated = 0;
	let skippedChangedDuringSweep = 0;
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
				if (isWithinKvNormalizationQuietPeriod(document.updatedAt, nowMs)) {
					skippedRecentlyUpdated += 1;
					continue;
				}

				if (document.type === "thread") {
					if (!env.normalizeThread) {
						throw new Error("Thread KV normalization requires the owning coordinator operation.");
					}
					const outcome = await env.normalizeThread({
						threadId: row.objectId,
						expectedRevision: document.revision,
						expectedUpdatedAt: document.updatedAt,
					});
					switch (outcome.kind) {
						case "rewritten": rewritten += 1; break;
						case "unchanged": break;
						case "skipped_recently_updated": skippedRecentlyUpdated += 1; break;
						case "skipped_changed": skippedChangedDuringSweep += 1; break;
						default: {
							const exhaustive: never = outcome;
							return exhaustive;
						}
					}
				} else {
					const latest = await readNormalizableDocument(env.BICKR_KV, entityType, row.objectId);
					if (!latest || !sameDocumentVersion(document, latest)) {
						skippedChangedDuringSweep += 1;
						continue;
					}
					const latestNormalized = normalizeDocument(latest);
					const latestSchemaLags = typeof latest.schemaVersion !== "number" || latest.schemaVersion < schemaVersion;
					if (!latestSchemaLags && JSON.stringify(latestNormalized) === JSON.stringify(latest)) {
						continue;
					}
					await writeJson(env.BICKR_KV, documentKey(entityType, row.objectId), latestNormalized);
					rewritten += 1;
				}
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
		skippedRecentlyUpdated,
		skippedChangedDuringSweep,
		budgetExhausted: iteration.budgetExhausted,
		done: !iteration.budgetExhausted && skippedRecentlyUpdated === 0 && skippedChangedDuringSweep === 0,
	};
}

export function isWithinKvNormalizationQuietPeriod(updatedAt: string, nowMs = Date.now()): boolean {
	const updatedAtMs = Date.parse(updatedAt);
	return Number.isFinite(updatedAtMs) && updatedAtMs > nowMs - kvNormalizationQuietPeriodMs;
}

export function isThreadNormalizationOutcome(value: unknown): value is ThreadNormalizationOutcome {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const kind = (value as Record<string, unknown>).kind;
	return typeof kind === "string" && (threadNormalizationOutcomeKinds as readonly string[]).includes(kind);
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

function sameDocumentVersion(left: NormalizableDocument, right: NormalizableDocument): boolean {
	return left.revision === right.revision && left.updatedAt === right.updatedAt;
}

function requiredTimestamp(value: string, name: string): number {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		throw new Error(`${name} must be an ISO timestamp.`);
	}
	return timestamp;
}
