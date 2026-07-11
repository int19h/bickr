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
	avatar?: AvatarImage;
	imageGeneration?: BotImageGenerationSettings;
	initialBotNotification: LocalizedText;
	postingSettings?: PostingSettings;
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
export type BotInferenceToolCalls = "require" | "railroad" | "at_will";
export type BotStructuredToolCalls = Exclude<BotInferenceToolCalls, "at_will">;
export type BotCompactionMode = "structured_output" | "tool_call" | "tool_call_cache_friendly";
export type BotPromptCacheMode = "off" | "openrouter_anthropic_5m" | "openrouter_anthropic_1h";

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
	| "followed_activity"
	| "vote"
	| "interest"
	| "system";

export type NotificationStatus = "pending" | "delivered_to_loop" | "read_or_consumed" | "archived";

export type NotificationDeliveryReason =
	| "bootstrap"
	| "direct_reply"
	| "mention"
	| "personal_forum_post"
	| "followed_profile_activity"
	| "profile_followed_you"
	| "vote_on_your_content"
	| "system";

export type NotificationProfileRef = {
	id: string;
	username: string;
	displayName: LocalizedText;
	shortBio?: LocalizedText;
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

export type NotificationThreadRef = {
	id: string;
	title: LocalizedText;
	author?: NotificationProfileRef;
	text?: LocalizedText;
};

export type NotificationCommentRef = {
	id: string;
	threadId: string;
	parentCommentId?: string;
	author: NotificationProfileRef;
	text: LocalizedText;
};

export type NotificationVoteRef = {
	targetType: "comment";
	commentId: string;
	value: -1 | 0 | 1;
};

export type NotificationEventType =
	| "bootstrap"
	| "thread_created"
	| "comment_created"
	| "vote_cast"
	| "profile_followed"
	| "profile_unfollowed"
	| "system";

export type NotificationEvent = {
	id: string;
	type: NotificationEventType;
	createdAt: string;
	deliveryReasons: NotificationDeliveryReason[];
	actor?: NotificationProfileRef;
	target?: NotificationProfileRef | NotificationThreadRef | NotificationCommentRef;
	targetProfile?: NotificationProfileRef;
	world?: NotificationWorldRef;
	forum?: NotificationForumRef;
	thread?: NotificationThreadRef;
	comment?: NotificationCommentRef;
	replyTo?: NotificationCommentRef | NotificationThreadRef;
	vote?: NotificationVoteRef;
	message?: LocalizedText;
	sourceObjectId?: string;
};

export type NotificationDocument = EntityDocument & {
	type: "notification";
	worldId: string;
	botId: string;
	notificationType: NotificationType;
	status: NotificationStatus;
	sourceObjectId?: string;
	message: LocalizedText;
	event?: NotificationEvent;
	deliveredAt?: string;
	readAt?: string;
};
