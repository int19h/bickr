import { isD1UniqueConstraintError } from "./d1-errors";
import { entityIndexVersions } from "./index-versions";
import type { ForumDocument } from "./model";
import { forumIndexProjectionStatement, RepositoryError } from "./repository";
import { forumSearchIndexStatements } from "./search";
import { kvKeys, objectIndexProjectionStatement, readJson, writeJson, type D1DatabaseLike, type KVNamespaceLike } from "./storage";

export type ForumCreationIntent = {
	forumId: string;
	worldId: string;
	ownerUserId: string;
	requestHash: string;
	documentJson: string | null;
	state: "pending" | "active" | "cancelled";
};
const receiptLifetimeMs = 30 * 24 * 60 * 60_000;
const columns = `forum_id AS forumId, world_id AS worldId, owner_user_id AS ownerUserId,
	request_hash AS requestHash, document_json AS documentJson, state`;

export function readForumCreationIntent(db: D1DatabaseLike, forumId: string) {
	return db.prepare(`SELECT ${columns} FROM forum_creation_intents WHERE forum_id = ?`).bind(forumId).first<ForumCreationIntent>();
}

export async function retryForumCreation(kv: KVNamespaceLike, db: D1DatabaseLike, owner: string, key: string, requestHash: string): Promise<ForumDocument | null> {
	const intent = await db.prepare(`SELECT ${columns} FROM forum_creation_intents WHERE owner_user_id = ? AND request_key = ?`).bind(owner, key).first<ForumCreationIntent>();
	if (!intent) return null;
	if (intent.requestHash !== requestHash) throw new RepositoryError("conflict", "The creation key was already used for a different request.", 409);
	return finishForumCreation(kv, db, intent);
}

/** The caller holds the world writer queue through reservation and activation. */
export async function commitForumCreation(kv: KVNamespaceLike, db: D1DatabaseLike, forum: ForumDocument, requestKey: string, requestHash: string): Promise<ForumDocument> {
	try {
		const result = await db.prepare(`INSERT INTO forum_creation_intents
			(forum_id, world_id, owner_user_id, handle, request_key, request_hash, document_json, state, next_attempt_at)
			SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ? WHERE
			EXISTS (SELECT 1 FROM users_index WHERE user_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active')
			AND EXISTS (SELECT 1 FROM worlds_index WHERE world_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active')`)
			.bind(forum.id, forum.worldId, forum.createdByUserId, forum.handle, requestKey, requestHash, JSON.stringify(forum), forum.createdAt, forum.createdByUserId, forum.worldId).run();
		if ((result.meta?.changes ?? 0) < 1) throw new RepositoryError("forbidden", "The account or world no longer accepts new forums.", 403);
	} catch (error) {
		if (isD1UniqueConstraintError(error)) throw new RepositoryError("conflict", "A forum with that handle is already being created.", 409);
		throw error;
	}
	return finishForumCreation(kv, db, { forumId: forum.id, worldId: forum.worldId, ownerUserId: forum.createdByUserId, requestHash, documentJson: JSON.stringify(forum), state: "pending" });
}

/** Recovery also enters the world writer queue. No snapshot crosses writers. */
export async function finishForumCreation(kv: KVNamespaceLike, db: D1DatabaseLike, intent: ForumCreationIntent): Promise<ForumDocument> {
	if (intent.state === "cancelled") throw new RepositoryError("not_found", "Forum creation was cancelled.", 410);
	if (intent.state === "active") {
		const row = await db.prepare(`SELECT forum_id FROM forums_index WHERE forum_id = ? AND deleted_at IS NULL`).bind(intent.forumId).first();
		const forum = row ? await readJson<ForumDocument>(kv, kvKeys.forum(intent.forumId)) : null;
		if (!forum || forum.deletedAt) throw new RepositoryError("not_found", "The created forum was deleted.", 410);
		return forum;
	}
	let forum = JSON.parse(intent.documentJson!) as ForumDocument;
	if (forum.id !== intent.forumId || forum.worldId !== intent.worldId || forum.createdByUserId !== intent.ownerUserId) throw new Error("Forum creation identity does not match its document.");
	const worldHandle = await activeParentWorldHandle(db, intent);
	if (!worldHandle) {
		await cancelForumCreation(kv, db, intent);
		throw new RepositoryError("forbidden", "The account or world no longer accepts new forums.", 403);
	}
	forum = { ...forum, worldHandle };
	await writeJson(kv, kvKeys.forum(forum.id), forum);
	try {
		await db.batch([
			forumIndexProjectionStatement(db, forum),
			...forumSearchIndexStatements(db, forum),
			objectIndexProjectionStatement(db, forum, "forum", entityIndexVersions.forum, forum.worldId),
			db.prepare(`UPDATE forum_creation_intents SET state = 'active', document_json = NULL, expires_at = ? WHERE forum_id = ? AND state = 'pending'`)
				.bind(new Date(Date.now() + receiptLifetimeMs).toISOString(), forum.id),
		]);
	} catch (error) {
		// A lost batch response does not mean activation failed. Its receipt is
		// the decision, including when account deletion has since started.
		const committed = await readForumCreationIntent(db, intent.forumId);
		if (committed?.state === "active") return finishForumCreation(kv, db, committed);
		// D1 does not expose trigger error codes. Determine the typed cause from
		// canonical parent state instead of matching a database error message.
		if (!await activeParentWorldHandle(db, intent)) {
			await cancelForumCreation(kv, db, intent);
			throw new RepositoryError("forbidden", "The account or world no longer accepts new forums.", 403);
		}
		if (isD1UniqueConstraintError(error)) {
			await cancelForumCreation(kv, db, intent);
			throw new RepositoryError("conflict", "A forum with that handle already exists in this world.", 409);
		}
		throw error;
	}
	return forum;
}

async function activeParentWorldHandle(db: D1DatabaseLike, intent: ForumCreationIntent): Promise<string | null> {
	return (await db.prepare(`SELECT w.handle FROM users_index u JOIN worlds_index w ON w.world_id = ?
		WHERE u.user_id = ? AND u.deleted_at IS NULL AND u.lifecycle_state = 'active'
		AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'`).bind(intent.worldId, intent.ownerUserId).first<{ handle: string }>())?.handle ?? null;
}

async function cancelForumCreation(kv: KVNamespaceLike, db: D1DatabaseLike, intent: ForumCreationIntent) {
	const current = await readForumCreationIntent(db, intent.forumId);
	if (current?.state !== "pending") return;
	await kv.delete(kvKeys.forum(intent.forumId));
	await db.prepare(`UPDATE forum_creation_intents SET state = 'cancelled', document_json = NULL, expires_at = ? WHERE forum_id = ? AND state = 'pending'`)
		.bind(new Date(Date.now() + receiptLifetimeMs).toISOString(), intent.forumId).run();
}
