import { makeId, randomToken, sha256Hex } from "./ids";
import { objectIndexScopeStaleStatement } from "./object-index-scope";
import { entityIndexVersions } from "./index-versions";
import { tombstoneHandle } from "./handles";
import {
	schemaVersion,
	authProviders,
	avatarCropFromJson,
	avatarCropJson,
	defaultTranslationPrompt,
	localizedText,
	localizedTextFromStored,
	localizedTextString,
	type AvatarImage,
	type AuthProvider,
	type BotCloneSource,
	type BotCloneSourceSummary,
	type BotImageGenerationSettings,
	type BotImageGenerationSettingsInput,
	type BotInferenceSettingsInput,
	type BotInferenceSettings,
	type BotInferenceReasoningEffort,
	type BotDocument,
	type AddBotGroupMembersInput,
	type BotEffectivePostingSettings,
	type BotEffectiveTickSettings,
	type BotGroupSummary,
	type BotLocalOverrides,
	type BotPublicProfile,
	type BotSummary,
	type BotTickSpreadResult,
	type BotTranslationSettings,
	type BotTranslationSettingsInput,
	type BotToolSettings,
	type BotToolSettingsInput,
	type BotTickSettings,
	type BotTickSettingsInput,
	type CreateBotGroupInput,
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
	type LanguageTag,
	type LocalizedText,
	type LinkedAuthIdentity,
	type PostingSettings,
	type PostingSettingsInput,
	type ThreadSettings,
	type ThreadSettingsInput,
	type PublicUser,
	type SessionDocument,
	type UpdateBotGroupInput,
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
import {
	effectiveThreadSettings,
	mergeThreadSettings,
	threadSettingsHasValues,
} from "./thread-policy";
import { personalForumDescription } from "./personal-forums";
import { escapeLike, upsertBotSearchIndex, upsertForumSearchIndex, upsertWorldSearchIndex } from "./search";
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
import { planBotTickSpread, type TickSpreadInput } from "./tick-spread";
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
	language: string | null;
	uiLocale: string | null;
	avatarCrop: string | null;
	avatarUrl: string | null;
	profileCompletedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

type WorldSummaryIndexRow = Omit<WorldSummary, "avatar" | "avatarCrop" | "avatarUrl" | "imageGeneration" | "postingSettings" | "threadSettings" | "name" | "description" | "prompt" | "initialBotNotification"> & {
	language: string | null;
	name: string;
	description: string;
	prompt: string;
	initialBotNotification: string;
	avatarCrop: string | null;
	avatarUrl: string | null;
	imageGenerationJson: string | null;
	nameLang: string | null;
	descriptionLang: string | null;
	promptLang: string | null;
	initialBotNotificationLang: string | null;
	postingThreadBodyCharacters: number | null;
	postingCommentBodyCharacters: number | null;
	threadCommentLimit: number | null;
};

type ForumSummaryIndexRow = Omit<ForumSummary, "description" | "threadSettings"> & {
	language: string | null;
	description: string;
	descriptionLang: string | null;
	threadCommentLimit: number | null;
};
type ExistingHandleRow = { handle: string };

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

function languageFromStored(value: string | null | undefined): LanguageTag | null {
	return value?.trim() ? value as LanguageTag : null;
}

function uiLocaleFromStored(value: string | null | undefined): UserDocument["uiLocale"] {
	return value?.trim() ? value as UserDocument["uiLocale"] : undefined;
}

function localizedTextFromParts(text: string | null | undefined, lang: string | null | undefined): LocalizedText {
	return localizedText(text ?? "", languageFromStored(lang));
}

function localizedTextSql(value: LocalizedText): string {
	return value.text;
}

function localizedTextLangSql(value: LocalizedText): string | null {
	return value.lang;
}

function booleanSql(value: boolean | null | undefined): number {
	return value ? 1 : 0;
}

function booleanFromStored(value: number | boolean | null | undefined): boolean {
	return value === true || value === 1;
}

export type SessionCreateResult = {
	cookieValue: string;
	session: SessionDocument;
};

export type CliAuthRequestDocument = {
	id: string;
	type: "cliAuthRequest";
	label: string;
	userId?: string;
	approvedAt?: string;
	consumedAt?: string;
	createdAt: string;
	expiresAt: string;
	updatedAt: string;
};

export type CliAuthStartResult = {
	deviceCode: string;
	request: CliAuthRequestDocument;
};

export type CliAuthPollResult =
	| { status: "pending"; expiresAt: string }
	| { status: "expired"; expiresAt: string }
	| { status: "complete"; token: string; expiresAt: string };

export type CliTokenDocument = {
	id: string;
	type: "cliToken";
	userId: string;
	label: string;
	createdAt: string;
	expiresAt: string;
	updatedAt: string;
};

const sessionTtlSeconds = 60 * 60 * 24 * 30;
const cliAuthRequestTtlSeconds = 10 * 60;
const cliTokenTtlSeconds = 60 * 60 * 24 * 90;
export const defaultInitialBotNotification =
	"You have just finished creating your Bickr account and logged in for the first time.";
export const introForumHandle = "intro";
const introForumDescription = "Introductions, first threads, and orientation for new participants in this world.";
const defaultTickSettings: BotEffectiveTickSettings = {
	enabled: false,
	intervalSeconds: 86_400,
	allowEarlyLogOff: true,
	contextWindowTokens: 30_000,
	compactionThreshold: 0.75,
	compactionSummaryPercent: 10,
	compactionMaxCharacters: 4_000,
	maxToolCallsPerTick: 10,
	maxSuccessfulToolCallsPerIteration: 8,
	maxGeneratedTokensPerTick: 15_000,
	maxGeneratedTokensPerIteration: 30_000,
};
const defaultInferenceSettings: BotInferenceSettings = {};
const defaultToolSettings: BotToolSettings = {};

function defaultInitialBotNotificationText(lang: LanguageTag | null): LocalizedText {
	return localizedText(defaultInitialBotNotification, lang);
}

function introForumDescriptionText(lang: LanguageTag | null): LocalizedText {
	return localizedText(introForumDescription, lang);
}

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
		language: null,
		displayName: localizedText(displayName, null),
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.user(userId), user);
	await upsertUserIndexProjection(db, user);
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
	await putObjectIndex(db, user, "user", entityIndexVersions.user);

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

export async function createCliAuthRequest(
	kv: KVNamespaceLike,
	input: { label?: string } = {},
	now = new Date(),
): Promise<CliAuthStartResult> {
	const deviceCode = randomToken(24);
	const requestHash = await sha256Hex(deviceCode);
	const createdAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + cliAuthRequestTtlSeconds * 1000).toISOString();
	const request: CliAuthRequestDocument = {
		id: `car_${requestHash.slice(0, 32)}`,
		type: "cliAuthRequest",
		label: normalizedCliLabel(input.label),
		createdAt,
		expiresAt,
		updatedAt: createdAt,
	};
	await writeJson(kv, kvKeys.cliAuthRequest(requestHash), request, { expirationTtl: cliAuthRequestTtlSeconds });
	return { deviceCode, request };
}

export async function readCliAuthRequest(
	kv: KVNamespaceLike,
	deviceCode: string,
	now = new Date(),
): Promise<CliAuthRequestDocument | null> {
	const request = await readJson<CliAuthRequestDocument>(kv, kvKeys.cliAuthRequest(await sha256Hex(deviceCode)));
	if (!request || Date.parse(request.expiresAt) <= now.getTime()) {
		return null;
	}
	return request;
}

export async function approveCliAuthRequest(
	kv: KVNamespaceLike,
	deviceCode: string,
	userId: string,
	now = new Date(),
): Promise<CliAuthRequestDocument> {
	const requestHash = await sha256Hex(deviceCode);
	const request = await readJson<CliAuthRequestDocument>(kv, kvKeys.cliAuthRequest(requestHash));
	if (!request || Date.parse(request.expiresAt) <= now.getTime()) {
		throw new RepositoryError("not_found", "CLI login request expired or was not found.", 404);
	}
	if (request.consumedAt) {
		throw new RepositoryError("conflict", "CLI login request has already been completed.", 409);
	}
	const updatedAt = now.toISOString();
	const updated: CliAuthRequestDocument = {
		...request,
		userId,
		approvedAt: request.approvedAt ?? updatedAt,
		updatedAt,
	};
	await writeJson(kv, kvKeys.cliAuthRequest(requestHash), updated, {
		expirationTtl: Math.max(1, Math.ceil((Date.parse(updated.expiresAt) - now.getTime()) / 1000)),
	});
	return updated;
}

export async function pollCliAuthRequest(
	kv: KVNamespaceLike,
	deviceCode: string,
	now = new Date(),
): Promise<CliAuthPollResult> {
	const requestHash = await sha256Hex(deviceCode);
	const request = await readJson<CliAuthRequestDocument>(kv, kvKeys.cliAuthRequest(requestHash));
	if (!request) {
		return { status: "expired", expiresAt: now.toISOString() };
	}
	if (Date.parse(request.expiresAt) <= now.getTime()) {
		return { status: "expired", expiresAt: request.expiresAt };
	}
	if (!request.userId || !request.approvedAt) {
		return { status: "pending", expiresAt: request.expiresAt };
	}
	if (request.consumedAt) {
		return { status: "expired", expiresAt: request.expiresAt };
	}
	const token = `bckr_cli_${randomToken(32)}`;
	const tokenHash = await sha256Hex(token);
	const createdAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + cliTokenTtlSeconds * 1000).toISOString();
	const tokenDocument: CliTokenDocument = {
		id: `cli_${tokenHash.slice(0, 32)}`,
		type: "cliToken",
		userId: request.userId,
		label: request.label,
		createdAt,
		expiresAt,
		updatedAt: createdAt,
	};
	await writeJson(kv, kvKeys.cliToken(tokenHash), tokenDocument, { expirationTtl: cliTokenTtlSeconds });
	await writeJson(kv, kvKeys.cliAuthRequest(requestHash), {
		...request,
		consumedAt: createdAt,
		updatedAt: createdAt,
	} satisfies CliAuthRequestDocument, {
		expirationTtl: Math.max(1, Math.ceil((Date.parse(request.expiresAt) - now.getTime()) / 1000)),
	});
	return { status: "complete", token, expiresAt };
}

export async function userForCliToken(
	kv: KVNamespaceLike,
	token: string | null | undefined,
	now = new Date(),
): Promise<UserDocument | null> {
	if (!token) {
		return null;
	}
	const tokenHash = await sha256Hex(token);
	const document = await readJson<CliTokenDocument>(kv, kvKeys.cliToken(tokenHash));
	if (!document || Date.parse(document.expiresAt) <= now.getTime()) {
		return null;
	}
	const user = await readJson<UserDocument>(kv, kvKeys.user(document.userId));
	return user && !user.deletedAt ? user : null;
}

export async function deleteCliToken(kv: KVNamespaceLike, token: string | null | undefined): Promise<void> {
	if (!token) {
		return;
	}
	await deleteKey(kv, kvKeys.cliToken(await sha256Hex(token)));
}

function normalizedCliLabel(value: string | null | undefined): string {
	const label = value?.trim();
	return label ? label.slice(0, 120) : "Bickr CLI";
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
		language: user.language,
		...(user.uiLocale ? { uiLocale: user.uiLocale } : {}),
		displayName: user.displayName,
		...(user.avatar ? { avatar: user.avatar, avatarUrl: user.avatar.url } : {}),
		...(user.avatar?.crop ? { avatarCrop: user.avatar.crop } : {}),
		profileComplete: Boolean(user.profileCompletedAt),
		...(user.profileCompletedAt ? { profileCompletedAt: user.profileCompletedAt } : {}),
	};
}

function publicUserFromIndexRow(row: PublicUserIndexRow): PublicUser {
	const language = languageFromStored(row.language);
	const avatarCrop = avatarCropFromJson(row.avatarCrop);
	return {
		id: row.id,
		handle: row.handle,
		language,
		...(uiLocaleFromStored(row.uiLocale) ? { uiLocale: uiLocaleFromStored(row.uiLocale) } : {}),
		displayName: localizedTextFromParts(row.displayName, language),
		...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
		...(avatarCrop ? { avatarCrop } : {}),
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

async function publicUserByHandle(db: D1DatabaseLike, handle: string): Promise<PublicUser> {
	const row = await db
		.prepare(
			`SELECT
				user_id AS id,
				handle,
				display_name AS displayName,
				language,
				ui_locale AS uiLocale,
				avatar_url AS avatarUrl,
				avatar_crop AS avatarCrop,
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

async function publicUserById(db: D1DatabaseLike, userId: string): Promise<PublicUser> {
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
					language,
					ui_locale AS uiLocale,
					avatar_url AS avatarUrl,
					avatar_crop AS avatarCrop,
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
		language: bot.language,
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
		...(input.language !== undefined ? { language: input.language } : {}),
		...(input.uiLocale !== undefined ? { uiLocale: input.uiLocale } : {}),
		...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
		inferenceSettings,
		profileCompletedAt: current.profileCompletedAt ?? now,
		revision: current.revision + 1,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.user(updated.id), updated);
	await db
		.prepare(
			`UPDATE users_index
			 SET handle = ?, display_name = ?, display_name_lang = ?, language = ?, ui_locale = ?,
			     avatar_url = ?, avatar_crop = ?, profile_completed_at = ?, updated_at = ?
			 WHERE user_id = ?`,
		)
		.bind(
			updated.handle,
			localizedTextSql(updated.displayName),
			localizedTextLangSql(updated.displayName),
			updated.language,
			updated.uiLocale ?? null,
			updated.avatar?.url ?? null,
			avatarCropJson(updated.avatar?.crop),
			updated.profileCompletedAt ?? null,
			now,
			updated.id,
		)
		.run();
	await putObjectIndex(db, updated, "user", entityIndexVersions.user);

	return userProfile(updated, await listUserAuthIdentities(db, updated.id));
}

export async function updateUserAvatar(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
	avatar: AvatarImage | undefined,
	now = new Date().toISOString(),
): Promise<UserProfile> {
	const current = await userById(kv, userId);
	const { avatar: _avatar, ...withoutAvatar } = current;
	const updated: UserDocument = {
		...withoutAvatar,
		...(avatar ? { avatar } : {}),
		revision: current.revision + 1,
		updatedAt: now,
	};
	await writeJson(kv, kvKeys.user(updated.id), updated);
	await db
		.prepare(
			`UPDATE users_index
			 SET avatar_url = ?, avatar_crop = ?, updated_at = ?
			 WHERE user_id = ? AND deleted_at IS NULL`,
		)
		.bind(updated.avatar?.url ?? null, avatarCropJson(updated.avatar?.crop), now, updated.id)
		.run();
	await putObjectIndex(db, updated, "user", entityIndexVersions.user);
	return userProfile(updated, await listUserAuthIdentities(db, updated.id));
}

export async function listWorlds(db: D1DatabaseLike): Promise<WorldListSummary[]> {
	const result = await db
		.prepare(
			`SELECT
				w.world_id AS id,
				w.handle,
				w.language,
				w.name,
				w.name_lang AS nameLang,
				w.description,
				w.description_lang AS descriptionLang,
				w.prompt,
				w.prompt_lang AS promptLang,
				w.avatar_url AS avatarUrl,
				w.avatar_crop AS avatarCrop,
				w.image_generation AS imageGenerationJson,
				w.initial_bot_notification AS initialBotNotification,
				w.initial_bot_notification_lang AS initialBotNotificationLang,
				w.posting_thread_body_characters AS postingThreadBodyCharacters,
				w.posting_comment_body_characters AS postingCommentBodyCharacters,
				w.thread_comment_limit AS threadCommentLimit,
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
	const threadSettings = mergeThreadSettings(undefined, input.threadSettings);
	const world: WorldDocument = {
		id: makeId("wld"),
		type: "world",
		schemaVersion,
		revision: 1,
		handle: input.handle,
		language: input.language,
		name: input.name,
		description: input.description,
		prompt: input.prompt ?? localizedText("", input.language),
		...(input.imageGeneration ? { imageGeneration: mergeImageGenerationSettings(undefined, input.imageGeneration) } : {}),
		initialBotNotification: input.initialBotNotification ?? defaultInitialBotNotificationText(input.language),
		...(postingSettingsHasValues(postingSettings) ? { postingSettings } : {}),
		...(threadSettingsHasValues(threadSettings) ? { threadSettings } : {}),
		createdByUserId: userId,
		visibility: "public",
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.world(world.id), world);
	await upsertWorldIndexProjection(db, world);
	await putObjectIndex(db, world, "world", entityIndexVersions.world, world.id);
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
				f.language,
				f.description,
				f.description_lang AS descriptionLang,
				f.created_by_user_id AS createdByUserId,
				f.personal_bot_id AS personalBotId,
				f.thread_comment_limit AS threadCommentLimit,
				f.created_at AS createdAt,
				f.updated_at AS updatedAt
			 FROM forums_index f
			 WHERE f.world_id = ? AND f.deleted_at IS NULL
			 ORDER BY f.handle ASC`,
		)
		.bind(world.id)
		.all<ForumSummaryIndexRow>();

	return (result.results ?? []).map(forumSummaryFromIndexRow);
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
	assertThreadSettingsInputWithinLimit(
		input.threadSettings,
		effectiveThreadSettings(world.threadSettings, undefined).commentLimit,
	);

	const threadSettings = mergeThreadSettings(undefined, input.threadSettings);
	const forum: ForumDocument = {
		id: makeId("frm"),
		type: "forum",
		schemaVersion,
		revision: 1,
		worldId: world.id,
		worldHandle: world.handle,
		handle: input.handle,
		language: input.language,
		description: input.description,
		...(threadSettingsHasValues(threadSettings) ? { threadSettings } : {}),
		createdByUserId: userId,
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.forum(forum.id), forum);
	await upsertForumIndexProjection(db, forum);
	await putObjectIndex(db, forum, "forum", entityIndexVersions.forum, forum.worldId);

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

type UserBotRuntimeSpreadRow = {
	botId: string;
	handle: string;
	enabled: number;
	status: string;
	tickIntervalSeconds: number;
	nextDueAt: string | null;
};

export async function spreadUserBotTicks(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
	now = new Date().toISOString(),
): Promise<BotTickSpreadResult> {
	const result = await db
		.prepare(
			`SELECT
				runtime.bot_id AS botId,
				bots.handle AS handle,
				runtime.enabled AS enabled,
				runtime.status AS status,
				runtime.tick_interval_seconds AS tickIntervalSeconds,
				runtime.next_due_at AS nextDueAt
			 FROM bot_runtime_index runtime
			 JOIN bots_index bots ON bots.bot_id = runtime.bot_id
			 WHERE runtime.owner_user_id = ?
			   AND bots.owner_user_id = ?
			   AND bots.deleted_at IS NULL`,
		)
		.bind(userId, userId)
		.all<UserBotRuntimeSpreadRow>();
	const rows = result.results ?? [];
	const schedulableRows = rows.filter((row) => row.enabled === 1 && row.status !== "running");
	const plan = planBotTickSpread(
		schedulableRows.map((row): TickSpreadInput => ({
			botId: row.botId,
			handle: row.handle,
			intervalSeconds: row.tickIntervalSeconds,
			nextDueAt: row.nextDueAt,
		})),
		new Date(now),
	);
	if (plan.scheduled.length > 0) {
		const update = db.prepare(
			`UPDATE bot_runtime_index
			 SET next_due_at = ?, updated_at = ?
			 WHERE bot_id = ?
			   AND owner_user_id = ?
			   AND enabled = 1
			   AND status != 'running'`,
		);
		await db.batch(
			plan.scheduled.map((schedule) =>
				update.bind(schedule.nextDueAt, now, schedule.botId, userId),
			),
		);
	}

	return {
		bots: await listUserBots(kv, db, userId),
		scheduled: plan.scheduled,
		skipped: {
			paused: rows.filter((row) => row.enabled !== 1).length,
			running: rows.filter((row) => row.enabled === 1 && row.status === "running").length,
		},
		...(plan.anchorBotId ? { anchorBotId: plan.anchorBotId } : {}),
		...(plan.exactHyperperiodSeconds !== undefined ? { exactHyperperiodSeconds: plan.exactHyperperiodSeconds } : {}),
		usedApproximateHorizon: plan.usedApproximateHorizon,
	};
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
	const includeLanguageInSystemPrompt =
		cloneSource ? input.includeLanguageInSystemPrompt ?? null
		:	input.includeLanguageInSystemPrompt === null ? false : input.includeLanguageInSystemPrompt ?? true;

	let bot: BotDocument = {
		id: makeId("bot"),
		type: "bot",
		schemaVersion,
		revision: 1,
		homeWorldId: world.id,
		homeWorldHandle: world.handle,
		ownerUserId: userId,
		handle: input.handle,
		language: input.language,
		includeLanguageInSystemPrompt,
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
	await upsertBotSearchIndex(db, effectiveBot);
	await putObjectIndex(db, bot, "bot", entityIndexVersions.bot, bot.homeWorldId);

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
	const inferenceSettings = mergeInferenceSettings(bot.inferenceSettings, input.inferenceSettings);
	enforceInferenceModelAccess(inferenceSettings, owner.inferenceSettings);
	const toolSettings = mergeToolSettings(bot.toolSettings, input.toolSettings);
	const inheritedPostingSettings = effectivePostingSettings(worldPostingSettings, undefined);
	assertPostingSettingsInputWithinLimits(input.postingSettings, inheritedPostingSettings);
	const postingSettings = mergePostingSettings(bot.postingSettings, input.postingSettings);
	const includeLanguageInSystemPrompt =
		input.includeLanguageInSystemPrompt === undefined ?
			bot.includeLanguageInSystemPrompt ?? (canInheritProfile ? null : false)
		:	input.includeLanguageInSystemPrompt === null && !canInheritProfile ? false : input.includeLanguageInSystemPrompt;
	const updated: BotDocument = {
		...bot,
		...input,
		handle: nextHandle,
		includeLanguageInSystemPrompt,
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
	const effectiveUpdated = canInheritProfile ? await effectiveBotDocument(kv, db, updated) : updated;
	const personalForumUpdate = await personalForumUpdateForBotProfile(kv, db, bot, effectiveUpdated, now);

	if (personalForumUpdate) {
		await db.batch([
			botIndexUpdateStatement(db, effectiveUpdated),
			db
				.prepare(
					`UPDATE forums_index
					 SET handle = ?, language = ?, description = ?, description_lang = ?, updated_at = ?
					 WHERE forum_id = ? AND deleted_at IS NULL`,
				)
				.bind(
					personalForumUpdate.updated.handle,
					personalForumUpdate.updated.language,
					localizedTextSql(personalForumUpdate.updated.description),
					localizedTextLangSql(personalForumUpdate.updated.description),
					now,
					personalForumUpdate.updated.id,
				),
			db
				.prepare(`UPDATE threads_index SET forum_handle = ? WHERE forum_id = ? AND deleted_at IS NULL`)
				.bind(personalForumUpdate.updated.handle, personalForumUpdate.updated.id),
			objectIndexScopeStaleStatement(db, {
				kind: "forum",
				forumId: personalForumUpdate.updated.id,
			}),
		]);
		await writeJson(kv, kvKeys.bot(updated.id), updated);
	} else {
		await writeJson(kv, kvKeys.bot(updated.id), updated);
		await upsertBotIndex(db, effectiveUpdated);
	}
	await upsertBotRuntimeIndex(db, updated, now, shouldRescheduleBotRuntime(bot.tickSettings, updated.tickSettings, input.tickSettings));
	await upsertBotSearchIndex(db, effectiveUpdated);
	await putObjectIndex(db, updated, "bot", entityIndexVersions.bot, updated.homeWorldId);

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
	await upsertBotSearchIndex(db, effectiveUpdated);
	await putObjectIndex(db, updated, "bot", entityIndexVersions.bot, updated.homeWorldId);

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
	await upsertBotSearchIndex(db, effectiveUpdated);
	await putObjectIndex(db, updated, "bot", entityIndexVersions.bot, updated.homeWorldId);

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
	const tombstonedHandle = tombstoneHandle(bot.id);
	const deleted: BotDocument = {
		...bot,
		handle: tombstonedHandle,
		handleAtDeletion: bot.handleAtDeletion ?? bot.handle,
		revision: bot.revision + 1,
		updatedAt: now,
		deletedAt: now,
	};

	await writeJson(kv, kvKeys.bot(deleted.id), deleted);
	await upsertBotIndex(db, deleted);
	await deleteBotGroupMembershipsForBot(db, deleted.id);
	await disableBotRuntime(db, deleted.id, now);
	await upsertBotSearchIndex(db, deleted);
	await putObjectIndex(db, deleted, "bot", entityIndexVersions.bot, deleted.homeWorldId);

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
		language: bot.language ?? effectiveBefore.language,
		includeLanguageInSystemPrompt: bot.includeLanguageInSystemPrompt ?? effectiveBefore.includeLanguageInSystemPrompt,
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
	await upsertBotSearchIndex(db, effectiveUpdated);
	await putObjectIndex(db, updated, "bot", entityIndexVersions.bot, updated.homeWorldId);

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
	const localIncludeLanguageInSystemPrompt = bot.includeLanguageInSystemPrompt ?? false;
	const next: BotDocument = {
		...bot,
		language: bot.language === sourceEffective.language ? null : bot.language,
		includeLanguageInSystemPrompt:
			localIncludeLanguageInSystemPrompt === sourceEffective.includeLanguageInSystemPrompt ?
				null
			:	localIncludeLanguageInSystemPrompt,
		displayName: localizedTextEqual(bot.displayName, sourceEffective.displayName) ? emptyLocalizedText(bot.language) : bot.displayName,
		shortBio: localizedTextEqual(bot.shortBio, sourceEffective.shortBio) ? emptyLocalizedText(bot.language) : bot.shortBio,
		prompt: localizedTextEqual(bot.prompt, sourceEffective.prompt) ? emptyLocalizedText(bot.language) : bot.prompt,
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
	await upsertBotSearchIndex(db, effectiveUpdated);
	await putObjectIndex(db, next, "bot", entityIndexVersions.bot, next.homeWorldId);

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
			const targetIncludeLanguageInSystemPrompt = targetRaw.includeLanguageInSystemPrompt ?? false;
			let updated: BotDocument = {
				...targetRaw,
				language: targetRaw.language === sourceEffective.language ? null : targetRaw.language,
				includeLanguageInSystemPrompt:
					targetIncludeLanguageInSystemPrompt === sourceEffective.includeLanguageInSystemPrompt ?
						null
					:	targetIncludeLanguageInSystemPrompt,
				displayName: localizedTextEqual(targetRaw.displayName, sourceEffective.displayName) ? emptyLocalizedText(targetRaw.language) : targetRaw.displayName,
				shortBio: localizedTextEqual(targetRaw.shortBio, sourceEffective.shortBio) ? emptyLocalizedText(targetRaw.language) : targetRaw.shortBio,
				prompt: localizedTextEqual(targetRaw.prompt, sourceEffective.prompt) ? emptyLocalizedText(targetRaw.language) : targetRaw.prompt,
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
			await upsertBotSearchIndex(db, effective);
			await putObjectIndex(db, updated, "bot", entityIndexVersions.bot, updated.homeWorldId);
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

type BotGroupRow = {
	id: string;
	worldId: string;
	ownerUserId: string;
	language: string | null;
	customTitle: string | null;
	customTitleLang: string | null;
	createdAt: string;
	updatedAt: string;
};

type BotGroupMemberRow = {
	groupId: string;
	botId: string;
};

export async function listBotGroups(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	userId: string,
): Promise<BotGroupSummary[]> {
	const world = await worldByHandle(db, worldHandle);
	return botGroupSummariesForOwner(kv, db, world.id, userId);
}

export async function createBotGroup(
	_kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	userId: string,
	input: CreateBotGroupInput,
	now = new Date().toISOString(),
): Promise<BotGroupSummary> {
	const world = await worldByHandle(db, worldHandle);
	const group: BotGroupRow = {
		id: makeId("grp"),
		worldId: world.id,
		ownerUserId: userId,
		language: input.language,
		customTitle: input.customTitle?.text ?? null,
		customTitleLang: input.customTitle?.lang ?? null,
		createdAt: now,
		updatedAt: now,
	};
	await db
		.prepare(
			`INSERT INTO bot_groups (
				group_id, world_id, owner_user_id, language, custom_title, custom_title_lang, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		)
		.bind(group.id, group.worldId, group.ownerUserId, group.language, group.customTitle, group.customTitleLang, group.createdAt, group.updatedAt)
		.run();
	return botGroupSummary(group, []);
}

export async function updateBotGroup(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	userId: string,
	groupId: string,
	input: UpdateBotGroupInput,
	now = new Date().toISOString(),
): Promise<BotGroupSummary> {
	const { world } = await botGroupForOwner(db, worldHandle, userId, groupId);
	await db
		.prepare(
			`UPDATE bot_groups
			 SET language = ?, custom_title = ?, custom_title_lang = ?, updated_at = ?
			 WHERE group_id = ? AND world_id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.language, input.customTitle?.text ?? null, input.customTitle?.lang ?? null, now, groupId, world.id, userId)
		.run();
	return botGroupSummaryForOwner(kv, db, world.id, userId, groupId);
}

export async function deleteBotGroup(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	userId: string,
	groupId: string,
	now = new Date().toISOString(),
): Promise<BotGroupSummary> {
	const { world } = await botGroupForOwner(db, worldHandle, userId, groupId);
	const group = await botGroupSummaryForOwner(kv, db, world.id, userId, groupId);
	await db.batch([
		db
			.prepare(
				`UPDATE bot_groups
				 SET updated_at = ?, deleted_at = ?
				 WHERE group_id = ? AND world_id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
			)
			.bind(now, now, groupId, world.id, userId),
		db.prepare(`DELETE FROM bot_group_members WHERE group_id = ? AND world_id = ?`).bind(groupId, world.id),
	]);
	return group;
}

export async function addBotGroupMembers(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	userId: string,
	groupId: string,
	input: AddBotGroupMembersInput,
	now = new Date().toISOString(),
): Promise<BotGroupSummary> {
	const { world } = await botGroupForOwner(db, worldHandle, userId, groupId);
	const placeholders = input.botIds.map(() => "?").join(", ");
	const activeRows = await db
		.prepare(
			`SELECT bot_id AS id
			 FROM bots_index
			 WHERE home_world_id = ? AND deleted_at IS NULL AND bot_id IN (${placeholders})`,
		)
		.bind(world.id, ...input.botIds)
		.all<{ id: string }>();
	const activeIds = new Set((activeRows.results ?? []).map((row) => row.id));
	if (activeIds.size !== input.botIds.length) {
		throw new RepositoryError("bad_request", "All selected bots must be active bots in this world.", 400);
	}
	await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO bot_group_members (group_id, bot_id, world_id, added_at)
				 SELECT ?, bot_id, ?, ?
				 FROM bots_index
				 WHERE home_world_id = ? AND deleted_at IS NULL AND bot_id IN (${placeholders})`,
			)
			.bind(groupId, world.id, now, world.id, ...input.botIds),
		db
			.prepare(
				`UPDATE bot_groups
				 SET updated_at = ?
				 WHERE group_id = ? AND world_id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
			)
			.bind(now, groupId, world.id, userId),
	]);
	return botGroupSummaryForOwner(kv, db, world.id, userId, groupId);
}

export async function removeBotGroupMember(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	userId: string,
	groupId: string,
	botId: string,
	now = new Date().toISOString(),
): Promise<BotGroupSummary> {
	const { world } = await botGroupForOwner(db, worldHandle, userId, groupId);
	await db.batch([
		db.prepare(`DELETE FROM bot_group_members WHERE group_id = ? AND bot_id = ? AND world_id = ?`).bind(groupId, botId, world.id),
		db
			.prepare(
				`UPDATE bot_groups
				 SET updated_at = ?
				 WHERE group_id = ? AND world_id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
			)
			.bind(now, groupId, world.id, userId),
	]);
	return botGroupSummaryForOwner(kv, db, world.id, userId, groupId);
}

export async function deleteBotGroupMembershipsForBot(db: D1DatabaseLike, botId: string): Promise<void> {
	await db.prepare(`DELETE FROM bot_group_members WHERE bot_id = ?`).bind(botId).run();
}

export async function softDeleteBotGroupsForWorld(
	db: D1DatabaseLike,
	worldId: string,
	now = new Date().toISOString(),
): Promise<void> {
	await db.batch([
		db
			.prepare(`UPDATE bot_groups SET updated_at = ?, deleted_at = ? WHERE world_id = ? AND deleted_at IS NULL`)
			.bind(now, now, worldId),
		db.prepare(`DELETE FROM bot_group_members WHERE world_id = ?`).bind(worldId),
	]);
}

async function softDeleteBotGroupsForOwner(
	db: D1DatabaseLike,
	userId: string,
	now = new Date().toISOString(),
): Promise<void> {
	const rows = await db
		.prepare(`SELECT group_id AS id, world_id AS worldId FROM bot_groups WHERE owner_user_id = ? AND deleted_at IS NULL`)
		.bind(userId)
		.all<{ id: string; worldId: string }>();
	const groups = rows.results ?? [];
	if (groups.length === 0) {
		return;
	}
	const placeholders = groups.map(() => "?").join(", ");
	await db.batch([
		db
			.prepare(`UPDATE bot_groups SET updated_at = ?, deleted_at = ? WHERE owner_user_id = ? AND deleted_at IS NULL`)
			.bind(now, now, userId),
		db.prepare(`DELETE FROM bot_group_members WHERE group_id IN (${placeholders})`).bind(...groups.map((group) => group.id)),
	]);
}

async function botGroupForOwner(
	db: D1DatabaseLike,
	worldHandle: string,
	userId: string,
	groupId: string,
): Promise<{ group: BotGroupRow; world: Pick<WorldSummary, "id" | "handle"> }> {
	const world = await worldByHandle(db, worldHandle);
	const group = await botGroupRowForOwner(db, world.id, userId, groupId);
	return { group, world };
}

async function botGroupSummaryForOwner(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldId: string,
	userId: string,
	groupId: string,
): Promise<BotGroupSummary> {
	const group = await botGroupRowForOwner(db, worldId, userId, groupId);
	const [summary] = await botGroupSummaries(kv, db, [group], await botGroupMemberRows(db, worldId, [groupId]));
	if (!summary) {
		throw new RepositoryError("not_found", "Group not found.", 404);
	}
	return summary;
}

async function botGroupRowForOwner(
	db: D1DatabaseLike,
	worldId: string,
	userId: string,
	groupId: string,
): Promise<BotGroupRow> {
	const group = await db
		.prepare(
			`SELECT
				group_id AS id,
				world_id AS worldId,
				owner_user_id AS ownerUserId,
				language,
				custom_title AS customTitle,
				custom_title_lang AS customTitleLang,
				created_at AS createdAt,
				updated_at AS updatedAt
			 FROM bot_groups
			 WHERE group_id = ? AND world_id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
		)
		.bind(groupId, worldId, userId)
		.first<BotGroupRow>();
	if (!group) {
		throw new RepositoryError("not_found", "Group not found.", 404);
	}
	return group;
}

async function botGroupSummariesForOwner(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldId: string,
	userId: string,
): Promise<BotGroupSummary[]> {
	const groupsResult = await db
		.prepare(
			`SELECT
				group_id AS id,
				world_id AS worldId,
				owner_user_id AS ownerUserId,
				language,
				custom_title AS customTitle,
				custom_title_lang AS customTitleLang,
				created_at AS createdAt,
				updated_at AS updatedAt
			 FROM bot_groups
			 WHERE world_id = ? AND owner_user_id = ? AND deleted_at IS NULL
			 ORDER BY created_at ASC, group_id ASC`,
		)
		.bind(worldId, userId)
		.all<BotGroupRow>();
	const groups = groupsResult.results ?? [];
	return botGroupSummaries(kv, db, groups, await botGroupMemberRows(db, worldId, groups.map((group) => group.id)));
}

async function botGroupMemberRows(
	db: D1DatabaseLike,
	worldId: string,
	groupIds: string[],
): Promise<BotGroupMemberRow[]> {
	if (groupIds.length === 0) {
		return [];
	}
	const placeholders = groupIds.map(() => "?").join(", ");
	const result = await db
		.prepare(
			`SELECT m.group_id AS groupId, m.bot_id AS botId
			 FROM bot_group_members m
			 JOIN bots_index b ON b.bot_id = m.bot_id AND b.home_world_id = m.world_id AND b.deleted_at IS NULL
			 WHERE m.world_id = ? AND m.group_id IN (${placeholders})
			 ORDER BY m.group_id ASC, lower(b.handle) ASC, b.handle ASC`,
		)
		.bind(worldId, ...groupIds)
		.all<BotGroupMemberRow>();
	return result.results ?? [];
}

async function botGroupSummaries(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	groups: BotGroupRow[],
	memberRows: BotGroupMemberRow[],
): Promise<BotGroupSummary[]> {
	if (groups.length === 0) {
		return [];
	}
	const botIds = [...new Set(memberRows.map((row) => row.botId))];
	const rawBots = (await Promise.all(botIds.map((botId) => readJson<BotDocument>(kv, kvKeys.bot(botId)))))
		.filter((bot): bot is BotDocument => Boolean(bot && !bot.deletedAt))
		.map((bot) => normalizeBotDefaults(bot));
	const effectiveBots = await effectiveBotDocuments(kv, db, rawBots);
	const worldPostingSettings = await worldPostingSettingsByIds(db, effectiveBots.map((bot) => bot.homeWorldId));
	const botSummaries = await attachBotOwners(db, effectiveBots.map((bot) =>
		botSummary(bot, {
			includePrompt: false,
			worldPostingSettings: worldPostingSettings.get(bot.homeWorldId),
		}),
	));
	const botsById = new Map(botSummaries.map((bot) => [bot.id, bot]));
	const groupBots = new Map<string, BotSummary[]>();
	for (const row of memberRows) {
		const bot = botsById.get(row.botId);
		if (!bot) {
			continue;
		}
		const bots = groupBots.get(row.groupId) ?? [];
		bots.push(bot);
		groupBots.set(row.groupId, bots);
	}
	return groups.map((group) => botGroupSummary(group, groupBots.get(group.id) ?? []));
}

function botGroupSummary(group: BotGroupRow, bots: BotSummary[]): BotGroupSummary {
	const language = languageFromStored(group.language);
	const customTitle = group.customTitle ? localizedTextFromParts(group.customTitle, group.customTitleLang ?? group.language) : null;
	const displayTitle = customTitle?.text ?? (bots.length > 0 ? bots.map((bot) => `u/${bot.handle}`).join(", ") : "Empty group");
	return {
		id: group.id,
		worldId: group.worldId,
		ownerUserId: group.ownerUserId,
		language,
		customTitle,
		displayTitle,
		titleSource: customTitle ? "custom" : "members",
		bots,
		createdAt: group.createdAt,
		updatedAt: group.updatedAt,
	};
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
				language,
				name,
				name_lang AS nameLang,
				description,
				description_lang AS descriptionLang,
				prompt,
				prompt_lang AS promptLang,
				avatar_url AS avatarUrl,
				avatar_crop AS avatarCrop,
				image_generation AS imageGenerationJson,
				initial_bot_notification AS initialBotNotification,
				initial_bot_notification_lang AS initialBotNotificationLang,
				posting_thread_body_characters AS postingThreadBodyCharacters,
				posting_comment_body_characters AS postingCommentBodyCharacters,
				thread_comment_limit AS threadCommentLimit,
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
				f.language,
				f.description,
				f.description_lang AS descriptionLang,
				f.created_by_user_id AS createdByUserId,
				f.personal_bot_id AS personalBotId,
				f.thread_comment_limit AS threadCommentLimit,
				f.created_at AS createdAt,
				f.updated_at AS updatedAt
			 FROM forums_index f
			 JOIN worlds_index w ON w.world_id = f.world_id AND w.deleted_at IS NULL
			 WHERE f.created_by_user_id = ?
			   AND f.deleted_at IS NULL
			   AND w.created_by_user_id != ?
			 ORDER BY lower(f.world_handle) ASC, lower(f.handle) ASC`,
		)
		.bind(userId, userId)
		.all<ForumSummaryIndexRow>();
	return (result.results ?? []).map(forumSummaryFromIndexRow);
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
	const tombstonedHandle = tombstoneHandle(current.id);
	const deleted: UserDocument = {
		...current,
		handle: tombstonedHandle,
		revision: current.revision + 1,
		updatedAt: now,
		deletedAt: now,
	};
	await writeJson(kv, kvKeys.user(deleted.id), deleted);
	await softDeleteBotGroupsForOwner(db, deleted.id, now);
	await db
		.prepare(
			`UPDATE users_index
			 SET handle = ?, updated_at = ?, deleted_at = ?
			 WHERE user_id = ? AND deleted_at IS NULL`,
		)
		.bind(tombstonedHandle, now, now, deleted.id)
		.run();
	await db.prepare(`DELETE FROM provider_identities WHERE user_id = ?`).bind(deleted.id).run();
	await putObjectIndex(db, deleted, "user", entityIndexVersions.user);
	return publicUser(deleted);
}

async function listOwnedForumsByWorld(
	db: D1DatabaseLike,
	userId: string,
): Promise<HumanOwnedForumGroup[]> {
	type ForumWithWorldRow = Omit<ForumSummary, "description" | "language" | "threadSettings"> & {
		language: string | null;
		description: string;
		descriptionLang: string | null;
		threadCommentLimit: number | null;
		groupWorldId: string;
		groupWorldHandle: string;
		groupWorldLanguage: string | null;
		groupWorldName: string;
		groupWorldNameLang: string | null;
		groupWorldDescription: string;
		groupWorldDescriptionLang: string | null;
		groupWorldPrompt: string;
		groupWorldPromptLang: string | null;
		groupWorldInitialBotNotification: string;
		groupWorldInitialBotNotificationLang: string | null;
		groupWorldPostingThreadBodyCharacters: number | null;
		groupWorldPostingCommentBodyCharacters: number | null;
		groupWorldThreadCommentLimit: number | null;
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
				f.language,
				f.description,
				f.description_lang AS descriptionLang,
				f.created_by_user_id AS createdByUserId,
				f.personal_bot_id AS personalBotId,
				f.thread_comment_limit AS threadCommentLimit,
				f.created_at AS createdAt,
				f.updated_at AS updatedAt,
				w.world_id AS groupWorldId,
				w.handle AS groupWorldHandle,
				w.language AS groupWorldLanguage,
				w.name AS groupWorldName,
				w.name_lang AS groupWorldNameLang,
				w.description AS groupWorldDescription,
				w.description_lang AS groupWorldDescriptionLang,
				w.prompt AS groupWorldPrompt,
				w.prompt_lang AS groupWorldPromptLang,
				w.initial_bot_notification AS groupWorldInitialBotNotification,
				w.initial_bot_notification_lang AS groupWorldInitialBotNotificationLang,
				w.posting_thread_body_characters AS groupWorldPostingThreadBodyCharacters,
				w.posting_comment_body_characters AS groupWorldPostingCommentBodyCharacters,
				w.thread_comment_limit AS groupWorldThreadCommentLimit,
				w.created_by_user_id AS groupWorldCreatedByUserId,
				w.created_at AS groupWorldCreatedAt,
				w.updated_at AS groupWorldUpdatedAt
			 FROM forums_index f
			 JOIN worlds_index w ON w.world_id = f.world_id AND w.deleted_at IS NULL
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
			const createdGroup: HumanOwnedForumGroup = {
				world: {
					id: row.groupWorldId,
					handle: row.groupWorldHandle,
					language: languageFromStored(row.groupWorldLanguage),
					name: localizedTextFromParts(row.groupWorldName, row.groupWorldNameLang ?? row.groupWorldLanguage),
					description: localizedTextFromParts(row.groupWorldDescription, row.groupWorldDescriptionLang ?? row.groupWorldLanguage),
					prompt: localizedTextFromParts(row.groupWorldPrompt, row.groupWorldPromptLang ?? row.groupWorldLanguage),
					initialBotNotification: localizedTextFromParts(
						row.groupWorldInitialBotNotification,
						row.groupWorldInitialBotNotificationLang ?? row.groupWorldLanguage,
					),
					...postingSettingsObject(
						row.groupWorldPostingThreadBodyCharacters,
						row.groupWorldPostingCommentBodyCharacters,
					),
					...threadSettingsObject(row.groupWorldThreadCommentLimit),
					createdByUserId: row.groupWorldCreatedByUserId,
					createdAt: row.groupWorldCreatedAt,
					updatedAt: row.groupWorldUpdatedAt,
				},
				forums: [],
			};
			groups.set(row.groupWorldId, createdGroup);
			group = createdGroup;
		}
		group.forums.push({
			id: row.id,
			worldId: row.worldId,
			worldHandle: row.worldHandle,
			handle: row.handle,
			language: languageFromStored(row.language),
			description: localizedTextFromParts(row.description, row.descriptionLang ?? row.language),
			createdByUserId: row.createdByUserId,
			...(row.personalBotId ? { personalBotId: row.personalBotId } : {}),
			...threadSettingsObject(row.threadCommentLimit),
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
					language,
					name,
					name_lang AS nameLang,
					description,
					description_lang AS descriptionLang,
					prompt,
					prompt_lang AS promptLang,
					avatar_url AS avatarUrl,
					avatar_crop AS avatarCrop,
					image_generation AS imageGenerationJson,
					initial_bot_notification AS initialBotNotification,
					initial_bot_notification_lang AS initialBotNotificationLang,
					posting_thread_body_characters AS postingThreadBodyCharacters,
					posting_comment_body_characters AS postingCommentBodyCharacters,
					thread_comment_limit AS threadCommentLimit,
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

export function assertThreadSettingsInputWithinLimit(
	input: ThreadSettingsInput | undefined,
	inheritedLimit: number,
): void {
	if (
		input?.commentLimit !== undefined &&
		input.commentLimit !== null &&
		input.commentLimit > inheritedLimit
	) {
		throw new RepositoryError(
			"bad_request",
			`Thread comment limit must be an integer between 1 and ${inheritedLimit}.`,
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
		worldLanguage: string | null;
		worldName: string;
		worldNameLang: string | null;
		worldDescription: string;
		worldDescriptionLang: string | null;
		worldPrompt: string;
		worldPromptLang: string | null;
		worldAvatarUrl: string | null;
		worldAvatarCrop: string | null;
		worldInitialBotNotification: string;
		worldInitialBotNotificationLang: string | null;
		worldPostingThreadBodyCharacters: number | null;
		worldPostingCommentBodyCharacters: number | null;
		worldCreatedByUserId: string;
		worldCreatedAt: string;
		worldUpdatedAt: string;
		botId: string;
		homeWorldId: string;
		homeWorldHandle: string;
		handle: string;
		language: string | null;
		displayName: string;
		displayNameLang: string | null;
		shortBio: string;
		shortBioLang: string | null;
		avatarUrl: string | null;
		createdAt: string;
		updatedAt: string;
		ownerUserId: string;
		ownerHandle: string | null;
		ownerDisplayName: string | null;
		ownerDisplayNameLang: string | null;
		ownerLanguage: string | null;
		ownerUiLocale: string | null;
		ownerAvatarUrl: string | null;
		ownerAvatarCrop: string | null;
		ownerProfileCompletedAt: string | null;
		avatarCrop: string | null;
	};
	const result = await db
		.prepare(
			`SELECT
				w.world_id AS worldId,
				w.handle AS worldHandle,
				w.language AS worldLanguage,
				w.name AS worldName,
				w.name_lang AS worldNameLang,
				w.description AS worldDescription,
				w.description_lang AS worldDescriptionLang,
				w.prompt AS worldPrompt,
				w.prompt_lang AS worldPromptLang,
				w.avatar_url AS worldAvatarUrl,
				w.avatar_crop AS worldAvatarCrop,
				w.initial_bot_notification AS worldInitialBotNotification,
				w.initial_bot_notification_lang AS worldInitialBotNotificationLang,
				w.posting_thread_body_characters AS worldPostingThreadBodyCharacters,
				w.posting_comment_body_characters AS worldPostingCommentBodyCharacters,
				w.created_by_user_id AS worldCreatedByUserId,
				w.created_at AS worldCreatedAt,
				w.updated_at AS worldUpdatedAt,
				b.bot_id AS botId,
				b.home_world_id AS homeWorldId,
				b.home_world_handle AS homeWorldHandle,
				b.handle,
				b.language,
				b.display_name AS displayName,
				b.display_name_lang AS displayNameLang,
				b.short_bio AS shortBio,
				b.short_bio_lang AS shortBioLang,
				b.avatar_url AS avatarUrl,
				b.avatar_crop AS avatarCrop,
				b.created_at AS createdAt,
				b.updated_at AS updatedAt,
				b.owner_user_id AS ownerUserId,
				u.handle AS ownerHandle,
				u.display_name AS ownerDisplayName,
				u.display_name_lang AS ownerDisplayNameLang,
				u.language AS ownerLanguage,
				u.ui_locale AS ownerUiLocale,
				u.avatar_url AS ownerAvatarUrl,
				u.avatar_crop AS ownerAvatarCrop,
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
					language: languageFromStored(row.worldLanguage),
					name: localizedTextFromParts(row.worldName, row.worldNameLang ?? row.worldLanguage),
					description: localizedTextFromParts(row.worldDescription, row.worldDescriptionLang ?? row.worldLanguage),
					prompt: localizedTextFromParts(row.worldPrompt, row.worldPromptLang ?? row.worldLanguage),
					...(row.worldAvatarUrl ? { avatarUrl: row.worldAvatarUrl } : {}),
					...(avatarCropFromJson(row.worldAvatarCrop) ? { avatarCrop: avatarCropFromJson(row.worldAvatarCrop) } : {}),
					initialBotNotification: localizedTextFromParts(row.worldInitialBotNotification, row.worldInitialBotNotificationLang ?? row.worldLanguage),
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
			language: languageFromStored(row.language),
			displayName: localizedTextFromParts(row.displayName, row.displayNameLang ?? row.language),
			shortBio: localizedTextFromParts(row.shortBio, row.shortBioLang ?? row.language),
			...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
			...(avatarCrop ? { avatarCrop } : {}),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			...(row.ownerHandle && row.ownerDisplayName ?
				{
					owner: {
						id: row.ownerUserId,
						handle: row.ownerHandle,
						language: languageFromStored(row.ownerLanguage),
						...(uiLocaleFromStored(row.ownerUiLocale) ? { uiLocale: uiLocaleFromStored(row.ownerUiLocale) } : {}),
						displayName: localizedTextFromParts(row.ownerDisplayName, row.ownerDisplayNameLang ?? row.ownerLanguage),
						...(row.ownerAvatarUrl ? { avatarUrl: row.ownerAvatarUrl } : {}),
						...(avatarCropFromJson(row.ownerAvatarCrop) ? { avatarCrop: avatarCropFromJson(row.ownerAvatarCrop) } : {}),
						profileComplete: Boolean(row.ownerProfileCompletedAt),
						...(row.ownerProfileCompletedAt ? { profileCompletedAt: row.ownerProfileCompletedAt } : {}),
					},
				}
			:	{}),
		});
	}
	return [...groups.values()];
}

export async function worldByHandle(
	db: D1DatabaseLike,
	worldHandle: string,
): Promise<{ id: string; handle: string; postingSettings?: PostingSettings; threadSettings?: ThreadSettings }> {
	const world = await db
		.prepare(
			`SELECT
				world_id AS id,
				handle,
				posting_thread_body_characters AS postingThreadBodyCharacters,
				posting_comment_body_characters AS postingCommentBodyCharacters,
				thread_comment_limit AS threadCommentLimit
			 FROM worlds_index
			 WHERE handle = ? AND deleted_at IS NULL`,
		)
		.bind(worldHandle)
		.first<{ id: string; handle: string; postingThreadBodyCharacters: number | null; postingCommentBodyCharacters: number | null; threadCommentLimit: number | null }>();
	if (!world) {
		throw new RepositoryError("not_found", "World not found.", 404);
	}

	return {
		id: world.id,
		handle: world.handle,
		...postingSettingsObject(world.postingThreadBodyCharacters, world.postingCommentBodyCharacters),
		...threadSettingsObject(world.threadCommentLimit),
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

type PersonalForumUpdate = {
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

async function personalForumUpdateForBotProfile(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	previousBot: BotDocument,
	updatedBot: BotDocument,
	now: string,
): Promise<PersonalForumUpdate | null> {
	const row = await db
		.prepare(
			`SELECT forum_id AS id, handle
			 FROM forums_index
			 WHERE personal_bot_id = ? AND deleted_at IS NULL`,
		)
		.bind(previousBot.id)
		.first<{ id: string; handle: string }>();
	if (!row) {
		return null;
	}
	const nextForumHandle = row.handle === previousBot.handle ? updatedBot.handle : row.handle;

	if (nextForumHandle !== row.handle) {
		const existing = await db
			.prepare(
				`SELECT forum_id AS id
				 FROM forums_index
				 WHERE world_id = ? AND handle = ? AND deleted_at IS NULL`,
			)
			.bind(previousBot.homeWorldId, nextForumHandle)
			.first<{ id: string }>();
		if (existing && existing.id !== row.id) {
			throw new RepositoryError("conflict", "A forum with that handle already exists in this world.", 409);
		}
	}

	const forum = await readJson<ForumDocument>(kv, kvKeys.forum(row.id));
	if (!forum || forum.deletedAt) {
		throw new RepositoryError("server_error", "Personal forum document is missing.", 500);
	}
	const current = normalizeForumDefaults(forum);
	const description = personalForumDescription(updatedBot);
	if (
		current.handle === nextForumHandle &&
		current.language === updatedBot.language &&
		localizedTextEqual(current.description, description)
	) {
		return null;
	}
	return {
		updated: {
			...current,
			handle: nextForumHandle,
			language: updatedBot.language,
			description,
			revision: forum.revision + 1,
			updatedAt: now,
		},
	};
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
	const cache = new Map<string, BotDocument>();
	return Promise.all(bots.map((bot) => effectiveBotDocument(kv, db, bot, { cache, visiting: new Set() })));
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
			includeLanguageInSystemPrompt: normalized.includeLanguageInSystemPrompt ?? false,
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
		const effectiveLanguage = normalized.language ?? sourceEffective.language;
		const effectiveIncludeLanguageInSystemPrompt =
			normalized.includeLanguageInSystemPrompt ?? sourceEffective.includeLanguageInSystemPrompt ?? false;
		const inheritedInference = hasInferenceText(normalized.inferenceSettings.model) ?
			normalized.inferenceSettings
		:	cloneInferenceSettings(sourceEffective.inferenceSettings);
		const resolved: BotDocument = {
			...normalized,
			language: effectiveLanguage,
			includeLanguageInSystemPrompt: effectiveIncludeLanguageInSystemPrompt,
			displayName: hasProfileText(normalized.displayName) ?
				localizedTextWithFallbackLang(normalized.displayName, effectiveLanguage)
			:	sourceEffective.displayName,
			shortBio: hasProfileText(normalized.shortBio) ?
				localizedTextWithFallbackLang(normalized.shortBio, effectiveLanguage)
			:	sourceEffective.shortBio,
			prompt: hasProfileText(normalized.prompt) ?
				localizedTextWithFallbackLang(normalized.prompt, effectiveLanguage)
			:	sourceEffective.prompt,
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
		language: bot.language,
		includeLanguageInSystemPrompt: bot.includeLanguageInSystemPrompt,
		displayName: bot.displayName,
		shortBio: bot.shortBio,
		...(bot.avatar ? { avatarUrl: bot.avatar.url } : {}),
		...(bot.avatar?.crop ? { avatarCrop: bot.avatar.crop } : {}),
	};
}

function botLocalOverrides(bot: BotDocument): BotLocalOverrides {
	return {
		language: bot.language,
		includeLanguageInSystemPrompt: bot.includeLanguageInSystemPrompt,
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

function emptyLocalizedText(lang: LanguageTag | null): LocalizedText {
	return localizedText("", lang);
}

function localizedTextWithFallbackLang(value: LocalizedText, fallbackLang: LanguageTag | null): LocalizedText {
	return value.lang ? value : localizedText(value.text, fallbackLang);
}

function localizedTextEqual(left: LocalizedText, right: LocalizedText): boolean {
	return left.text === right.text && left.lang === right.lang;
}

function hasProfileText(value: LocalizedText | string | undefined): boolean {
	return Boolean(localizedTextString(value).trim());
}

function assertMaterializedProfileFields(displayName: LocalizedText, shortBio: LocalizedText, prompt: LocalizedText): void {
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
			await upsertBotSearchIndex(db, effective);
			await putObjectIndex(db, raw, "bot", entityIndexVersions.bot, raw.homeWorldId);
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

export async function upsertUserIndexProjection(
	db: D1DatabaseLike,
	user: UserDocument,
): Promise<UserDocument> {
	const normalized = normalizeUserDefaults(user);
	await db
		.prepare(
			`INSERT INTO users_index (
				user_id, handle, display_name, display_name_lang, language, ui_locale,
				avatar_url, avatar_crop, profile_completed_at, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				handle = excluded.handle,
				display_name = excluded.display_name,
				display_name_lang = excluded.display_name_lang,
				language = excluded.language,
				ui_locale = excluded.ui_locale,
				avatar_url = excluded.avatar_url,
				avatar_crop = excluded.avatar_crop,
				profile_completed_at = excluded.profile_completed_at,
				updated_at = excluded.updated_at,
				deleted_at = excluded.deleted_at`,
		)
		.bind(
			normalized.id,
			normalized.handle,
			localizedTextSql(normalized.displayName),
			localizedTextLangSql(normalized.displayName),
			normalized.language,
			normalized.uiLocale ?? null,
			normalized.avatar?.url ?? null,
			avatarCropJson(normalized.avatar?.crop),
			normalized.profileCompletedAt ?? null,
			normalized.createdAt,
			normalized.updatedAt,
			normalized.deletedAt ?? null,
		)
		.run();
	return normalized;
}

export async function upsertWorldIndexProjection(
	db: D1DatabaseLike,
	world: WorldDocument,
): Promise<WorldDocument> {
	const normalized = normalizeWorldDefaults(world);
	await db
		.prepare(
			`INSERT INTO worlds_index (
				world_id, handle, language, name, name_lang, description, description_lang, prompt, prompt_lang,
				avatar_url, avatar_crop, image_generation, initial_bot_notification, initial_bot_notification_lang,
				created_by_user_id, visibility, posting_thread_body_characters, posting_comment_body_characters,
				thread_comment_limit, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(world_id) DO UPDATE SET
				handle = excluded.handle,
				language = excluded.language,
				name = excluded.name,
				name_lang = excluded.name_lang,
				description = excluded.description,
				description_lang = excluded.description_lang,
				prompt = excluded.prompt,
				prompt_lang = excluded.prompt_lang,
				avatar_url = excluded.avatar_url,
				avatar_crop = excluded.avatar_crop,
				image_generation = excluded.image_generation,
				initial_bot_notification = excluded.initial_bot_notification,
				initial_bot_notification_lang = excluded.initial_bot_notification_lang,
				visibility = excluded.visibility,
				posting_thread_body_characters = excluded.posting_thread_body_characters,
				posting_comment_body_characters = excluded.posting_comment_body_characters,
				thread_comment_limit = excluded.thread_comment_limit,
				updated_at = excluded.updated_at,
				deleted_at = excluded.deleted_at`,
		)
		.bind(
			normalized.id,
			normalized.handle,
			normalized.language,
			localizedTextSql(normalized.name),
			localizedTextLangSql(normalized.name),
			localizedTextSql(normalized.description),
			localizedTextLangSql(normalized.description),
			localizedTextSql(normalized.prompt),
			localizedTextLangSql(normalized.prompt),
			normalized.avatar?.url ?? null,
			avatarCropJson(normalized.avatar?.crop),
			imageGenerationSettingsJson(normalized.imageGeneration),
			localizedTextSql(normalized.initialBotNotification),
			localizedTextLangSql(normalized.initialBotNotification),
			normalized.createdByUserId,
			normalized.visibility,
			normalized.postingSettings?.threadBodyCharacters ?? null,
			normalized.postingSettings?.commentBodyCharacters ?? null,
			normalized.threadSettings?.commentLimit ?? null,
			normalized.createdAt,
			normalized.updatedAt,
			normalized.deletedAt ?? null,
		)
		.run();
	await upsertWorldSearchIndex(db, normalized);
	return normalized;
}

export async function upsertForumIndexProjection(
	db: D1DatabaseLike,
	forum: ForumDocument,
): Promise<ForumDocument> {
	const normalized = normalizeForumDefaults(forum);
	await db
		.prepare(
			`INSERT INTO forums_index (
				forum_id, world_id, world_handle, handle, language, description, description_lang,
				created_by_user_id, created_at, updated_at, deleted_at, personal_bot_id,
				thread_comment_limit
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(forum_id) DO UPDATE SET
				world_handle = excluded.world_handle,
				handle = excluded.handle,
				language = excluded.language,
				description = excluded.description,
				description_lang = excluded.description_lang,
				personal_bot_id = excluded.personal_bot_id,
				thread_comment_limit = excluded.thread_comment_limit,
				updated_at = excluded.updated_at,
				deleted_at = excluded.deleted_at`,
		)
		.bind(
			normalized.id,
			normalized.worldId,
			normalized.worldHandle,
			normalized.handle,
			normalized.language,
			localizedTextSql(normalized.description),
			localizedTextLangSql(normalized.description),
			normalized.createdByUserId,
			normalized.createdAt,
			normalized.updatedAt,
			normalized.deletedAt ?? null,
			normalized.personalBotId ?? null,
			normalized.threadSettings?.commentLimit ?? null,
		)
		.run();
	await upsertForumSearchIndex(db, normalized);
	return normalized;
}

export async function upsertBotIndexProjection(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	bot: BotDocument,
): Promise<BotDocument> {
	const effective = await effectiveBotDocument(kv, db, bot);
	await upsertBotIndex(db, effective);
	await upsertBotSearchIndex(db, effective);
	return effective;
}

async function upsertBotIndex(db: D1DatabaseLike, bot: BotDocument): Promise<void> {
	await db
		.prepare(
			`INSERT INTO bots_index (
				bot_id, home_world_id, home_world_handle, handle, language, display_name, display_name_lang, owner_user_id,
				include_language_in_system_prompt, short_bio, short_bio_lang, avatar_url, avatar_crop, import_provider, import_external_handle, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(bot_id) DO UPDATE SET
				home_world_handle = excluded.home_world_handle,
				handle = excluded.handle,
				language = excluded.language,
				display_name = excluded.display_name,
				display_name_lang = excluded.display_name_lang,
				include_language_in_system_prompt = excluded.include_language_in_system_prompt,
				short_bio = excluded.short_bio,
				short_bio_lang = excluded.short_bio_lang,
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
			bot.language,
			localizedTextSql(bot.displayName),
			localizedTextLangSql(bot.displayName),
			bot.ownerUserId,
			booleanSql(bot.includeLanguageInSystemPrompt),
			localizedTextSql(bot.shortBio),
			localizedTextLangSql(bot.shortBio),
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
			     language = ?,
			     display_name = ?,
			     display_name_lang = ?,
			     include_language_in_system_prompt = ?,
			     short_bio = ?,
			     short_bio_lang = ?,
			     avatar_url = ?,
			     avatar_crop = ?,
			     updated_at = ?,
			     deleted_at = ?
			 WHERE bot_id = ?`,
		)
		.bind(
			bot.homeWorldHandle,
			bot.handle,
			bot.language,
			localizedTextSql(bot.displayName),
			localizedTextLangSql(bot.displayName),
			booleanSql(bot.includeLanguageInSystemPrompt),
			localizedTextSql(bot.shortBio),
			localizedTextLangSql(bot.shortBio),
			bot.avatar?.url ?? null,
			avatarCropJson(bot.avatar?.crop),
			bot.updatedAt,
			bot.deletedAt ?? null,
			bot.id,
		);
}

async function uniqueUserHandle(db: D1DatabaseLike, preferred: string): Promise<string> {
	const base = slugifyHandle(preferred, "user", 24);
	const existingHandles = await existingUserHandlesForBase(db, base);

	for (let attempt = 0; attempt < 50; attempt += 1) {
		const handle = candidateHandle(base, attempt);
		if (!existingHandles.has(handle)) {
			return handle;
		}
	}

	return `${base}-${randomToken(4)}`;
}

async function existingUserHandlesForBase(db: D1DatabaseLike, base: string): Promise<Set<string>> {
	const result = await db
		.prepare(
			`SELECT handle
			 FROM users_index
			 WHERE handle = ? OR handle LIKE ? ESCAPE '\\'`,
		)
		.bind(base, suffixedHandleLikePattern(base))
		.all<ExistingHandleRow>();
	return new Set((result.results ?? []).map((row) => row.handle));
}

function worldSummary(world: WorldDocument): WorldSummary {
	return {
		id: world.id,
		handle: world.handle,
		language: world.language,
		name: world.name,
		description: world.description,
		prompt: world.prompt ?? localizedText("", world.language),
		...(world.avatar ? { avatar: world.avatar, avatarUrl: world.avatar.url } : {}),
		...(world.avatar?.crop ? { avatarCrop: world.avatar.crop } : {}),
		...(world.imageGeneration ? { imageGeneration: cloneImageGenerationSettings(world.imageGeneration) } : {}),
		initialBotNotification: world.initialBotNotification,
		...(postingSettingsHasValues(world.postingSettings) ? { postingSettings: world.postingSettings } : {}),
		...(threadSettingsHasValues(world.threadSettings) ? { threadSettings: world.threadSettings } : {}),
		createdByUserId: world.createdByUserId,
		createdAt: world.createdAt,
		updatedAt: world.updatedAt,
	};
}

function worldSummaryFromIndexRow<T extends WorldSummaryIndexRow>(row: T): Omit<T, keyof WorldSummaryIndexRow> & WorldSummary {
	const {
		avatarCrop,
		avatarUrl,
		imageGenerationJson,
		nameLang,
		descriptionLang,
		promptLang,
		initialBotNotificationLang,
		postingThreadBodyCharacters,
		postingCommentBodyCharacters,
		threadCommentLimit,
		...world
	} = row;
	const crop = avatarCropFromJson(avatarCrop);
	const imageGeneration = imageGenerationSettingsFromJson(imageGenerationJson);
	return {
		...world,
		language: languageFromStored(world.language),
		name: localizedTextFromParts(world.name, nameLang ?? world.language),
		description: localizedTextFromParts(world.description, descriptionLang ?? world.language),
		prompt: localizedTextFromParts(world.prompt ?? "", promptLang ?? world.language),
		initialBotNotification: localizedTextFromParts(world.initialBotNotification, initialBotNotificationLang ?? world.language),
		...(avatarUrl ? { avatarUrl } : {}),
		...(crop ? { avatarCrop: crop } : {}),
		...(imageGeneration ? { imageGeneration } : {}),
		...postingSettingsObject(postingThreadBodyCharacters, postingCommentBodyCharacters),
		...threadSettingsObject(threadCommentLimit),
	} as Omit<T, keyof WorldSummaryIndexRow> & WorldSummary;
}

function imageGenerationSettingsJson(settings: BotImageGenerationSettings | undefined): string | null {
	return settings ? JSON.stringify(settings) : null;
}

function imageGenerationSettingsFromJson(value: string | null | undefined): BotImageGenerationSettings | undefined {
	if (!value) {
		return undefined;
	}
	try {
		return mergeImageGenerationSettings(undefined, JSON.parse(value) as BotImageGenerationSettingsInput);
	} catch {
		return undefined;
	}
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

function threadSettingsObject(commentLimit: number | null | undefined): { threadSettings?: ThreadSettings } {
	return commentLimit === null || commentLimit === undefined ? {} : { threadSettings: { commentLimit } };
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

function forumSummaryFromIndexRow(row: ForumSummaryIndexRow): ForumSummary {
	const { threadCommentLimit, ...forum } = row;
	return {
		...forum,
		language: languageFromStored(row.language),
		description: localizedTextFromParts(row.description, row.descriptionLang ?? row.language),
		...threadSettingsObject(threadCommentLimit),
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
		language: bot.language,
		includeLanguageInSystemPrompt: bot.includeLanguageInSystemPrompt,
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
		language: overrides.language,
		includeLanguageInSystemPrompt: overrides.includeLanguageInSystemPrompt,
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
		language: bot.language,
		description: personalForumDescription(bot),
		createdByUserId: userId,
		personalBotId: bot.id,
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.forum(forum.id), forum);
	await upsertForumIndexProjection(db, forum);
	await putObjectIndex(db, forum, "forum", entityIndexVersions.forum, forum.worldId);
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
		language: world.language,
		description: introForumDescriptionText(world.language),
		createdByUserId: userId,
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.forum(forum.id), forum);
	await upsertForumIndexProjection(db, forum);
	await putObjectIndex(db, forum, "forum", entityIndexVersions.forum, forum.worldId);
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
	const existingHandles = await existingForumHandlesForBase(db, worldId, preferred);
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const handle = candidateHandle(preferred, attempt);
		if (!existingHandles.has(handle)) {
			return handle;
		}
	}

	return `${preferred}-${randomToken(4)}`;
}

async function existingForumHandlesForBase(db: D1DatabaseLike, worldId: string, base: string): Promise<Set<string>> {
	const result = await db
		.prepare(
			`SELECT handle
			 FROM forums_index
			 WHERE world_id = ?
			   AND deleted_at IS NULL
			   AND (handle = ? OR handle LIKE ? ESCAPE '\\')`,
		)
		.bind(worldId, base, suffixedHandleLikePattern(base))
		.all<ExistingHandleRow>();
	return new Set((result.results ?? []).map((row) => row.handle));
}

function candidateHandle(base: string, attempt: number): string {
	return attempt === 0 ? base : `${base}-${attempt + 1}`;
}

function suffixedHandleLikePattern(base: string): string {
	return `${escapeLike(base)}-%`;
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

export function normalizeWorldDefaults(world: WorldDocument): WorldDocument {
	const raw = world as WorldDocument & Record<string, unknown>;
	const language = languageFromStored(typeof raw.language === "string" ? raw.language : null);
	return {
		...world,
		schemaVersion,
		language,
		name: localizedTextFromStored(raw.name, language),
		description: localizedTextFromStored(raw.description, language),
		prompt: localizedTextFromStored(raw.prompt, language),
		initialBotNotification: localizedTextFromStored(raw.initialBotNotification, language),
		...(world.imageGeneration ? { imageGeneration: mergeImageGenerationSettings(undefined, world.imageGeneration) } : { imageGeneration: undefined }),
		...(postingSettingsHasValues(world.postingSettings) ?
			{ postingSettings: mergePostingSettings(undefined, world.postingSettings) }
		:	{ postingSettings: undefined }),
		...(threadSettingsHasValues(world.threadSettings) ?
			{ threadSettings: mergeThreadSettings(undefined, world.threadSettings) }
		:	{ threadSettings: undefined }),
	};
}

export function normalizeForumDefaults(forum: ForumDocument): ForumDocument {
	const raw = forum as ForumDocument & Record<string, unknown>;
	const language = languageFromStored(typeof raw.language === "string" ? raw.language : null);
	return {
		...forum,
		schemaVersion,
		language,
		description: localizedTextFromStored(raw.description, language),
		...(threadSettingsHasValues(forum.threadSettings) ?
			{ threadSettings: mergeThreadSettings(undefined, forum.threadSettings) }
		:	{ threadSettings: undefined }),
	};
}

export function normalizeBotDefaults(bot: BotDocument): BotDocument {
	const raw = bot as BotDocument & Record<string, unknown>;
	const language = languageFromStored(typeof raw.language === "string" ? raw.language : null);
	const rawIncludeLanguageInSystemPrompt = raw.includeLanguageInSystemPrompt;
	return {
		...bot,
		schemaVersion,
		language,
		includeLanguageInSystemPrompt:
			typeof rawIncludeLanguageInSystemPrompt === "boolean" ? rawIncludeLanguageInSystemPrompt
			: rawIncludeLanguageInSystemPrompt === null ? null
			: typeof rawIncludeLanguageInSystemPrompt === "number" ? booleanFromStored(rawIncludeLanguageInSystemPrompt)
			: null,
		displayName: localizedTextFromStored(raw.displayName, language),
		shortBio: localizedTextFromStored(raw.shortBio, language),
		prompt: localizedTextFromStored(raw.prompt, language),
		inferenceSettings: mergeInferenceSettings(undefined, bot.inferenceSettings),
		toolSettings: mergeToolSettings(undefined, bot.toolSettings),
		...(postingSettingsHasValues(bot.postingSettings) ?
			{ postingSettings: mergePostingSettings(undefined, bot.postingSettings) }
		:	{ postingSettings: undefined }),
		tickSettings: mergeTickSettings(undefined, bot.tickSettings),
	};
}

export function normalizeUserDefaults(user: UserDocument): UserDocument {
	const { avatarUrl: _legacyAvatarUrl, ...withoutLegacyAvatarUrl } = user as UserDocument & Record<string, unknown> & { avatarUrl?: string };
	const raw = withoutLegacyAvatarUrl as UserDocument & Record<string, unknown>;
	const language = languageFromStored(typeof raw.language === "string" ? raw.language : null);
	return {
		...withoutLegacyAvatarUrl,
		schemaVersion,
		language,
		...(uiLocaleFromStored(typeof raw.uiLocale === "string" ? raw.uiLocale : null) ?
			{ uiLocale: uiLocaleFromStored(typeof raw.uiLocale === "string" ? raw.uiLocale : null) }
		:	{}),
		displayName: localizedTextFromStored(raw.displayName, language),
		inferenceSettings: mergeInferenceSettings(undefined, raw.inferenceSettings),
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
	assignOptionalSetting(settings, key, value);
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
	assignOptionalSetting(settings, key, value);
}

export function mergeInferenceSettings(
	current: BotInferenceSettings | undefined,
	patch?: BotInferenceSettingsInput | BotInferenceSettings,
): BotInferenceSettings {
	const next: BotInferenceSettings = {
		...defaultInferenceSettings,
		...(current ?? {}),
		...(current?.recurringPrompt ? { recurringPrompt: normalizedLocalizedText(current.recurringPrompt) } : {}),
		...(current?.imageGeneration ? { imageGeneration: cloneImageGenerationSettings(current.imageGeneration) } : {}),
		...(current?.translation ? { translation: cloneTranslationSettings(current.translation) } : {}),
		...(current?.providerRouting ? { providerRouting: cloneJsonObject(current.providerRouting) } : {}),
	};
	delete next.openRouterApiKeySet;
	if (next.recurringPromptEnabled !== false) {
		delete next.recurringPromptEnabled;
	}
	if (!patch) {
		return next;
	}

	assignTrimmedString(next, "openRouterApiKey", patch.openRouterApiKey);
	assignTrimmedString(next, "baseUrl", patch.baseUrl);
	assignTrimmedString(next, "model", patch.model);
	assignOptionalSetting(next, "compactionMode", patch.compactionMode);
	assignOptionalSetting(next, "promptCacheMode", patch.promptCacheMode);
	assignOptionalSetting(next, "cacheFriendlyCompaction", patch.cacheFriendlyCompaction);
	assignInferenceDefaultTrueBoolean(next, "recurringPromptEnabled", patch.recurringPromptEnabled);
	assignInferencePreservedString(next, "recurringPrompt", patch.recurringPrompt);
	assignOptionalSetting(next, "supportsPrefill", patch.supportsPrefill);
	assignInferenceReasoningEffort(next, "reasoningEffort", patch.reasoningEffort);
	assignOptionalSetting(next, "toolCalls", patch.toolCalls);
	assignClonedJsonObject(next, "providerRouting", patch.providerRouting);
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
	assignOptionalSetting(next, "temperature", patch.temperature);
	assignOptionalSetting(next, "topK", patch.topK);
	assignOptionalSetting(next, "topP", patch.topP);
	assignOptionalSetting(next, "minP", patch.minP);
	assignOptionalSetting(next, "frequencyPenalty", patch.frequencyPenalty);
	assignOptionalSetting(next, "presencePenalty", patch.presencePenalty);
	assignOptionalSetting(next, "repetitionPenalty", patch.repetitionPenalty);
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
	assignTrimmedString(settings, key, value);
}

function assignToolNumber<T extends object, K extends keyof T>(
	settings: T,
	key: K,
	value: number | null | undefined,
): void {
	assignOptionalSetting(settings, key, value as T[K] | null | undefined);
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

function assignTrimmedString<T extends object, K extends keyof T>(
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

function assignOptionalSetting<T extends object, K extends keyof T>(
	settings: T,
	key: K,
	value: T[K] | null | undefined,
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

function assignInferencePreservedString(
	settings: BotInferenceSettings,
	key: "recurringPrompt",
	value: LocalizedText | string | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	const text = normalizedLocalizedText(value);
	if (!text.text.trim()) {
		delete settings[key];
		return;
	}
	settings[key] = text;
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

function assignClonedJsonObject<T extends object, K extends keyof T>(
	settings: T,
	key: K,
	value: JsonObject | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	settings[key] = cloneJsonObject(value) as T[K];
}

function cloneJsonObject(value: JsonObject): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function cloneImageGenerationSettings(settings: BotImageGenerationSettings): BotImageGenerationSettings {
	return {
		...settings,
		...(settings.prompt ? { prompt: normalizedLocalizedText(settings.prompt) } : {}),
		...(settings.providerRouting ? { providerRouting: cloneJsonObject(settings.providerRouting) } : {}),
	};
}

export function mergeImageGenerationSettings(
	current: BotImageGenerationSettings | undefined,
	patch: BotImageGenerationSettingsInput | BotImageGenerationSettings | null,
): BotImageGenerationSettings | undefined {
	if (patch === null) {
		return undefined;
	}
	const next: BotImageGenerationSettings = current ? cloneImageGenerationSettings(current) : {};
	assignTrimmedString(next, "model", patch.model);
	assignLocalizedTextSetting(next, "prompt", patch.prompt);
	assignClonedJsonObject(next, "providerRouting", patch.providerRouting);
	assignTrimmedString(next, "aspectRatio", patch.aspectRatio);
	assignTrimmedString(next, "imageSize", patch.imageSize);
	assignOptionalSetting(next, "temperature", patch.temperature);
	assignOptionalSetting(next, "topK", patch.topK);
	assignOptionalSetting(next, "topP", patch.topP);
	assignOptionalSetting(next, "minP", patch.minP);
	assignOptionalSetting(next, "frequencyPenalty", patch.frequencyPenalty);
	assignOptionalSetting(next, "presencePenalty", patch.presencePenalty);
	assignOptionalSetting(next, "repetitionPenalty", patch.repetitionPenalty);
	return imageGenerationSettingsHasValues(next) ? next : undefined;
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
		...(settings.prompt ? { prompt: normalizedLocalizedText(settings.prompt) } : {}),
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
	assignTrimmedString(next, "model", patch.model);
	assignLocalizedTextSetting(next, "prompt", patch.prompt);
	if (next.enabled === undefined && hasInferenceText(next.model)) {
		next.enabled = true;
	}
	assignInferenceReasoningEffort(next, "reasoningEffort", patch.reasoningEffort);
	assignOptionalSetting(next, "toolCalls", patch.toolCalls);
	assignClonedJsonObject(next, "providerRouting", patch.providerRouting);
	assignOptionalSetting(next, "temperature", patch.temperature);
	assignOptionalSetting(next, "topK", patch.topK);
	assignOptionalSetting(next, "topP", patch.topP);
	assignOptionalSetting(next, "minP", patch.minP);
	assignOptionalSetting(next, "frequencyPenalty", patch.frequencyPenalty);
	assignOptionalSetting(next, "presencePenalty", patch.presencePenalty);
	assignOptionalSetting(next, "repetitionPenalty", patch.repetitionPenalty);
	if ((next.enabled || hasInferenceText(next.model)) && !hasInferenceText(next.prompt)) {
		next.prompt = localizedText(defaultTranslationPrompt, null);
	}
	return translationSettingsHasValues(next) ? next : undefined;
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

function normalizedLocalizedText(value: LocalizedText | string): LocalizedText {
	return localizedTextFromStored(value);
}

function assignLocalizedTextSetting<T extends { prompt?: LocalizedText }>(
	settings: T,
	key: "prompt",
	value: LocalizedText | string | null | undefined,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		delete settings[key];
		return;
	}
	const text = normalizedLocalizedText(value);
	if (text.text.trim()) {
		settings[key] = text;
	} else {
		delete settings[key];
	}
}

function hasInferenceText(value: string | LocalizedText | undefined): boolean {
	return Boolean(localizedTextString(value).trim());
}
