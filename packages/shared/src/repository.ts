import { makeId, randomToken, sha256Hex } from "./ids";
import {
	schemaVersion,
	authProviders,
	avatarCropFromJson,
	avatarCropJson,
	defaultTranslationPrompt,
	type AvatarImage,
	type AuthProvider,
	type BotCloneSource,
	type BotCloneSourceSummary,
	type BotImageGenerationSettings,
	type BotImageGenerationSettingsInput,
	type BotInferenceSettingsInput,
	type BotInferenceSettings,
	type BotCompactionMode,
	type BotInferenceToolCalls,
	type BotInferenceReasoningEffort,
	type BotDocument,
	type BotEffectivePostingSettings,
	type BotEffectiveTickSettings,
	type BotLocalOverrides,
	type BotPublicProfile,
	type BotSummary,
	type BotStructuredToolCalls,
	type BotTranslationSettings,
	type BotTranslationSettingsInput,
	type BotToolSettings,
	type BotToolSettingsInput,
	type BotTickSettings,
	type BotTickSettingsInput,
	type CreateBotInput,
	type CreateForumInput,
	type CreateWorldInput,
	type ApiErrorDetails,
	type OpenRouterDatetimeToolSettings,
	type OpenRouterDatetimeToolSettingsInput,
	type OpenRouterServerToolSettings,
	type OpenRouterServerToolSettingsInput,
	type OpenRouterWebFetchToolSettings,
	type OpenRouterWebFetchToolSettingsInput,
	type OpenRouterWebSearchToolSettings,
	type OpenRouterWebSearchToolSettingsInput,
	type OpenRouterWebSearchUserLocation,
	type OpenRouterWebSearchUserLocationInput,
	type ForumDocument,
	type ForumSummary,
	type HumanOwnedBotGroup,
	type HumanOwnedForumGroup,
	type HumanProfile,
	type HumanProfileDeleteBlocker,
	type HumanProfileDeleteEligibility,
	type JsonObject,
	type LinkedAuthIdentity,
	type PostingSettings,
	type PostingSettingsInput,
	type PublicUser,
	type SessionDocument,
	type ThreadDocument,
	type UpdateBotInput,
	type UpdateUserProfileInput,
	type UserDocument,
	type UserProfile,
	type WorldDocument,
	type WorldListSummary,
	type WorldSummary,
} from "./model";
import {
	effectivePostingSettings,
	mergePostingSettings,
	postingSettingsHasValues,
} from "./posting";
import { upsertBotSearchIndex, upsertForumSearchIndex, upsertWorldSearchIndex } from "./search";
import {
	type D1DatabaseLike,
	type D1PreparedStatementLike,
	type KVNamespaceLike,
	deleteKey,
	kvKeys,
	putObjectIndex,
	readJson,
	writeJson,
} from "./storage";
import { slugifyHandle } from "./validation";

export class RepositoryError extends Error {
	readonly code: "bad_request" | "conflict" | "forbidden" | "not_found" | "server_error" | "unauthorized";
	readonly status: number;
	readonly details?: RepositoryErrorDetails;

	constructor(
		code: "bad_request" | "conflict" | "forbidden" | "not_found" | "server_error" | "unauthorized",
		message: string,
		status: number,
		details?: RepositoryErrorDetails,
	) {
		super(message);
		this.name = "RepositoryError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

export type RepositoryErrorDetails = ApiErrorDetails;

export type ProviderUserProfile = {
	provider: AuthProvider;
	subject: string;
	login: string;
	displayName?: string;
	email?: string;
	avatarUrl?: string;
};

type ProviderIdentityRow = {
	provider: string;
	providerSubject: string;
	userId: string;
	providerLogin: string;
	email: string | null;
	avatarUrl: string | null;
	createdAt: string;
	updatedAt: string;
};

type PublicUserIndexRow = {
	id: string;
	handle: string;
	displayName: string;
	avatarUrl: string | null;
	profileCompletedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

type WorldSummaryIndexRow = Omit<WorldSummary, "postingSettings"> & {
	postingThreadBodyCharacters: number | null;
	postingCommentBodyCharacters: number | null;
};

type BotCloneSourceRow = {
	botId: string;
	sourceBotId: string;
	sourceWorldId: string;
	sourceWorldHandle: string;
	sourceHandle: string;
	clonedAt: string;
	linked: number;
	unlinkedAt: string | null;
	relinkedAt: string | null;
};

export type SessionCreateResult = {
	cookieValue: string;
	session: SessionDocument;
};

const sessionTtlSeconds = 60 * 60 * 24 * 30;
export const defaultInitialBotNotification =
	"You have just finished creating your Bickr account and logged in for the first time.";
export const introForumHandle = "intro";
const introForumDescription = "Introductions, first threads, and orientation for new participants in this world.";
export const defaultTickSettings: BotEffectiveTickSettings = {
	enabled: false,
	intervalSeconds: 86_400,
	allowEarlyLogOff: false,
	contextWindowTokens: 20_000,
	compactionThreshold: 0.75,
	compactionSummaryPercent: 10,
	compactionMaxCharacters: 4_000,
	maxToolCallsPerTick: 10,
	maxSuccessfulToolCallsPerIteration: 8,
	maxGeneratedTokensPerTick: 15_000,
	maxGeneratedTokensPerIteration: 30_000,
};
export const defaultInferenceSettings: BotInferenceSettings = {};
export const defaultToolSettings: BotToolSettings = {};

export type CreateBotOptions = {
	now?: string;
	prepareAvatar?: (bot: BotDocument) => Promise<AvatarImage | undefined>;
	cloneSource?: BotDocument;
};

export type DeleteBotOptions = {
	now?: string;
	allowLinkedCloneDelete?: boolean;
};

export type CloneSourceBackfillResult = {
	groups: number;
	clonesLinked: number;
	clonesSkipped: number;
};

export async function upsertProviderUser(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	input: ProviderUserProfile,
	now = new Date().toISOString(),
): Promise<UserDocument> {
	const profile = normalizeProviderProfile(input);
	const existingIdentity = await providerIdentityBySubject(db, profile.provider, profile.subject);

	if (existingIdentity) {
		const user = await readJson<UserDocument>(kv, kvKeys.user(existingIdentity.userId));
		if (!user) {
			throw new RepositoryError("server_error", "User document is missing.", 500);
		}

		await updateProviderIdentity(db, profile, now);

		return normalizeUserDefaults(user);
	}

	const userId = makeId("usr");
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

	await writeJson(kv, kvKeys.user(userId), user);
	await db
		.prepare(
			`INSERT INTO users_index (
				user_id, handle, display_name, avatar_url, profile_completed_at, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)`,
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
			profile.provider,
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

	return user;
}

export async function linkProviderIdentity(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
	input: ProviderUserProfile,
	now = new Date().toISOString(),
): Promise<UserDocument> {
	const profile = normalizeProviderProfile(input);
	const user = await userById(kv, userId);
	const existingIdentity = await providerIdentityBySubject(db, profile.provider, profile.subject);
	if (existingIdentity) {
		if (existingIdentity.userId !== user.id) {
			throw new RepositoryError(
				"conflict",
				`That ${providerLabel(profile.provider)} account is already linked to another Bickr account.`,
				409,
			);
		}
		await updateProviderIdentity(db, profile, now);
		return user;
	}

	const existingProviderForUser = await providerIdentityForUserProvider(db, user.id, profile.provider);
	if (existingProviderForUser) {
		throw new RepositoryError(
			"conflict",
			`This account already has a ${providerLabel(profile.provider)} sign-in method linked.`,
			409,
		);
	}

	await db
		.prepare(
			`INSERT INTO provider_identities (
				provider, provider_subject, user_id, provider_login, email, avatar_url, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			profile.provider,
			profile.subject,
			user.id,
			profile.login,
			profile.email ?? null,
			profile.avatarUrl ?? null,
			now,
			now,
		)
		.run();

	return user;
}

export async function unlinkProviderIdentity(
	db: D1DatabaseLike,
	userId: string,
	provider: AuthProvider,
): Promise<LinkedAuthIdentity[]> {
	const identities = await listUserAuthIdentities(db, userId);
	if (!identities.some((identity) => identity.provider === provider)) {
		throw new RepositoryError("not_found", "Sign-in method is not linked to this account.", 404);
	}
	if (identities.length <= 1) {
		throw new RepositoryError("conflict", "At least one sign-in method must remain linked.", 409);
	}

	const result = await db
		.prepare(
			`DELETE FROM provider_identities
			 WHERE provider = ? AND user_id = ?
			 AND EXISTS (
				SELECT 1
				FROM provider_identities AS remaining
				WHERE remaining.user_id = provider_identities.user_id
					AND remaining.provider != provider_identities.provider
			 )`,
		)
		.bind(provider, userId)
		.run();
	if ((result.meta?.changes ?? 0) < 1) {
		throw new RepositoryError("conflict", "At least one sign-in method must remain linked.", 409);
	}

	return listUserAuthIdentities(db, userId);
}

export async function listUserAuthIdentities(
	db: D1DatabaseLike,
	userId: string,
): Promise<LinkedAuthIdentity[]> {
	const result = await db
		.prepare(
			`SELECT
				provider,
				provider_subject AS providerSubject,
				user_id AS userId,
				provider_login AS providerLogin,
				email,
				avatar_url AS avatarUrl,
				created_at AS createdAt,
				updated_at AS updatedAt
			 FROM provider_identities
			 WHERE user_id = ?
			 ORDER BY provider ASC`,
		)
		.bind(userId)
		.all<ProviderIdentityRow>();

	return (result.results ?? []).flatMap((row) => {
		const provider = authProviderFromString(row.provider);
		if (!provider) {
			return [];
		}
		return [
			{
				provider,
				providerLogin: row.providerLogin,
				...(row.email ? { email: row.email } : {}),
				...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
			},
		];
	});
}

function normalizeProviderProfile(profile: ProviderUserProfile): ProviderUserProfile {
	const provider = authProviderFromString(profile.provider);
	if (!provider) {
		throw new RepositoryError("bad_request", "Auth provider is not supported.", 400);
	}

	const subject = profile.subject.trim();
	const login = profile.login.trim();
	if (!subject || !login) {
		throw new RepositoryError("bad_request", "Provider profile is missing required fields.", 400);
	}

	const displayName = profile.displayName?.trim();
	const email = profile.email?.trim();
	const avatarUrl = profile.avatarUrl?.trim();
	return {
		provider,
		subject,
		login,
		...(displayName ? { displayName } : {}),
		...(email ? { email } : {}),
		...(avatarUrl ? { avatarUrl } : {}),
	};
}

function authProviderFromString(value: string): AuthProvider | null {
	return (authProviders as readonly string[]).includes(value) ? (value as AuthProvider) : null;
}

function providerLabel(provider: AuthProvider): string {
	return provider === "github" ? "GitHub" : "Google";
}

async function providerIdentityBySubject(
	db: D1DatabaseLike,
	provider: AuthProvider,
	subject: string,
): Promise<ProviderIdentityRow | null> {
	return db
		.prepare(
			`SELECT
				provider,
				provider_subject AS providerSubject,
				user_id AS userId,
				provider_login AS providerLogin,
				email,
				avatar_url AS avatarUrl,
				created_at AS createdAt,
				updated_at AS updatedAt
			 FROM provider_identities
			 WHERE provider = ? AND provider_subject = ?`,
		)
		.bind(provider, subject)
		.first<ProviderIdentityRow>();
}

async function providerIdentityForUserProvider(
	db: D1DatabaseLike,
	userId: string,
	provider: AuthProvider,
): Promise<ProviderIdentityRow | null> {
	return db
		.prepare(
			`SELECT
				provider,
				provider_subject AS providerSubject,
				user_id AS userId,
				provider_login AS providerLogin,
				email,
				avatar_url AS avatarUrl,
				created_at AS createdAt,
				updated_at AS updatedAt
			 FROM provider_identities
			 WHERE user_id = ? AND provider = ?`,
		)
		.bind(userId, provider)
		.first<ProviderIdentityRow>();
}

async function updateProviderIdentity(
	db: D1DatabaseLike,
	profile: ProviderUserProfile,
	now: string,
): Promise<void> {
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
			profile.provider,
			profile.subject,
		)
		.run();
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

	const user = await readJson<UserDocument>(kv, kvKeys.user(session.userId));
	return user && !user.deletedAt ? user : null;
}

export async function userById(kv: KVNamespaceLike, userId: string): Promise<UserDocument> {
	const user = await readJson<UserDocument>(kv, kvKeys.user(userId));
	if (!user || user.deletedAt) {
		throw new RepositoryError("not_found", "User not found.", 404);
	}
	return normalizeUserDefaults(user);
}

export async function deleteSession(kv: KVNamespaceLike, token: string | null | undefined): Promise<void> {
	if (!token) {
		return;
	}

	await deleteKey(kv, kvKeys.session(await sha256Hex(token)));
}

export function publicUser(user: UserDocument): PublicUser {
	return {
		id: user.id,
		handle: user.handle,
		displayName: user.displayName,
		...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
		profileComplete: Boolean(user.profileCompletedAt),
		...(user.profileCompletedAt ? { profileCompletedAt: user.profileCompletedAt } : {}),
	};
}

function publicUserFromIndexRow(row: PublicUserIndexRow): PublicUser {
	return {
		id: row.id,
		handle: row.handle,
		displayName: row.displayName,
		...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
		profileComplete: Boolean(row.profileCompletedAt),
		...(row.profileCompletedAt ? { profileCompletedAt: row.profileCompletedAt } : {}),
	};
}

export function userProfile(user: UserDocument, authIdentities: LinkedAuthIdentity[] = []): UserProfile {
	const normalized = normalizeUserDefaults(user);
	return {
		...publicUser(normalized),
		authIdentities,
		inferenceSettings: publicInferenceSettings(normalized.inferenceSettings),
		createdAt: normalized.createdAt,
		updatedAt: normalized.updatedAt,
	};
}

export async function publicUserByHandle(db: D1DatabaseLike, handle: string): Promise<PublicUser> {
	const row = await db
		.prepare(
			`SELECT
				user_id AS id,
				handle,
				display_name AS displayName,
				avatar_url AS avatarUrl,
				profile_completed_at AS profileCompletedAt,
				created_at AS createdAt,
				updated_at AS updatedAt
			 FROM users_index
			 WHERE handle = ? AND deleted_at IS NULL`,
		)
		.bind(handle)
		.first<PublicUserIndexRow>();
	if (!row) {
		throw new RepositoryError("not_found", "Profile not found.", 404);
	}
	return publicUserFromIndexRow(row);
}

export async function publicUserById(db: D1DatabaseLike, userId: string): Promise<PublicUser> {
	const users = await publicUsersByIds(db, [userId]);
	const user = users.get(userId);
	if (!user) {
		throw new RepositoryError("not_found", "Profile not found.", 404);
	}
	return user;
}

async function publicUsersByIds(db: D1DatabaseLike, userIds: string[]): Promise<Map<string, PublicUser>> {
	const ids = [...new Set(userIds.filter(Boolean))];
	const users = new Map<string, PublicUser>();
	for (let index = 0; index < ids.length; index += 90) {
		const batch = ids.slice(index, index + 90);
		if (batch.length === 0) {
			continue;
		}
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT
					user_id AS id,
					handle,
					display_name AS displayName,
					avatar_url AS avatarUrl,
					profile_completed_at AS profileCompletedAt,
					created_at AS createdAt,
					updated_at AS updatedAt
				 FROM users_index
				 WHERE user_id IN (${placeholders}) AND deleted_at IS NULL`,
			)
			.bind(...batch)
			.all<PublicUserIndexRow>();
		for (const row of result.results ?? []) {
			users.set(row.id, publicUserFromIndexRow(row));
		}
	}
	return users;
}

export function botPublicProfile(bot: BotDocument | BotSummary): BotPublicProfile {
	return {
		id: bot.id,
		homeWorldId: bot.homeWorldId,
		homeWorldHandle: bot.homeWorldHandle,
		handle: bot.handle,
		displayName: bot.displayName,
		shortBio: bot.shortBio,
		...("avatarUrl" in bot && bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : "avatar" in bot && bot.avatar ? { avatarUrl: bot.avatar.url } : {}),
		...("avatarCrop" in bot && bot.avatarCrop ? { avatarCrop: bot.avatarCrop } : "avatar" in bot && bot.avatar?.crop ? { avatarCrop: bot.avatar.crop } : {}),
		createdAt: bot.createdAt,
		updatedAt: bot.updatedAt,
	};
}

export async function updateUserProfile(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
	input: UpdateUserProfileInput,
	now = new Date().toISOString(),
): Promise<UserProfile> {
	const current = await userById(kv, userId);
	const nextHandle = input.handle ?? current.handle;
	if (nextHandle !== current.handle) {
		const existing = await db
			.prepare(`SELECT user_id AS id FROM users_index WHERE handle = ? AND deleted_at IS NULL`)
			.bind(nextHandle)
			.first<{ id: string }>();
		if (existing && existing.id !== current.id) {
			throw new RepositoryError("conflict", "A user with that handle already exists.", 409);
		}
	}

	const inferenceSettings = mergeInferenceSettings(current.inferenceSettings, input.inferenceSettings);
	enforceInferenceModelAccess(inferenceSettings);

	const updated: UserDocument = {
		...current,
		...(input.handle !== undefined ? { handle: input.handle } : {}),
		...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
		...(input.avatarUrl !== undefined ? (input.avatarUrl ? { avatarUrl: input.avatarUrl } : { avatarUrl: undefined }) : {}),
		inferenceSettings,
		profileCompletedAt: current.profileCompletedAt ?? now,
		revision: current.revision + 1,
		updatedAt: now,
	};
	if (input.avatarUrl === null || input.avatarUrl === "") {
		delete updated.avatarUrl;
	}

	await writeJson(kv, kvKeys.user(updated.id), updated);
	await db
		.prepare(
			`UPDATE users_index
			 SET handle = ?, display_name = ?, avatar_url = ?, profile_completed_at = ?, updated_at = ?
			 WHERE user_id = ?`,
		)
		.bind(updated.handle, updated.displayName, updated.avatarUrl ?? null, updated.profileCompletedAt ?? null, now, updated.id)
		.run();
	await putObjectIndex(db, updated, "user");

	return userProfile(updated, await listUserAuthIdentities(db, updated.id));
}

export async function listWorlds(db: D1DatabaseLike): Promise<WorldListSummary[]> {
	const result = await db
		.prepare(
			`SELECT
				w.world_id AS id,
				w.handle,
				w.name,
				w.description,
				w.initial_bot_notification AS initialBotNotification,
				w.posting_thread_body_characters AS postingThreadBodyCharacters,
				w.posting_comment_body_characters AS postingCommentBodyCharacters,
				w.created_by_user_id AS createdByUserId,
				w.created_at AS createdAt,
				w.updated_at AS updatedAt,
				COALESCE(forum_counts.forumCount, 0) AS forumCount,
				COALESCE(bot_counts.botCount, 0) AS botCount
			 FROM worlds_index w
			 LEFT JOIN (
				SELECT world_id, COUNT(*) AS forumCount
				FROM forums_index
				WHERE deleted_at IS NULL AND personal_bot_id IS NULL
				GROUP BY world_id
			 ) forum_counts ON forum_counts.world_id = w.world_id
			 LEFT JOIN (
				SELECT home_world_id AS world_id, COUNT(*) AS botCount
				FROM bots_index
				WHERE deleted_at IS NULL
				GROUP BY home_world_id
			 ) bot_counts ON bot_counts.world_id = w.world_id
			 WHERE w.deleted_at IS NULL
			 ORDER BY w.updated_at DESC, w.handle ASC`,
		)
		.all<WorldSummaryIndexRow & Pick<WorldListSummary, "forumCount" | "botCount">>();

	return (result.results ?? []).map(worldSummaryFromIndexRow);
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

	const postingSettings = mergePostingSettings(undefined, input.postingSettings);
	const world: WorldDocument = {
		id: makeId("wld"),
		type: "world",
		schemaVersion,
		revision: 1,
		handle: input.handle,
		name: input.name,
		description: input.description,
		initialBotNotification: input.initialBotNotification ?? defaultInitialBotNotification,
		...(postingSettingsHasValues(postingSettings) ? { postingSettings } : {}),
		createdByUserId: userId,
		visibility: "public",
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.world(world.id), world);
	await db
		.prepare(
			`INSERT INTO worlds_index (
				world_id, handle, name, description, initial_bot_notification, created_by_user_id,
				visibility, posting_thread_body_characters, posting_comment_body_characters, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		)
		.bind(
			world.id,
			world.handle,
			world.name,
			world.description,
			world.initialBotNotification,
			world.createdByUserId,
			world.visibility,
			world.postingSettings?.threadBodyCharacters ?? null,
			world.postingSettings?.commentBodyCharacters ?? null,
			now,
			now,
		)
		.run();
	await putObjectIndex(db, world, "world", world.id);
	await upsertWorldSearchIndex(db, world);
	await createIntroForumForWorld(kv, db, world, userId, now);

	return worldSummary(world);
}

export async function listForums(db: D1DatabaseLike, worldHandle: string): Promise<ForumSummary[]> {
	const world = await worldByHandle(db, worldHandle);
	const result = await db
		.prepare(
			`SELECT
				f.forum_id AS id,
				f.world_id AS worldId,
				f.world_handle AS worldHandle,
				f.handle,
				CASE
					WHEN f.personal_bot_id IS NOT NULL AND b.bot_id IS NOT NULL
						THEN 'Blog of ' || b.display_name || ' (u/' || b.handle || ')'
					ELSE f.description
				END AS description,
				f.created_by_user_id AS createdByUserId,
				f.personal_bot_id AS personalBotId,
				f.created_at AS createdAt,
				f.updated_at AS updatedAt
			 FROM forums_index f
			 LEFT JOIN bots_index b ON b.bot_id = f.personal_bot_id AND b.deleted_at IS NULL
			 WHERE f.world_id = ? AND f.deleted_at IS NULL
			 ORDER BY f.handle ASC`,
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
				, personal_bot_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
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
	await upsertForumSearchIndex(db, forum);

	return forumSummary(forum);
}

async function attachBotOwners(db: D1DatabaseLike, bots: BotSummary[]): Promise<BotSummary[]> {
	const owners = await publicUsersByIds(db, bots.map((bot) => bot.ownerUserId));
	return bots.map((bot) => {
		const owner = owners.get(bot.ownerUserId);
		return owner ? { ...bot, owner } : bot;
	});
}

export async function listUserBots(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
): Promise<BotSummary[]> {
	const result = await db
		.prepare(
			`WITH selected AS (
				SELECT bot_id AS id, updated_at, handle
				FROM bots_index
				WHERE owner_user_id = ? AND deleted_at IS NULL
			 ),
			 activity AS (
				SELECT threads.author_bot_id AS bot_id, threads.created_at AS active_at
				FROM threads_index threads
				JOIN selected ON selected.id = threads.author_bot_id
				WHERE threads.deleted_at IS NULL
				UNION ALL
				SELECT comments.author_bot_id AS bot_id, comments.created_at AS active_at
				FROM comments_index comments
				JOIN selected ON selected.id = comments.author_bot_id
				WHERE comments.deleted_at IS NULL
				UNION ALL
				SELECT votes.bot_id AS bot_id, votes.updated_at AS active_at
				FROM votes
				JOIN selected ON selected.id = votes.bot_id
				UNION ALL
				SELECT follows.follower_bot_id AS bot_id, follows.created_at AS active_at
				FROM follows
				JOIN selected ON selected.id = follows.follower_bot_id
			 )
			 SELECT
				selected.id AS id,
				runtime.next_due_at AS nextDueAt,
				MAX(activity.active_at) AS lastActiveAt
			 FROM selected
			 LEFT JOIN bot_runtime_index runtime ON runtime.bot_id = selected.id
			 LEFT JOIN activity ON activity.bot_id = selected.id
			 GROUP BY selected.id, runtime.next_due_at, selected.updated_at, selected.handle
			 ORDER BY selected.updated_at DESC, selected.handle ASC`,
		)
		.bind(userId)
		.all<{ id: string; nextDueAt: string | null; lastActiveAt: string | null }>();
	const rows = result.results ?? [];
	const runtimeById = new Map(
		rows.map((row) => [row.id, { nextDueAt: row.nextDueAt, lastActiveAt: row.lastActiveAt }]),
	);
	const bots = await Promise.all(rows.map((row) => readJson<BotDocument>(kv, kvKeys.bot(row.id))));
	const activeBots = bots
		.filter((bot): bot is BotDocument => Boolean(bot && !bot.deletedAt))
		.map((bot) => normalizeBotDefaults(bot));
	const effectiveBots = await effectiveBotDocuments(kv, db, activeBots);
	const worldPostingSettings = await worldPostingSettingsByIds(db, effectiveBots.map((bot) => bot.homeWorldId));

	return attachBotOwners(db, effectiveBots.map((bot) => {
		const runtime = runtimeById.get(bot.id);
		return botSummaryWithLastActive(bot, runtime?.lastActiveAt, {
			includeToolSettings: true,
			nextDueAt: runtime?.nextDueAt ?? null,
			worldPostingSettings: worldPostingSettings.get(bot.homeWorldId),
		});
	}));
}

export async function createBot(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	input: CreateBotInput,
	userId: string,
	options: CreateBotOptions | string = {},
): Promise<BotSummary> {
	const createOptions = typeof options === "string" ? { now: options } : options;
	const now = createOptions.now ?? new Date().toISOString();
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

	const owner = await userById(kv, userId);
	const cloneSource = input.cloneSourceBotId ? createOptions.cloneSource ?? await rawBotById(kv, db, input.cloneSourceBotId) : null;
	if (cloneSource && cloneSource.id !== input.cloneSourceBotId) {
		throw new RepositoryError("bad_request", "Clone source does not match the requested source.", 400);
	}
	if (cloneSource && cloneSource.ownerUserId !== userId) {
		throw new RepositoryError("forbidden", "You can only clone your own participants.", 403);
	}
	if (!cloneSource) {
		assertMaterializedProfileFields(input.displayName, input.shortBio, input.prompt);
	}
	const inferenceSettings = mergeInferenceSettings(undefined, input.inferenceSettings);
	enforceInferenceModelAccess(inferenceSettings, owner.inferenceSettings);
	const toolSettings = mergeToolSettings(undefined, input.toolSettings);
	const inheritedPostingSettings = effectivePostingSettings(world.postingSettings, undefined);
	assertPostingSettingsInputWithinLimits(input.postingSettings, inheritedPostingSettings);
	const postingSettings = mergePostingSettings(undefined, input.postingSettings);

	let bot: BotDocument = {
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
		inferenceSettings,
		toolSettings,
		...(postingSettingsHasValues(postingSettings) ? { postingSettings } : {}),
		tickSettings: mergeTickSettings(undefined, input.tickSettings),
		...(input.importSource ? { importSource: input.importSource } : {}),
		...(input.avatar ? { avatar: input.avatar } : {}),
		createdAt: now,
		updatedAt: now,
	};
	const preparedAvatar = await createOptions.prepareAvatar?.(bot);
	if (preparedAvatar) {
		bot = { ...bot, avatar: preparedAvatar };
	}

	await writeJson(kv, kvKeys.bot(bot.id), bot);
	if (cloneSource) {
		await insertBotCloneSource(db, bot, cloneSource, now);
	}
	const effectiveBot = cloneSource ? await effectiveBotDocument(kv, db, bot) : bot;
	await upsertBotIndex(db, effectiveBot);
	await createPersonalForumForBot(kv, db, effectiveBot, userId, now);
	await upsertBotRuntimeIndex(db, bot, now);
	await autoSubscribeUserToBot(db, userId, bot, now);
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
	await upsertBotSearchIndex(db, effectiveBot);

	return botSummary(effectiveBot, {
		includeToolSettings: true,
		nextDueAt: await botRuntimeNextDueAt(db, bot.id),
		owner: publicUser(owner),
		worldPostingSettings: world.postingSettings,
	});
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
	const owner = await userById(kv, userId);
	const worldPostingSettings = await worldPostingSettingsById(db, bot.homeWorldId);
	const cloneSource = await cloneSourceByBotId(db, bot.id);
	const canInheritProfile = Boolean(cloneSource?.linked);
	const nextHandle = input.handle ?? bot.handle;
	if (nextHandle !== bot.handle) {
		await assertBotHandleAvailable(db, bot.homeWorldId, bot.id, nextHandle);
	}
	const personalForumRename =
		nextHandle !== bot.handle ? await personalForumRenameForBotHandle(kv, db, bot, nextHandle, now) : null;
	const inferenceSettings = mergeInferenceSettings(bot.inferenceSettings, input.inferenceSettings);
	enforceInferenceModelAccess(inferenceSettings, owner.inferenceSettings);
	const toolSettings = mergeToolSettings(bot.toolSettings, input.toolSettings);
	const inheritedPostingSettings = effectivePostingSettings(worldPostingSettings, undefined);
	assertPostingSettingsInputWithinLimits(input.postingSettings, inheritedPostingSettings);
	const postingSettings = mergePostingSettings(bot.postingSettings, input.postingSettings);
	const updated: BotDocument = {
		...bot,
		...input,
		handle: nextHandle,
		inferenceSettings,
		toolSettings,
		...(postingSettingsHasValues(postingSettings) ? { postingSettings } : { postingSettings: undefined }),
		tickSettings: mergeTickSettings(bot.tickSettings, input.tickSettings),
		revision: bot.revision + 1,
		updatedAt: now,
	};
	if (!canInheritProfile) {
		assertMaterializedProfileFields(updated.displayName, updated.shortBio, updated.prompt);
	}

	await writeJson(kv, kvKeys.bot(updated.id), updated);
	const effectiveUpdated = canInheritProfile ? await effectiveBotDocument(kv, db, updated) : updated;
	if (personalForumRename) {
		await db.batch([
			botIndexUpdateStatement(db, effectiveUpdated),
			db
				.prepare(`UPDATE forums_index SET handle = ?, updated_at = ? WHERE forum_id = ? AND deleted_at IS NULL`)
				.bind(personalForumRename.updated.handle, now, personalForumRename.updated.id),
			db
				.prepare(`UPDATE threads_index SET forum_handle = ? WHERE forum_id = ? AND deleted_at IS NULL`)
				.bind(personalForumRename.updated.handle, personalForumRename.updated.id),
		]);
	} else {
		await upsertBotIndex(db, effectiveUpdated);
	}
	await upsertBotRuntimeIndex(db, updated, now, shouldRescheduleBotRuntime(bot.tickSettings, updated.tickSettings, input.tickSettings));
	if (personalForumRename) {
		await writeJson(kv, kvKeys.forum(personalForumRename.updated.id), personalForumRename.updated);
		await writePersonalForumThreadRenameDocuments(kv, db, personalForumRename.updated, now);
		await putObjectIndex(db, personalForumRename.updated, "forum", personalForumRename.updated.worldId);
		await upsertForumSearchIndex(db, personalForumRename.updated);
	}
	await putObjectIndex(db, updated, "bot", updated.homeWorldId);
	await upsertBotSearchIndex(db, effectiveUpdated);

	return botSummary(effectiveUpdated, {
		includeToolSettings: true,
		nextDueAt: await botRuntimeNextDueAt(db, updated.id),
		owner: publicUser(owner),
		worldPostingSettings,
	});
}

export async function updateBotAvatar(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	userId: string,
	avatar: AvatarImage,
	now = new Date().toISOString(),
): Promise<BotSummary> {
	const bot = await botForOwner(kv, db, botId, userId);
	const owner = await userById(kv, userId);
	const worldPostingSettings = await worldPostingSettingsById(db, bot.homeWorldId);
	const updated: BotDocument = {
		...bot,
		avatar,
		revision: bot.revision + 1,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.bot(updated.id), updated);
	const effectiveUpdated = await effectiveBotDocument(kv, db, updated);
	await upsertBotIndex(db, effectiveUpdated);
	await putObjectIndex(db, updated, "bot", updated.homeWorldId);
	await upsertBotSearchIndex(db, effectiveUpdated);

	return botSummary(effectiveUpdated, {
		includeToolSettings: true,
		nextDueAt: await botRuntimeNextDueAt(db, updated.id),
		owner: publicUser(owner),
		worldPostingSettings,
	});
}

export async function deleteBotAvatar(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	userId: string,
	now = new Date().toISOString(),
): Promise<BotSummary> {
	const bot = await botForOwner(kv, db, botId, userId);
	const owner = await userById(kv, userId);
	const worldPostingSettings = await worldPostingSettingsById(db, bot.homeWorldId);
	const { avatar: _avatar, ...withoutAvatar } = bot;
	const updated: BotDocument = {
		...withoutAvatar,
		revision: bot.revision + 1,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.bot(updated.id), updated);
	const effectiveUpdated = await effectiveBotDocument(kv, db, updated);
	await upsertBotIndex(db, effectiveUpdated);
	await putObjectIndex(db, updated, "bot", updated.homeWorldId);
	await upsertBotSearchIndex(db, effectiveUpdated);

	return botSummary(effectiveUpdated, {
		includeToolSettings: true,
		nextDueAt: await botRuntimeNextDueAt(db, updated.id),
		owner: publicUser(owner),
		worldPostingSettings,
	});
}

export async function deleteBot(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	userId: string,
	options: DeleteBotOptions | string = {},
): Promise<BotSummary> {
	const deleteOptions = typeof options === "string" ? { now: options } : options;
	const now = deleteOptions.now ?? new Date().toISOString();
	const bot = await botForOwner(kv, db, botId, userId);
	if (!deleteOptions.allowLinkedCloneDelete && await hasLinkedCloneDescendants(db, bot.id)) {
		throw new RepositoryError(
			"conflict",
			"Delete linked clones of this participant, or unlink them, before deleting the source participant.",
			409,
		);
	}
	const owner = await publicUserById(db, userId);
	const worldPostingSettings = await worldPostingSettingsById(db, bot.homeWorldId);
	const deleted: BotDocument = {
		...bot,
		revision: bot.revision + 1,
		updatedAt: now,
		deletedAt: now,
	};

	await writeJson(kv, kvKeys.bot(deleted.id), deleted);
	await upsertBotIndex(db, deleted);
	await disableBotRuntime(db, deleted.id, now);
	await putObjectIndex(db, deleted, "bot", deleted.homeWorldId);
	await upsertBotSearchIndex(db, deleted);

	return botSummary(deleted, { includeToolSettings: true, nextDueAt: null, owner, worldPostingSettings });
}

export async function unlinkBotClone(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	userId: string,
	copiedInheritedAvatar?: AvatarImage,
	now = new Date().toISOString(),
): Promise<BotSummary> {
	const bot = await botForOwner(kv, db, botId, userId);
	const cloneSource = await cloneSourceByBotId(db, bot.id);
	if (!cloneSource) {
		throw new RepositoryError("bad_request", "This participant is not a clone.", 400);
	}
	const owner = await userById(kv, userId);
	const worldPostingSettings = await worldPostingSettingsById(db, bot.homeWorldId);
	if (!cloneSource.linked) {
		const effective = await effectiveBotDocument(kv, db, bot);
		return botSummary(effective, {
			includeToolSettings: true,
			nextDueAt: await botRuntimeNextDueAt(db, bot.id),
			owner: publicUser(owner),
			worldPostingSettings,
		});
	}
	const effectiveBefore = await effectiveBotDocument(kv, db, bot);
	const updated: BotDocument = {
		...bot,
		displayName: hasProfileText(bot.displayName) ? bot.displayName : effectiveBefore.displayName,
		shortBio: hasProfileText(bot.shortBio) ? bot.shortBio : effectiveBefore.shortBio,
		prompt: hasProfileText(bot.prompt) ? bot.prompt : effectiveBefore.prompt,
		inferenceSettings: hasInferenceText(bot.inferenceSettings.model) ?
			bot.inferenceSettings
		:	cloneInferenceSettings(effectiveBefore.inferenceSettings),
		...(bot.avatar ? { avatar: bot.avatar } : copiedInheritedAvatar ? { avatar: copiedInheritedAvatar } : {}),
		revision: bot.revision + 1,
		updatedAt: now,
	};
	assertMaterializedProfileFields(updated.displayName, updated.shortBio, updated.prompt);

	await writeJson(kv, kvKeys.bot(updated.id), updated);
	await db
		.prepare(
			`UPDATE bot_clone_sources
			 SET linked = 0, unlinked_at = ?, relinked_at = NULL
			 WHERE bot_id = ?`,
		)
		.bind(now, updated.id)
		.run();
	const effectiveUpdated = await effectiveBotDocument(kv, db, updated);
	await upsertBotIndex(db, effectiveUpdated);
	await putObjectIndex(db, updated, "bot", updated.homeWorldId);
	await upsertBotSearchIndex(db, effectiveUpdated);

	return botSummary(effectiveUpdated, {
		includeToolSettings: true,
		nextDueAt: await botRuntimeNextDueAt(db, updated.id),
		owner: publicUser(owner),
		worldPostingSettings,
	});
}

export async function relinkBotClone(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	userId: string,
	now = new Date().toISOString(),
): Promise<BotSummary> {
	const bot = await botForOwner(kv, db, botId, userId);
	const cloneSource = await cloneSourceByBotId(db, bot.id);
	if (!cloneSource) {
		throw new RepositoryError("bad_request", "This participant is not a clone.", 400);
	}
	const owner = await userById(kv, userId);
	const worldPostingSettings = await worldPostingSettingsById(db, bot.homeWorldId);
	const sourceRaw = await rawBotById(kv, db, cloneSource.sourceBotId);
	if (sourceRaw.ownerUserId !== userId) {
		throw new RepositoryError("forbidden", "You can only relink to your own participants.", 403);
	}
	await assertNoCloneCycle(db, bot.id, sourceRaw.id);
	const sourceEffective = await effectiveBotDocument(kv, db, sourceRaw);
	const next: BotDocument = {
		...bot,
		displayName: bot.displayName === sourceEffective.displayName ? "" : bot.displayName,
		shortBio: bot.shortBio === sourceEffective.shortBio ? "" : bot.shortBio,
		prompt: bot.prompt === sourceEffective.prompt ? "" : bot.prompt,
		inferenceSettings: inferenceSettingsEqual(bot.inferenceSettings, sourceEffective.inferenceSettings) ?
			cloneInferenceSettings(undefined)
		:	bot.inferenceSettings,
		revision: bot.revision + 1,
		updatedAt: now,
	};
	if (avatarEquivalentForRelink(bot.avatar, sourceEffective.avatar)) {
		delete next.avatar;
	}

	await writeJson(kv, kvKeys.bot(next.id), next);
	await db
		.prepare(
			`UPDATE bot_clone_sources
			 SET linked = 1, relinked_at = ?, unlinked_at = NULL
			 WHERE bot_id = ?`,
		)
		.bind(now, next.id)
		.run();
	const effectiveUpdated = await effectiveBotDocument(kv, db, next);
	await upsertBotIndex(db, effectiveUpdated);
	await putObjectIndex(db, next, "bot", next.homeWorldId);
	await upsertBotSearchIndex(db, effectiveUpdated);

	return botSummary(effectiveUpdated, {
		includeToolSettings: true,
		nextDueAt: await botRuntimeNextDueAt(db, next.id),
		owner: publicUser(owner),
		worldPostingSettings,
	});
}

export async function backfillInferredCloneSources(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	now = new Date().toISOString(),
): Promise<CloneSourceBackfillResult> {
	const result = await db
		.prepare(
			`SELECT
				bot_id AS id,
				owner_user_id AS ownerUserId,
				handle,
				created_at AS createdAt
			 FROM bots_index
			 WHERE deleted_at IS NULL
			 ORDER BY owner_user_id ASC, handle ASC, created_at ASC, bot_id ASC`,
		)
		.all<{ id: string; ownerUserId: string; handle: string; createdAt: string }>();
	const groups = new Map<string, string[]>();
	for (const row of result.results ?? []) {
		const key = `${row.ownerUserId}\0${row.handle}`;
		const group = groups.get(key) ?? [];
		group.push(row.id);
		groups.set(key, group);
	}

	let groupCount = 0;
	let clonesLinked = 0;
	let clonesSkipped = 0;
	for (const botIds of groups.values()) {
		if (botIds.length < 2) {
			continue;
		}
		groupCount += 1;
		const [sourceId, ...targetIds] = botIds;
		const sourceRaw = await rawBotById(kv, db, sourceId);
		const sourceEffective = await effectiveBotDocument(kv, db, sourceRaw);
		for (const targetId of targetIds) {
			if (await cloneSourceByBotId(db, targetId)) {
				clonesSkipped += 1;
				continue;
			}
			const targetRaw = await rawBotById(kv, db, targetId);
			let updated: BotDocument = {
				...targetRaw,
				displayName: targetRaw.displayName === sourceEffective.displayName ? "" : targetRaw.displayName,
				shortBio: targetRaw.shortBio === sourceEffective.shortBio ? "" : targetRaw.shortBio,
				prompt: targetRaw.prompt === sourceEffective.prompt ? "" : targetRaw.prompt,
				inferenceSettings: inferenceSettingsEqual(targetRaw.inferenceSettings, sourceEffective.inferenceSettings) ?
					cloneInferenceSettings(undefined)
				:	targetRaw.inferenceSettings,
				revision: targetRaw.revision + 1,
				updatedAt: now,
			};
			if (avatarEquivalentForRelink(targetRaw.avatar, sourceEffective.avatar)) {
				const { avatar: _avatar, ...withoutAvatar } = updated;
				updated = withoutAvatar;
			}
			await insertBotCloneSource(db, updated, sourceRaw, now);
			await writeJson(kv, kvKeys.bot(updated.id), updated);
			const effective = await effectiveBotDocument(kv, db, updated);
			await upsertBotIndex(db, effective);
			await putObjectIndex(db, updated, "bot", updated.homeWorldId);
			await upsertBotSearchIndex(db, effective);
			clonesLinked += 1;
		}
	}
	return { groups: groupCount, clonesLinked, clonesSkipped };
}

export async function rawBotById(kv: KVNamespaceLike, db: D1DatabaseLike, botId: string): Promise<BotDocument> {
	const row = await db
		.prepare(`SELECT deleted_at AS deletedAt FROM bots_index WHERE bot_id = ?`)
		.bind(botId)
		.first<{ deletedAt: string | null }>();
	if (!row || row.deletedAt) {
		throw new RepositoryError("not_found", "Bot not found.", 404);
	}

	const bot = await readJson<BotDocument>(kv, kvKeys.bot(botId));
	if (!bot || bot.deletedAt) {
		throw new RepositoryError("not_found", "Bot not found.", 404);
	}
	return normalizeBotDefaults(bot);
}

export async function botById(kv: KVNamespaceLike, db: D1DatabaseLike, botId: string): Promise<BotDocument> {
	return effectiveBotDocument(kv, db, await rawBotById(kv, db, botId));
}

export async function botByHandle(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldId: string,
	handle: string,
): Promise<BotDocument | null> {
	const row = await db
		.prepare(
			`SELECT bot_id AS id
			 FROM bots_index
			 WHERE home_world_id = ? AND handle = ? AND deleted_at IS NULL`,
		)
		.bind(worldId, handle)
		.first<{ id: string }>();
	return row ? botById(kv, db, row.id) : null;
}

export async function listWorldBots(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
): Promise<BotSummary[]> {
	const world = await worldByHandle(db, worldHandle);
	const result = await db
		.prepare(
			`WITH selected AS (
				SELECT bot_id AS id, handle
				FROM bots_index
				WHERE home_world_id = ? AND deleted_at IS NULL
			 ),
			 activity AS (
				SELECT threads.author_bot_id AS bot_id, threads.created_at AS active_at
				FROM threads_index threads
				JOIN selected ON selected.id = threads.author_bot_id
				WHERE threads.deleted_at IS NULL
				UNION ALL
				SELECT comments.author_bot_id AS bot_id, comments.created_at AS active_at
				FROM comments_index comments
				JOIN selected ON selected.id = comments.author_bot_id
				WHERE comments.deleted_at IS NULL
				UNION ALL
				SELECT votes.bot_id AS bot_id, votes.updated_at AS active_at
				FROM votes
				JOIN selected ON selected.id = votes.bot_id
				UNION ALL
				SELECT follows.follower_bot_id AS bot_id, follows.created_at AS active_at
				FROM follows
				JOIN selected ON selected.id = follows.follower_bot_id
			 )
			 SELECT
				selected.id AS id,
				runtime.next_due_at AS nextDueAt,
				MAX(activity.active_at) AS lastActiveAt
			 FROM selected
			 LEFT JOIN bot_runtime_index runtime ON runtime.bot_id = selected.id
			 LEFT JOIN activity ON activity.bot_id = selected.id
			 GROUP BY selected.id, runtime.next_due_at, selected.handle
			 ORDER BY selected.handle ASC`,
		)
		.bind(world.id)
		.all<{ id: string; nextDueAt: string | null; lastActiveAt: string | null }>();
	const rows = result.results ?? [];
	const runtimeById = new Map(
		rows.map((row) => [row.id, { nextDueAt: row.nextDueAt, lastActiveAt: row.lastActiveAt }]),
	);
	const bots = await Promise.all(rows.map((row) => readJson<BotDocument>(kv, kvKeys.bot(row.id))));
	const activeBots = bots.filter((bot): bot is BotDocument => Boolean(bot && !bot.deletedAt)).map((bot) => normalizeBotDefaults(bot));
	const effectiveBots = await effectiveBotDocuments(kv, db, activeBots);
	return attachBotOwners(db, effectiveBots.map((bot) => {
		const runtime = runtimeById.get(bot.id);
		return botSummaryWithLastActive(bot, runtime?.lastActiveAt, {
			includePrompt: false,
			nextDueAt: runtime?.nextDueAt ?? null,
			worldPostingSettings: world.postingSettings,
		});
	}));
}

export async function humanProfileByHandle(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	handle: string,
	viewerUserId?: string | null,
): Promise<HumanProfile> {
	const user = await publicUserByHandle(db, handle);
	const [worlds, forumsByWorld, bots, deleteEligibility] = await Promise.all([
		listOwnedWorlds(db, user.id),
		listOwnedForumsByWorld(db, user.id),
		listUserBots(kv, db, user.id),
		viewerUserId === user.id ? humanProfileDeleteEligibility(db, user.id) : Promise.resolve(undefined),
	]);
	const botsByWorld = await groupBotsByWorld(db, bots);
	return {
		user,
		worlds,
		forumsByWorld,
		botsByWorld,
		totals: {
			worlds: worlds.length,
			forums: forumsByWorld.reduce((count, group) => count + group.forums.length, 0),
			bots: bots.length,
		},
		isSelf: viewerUserId === user.id,
		...(deleteEligibility ? { deleteEligibility } : {}),
	};
}

export async function listOwnedWorlds(db: D1DatabaseLike, userId: string): Promise<WorldSummary[]> {
	const result = await db
		.prepare(
			`SELECT
				world_id AS id,
				handle,
				name,
				description,
				initial_bot_notification AS initialBotNotification,
				posting_thread_body_characters AS postingThreadBodyCharacters,
				posting_comment_body_characters AS postingCommentBodyCharacters,
				created_by_user_id AS createdByUserId,
				created_at AS createdAt,
				updated_at AS updatedAt
			 FROM worlds_index
			 WHERE created_by_user_id = ? AND deleted_at IS NULL
			 ORDER BY lower(handle) ASC`,
		)
		.bind(userId)
		.all<WorldSummaryIndexRow>();
	return (result.results ?? []).map(worldSummaryFromIndexRow);
}

export async function listOwnedForumsOutsideOwnedWorlds(
	db: D1DatabaseLike,
	userId: string,
): Promise<ForumSummary[]> {
	const result = await db
		.prepare(
			`SELECT
				f.forum_id AS id,
				f.world_id AS worldId,
				f.world_handle AS worldHandle,
				f.handle,
				CASE
					WHEN f.personal_bot_id IS NOT NULL AND b.bot_id IS NOT NULL
						THEN 'Blog of ' || b.display_name || ' (u/' || b.handle || ')'
					ELSE f.description
				END AS description,
				f.created_by_user_id AS createdByUserId,
				f.personal_bot_id AS personalBotId,
				f.created_at AS createdAt,
				f.updated_at AS updatedAt
			 FROM forums_index f
			 JOIN worlds_index w ON w.world_id = f.world_id AND w.deleted_at IS NULL
			 LEFT JOIN bots_index b ON b.bot_id = f.personal_bot_id AND b.deleted_at IS NULL
			 WHERE f.created_by_user_id = ?
			   AND f.deleted_at IS NULL
			   AND w.created_by_user_id != ?
			 ORDER BY lower(f.world_handle) ASC, lower(f.handle) ASC`,
		)
		.bind(userId, userId)
		.all<ForumSummary>();
	return result.results ?? [];
}

export async function humanProfileDeleteEligibility(
	db: D1DatabaseLike,
	userId: string,
): Promise<HumanProfileDeleteEligibility> {
	const blockers = await foreignBotBlockersForOwnedWorlds(db, userId);
	return {
		canDelete: blockers.length === 0,
		blockers,
	};
}

export async function softDeleteUserProfile(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
	now = new Date().toISOString(),
): Promise<PublicUser> {
	const current = await userById(kv, userId);
	const tombstoneHandle = deletedUserHandle(current.id);
	const deleted: UserDocument = {
		...current,
		handle: tombstoneHandle,
		revision: current.revision + 1,
		updatedAt: now,
		deletedAt: now,
	};
	await writeJson(kv, kvKeys.user(deleted.id), deleted);
	await db
		.prepare(
			`UPDATE users_index
			 SET handle = ?, updated_at = ?, deleted_at = ?
			 WHERE user_id = ? AND deleted_at IS NULL`,
		)
		.bind(tombstoneHandle, now, now, deleted.id)
		.run();
	await db.prepare(`DELETE FROM provider_identities WHERE user_id = ?`).bind(deleted.id).run();
	await putObjectIndex(db, deleted, "user");
	return publicUser(deleted);
}

async function listOwnedForumsByWorld(
	db: D1DatabaseLike,
	userId: string,
): Promise<HumanOwnedForumGroup[]> {
	type ForumWithWorldRow = ForumSummary & {
		groupWorldId: string;
		groupWorldHandle: string;
		groupWorldName: string;
		groupWorldDescription: string;
		groupWorldInitialBotNotification: string;
		groupWorldPostingThreadBodyCharacters: number | null;
		groupWorldPostingCommentBodyCharacters: number | null;
		groupWorldCreatedByUserId: string;
		groupWorldCreatedAt: string;
		groupWorldUpdatedAt: string;
	};
	const result = await db
		.prepare(
			`SELECT
				f.forum_id AS id,
				f.world_id AS worldId,
				f.world_handle AS worldHandle,
				f.handle,
				CASE
					WHEN f.personal_bot_id IS NOT NULL AND b.bot_id IS NOT NULL
						THEN 'Blog of ' || b.display_name || ' (u/' || b.handle || ')'
					ELSE f.description
				END AS description,
				f.created_by_user_id AS createdByUserId,
				f.personal_bot_id AS personalBotId,
				f.created_at AS createdAt,
				f.updated_at AS updatedAt,
				w.world_id AS groupWorldId,
				w.handle AS groupWorldHandle,
				w.name AS groupWorldName,
				w.description AS groupWorldDescription,
				w.initial_bot_notification AS groupWorldInitialBotNotification,
				w.posting_thread_body_characters AS groupWorldPostingThreadBodyCharacters,
				w.posting_comment_body_characters AS groupWorldPostingCommentBodyCharacters,
				w.created_by_user_id AS groupWorldCreatedByUserId,
				w.created_at AS groupWorldCreatedAt,
				w.updated_at AS groupWorldUpdatedAt
			 FROM forums_index f
			 JOIN worlds_index w ON w.world_id = f.world_id AND w.deleted_at IS NULL
			 LEFT JOIN bots_index b ON b.bot_id = f.personal_bot_id AND b.deleted_at IS NULL
			 WHERE f.created_by_user_id = ?
			   AND f.deleted_at IS NULL
			   AND f.personal_bot_id IS NULL
			 ORDER BY lower(w.handle) ASC, lower(f.handle) ASC`,
		)
		.bind(userId)
		.all<ForumWithWorldRow>();
	const groups = new Map<string, HumanOwnedForumGroup>();
	for (const row of result.results ?? []) {
		let group = groups.get(row.groupWorldId);
		if (!group) {
			group = {
				world: {
					id: row.groupWorldId,
					handle: row.groupWorldHandle,
					name: row.groupWorldName,
					description: row.groupWorldDescription,
					initialBotNotification: row.groupWorldInitialBotNotification,
					...postingSettingsObject(
						row.groupWorldPostingThreadBodyCharacters,
						row.groupWorldPostingCommentBodyCharacters,
					),
					createdByUserId: row.groupWorldCreatedByUserId,
					createdAt: row.groupWorldCreatedAt,
					updatedAt: row.groupWorldUpdatedAt,
				},
				forums: [],
			};
			groups.set(row.groupWorldId, group);
		}
		group.forums.push({
			id: row.id,
			worldId: row.worldId,
			worldHandle: row.worldHandle,
			handle: row.handle,
			description: row.description,
			createdByUserId: row.createdByUserId,
			...(row.personalBotId ? { personalBotId: row.personalBotId } : {}),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		});
	}
	return [...groups.values()];
}

async function groupBotsByWorld(db: D1DatabaseLike, bots: BotSummary[]): Promise<HumanOwnedBotGroup[]> {
	const worldsById = await worldSummariesByIds(db, bots.map((bot) => bot.homeWorldId));
	const groups = new Map<string, HumanOwnedBotGroup>();
	for (const bot of [...bots].sort((left, right) =>
		left.homeWorldHandle.localeCompare(right.homeWorldHandle) || left.handle.localeCompare(right.handle),
	)) {
		const world = worldsById.get(bot.homeWorldId);
		if (!world) {
			continue;
		}
		let group = groups.get(world.id);
		if (!group) {
			group = { world, bots: [] };
			groups.set(world.id, group);
		}
		group.bots.push(bot);
	}
	return [...groups.values()];
}

async function worldSummariesByIds(
	db: D1DatabaseLike,
	worldIds: string[],
): Promise<Map<string, WorldSummary>> {
	const ids = [...new Set(worldIds.filter(Boolean))];
	const worlds = new Map<string, WorldSummary>();
	for (let index = 0; index < ids.length; index += 90) {
		const batch = ids.slice(index, index + 90);
		if (batch.length === 0) {
			continue;
		}
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT
					world_id AS id,
					handle,
					name,
					description,
					initial_bot_notification AS initialBotNotification,
					posting_thread_body_characters AS postingThreadBodyCharacters,
					posting_comment_body_characters AS postingCommentBodyCharacters,
					created_by_user_id AS createdByUserId,
					created_at AS createdAt,
					updated_at AS updatedAt
				 FROM worlds_index
				 WHERE world_id IN (${placeholders}) AND deleted_at IS NULL`,
			)
			.bind(...batch)
			.all<WorldSummaryIndexRow>();
		for (const row of result.results ?? []) {
			const world = worldSummaryFromIndexRow(row);
			worlds.set(world.id, world);
		}
	}
	return worlds;
}

async function worldPostingSettingsById(
	db: D1DatabaseLike,
	worldId: string,
): Promise<PostingSettings | undefined> {
	const worlds = await worldPostingSettingsByIds(db, [worldId]);
	return worlds.get(worldId);
}

async function worldPostingSettingsByIds(
	db: D1DatabaseLike,
	worldIds: string[],
): Promise<Map<string, PostingSettings | undefined>> {
	const ids = [...new Set(worldIds.filter(Boolean))];
	const worlds = new Map<string, PostingSettings | undefined>();
	for (let index = 0; index < ids.length; index += 90) {
		const batch = ids.slice(index, index + 90);
		if (batch.length === 0) {
			continue;
		}
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT
					world_id AS id,
					posting_thread_body_characters AS postingThreadBodyCharacters,
					posting_comment_body_characters AS postingCommentBodyCharacters
				 FROM worlds_index
				 WHERE world_id IN (${placeholders}) AND deleted_at IS NULL`,
			)
			.bind(...batch)
			.all<{ id: string; postingThreadBodyCharacters: number | null; postingCommentBodyCharacters: number | null }>();
		for (const row of result.results ?? []) {
			worlds.set(
				row.id,
				postingSettingsObject(row.postingThreadBodyCharacters, row.postingCommentBodyCharacters).postingSettings,
			);
		}
	}
	return worlds;
}

function assertPostingSettingsInputWithinLimits(
	input: PostingSettingsInput | undefined,
	inherited: BotEffectivePostingSettings,
): void {
	if (!input) {
		return;
	}
	if (input.threadBodyCharacters !== undefined && input.threadBodyCharacters !== null && input.threadBodyCharacters > inherited.threadBodyCharacters) {
		throw new RepositoryError(
			"bad_request",
			`Thread body characters must be an integer between 1 and ${inherited.threadBodyCharacters}.`,
			400,
		);
	}
	if (input.commentBodyCharacters !== undefined && input.commentBodyCharacters !== null && input.commentBodyCharacters > inherited.commentBodyCharacters) {
		throw new RepositoryError(
			"bad_request",
			`Comment body characters must be an integer between 1 and ${inherited.commentBodyCharacters}.`,
			400,
		);
	}
}

async function foreignBotBlockersForOwnedWorlds(
	db: D1DatabaseLike,
	userId: string,
): Promise<HumanProfileDeleteBlocker[]> {
	type BlockingBotRow = {
		worldId: string;
		worldHandle: string;
		worldName: string;
		worldDescription: string;
		worldInitialBotNotification: string;
		worldPostingThreadBodyCharacters: number | null;
		worldPostingCommentBodyCharacters: number | null;
		worldCreatedByUserId: string;
		worldCreatedAt: string;
		worldUpdatedAt: string;
		botId: string;
		homeWorldId: string;
		homeWorldHandle: string;
		handle: string;
		displayName: string;
		shortBio: string;
		avatarUrl: string | null;
		createdAt: string;
		updatedAt: string;
		ownerUserId: string;
		ownerHandle: string | null;
		ownerDisplayName: string | null;
		ownerAvatarUrl: string | null;
		ownerProfileCompletedAt: string | null;
		avatarCrop: string | null;
	};
	const result = await db
		.prepare(
			`SELECT
				w.world_id AS worldId,
				w.handle AS worldHandle,
				w.name AS worldName,
				w.description AS worldDescription,
				w.initial_bot_notification AS worldInitialBotNotification,
				w.posting_thread_body_characters AS worldPostingThreadBodyCharacters,
				w.posting_comment_body_characters AS worldPostingCommentBodyCharacters,
				w.created_by_user_id AS worldCreatedByUserId,
				w.created_at AS worldCreatedAt,
				w.updated_at AS worldUpdatedAt,
				b.bot_id AS botId,
				b.home_world_id AS homeWorldId,
				b.home_world_handle AS homeWorldHandle,
				b.handle,
				b.display_name AS displayName,
				b.short_bio AS shortBio,
				b.avatar_url AS avatarUrl,
				b.avatar_crop AS avatarCrop,
				b.created_at AS createdAt,
				b.updated_at AS updatedAt,
				b.owner_user_id AS ownerUserId,
				u.handle AS ownerHandle,
				u.display_name AS ownerDisplayName,
				u.avatar_url AS ownerAvatarUrl,
				u.profile_completed_at AS ownerProfileCompletedAt
			 FROM worlds_index w
			 JOIN bots_index b ON b.home_world_id = w.world_id AND b.deleted_at IS NULL
			 LEFT JOIN users_index u ON u.user_id = b.owner_user_id AND u.deleted_at IS NULL
			 WHERE w.created_by_user_id = ?
			   AND w.deleted_at IS NULL
			   AND b.owner_user_id != ?
			 ORDER BY lower(w.handle) ASC, lower(b.handle) ASC`,
		)
		.bind(userId, userId)
		.all<BlockingBotRow>();
	const groups = new Map<string, HumanProfileDeleteBlocker>();
	for (const row of result.results ?? []) {
		let group = groups.get(row.worldId);
		if (!group) {
			group = {
				type: "foreign_bots_in_owned_world",
				world: {
					id: row.worldId,
					handle: row.worldHandle,
					name: row.worldName,
					description: row.worldDescription,
					initialBotNotification: row.worldInitialBotNotification,
					...postingSettingsObject(
						row.worldPostingThreadBodyCharacters,
						row.worldPostingCommentBodyCharacters,
					),
					createdByUserId: row.worldCreatedByUserId,
					createdAt: row.worldCreatedAt,
					updatedAt: row.worldUpdatedAt,
				},
				bots: [],
			};
			groups.set(row.worldId, group);
		}
		const avatarCrop = avatarCropFromJson(row.avatarCrop);
		group.bots.push({
			id: row.botId,
			homeWorldId: row.homeWorldId,
			homeWorldHandle: row.homeWorldHandle,
			handle: row.handle,
			displayName: row.displayName,
			shortBio: row.shortBio,
			...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
			...(avatarCrop ? { avatarCrop } : {}),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			...(row.ownerHandle && row.ownerDisplayName ?
				{
					owner: {
						id: row.ownerUserId,
						handle: row.ownerHandle,
						displayName: row.ownerDisplayName,
						...(row.ownerAvatarUrl ? { avatarUrl: row.ownerAvatarUrl } : {}),
						profileComplete: Boolean(row.ownerProfileCompletedAt),
						...(row.ownerProfileCompletedAt ? { profileCompletedAt: row.ownerProfileCompletedAt } : {}),
					},
				}
			:	{}),
		});
	}
	return [...groups.values()];
}

function deletedUserHandle(userId: string): string {
	return `deleted-${userId.replace(/[^a-z0-9_-]/gi, "-").slice(0, 24)}`.slice(0, 32);
}

export async function worldByHandle(
	db: D1DatabaseLike,
	worldHandle: string,
): Promise<{ id: string; handle: string; postingSettings?: PostingSettings }> {
	const world = await db
		.prepare(
			`SELECT
				world_id AS id,
				handle,
				posting_thread_body_characters AS postingThreadBodyCharacters,
				posting_comment_body_characters AS postingCommentBodyCharacters
			 FROM worlds_index
			 WHERE handle = ? AND deleted_at IS NULL`,
		)
		.bind(worldHandle)
		.first<{ id: string; handle: string; postingThreadBodyCharacters: number | null; postingCommentBodyCharacters: number | null }>();
	if (!world) {
		throw new RepositoryError("not_found", "World not found.", 404);
	}

	return {
		id: world.id,
		handle: world.handle,
		...postingSettingsObject(world.postingThreadBodyCharacters, world.postingCommentBodyCharacters),
	};
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

	return normalizeBotDefaults(bot);
}

type PersonalForumRename = {
	updated: ForumDocument;
};

async function assertBotHandleAvailable(
	db: D1DatabaseLike,
	worldId: string,
	currentBotId: string,
	handle: string,
): Promise<void> {
	const existing = await db
		.prepare(
			`SELECT bot_id AS id
			 FROM bots_index
			 WHERE home_world_id = ? AND handle = ? AND deleted_at IS NULL`,
		)
		.bind(worldId, handle)
		.first<{ id: string }>();
	if (existing && existing.id !== currentBotId) {
		throw new RepositoryError("conflict", "A bot with that handle already exists in this world.", 409);
	}
}

async function personalForumRenameForBotHandle(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	bot: BotDocument,
	nextHandle: string,
	now: string,
): Promise<PersonalForumRename | null> {
	const row = await db
		.prepare(
			`SELECT forum_id AS id, handle
			 FROM forums_index
			 WHERE personal_bot_id = ? AND deleted_at IS NULL`,
		)
		.bind(bot.id)
		.first<{ id: string; handle: string }>();
	if (!row || row.handle !== bot.handle) {
		return null;
	}

	const existing = await db
		.prepare(
			`SELECT forum_id AS id
			 FROM forums_index
			 WHERE world_id = ? AND handle = ? AND deleted_at IS NULL`,
		)
		.bind(bot.homeWorldId, nextHandle)
		.first<{ id: string }>();
	if (existing && existing.id !== row.id) {
		throw new RepositoryError("conflict", "A forum with that handle already exists in this world.", 409);
	}

	const forum = await readJson<ForumDocument>(kv, kvKeys.forum(row.id));
	if (!forum || forum.deletedAt) {
		throw new RepositoryError("server_error", "Personal forum document is missing.", 500);
	}
	return {
		updated: {
			...forum,
			handle: nextHandle,
			revision: forum.revision + 1,
			updatedAt: now,
		},
	};
}

async function writePersonalForumThreadRenameDocuments(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	forum: ForumDocument,
	now: string,
): Promise<void> {
	const threads = await db
		.prepare(`SELECT thread_id AS id FROM threads_index WHERE forum_id = ? AND deleted_at IS NULL`)
		.bind(forum.id)
		.all<{ id: string }>();
	for (const row of threads.results ?? []) {
		const thread = await readJson<ThreadDocument>(kv, kvKeys.thread(row.id));
		if (!thread || thread.deletedAt || thread.forumHandle === forum.handle) {
			continue;
		}
		const renamed: ThreadDocument = {
			...thread,
			forumHandle: forum.handle,
			revision: thread.revision + 1,
			updatedAt: now,
		};
		await writeJson(kv, kvKeys.thread(renamed.id), renamed);
		await putObjectIndex(db, renamed, "thread", renamed.worldId);
	}
}

const maxCloneChainDepth = 16;

type EffectiveBotContext = {
	cache: Map<string, BotDocument>;
	visiting: Set<string>;
};

function emptyEffectiveBotContext(): EffectiveBotContext {
	return { cache: new Map(), visiting: new Set() };
}

async function effectiveBotDocuments(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	bots: BotDocument[],
): Promise<BotDocument[]> {
	const context = emptyEffectiveBotContext();
	return Promise.all(bots.map((bot) => effectiveBotDocument(kv, db, bot, context)));
}

async function effectiveBotDocument(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	bot: BotDocument,
	context = emptyEffectiveBotContext(),
	depth = 0,
): Promise<BotDocument> {
	const normalized = normalizeBotDefaults(bot);
	const cached = context.cache.get(normalized.id);
	if (cached) {
		return cached;
	}
	if (depth > maxCloneChainDepth) {
		throw new RepositoryError("conflict", "Clone source chain is too deep.", 409);
	}
	if (context.visiting.has(normalized.id)) {
		throw new RepositoryError("conflict", "Clone source cycle detected.", 409);
	}

	const cloneSource = await cloneSourceByBotId(db, normalized.id);
	const localOverrides = cloneSource ? botLocalOverrides(normalized) : undefined;
	if (!cloneSource?.linked) {
		const sourceSummary = cloneSource && cloneSource.sourceBotId !== normalized.id ?
			await cloneSourceSummary(kv, db, cloneSource, context, depth)
		:	cloneSource ?? undefined;
		const resolved = {
			...normalized,
			...(sourceSummary ? { cloneSource: sourceSummary } : {}),
			...(localOverrides ? { localOverrides } : {}),
		};
		context.cache.set(normalized.id, resolved);
		return resolved;
	}

	context.visiting.add(normalized.id);
	try {
		const sourceRaw = await sourceRawBotForLinkedClone(kv, db, cloneSource);
		const sourceEffective = await effectiveBotDocument(kv, db, sourceRaw, context, depth + 1);
		const inheritedInference = hasInferenceText(normalized.inferenceSettings.model) ?
			normalized.inferenceSettings
		:	cloneInferenceSettings(sourceEffective.inferenceSettings);
		const resolved: BotDocument = {
			...normalized,
			displayName: hasProfileText(normalized.displayName) ? normalized.displayName : sourceEffective.displayName,
			shortBio: hasProfileText(normalized.shortBio) ? normalized.shortBio : sourceEffective.shortBio,
			prompt: hasProfileText(normalized.prompt) ? normalized.prompt : sourceEffective.prompt,
			inferenceSettings: inheritedInference,
			...(normalized.avatar ? { avatar: normalized.avatar } : sourceEffective.avatar ? { avatar: sourceEffective.avatar } : { avatar: undefined }),
			cloneSource: { ...cloneSource, sourceBot: cloneSourceBotProfile(sourceEffective) },
			...(localOverrides ? { localOverrides } : {}),
		};
		context.cache.set(normalized.id, resolved);
		return resolved;
	} finally {
		context.visiting.delete(normalized.id);
	}
}

async function sourceRawBotForLinkedClone(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	cloneSource: BotCloneSource,
): Promise<BotDocument> {
	try {
		return await rawBotById(kv, db, cloneSource.sourceBotId);
	} catch (error) {
		if (error instanceof RepositoryError && error.code === "not_found") {
			throw new RepositoryError("server_error", "Linked clone source is missing.", 500);
		}
		throw error;
	}
}

async function cloneSourceSummary(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	cloneSource: BotCloneSource,
	context: EffectiveBotContext,
	depth: number,
): Promise<BotCloneSourceSummary> {
	try {
		const source = await effectiveBotDocument(kv, db, await rawBotById(kv, db, cloneSource.sourceBotId), context, depth + 1);
		return { ...cloneSource, sourceBot: cloneSourceBotProfile(source) };
	} catch (error) {
		if (error instanceof RepositoryError && error.code === "not_found") {
			return cloneSource;
		}
		throw error;
	}
}

function cloneSourceBotProfile(bot: BotDocument): NonNullable<BotCloneSourceSummary["sourceBot"]> {
	return {
		id: bot.id,
		homeWorldId: bot.homeWorldId,
		homeWorldHandle: bot.homeWorldHandle,
		handle: bot.handle,
		displayName: bot.displayName,
		shortBio: bot.shortBio,
		...(bot.avatar ? { avatarUrl: bot.avatar.url } : {}),
		...(bot.avatar?.crop ? { avatarCrop: bot.avatar.crop } : {}),
	};
}

function botLocalOverrides(bot: BotDocument): BotLocalOverrides {
	return {
		displayName: bot.displayName,
		shortBio: bot.shortBio,
		prompt: bot.prompt,
		inferenceSettings: cloneInferenceSettings(bot.inferenceSettings),
		hasAvatar: Boolean(bot.avatar),
		...(bot.avatar ? { avatar: bot.avatar, avatarUrl: bot.avatar.url } : {}),
		...(bot.avatar?.crop ? { avatarCrop: bot.avatar.crop } : {}),
	};
}

async function cloneSourceByBotId(db: D1DatabaseLike, botId: string): Promise<BotCloneSource | null> {
	const row = await db
		.prepare(
			`SELECT
				bot_id AS botId,
				source_bot_id AS sourceBotId,
				source_world_id AS sourceWorldId,
				source_world_handle AS sourceWorldHandle,
				source_handle AS sourceHandle,
				cloned_at AS clonedAt,
				linked,
				unlinked_at AS unlinkedAt,
				relinked_at AS relinkedAt
			 FROM bot_clone_sources
			 WHERE bot_id = ?`,
		)
		.bind(botId)
		.first<BotCloneSourceRow>();
	return row ? cloneSourceFromRow(row) : null;
}

function cloneSourceFromRow(row: BotCloneSourceRow): BotCloneSource {
	return {
		sourceBotId: row.sourceBotId,
		sourceWorldId: row.sourceWorldId,
		sourceWorldHandle: row.sourceWorldHandle,
		sourceHandle: row.sourceHandle,
		clonedAt: row.clonedAt,
		linked: row.linked !== 0,
		...(row.unlinkedAt ? { unlinkedAt: row.unlinkedAt } : {}),
		...(row.relinkedAt ? { relinkedAt: row.relinkedAt } : {}),
	};
}

async function insertBotCloneSource(
	db: D1DatabaseLike,
	bot: BotDocument,
	source: BotDocument,
	now: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO bot_clone_sources (
				bot_id, source_bot_id, source_world_id, source_world_handle, source_handle,
				cloned_at, linked, unlinked_at, relinked_at
			) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL)`,
		)
		.bind(bot.id, source.id, source.homeWorldId, source.homeWorldHandle, source.handle, now)
		.run();
}

function hasProfileText(value: string | undefined): boolean {
	return Boolean(value?.trim());
}

function assertMaterializedProfileFields(displayName: string, shortBio: string, prompt: string): void {
	if (!hasProfileText(displayName)) {
		throw new RepositoryError("bad_request", "Bot name is required.", 400);
	}
	if (!hasProfileText(shortBio)) {
		throw new RepositoryError("bad_request", "Short bio is required.", 400);
	}
	if (!hasProfileText(prompt)) {
		throw new RepositoryError("bad_request", "Prompt is required.", 400);
	}
}

function cloneInferenceSettings(settings: BotInferenceSettings | undefined): BotInferenceSettings {
	return mergeInferenceSettings(undefined, settings);
}

function inferenceSettingsEqual(left: BotInferenceSettings | undefined, right: BotInferenceSettings | undefined): boolean {
	return JSON.stringify(cloneInferenceSettings(left)) === JSON.stringify(cloneInferenceSettings(right));
}

function avatarEquivalentForRelink(left: AvatarImage | undefined, right: AvatarImage | undefined): boolean {
	if (!left || !right) {
		return false;
	}
	return (
		left.contentType === right.contentType &&
		left.byteLength === right.byteLength &&
		left.width === right.width &&
		left.height === right.height &&
		JSON.stringify(left.crop ?? null) === JSON.stringify(right.crop ?? null) &&
		JSON.stringify(left.source ?? null) === JSON.stringify(right.source ?? null)
	);
}

async function hasLinkedCloneDescendants(db: D1DatabaseLike, sourceBotId: string): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT c.bot_id AS id
			 FROM bot_clone_sources c
			 JOIN bots_index b ON b.bot_id = c.bot_id AND b.deleted_at IS NULL
			 WHERE c.source_bot_id = ? AND c.linked = 1
			 LIMIT 1`,
		)
		.bind(sourceBotId)
		.first<{ id: string }>();
	return Boolean(row);
}

async function linkedCloneChildIds(db: D1DatabaseLike, sourceBotId: string): Promise<string[]> {
	const result = await db
		.prepare(
			`SELECT c.bot_id AS id
			 FROM bot_clone_sources c
			 JOIN bots_index b ON b.bot_id = c.bot_id AND b.deleted_at IS NULL
			 WHERE c.source_bot_id = ? AND c.linked = 1
			 ORDER BY b.updated_at ASC, b.handle ASC`,
		)
		.bind(sourceBotId)
		.all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id);
}

export async function refreshLinkedCloneIndexes(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	sourceBotId: string,
): Promise<BotSummary[]> {
	const summaries: BotSummary[] = [];
	const seen = new Set<string>();
	const queue = [sourceBotId];
	while (queue.length > 0) {
		const currentSourceId = queue.shift() ?? "";
		const childIds = await linkedCloneChildIds(db, currentSourceId);
		for (const childId of childIds) {
			if (seen.has(childId)) {
				continue;
			}
			seen.add(childId);
			const raw = await rawBotById(kv, db, childId);
			const effective = await effectiveBotDocument(kv, db, raw);
			await upsertBotIndex(db, effective);
			await putObjectIndex(db, raw, "bot", raw.homeWorldId);
			await upsertBotSearchIndex(db, effective);
			const worldPostingSettings = await worldPostingSettingsById(db, raw.homeWorldId);
			summaries.push(botSummary(effective, {
				includeToolSettings: true,
				nextDueAt: await botRuntimeNextDueAt(db, raw.id),
				worldPostingSettings,
			}));
			queue.push(childId);
		}
	}
	return attachBotOwners(db, summaries);
}

async function assertNoCloneCycle(db: D1DatabaseLike, botId: string, sourceBotId: string): Promise<void> {
	let currentId = sourceBotId;
	const visited = new Set<string>([botId]);
	for (let depth = 0; depth <= maxCloneChainDepth; depth += 1) {
		if (visited.has(currentId)) {
			throw new RepositoryError("conflict", "Clone source cycle detected.", 409);
		}
		visited.add(currentId);
		const source = await cloneSourceByBotId(db, currentId);
		if (!source?.linked) {
			return;
		}
		currentId = source.sourceBotId;
	}
	throw new RepositoryError("conflict", "Clone source chain is too deep.", 409);
}

async function upsertBotIndex(db: D1DatabaseLike, bot: BotDocument): Promise<void> {
	await db
		.prepare(
			`INSERT INTO bots_index (
				bot_id, home_world_id, home_world_handle, handle, display_name, owner_user_id,
				short_bio, avatar_url, avatar_crop, import_provider, import_external_handle, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(bot_id) DO UPDATE SET
				home_world_handle = excluded.home_world_handle,
				handle = excluded.handle,
				display_name = excluded.display_name,
				short_bio = excluded.short_bio,
				avatar_url = excluded.avatar_url,
				avatar_crop = excluded.avatar_crop,
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
			bot.avatar?.url ?? null,
			avatarCropJson(bot.avatar?.crop),
			bot.importSource?.provider ?? null,
			bot.importSource?.originalHandle ?? null,
			bot.createdAt,
			bot.updatedAt,
			bot.deletedAt ?? null,
		)
		.run();
}

function botIndexUpdateStatement(db: D1DatabaseLike, bot: BotDocument): D1PreparedStatementLike {
	return db
		.prepare(
			`UPDATE bots_index
			 SET home_world_handle = ?,
			     handle = ?,
			     display_name = ?,
			     short_bio = ?,
			     avatar_url = ?,
			     avatar_crop = ?,
			     updated_at = ?,
			     deleted_at = ?
			 WHERE bot_id = ?`,
		)
		.bind(
			bot.homeWorldHandle,
			bot.handle,
			bot.displayName,
			bot.shortBio,
			bot.avatar?.url ?? null,
			avatarCropJson(bot.avatar?.crop),
			bot.updatedAt,
			bot.deletedAt ?? null,
			bot.id,
		);
}

async function uniqueUserHandle(db: D1DatabaseLike, preferred: string): Promise<string> {
	const base = slugifyHandle(preferred, "user", 24);

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
		initialBotNotification: world.initialBotNotification,
		...(postingSettingsHasValues(world.postingSettings) ? { postingSettings: world.postingSettings } : {}),
		createdByUserId: world.createdByUserId,
		createdAt: world.createdAt,
		updatedAt: world.updatedAt,
	};
}

function worldSummaryFromIndexRow<T extends WorldSummaryIndexRow>(row: T): Omit<T, keyof WorldSummaryIndexRow> & WorldSummary {
	const {
		postingThreadBodyCharacters,
		postingCommentBodyCharacters,
		...world
	} = row;
	return {
		...world,
		...postingSettingsObject(postingThreadBodyCharacters, postingCommentBodyCharacters),
	} as Omit<T, keyof WorldSummaryIndexRow> & WorldSummary;
}

function postingSettingsObject(
	threadBodyCharacters: number | null | undefined,
	commentBodyCharacters: number | null | undefined,
): { postingSettings?: PostingSettings } {
	const postingSettings: PostingSettings = {
		...(threadBodyCharacters !== null && threadBodyCharacters !== undefined ? { threadBodyCharacters } : {}),
		...(commentBodyCharacters !== null && commentBodyCharacters !== undefined ? { commentBodyCharacters } : {}),
	};
	return postingSettingsHasValues(postingSettings) ? { postingSettings } : {};
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

function botSummary(
	bot: BotDocument,
	options: {
		includePrompt?: boolean;
		includeToolSettings?: boolean;
		nextDueAt?: string | null;
		owner?: PublicUser;
		worldPostingSettings?: PostingSettings;
	} = {},
): BotSummary {
	return {
		id: bot.id,
		homeWorldId: bot.homeWorldId,
		homeWorldHandle: bot.homeWorldHandle,
		ownerUserId: bot.ownerUserId,
		...(options.owner ? { owner: options.owner } : {}),
		handle: bot.handle,
		displayName: bot.displayName,
		shortBio: bot.shortBio,
		...(bot.avatar ? { avatar: bot.avatar, avatarUrl: bot.avatar.url } : {}),
		...(bot.avatar?.crop ? { avatarCrop: bot.avatar.crop } : {}),
		...(options.includePrompt === false ? {} : { prompt: bot.prompt }),
		inferenceSettings: publicInferenceSettings(bot.inferenceSettings),
		...(options.includeToolSettings ? { toolSettings: publicToolSettings(bot.toolSettings) } : {}),
		postingSettings: mergePostingSettings(bot.postingSettings, undefined),
		effectivePostingSettings: effectivePostingSettings(options.worldPostingSettings, bot.postingSettings),
		tickSettings: bot.tickSettings,
		effectiveTickSettings: effectiveTickSettings(bot.tickSettings),
		...(bot.importSource ? { importSource: bot.importSource } : {}),
		...(bot.cloneSource ? { cloneSource: bot.cloneSource } : {}),
		...(bot.localOverrides ? { localOverrides: publicBotLocalOverrides(bot.localOverrides) } : {}),
		...(options.nextDueAt !== undefined ? { nextDueAt: options.nextDueAt } : {}),
		createdAt: bot.createdAt,
		updatedAt: bot.updatedAt,
	};
}

function publicBotLocalOverrides(overrides: BotLocalOverrides): BotLocalOverrides {
	return {
		displayName: overrides.displayName,
		shortBio: overrides.shortBio,
		...(overrides.prompt !== undefined ? { prompt: overrides.prompt } : {}),
		inferenceSettings: publicInferenceSettings(overrides.inferenceSettings),
		hasAvatar: overrides.hasAvatar,
		...(overrides.avatar ? { avatar: overrides.avatar, avatarUrl: overrides.avatar.url } : {}),
		...(overrides.avatar?.crop ? { avatarCrop: overrides.avatar.crop } : {}),
	};
}

function botSummaryWithLastActive(
	bot: BotDocument,
	lastActiveAt?: string | null,
	options: {
		includePrompt?: boolean;
		includeToolSettings?: boolean;
		nextDueAt?: string | null;
		owner?: PublicUser;
		worldPostingSettings?: PostingSettings;
	} = {},
): BotSummary {
	return {
		...botSummary(bot, options),
		lastActiveAt: lastActiveAt ?? bot.createdAt,
	};
}

async function botRuntimeNextDueAt(db: D1DatabaseLike, botId: string): Promise<string | null> {
	const row = await db
		.prepare(`SELECT next_due_at AS nextDueAt FROM bot_runtime_index WHERE bot_id = ?`)
		.bind(botId)
		.first<{ nextDueAt: string | null }>();
	return row?.nextDueAt ?? null;
}

async function createPersonalForumForBot(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	bot: BotDocument,
	userId: string,
	now: string,
): Promise<void> {
	const existing = await db
		.prepare(`SELECT forum_id AS id FROM forums_index WHERE personal_bot_id = ? AND deleted_at IS NULL`)
		.bind(bot.id)
		.first<{ id: string }>();
	if (existing) {
		return;
	}

	const handle = await uniqueForumHandle(db, bot.homeWorldId, bot.handle);
	const forum: ForumDocument = {
		id: makeId("frm"),
		type: "forum",
		schemaVersion,
		revision: 1,
		worldId: bot.homeWorldId,
		worldHandle: bot.homeWorldHandle,
		handle,
		description: `Blog of ${bot.displayName} (u/${bot.handle})`,
		createdByUserId: userId,
		personalBotId: bot.id,
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.forum(forum.id), forum);
	await db
		.prepare(
			`INSERT INTO forums_index (
				forum_id, world_id, world_handle, handle, description, created_by_user_id,
				created_at, updated_at, deleted_at, personal_bot_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
			forum.personalBotId,
		)
		.run();
	await putObjectIndex(db, forum, "forum", forum.worldId);
	await upsertForumSearchIndex(db, forum);
}

async function createIntroForumForWorld(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	world: WorldDocument,
	userId: string,
	now: string,
): Promise<void> {
	const existing = await db
		.prepare(
			`SELECT forum_id AS id
			 FROM forums_index
			 WHERE world_id = ? AND handle = ? AND deleted_at IS NULL`,
		)
		.bind(world.id, introForumHandle)
		.first<{ id: string }>();
	if (existing) {
		return;
	}

	const forum: ForumDocument = {
		id: makeId("frm"),
		type: "forum",
		schemaVersion,
		revision: 1,
		worldId: world.id,
		worldHandle: world.handle,
		handle: introForumHandle,
		description: introForumDescription,
		createdByUserId: userId,
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.forum(forum.id), forum);
	await db
		.prepare(
			`INSERT INTO forums_index (
				forum_id, world_id, world_handle, handle, description, created_by_user_id,
				created_at, updated_at, deleted_at, personal_bot_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
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
	await upsertForumSearchIndex(db, forum);
}

async function autoSubscribeUserToBot(
	db: D1DatabaseLike,
	userId: string,
	bot: BotDocument,
	now: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO human_subscriptions (
				subscription_id, user_id, world_id, scope_type, scope_id,
				active, auto_created, created_at, updated_at
			) VALUES (?, ?, ?, 'bot', ?, 1, 1, ?, ?)
			ON CONFLICT(user_id, scope_type, scope_id) DO UPDATE SET
				active = 1,
				auto_created = CASE
					WHEN human_subscriptions.auto_created = 1 THEN 1
					ELSE excluded.auto_created
				END,
				updated_at = excluded.updated_at`,
		)
		.bind(makeId("hsb"), userId, bot.homeWorldId, bot.id, now, now)
		.run();
}

async function uniqueForumHandle(db: D1DatabaseLike, worldId: string, preferred: string): Promise<string> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const handle = attempt === 0 ? preferred : `${preferred}-${attempt + 1}`;
		const existing = await db
			.prepare(
				`SELECT forum_id AS id
				 FROM forums_index
				 WHERE world_id = ? AND handle = ? AND deleted_at IS NULL`,
			)
			.bind(worldId, handle)
			.first<{ id: string }>();
		if (!existing) {
			return handle;
		}
	}

	return `${preferred}-${randomToken(4)}`;
}

async function upsertBotRuntimeIndex(
	db: D1DatabaseLike,
	bot: BotDocument,
	now: string,
	options: { reschedule?: boolean; scheduleIfMissing?: boolean } = {},
): Promise<void> {
	const settings = effectiveTickSettings(bot.tickSettings);
	const contextWindowTokens = bot.tickSettings.contextWindowTokens ?? null;
	const nextDue =
		!settings.enabled ? null
		: options.scheduleIfMissing ? now
		: new Date(Date.parse(now) + settings.intervalSeconds * 1000).toISOString();
	await db
		.prepare(
			`INSERT INTO bot_runtime_index (
				bot_id, owner_user_id, world_id, enabled, tick_interval_seconds, context_window_tokens,
				compaction_threshold, compaction_summary_percent, compaction_max_characters,
				max_tool_calls_per_tick, max_successful_tool_calls_per_iteration,
				max_generated_tokens_per_tick, max_generated_tokens_per_iteration,
				next_due_at, status, active_run_id,
				lease_expires_at, last_error, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, NULL, NULL, ?, ?)
			ON CONFLICT(bot_id) DO UPDATE SET
				owner_user_id = excluded.owner_user_id,
				world_id = excluded.world_id,
				enabled = excluded.enabled,
				tick_interval_seconds = excluded.tick_interval_seconds,
				context_window_tokens = excluded.context_window_tokens,
				compaction_threshold = excluded.compaction_threshold,
				compaction_summary_percent = excluded.compaction_summary_percent,
				compaction_max_characters = excluded.compaction_max_characters,
				max_tool_calls_per_tick = excluded.max_tool_calls_per_tick,
				max_successful_tool_calls_per_iteration = excluded.max_successful_tool_calls_per_iteration,
				max_generated_tokens_per_tick = excluded.max_generated_tokens_per_tick,
				max_generated_tokens_per_iteration = excluded.max_generated_tokens_per_iteration,
				next_due_at = CASE
					WHEN excluded.enabled = 0 THEN NULL
					WHEN ? THEN COALESCE(bot_runtime_index.next_due_at, excluded.next_due_at)
					WHEN ? THEN excluded.next_due_at
					WHEN bot_runtime_index.next_due_at IS NULL THEN excluded.next_due_at
					ELSE bot_runtime_index.next_due_at
				END,
				updated_at = excluded.updated_at`,
		)
		.bind(
			bot.id,
			bot.ownerUserId,
			bot.homeWorldId,
			settings.enabled ? 1 : 0,
			settings.intervalSeconds,
			contextWindowTokens,
			settings.compactionThreshold,
			settings.compactionSummaryPercent,
			settings.compactionMaxCharacters,
			settings.maxToolCallsPerTick,
			settings.maxSuccessfulToolCallsPerIteration,
			settings.maxGeneratedTokensPerTick,
			settings.maxGeneratedTokensPerIteration,
			nextDue,
			now,
			now,
			options.scheduleIfMissing ? 1 : 0,
			options.reschedule ? 1 : 0,
		)
		.run();
}

function shouldRescheduleBotRuntime(
	previous: BotTickSettings,
	next: BotTickSettings,
	patch?: BotTickSettingsInput,
): { reschedule?: boolean; scheduleIfMissing?: boolean } {
	if (!patch) {
		return {};
	}
	if (patch.enabled !== undefined && next.enabled && !previous.enabled) {
		return { scheduleIfMissing: true };
	}
	if (patch.intervalSeconds !== undefined && next.enabled && next.intervalSeconds !== previous.intervalSeconds) {
		return { reschedule: true };
	}
	return {};
}

async function disableBotRuntime(db: D1DatabaseLike, botId: string, now: string): Promise<void> {
	await db
		.prepare(
			`UPDATE bot_runtime_index
			 SET enabled = 0, status = 'idle', active_run_id = NULL, lease_expires_at = NULL, next_due_at = NULL, updated_at = ?
			 WHERE bot_id = ?`,
		)
		.bind(now, botId)
		.run();
}

function normalizeBotDefaults(bot: BotDocument): BotDocument {
	return {
		...bot,
		inferenceSettings: mergeInferenceSettings(undefined, bot.inferenceSettings),
		toolSettings: mergeToolSettings(undefined, bot.toolSettings),
		...(postingSettingsHasValues(bot.postingSettings) ?
			{ postingSettings: mergePostingSettings(undefined, bot.postingSettings) }
		:	{ postingSettings: undefined }),
		tickSettings: mergeTickSettings(undefined, bot.tickSettings),
	};
}

function normalizeUserDefaults(user: UserDocument): UserDocument {
	return {
		...user,
		inferenceSettings: mergeInferenceSettings(undefined, user.inferenceSettings),
	};
}

export function mergeTickSettings(
	current: BotTickSettings | undefined,
	patch?: BotTickSettingsInput | BotTickSettings,
): BotTickSettings {
	const next: BotTickSettings = {
		enabled: current?.enabled ?? defaultTickSettings.enabled,
		intervalSeconds: current?.intervalSeconds ?? defaultTickSettings.intervalSeconds,
		...(current?.allowEarlyLogOff !== undefined ? { allowEarlyLogOff: current.allowEarlyLogOff } : {}),
		...(current?.contextWindowTokens !== undefined ? { contextWindowTokens: current.contextWindowTokens } : {}),
		compactionThreshold: current?.compactionThreshold ?? defaultTickSettings.compactionThreshold,
		...(current?.compactionSummaryPercent !== undefined ? { compactionSummaryPercent: current.compactionSummaryPercent } : {}),
		...(current?.compactionMaxCharacters !== undefined ? { compactionMaxCharacters: current.compactionMaxCharacters } : {}),
		...(current?.maxToolCallsPerTick !== undefined ? { maxToolCallsPerTick: current.maxToolCallsPerTick } : {}),
		...(current?.maxSuccessfulToolCallsPerIteration !== undefined ?
			{ maxSuccessfulToolCallsPerIteration: current.maxSuccessfulToolCallsPerIteration }
		:	{}),
		...(current?.maxGeneratedTokensPerTick !== undefined ? { maxGeneratedTokensPerTick: current.maxGeneratedTokensPerTick } : {}),
		...(current?.maxGeneratedTokensPerIteration !== undefined ?
			{ maxGeneratedTokensPerIteration: current.maxGeneratedTokensPerIteration }
		:	{}),
	};
	if (!patch) {
		return next;
	}

	if (patch.enabled !== undefined) {
		next.enabled = patch.enabled;
	}
	if (patch.intervalSeconds !== undefined) {
		next.intervalSeconds = patch.intervalSeconds;
	}
	assignOptionalTickBoolean(next, "allowEarlyLogOff", patch.allowEarlyLogOff);
	assignOptionalTickNumber(next, "contextWindowTokens", patch.contextWindowTokens);
	if (patch.compactionThreshold !== undefined) {
		next.compactionThreshold = patch.compactionThreshold;
	}
	assignOptionalTickNumber(next, "compactionSummaryPercent", patch.compactionSummaryPercent);
	assignOptionalTickNumber(next, "compactionMaxCharacters", patch.compactionMaxCharacters);
	assignOptionalTickNumber(next, "maxToolCallsPerTick", patch.maxToolCallsPerTick);
	assignOptionalTickNumber(next, "maxSuccessfulToolCallsPerIteration", patch.maxSuccessfulToolCallsPerIteration);
	assignOptionalTickNumber(next, "maxGeneratedTokensPerTick", patch.maxGeneratedTokensPerTick);
	assignOptionalTickNumber(next, "maxGeneratedTokensPerIteration", patch.maxGeneratedTokensPerIteration);
	return next;
}

export function effectiveTickSettings(settings: BotTickSettings | undefined): BotEffectiveTickSettings {
	const normalized = mergeTickSettings(undefined, settings);
	return {
		enabled: normalized.enabled,
		intervalSeconds: normalized.intervalSeconds,
		allowEarlyLogOff: normalized.allowEarlyLogOff ?? defaultTickSettings.allowEarlyLogOff,
		contextWindowTokens: normalized.contextWindowTokens ?? defaultTickSettings.contextWindowTokens,
		compactionThreshold: normalized.compactionThreshold,
		compactionSummaryPercent: normalized.compactionSummaryPercent ?? defaultTickSettings.compactionSummaryPercent,
		compactionMaxCharacters: normalized.compactionMaxCharacters ?? defaultTickSettings.compactionMaxCharacters,
		maxToolCallsPerTick: normalized.maxToolCallsPerTick ?? defaultTickSettings.maxToolCallsPerTick,
		maxSuccessfulToolCallsPerIteration:
			normalized.maxSuccessfulToolCallsPerIteration ?? defaultTickSettings.maxSuccessfulToolCallsPerIteration,
		maxGeneratedTokensPerTick: normalized.maxGeneratedTokensPerTick ?? defaultTickSettings.maxGeneratedTokensPerTick,
		maxGeneratedTokensPerIteration:
			normalized.maxGeneratedTokensPerIteration ?? defaultTickSettings.maxGeneratedTokensPerIteration,
	};
}

function assignOptionalTickBoolean(
	settings: BotTickSettings,
	key: "allowEarlyLogOff",
	value: boolean | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = value;
}

function assignOptionalTickNumber(
	settings: BotTickSettings,
	key:
		| "contextWindowTokens"
		| "compactionSummaryPercent"
		| "compactionMaxCharacters"
		| "maxToolCallsPerTick"
		| "maxSuccessfulToolCallsPerIteration"
		| "maxGeneratedTokensPerTick"
		| "maxGeneratedTokensPerIteration",
	value: number | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = value;
}

export function mergeInferenceSettings(
	current: BotInferenceSettings | undefined,
	patch?: BotInferenceSettingsInput | BotInferenceSettings,
): BotInferenceSettings {
	const next: BotInferenceSettings = {
		...defaultInferenceSettings,
		...(current ?? {}),
		...(current?.imageGeneration ? { imageGeneration: cloneImageGenerationSettings(current.imageGeneration) } : {}),
		...(current?.translation ? { translation: cloneTranslationSettings(current.translation) } : {}),
		...(current?.providerRouting ? { providerRouting: cloneJsonObject(current.providerRouting) } : {}),
	};
	delete next.openRouterApiKeySet;
	if (!next.recurringPrompt && next.reasoningPrefill) {
		next.recurringPrompt = next.reasoningPrefill;
	}
	delete next.reasoningPrefill;
	if (next.recurringPromptEnabled !== false) {
		delete next.recurringPromptEnabled;
	}
	if (!patch) {
		return next;
	}

	assignInferenceString(next, "openRouterApiKey", patch.openRouterApiKey);
	assignInferenceString(next, "baseUrl", patch.baseUrl);
	assignInferenceString(next, "model", patch.model);
	assignInferenceCompactionMode(next, "compactionMode", patch.compactionMode);
	assignInferenceBoolean(next, "cacheFriendlyCompaction", patch.cacheFriendlyCompaction);
	assignInferenceDefaultTrueBoolean(next, "recurringPromptEnabled", patch.recurringPromptEnabled);
	const recurringPromptPatch = Object.prototype.hasOwnProperty.call(patch, "recurringPrompt")
		? patch.recurringPrompt
		: patch.reasoningPrefill;
	assignInferencePreservedString(next, "recurringPrompt", recurringPromptPatch);
	assignInferenceBoolean(next, "supportsPrefill", patch.supportsPrefill);
	assignInferenceReasoningEffort(next, "reasoningEffort", patch.reasoningEffort);
	assignInferenceToolCalls(next, "toolCalls", patch.toolCalls);
	assignInferenceJsonObject(next, "providerRouting", patch.providerRouting);
	if (patch.imageGeneration !== undefined) {
		const imageGeneration = mergeImageGenerationSettings(next.imageGeneration, patch.imageGeneration);
		if (imageGeneration) {
			next.imageGeneration = imageGeneration;
		} else {
			delete next.imageGeneration;
		}
	}
	if (patch.translation !== undefined) {
		const translation = mergeTranslationSettings(next.translation, patch.translation);
		if (translation) {
			next.translation = translation;
		} else {
			delete next.translation;
		}
	}
	assignInferenceNumber(next, "temperature", patch.temperature);
	assignInferenceNumber(next, "topK", patch.topK);
	assignInferenceNumber(next, "topP", patch.topP);
	assignInferenceNumber(next, "minP", patch.minP);
	assignInferenceNumber(next, "frequencyPenalty", patch.frequencyPenalty);
	assignInferenceNumber(next, "presencePenalty", patch.presencePenalty);
	assignInferenceNumber(next, "repetitionPenalty", patch.repetitionPenalty);
	if (next.recurringPromptEnabled !== false) {
		delete next.recurringPromptEnabled;
	}
	return next;
}

export function enforceInferenceModelAccess(
	settings: BotInferenceSettings,
	inherited?: BotInferenceSettings,
): BotInferenceSettings {
	const canCustomizeModel =
		hasInferenceText(settings.openRouterApiKey) ||
		hasInferenceText(settings.baseUrl) ||
		hasInferenceText(inherited?.openRouterApiKey) ||
		hasInferenceText(inherited?.baseUrl);
	if (!canCustomizeModel) {
		delete settings.model;
		if (settings.translation) {
			delete settings.translation.model;
		}
	}
	return settings;
}

function publicInferenceSettings(settings: BotInferenceSettings | undefined): BotInferenceSettings {
	const normalized = mergeInferenceSettings(undefined, settings);
	const { openRouterApiKey, openRouterApiKeySet: _openRouterApiKeySet, ...publicSettings } = normalized;
	return {
		...publicSettings,
		...(openRouterApiKey ? { openRouterApiKeySet: true } : {}),
	};
}

export function mergeToolSettings(
	current: BotToolSettings | undefined,
	patch?: BotToolSettingsInput | BotToolSettings,
): BotToolSettings {
	const next: BotToolSettings = {
		...defaultToolSettings,
		...(current?.openRouter ? { openRouter: cloneOpenRouterToolSettings(current.openRouter) } : {}),
	};
	if (!patch) {
		return next;
	}
	if (patch.openRouter === undefined) {
		return next;
	}
	if (patch.openRouter === null) {
		delete next.openRouter;
		return next;
	}
	next.openRouter = mergeOpenRouterToolSettings(next.openRouter, patch.openRouter);
	if (!next.openRouter) {
		delete next.openRouter;
	}
	return next;
}

function publicToolSettings(settings: BotToolSettings | undefined): BotToolSettings {
	return mergeToolSettings(undefined, settings);
}

function cloneOpenRouterToolSettings(settings: OpenRouterServerToolSettings): OpenRouterServerToolSettings {
	return {
		...(settings.datetime ? { datetime: { ...settings.datetime } } : {}),
		...(settings.webSearch ?
			{
				webSearch: {
					...settings.webSearch,
					...(settings.webSearch.userLocation ?
						{ userLocation: { ...settings.webSearch.userLocation } }
					:	{}),
					...(settings.webSearch.allowedDomains ?
						{ allowedDomains: [...settings.webSearch.allowedDomains] }
					:	{}),
					...(settings.webSearch.excludedDomains ?
						{ excludedDomains: [...settings.webSearch.excludedDomains] }
					:	{}),
				},
			}
		:	{}),
		...(settings.webFetch ?
			{
				webFetch: {
					...settings.webFetch,
					...(settings.webFetch.allowedDomains ? { allowedDomains: [...settings.webFetch.allowedDomains] } : {}),
					...(settings.webFetch.blockedDomains ? { blockedDomains: [...settings.webFetch.blockedDomains] } : {}),
				},
			}
		:	{}),
	};
}

function mergeOpenRouterToolSettings(
	current: OpenRouterServerToolSettings | undefined,
	patch: OpenRouterServerToolSettingsInput | OpenRouterServerToolSettings,
): OpenRouterServerToolSettings | undefined {
	const next = current ? cloneOpenRouterToolSettings(current) : {};
	if (patch.datetime !== undefined) {
		if (patch.datetime === null) {
			delete next.datetime;
		} else {
			next.datetime = mergeOpenRouterDatetimeTool(next.datetime, patch.datetime);
			if (!next.datetime) {
				delete next.datetime;
			}
		}
	}
	if (patch.webSearch !== undefined) {
		if (patch.webSearch === null) {
			delete next.webSearch;
		} else {
			next.webSearch = mergeOpenRouterWebSearchTool(next.webSearch, patch.webSearch);
			if (!next.webSearch) {
				delete next.webSearch;
			}
		}
	}
	if (patch.webFetch !== undefined) {
		if (patch.webFetch === null) {
			delete next.webFetch;
		} else {
			next.webFetch = mergeOpenRouterWebFetchTool(next.webFetch, patch.webFetch);
			if (!next.webFetch) {
				delete next.webFetch;
			}
		}
	}
	return Object.keys(next).length > 0 ? next : undefined;
}

function mergeOpenRouterDatetimeTool(
	current: OpenRouterDatetimeToolSettings | undefined,
	patch: OpenRouterDatetimeToolSettingsInput | OpenRouterDatetimeToolSettings,
): OpenRouterDatetimeToolSettings | undefined {
	const next: Partial<OpenRouterDatetimeToolSettings> = current ? { ...current } : {};
	if (patch.enabled !== undefined) {
		next.enabled = patch.enabled;
	}
	assignToolString(next, "timezone", patch.timezone);
	if (!next.enabled && !next.timezone) {
		return undefined;
	}
	next.enabled ??= false;
	return next as OpenRouterDatetimeToolSettings;
}

function mergeOpenRouterWebSearchTool(
	current: OpenRouterWebSearchToolSettings | undefined,
	patch: OpenRouterWebSearchToolSettingsInput | OpenRouterWebSearchToolSettings,
): OpenRouterWebSearchToolSettings | undefined {
	const next: Partial<OpenRouterWebSearchToolSettings> = current ?
		{
			...current,
			...(current.userLocation ? { userLocation: { ...current.userLocation } } : {}),
			...(current.allowedDomains ? { allowedDomains: [...current.allowedDomains] } : {}),
			...(current.excludedDomains ? { excludedDomains: [...current.excludedDomains] } : {}),
		}
	:	{};
	if (patch.enabled !== undefined) {
		next.enabled = patch.enabled;
	}
	assignToolString(next, "engine", patch.engine);
	assignToolNumber(next, "maxResults", patch.maxResults);
	assignToolNumber(next, "maxTotalResults", patch.maxTotalResults);
	assignToolString(next, "searchContextSize", patch.searchContextSize);
	if (patch.userLocation !== undefined) {
		next.userLocation =
			patch.userLocation === null ? undefined : mergeOpenRouterUserLocation(next.userLocation, patch.userLocation);
	}
	assignToolStringList(next, "allowedDomains", patch.allowedDomains);
	assignToolStringList(next, "excludedDomains", patch.excludedDomains);
	if (!next.enabled && !webSearchHasParameters(next)) {
		return undefined;
	}
	next.enabled ??= false;
	return next as OpenRouterWebSearchToolSettings;
}

function mergeOpenRouterUserLocation(
	current: OpenRouterWebSearchUserLocation | undefined,
	patch: OpenRouterWebSearchUserLocationInput | OpenRouterWebSearchUserLocation,
): OpenRouterWebSearchUserLocation | undefined {
	const next: Partial<OpenRouterWebSearchUserLocation> = current ? { ...current } : { type: "approximate" };
	assignToolString(next, "city", patch.city);
	assignToolString(next, "region", patch.region);
	assignToolString(next, "country", patch.country);
	assignToolString(next, "timezone", patch.timezone);
	return next.city || next.region || next.country || next.timezone ? next as OpenRouterWebSearchUserLocation : undefined;
}

function mergeOpenRouterWebFetchTool(
	current: OpenRouterWebFetchToolSettings | undefined,
	patch: OpenRouterWebFetchToolSettingsInput | OpenRouterWebFetchToolSettings,
): OpenRouterWebFetchToolSettings | undefined {
	const next: Partial<OpenRouterWebFetchToolSettings> = current ?
		{
			...current,
			...(current.allowedDomains ? { allowedDomains: [...current.allowedDomains] } : {}),
			...(current.blockedDomains ? { blockedDomains: [...current.blockedDomains] } : {}),
		}
	:	{};
	if (patch.enabled !== undefined) {
		next.enabled = patch.enabled;
	}
	assignToolString(next, "engine", patch.engine);
	assignToolNumber(next, "maxUses", patch.maxUses);
	assignToolNumber(next, "maxContentTokens", patch.maxContentTokens);
	assignToolStringList(next, "allowedDomains", patch.allowedDomains);
	assignToolStringList(next, "blockedDomains", patch.blockedDomains);
	if (!next.enabled && !webFetchHasParameters(next)) {
		return undefined;
	}
	next.enabled ??= false;
	return next as OpenRouterWebFetchToolSettings;
}

function webSearchHasParameters(settings: Partial<OpenRouterWebSearchToolSettings>): boolean {
	return Boolean(
		settings.engine ||
			settings.maxResults !== undefined ||
			settings.maxTotalResults !== undefined ||
			settings.searchContextSize ||
			settings.userLocation ||
			settings.allowedDomains ||
			settings.excludedDomains,
	);
}

function webFetchHasParameters(settings: Partial<OpenRouterWebFetchToolSettings>): boolean {
	return Boolean(
		settings.engine ||
			settings.maxUses !== undefined ||
			settings.maxContentTokens !== undefined ||
			settings.allowedDomains ||
			settings.blockedDomains,
	);
}

function assignToolString<T extends object, K extends keyof T>(
	settings: T,
	key: K,
	value: string | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	const trimmed = value.trim();
	if (trimmed) {
		settings[key] = trimmed as T[K];
	} else {
		delete settings[key];
	}
}

function assignToolNumber<T extends object, K extends keyof T>(
	settings: T,
	key: K,
	value: number | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = value as T[K];
}

function assignToolStringList<T extends object, K extends keyof T>(
	settings: T,
	key: K,
	value: string[] | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null || value.length === 0) {
		delete settings[key];
		return;
	}
	settings[key] = [...value] as T[K];
}

function assignInferenceString(
	settings: BotInferenceSettings,
	key: "openRouterApiKey" | "baseUrl" | "model",
	value: string | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	const trimmed = value.trim();
	if (trimmed) {
		settings[key] = trimmed;
	} else {
		delete settings[key];
	}
}

function assignInferencePreservedString(
	settings: BotInferenceSettings,
	key: "recurringPrompt",
	value: string | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null || !value.trim()) {
		delete settings[key];
		return;
	}
	settings[key] = value;
}

function assignInferenceDefaultTrueBoolean(
	settings: BotInferenceSettings,
	key: "recurringPromptEnabled",
	value: boolean | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === false) {
		settings[key] = false;
		return;
	}
	delete settings[key];
}

function assignInferenceBoolean(
	settings: BotInferenceSettings,
	key: "cacheFriendlyCompaction" | "supportsPrefill",
	value: boolean | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = value;
}

function assignInferenceReasoningEffort<T extends { reasoningEffort?: BotInferenceReasoningEffort }>(
	settings: T,
	key: "reasoningEffort",
	value: BotInferenceReasoningEffort | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null || value === "default") {
		delete settings[key];
		return;
	}
	settings[key] = value;
}

function assignInferenceToolCalls<T extends { toolCalls?: BotInferenceToolCalls }>(
	settings: T,
	key: "toolCalls",
	value: BotInferenceToolCalls | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = value;
}

function assignInferenceCompactionMode<T extends { compactionMode?: BotCompactionMode }>(
	settings: T,
	key: "compactionMode",
	value: BotCompactionMode | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = value;
}

function assignStructuredToolCalls<T extends { toolCalls?: BotStructuredToolCalls }>(
	settings: T,
	key: "toolCalls",
	value: BotStructuredToolCalls | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = value;
}

function assignInferenceJsonObject(
	settings: BotInferenceSettings,
	key: "providerRouting",
	value: JsonObject | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = cloneJsonObject(value);
}

type InferenceNumberSettingKey =
	| "temperature"
	| "topK"
	| "topP"
	| "minP"
	| "frequencyPenalty"
	| "presencePenalty"
	| "repetitionPenalty";

function assignInferenceNumber(
	settings: BotInferenceSettings,
	key: InferenceNumberSettingKey,
	value: number | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = value;
}

function cloneJsonObject(value: JsonObject): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function cloneImageGenerationSettings(settings: BotImageGenerationSettings): BotImageGenerationSettings {
	return {
		...settings,
		...(settings.providerRouting ? { providerRouting: cloneJsonObject(settings.providerRouting) } : {}),
	};
}

function mergeImageGenerationSettings(
	current: BotImageGenerationSettings | undefined,
	patch: BotImageGenerationSettingsInput | BotImageGenerationSettings | null,
): BotImageGenerationSettings | undefined {
	if (patch === null) {
		return undefined;
	}
	const next: BotImageGenerationSettings = current ? cloneImageGenerationSettings(current) : {};
	assignImageGenerationString(next, "model", patch.model);
	assignImageGenerationString(next, "prompt", patch.prompt);
	assignImageGenerationJsonObject(next, "providerRouting", patch.providerRouting);
	assignImageGenerationString(next, "aspectRatio", patch.aspectRatio);
	assignImageGenerationString(next, "imageSize", patch.imageSize);
	assignImageGenerationNumber(next, "temperature", patch.temperature);
	assignImageGenerationNumber(next, "topK", patch.topK);
	assignImageGenerationNumber(next, "topP", patch.topP);
	assignImageGenerationNumber(next, "minP", patch.minP);
	assignImageGenerationNumber(next, "frequencyPenalty", patch.frequencyPenalty);
	assignImageGenerationNumber(next, "presencePenalty", patch.presencePenalty);
	assignImageGenerationNumber(next, "repetitionPenalty", patch.repetitionPenalty);
	return imageGenerationSettingsHasValues(next) ? next : undefined;
}

function assignImageGenerationString(
	settings: BotImageGenerationSettings,
	key: "model" | "prompt" | "aspectRatio" | "imageSize",
	value: string | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	const trimmed = value.trim();
	if (trimmed) {
		settings[key] = trimmed;
	} else {
		delete settings[key];
	}
}

function assignImageGenerationJsonObject(
	settings: BotImageGenerationSettings,
	key: "providerRouting",
	value: JsonObject | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = cloneJsonObject(value);
}

type ImageGenerationNumberSettingKey = Exclude<InferenceNumberSettingKey, never>;

function assignImageGenerationNumber(
	settings: BotImageGenerationSettings,
	key: ImageGenerationNumberSettingKey,
	value: number | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = value;
}

function imageGenerationSettingsHasValues(settings: BotImageGenerationSettings): boolean {
	return (
		hasInferenceText(settings.model) ||
		hasInferenceText(settings.prompt) ||
		settings.providerRouting !== undefined ||
		hasInferenceText(settings.aspectRatio) ||
		hasInferenceText(settings.imageSize) ||
		settings.temperature !== undefined ||
		settings.topK !== undefined ||
		settings.topP !== undefined ||
		settings.minP !== undefined ||
		settings.frequencyPenalty !== undefined ||
		settings.presencePenalty !== undefined ||
		settings.repetitionPenalty !== undefined
	);
}

function cloneTranslationSettings(settings: BotTranslationSettings): BotTranslationSettings {
	return {
		...settings,
		...(settings.providerRouting ? { providerRouting: cloneJsonObject(settings.providerRouting) } : {}),
	};
}

function mergeTranslationSettings(
	current: BotTranslationSettings | undefined,
	patch: BotTranslationSettingsInput | BotTranslationSettings | null,
): BotTranslationSettings | undefined {
	if (patch === null) {
		return undefined;
	}
	const next: BotTranslationSettings = current ? cloneTranslationSettings(current) : {};
	if (patch.enabled !== undefined) {
		next.enabled = Boolean(patch.enabled);
	}
	assignTranslationString(next, "model", patch.model);
	assignTranslationString(next, "prompt", patch.prompt);
	if (next.enabled === undefined && hasInferenceText(next.model)) {
		next.enabled = true;
	}
	assignInferenceReasoningEffort(next, "reasoningEffort", patch.reasoningEffort);
	assignStructuredToolCalls(next, "toolCalls", patch.toolCalls);
	assignTranslationJsonObject(next, "providerRouting", patch.providerRouting);
	assignTranslationNumber(next, "temperature", patch.temperature);
	assignTranslationNumber(next, "topK", patch.topK);
	assignTranslationNumber(next, "topP", patch.topP);
	assignTranslationNumber(next, "minP", patch.minP);
	assignTranslationNumber(next, "frequencyPenalty", patch.frequencyPenalty);
	assignTranslationNumber(next, "presencePenalty", patch.presencePenalty);
	assignTranslationNumber(next, "repetitionPenalty", patch.repetitionPenalty);
	if ((next.enabled || hasInferenceText(next.model)) && !hasInferenceText(next.prompt)) {
		next.prompt = defaultTranslationPrompt;
	}
	return translationSettingsHasValues(next) ? next : undefined;
}

function assignTranslationString(
	settings: BotTranslationSettings,
	key: "model" | "prompt",
	value: string | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	const trimmed = value.trim();
	if (trimmed) {
		settings[key] = trimmed;
	} else {
		delete settings[key];
	}
}

function assignTranslationJsonObject(
	settings: BotTranslationSettings,
	key: "providerRouting",
	value: JsonObject | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = cloneJsonObject(value);
}

type TranslationNumberSettingKey = Exclude<InferenceNumberSettingKey, never>;

function assignTranslationNumber(
	settings: BotTranslationSettings,
	key: TranslationNumberSettingKey,
	value: number | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = value;
}

function translationSettingsHasValues(settings: BotTranslationSettings): boolean {
	return (
		settings.enabled !== undefined ||
		hasInferenceText(settings.model) ||
		hasInferenceText(settings.prompt) ||
		settings.reasoningEffort !== undefined ||
		settings.toolCalls !== undefined ||
		settings.providerRouting !== undefined ||
		settings.temperature !== undefined ||
		settings.topK !== undefined ||
		settings.topP !== undefined ||
		settings.minP !== undefined ||
		settings.frequencyPenalty !== undefined ||
		settings.presencePenalty !== undefined ||
		settings.repetitionPenalty !== undefined
	);
}

function hasInferenceText(value: string | undefined): boolean {
	return Boolean(value?.trim());
}
