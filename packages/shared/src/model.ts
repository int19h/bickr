import { generatedOpenRouterImageModelConfigEntries } from "./openrouter-image-model-config.generated";

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

export const openRouterImageAspectRatios = [
	"1:1",
	"2:3",
	"3:2",
	"3:4",
	"4:3",
	"4:5",
	"5:4",
	"9:16",
	"16:9",
	"21:9",
] as const;

export const openRouterExtendedImageAspectRatios = ["1:4", "4:1", "1:8", "8:1"] as const;
export const openRouterGrokImageAspectRatios = ["2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "auto"] as const;

export const openRouterImageSizes = ["1K", "2K", "4K"] as const;
export const openRouterExtendedImageSizes = ["0.5K"] as const;
const openRouterGrokImageAspectRatioModelPrefix = "x-ai/grok-imagine-image";
const openRouterDefaultImageConfig = {
	aspectRatios: openRouterImageAspectRatios,
	imageSizes: openRouterImageSizes,
} as const satisfies OpenRouterImageModelConfig;
const generatedOpenRouterImageModelConfig = new Map<string, OpenRouterImageModelConfig>(
	generatedOpenRouterImageModelConfigEntries.map(([model, config]) => [model, config]),
);

export const defaultAvatarImageGenerationSettings = {
	model: "google/gemini-3.1-flash-image",
	aspectRatio: "1:1",
	imageSize: "1K",
} as const satisfies Pick<BotImageGenerationSettings, "model" | "aspectRatio" | "imageSize">;

export const defaultWorldAvatarImageGenerationSettings = {
	...defaultAvatarImageGenerationSettings,
	aspectRatio: "21:9",
} as const satisfies Pick<BotImageGenerationSettings, "model" | "aspectRatio" | "imageSize">;

export function avatarImageGenerationSettingsWithDefaults(
	settings: BotImageGenerationSettings | undefined,
): BotImageGenerationSettings {
	return imageGenerationSettingsWithDefaults(settings, defaultAvatarImageGenerationSettings);
}

export function worldAvatarImageGenerationSettingsWithDefaults(
	settings: BotImageGenerationSettings | undefined,
): BotImageGenerationSettings {
	return imageGenerationSettingsWithDefaults(settings, defaultWorldAvatarImageGenerationSettings);
}

function imageGenerationSettingsWithDefaults(
	settings: BotImageGenerationSettings | undefined,
	defaults: Pick<BotImageGenerationSettings, "model" | "aspectRatio" | "imageSize">,
): BotImageGenerationSettings {
	const model = settings?.model?.trim() || defaults.model;
	const defaultConfigShape =
		!settings?.model?.trim() ||
		normalizedOpenRouterImageModelId(settings.model) === normalizedOpenRouterImageModelId(defaults.model);
	const aspectRatio = settings?.aspectRatio?.trim() || (defaultConfigShape ? defaults.aspectRatio : undefined);
	const imageSize = settings?.imageSize?.trim() || (defaultConfigShape ? defaults.imageSize : undefined);
	const result: BotImageGenerationSettings = {
		...settings,
		model,
	};
	if (aspectRatio) {
		result.aspectRatio = aspectRatio;
	} else {
		delete result.aspectRatio;
	}
	if (imageSize) {
		result.imageSize = imageSize;
	} else {
		delete result.imageSize;
	}
	return result;
}

export type OpenRouterImageAspectRatio =
	| (typeof openRouterImageAspectRatios)[number]
	| (typeof openRouterExtendedImageAspectRatios)[number]
	| (typeof openRouterGrokImageAspectRatios)[number];

export type OpenRouterImageSize =
	| (typeof openRouterImageSizes)[number]
	| (typeof openRouterExtendedImageSizes)[number];

export type OpenRouterImageModelConfig = {
	aspectRatios: readonly string[];
	imageSizes: readonly string[];
};

export function openRouterImageModelConfig(model: string | undefined): OpenRouterImageModelConfig {
	return generatedOpenRouterImageModelConfig.get(normalizedOpenRouterImageModelId(model)) ?? openRouterDefaultImageConfig;
}

export function openRouterSuggestedImageAspectRatios(model: string | undefined): readonly string[] {
	return openRouterImageModelConfig(model).aspectRatios;
}

export function openRouterSuggestedImageSizes(model: string | undefined): readonly string[] {
	return openRouterImageModelConfig(model).imageSizes;
}

export function isOpenRouterImageAspectRatio(value: string): value is OpenRouterImageAspectRatio {
	return (openRouterImageAspectRatios as readonly string[]).includes(value) ||
		(openRouterExtendedImageAspectRatios as readonly string[]).includes(value) ||
		(openRouterGrokImageAspectRatios as readonly string[]).includes(value);
}

export function isOpenRouterImageSize(value: string): value is OpenRouterImageSize {
	return (openRouterImageSizes as readonly string[]).includes(value) ||
		(openRouterExtendedImageSizes as readonly string[]).includes(value);
}

export function isOpenRouterExtendedImageAspectRatio(value: string): value is (typeof openRouterExtendedImageAspectRatios)[number] {
	return (openRouterExtendedImageAspectRatios as readonly string[]).includes(value);
}

export function isOpenRouterGrokImageAspectRatio(value: string): value is (typeof openRouterGrokImageAspectRatios)[number] {
	return (openRouterGrokImageAspectRatios as readonly string[]).includes(value);
}

export function isOpenRouterExtendedImageSize(value: string): value is (typeof openRouterExtendedImageSizes)[number] {
	return (openRouterExtendedImageSizes as readonly string[]).includes(value);
}

export function supportsOpenRouterExtendedImageConfig(model: string): boolean {
	const config = openRouterImageModelConfig(model);
	return config.aspectRatios.some((ratio) => isOpenRouterExtendedImageAspectRatio(ratio)) ||
		config.imageSizes.some((size) => isOpenRouterExtendedImageSize(size));
}

export function supportsOpenRouterGrokImageAspectRatios(model: string): boolean {
	return normalizedOpenRouterImageModelId(model).startsWith(openRouterGrokImageAspectRatioModelPrefix);
}

function normalizedOpenRouterImageModelId(model: string | undefined): string {
	return model?.trim().toLowerCase().split(":")[0] ?? "";
}

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

export type BotImageGenerationSettingsInput = Partial<{
	model: string | null;
	prompt: LocalizedText | null;
	providerRouting: JsonObject | null;
	aspectRatio: string | null;
	imageSize: string | null;
	temperature: number | null;
	topK: number | null;
	topP: number | null;
	minP: number | null;
	frequencyPenalty: number | null;
	presencePenalty: number | null;
	repetitionPenalty: number | null;
}>;

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

export type OpenRouterDatetimeToolSettingsInput = Partial<{
	enabled: boolean;
	timezone: string | null;
}>;

export type OpenRouterWebSearchUserLocationInput = Partial<{
	city: string | null;
	region: string | null;
	country: string | null;
	timezone: string | null;
}>;

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

export type OpenRouterWebFetchToolSettingsInput = Partial<{
	enabled: boolean;
	engine: OpenRouterWebFetchEngine | null;
	maxUses: number | null;
	maxContentTokens: number | null;
	allowedDomains: string[] | null;
	blockedDomains: string[] | null;
}>;

export type OpenRouterServerToolSettingsInput = Partial<{
	datetime: OpenRouterDatetimeToolSettingsInput | null;
	webSearch: OpenRouterWebSearchToolSettingsInput | null;
	webFetch: OpenRouterWebFetchToolSettingsInput | null;
}>;

export type BotToolSettingsInput = Partial<{
	openRouter: OpenRouterServerToolSettingsInput | null;
}>;

export type PostingSettings = Partial<{
	threadBodyCharacters: number;
	commentBodyCharacters: number;
}>;

export type BotEffectivePostingSettings = Required<PostingSettings>;

export type PostingSettingsInput = Partial<{
	threadBodyCharacters: number | null;
	commentBodyCharacters: number | null;
}>;

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

export const defaultProviderModel = "openrouter/free";
export const defaultTextGenerationTemperature = 1;
export const legacyDefaultTextGenerationTemperature = 0.9;
export const defaultTranslationPrompt = "Translate to English.";
export const contextWindowTokensMin = 15_000;
export const contextWindowTokensMax = 1_000_000;

export function defaultReasoningPrefill(handle: string): string {
	return `I'm u/${handle}. I need to think about how I feel and what I want to do next.`;
}

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

export type PublicUser = {
	id: string;
	handle: string;
	language: LanguageTag | null;
	uiLocale?: UiLocalePreference;
	displayName: LocalizedText;
	avatar?: AvatarImage;
	avatarUrl?: string;
	avatarCrop?: AvatarCrop;
	profileComplete: boolean;
	profileCompletedAt?: string;
};

export type LinkedAuthIdentity = {
	provider: AuthProvider;
	providerLogin: string;
	email?: string;
	avatarUrl?: string;
	createdAt: string;
	updatedAt: string;
};

export type UserProfile = PublicUser & {
	authIdentities: LinkedAuthIdentity[];
	inferenceSettings: BotInferenceSettings;
	createdAt: string;
	updatedAt: string;
};

export type SessionPayload = {
	authenticated: boolean;
	user: PublicUser | null;
};

export type HumanSubscriptionScope = "world" | "forum" | "thread" | "comment" | "bot";

export type HumanSubscription = {
	id: string;
	userId: string;
	worldId: string;
	scopeType: HumanSubscriptionScope;
	scopeId: string;
	active: boolean;
	autoCreated: boolean;
	createdAt: string;
	updatedAt: string;
};

export type HumanSubscriptionTarget = {
	scopeType: HumanSubscriptionScope;
	scopeId: string;
	worldId: string;
};

export type HumanSubscriptionChange = HumanSubscriptionTarget & {
	active: boolean;
};

export type HumanSubscriptionCommentSummary = {
	id: string;
	threadId: string;
	worldId: string;
	forumId: string;
	authorBotId: string;
	authorHandle: string;
	authorDisplayName: LocalizedText;
	authorAvatarUrl?: string;
	authorAvatarCrop?: AvatarCrop;
	bodyPreview: LocalizedText;
	createdAt: string;
};

export type HumanSubscriptionCommentNode = {
	type: "comment";
	comment: HumanSubscriptionCommentSummary;
	target: HumanSubscriptionTarget;
	subscription?: HumanSubscription;
};

export type HumanSubscriptionThreadNode = {
	type: "thread";
	thread: ThreadSummary;
	target: HumanSubscriptionTarget;
	subscription?: HumanSubscription;
	comments: HumanSubscriptionCommentNode[];
};

export type HumanSubscriptionForumNode = {
	type: "forum";
	forum: ForumSummary;
	target: HumanSubscriptionTarget;
	subscription?: HumanSubscription;
	threads: HumanSubscriptionThreadNode[];
};

export type HumanSubscriptionBotNode = {
	type: "bot";
	bot: BotPublicProfile;
	target: HumanSubscriptionTarget;
	subscription?: HumanSubscription;
};

export type HumanSubscriptionWorldNode = {
	type: "world";
	world: WorldSummary;
	target: HumanSubscriptionTarget;
	subscription?: HumanSubscription;
	bots: HumanSubscriptionBotNode[];
	forums: HumanSubscriptionForumNode[];
};

export type HumanSubscriptionTree = {
	worlds: HumanSubscriptionWorldNode[];
};

export type HumanSubscriptionTreeResponse = {
	subscriptions: HumanSubscription[];
	tree: HumanSubscriptionTree;
};

export type HumanNotificationType =
	| "thread_created"
	| "comment_created"
	| "vote_cast"
	| "bot_followed"
	| "bot_unfollowed"
	| "spotlight_action"
	| "spotlight_no_reaction"
	| "spotlight_failed"
	| "bot_runtime_failed"
	| "world_settings_changed";

export type HumanNotification = {
	id: string;
	userId: string;
	worldId: string;
	eventKey: string;
	notificationType: HumanNotificationType;
	actorBotId?: string;
	actorHandle?: string;
	actorDisplayName?: LocalizedText;
	worldHandle?: string;
	worldName?: LocalizedText;
	forumId?: string;
	forumHandle?: string;
	forumName?: LocalizedText;
	sourceType?: string;
	sourceId?: string;
	targetType?: string;
	targetId?: string;
	title: LocalizedText;
	body: LocalizedText;
	urlPath: string;
	spotlightId?: string;
	spotlightLabel?: string;
	createdAt: string;
	readAt?: string;
	archivedAt?: string;
};

export type HumanNotificationSummary = {
	hasMore?: boolean;
	nextOffset?: number;
	unreadCount: number;
	notifications: HumanNotification[];
};

export type HumanNotificationListScope =
	| { scopeType: "all" }
	| { scopeType: "world"; scopeId: string }
	| { scopeType: "bot"; scopeId: string };

export type HumanNotificationReadScope =
	| { scopeType: "all" }
	| { scopeType: "world"; scopeId: string }
	| { scopeType: "bot"; scopeId: string }
	| { scopeType: "notifications"; notificationIds: string[] };

export type WorldSummary = {
	id: string;
	handle: string;
	language: LanguageTag | null;
	name: LocalizedText;
	description: LocalizedText;
	prompt: LocalizedText;
	avatar?: AvatarImage;
	avatarUrl?: string;
	avatarCrop?: AvatarCrop;
	imageGeneration?: BotImageGenerationSettings;
	initialBotNotification: LocalizedText;
	postingSettings?: PostingSettings;
	createdByUserId: string;
	createdAt: string;
	updatedAt: string;
};

export type WorldListSummary = WorldSummary & {
	forumCount: number;
	botCount: number;
};

export type ForumSummary = {
	id: string;
	worldId: string;
	worldHandle: string;
	handle: string;
	language: LanguageTag | null;
	description: LocalizedText;
	createdByUserId: string;
	personalBotId?: string;
	createdAt: string;
	updatedAt: string;
};

export type BotSummary = {
	id: string;
	homeWorldId: string;
	homeWorldHandle: string;
	ownerUserId: string;
	owner?: PublicUser;
	handle: string;
	language: LanguageTag | null;
	includeLanguageInSystemPrompt: boolean | null;
	displayName: LocalizedText;
	shortBio: LocalizedText;
	avatar?: AvatarImage;
	avatarUrl?: string;
	avatarCrop?: AvatarCrop;
	prompt?: LocalizedText;
	inferenceSettings: BotInferenceSettings;
	toolSettings?: BotToolSettings;
	postingSettings: PostingSettings;
	effectivePostingSettings: BotEffectivePostingSettings;
	tickSettings: BotTickSettings;
	effectiveTickSettings: BotEffectiveTickSettings;
	importSource?: ChirperImportSource;
	cloneSource?: BotCloneSourceSummary;
	localOverrides?: BotLocalOverrides;
	lastActiveAt?: string;
	nextDueAt?: string | null;
	createdAt: string;
	updatedAt: string;
};

export type BotGroupTitleSource = "custom" | "members";

export type BotGroupSummary = {
	id: string;
	worldId: string;
	ownerUserId: string;
	language: LanguageTag | null;
	customTitle: LocalizedText | null;
	displayTitle: string;
	titleSource: BotGroupTitleSource;
	bots: BotSummary[];
	createdAt: string;
	updatedAt: string;
};

export type BotPublicProfile = {
	id: string;
	homeWorldId: string;
	homeWorldHandle: string;
	handle: string;
	language: LanguageTag | null;
	displayName: LocalizedText;
	shortBio: LocalizedText;
	avatarUrl?: string;
	avatarCrop?: AvatarCrop;
	createdAt: string;
	updatedAt: string;
};

export type BotSearchResult = BotPublicProfile & {
	score?: number;
	source?: "vector" | "text";
};

export type SearchEntityType = "world" | "forum" | "bot";
export type SearchMode = "substring" | "fts" | "semantic";
export type SearchResultSource = "substring" | "fts" | "semantic";

export type SearchWorldContext = {
	id: string;
	handle: string;
	name: LocalizedText;
	description: LocalizedText;
	matched: boolean;
};

export type SearchResultBase = {
	id: string;
	rank: number;
	score?: number;
	source: SearchResultSource;
	type: SearchEntityType;
	urlPath: string;
	world: SearchWorldContext;
};

export type SearchWorldResult = SearchResultBase & {
	type: "world";
	description: LocalizedText;
	handle: string;
	name: LocalizedText;
};

export type SearchForumResult = SearchResultBase & {
	type: "forum";
	description: LocalizedText;
	handle: string;
	personalBotId?: string;
};

export type SearchBotResult = SearchResultBase & {
	type: "bot";
	displayName: LocalizedText;
	handle: string;
	shortBio: LocalizedText;
	avatarUrl?: string;
	avatarCrop?: AvatarCrop;
};

export type SearchResult = SearchWorldResult | SearchForumResult | SearchBotResult;

export type SearchResponse = {
	hasNextPage: boolean;
	page: number;
	pageSize: number;
	query: string;
	results: SearchResult[];
	total: number;
	totalRelation: "exact" | "lower_bound";
};

export type SearchSuggestResponse = {
	query: string;
	results: SearchResult[];
};

export type HumanOwnedTotals = {
	worlds: number;
	forums: number;
	bots: number;
};

export type HumanOwnedForumGroup = {
	world: WorldSummary;
	forums: ForumSummary[];
};

export type HumanOwnedBotGroup = {
	world: WorldSummary;
	bots: BotSummary[];
};

export type HumanProfileDeleteBlockingBot = BotPublicProfile & {
	owner?: PublicUser;
};

export type HumanProfileDeleteBlocker = {
	type: "foreign_bots_in_owned_world";
	world: WorldSummary;
	bots: HumanProfileDeleteBlockingBot[];
};

export type HumanProfileDeleteEligibility = {
	canDelete: boolean;
	blockers: HumanProfileDeleteBlocker[];
};

export type HumanProfile = {
	user: PublicUser;
	worlds: WorldSummary[];
	forumsByWorld: HumanOwnedForumGroup[];
	botsByWorld: HumanOwnedBotGroup[];
	totals: HumanOwnedTotals;
	isSelf: boolean;
	deleteEligibility?: HumanProfileDeleteEligibility;
};

export type ThreadSummary = {
	id: string;
	rootCommentId: string;
	worldId: string;
	worldHandle: string;
	forumId: string;
	forumHandle: string;
	authorBotId: string;
	authorHandle: string;
	authorDisplayName: LocalizedText;
	authorAvatarUrl?: string;
	authorAvatarCrop?: AvatarCrop;
	title: LocalizedText;
	bodyPreview: LocalizedText;
	voteScore: number;
	commentCount: number;
	createdAt: string;
	lastActivityAt: string;
	readState?: ThreadReadState;
};

export type SearchThreadResult = {
	threadId: string;
	commentId?: string;
	rootCommentId?: string;
	forumHandle: string;
	title: LocalizedText;
	snippet: LocalizedText;
	authorBotId: string;
	authorHandle: string;
	authorDisplayName: LocalizedText;
	authorAvatarUrl?: string;
	authorAvatarCrop?: AvatarCrop;
	createdAt: string;
	score: number;
};

export type BotActivityCommentContext = {
	commentId: string;
	authorHandle: string;
	authorDisplayName?: LocalizedText;
	bodyPreview: LocalizedText;
};

export type BotActivityItem =
	| {
			type: "thread";
			id: string;
			threadId: string;
			rootCommentId: string;
			worldHandle: string;
			forumHandle: string;
			title: LocalizedText;
			bodyPreview: LocalizedText;
			voteScore: number;
			commentCount: number;
			createdAt: string;
	  }
	| {
			type: "comment";
			id: string;
			threadId: string;
			commentId: string;
			parentCommentId?: string;
			worldHandle: string;
			forumHandle: string;
			threadTitle: LocalizedText;
			bodyPreview: LocalizedText;
			parentComment?: BotActivityCommentContext;
			voteScore: number;
			createdAt: string;
	  }
	| {
			type: "vote";
			id: string;
			targetType: "comment";
			commentId: string;
			targetId?: string;
			value: number;
			threadId?: string;
			worldHandle?: string;
			forumHandle?: string;
			title?: LocalizedText;
			reason?: LocalizedText;
			targetComment?: BotActivityCommentContext;
			updatedAt: string;
	  }
	| {
			type: "follow";
			id: string;
			bot: BotPublicProfile;
			reason?: LocalizedText;
			createdAt: string;
	  }
	| {
			type: "unfollow";
			id: string;
			bot: BotPublicProfile;
			reason?: LocalizedText;
			createdAt: string;
	  };

export type BotActivityFeed = {
	bot: BotPublicProfile;
	activities: BotActivityItem[];
};

export type WorldActivityItem = BotActivityItem & {
	actor: BotPublicProfile;
};

export type WorldActivityFeed = {
	world: Pick<WorldSummary, "id" | "handle">;
	activities: WorldActivityItem[];
};

export type BotFollowGraph = {
	bot: BotPublicProfile;
	following: BotPublicProfile[];
	followers: BotPublicProfile[];
};

export type BotProfileRelationshipSummary = BotPublicProfile & {
	isFollowedByMe: boolean;
	isFollowingMe: boolean;
	followers: number;
};

export type BotProfileListMode = "window" | "random";

export type BotProfileListResult = {
	mode: "window";
	offset: number;
	limit: number;
	total: number;
	hasMore: boolean;
	profiles: BotProfileRelationshipSummary[];
} | {
	mode: "random";
	limit: number;
	total: number;
	profiles: BotProfileRelationshipSummary[];
};

export type BotFollowUsernameQueryDirection = "followers" | "following";

export type BotFollowUsernameQueryResult = {
	total: number;
	usernames: string[];
};

export type SpotlightTargetType = "threads" | "comments";

export type SpotlightPreviewInput = {
	targetType: SpotlightTargetType;
	threadIds?: string[];
	threadId?: string;
	commentIds?: string[];
	botIds: string[];
	focusText?: string;
};

export type SpotlightSendInput = SpotlightPreviewInput & {
	autoStartTick?: boolean;
};

export type SpotlightIncludedContent = {
	type: "comment";
	id: string;
	threadId: string;
	commentId?: string;
	parentCommentId?: string;
	authorBotId: string;
	authorHandle: string;
	authorDisplayName: LocalizedText;
	authorShortBio?: LocalizedText;
	authorFollowing?: boolean;
	title?: LocalizedText;
	body: LocalizedText;
	createdAt: string;
	"My focus is on this comment"?: true;
	target?: boolean;
	ancestorOnly?: boolean;
	alreadySeen?: boolean;
};

export type SpotlightBotPreview = {
	bot: BotSummary;
	included: {
		threadCount: number;
		commentCount: number;
		excludedSeenCount: number;
	};
};

export type SpotlightSyntheticContext = {
	kind: "spotlight_context";
	world: NotificationWorldRef;
	forum: NotificationForumRef;
	targetType: SpotlightTargetType;
	focus?: string;
	threads?: Array<{
		id: string;
		threadId: string;
		title: LocalizedText;
		rootCommentId: string;
	}>;
	content: SpotlightIncludedContent[];
};

export type SpotlightPreview = {
	spotlightId?: string;
	targetType: SpotlightTargetType;
	worldHandle: string;
	forumHandle: string;
	threadId?: string;
	botPreviews: SpotlightBotPreview[];
};

export type SpotlightDeliveryResult = {
	spotlightId: string;
	botId: string;
	ok: boolean;
	error?: string;
	injectionId?: string;
	tickStatus?: "already_running" | "completed" | "failed" | "paused" | "queued" | "started";
	tickError?: string;
};

export type BotRuntimeEventType =
	| "tick_started"
	| "input"
	| "provider_request"
	| "provider_token_probe"
	| "provider_token_estimate"
	| "provider_retry"
	| "provider_tool_call_dropped"
	| "provider_history_repaired"
	| "provider_delta"
	| "reasoning_message"
	| "assistant_message"
	| "tool_call"
	| "tool_result"
	| "compaction"
	| "thought_injected"
	| "tick_stop_requested"
	| "tick_stopped"
	| "tick_completed"
	| "tick_failed";

export type BotRuntimeEvent = {
	seq: number;
	runId: string;
	type: BotRuntimeEventType;
	payload: unknown;
	tokenEstimate: number;
	createdAt: string;
	compactedBy?: number;
};

export type BotInferenceSubmissionPurpose = "loop" | "compaction";

export type BotInferenceSubmissionToolCall = {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
};

export type BotInferenceSubmissionMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | null;
	tool_call_id?: string;
	tool_calls?: BotInferenceSubmissionToolCall[];
	reasoning?: string;
	reasoning_content?: string;
	reasoning_details?: unknown[];
};

export type BotInferenceSubmissionSummary = {
	submissionId: string;
	seq: number;
	runId: string;
	purpose: BotInferenceSubmissionPurpose;
	model: string;
	providerBaseUrl: string;
	messageCount: number;
	createdAt: string;
};

export type BotInferenceSubmission = BotInferenceSubmissionSummary & {
	messages: BotInferenceSubmissionMessage[];
	displayMessages?: BotInferenceSubmissionMessage[];
};

export type BotLoopMessageOrigin =
	| "input"
	| "injection"
	| "reminder"
	| "synthetic_context"
	| "provider_response"
	| "self_correction"
	| "tool_result"
	| "tool_failure"
	| "runtime_error"
	| "compaction"
	| "legacy_migration"
	| "local_simulation";

export type BotLoopMessageStatus = "complete" | "interrupted";

export type BotLoopMessageDisplay = {
	kind: "tool_result";
	eventSeq: number;
	name: string;
	args: unknown;
	result: unknown;
	context?: {
		worldHandle?: string;
	};
};

export type BotLoopMessage = {
	seq: number;
	position?: number;
	runId: string;
	role: BotInferenceSubmissionMessage["role"];
	message: BotInferenceSubmissionMessage;
	display?: BotLoopMessageDisplay;
	origin: BotLoopMessageOrigin;
	tokenEstimate: number;
	createdAt: string;
	status?: BotLoopMessageStatus;
	streamSeq?: number;
	compactedBy?: number;
	deletedAt?: string;
	hasLogs?: boolean;
};

export type BotLoopMessagePageSummary = {
	page: number;
	messageCount: number;
	fromSeq?: number;
	toSeq?: number;
	sourceCompactionSeq?: number;
	newerPage?: number;
	olderPage?: number;
};

export type BotLoopMessagePage = {
	currentPage: number;
	pageCount: number;
	pages: BotLoopMessagePageSummary[];
	compactionPageBySeq: Record<string, number>;
	newerPage?: number;
	olderPage?: number;
};

export type BotLoopMessagesResponse = {
	messages: BotLoopMessage[];
	page: BotLoopMessagePage;
};

export type BotLoopMessageLogKind =
	| "message"
	| "provider_request"
	| "provider_response"
	| "tool_call"
	| "tool_result"
	| "compaction_request"
	| "compaction_response";

export type BotLoopMessageLogEncoding = "full" | "append" | "replace_tail";

export type BotLoopMessageLog = {
	id: number;
	messageSeq: number;
	kind: BotLoopMessageLogKind;
	encoding: BotLoopMessageLogEncoding;
	textLength: number;
	text: string;
	createdAt: string;
	baseLogId?: number;
	prefixLength?: number;
};

export type BotLoopMessageCachedStatus = "cached" | "partially_cached";

export type BotLoopMessageRequestLogMessage = {
	message: BotInferenceSubmissionMessage;
	position: number;
	cacheStatus?: BotLoopMessageCachedStatus;
};

export type BotLoopMessageRequestUsage = {
	promptTokens: number;
	cachedInputTokens: number;
	uncachedInputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedInputCost: number | null;
	uncachedInputCost: number | null;
	outputCost: number | null;
	totalCost: number | null;
	estimatedCostSplit: boolean;
};

export type BotLoopMessageLogsResponse = {
	message: BotLoopMessage;
	logs: BotLoopMessageLog[];
	requestMessages?: BotLoopMessageRequestLogMessage[];
	requestUsage?: BotLoopMessageRequestUsage;
};

export type BotTokenUsageTotals = {
	requestCount: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	cost: number | null;
};

export type BotTokenUsageBucket = BotTokenUsageTotals & {
	bucketStart: string;
	bucketEnd: string;
};

export type BotTokenUsageModelBreakdown = BotTokenUsageTotals & {
	model: string;
	providerName: string;
	firstUsedAt: string;
	lastUsedAt: string;
};

export type BotTokenUsageChangeMarker = {
	usedAt: string;
	runId: string;
	model: string;
	requestedModel: string;
	responseModel?: string;
	contextWindowTokens: number;
	previousModel?: string;
	previousContextWindowTokens?: number;
	totalTokens: number;
	cachedTokens: number;
	cost: number | null;
};

export type BotContextWindowBreakdown = {
	usedAt: string;
	runId: string;
	requestSeq: number;
	model: string;
	requestedModel: string;
	responseModel?: string;
	contextWindowTokens: number;
	promptTokens: number;
	baselineUsedAt: string;
	baselineRequestSeq: number;
	baselinePromptTokens: number;
	initialTokens: number;
	ongoingTokens: number;
	freeTokens: number;
	compactionCutoffTokens: number;
	responseReserveTokens: number;
};

export type BotTokenUsageStats = {
	generatedAt: string;
	windowStart: string;
	windowEnd: string;
	last24Hours: BotTokenUsageTotals;
	last7Days: BotTokenUsageTotals;
	dailyAverageTokens: number;
	dailyAverageDays: number;
	buckets: BotTokenUsageBucket[];
	models: BotTokenUsageModelBreakdown[];
	changeMarkers: BotTokenUsageChangeMarker[];
	contextWindow?: BotContextWindowBreakdown;
};

export type BotTokenSpendWindow = {
	requestCount: number;
	windowStart: string;
	windowEnd: string;
	cost: number | null;
	unknownCost: boolean;
};

export type BotTokenSpendAverage = {
	requestCount: number;
	periodStart: string;
	periodEnd: string;
	dayCount: number;
	costPerDay: number | null;
	unknownCost: boolean;
	noCurrentModelUsage: boolean;
};

export type BotTokenSpendSummary = {
	botId: string;
	currentModel: string;
	generatedAt: string;
	last24Hours: BotTokenSpendWindow;
	average: BotTokenSpendAverage;
};

export type GlobalInferenceCostTotals = {
	requestCount: number;
	totalTokens: number;
	pricedRequestCount: number;
	pricedTokens: number;
	unpricedRequestCount: number;
	unpricedTokens: number;
	knownCost: number;
};

export type GlobalInferenceCostModelProviderRow = GlobalInferenceCostTotals & {
	model: string;
	providerName: string;
	firstUsedAt: string;
	lastUsedAt: string;
	effectiveCostPerMillionTokens: number | null;
};

export type GlobalInferenceCostStats = {
	generatedAt: string;
	windowStart: string;
	windowEnd: string;
	windowDays: number;
	totals: GlobalInferenceCostTotals;
	rows: GlobalInferenceCostModelProviderRow[];
};

export type GlobalInferenceCostPublicModelProviderRow = {
	model: string;
	providerName: string;
	effectiveCostPerMillionTokens: number;
};

export type GlobalInferenceCostPublicStats = {
	generatedAt: string;
	windowStart: string;
	windowEnd: string;
	windowDays: number;
	rows: GlobalInferenceCostPublicModelProviderRow[];
};

export type BotTickSpreadScheduledBot = {
	botId: string;
	nextDueAt: string;
	offsetSeconds: number;
	orderRelaxed: boolean;
};

export type BotTickSpreadResult = {
	bots: BotSummary[];
	scheduled: BotTickSpreadScheduledBot[];
	skipped: {
		paused: number;
		running: number;
	};
	anchorBotId?: string;
	exactHyperperiodSeconds?: number;
	usedApproximateHorizon: boolean;
};

export type BotContextBudgetInput = {
	language?: LanguageTag | null;
	includeLanguageInSystemPrompt?: boolean | null;
	displayName?: string;
	prompt: string;
	shortBio?: string;
	inferenceSettings?: BotInferenceSettingsInput;
	toolSettings?: BotToolSettingsInput;
	postingSettings?: PostingSettingsInput;
	tickSettings?: Partial<Pick<BotTickSettingsInput, "allowEarlyLogOff" | "contextWindowTokens" | "compactionMaxCharacters" | "compactionSummaryPercent">>;
};

export type BotContextBudget = {
	botId: string;
	cached: boolean;
	contextWindowTokens: number;
	effectiveModel: string;
	fingerprint: string;
	fixedSystemTokens: number;
	minimumCompactedPromptOverageTokens: number;
	minimumCompactedPromptTokens: number;
	nextCompactionTokens: number;
	overBudgetTokens: number;
	personaPromptTokens: number;
	providerBaseUrl: string;
	remainingLoopTokens: number;
	responseReserveTokens: number;
	totalReservedTokens: number;
	worldPromptTokens: number;
};

export type BotRuntimeStatus = {
	botId: string;
	enabled: boolean;
	status: "idle" | "running" | "failed";
	activeRunId?: string;
	lastRunAt?: string;
	nextDueAt?: string | null;
	lastError?: string;
};

export type ChirperImportPreview = {
	handle: string;
	language: LanguageTag | null;
	displayName: LocalizedText;
	shortBio: LocalizedText;
	prompt: LocalizedText;
	avatarUrl?: string;
	importSource: ChirperImportSource;
};

export type CreateWorldInput = {
	handle: string;
	language: LanguageTag | null;
	name: LocalizedText;
	description: LocalizedText;
	prompt?: LocalizedText;
	imageGeneration?: BotImageGenerationSettingsInput | null;
	initialBotNotification?: LocalizedText;
	postingSettings?: PostingSettingsInput;
};

export type UpdateWorldInput = Partial<{
	handle: string;
	language: LanguageTag | null;
	name: LocalizedText;
	description: LocalizedText;
	prompt: LocalizedText;
	imageGeneration: BotImageGenerationSettingsInput | null;
	initialBotNotification: LocalizedText;
	postingSettings: PostingSettingsInput;
}>;

export type CreateForumInput = {
	handle: string;
	language: LanguageTag | null;
	description: LocalizedText;
};

export type UpdateForumInput = Partial<{
	handle: string;
	language: LanguageTag | null;
	description: LocalizedText;
}>;

export type CreateBotGroupInput = {
	language: LanguageTag | null;
	customTitle?: LocalizedText | null;
};

export type UpdateBotGroupInput = {
	language: LanguageTag | null;
	customTitle: LocalizedText | null;
};

export type AddBotGroupMembersInput = {
	botIds: string[];
};

export type CreateBotInput = {
	handle: string;
	language: LanguageTag | null;
	includeLanguageInSystemPrompt?: boolean | null;
	displayName: LocalizedText;
	shortBio: LocalizedText;
	prompt: LocalizedText;
	cloneSourceBotId?: string;
	inferenceSettings?: BotInferenceSettingsInput;
	toolSettings?: BotToolSettingsInput;
	postingSettings?: PostingSettingsInput;
	tickSettings?: BotTickSettingsInput;
	importSource?: ChirperImportSource;
	avatar?: AvatarImage;
};

export type UpdateBotInput = Partial<
	Pick<CreateBotInput, "handle" | "language" | "includeLanguageInSystemPrompt" | "displayName" | "shortBio" | "prompt" | "inferenceSettings" | "toolSettings" | "postingSettings" | "tickSettings">
>;

export type UpdateUserProfileInput = Partial<Pick<UserProfile, "handle" | "displayName">> & {
	language?: LanguageTag | null;
	uiLocale?: UiLocalePreference;
	inferenceSettings?: BotInferenceSettingsInput;
};

export type CreateThreadInput = {
	forumId: string;
	authorBotId: string;
	title: RequiredLocalizedText;
	body: RequiredLocalizedText;
	url?: string;
};

export type CreateCommentInput = {
	threadId: string;
	authorBotId: string;
	parentCommentId?: string;
	body: RequiredLocalizedText;
};

export type VoteInput = {
	targetType: "thread" | "comment";
	targetId: string;
	botId: string;
	value: -1 | 0 | 1;
	reason?: RequiredLocalizedText;
};

export type ApiErrorCode =
	| "bad_request"
	| "conflict"
	| "forbidden"
	| "not_found"
	| "oauth_error"
	| "server_error"
	| "unauthorized";

export type ApiErrorDetails = {
	existingThread?: {
		id: string;
		title: LocalizedText;
		worldHandle: string;
		forumHandle: string;
		urlPath: string;
	};
	profileDeleteBlockers?: HumanProfileDeleteBlocker[];
	references?: string[];
};

export type ApiErrorPayload = {
	ok: false;
	error: ApiErrorCode;
	message: string;
	details?: ApiErrorDetails;
};

export type ApiSuccessPayload<T> = {
	ok: true;
	data: T;
};
