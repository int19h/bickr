import { type EntityDocument } from "./model";
import { type IndexedEntityType } from "./index-versions";
import { isCloudflareRateLimitError, retryCloudflareOperation } from "./cloudflare";

// D1 currently allows 100 bound parameters per statement. Keep set-oriented
// queries below this shared ceiling so callers do not invent divergent limits.
export const d1MaxBoundParameters = 100;
// Leave one slot for a future fixed predicate without making full batches fail.
export const d1SafeBoundParameters = d1MaxBoundParameters - 1;

export function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		result.push(items.slice(index, index + size));
	}
	return result;
}

export const kvKeys = {
	user: (userId: string) => `v1:user:${userId}`,
	session: (sessionHash: string) => `v1:session:${sessionHash}`,
	oauthReturnTo: (provider: string, stateHash: string) => `v1:oauth-return-to:${provider}:${stateHash}`,
	cliAuthRequest: (requestHash: string) => `v1:cli-auth-request:${requestHash}`,
	cliToken: (tokenHash: string) => `v1:cli-token:${tokenHash}`,
	mcpClient: (clientId: string) => `v1:mcp-client:${clientId}`,
	mcpAuthorizationCode: (codeHash: string) => `v1:mcp-authorization-code:${codeHash}`,
	mcpGrant: (grantId: string) => `v1:mcp-grant:${grantId}`,
	mcpAccessToken: (tokenHash: string) => `v1:mcp-access-token:${tokenHash}`,
	mcpRefreshToken: (tokenHash: string) => `v1:mcp-refresh-token:${tokenHash}`,
	world: (worldId: string) => `v1:world:${worldId}`,
	forum: (forumId: string) => `v1:forum:${forumId}`,
	bot: (botId: string) => `v1:bot:${botId}`,
	thread: (threadId: string) => `v1:thread:${threadId}`,
	// One bounded maintenance cursor is retained only until a complete
	// objects_index pass finishes, then deleted before the next pass.
	objectIndexRepairCursor: "v1:maintenance:object-index-repair-cursor",
	// One cursor per entity type is retained only until that type's KV
	// normalization pass finishes, then deleted before the next pass.
	kvNormalizationSweepCursor: (objectType: IndexedEntityType) =>
		`v1:maintenance:kv-normalization-sweep-cursor:${objectType}`,
	// One cursor per deleted forum is retained only while its bounded thread
	// deletion fan-out is incomplete. The owning forum coordinator removes it
	// after every indexed thread has passed through its thread coordinator.
	forumThreadDeletionSweepCursor: (forumId: string) =>
		`v1:maintenance:forum-thread-deletion-sweep-cursor:${forumId}`,
	// One cursor per deleted world is retained only while its bounded forum
	// deletion fan-out is incomplete. The owning world coordinator removes it
	// after every forum has started its own resumable deletion.
	worldForumDeletionSweepCursor: (worldId: string) =>
		`v1:maintenance:world-forum-deletion-sweep-cursor:${worldId}`,
	// This cursor is retained only until the one-time personal-forum
	// description resync finishes, then deleted before the next pass.
	personalForumDescriptionSweepCursor: "v1:maintenance:personal-forum-description-sweep-cursor",
	// The vector reindex cursor is retained only until a complete pass over the
	// searchable entity indexes finishes, then deleted before the next pass.
	searchVectorReindexCursor: "v1:maintenance:search-vector-reindex-cursor",
	// One cursor carrying the daily BotRuntime retention sweep's position in
	// bot_runtime_index. Retained only while a pass is incomplete: the sweep
	// deletes it on reaching the end so the next pass restarts from the first
	// participant.
	botRuntimeRetentionSweepCursor: "v1:maintenance:bot-runtime-retention-sweep-cursor",
	notification: (botId: string, notificationId: string) =>
		`v1:notification:${botId}:${notificationId}`,
};

export type KVNamespaceLike = {
	get(key: string, options?: { type: "json" }): Promise<unknown>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
};

export type D1Result<T = unknown> = {
	results?: T[];
	success: boolean;
	meta?: {
		changes?: number;
		[key: string]: unknown;
	};
};

export type D1PreparedStatementLike = {
	bind(...values: unknown[]): D1PreparedStatementLike;
	first<T = unknown>(): Promise<T | null>;
	all<T = unknown>(): Promise<D1Result<T>>;
	run(): Promise<D1Result>;
};

export type D1DatabaseLike = {
	batch(statements: D1PreparedStatementLike[]): Promise<Array<D1Result>>;
	prepare(query: string): D1PreparedStatementLike;
};

export async function readJson<T>(kv: KVNamespaceLike, key: string): Promise<T | null> {
	const value = await kv.get(key, { type: "json" });
	return value === null ? null : (value as T);
}

export async function writeJson(
	kv: KVNamespaceLike,
	key: string,
	value: unknown,
	options?: { expirationTtl?: number },
): Promise<void> {
	const serialized = JSON.stringify(value);
	await retryKvMutation(`KV put ${key}`, () => kv.put(key, serialized, options));
}

export async function deleteKey(kv: KVNamespaceLike, key: string): Promise<void> {
	await retryKvMutation(`KV delete ${key}`, () => kv.delete(key));
}

function retryKvMutation(operation: string, run: () => Promise<void>): Promise<void> {
	return retryCloudflareOperation({
		operation,
		run,
		maxAttempts: 5,
		initialDelayMs: 1_100,
		maxDelayMs: 8_000,
		shouldRetry: isCloudflareRateLimitError,
	});
}

export async function putObjectIndex(
	db: D1DatabaseLike,
	document: EntityDocument,
	objectType: IndexedEntityType,
	indexVersion: number,
	worldId?: string,
): Promise<void> {
	await objectIndexProjectionStatement(db, document, objectType, indexVersion, worldId).run();
}

export function objectIndexProjectionStatement(
	db: D1DatabaseLike,
	document: EntityDocument,
	objectType: IndexedEntityType,
	indexVersion: number,
	worldId?: string,
): D1PreparedStatementLike {
	return db
		.prepare(
			`INSERT INTO objects_index (
				object_id, object_type, world_id, revision, index_version, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(object_id) DO UPDATE SET
				object_type = excluded.object_type,
				world_id = excluded.world_id,
				revision = excluded.revision,
				index_version = excluded.index_version,
				updated_at = excluded.updated_at,
				deleted_at = excluded.deleted_at`,
		)
		.bind(
			document.id,
			objectType,
			worldId ?? null,
			document.revision,
			indexVersion,
			document.updatedAt,
			document.deletedAt ?? null,
		);
}
