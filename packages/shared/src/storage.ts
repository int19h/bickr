import { type EntityDocument } from "./model";
import { isCloudflareRateLimitError, retryCloudflareOperation } from "./cloudflare";

export const kvKeys = {
	user: (userId: string) => `v1:user:${userId}`,
	session: (sessionHash: string) => `v1:session:${sessionHash}`,
	world: (worldId: string) => `v1:world:${worldId}`,
	forum: (forumId: string) => `v1:forum:${forumId}`,
	bot: (botId: string) => `v1:bot:${botId}`,
	thread: (threadId: string) => `v1:thread:${threadId}`,
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
	objectType: string,
	worldId?: string,
): Promise<void> {
	await db
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
			1,
			document.updatedAt,
			document.deletedAt ?? null,
		)
		.run();
}
