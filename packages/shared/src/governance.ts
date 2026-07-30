import {
	avatarCropJson,
	type AvatarImage,
	type ForumDocument,
	type ForumSummary,
	type ThreadDocument,
	type UpdateForumInput,
	type UpdateWorldInput,
	type WorldDocument,
	type WorldSummary,
} from "./model";
import { tombstoneHandle } from "./handles";
import { objectIndexScopeStaleStatement } from "./object-index-scope";
import { entityIndexVersions } from "./index-versions";
import {
	mergePostingSettings,
	postingSettingsHasValues,
} from "./posting";
import {
	effectiveThreadSettings,
	mergeThreadSettings,
	threadSettingsHasValues,
} from "./thread-policy";
import {
	assertWorldRecurringPromptConfiguration,
	assertThreadSettingsInputWithinLimit,
	mergeImageGenerationSettings,
	normalizeForumDefaults,
	normalizeWorldDefaults,
	RepositoryError,
	softDeleteBotGroupsForWorld,
	worldIndexProjectionStatement,
	worldSummaryFromDocument,
} from "./repository";
import { upsertForumSearchIndex, upsertWorldSearchIndex } from "./search";
import {
	readThread,
	recordWorldSettingsChangedHumanNotifications,
	rootCommentForThread,
	softDeleteComment,
	softDeleteThread,
} from "./social";
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
	const threadSettings = mergeThreadSettings(world.threadSettings, input.threadSettings);
	const imageGeneration = input.imageGeneration === undefined ?
		world.imageGeneration
	:	mergeImageGenerationSettings(world.imageGeneration, input.imageGeneration);
	const updated: WorldDocument = {
		...world,
		...input,
		handle: nextHandle,
		...(postingSettingsHasValues(postingSettings) ? { postingSettings } : { postingSettings: undefined }),
		...(threadSettingsHasValues(threadSettings) ? { threadSettings } : { threadSettings: undefined }),
		...(imageGeneration ? { imageGeneration } : { imageGeneration: undefined }),
		revision: world.revision + 1,
		updatedAt: now,
	};
	assertWorldRecurringPromptConfiguration(updated);
	if (nextHandle !== world.handle) {
		const [projectionResult] = await db.batch([
			worldIndexProjectionStatement(db, updated),
			db
				.prepare(
					`UPDATE forums_index
					 SET world_handle = ?, updated_at = ?
					 WHERE world_id = ? AND deleted_at IS NULL
					   AND EXISTS (SELECT 1 FROM worlds_index WHERE world_id = ? AND deleted_at IS NULL)`,
				)
				.bind(updated.handle, now, updated.id, updated.id),
			db
				.prepare(
					`UPDATE bots_index
					 SET home_world_handle = ?, updated_at = ?
					 WHERE home_world_id = ? AND deleted_at IS NULL
					   AND EXISTS (SELECT 1 FROM worlds_index WHERE world_id = ? AND deleted_at IS NULL)`,
				)
				.bind(updated.handle, now, updated.id, updated.id),
			db
				.prepare(
					`UPDATE threads_index
					 SET world_handle = ?
					 WHERE world_id = ? AND deleted_at IS NULL
					   AND EXISTS (SELECT 1 FROM worlds_index WHERE world_id = ? AND deleted_at IS NULL)`,
				)
				.bind(updated.handle, updated.id, updated.id),
			objectIndexScopeStaleStatement(
				db,
				{ kind: "world", worldId: updated.id },
				{ includeScopeRoot: false, requireLiveScopeRoot: true },
			),
		]);
		if ((projectionResult?.meta?.changes ?? 0) < 1) {
			throw new RepositoryError("not_found", "World not found.", 404);
		}
		await writeJson(kv, kvKeys.world(updated.id), updated);
	} else {
		const projectionResult = await worldIndexProjectionStatement(db, updated).run();
		if ((projectionResult.meta?.changes ?? 0) < 1) {
			throw new RepositoryError("not_found", "World not found.", 404);
		}
		await writeJson(kv, kvKeys.world(updated.id), updated);
	}
	await upsertWorldSearchIndex(db, updated);
	await putObjectIndex(db, updated, "world", entityIndexVersions.world, updated.id);
	await recordWorldSettingsChangedHumanNotifications(db, { previous: world, updated, editorUserId: userId, now });
	return worldSummaryFromDocument(updated);
}

export async function updateWorldAvatar(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	userId: string,
	avatar: AvatarImage | undefined,
	now = new Date().toISOString(),
): Promise<WorldSummary> {
	const world = await worldDocumentByHandle(kv, db, worldHandle);
	assertWorldOwner(world, userId);
	const updated: WorldDocument = {
		...world,
		...(avatar ? { avatar } : { avatar: undefined }),
		revision: world.revision + 1,
		updatedAt: now,
	};
	await writeJson(kv, kvKeys.world(updated.id), updated);
	await db
		.prepare(
			`UPDATE worlds_index
			 SET avatar_url = ?, avatar_crop = ?, updated_at = ?
			 WHERE world_id = ? AND deleted_at IS NULL`,
		)
		.bind(updated.avatar?.url ?? null, avatarCropJson(updated.avatar?.crop), now, updated.id)
		.run();
	await upsertWorldSearchIndex(db, updated);
	await putObjectIndex(db, updated, "world", entityIndexVersions.world, updated.id);
	await recordWorldSettingsChangedHumanNotifications(db, { previous: world, updated, editorUserId: userId, now });
	return worldSummaryFromDocument(updated);
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

	await softDeleteBotGroupsForWorld(db, world.id, now);

	const tombstonedHandle = tombstoneHandle(world.id);
	const deleted: WorldDocument = {
		...world,
		handle: tombstonedHandle,
		handleAtDeletion: world.handleAtDeletion ?? world.handle,
		revision: world.revision + 1,
		updatedAt: now,
		deletedAt: now,
	};
	await writeJson(kv, kvKeys.world(deleted.id), deleted);
	await db
		.prepare(`UPDATE worlds_index SET handle = ?, updated_at = ?, deleted_at = ? WHERE world_id = ? AND deleted_at IS NULL`)
		.bind(tombstonedHandle, now, now, deleted.id)
		.run();
	await upsertWorldSearchIndex(db, deleted);
	await putObjectIndex(db, deleted, "world", entityIndexVersions.world, deleted.id);
	return worldSummaryFromDocument(deleted);
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
	const world = await worldDocumentByHandle(kv, db, worldHandle);
	if (world.id !== forum.worldId) {
		throw new RepositoryError("not_found", "Forum not found in this world.", 404);
	}
	assertThreadSettingsInputWithinLimit(
		input.threadSettings,
		effectiveThreadSettings(world.threadSettings, undefined).commentLimit,
	);
	const nextHandle = input.handle ?? forum.handle;
	if (nextHandle !== forum.handle) {
		await assertForumHandleAvailable(db, forum.worldId, forum.id, nextHandle);
	}
	const threadSettings = mergeThreadSettings(forum.threadSettings, input.threadSettings);
	const updated: ForumDocument = {
		...forum,
		...input,
		handle: nextHandle,
		...(threadSettingsHasValues(threadSettings) ? { threadSettings } : { threadSettings: undefined }),
		revision: forum.revision + 1,
		updatedAt: now,
	};
	if (nextHandle !== forum.handle) {
		await db.batch([
			db
				.prepare(
					`UPDATE forums_index
					 SET handle = ?, language = ?, description = ?, description_lang = ?, thread_comment_limit = ?, updated_at = ?
					 WHERE forum_id = ? AND deleted_at IS NULL`,
				)
				.bind(
					updated.handle,
					updated.language,
					updated.description.text,
					updated.description.lang,
					updated.threadSettings?.commentLimit ?? null,
					now,
					updated.id,
				),
			db
				.prepare(`UPDATE threads_index SET forum_handle = ? WHERE forum_id = ? AND deleted_at IS NULL`)
				.bind(updated.handle, updated.id),
			objectIndexScopeStaleStatement(db, { kind: "forum", forumId: updated.id }, { includeScopeRoot: false }),
		]);
		await writeJson(kv, kvKeys.forum(updated.id), updated);
	} else {
		await db
			.prepare(
				`UPDATE forums_index
				 SET language = ?, description = ?, description_lang = ?, thread_comment_limit = ?, updated_at = ?
				 WHERE forum_id = ? AND deleted_at IS NULL`,
			)
			.bind(
				updated.language,
				updated.description.text,
				updated.description.lang,
				updated.threadSettings?.commentLimit ?? null,
				now,
				updated.id,
			)
			.run();
		await writeJson(kv, kvKeys.forum(updated.id), updated);
	}
	await upsertForumSearchIndex(db, updated);
	await putObjectIndex(db, updated, "forum", entityIndexVersions.forum, updated.worldId);
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
	const deleted = await markForumDeleted(kv, db, forum, now);
	return forumSummary(deleted);
}

export async function deleteForumForWorld(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldId: string,
	forumId: string,
	now: string,
): Promise<ForumDocument> {
	const forum = await readJson<ForumDocument>(kv, kvKeys.forum(forumId));
	if (!forum || forum.id !== forumId || forum.worldId !== worldId) {
		throw new RepositoryError("not_found", "Forum not found in this world.", 404);
	}
	const normalized = normalizeForumDefaults(forum);
	return markForumDeleted(kv, db, normalized, normalized.deletedAt ?? now);
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

async function markForumDeleted(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	forum: ForumDocument,
	now: string,
): Promise<ForumDocument> {
	const tombstonedHandle = tombstoneHandle(forum.id);
	const deleted: ForumDocument = forum.deletedAt ? forum : {
		...forum,
		handle: tombstonedHandle,
		handleAtDeletion: forum.handleAtDeletion ?? forum.handle,
		revision: forum.revision + 1,
		updatedAt: now,
		deletedAt: now,
	};
	await writeJson(kv, kvKeys.forum(deleted.id), deleted);
	await db
		.prepare(`UPDATE forums_index SET handle = ?, updated_at = ?, deleted_at = ? WHERE forum_id = ? AND deleted_at IS NULL`)
		.bind(tombstonedHandle, now, now, deleted.id)
		.run();
	await upsertForumSearchIndex(db, deleted);
	await putObjectIndex(db, deleted, "forum", entityIndexVersions.forum, deleted.worldId);
	return deleted;
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
	return normalizeWorldDefaults(world);
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
	return normalizeForumDefaults(forum);
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

function forumSummary(forum: ForumDocument): ForumSummary {
	return {
		id: forum.id,
		worldId: forum.worldId,
		worldHandle: forum.worldHandle,
		handle: forum.handle,
		language: forum.language,
		description: forum.description,
		createdByUserId: forum.createdByUserId,
		...(forum.personalBotId ? { personalBotId: forum.personalBotId } : {}),
		...(threadSettingsHasValues(forum.threadSettings) ? { threadSettings: forum.threadSettings } : {}),
		createdAt: forum.createdAt,
		updatedAt: forum.updatedAt,
	};
}
