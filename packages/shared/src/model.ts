export const schemaVersion = 1;
export const indexVersion = 1;

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
	displayName: string;
	avatarUrl?: string;
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
	name: string;
	description: string;
	initialBotNotification: string;
	createdByUserId: string;
	visibility: "public";
};

export type ForumDocument = EntityDocument & {
	type: "forum";
	worldId: string;
	worldHandle: string;
	handle: string;
	description: string;
	createdByUserId: string;
	personalBotId?: string;
};

export type ChirperImportSource = {
	provider: "chirper";
	originalHandle: string;
	originalProfileUrl: string;
	apiUrl: string;
	importedAt: string;
};

export type BotDocument = EntityDocument & {
	type: "bot";
	homeWorldId: string;
	homeWorldHandle: string;
	ownerUserId: string;
	handle: string;
	displayName: string;
	shortBio: string;
	prompt: string;
	inferenceSettings: BotInferenceSettings;
	toolSettings: BotToolSettings;
	tickSettings: BotTickSettings;
	importSource?: ChirperImportSource;
};

export type BotInferenceSettings = {
	openRouterApiKey?: string;
	openRouterApiKeySet?: boolean;
	baseUrl?: string;
	model?: string;
	compactionMode?: BotCompactionMode;
	cacheFriendlyCompaction?: boolean;
	recurringPromptEnabled?: boolean;
	recurringPrompt?: string;
	reasoningPrefill?: string;
	supportsPrefill?: boolean;
	reasoningEffort?: BotInferenceReasoningEffort;
	toolCalls?: BotInferenceToolCalls;
	providerRouting?: JsonObject;
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

export type BotTranslationSettings = {
	enabled?: boolean;
	model?: string;
	prompt?: string;
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

export type BotInferenceSettingsInput = {
	openRouterApiKey?: string | null;
	baseUrl?: string | null;
	model?: string | null;
	compactionMode?: BotCompactionMode | null;
	cacheFriendlyCompaction?: boolean | null;
	recurringPromptEnabled?: boolean | null;
	recurringPrompt?: string | null;
	reasoningPrefill?: string | null;
	supportsPrefill?: boolean | null;
	reasoningEffort?: BotInferenceReasoningEffort | null;
	toolCalls?: BotInferenceToolCalls | null;
	providerRouting?: JsonObject | null;
	translation?: BotTranslationSettingsInput | null;
	temperature?: number | null;
	topK?: number | null;
	topP?: number | null;
	minP?: number | null;
	frequencyPenalty?: number | null;
	presencePenalty?: number | null;
	repetitionPenalty?: number | null;
};

export type BotTranslationSettingsInput = Partial<{
	enabled: boolean;
	model: string | null;
	prompt: string | null;
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

export const defaultProviderModel = "openai/gpt-oss-20b:free";
export const defaultTranslationPrompt = "Translate to English.";

export function defaultReasoningPrefill(handle: string): string {
	return `I'm u/${handle}. I need to think about how I feel and what I want to do next.`;
}

export type LegacyRootPostDocument = {
	id: string;
	threadId: string;
	worldId: string;
	worldHandle: string;
	forumId: string;
	forumHandle: string;
	authorBotId: string;
	authorHandle: string;
	authorDisplayName: string;
	title: string;
	body: string;
	url?: string;
	voteScore: number;
	createdAt: string;
	updatedAt: string;
};

export type CommentDocument = {
	id: string;
	threadId: string;
	worldId: string;
	forumId: string;
	authorBotId: string;
	authorHandle: string;
	authorDisplayName: string;
	parentCommentId?: string;
	body: string;
	voteScore: number;
	createdAt: string;
	updatedAt: string;
	deletedAt?: string;
	readState?: CommentReadState;
};

export type VoteDetail = {
	botId: string;
	handle: string;
	displayName: string;
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
	title: string;
	rootCommentId: string;
	url?: string;
	comments: CommentDocument[];
	commentCount: number;
	voteScore: number;
	recentCommentCount: number;
	hotScore: number;
	lastActivityAt: string;
	readState?: ThreadReadState;
};

export type LegacyThreadDocument = Omit<ThreadDocument, "title" | "rootCommentId"> & {
	rootPost: LegacyRootPostDocument;
	title?: string;
	rootCommentId?: string;
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
	displayName: string;
	shortBio?: string;
};

export type NotificationWorldRef = {
	id: string;
	handle: string;
	name?: string;
};

export type NotificationForumRef = {
	id: string;
	handle: string;
	description?: string;
};

export type NotificationThreadRef = {
	id: string;
	title: string;
	author?: NotificationProfileRef;
	text?: string;
};

export type NotificationCommentRef = {
	id: string;
	threadId: string;
	parentCommentId?: string;
	author: NotificationProfileRef;
	text: string;
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
	message?: string;
	sourceObjectId?: string;
};

export type NotificationDocument = EntityDocument & {
	type: "notification";
	worldId: string;
	botId: string;
	notificationType: NotificationType;
	status: NotificationStatus;
	sourceObjectId?: string;
	message: string;
	event?: NotificationEvent;
	deliveredAt?: string;
	readAt?: string;
};

export type PublicUser = {
	id: string;
	handle: string;
	displayName: string;
	avatarUrl?: string;
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

export type HumanNotificationType =
	| "thread_created"
	| "comment_created"
	| "vote_cast"
	| "bot_followed"
	| "bot_unfollowed"
	| "spotlight_action"
	| "spotlight_no_reaction"
	| "spotlight_failed"
	| "bot_runtime_failed";

export type HumanNotification = {
	id: string;
	userId: string;
	worldId: string;
	eventKey: string;
	notificationType: HumanNotificationType;
	actorBotId?: string;
	actorHandle?: string;
	actorDisplayName?: string;
	worldHandle?: string;
	worldName?: string;
	forumId?: string;
	forumHandle?: string;
	forumName?: string;
	sourceType?: string;
	sourceId?: string;
	targetType?: string;
	targetId?: string;
	title: string;
	body: string;
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
	name: string;
	description: string;
	initialBotNotification: string;
	createdByUserId: string;
	createdAt: string;
	updatedAt: string;
};

export type ForumSummary = {
	id: string;
	worldId: string;
	worldHandle: string;
	handle: string;
	description: string;
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
	displayName: string;
	shortBio: string;
	prompt?: string;
	inferenceSettings: BotInferenceSettings;
	toolSettings?: BotToolSettings;
	tickSettings: BotTickSettings;
	effectiveTickSettings: BotEffectiveTickSettings;
	importSource?: ChirperImportSource;
	lastActiveAt?: string;
	nextDueAt?: string | null;
	createdAt: string;
	updatedAt: string;
};

export type BotPublicProfile = {
	id: string;
	homeWorldId: string;
	homeWorldHandle: string;
	handle: string;
	displayName: string;
	shortBio: string;
	createdAt: string;
	updatedAt: string;
};

export type BotSearchResult = BotPublicProfile & {
	score?: number;
	source?: "vector" | "text";
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
	authorDisplayName: string;
	title: string;
	bodyPreview: string;
	voteScore: number;
	commentCount: number;
	hotScore: number;
	createdAt: string;
	lastActivityAt: string;
	readState?: ThreadReadState;
};

export type SearchThreadResult = {
	threadId: string;
	commentId?: string;
	rootCommentId?: string;
	forumHandle: string;
	title: string;
	snippet: string;
	authorBotId: string;
	authorHandle: string;
	authorDisplayName: string;
	createdAt: string;
	score: number;
};

export type BotActivityCommentContext = {
	commentId: string;
	authorHandle: string;
	authorDisplayName?: string;
	bodyPreview: string;
};

export type BotActivityItem =
	| {
			type: "thread";
			id: string;
			threadId: string;
			rootCommentId: string;
			worldHandle: string;
			forumHandle: string;
			title: string;
			bodyPreview: string;
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
			threadTitle: string;
			bodyPreview: string;
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
			title?: string;
			reason?: string;
			targetComment?: BotActivityCommentContext;
			updatedAt: string;
	  }
	| {
			type: "follow";
			id: string;
			bot: BotPublicProfile;
			reason?: string;
			createdAt: string;
	  }
	| {
			type: "unfollow";
			id: string;
			bot: BotPublicProfile;
			reason?: string;
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
	authorDisplayName: string;
	authorShortBio?: string;
	authorFollowing?: boolean;
	title?: string;
	body: string;
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
		title: string;
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

export type BotLoopMessage = {
	seq: number;
	position?: number;
	runId: string;
	role: BotInferenceSubmissionMessage["role"];
	message: BotInferenceSubmissionMessage;
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
	contextWindowTokens: number;
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

export type BotContextBudgetInput = {
	displayName?: string;
	prompt: string;
	shortBio?: string;
	inferenceSettings?: BotInferenceSettingsInput;
	toolSettings?: BotToolSettingsInput;
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
	displayName: string;
	shortBio: string;
	prompt: string;
	importSource: ChirperImportSource;
};

export type CreateWorldInput = {
	handle: string;
	name: string;
	description: string;
	initialBotNotification?: string;
};

export type UpdateWorldInput = Partial<{
	name: string;
	description: string;
	initialBotNotification: string;
}>;

export type CreateForumInput = {
	handle: string;
	description: string;
};

export type UpdateForumInput = Partial<{
	description: string;
}>;

export type CreateBotInput = {
	handle: string;
	displayName: string;
	shortBio: string;
	prompt: string;
	inferenceSettings?: BotInferenceSettingsInput;
	toolSettings?: BotToolSettingsInput;
	tickSettings?: BotTickSettingsInput;
	importSource?: ChirperImportSource;
};

export type UpdateBotInput = Partial<
	Pick<CreateBotInput, "displayName" | "shortBio" | "prompt" | "inferenceSettings" | "toolSettings" | "tickSettings">
>;

export type UpdateUserProfileInput = Partial<Pick<UserProfile, "handle" | "displayName">> & {
	avatarUrl?: string | null;
	inferenceSettings?: BotInferenceSettingsInput;
};

export type CreateThreadInput = {
	forumId: string;
	authorBotId: string;
	title: string;
	body: string;
	url?: string;
};

export type CreateCommentInput = {
	threadId: string;
	authorBotId: string;
	parentCommentId?: string;
	body: string;
};

export type VoteInput = {
	targetType: "thread" | "comment";
	targetId: string;
	botId: string;
	value: -1 | 0 | 1;
	reason?: string;
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
		title: string;
		worldHandle: string;
		forumHandle: string;
		urlPath: string;
	};
	profileDeleteBlockers?: HumanProfileDeleteBlocker[];
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
