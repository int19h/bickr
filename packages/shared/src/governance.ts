import {
	type BotDocument,
	type ForumDocument,
	type ForumSummary,
	type ThreadDocument,
	type UpdateForumInput,
	type UpdateWorldInput,
	type WorldDocument,
	type WorldSummary,
} from "./model";
import {
	mergePostingSettings,
	postingSettingsHasValues,
} from "./posting";
import { RepositoryError, softDeleteBotGroupsForWorld } from "./repository";
import { upsertForumSearchIndex, upsertWorldSearchIndex } from "./search";
import { readThread, rootCommentForThread, softDeleteComment, softDeleteThread, softDeleteThreadsInForum } from "./social";
import {
	type D1DatabaseLike,
	type KVNamespaceLike,
	kvKeys,
	putObjectIndex,
	readJson,
	writeJson,
} from "./storage";

export async function updateWorld(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	userId: string,
	input: UpdateWorldInput,
	now = new Date().toISOString(),
): Promise<WorldSummary> {
	const world = await worldDocumentByHandle(kv, db, worldHandle);
	assertWorldOwner(world, userId);
	const nextHandle = input.handle ?? world.handle;
	if (nextHandle !== world.handle) {
		await assertWorldHandleAvailable(db, world.id, nextHandle);
	}
	const postingSettings = mergePostingSettings(world.postingSettings, input.postingSettings);
	const updated: WorldDocument = {
		...world,
		...input,
		handle: nextHandle,
		...(postingSettingsHasValues(postingSettings) ? { postingSettings } : { postingSettings: undefined }),
		revision: world.revision + 1,
		updatedAt: now,
	};
	if (nextHandle !== world.handle) {
		await db.batch([
			db
				.prepare(
					`UPDATE worlds_index
					 SET handle = ?,
					     name = ?,
					     description = ?,
					     initial_bot_notification = ?,
					     posting_thread_body_characters = ?,
					     posting_comment_body_characters = ?,
					     updated_at = ?
					 WHERE world_id = ? AND deleted_at IS NULL`,
				)
				.bind(
					updated.handle,
					updated.name,
					updated.description,
					updated.initialBotNotification,
					updated.postingSettings?.threadBodyCharacters ?? null,
					updated.postingSettings?.commentBodyCharacters ?? null,
					now,
					updated.id,
				),
			db
				.prepare(`UPDATE forums_index SET world_handle = ?, updated_at = ? WHERE world_id = ? AND deleted_at IS NULL`)
				.bind(updated.handle, now, updated.id),
			db
				.prepare(`UPDATE bots_index SET home_world_handle = ?, updated_at = ? WHERE home_world_id = ? AND deleted_at IS NULL`)
				.bind(updated.handle, now, updated.id),
			db
				.prepare(`UPDATE threads_index SET world_handle = ? WHERE world_id = ? AND deleted_at IS NULL`)
				.bind(updated.handle, updated.id),
		]);
		await writeWorldRenameDocuments(kv, db, world, updated, now);
	} else {
		await db
			.prepare(
				`UPDATE worlds_index
				 SET name = ?,
				     description = ?,
				     initial_bot_notification = ?,
				     posting_thread_body_characters = ?,
				     posting_comment_body_characters = ?,
				     updated_at = ?
				 WHERE world_id = ? AND deleted_at IS NULL`,
			)
			.bind(
				updated.name,
				updated.description,
				updated.initialBotNotification,
				updated.postingSettings?.threadBodyCharacters ?? null,
				updated.postingSettings?.commentBodyCharacters ?? null,
				now,
				updated.id,
			)
			.run();
		await writeJson(kv, kvKeys.world(updated.id), updated);
	}
	await putObjectIndex(db, updated, "world", updated.id);
	await upsertWorldSearchIndex(db, updated);
	return worldSummary(updated);
}

export async function deleteWorld(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	userId: string,
	now = new Date().toISOString(),
): Promise<WorldSummary> {
	const world = await worldDocumentByHandle(kv, db, worldHandle);
	assertWorldOwner(world, userId);
	const activeBots = await db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM bots_index
			 WHERE home_world_id = ? AND deleted_at IS NULL`,
		)
		.bind(world.id)
		.first<{ count: number }>();
	if ((activeBots?.count ?? 0) > 0) {
		throw new RepositoryError("forbidden", "Worlds can only be deleted after all bots in them are deleted.", 403);
	}

	const forums = await db
		.prepare(`SELECT forum_id AS id FROM forums_index WHERE world_id = ? AND deleted_at IS NULL`)
		.bind(world.id)
		.all<{ id: string }>();
	for (const row of forums.results ?? []) {
		const forum = await forumDocumentById(kv, db, row.id);
		await softDeleteForum(kv, db, forum, now);
	}
	await softDeleteBotGroupsForWorld(db, world.id, now);

	const deleted: WorldDocument = {
		...world,
		revision: world.revision + 1,
		updatedAt: now,
		deletedAt: now,
	};
	await writeJson(kv, kvKeys.world(deleted.id), deleted);
	await db
		.prepare(`UPDATE worlds_index SET updated_at = ?, deleted_at = ? WHERE world_id = ? AND deleted_at IS NULL`)
		.bind(now, now, deleted.id)
		.run();
	await putObjectIndex(db, deleted, "world", deleted.id);
	await upsertWorldSearchIndex(db, deleted);
	return worldSummary(deleted);
}

export async function updateForum(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	forumHandle: string,
	userId: string,
	input: UpdateForumInput,
	now = new Date().toISOString(),
): Promise<ForumSummary> {
	const forum = await forumDocumentByHandle(kv, db, worldHandle, forumHandle);
	await assertCanModerateForum(db, forum, userId);
	const nextHandle = input.handle ?? forum.handle;
	if (nextHandle !== forum.handle) {
		await assertForumHandleAvailable(db, forum.worldId, forum.id, nextHandle);
	}
	const updated: ForumDocument = {
		...forum,
		...input,
		handle: nextHandle,
		revision: forum.revision + 1,
		updatedAt: now,
	};
	if (nextHandle !== forum.handle) {
		await db.batch([
			db
				.prepare(`UPDATE forums_index SET handle = ?, description = ?, updated_at = ? WHERE forum_id = ? AND deleted_at IS NULL`)
				.bind(updated.handle, updated.description, now, updated.id),
			db
				.prepare(`UPDATE threads_index SET forum_handle = ? WHERE forum_id = ? AND deleted_at IS NULL`)
				.bind(updated.handle, updated.id),
		]);
		await writeForumRenameDocuments(kv, db, forum, updated, now);
	} else {
		await db
			.prepare(`UPDATE forums_index SET description = ?, updated_at = ? WHERE forum_id = ? AND deleted_at IS NULL`)
			.bind(updated.description, now, updated.id)
			.run();
		await writeJson(kv, kvKeys.forum(updated.id), updated);
	}
	await putObjectIndex(db, updated, "forum", updated.worldId);
	await upsertForumSearchIndex(db, updated);
	return forumSummary(updated);
}

export async function deleteForum(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	forumHandle: string,
	userId: string,
	now = new Date().toISOString(),
): Promise<ForumSummary> {
	const forum = await forumDocumentByHandle(kv, db, worldHandle, forumHandle);
	await assertCanModerateForum(db, forum, userId);
	const deleted = await softDeleteForum(kv, db, forum, now);
	return forumSummary(deleted);
}

export async function deleteThread(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	forumId: string,
	threadId: string,
	userId: string,
	now = new Date().toISOString(),
	options: { thread?: ThreadDocument } = {},
): Promise<ThreadDocument> {
	const thread = options.thread?.id === threadId ? options.thread : await readThread(kv, threadId);
	if (thread.forumId !== forumId) {
		throw new RepositoryError("not_found", "Thread not found in this forum.", 404);
	}
	if (!(await canModerateForumId(db, forumId, userId)) && !(await userOwnsBot(db, userId, rootCommentForThread(thread).authorBotId))) {
		throw new RepositoryError("forbidden", "You cannot delete this thread.", 403);
	}
	return softDeleteThread(kv, db, thread, now);
}

export async function deleteComment(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	forumId: string,
	threadId: string,
	commentId: string,
	userId: string,
	now = new Date().toISOString(),
	options: { thread?: ThreadDocument } = {},
): Promise<ThreadDocument> {
	const thread = options.thread?.id === threadId ? options.thread : await readThread(kv, threadId);
	if (thread.forumId !== forumId) {
		throw new RepositoryError("not_found", "Thread not found in this forum.", 404);
	}
	const comment = thread.comments.find((item) => item.id === commentId);
	if (!comment) {
		throw new RepositoryError("not_found", "Comment not found.", 404);
	}
	if (!(await canModerateForumId(db, forumId, userId)) && !(await userOwnsBot(db, userId, comment.authorBotId))) {
		throw new RepositoryError("forbidden", "You cannot delete this comment.", 403);
	}
	return softDeleteComment(kv, db, thread, commentId, now);
}

async function softDeleteForum(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	forum: ForumDocument,
	now: string,
): Promise<ForumDocument> {
	await softDeleteThreadsInForum(kv, db, forum.id, now);
	const deleted: ForumDocument = {
		...forum,
		revision: forum.revision + 1,
		updatedAt: now,
		deletedAt: now,
	};
	await writeJson(kv, kvKeys.forum(deleted.id), deleted);
	await db
		.prepare(`UPDATE forums_index SET updated_at = ?, deleted_at = ? WHERE forum_id = ? AND deleted_at IS NULL`)
		.bind(now, now, deleted.id)
		.run();
	await putObjectIndex(db, deleted, "forum", deleted.worldId);
	await upsertForumSearchIndex(db, deleted);
	return deleted;
}

async function writeWorldRenameDocuments(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	previous: WorldDocument,
	updated: WorldDocument,
	now: string,
): Promise<void> {
	await writeJson(kv, kvKeys.world(updated.id), updated);

	const forums = await db
		.prepare(`SELECT forum_id AS id FROM forums_index WHERE world_id = ? AND deleted_at IS NULL`)
		.bind(updated.id)
		.all<{ id: string }>();
	for (const row of forums.results ?? []) {
		const forum = await forumDocumentById(kv, db, row.id);
		if (forum.worldHandle === updated.handle) {
			continue;
		}
		const renamed: ForumDocument = {
			...forum,
			worldHandle: updated.handle,
			revision: forum.revision + 1,
			updatedAt: now,
		};
		await writeJson(kv, kvKeys.forum(renamed.id), renamed);
		await putObjectIndex(db, renamed, "forum", renamed.worldId);
	}

	const bots = await db
		.prepare(`SELECT bot_id AS id FROM bots_index WHERE home_world_id = ? AND deleted_at IS NULL`)
		.bind(updated.id)
		.all<{ id: string }>();
	for (const row of bots.results ?? []) {
		const bot = await readJson<BotDocument>(kv, kvKeys.bot(row.id));
		if (!bot || bot.deletedAt || bot.homeWorldHandle === updated.handle) {
			continue;
		}
		const renamed: BotDocument = {
			...bot,
			homeWorldHandle: updated.handle,
			revision: bot.revision + 1,
			updatedAt: now,
		};
		await writeJson(kv, kvKeys.bot(renamed.id), renamed);
		await putObjectIndex(db, renamed, "bot", renamed.homeWorldId);
	}

	const threads = await db
		.prepare(`SELECT thread_id AS id FROM threads_index WHERE world_id = ? AND deleted_at IS NULL`)
		.bind(updated.id)
		.all<{ id: string }>();
	for (const row of threads.results ?? []) {
		const thread = await readThread(kv, row.id);
		if (thread.worldHandle === updated.handle) {
			continue;
		}
		const renamed: ThreadDocument = {
			...thread,
			worldHandle: updated.handle,
			revision: thread.revision + 1,
			updatedAt: now,
		};
		await writeJson(kv, kvKeys.thread(renamed.id), renamed);
		await putObjectIndex(db, renamed, "thread", renamed.worldId);
	}

	if (previous.handle !== updated.handle) {
		await putObjectIndex(db, updated, "world", updated.id);
	}
}

async function writeForumRenameDocuments(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	previous: ForumDocument,
	updated: ForumDocument,
	now: string,
): Promise<void> {
	await writeJson(kv, kvKeys.forum(updated.id), updated);

	const threads = await db
		.prepare(`SELECT thread_id AS id FROM threads_index WHERE forum_id = ? AND deleted_at IS NULL`)
		.bind(updated.id)
		.all<{ id: string }>();
	for (const row of threads.results ?? []) {
		const thread = await readThread(kv, row.id);
		if (thread.forumHandle === updated.handle) {
			continue;
		}
		const renamed: ThreadDocument = {
			...thread,
			forumHandle: updated.handle,
			revision: thread.revision + 1,
			updatedAt: now,
		};
		await writeJson(kv, kvKeys.thread(renamed.id), renamed);
		await putObjectIndex(db, renamed, "thread", renamed.worldId);
	}

	if (previous.handle !== updated.handle) {
		await putObjectIndex(db, updated, "forum", updated.worldId);
	}
}

async function worldDocumentByHandle(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
): Promise<WorldDocument> {
	const row = await db
		.prepare(
			`SELECT world_id AS id, deleted_at AS deletedAt
			 FROM worlds_index
			 WHERE handle = ?`,
		)
		.bind(worldHandle)
		.first<{ id: string; deletedAt: string | null }>();
	if (!row || row.deletedAt) {
		throw new RepositoryError("not_found", "World not found.", 404);
	}
	const world = await readJson<WorldDocument>(kv, kvKeys.world(row.id));
	if (!world || world.deletedAt) {
		throw new RepositoryError("not_found", "World not found.", 404);
	}
	return world;
}

async function forumDocumentByHandle(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	forumHandle: string,
): Promise<ForumDocument> {
	const row = await db
		.prepare(
			`SELECT forum_id AS id, deleted_at AS deletedAt
			 FROM forums_index
			 WHERE world_handle = ? AND handle = ?`,
		)
		.bind(worldHandle, forumHandle)
		.first<{ id: string; deletedAt: string | null }>();
	if (!row || row.deletedAt) {
		throw new RepositoryError("not_found", "Forum not found.", 404);
	}
	return forumDocumentById(kv, db, row.id);
}

async function forumDocumentById(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	forumId: string,
): Promise<ForumDocument> {
	const row = await db
		.prepare(`SELECT deleted_at AS deletedAt FROM forums_index WHERE forum_id = ?`)
		.bind(forumId)
		.first<{ deletedAt: string | null }>();
	if (!row || row.deletedAt) {
		throw new RepositoryError("not_found", "Forum not found.", 404);
	}
	const forum = await readJson<ForumDocument>(kv, kvKeys.forum(forumId));
	if (!forum || forum.deletedAt) {
		throw new RepositoryError("not_found", "Forum not found.", 404);
	}
	return forum;
}

function assertWorldOwner(world: WorldDocument, userId: string): void {
	if (world.createdByUserId !== userId) {
		throw new RepositoryError("forbidden", "Only this world's owner can change it.", 403);
	}
}

async function assertCanModerateForum(
	db: D1DatabaseLike,
	forum: ForumDocument,
	userId: string,
): Promise<void> {
	if (forum.createdByUserId === userId || (await userOwnsWorld(db, userId, forum.worldId))) {
		return;
	}
	throw new RepositoryError("forbidden", "Only this forum's owner or world owner can change it.", 403);
}

async function canModerateForumId(
	db: D1DatabaseLike,
	forumId: string,
	userId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT
				f.created_by_user_id AS forumOwnerUserId,
				w.created_by_user_id AS worldOwnerUserId
			 FROM forums_index f
			 JOIN worlds_index w ON w.world_id = f.world_id
			 WHERE f.forum_id = ?
			   AND f.deleted_at IS NULL
			   AND w.deleted_at IS NULL`,
		)
		.bind(forumId)
		.first<{ forumOwnerUserId: string; worldOwnerUserId: string }>();
	return Boolean(row && (row.forumOwnerUserId === userId || row.worldOwnerUserId === userId));
}

async function userOwnsWorld(
	db: D1DatabaseLike,
	userId: string,
	worldId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT world_id AS id
			 FROM worlds_index
			 WHERE world_id = ? AND created_by_user_id = ? AND deleted_at IS NULL`,
		)
		.bind(worldId, userId)
		.first<{ id: string }>();
	return Boolean(row);
}

async function assertWorldHandleAvailable(
	db: D1DatabaseLike,
	currentWorldId: string,
	handle: string,
): Promise<void> {
	const existing = await db
		.prepare(`SELECT world_id AS id FROM worlds_index WHERE handle = ? AND deleted_at IS NULL`)
		.bind(handle)
		.first<{ id: string }>();
	if (existing && existing.id !== currentWorldId) {
		throw new RepositoryError("conflict", "A world with that handle already exists.", 409);
	}
}

async function assertForumHandleAvailable(
	db: D1DatabaseLike,
	worldId: string,
	currentForumId: string,
	handle: string,
): Promise<void> {
	const existing = await db
		.prepare(
			`SELECT forum_id AS id
			 FROM forums_index
			 WHERE world_id = ? AND handle = ? AND deleted_at IS NULL`,
		)
		.bind(worldId, handle)
		.first<{ id: string }>();
	if (existing && existing.id !== currentForumId) {
		throw new RepositoryError("conflict", "A forum with that handle already exists in this world.", 409);
	}
}

async function userOwnsBot(
	db: D1DatabaseLike,
	userId: string,
	botId: string,
): Promise<boolean> {
	const row = await db
		.prepare(`SELECT owner_user_id AS ownerUserId FROM bots_index WHERE bot_id = ?`)
		.bind(botId)
		.first<{ ownerUserId: string }>();
	return row?.ownerUserId === userId;
}

function worldSummary(world: WorldDocument): WorldSummary {
	return {
		id: world.id,
		handle: world.handle,
		name: world.name,
		description: world.description,
		initialBotNotification: world.initialBotNotification,
		...(postingSettingsHasValues(world.postingSettings) ? { postingSettings: world.postingSettings } : {}),
		createdByUserId: world.createdByUserId,
		createdAt: world.createdAt,
		updatedAt: world.updatedAt,
	};
}

function forumSummary(forum: ForumDocument): ForumSummary {
	return {
		id: forum.id,
		worldId: forum.worldId,
		worldHandle: forum.worldHandle,
		handle: forum.handle,
		description: forum.description,
		createdByUserId: forum.createdByUserId,
		...(forum.personalBotId ? { personalBotId: forum.personalBotId } : {}),
		createdAt: forum.createdAt,
		updatedAt: forum.updatedAt,
	};
}
