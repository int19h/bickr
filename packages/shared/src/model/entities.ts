export const schemaVersion = 2;

export type LanguageTag = string & { readonly __brand: "LanguageTag" };

export type LocalizedText = {
	lang: LanguageTag | null;
	text: string;
};

export type RequiredLocalizedText = {
	lang: LanguageTag;
	text: string;
};

export type UiLocalePreference = "system" | LanguageTag;

export function localizedText(text: string, lang: LanguageTag | null): LocalizedText {
	return { lang, text };
}

export function localizedTextString(value: LocalizedText | string | null | undefined): string {
	if (typeof value === "string") {
		return value;
	}
	return value?.text ?? "";
}

export function localizedTextLang(value: LocalizedText | string | null | undefined): LanguageTag | null {
	if (!value || typeof value === "string") {
		return null;
	}
	return value.lang;
}

export function localizedTextFromStored(value: unknown, fallbackLang: LanguageTag | null = null): LocalizedText {
	if (typeof value === "string") {
		return localizedText(value, fallbackLang);
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const text = typeof record.text === "string" ? record.text : "";
		const lang = typeof record.lang === "string" && record.lang.trim() ? record.lang as LanguageTag : null;
		return localizedText(text, lang ?? fallbackLang);
	}
	return localizedText("", fallbackLang);
}

export type EntityType =
	| "user"
	| "session"
	| "world"
	| "forum"
	| "bot"
	| "thread"
	| "notification";

export const authProviders = ["github", "google"] as const;
export type AuthProvider = (typeof authProviders)[number];

export type EntityDocument = {
	id: string;
	type: EntityType;
	schemaVersion: number;
	revision: number;
	createdAt: string;
	updatedAt: string;
	deletedAt?: string;
};

export type UserDocument = EntityDocument & {
	type: "user";
	handle: string;
	language: LanguageTag | null;
	uiLocale?: UiLocalePreference;
	displayName: LocalizedText;
	avatar?: AvatarImage;
	inferenceSettings?: BotInferenceSettings;
	profileCompletedAt?: string;
};

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = {
	[key: string]: JsonValue;
};

export type SessionDocument = EntityDocument & {
	type: "session";
	userId: string;
	expiresAt: string;
};

export type WorldDocument = EntityDocument & {
	type: "world";
	handle: string;
	handleAtDeletion?: string;
	language: LanguageTag | null;
	name: LocalizedText;
	description: LocalizedText;
	prompt: LocalizedText;
	recurringPromptEnabled: boolean;
	recurringPrompt: LocalizedText;
	avatar?: AvatarImage;
	imageGeneration?: BotImageGenerationSettings;
	initialBotNotification: LocalizedText;
	postingSettings?: PostingSettings;
	threadSettings?: ThreadSettings;
	createdByUserId: string;
	visibility: "public";
};

export type ForumDocument = EntityDocument & {
	type: "forum";
	worldId: string;
	worldHandle: string;
	handle: string;
	handleAtDeletion?: string;
	language: LanguageTag | null;
	description: LocalizedText;
	createdByUserId: string;
	personalBotId?: string;
	threadSettings?: ThreadSettings;
	/**
	 * A read-only forum keeps its threads and comments readable and keeps voting
	 * and moderation available; only new threads and replies are rejected. It is
	 * required rather than optional so every writer states it explicitly; the
	 * authoritative value for content-write enforcement is the `read_only`
	 * column of the D1 projection, which the forum PATCH commits before it
	 * returns.
	 */
	readOnly: boolean;
};

export type ChirperImportSource = {
	provider: "chirper";
	originalHandle: string;
	originalProfileUrl: string;
	apiUrl: string;
	importedAt: string;
	sourceAvatarUrl?: string;
};

export type BotCloneSource = {
	sourceBotId: string;
	sourceWorldId: string;
	sourceWorldHandle: string;
	sourceHandle: string;
	clonedAt: string;
	linked: boolean;
	unlinkedAt?: string;
	relinkedAt?: string;
};

export type AvatarImageSource =
	| {
			type: "upload";
			uploadedAt: string;
			originalFilename?: string;
	  }
	| {
			type: "remote_url";
			sourceUrl: string;
			importedAt: string;
	  }
	| {
			type: "chirper";
			sourceUrl: string;
			originalHandle: string;
			importedAt: string;
	  }
	| {
			type: "generated";
			model: string;
			generatedAt: string;
			cost?: number;
			prompt?: string;
	  };

export type AvatarCrop = {
	x: number;
	y: number;
	size: number;
	imageWidth: number;
	imageHeight: number;
};

export type AvatarImage = {
	key: string;
	url: string;
	contentType: string;
	byteLength?: number;
	width?: number;
	height?: number;
	crop?: AvatarCrop;
	source?: AvatarImageSource;
	updatedAt: string;
};

export type BotCloneSourceSummary = BotCloneSource & {
	sourceBot?: {
		id: string;
		homeWorldId: string;
		homeWorldHandle: string;
		handle: string;
		language: LanguageTag | null;
		includeLanguageInSystemPrompt: boolean | null;
		displayName: LocalizedText;
		shortBio: LocalizedText;
		avatarUrl?: string;
		avatarCrop?: AvatarCrop;
	};
};

export type BotLocalOverrides = {
	language: LanguageTag | null;
	includeLanguageInSystemPrompt: boolean | null;
	displayName: LocalizedText;
	shortBio: LocalizedText;
	prompt?: LocalizedText;
	inferenceSettings: BotInferenceSettings;
	hasAvatar: boolean;
	avatar?: AvatarImage;
	avatarUrl?: string;
	avatarCrop?: AvatarCrop;
};

function avatarCropFromValue(value: unknown): AvatarCrop | undefined {
	const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const crop = {
		x: record.x,
		y: record.y,
		size: record.size,
		imageWidth: record.imageWidth,
		imageHeight: record.imageHeight,
	};
	if (!Object.values(crop).every((part) => Number.isInteger(part))) {
		return undefined;
	}
	const parsed = crop as AvatarCrop;
	if (
		parsed.x < 0 ||
		parsed.y < 0 ||
		parsed.size <= 0 ||
		parsed.imageWidth <= 0 ||
		parsed.imageHeight <= 0 ||
		parsed.x + parsed.size > parsed.imageWidth ||
		parsed.y + parsed.size > parsed.imageHeight
	) {
		return undefined;
	}
	return parsed;
}

export function avatarCropFromJson(value: string | null | undefined): AvatarCrop | undefined {
	if (!value) {
		return undefined;
	}
	try {
		return avatarCropFromValue(JSON.parse(value) as unknown);
	} catch {
		return undefined;
	}
}

export function avatarCropJson(crop: AvatarCrop | undefined): string | null {
	return crop ? JSON.stringify(crop) : null;
}

export type BotDocument = EntityDocument & {
	type: "bot";
	homeWorldId: string;
	homeWorldHandle: string;
	ownerUserId: string;
	handle: string;
	handleAtDeletion?: string;
	language: LanguageTag | null;
	includeLanguageInSystemPrompt: boolean | null;
	displayName: LocalizedText;
	shortBio: LocalizedText;
	prompt: LocalizedText;
	inferenceSettings: BotInferenceSettings;
	toolSettings: BotToolSettings;
	postingSettings?: PostingSettings;
	tickSettings: BotTickSettings;
	importSource?: ChirperImportSource;
	cloneSource?: BotCloneSourceSummary;
	localOverrides?: BotLocalOverrides;
	avatar?: AvatarImage;
};

export type BotInferenceSettings = {
	openRouterApiKey?: string;
	openRouterApiKeySet?: boolean;
	baseUrl?: string;
	model?: string;
	compactionMode?: BotCompactionMode;
	promptCacheMode?: BotPromptCacheMode;
	cacheFriendlyCompaction?: boolean;
	recurringPromptEnabled?: boolean;
	recurringPrompt?: LocalizedText;
	supportsPrefill?: boolean;
	reasoningEffort?: BotInferenceReasoningEffort;
	toolCalls?: BotInferenceToolCalls;
	providerRouting?: JsonObject;
	imageGeneration?: BotImageGenerationSettings;
	translation?: BotTranslationSettings;
	temperature?: number;
	topK?: number;
	topP?: number;
	minP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
};

export type BotInferenceReasoningEffort = "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type BotCompactionReasoningEffort = Exclude<BotInferenceReasoningEffort, "default" | "none">;
/** Provider request intent is retained until the final request shape is built. */
export type BotInferenceReasoningRequest =
	| { kind: "bickr_automatic" }
	| { kind: "provider_default" }
	| { kind: "reasoning_disabled" }
	| { kind: "explicit_effort"; effort: BotCompactionReasoningEffort };
export type BotInferenceReasoningIntent = { kind: "inherit" } | BotInferenceReasoningRequest;
export type BotCompactionReasoningRequest =
	| { kind: "reasoning_disabled" }
	| { kind: "model_default" }
	| { kind: "explicit_effort"; effort: BotCompactionReasoningEffort };
export type BotInferenceToolCalls = "require" | "railroad" | "at_will";
export type BotInferenceToolCallRequest =
	| { kind: "bickr_automatic" }
	| { kind: "provider_default" }
	| { kind: "strategy"; strategy: BotInferenceToolCalls };
export type BotInferenceToolCallIntent = { kind: "inherit" } | BotInferenceToolCallRequest;
/** Raw prefill intent is retained until the request's reasoning shape is known. */
export type BotInferencePrefillIntent =
	| { kind: "inherit" }
	| { kind: "explicit"; enabled: boolean };
export type BotStructuredToolCalls = Exclude<BotInferenceToolCalls, "at_will">;
export type BotCompactionMode = "structured_output" | "tool_call" | "tool_call_cache_friendly";
export type BotCompactionModeRequest =
	| { kind: "bickr_automatic" }
	| { kind: "mode"; mode: BotCompactionMode };
export type BotCompactionModeIntent = { kind: "inherit" } | BotCompactionModeRequest;
/**
 * Migration-v1 stored this impossible provider-owned state. New owner writes
 * reject it; migration 0046 rewrites provenance-proven rows and this boundary
 * keeps unswept rows readable until that bounded sweep completes. Once fleet
 * status has no pending rows, bump the graph schema and delete this alias and
 * its storage-parser branch.
 */
export type LegacyBotCompactionModeRequest = BotCompactionModeRequest | { kind: "provider_default" };
export type BotPromptCacheMode = "off" | "openrouter_anthropic_5m" | "openrouter_anthropic_1h";
export type BotPromptCacheRequest =
	| { kind: "bickr_automatic" }
	| { kind: "provider_default" }
	| { kind: "mode"; mode: BotPromptCacheMode };
export type BotPromptCacheIntent = { kind: "inherit" } | BotPromptCacheRequest;

export type BotTranslationSettings = {
	enabled?: boolean;
	model?: string;
	prompt?: LocalizedText;
	reasoningEffort?: BotInferenceReasoningEffort;
	toolCalls?: BotStructuredToolCalls;
	providerRouting?: JsonObject;
	temperature?: number;
	topK?: number;
	topP?: number;
	minP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
};

export type BotImageGenerationSettings = {
	model?: string;
	prompt?: LocalizedText;
	providerRouting?: JsonObject;
	aspectRatio?: string;
	imageSize?: string;
	temperature?: number;
	topK?: number;
	topP?: number;
	minP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
};

export type SettingsPatch<T> = { [K in keyof T]?: T[K] | null };

// Omits the output-only API-key indicator and recursively patches nested settings.
export type BotInferenceSettingsInput = {
	openRouterApiKey?: string | null;
	baseUrl?: string | null;
	model?: string | null;
	compactionMode?: BotCompactionMode | null;
	promptCacheMode?: BotPromptCacheMode | null;
	cacheFriendlyCompaction?: boolean | null;
	recurringPromptEnabled?: boolean | null;
	recurringPrompt?: LocalizedText | null;
	supportsPrefill?: boolean | null;
	reasoningEffort?: BotInferenceReasoningEffort | null;
	toolCalls?: BotInferenceToolCalls | null;
	providerRouting?: JsonObject | null;
	imageGeneration?: BotImageGenerationSettingsInput | null;
	translation?: BotTranslationSettingsInput | null;
	temperature?: number | null;
	topK?: number | null;
	topP?: number | null;
	minP?: number | null;
	frequencyPenalty?: number | null;
	presencePenalty?: number | null;
	repetitionPenalty?: number | null;
};

export type BotImageGenerationSettingsInput = SettingsPatch<BotImageGenerationSettings>;

// Keeps enabled non-nullable so callers cannot clear the translation toggle.
export type BotTranslationSettingsInput = Partial<{
	enabled: boolean;
	model: string | null;
	prompt: LocalizedText | null;
	reasoningEffort: BotInferenceReasoningEffort | null;
	toolCalls: BotStructuredToolCalls | null;
	providerRouting: JsonObject | null;
	temperature: number | null;
	topK: number | null;
	topP: number | null;
	minP: number | null;
	frequencyPenalty: number | null;
	presencePenalty: number | null;
	repetitionPenalty: number | null;
}>;

export type OpenRouterWebSearchEngine = "auto" | "native" | "exa" | "firecrawl" | "parallel";
export type OpenRouterWebFetchEngine = "auto" | "native" | "exa" | "openrouter" | "firecrawl";
export type OpenRouterSearchContextSize = "low" | "medium" | "high";

export type OpenRouterDatetimeToolSettings = {
	enabled: boolean;
	timezone?: string;
};

export type OpenRouterWebSearchUserLocation = {
	type: "approximate";
	city?: string;
	region?: string;
	country?: string;
	timezone?: string;
};

export type OpenRouterWebSearchToolSettings = {
	enabled: boolean;
	engine?: OpenRouterWebSearchEngine;
	maxResults?: number;
	maxTotalResults?: number;
	searchContextSize?: OpenRouterSearchContextSize;
	userLocation?: OpenRouterWebSearchUserLocation;
	allowedDomains?: string[];
	excludedDomains?: string[];
};

export type OpenRouterWebFetchToolSettings = {
	enabled: boolean;
	engine?: OpenRouterWebFetchEngine;
	maxUses?: number;
	maxContentTokens?: number;
	allowedDomains?: string[];
	blockedDomains?: string[];
};

export type OpenRouterServerToolSettings = {
	datetime?: OpenRouterDatetimeToolSettings;
	webSearch?: OpenRouterWebSearchToolSettings;
	webFetch?: OpenRouterWebFetchToolSettings;
};

export type BotToolSettings = {
	openRouter?: OpenRouterServerToolSettings;
};

// Keeps enabled non-nullable so callers cannot clear the tool toggle.
export type OpenRouterDatetimeToolSettingsInput = Partial<{
	enabled: boolean;
	timezone: string | null;
}>;

// Omits the fixed "approximate" discriminator supplied by the settings writer.
export type OpenRouterWebSearchUserLocationInput = Partial<{
	city: string | null;
	region: string | null;
	country: string | null;
	timezone: string | null;
}>;

// Keeps enabled non-nullable and recursively patches the nested location.
export type OpenRouterWebSearchToolSettingsInput = Partial<{
	enabled: boolean;
	engine: OpenRouterWebSearchEngine | null;
	maxResults: number | null;
	maxTotalResults: number | null;
	searchContextSize: OpenRouterSearchContextSize | null;
	userLocation: OpenRouterWebSearchUserLocationInput | null;
	allowedDomains: string[] | null;
	excludedDomains: string[] | null;
}>;

// Keeps enabled non-nullable so callers cannot clear the tool toggle.
export type OpenRouterWebFetchToolSettingsInput = Partial<{
	enabled: boolean;
	engine: OpenRouterWebFetchEngine | null;
	maxUses: number | null;
	maxContentTokens: number | null;
	allowedDomains: string[] | null;
	blockedDomains: string[] | null;
}>;

// Recursively patches each nested tool's settings instead of replacing them.
export type OpenRouterServerToolSettingsInput = Partial<{
	datetime: OpenRouterDatetimeToolSettingsInput | null;
	webSearch: OpenRouterWebSearchToolSettingsInput | null;
	webFetch: OpenRouterWebFetchToolSettingsInput | null;
}>;

// Recursively patches OpenRouter settings instead of replacing them.
export type BotToolSettingsInput = Partial<{
	openRouter: OpenRouterServerToolSettingsInput | null;
}>;

export type PostingSettings = Partial<{
	threadBodyCharacters: number;
	commentBodyCharacters: number;
}>;

export type BotEffectivePostingSettings = Required<PostingSettings>;

export type PostingSettingsInput = SettingsPatch<PostingSettings>;

export type ThreadSettings = Partial<{
	commentLimit: number;
}>;

export type EffectiveThreadSettings = Required<ThreadSettings>;

export type ThreadSettingsInput = SettingsPatch<ThreadSettings>;

export type ThreadLock = {
	kind: "comment_limit";
	limit: number;
};

export type BotTickSettings = {
	enabled: boolean;
	intervalSeconds: number;
	allowEarlyLogOff?: boolean;
	contextWindowTokens?: number;
	compactionThreshold: number;
	compactionSummaryPercent?: number;
	compactionMaxCharacters?: number;
	maxToolCallsPerTick?: number;
	maxSuccessfulToolCallsPerIteration?: number;
	maxGeneratedTokensPerTick?: number;
	maxGeneratedTokensPerIteration?: number;
};

export type BotEffectiveTickSettings = Required<BotTickSettings>;

// Keeps required runtime controls non-nullable while optional overrides remain clearable.
export type BotTickSettingsInput = Partial<{
	enabled: boolean;
	intervalSeconds: number;
	allowEarlyLogOff: boolean | null;
	contextWindowTokens: number | null;
	compactionThreshold: number;
	compactionSummaryPercent: number | null;
	compactionMaxCharacters: number | null;
	maxToolCallsPerTick: number | null;
	maxSuccessfulToolCallsPerIteration: number | null;
	maxGeneratedTokensPerTick: number | null;
	maxGeneratedTokensPerIteration: number | null;
}>;

export type CommentDocument = {
	id: string;
	threadId: string;
	worldId: string;
	forumId: string;
	authorBotId: string;
	authorHandle: string;
	authorDisplayName: LocalizedText;
	/**
	 * Read-time overlay, never persisted (§2.7). `hydrateThreadForRead` strips
	 * whatever a stored document carries and fills these from the author's
	 * current avatar; a deleted or inactive author leaves them absent.
	 */
	authorAvatarUrl?: string;
	authorAvatarCrop?: AvatarCrop;
	parentCommentId?: string;
	body: LocalizedText;
	voteScore: number;
	createdAt: string;
	updatedAt: string;
	deletedAt?: string;
	readState?: CommentReadState;
};

export type VoteDetail = {
	botId: string;
	handle: string;
	displayName: LocalizedText;
	value: number;
	createdAt: string;
	updatedAt: string;
};

export type ThreadReadState = {
	isNew: boolean;
	hasNewComments: boolean;
	newCommentCount: number;
};

export type CommentReadState = {
	isNew: boolean;
};

export type ThreadDocument = EntityDocument & {
	type: "thread";
	worldId: string;
	worldHandle: string;
	forumId: string;
	forumHandle: string;
	title: LocalizedText;
	rootCommentId: string;
	url?: string;
	comments: CommentDocument[];
	commentCount: number;
	voteScore: number;
	recentCommentCount: number;
	lastActivityAt: string;
	readState?: ThreadReadState;
};

export type NotificationType =
	| "bootstrap"
	| "reply"
	| "mention"
	| "personal_forum_post"
	| "follow"
	| "unfollow"
	| "followed_activity"
	| "vote"
	| "interest"
	| "system";

/**
 * Delivery deletes a notification from both stores instead of transitioning it
 * (design doc §2.3), so `pending` is the only status this build writes, reads or
 * selects on. The retired `delivered_to_loop`/`read_or_consumed`/`archived`
 * values still sit in D1 rows written by earlier builds until the prune drains
 * them, which is why the prune matches them as "not pending" rather than by
 * name, and why readers of pre-redesign documents compare the stored string.
 */
export type NotificationStatus = "pending";

export type NotificationDeliveryReason =
	| "bootstrap"
	| "direct_reply"
	| "mention"
	| "personal_forum_post"
	| "followed_profile_activity"
	| "profile_followed_you"
	| "profile_unfollowed_you"
	| "vote_on_your_content"
	| "system";

export type NotificationProfileRef = {
	id: string;
	username: string;
	displayName: LocalizedText;
};

export type NotificationWorldRef = {
	id: string;
	handle: string;
	name?: LocalizedText;
};

export type NotificationForumRef = {
	id: string;
	handle: string;
	description?: LocalizedText;
};

/** Where a piece of content lives. Carries no body text of its own. */
export type NotificationThreadRef = {
	id: string;
	title: LocalizedText;
};

/** A thread plus its root post: only full payloads pay for the body. */
export type NotificationThreadPostRef = NotificationThreadRef & {
	author: NotificationProfileRef;
	text: LocalizedText;
};

/** Identity of a comment, without its body. */
export type NotificationCommentRef = {
	id: string;
	threadId: string;
	parentCommentId?: string;
};

/** A comment plus its body: reply and mention payloads only. */
export type NotificationCommentPostRef = NotificationCommentRef & {
	author: NotificationProfileRef;
	text: LocalizedText;
};

/**
 * The payload of a stored notification, built per recipient class rather than
 * per action: one new comment yields a full reply payload for the parent's
 * author, a mention payload for every mentioned participant, and a body-free
 * notice for the author's followers.
 *
 * `kind` is that recipient class and decides which references the payload
 * carries; `type` is what happened in the forum and is what the participant is
 * shown. The two are separate because a mention can arrive with either a new
 * thread or a new comment while carrying the same references.
 */
export type NotificationEventPayload =
	| {
			kind: "bootstrap";
			type: "bootstrap";
			world: NotificationWorldRef;
			message: LocalizedText;
		}
	| {
			/** A followed participant opened a thread, or one landed in a personal forum. */
			kind: "thread_post";
			type: "thread_created";
			actor: NotificationProfileRef;
			thread: NotificationThreadPostRef;
		}
	| {
			kind: "reply";
			type: "comment_created";
			actor: NotificationProfileRef;
			thread: NotificationThreadRef;
			comment: NotificationCommentPostRef;
			/**
			 * The recipient's own comment, the one that was replied to. When it is the
			 * thread's root comment this is also the root post, which is the only case
			 * where a reply payload carries the root text.
			 */
			replyTo: NotificationCommentPostRef;
		}
	| {
			kind: "mention";
			/** Root-comment mentions arrive with a new thread; every other one with a comment. */
			type: "thread_created" | "comment_created";
			actor: NotificationProfileRef;
			thread: NotificationThreadRef;
			/** The mentioning comment, which for a new thread is its root comment. */
			comment: NotificationCommentPostRef;
		}
	| {
			/** Slim follower notice: references and a thread title, no bodies. */
			kind: "comment_notice";
			type: "comment_created";
			actor: NotificationProfileRef;
			thread: NotificationThreadRef;
			comment: NotificationCommentRef;
		}
	| {
			kind: "vote";
			type: "vote_cast";
			actor: NotificationProfileRef;
			/** The recipient's own comment that was voted on. */
			target: NotificationCommentRef;
			value: -1 | 0 | 1;
		}
	| {
			kind: "follow";
			type: "profile_followed";
			actor: NotificationProfileRef;
		}
	| {
			kind: "unfollow";
			type: "profile_unfollowed";
			actor: NotificationProfileRef;
		};

export type NotificationEventKind = NotificationEventPayload["kind"];

export type NotificationEventEnvelope = {
	/** The id of the notification document this payload was built for. */
	id: string;
	createdAt: string;
	deliveryReasons: NotificationDeliveryReason[];
	sourceObjectId?: string;
};

export type NotificationEvent = NotificationEventEnvelope & NotificationEventPayload;

/**
 * Legacy adapter (single, marked, and temporary): every notification stored
 * before the per-recipient payload redesign holds one flat optional-field event
 * that was copied verbatim to all recipients. Nothing writes this shape any
 * more, and the fields are typed as `unknown` because several generations of
 * writers produced them; the serializer reads them defensively.
 *
 * Retirement: pending notifications are pruned on a retention window, so this
 * variant — and the reader branches that switch on it — go away once no stored
 * document predates the redesign.
 */
export type LegacyNotificationEvent = {
	kind: "legacy";
	id: string;
	type: string;
	createdAt: string;
	deliveryReasons: string[];
	sourceObjectId?: string;
	message?: unknown;
	actor?: unknown;
	target?: unknown;
	targetProfile?: unknown;
	world?: unknown;
	forum?: unknown;
	thread?: unknown;
	comment?: unknown;
	replyTo?: unknown;
	vote?: unknown;
};

/** What a reader of stored notification documents has to handle. */
export type StoredNotificationEvent = NotificationEvent | LegacyNotificationEvent;

const notificationEventKinds: readonly string[] = [
	"bootstrap",
	"thread_post",
	"reply",
	"mention",
	"comment_notice",
	"vote",
	"follow",
	"unfollow",
] satisfies readonly NotificationEventKind[];

/**
 * The one place a stored notification event is classified. Documents written by
 * the current generation path carry their payload `kind`; anything else predates
 * it and is tagged as legacy so consumers can switch exhaustively instead of
 * sniffing shapes on their own.
 */
export function storedNotificationEvent(value: unknown): StoredNotificationEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.kind === "string" && notificationEventKinds.includes(record.kind)) {
		return value as NotificationEvent;
	}
	return {
		...record,
		kind: "legacy",
		id: typeof record.id === "string" ? record.id : "",
		type: typeof record.type === "string" ? record.type : "system",
		createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
		deliveryReasons: Array.isArray(record.deliveryReasons) ?
			record.deliveryReasons.filter((reason): reason is string => typeof reason === "string")
		:	[],
		...(typeof record.sourceObjectId === "string" ? { sourceObjectId: record.sourceObjectId } : {}),
	};
}

export type NotificationDocument = EntityDocument & {
	type: "notification";
	worldId: string;
	botId: string;
	notificationType: NotificationType;
	status: NotificationStatus;
	sourceObjectId?: string;
	message: LocalizedText;
	/**
	 * Absent only on documents old enough to predate stored events. Read it
	 * through {@link storedNotificationEvent}: a document written before the
	 * per-recipient redesign holds a {@link LegacyNotificationEvent}.
	 */
	event?: StoredNotificationEvent;
};
