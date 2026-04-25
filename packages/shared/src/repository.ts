import { makeId, randomToken, sha256Hex } from "./ids";
import {
	schemaVersion,
	type BotDocument,
	type BotSummary,
	type CreateBotInput,
	type CreateForumInput,
	type CreateWorldInput,
	type ForumDocument,
	type ForumSummary,
	type ProviderIdentityDocument,
	type PublicUser,
	type SessionDocument,
	type UpdateBotInput,
	type UserDocument,
	type WorldDocument,
	type WorldSummary,
} from "./model";
import {
	type D1DatabaseLike,
	type KVNamespaceLike,
	kvKeys,
	putObjectIndex,
	readJson,
	writeJson,
} from "./storage";

export class RepositoryError extends Error {
	readonly code: "bad_request" | "conflict" | "forbidden" | "not_found" | "server_error" | "unauthorized";
	readonly status: number;

	constructor(
		code: "bad_request" | "conflict" | "forbidden" | "not_found" | "server_error" | "unauthorized",
		message: string,
		status: number,
	) {
		super(message);
		this.name = "RepositoryError";
		this.code = code;
		this.status = status;
	}
}

export type GithubUserProfile = {
	subject: string;
	login: string;
	displayName?: string;
	email?: string;
	avatarUrl?: string;
};

export type SessionCreateResult = {
	cookieValue: string;
	session: SessionDocument;
};

const sessionTtlSeconds = 60 * 60 * 24 * 30;

export async function upsertGithubUser(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	profile: GithubUserProfile,
	now = new Date().toISOString(),
): Promise<UserDocument> {
	const existingIdentity = await db
		.prepare(
			`SELECT user_id AS userId
			 FROM provider_identities
			 WHERE provider = ? AND provider_subject = ?`,
		)
		.bind("github", profile.subject)
		.first<{ userId: string }>();

	if (existingIdentity) {
		const user = await readJson<UserDocument>(kv, kvKeys.user(existingIdentity.userId));
		if (!user) {
			throw new RepositoryError("server_error", "User document is missing.", 500);
		}

		await db
			.prepare(
				`UPDATE provider_identities
				 SET provider_login = ?, email = ?, avatar_url = ?, updated_at = ?
				 WHERE provider = ? AND provider_subject = ?`,
			)
			.bind(
				profile.login,
				profile.email ?? null,
				profile.avatarUrl ?? null,
				now,
				"github",
				profile.subject,
			)
			.run();

		return user;
	}

	const userId = makeId("usr");
	const providerIdentityId = makeId("pid");
	const handle = await uniqueUserHandle(db, profile.login);
	const displayName = profile.displayName?.trim() || profile.login;
	const user: UserDocument = {
		id: userId,
		type: "user",
		schemaVersion,
		revision: 1,
		handle,
		displayName,
		...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
		createdAt: now,
		updatedAt: now,
	};
	const identity: ProviderIdentityDocument = {
		id: providerIdentityId,
		type: "providerIdentity",
		schemaVersion,
		revision: 1,
		provider: "github",
		providerSubject: profile.subject,
		userId,
		providerLogin: profile.login,
		...(profile.email ? { email: profile.email } : {}),
		...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.user(userId), user);
	await writeJson(kv, kvKeys.providerIdentity("github", profile.subject), identity);
	await db
		.prepare(
			`INSERT INTO users_index (
				user_id, handle, display_name, avatar_url, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
		)
		.bind(user.id, user.handle, user.displayName, user.avatarUrl ?? null, now, now)
		.run();
	await db
		.prepare(
			`INSERT INTO provider_identities (
				provider, provider_subject, user_id, provider_login, email, avatar_url, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			"github",
			profile.subject,
			user.id,
			profile.login,
			profile.email ?? null,
			profile.avatarUrl ?? null,
			now,
			now,
		)
		.run();
	await putObjectIndex(db, user, "user");
	await putObjectIndex(db, identity, "providerIdentity");

	return user;
}

export async function createSession(
	kv: KVNamespaceLike,
	userId: string,
	now = new Date(),
): Promise<SessionCreateResult> {
	const cookieValue = randomToken();
	const sessionHash = await sha256Hex(cookieValue);
	const createdAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + sessionTtlSeconds * 1000).toISOString();
	const session: SessionDocument = {
		id: `sid_${sessionHash.slice(0, 32)}`,
		type: "session",
		schemaVersion,
		revision: 1,
		userId,
		expiresAt,
		createdAt,
		updatedAt: createdAt,
	};

	await writeJson(kv, kvKeys.session(sessionHash), session, { expirationTtl: sessionTtlSeconds });
	return { cookieValue, session };
}

export async function userForSessionToken(
	kv: KVNamespaceLike,
	token: string | null | undefined,
	now = new Date(),
): Promise<UserDocument | null> {
	if (!token) {
		return null;
	}

	const sessionHash = await sha256Hex(token);
	const session = await readJson<SessionDocument>(kv, kvKeys.session(sessionHash));
	if (!session || Date.parse(session.expiresAt) <= now.getTime()) {
		return null;
	}

	return readJson<UserDocument>(kv, kvKeys.user(session.userId));
}

export async function deleteSession(kv: KVNamespaceLike, token: string | null | undefined): Promise<void> {
	if (!token) {
		return;
	}

	await kv.delete(kvKeys.session(await sha256Hex(token)));
}

export function publicUser(user: UserDocument): PublicUser {
	return {
		id: user.id,
		handle: user.handle,
		displayName: user.displayName,
		...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
	};
}

export async function listWorlds(db: D1DatabaseLike): Promise<WorldSummary[]> {
	const result = await db
		.prepare(
			`SELECT
				world_id AS id,
				handle,
				name,
				description,
				created_by_user_id AS createdByUserId,
				created_at AS createdAt,
				updated_at AS updatedAt
			 FROM worlds_index
			 WHERE deleted_at IS NULL
			 ORDER BY updated_at DESC, handle ASC`,
		)
		.all<WorldSummary>();

	return result.results ?? [];
}

export async function createWorld(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	input: CreateWorldInput,
	userId: string,
	now = new Date().toISOString(),
): Promise<WorldSummary> {
	const existing = await db
		.prepare(`SELECT world_id AS id FROM worlds_index WHERE handle = ? AND deleted_at IS NULL`)
		.bind(input.handle)
		.first<{ id: string }>();
	if (existing) {
		throw new RepositoryError("conflict", "A world with that handle already exists.", 409);
	}

	const world: WorldDocument = {
		id: makeId("wld"),
		type: "world",
		schemaVersion,
		revision: 1,
		handle: input.handle,
		name: input.name,
		description: input.description,
		createdByUserId: userId,
		visibility: "public",
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.world(world.id), world);
	await db
		.prepare(
			`INSERT INTO worlds_index (
				world_id, handle, name, description, created_by_user_id, visibility, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		)
		.bind(
			world.id,
			world.handle,
			world.name,
			world.description,
			world.createdByUserId,
			world.visibility,
			now,
			now,
		)
		.run();
	await putObjectIndex(db, world, "world", world.id);

	return worldSummary(world);
}

export async function listForums(db: D1DatabaseLike, worldHandle: string): Promise<ForumSummary[]> {
	const world = await worldByHandle(db, worldHandle);
	const result = await db
		.prepare(
			`SELECT
				forum_id AS id,
				world_id AS worldId,
				world_handle AS worldHandle,
				handle,
				description,
				created_by_user_id AS createdByUserId,
				created_at AS createdAt,
				updated_at AS updatedAt
			 FROM forums_index
			 WHERE world_id = ? AND deleted_at IS NULL
			 ORDER BY updated_at DESC, handle ASC`,
		)
		.bind(world.id)
		.all<ForumSummary>();

	return result.results ?? [];
}

export async function createForum(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	input: CreateForumInput,
	userId: string,
	now = new Date().toISOString(),
): Promise<ForumSummary> {
	const world = await worldByHandle(db, worldHandle);
	const existing = await db
		.prepare(
			`SELECT forum_id AS id
			 FROM forums_index
			 WHERE world_id = ? AND handle = ? AND deleted_at IS NULL`,
		)
		.bind(world.id, input.handle)
		.first<{ id: string }>();
	if (existing) {
		throw new RepositoryError("conflict", "A forum with that handle already exists in this world.", 409);
	}

	const forum: ForumDocument = {
		id: makeId("frm"),
		type: "forum",
		schemaVersion,
		revision: 1,
		worldId: world.id,
		worldHandle: world.handle,
		handle: input.handle,
		description: input.description,
		createdByUserId: userId,
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.forum(forum.id), forum);
	await db
		.prepare(
			`INSERT INTO forums_index (
				forum_id, world_id, world_handle, handle, description, created_by_user_id, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		)
		.bind(
			forum.id,
			forum.worldId,
			forum.worldHandle,
			forum.handle,
			forum.description,
			forum.createdByUserId,
			now,
			now,
		)
		.run();
	await putObjectIndex(db, forum, "forum", forum.worldId);

	return forumSummary(forum);
}

export async function listUserBots(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
): Promise<BotSummary[]> {
	const result = await db
		.prepare(
			`SELECT bot_id AS id
			 FROM bots_index
			 WHERE owner_user_id = ? AND deleted_at IS NULL
			 ORDER BY updated_at DESC, handle ASC`,
		)
		.bind(userId)
		.all<{ id: string }>();
	const rows = result.results ?? [];
	const bots = await Promise.all(rows.map((row) => readJson<BotDocument>(kv, kvKeys.bot(row.id))));

	return bots.filter((bot): bot is BotDocument => Boolean(bot && !bot.deletedAt)).map(botSummary);
}

export async function createBot(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	input: CreateBotInput,
	userId: string,
	now = new Date().toISOString(),
): Promise<BotSummary> {
	const world = await worldByHandle(db, worldHandle);
	const existing = await db
		.prepare(
			`SELECT bot_id AS id
			 FROM bots_index
			 WHERE home_world_id = ? AND handle = ? AND deleted_at IS NULL`,
		)
		.bind(world.id, input.handle)
		.first<{ id: string }>();
	if (existing) {
		throw new RepositoryError("conflict", "A bot with that handle already exists in this world.", 409);
	}

	const bot: BotDocument = {
		id: makeId("bot"),
		type: "bot",
		schemaVersion,
		revision: 1,
		homeWorldId: world.id,
		homeWorldHandle: world.handle,
		ownerUserId: userId,
		handle: input.handle,
		displayName: input.displayName,
		shortBio: input.shortBio,
		prompt: input.prompt,
		...(input.importSource ? { importSource: input.importSource } : {}),
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.bot(bot.id), bot);
	await upsertBotIndex(db, bot);
	if (bot.importSource) {
		await db
			.prepare(
				`INSERT INTO bot_imports (
					bot_id, world_id, owner_user_id, provider, external_handle, external_profile_url, imported_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				bot.id,
				bot.homeWorldId,
				bot.ownerUserId,
				bot.importSource.provider,
				bot.importSource.originalHandle,
				bot.importSource.originalProfileUrl,
				bot.importSource.importedAt,
			)
			.run();
	}
	await putObjectIndex(db, bot, "bot", bot.homeWorldId);

	return botSummary(bot);
}

export async function updateBot(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	userId: string,
	input: UpdateBotInput,
	now = new Date().toISOString(),
): Promise<BotSummary> {
	const bot = await botForOwner(kv, db, botId, userId);
	const updated: BotDocument = {
		...bot,
		...input,
		revision: bot.revision + 1,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.bot(updated.id), updated);
	await upsertBotIndex(db, updated);
	await putObjectIndex(db, updated, "bot", updated.homeWorldId);

	return botSummary(updated);
}

export async function deleteBot(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	userId: string,
	now = new Date().toISOString(),
): Promise<BotSummary> {
	const bot = await botForOwner(kv, db, botId, userId);
	const deleted: BotDocument = {
		...bot,
		revision: bot.revision + 1,
		updatedAt: now,
		deletedAt: now,
	};

	await writeJson(kv, kvKeys.bot(deleted.id), deleted);
	await upsertBotIndex(db, deleted);
	await putObjectIndex(db, deleted, "bot", deleted.homeWorldId);

	return botSummary(deleted);
}

export async function worldByHandle(
	db: D1DatabaseLike,
	worldHandle: string,
): Promise<{ id: string; handle: string }> {
	const world = await db
		.prepare(
			`SELECT world_id AS id, handle
			 FROM worlds_index
			 WHERE handle = ? AND deleted_at IS NULL`,
		)
		.bind(worldHandle)
		.first<{ id: string; handle: string }>();
	if (!world) {
		throw new RepositoryError("not_found", "World not found.", 404);
	}

	return world;
}

async function botForOwner(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	userId: string,
): Promise<BotDocument> {
	const row = await db
		.prepare(
			`SELECT owner_user_id AS ownerUserId, deleted_at AS deletedAt
			 FROM bots_index
			 WHERE bot_id = ?`,
		)
		.bind(botId)
		.first<{ ownerUserId: string; deletedAt: string | null }>();
	if (!row || row.deletedAt) {
		throw new RepositoryError("not_found", "Bot not found.", 404);
	}
	if (row.ownerUserId !== userId) {
		throw new RepositoryError("forbidden", "You can only edit your own bots.", 403);
	}

	const bot = await readJson<BotDocument>(kv, kvKeys.bot(botId));
	if (!bot || bot.deletedAt) {
		throw new RepositoryError("not_found", "Bot not found.", 404);
	}

	return bot;
}

async function upsertBotIndex(db: D1DatabaseLike, bot: BotDocument): Promise<void> {
	await db
		.prepare(
			`INSERT INTO bots_index (
				bot_id, home_world_id, home_world_handle, handle, display_name, owner_user_id,
				short_bio, import_provider, import_external_handle, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(bot_id) DO UPDATE SET
				display_name = excluded.display_name,
				short_bio = excluded.short_bio,
				updated_at = excluded.updated_at,
				deleted_at = excluded.deleted_at`,
		)
		.bind(
			bot.id,
			bot.homeWorldId,
			bot.homeWorldHandle,
			bot.handle,
			bot.displayName,
			bot.ownerUserId,
			bot.shortBio,
			bot.importSource?.provider ?? null,
			bot.importSource?.originalHandle ?? null,
			bot.createdAt,
			bot.updatedAt,
			bot.deletedAt ?? null,
		)
		.run();
}

async function uniqueUserHandle(db: D1DatabaseLike, preferred: string): Promise<string> {
	const base = preferred
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9-]/g, "-")
		.replaceAll(/^-+|-+$/g, "")
		.slice(0, 24) || "user";

	for (let attempt = 0; attempt < 50; attempt += 1) {
		const handle = attempt === 0 ? base : `${base}-${attempt + 1}`;
		const existing = await db
			.prepare(`SELECT user_id AS id FROM users_index WHERE handle = ?`)
			.bind(handle)
			.first<{ id: string }>();
		if (!existing) {
			return handle;
		}
	}

	return `${base}-${randomToken(4)}`;
}

function worldSummary(world: WorldDocument): WorldSummary {
	return {
		id: world.id,
		handle: world.handle,
		name: world.name,
		description: world.description,
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
		createdAt: forum.createdAt,
		updatedAt: forum.updatedAt,
	};
}

function botSummary(bot: BotDocument): BotSummary {
	return {
		id: bot.id,
		homeWorldId: bot.homeWorldId,
		homeWorldHandle: bot.homeWorldHandle,
		ownerUserId: bot.ownerUserId,
		handle: bot.handle,
		displayName: bot.displayName,
		shortBio: bot.shortBio,
		prompt: bot.prompt,
		...(bot.importSource ? { importSource: bot.importSource } : {}),
		createdAt: bot.createdAt,
		updatedAt: bot.updatedAt,
	};
}
