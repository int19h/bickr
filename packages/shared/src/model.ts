export const schemaVersion = 1;
export const indexVersion = 1;

export type EntityType =
	| "user"
	| "providerIdentity"
	| "session"
	| "world"
	| "forum"
	| "bot"
	| "thread"
	| "notification";

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
};

export type ProviderIdentityDocument = EntityDocument & {
	type: "providerIdentity";
	provider: "github";
	providerSubject: string;
	userId: string;
	providerLogin: string;
	email?: string;
	avatarUrl?: string;
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
	tickSettings: BotTickSettings;
	importSource?: ChirperImportSource;
};

export type BotInferenceSettings = {
	openRouterApiKey?: string;
	openRouterApiKeySet?: boolean;
	baseUrl?: string;
	model?: string;
	temperature?: number;
	topK?: number;
	topP?: number;
	minP?: number;
};

export type BotInferenceSettingsInput = {
	openRouterApiKey?: string | null;
	baseUrl?: string | null;
	model?: string | null;
	temperature?: number | null;
	topK?: number | null;
	topP?: number | null;
	minP?: number | null;
};

export type BotTickSettings = {
	enabled: boolean;
	intervalSeconds: number;
	contextWindowTokens: number;
	compactionThreshold: number;
	maxToolCallsPerTick: number;
};

export type PostDocument = {
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
	rootPost: PostDocument;
	comments: CommentDocument[];
	commentCount: number;
	voteScore: number;
	recentCommentCount: number;
	hotScore: number;
	lastActivityAt: string;
	readState?: ThreadReadState;
};

export type NotificationType =
	| "bootstrap"
	| "reply"
	| "mention"
	| "personal_forum_post"
	| "follow"
	| "vote"
	| "interest"
	| "system";

export type NotificationStatus = "pending" | "delivered_to_loop" | "read_or_consumed" | "archived";

export type NotificationDocument = EntityDocument & {
	type: "notification";
	worldId: string;
	botId: string;
	notificationType: NotificationType;
	status: NotificationStatus;
	sourceObjectId?: string;
	message: string;
	deliveredAt?: string;
	readAt?: string;
};

export type PublicUser = {
	id: string;
	handle: string;
	displayName: string;
	avatarUrl?: string;
};

export type UserProfile = PublicUser & {
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
	| "spotlight_action"
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
	unreadCount: number;
	notifications: HumanNotification[];
};

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
	handle: string;
	displayName: string;
	shortBio: string;
	prompt: string;
	inferenceSettings: BotInferenceSettings;
	tickSettings: BotTickSettings;
	importSource?: ChirperImportSource;
	lastActiveAt?: string;
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

export type ThreadSummary = {
	id: string;
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

export type SearchPostResult = {
	threadId: string;
	commentId?: string;
	forumHandle: string;
	title: string;
	snippet: string;
	authorBotId: string;
	authorHandle: string;
	createdAt: string;
	score: number;
};

export type BotActivityItem =
	| {
			type: "post";
			id: string;
			threadId: string;
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
			voteScore: number;
			createdAt: string;
	  }
	| {
			type: "vote";
			id: string;
			targetType: "thread" | "comment";
			targetId: string;
			value: number;
			threadId?: string;
			commentId?: string;
			worldHandle?: string;
			forumHandle?: string;
			title?: string;
			updatedAt: string;
	  }
	| {
			type: "follow";
			id: string;
			bot: BotPublicProfile;
			createdAt: string;
	  };

export type BotActivityFeed = {
	bot: BotPublicProfile;
	activities: BotActivityItem[];
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

export type SpotlightSendInput = SpotlightPreviewInput;

export type SpotlightIncludedContent = {
	type: "thread" | "comment";
	id: string;
	threadId: string;
	parentCommentId?: string;
	authorHandle: string;
	authorDisplayName: string;
	title?: string;
	body: string;
	createdAt: string;
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
	content: SpotlightIncludedContent[];
	injectedText: string;
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
	tickStatus?: "already_running" | "completed" | "failed" | "started";
	tickError?: string;
};

export type BotRuntimeEventType =
	| "tick_started"
	| "input"
	| "provider_request"
	| "provider_retry"
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

export type BotRuntimeStatus = {
	botId: string;
	status: "idle" | "running" | "failed";
	activeRunId?: string;
	lastRunAt?: string;
	nextDueAt?: string;
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

export type CreateForumInput = {
	handle: string;
	description: string;
};

export type CreateBotInput = {
	handle: string;
	displayName: string;
	shortBio: string;
	prompt: string;
	inferenceSettings?: BotInferenceSettingsInput;
	tickSettings?: Partial<BotTickSettings>;
	importSource?: ChirperImportSource;
};

export type UpdateBotInput = Partial<
	Pick<CreateBotInput, "displayName" | "shortBio" | "prompt" | "inferenceSettings" | "tickSettings">
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
};

export type ApiErrorCode =
	| "bad_request"
	| "conflict"
	| "forbidden"
	| "not_found"
	| "oauth_error"
	| "server_error"
	| "unauthorized";

export type ApiErrorPayload = {
	ok: false;
	error: ApiErrorCode;
	message: string;
};

export type ApiSuccessPayload<T> = {
	ok: true;
	data: T;
};
