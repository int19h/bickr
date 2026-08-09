import type {
	AuthProvider,
	AvatarCrop,
	AvatarImage,
	BotCloneSourceSummary,
	BotEffectivePostingSettings,
	BotEffectiveTickSettings,
	BotImageGenerationSettings,
	BotImageGenerationSettingsInput,
	BotInferenceSettings,
	BotInferenceSettingsInput,
	BotLocalOverrides,
	BotTickSettings,
	BotTickSettingsInput,
	BotToolSettings,
	BotToolSettingsInput,
	ChirperImportSource,
	LanguageTag,
	LocalizedText,
	NotificationForumRef,
	NotificationWorldRef,
	PostingSettings,
	PostingSettingsInput,
	ThreadLock,
	ThreadSettings,
	ThreadSettingsInput,
	RequiredLocalizedText,
	ThreadReadState,
	UiLocalePreference,
} from "./entities";

// Caller-facing settings expose only whether a credential is configured. Write
// payloads use BotInferenceSettingsInput and stored documents use BotInferenceSettings.
export type PublicBotInferenceSettings = Omit<BotInferenceSettings, "openRouterApiKey"> & {
	openRouterApiKey?: never;
};

export type PublicBotLocalOverrides = Omit<BotLocalOverrides, "inferenceSettings"> & {
	inferenceSettings: PublicBotInferenceSettings;
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
	inferenceSettings: PublicBotInferenceSettings;
	translationInference?: TranslationInferenceAnnotation;
	createdAt: string;
	updatedAt: string;
};

export type TranslationInferenceAnnotation =
	| { enabled: false }
	| {
			enabled: true;
			migrationPending?: false;
			configurationId: string;
			displayName: "Translation";
			pointerRevision: number;
			effectiveModel: string;
			effectiveRevisionFingerprint: string;
			credentialAvailable: boolean;
	  }
	| {
			enabled: true;
			migrationPending: true;
			sourceConfigurationId: string;
			pointerRevision: number;
			effectiveModel: string;
			effectiveRevisionFingerprint: string;
			credentialAvailable: boolean;
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
	recurringPromptEnabled: boolean;
	recurringPrompt: LocalizedText;
	avatar?: AvatarImage;
	avatarUrl?: string;
	avatarCrop?: AvatarCrop;
	imageGeneration?: BotImageGenerationSettings;
	initialBotNotification: LocalizedText;
	postingSettings?: PostingSettings;
	threadSettings?: ThreadSettings;
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
	threadSettings?: ThreadSettings;
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
	inferenceSettings: PublicBotInferenceSettings;
	toolSettings?: BotToolSettings;
	postingSettings: PostingSettings;
	effectivePostingSettings: BotEffectivePostingSettings;
	tickSettings: BotTickSettings;
	effectiveTickSettings: BotEffectiveTickSettings;
	importSource?: ChirperImportSource;
	cloneSource?: BotCloneSourceSummary;
	localOverrides?: PublicBotLocalOverrides;
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

export type AccountDeletionResult =
	| {
			kind: "account_delete_pending";
			planned: HumanOwnedTotals;
	  }
	| {
			kind: "account_delete_complete";
			profile: PublicUser;
			deleted: HumanOwnedTotals;
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
	lock?: ThreadLock;
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
	focused?: true;
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
	recurringPromptEnabled?: boolean;
	recurringPrompt?: LocalizedText;
	imageGeneration?: BotImageGenerationSettingsInput | null;
	initialBotNotification?: LocalizedText;
	postingSettings?: PostingSettingsInput;
	threadSettings?: ThreadSettingsInput;
};

export type UpdateWorldInput = Partial<{
	handle: string;
	language: LanguageTag | null;
	name: LocalizedText;
	description: LocalizedText;
	prompt: LocalizedText;
	recurringPromptEnabled: boolean;
	recurringPrompt: LocalizedText;
	imageGeneration: BotImageGenerationSettingsInput | null;
	initialBotNotification: LocalizedText;
	postingSettings: PostingSettingsInput;
	threadSettings: ThreadSettingsInput;
}>;

export type CreateForumInput = {
	handle: string;
	language: LanguageTag | null;
	description: LocalizedText;
	threadSettings?: ThreadSettingsInput;
};

export type UpdateForumInput = Partial<{
	handle: string;
	language: LanguageTag | null;
	description: LocalizedText;
	threadSettings: ThreadSettingsInput;
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
	/**
	 * Typed inference-graph conflict cause. Owner clients branch on this instead
	 * of the human-facing message, which is composed per call site.
	 */
	inferenceGraphCause?: InferenceGraphErrorCause;
	profileDeleteBlockers?: HumanProfileDeleteBlocker[];
	references?: string[];
};

/**
 * Typed inference-graph failure causes. They are attached at the throw site and
 * echoed in owner error details; no consumer may branch on message text.
 */
export type InferenceGraphConflictCause =
	| "stale_revision"
	| "duplicate_name"
	| "quota_exceeded"
	| "self_parent"
	| "descendant_parent"
	| "cross_owner"
	| "invalid_parent"
	| "fixed_entry_requires_lifecycle"
	| "account_default_required"
	| "unexpected_unique_conflict";

export type InferenceGraphErrorCause = InferenceGraphConflictCause | "corrupt_graph";

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
