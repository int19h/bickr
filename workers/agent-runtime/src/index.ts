import { fail, ok, readJsonBody } from '@bickr/shared/api';
import { worldAvatarMembersPromptUserContent } from '@bickr/shared/avatar-prompts';
import {
	avatarContentTypeFromBytes,
	avatarMaxBytes,
	copyAvatarImage,
	fetchRemoteAvatarBytes,
	isAvatarContentType,
	normalizeAvatarPublicBaseUrl,
	promoteAvatarCandidate,
	storeAvatarImage,
	validateAvatarDataUrl,
	type R2BucketLike,
} from '@bickr/shared/avatar-storage';
import { isCloudflareRateLimitError, retryCloudflareOperation } from '@bickr/shared/cloudflare';
import { isD1UniqueConstraintError } from '@bickr/shared/d1-errors';
import { deleteForum, deleteWorld, updateWorld, updateWorldAvatar } from '@bickr/shared/governance';
import { json } from '@bickr/shared/http';
import { formatCommentRef, formatThreadRef, parseCommentRef, parseObjectRef, parseThreadRef } from '@bickr/shared/ids';
import { internalServiceUrl, isTrustedInternalServiceRequest } from '@bickr/shared/internal-service';
import {
	botById,
	botPublicProfile,
	createBot,
	deleteBot,
	effectiveTickSettings,
	enforceInferenceModelAccess,
	humanProfileDeleteEligibility,
	listOwnedForumsOutsideOwnedWorlds,
	listOwnedWorlds,
	listForums,
	listUserBots,
	listWorldBots,
	mergeInferenceSettings,
	mergeTickSettings,
	mergeToolSettings,
	rawBotById,
	refreshLinkedCloneIndexes,
	relinkBotClone,
	RepositoryError,
	softDeleteUserProfile,
	spreadUserBotTicks,
	unlinkBotClone,
	updateBot,
	updateBotAvatar,
	updateUserAvatar,
	updateUserProfile,
	userById,
	worldByHandle,
} from '@bickr/shared/repository';
import { effectivePostingSettings, mergePostingSettings } from '@bickr/shared/posting';
import {
	boundedSearchPage,
	deleteSearchVector,
	normalizeSearchFilters,
	parseSearchMode,
	parseSearchTypes,
	reindexSearchVectors,
	searchEntitiesSemantic,
	upsertBotSearchVector,
} from '@bickr/shared/search';
import {
	followBot,
	forumByHandle,
	followedBotIdSet,
	botActivityFeedByHandle,
	botProfileRelationshipSummaries,
	botPublicProfilesByHandles,
	buildNotificationForumContext,
	listHotThreads,
	listPendingNotifications,
	listWorldPublicProfiles,
	markBotSeenContent,
	markBotSeenFromResult,
	listThreads,
	markNotificationsDelivered,
	queryBotFollowUsernamesByHandle,
	readThread,
	rootCommentForThread,
	recordBotRuntimeFailureHumanNotification,
	recordSpotlightFailureHumanNotification,
	recordSpotlightNoReactionHumanNotification,
	recordSpotlightToolHumanNotification,
	searchBots,
	searchThreads,
	unfollowBot,
	ensureBootstrapNotification,
	type ForumContextProfileState,
	type ForumContextResult,
	type SeenContentItem,
} from '@bickr/shared/social';
import { type D1DatabaseLike, type KVNamespaceLike, kvKeys, readJson } from '@bickr/shared/storage';
import {
	botInferenceUsageRetentionDays,
	botTokenSpendSummaryFromUsageRows,
	cachedGlobalInferenceCostStats,
	listOwnerBotTokenSpendSummaries,
	pruneBotInferenceUsage,
	publicGlobalInferenceCostStats,
	recordBotInferenceUsageBatch,
	refreshGlobalInferenceCostStatsCacheIfStale,
	type BotInferenceUsageRecord,
} from '@bickr/shared/token-spend';
import {
	InputError,
	normalizeHandle,
	normalizeHandleText,
	parseBotContextBudgetInput,
	parseCreateBotInput,
	parseUpdateBotInput,
	parseUpdateUserProfileInput,
	parseUpdateWorldInput,
	requiredText,
} from '@bickr/shared/validation';
import {
	effectiveCompactionModeForModel,
	effectiveReasoningEffortForModel,
	effectiveContextWindowForModel,
	effectiveStructuredToolCallsForModel,
	effectiveSupportsPrefillForModel,
	effectiveToolCallsForModel,
	modelSupportsPromptCacheControl,
	modelSupportsReasoningNone,
} from '@bickr/shared/openrouter-model-capabilities';
import {
	type ApiErrorPayload,
	type AvatarImage,
	type BotContextBudget,
	type BotContextBudgetInput,
	type BotContextWindowBreakdown,
	defaultReasoningPrefill,
	defaultTranslationPrompt,
	defaultProviderModel,
	defaultTextGenerationTemperature,
	legacyDefaultTextGenerationTemperature,
	type BotInferenceSubmission,
	type BotInferenceSubmissionMessage,
	type BotInferenceSubmissionPurpose,
	type BotInferenceSubmissionSummary,
	type BotInferenceSubmissionToolCall,
	type BotLoopMessage,
	type BotLoopMessageDisplay,
	type BotLoopMessagePageSummary,
	type BotLoopMessagesResponse,
	type BotLoopMessageLog,
	type BotLoopMessageLogEncoding,
	type BotLoopMessageLogKind,
	type BotLoopMessageLogsResponse,
	type BotLoopMessageRequestLogMessage,
	type BotLoopMessageRequestUsage,
	type BotLoopMessageOrigin,
	type BotLoopMessageStatus,
	type BotDocument,
	type BotEffectivePostingSettings,
	type BotInferenceSettings,
	type BotInferenceSettingsInput,
	type BotInferenceReasoningEffort,
	type BotInferenceToolCalls,
	type BotPromptCacheMode,
	type BotCompactionMode,
	type BotFollowUsernameQueryResult,
	type BotProfileListResult,
	type BotProfileRelationshipSummary,
	type BotPublicProfile,
	type BotActivityFeed,
	type CommentDocument,
	type BotRuntimeEvent,
	type BotRuntimeEventType,
	type BotRuntimeStatus,
	type BotSearchResult,
	type BotSummary,
	type BotStructuredToolCalls,
	type BotTokenUsageBucket,
	type BotTokenUsageChangeMarker,
	type BotTokenUsageModelBreakdown,
	type BotTokenUsageStats,
	type BotTokenUsageTotals,
	type BotTokenSpendSummary,
	type JsonObject,
	type LanguageTag,
	type LocalizedText,
	type NotificationDocument,
	type NotificationEvent,
	type RequiredLocalizedText,
	type SearchThreadResult,
		type SpotlightIncludedContent,
		type SpotlightSyntheticContext,
		avatarImageGenerationSettingsWithDefaults,
		worldAvatarImageGenerationSettingsWithDefaults,
	type ThreadDocument,
	type ThreadSummary,
	type UserDocument,
	type WorldDocument,
	localizedTextLang,
	localizedTextString,
} from '@bickr/shared/model';
import {
	isOpenRouterProviderBaseUrl,
	isMetaCompactionToolDefinition,
	metaCompactionToolDefinition,
	metaCompactionToolName,
	mutableToolNames,
	nativeLanguageSystemPromptLine,
	openRouterServerToolSelection,
	providerCompactionSummaryPropertyDescription,
	providerCompactionSummarySchemaDescription,
	providerCompactionSummaryProperty,
	standardPrompt,
	toolDefinitionsForProviderRound,
	type ProviderToolDefinition,
} from './prompt-and-tools';
import {
	providerContextCompletionReserveTokens,
	providerContextPromptReserveTokens,
	providerContextReserveTokens,
} from './provider-requests';

export { defaultReasoningPrefill };

export interface Env {
	BICKR_D1: D1Database;
	BICKR_KV: KVNamespace;
	BOT_RUNTIME: DurableObjectNamespace;
	USER_BOTS: DurableObjectNamespace;
	FORUM_COORDINATOR_SERVICE: Fetcher;
	AI?: Ai;
	BICKR_R2?: R2Bucket;
	BICKR_R2_PUBLIC_BASE_URL?: string;
	BICKR_BOT_VECTORIZE?: Vectorize;
	BICKR_SEARCH_VECTORIZE?: Vectorize;
	OPENROUTER_API_KEY?: string;
	OPENROUTER_BASE_URL?: string;
	OPENROUTER_MODEL?: string;
	BICKR_SIMULATION_MODE?: string;
}

type RuntimeBotDocument = BotDocument & {
	effectivePostingSettings?: BotEffectivePostingSettings;
	worldPrompt?: string;
};

type RuntimeRow = {
	seq: number;
	run_id: string;
	type: BotRuntimeEventType;
	payload_json: string;
	token_estimate: number;
	created_at: string;
	compacted_by: number | null;
};

type CompactionCandidateEstimate = {
	row: LoopMessageRow;
	tokens: number;
};

type CompactionRowSelection = {
	rows: LoopMessageRow[];
	overBudgetFallback: boolean;
};

type CompactionMetrics = {
	allowedPromptTokens?: number;
	compactionMaxCharacters?: number;
	compactionMaxCompletionTokens?: number;
	compactionOverBudgetFallback?: boolean;
	estimatedContextTokens?: number;
	estimatedPromptTokens?: number;
	exactPromptTokens?: number;
	overBudgetTokens?: number;
	threshold?: number;
};

export type TextTokenCalibration = {
	tokensPerCharacter: number;
	sampleCount: number;
};

export type ProviderCompactionSummaryLimits = {
	minLength: number;
	maxLength: number;
	maxCompletionTokens: number;
	compactionInputTokens: number;
	nextCompactionTokens: number;
	compactionRequestOverheadTokens: number;
	anticipatedSummaryTokens: number;
	maxSummaryTokens: number;
	tokensPerCharacter: number;
	compactedCharacterCount: number;
	configuredMaxCharacters: number;
	compactionSummaryPercent: number;
};

type ProviderCompactionValidationLimits = Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'> &
	Partial<Pick<ProviderCompactionSummaryLimits, 'compactedCharacterCount' | 'tokensPerCharacter'>>;

type InferenceSubmissionRow = {
	id: string;
	event_seq: number;
	run_id: string;
	purpose: BotInferenceSubmissionPurpose;
	model: string;
	provider_base_url: string;
	message_count: number;
	messages_json: string;
	display_messages_json: string | null;
	created_at: string;
};

type LoopMessageRow = {
	seq: number;
	position: number;
	run_id: string;
	role: ChatMessage['role'];
	message_json: string;
	origin: BotLoopMessageOrigin;
	status: BotLoopMessageStatus | null;
	token_estimate: number;
	stream_seq: number | null;
	display_event_seq?: number | null;
	display_event_type?: BotRuntimeEventType | null;
	display_event_payload_json?: string | null;
	compacted_by: number | null;
	deleted_at: string | null;
	created_at: string;
	has_logs?: number;
};

type LoopMessagePageDescriptor = {
	page: number;
	sourceCompactionSeq: number | null;
	newerPage?: number;
};

type LoopMessagePageIndex = {
	descriptors: LoopMessagePageDescriptor[];
	compactionPageBySeq: Map<number, number>;
};

type LoopMessageLogRow = {
	id: number;
	message_seq: number;
	kind: BotLoopMessageLogKind;
	encoding: BotLoopMessageLogEncoding;
	base_log_id: number | null;
	prefix_length: number | null;
	text_length: number;
	chunk_count: number;
	created_at: string;
};

type RuntimeFailureLogKind = Extract<
	BotLoopMessageLogKind,
	'provider_request' | 'provider_response' | 'compaction_request' | 'compaction_response'
>;

type RuntimeFailureLog = {
	kind: RuntimeFailureLogKind;
	text: string;
};

type ProviderCompactionResponsePayload = {
	id?: unknown;
	model?: unknown;
	usage?: unknown;
	openrouter_metadata?: unknown;
	choices?: Array<{
		finish_reason?: unknown;
		native_finish_reason?: unknown;
		message?: {
			content?: unknown;
			tool_calls?: BotInferenceSubmissionToolCall[];
		};
	}>;
};

type LoopMessageLogChunkRow = {
	log_id: number;
	chunk_index: number;
	text: string;
};

type ChatMessage = BotInferenceSubmissionMessage;

type ReasoningDetail = Record<string, unknown>;

type ToolCall = BotInferenceSubmissionToolCall;

type ToolResult = {
	name: string;
	result: unknown;
	providerResult: unknown;
	displayEventSeq?: number;
	effectiveArgs?: Record<string, unknown>;
	selfCorrectionMessages?: string[];
	spotlightMutation?: boolean;
	spotlightTickTerminator?: boolean;
};

export type ProviderToolCallRewrite =
	| { kind: 'drop'; toolCallId: string }
	| { kind: 'replace_arguments'; toolCallId: string; arguments: string };

export type ProviderResponseToolCallRewriteResult =
	| { kind: 'unchanged'; message: BotInferenceSubmissionMessage }
	| { kind: 'updated'; message: BotInferenceSubmissionMessage }
	| { kind: 'deleted' };

type VoteToolTarget = {
	commentId: string;
	value: -1 | 0 | 1;
};

type FollowToolTarget = {
	username: string;
	reason: RequiredLocalizedText;
};

type FollowToolHistoryTarget = {
	username: string;
	reason?: string;
};

export type FollowToolSkipReason = 'already_following' | 'not_following' | 'self_follow' | 'profile_not_found';

export type FollowToolTargetSkip = {
	username: string;
	reason: FollowToolSkipReason;
};

export type FollowToolTargetPlan = {
	validProfiles: BotPublicProfile[];
	skipped: FollowToolTargetSkip[];
};

type FollowProfilesToolResult = {
	results: unknown[];
	effectiveTargets: FollowToolTarget[];
	selfCorrectionMessages: string[];
	spotlightMutation: SpotlightMutationScope;
};

type ProviderUsage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	cost: number | null;
	raw: Record<string, unknown>;
};

type ProviderResponse = {
	content: string;
	reasoning: string;
	reasoningDetails: ReasoningDetail[];
	toolCalls: ToolCall[];
	requestBody?: string;
	rawResponse?: string;
	skippedRawResponse?: string;
	usage?: ProviderUsage;
	responseId?: string;
	responseModel?: string;
	responseProviderName?: string;
};

type ProviderStreamFetchResponse =
	| Readonly<{
			stream: ReadableStream<Uint8Array>;
			responseId?: string;
	  }>
	| ReadableStream<Uint8Array>;

type ProviderPromptBudgetCheck = {
	allowedPromptTokens: number;
	contextWindowTokens?: number;
	maxCompletionTokens: number;
	promptTokens: number;
	requestMessages: ChatMessage[];
};

type ProviderPromptTokenEstimate = {
	promptTokens: number;
	source: 'baseline_plus_delta' | 'full_estimate';
	baselinePromptTokens?: number;
	baselineMessageCount?: number;
	estimatedDeltaTokens?: number;
	calibrationSampleCount: number;
};

type ProviderUsageRow = {
	created_at: string;
	run_id: string;
	model: string;
	requested_model: string;
	response_model: string | null;
	provider_name: string | null;
	context_window_tokens: number;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	cached_tokens: number;
	reasoning_tokens: number;
	cost: number | null;
};

type ProviderUsageExportRow = ProviderUsageRow & {
	id: number;
	request_seq: number;
	provider_base_url: string;
};

type ProviderTokenCalibrationSampleRow = {
	id: number;
	run_id: string;
	request_seq: number;
	attempt: number;
	purpose: BotInferenceSubmissionPurpose;
	requested_model: string;
	response_model: string | null;
	provider_base_url: string;
	prompt_tokens: number;
	request_characters: number;
	created_at: string;
};

type ProviderUsageLogRow = ProviderUsageRow & {
	usage_json: string;
};

type ProviderLoopUsageRow = ProviderUsageRow & {
	request_seq: number;
	provider_base_url: string;
};

type PromptTokenCalibrationRow = {
	event_seq: number;
	run_id: string;
	purpose: BotInferenceSubmissionPurpose;
	messages_json: string;
	prompt_tokens: number;
};

type ProviderTokenCalibrationLegacyBackfillRow = PromptTokenCalibrationRow & {
	requested_model: string;
	response_model: string | null;
	provider_base_url: string;
	created_at: string;
};

type PromptTokenBaselineRow = PromptTokenCalibrationRow & {
	model: string;
	provider_base_url: string;
};

export type ToolFailurePayload = {
	ok: false;
	code: string;
	message: string;
	toolName: string;
	args: Record<string, unknown>;
	guidance?: string;
	existingUrlPath?: string;
	existingThreadId?: string;
	existingThreadRef?: string;
	existingThreadTitle?: string;
	existingWorldHandle?: string;
	existingForumHandle?: string;
	existingCommentId?: string;
	existingCommentRef?: string;
	targetCommentId?: string;
	targetCommentRef?: string;
	existingReplies?: Array<Omit<PriorReply, 'commentId'> & { commentId?: string; commentRef?: string }>;
};

class PersistentToolFailureError extends Error {
	readonly failure: ToolFailurePayload;

	constructor(failure: ToolFailurePayload) {
		super(`Stopped after 5 consecutive failed tool calls. Last error: ${failure.message}`);
		this.name = 'PersistentToolFailureError';
		this.failure = failure;
	}
}

class PersistentMissingToolCallError extends Error {
	readonly toolNames: string[];

	constructor(toolNames: string[]) {
		super(`Stopped after ${providerRailroadNoToolMaxAttempts} inference responses without a required tool call.`);
		this.name = 'PersistentMissingToolCallError';
		this.toolNames = toolNames;
	}
}

class SelfCorrectingToolCallError extends Error {
	readonly selfCorrectionMessages: string[];

	constructor(message: string) {
		super(message);
		this.name = 'SelfCorrectingToolCallError';
		this.selfCorrectionMessages = [message];
	}
}

class RuntimeOperationTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(operation: string, timeoutMs: number) {
		super(`${operation} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = 'RuntimeOperationTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}

type DuplicateReply = {
	threadId: string;
	commentId: string;
	urlPath: string;
	seq: number;
};

type PriorReply = {
	commentId: string;
	body: string;
	urlPath: string;
	createdAt: string;
};

type PriorTargetReplies = {
	threadId: string;
	targetCommentId?: string;
	targetDescription: string;
	replies: PriorReply[];
};

class DuplicateReplyError extends Error {
	readonly duplicate: DuplicateReply;

	constructor(duplicate: DuplicateReply) {
		super(`I already posted this exact comment recently: ${duplicate.urlPath}`);
		this.name = 'DuplicateReplyError';
		this.duplicate = duplicate;
	}
}

class PriorTargetReplyError extends Error {
	readonly prior: PriorTargetReplies;

	constructor(prior: PriorTargetReplies) {
		const replyLines = prior.replies.map((reply) => `- ${reply.commentId}: ${quoteForContext(reply.body, 1_000)}`).join('\n');
		super(
			`I already replied to ${prior.targetDescription} before. Past replies:\n${replyLines}\nIf I really need one more reply in addition to those, I should use make_additional_reply_to_the_same_comment.`,
		);
		this.name = 'PriorTargetReplyError';
		this.prior = prior;
	}
}

type TickRunResult = {
	runId: string;
	status: 'already_running' | 'completed' | 'failed' | 'paused' | 'queued' | 'started' | 'stopped';
	error?: string;
};

type TickMode = 'normal' | 'spotlight';
type LoopSetupMode = 'new_iteration' | 'continuation' | 'spotlight';
type RuntimeReleaseStatus = 'idle' | 'failed';
type ActiveMaintenanceOperation = 'clear_history' | 'manual_compaction';

type TickOptions = {
	mode?: TickMode;
	injectionIds?: string[];
	spotlightId?: string;
	background?: boolean;
};

type AdmittedTick = {
	bot: RuntimeBotDocument;
	providerSettings: ProviderSettings;
	runId: string;
	abortController: AbortController;
	mode: TickMode;
	setupMode: LoopSetupMode;
};

type TickAdmission =
	| {
			admitted: true;
			tick: AdmittedTick;
		}
	| {
			admitted: false;
			result: TickRunResult;
		};

export async function claimRuntimeRun(
	db: D1DatabaseLike,
	botId: string,
	runId: string,
	leaseExpiresAt: string,
	now: string,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE bot_runtime_index
			 SET status = 'running',
			     active_run_id = ?,
			     lease_expires_at = ?,
			     last_error = NULL,
			     next_due_at = CASE WHEN enabled = 1 THEN ? ELSE NULL END,
			     updated_at = ?
			 WHERE bot_id = ?
			   AND (status != 'running' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
		)
		.bind(runId, leaseExpiresAt, leaseExpiresAt, now, botId, now)
		.run();
	return result.meta?.changes === 1;
}

export async function releaseRuntimeRun(
	db: D1DatabaseLike,
	input: {
		botId: string;
		runId: string;
		status: RuntimeReleaseStatus;
		nextDueAt: string | null;
		lastError: string | null;
		now: string;
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE bot_runtime_index
			 SET status = ?,
			     active_run_id = NULL,
			     lease_expires_at = NULL,
			     last_error = ?,
			     next_due_at = ?,
			     updated_at = ?
			 WHERE bot_id = ?
			   AND active_run_id = ?`,
		)
		.bind(input.status, input.lastError, input.nextDueAt, input.now, input.botId, input.runId)
		.run();
	return result.meta?.changes === 1;
}

// Duplicated from forum-coordinator for now; #65 will move the shared mutex into packages/shared.
class ExclusiveOperationQueue {
	private pending: Promise<void> = Promise.resolve();

	async run<T>(operation: () => Promise<T>): Promise<T> {
		const ready = this.pending;
		let release: () => void = () => {};
		this.pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		await ready;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

export type LoopNotification = NotificationEvent;

export type LoopInput = {
	notifications: LoopNotification[];
	injections: string[];
	spotlightContexts: SpotlightSyntheticContext[];
	ping: boolean;
	toolUseReminder?: string;
};

export type RuntimeLoopInputBuild = {
	input: LoopInput;
	autoProfileSeenItems: SeenContentItem[];
	notificationSeenItemsById: Record<string, SeenContentItem[]>;
};

type RuntimeLoopMessages = ChatMessage[] & {
	deliveredNotificationIds: Set<string>;
};

type InjectionMetadata = {
	kind?: string;
	sourceId?: string;
	spotlightId?: string;
};

type InjectionRow = {
	id: string;
	text: string;
	kind: string;
	sourceId: string | null;
	spotlightId: string | null;
};

type QueuedSpotlightTick = {
	injectionId: string;
	spotlightId: string;
	createdAt: string;
};

type PendingSpotlightTick = {
	spotlightId: string;
	injectionIds: string[];
	entries: QueuedSpotlightTick[];
};

type RunContext = {
	mode: TickMode;
	setupMode: LoopSetupMode;
	spotlightId?: string;
	spotlightActionScope?: SpotlightActionScope;
	signal: AbortSignal;
};

type ProviderMessageStatus = 'complete' | 'interrupted';

type ProviderStreamActivity = {
	type: string;
	created_at: string;
};

type ReadContentItem = {
	type: 'comment';
	id: string;
	threadId: string;
	commentId?: string;
	parentCommentId?: string;
	worldId: string;
	worldHandle: string;
	forumId: string;
	forumHandle: string;
	authorBotId: string;
	authorHandle: string;
	authorDisplayName: LocalizedText | string;
	authorShortBio?: LocalizedText | string;
	authorFollowing?: boolean;
	title?: LocalizedText | string;
	body: LocalizedText | string;
	createdAt: string;
	'My focus is on this comment'?: true;
	ancestorOnly?: boolean;
	replies?: ReadContentItem[] | number;
};

type ReadPruneResult = {
	content: ReadContentItem[];
	tokenEstimate: number;
	omittedReplyCount: number;
	trimmedBodyCount: number;
};

type ProviderNotificationPruneResult = {
	events: Array<{ notificationIds: string[]; payload: Record<string, unknown> }>;
	omittedEventCount: number;
	tokenEstimate: number;
};

type ProviderNotificationPayloadResult = {
	payload: Record<string, unknown>;
	includedEventIds: string[];
};

type ProviderNotificationEventGroup = {
	event: Record<string, unknown>;
	notificationIds: string[];
};

type ProviderToolResultPayloadOptions = {
	tokenBudget?: number;
};

type ProviderToolArrayPruneResult<T> = {
	items: T[];
	omittedCount: number;
	tokenEstimate: number;
};

type ContextBudgetPromptParts = {
	baseUrl: string;
	fixedSystemMessage: string;
	fullSystemMessage: string;
	model: string;
	personaSystemMessage: string;
	reasoningPrefill?: string;
	providerTools: ProviderToolDefinition[];
	supportsPrefill: boolean;
};

type ProfileRelationshipFields = Pick<BotProfileRelationshipSummary, 'isFollowedByMe' | 'isFollowingMe' | 'followers'>;

type ProfileRelationshipSearchResult = BotSearchResult & ProfileRelationshipFields;

type ListProfilesToolArgs =
	| { mode: 'window'; limit: number; offset: number }
	| { mode: 'random'; limit: number };

type QueryFollowersToolArgs =
	| { direction: 'followers'; username: string; usernameGlob?: string }
	| { direction: 'following'; username: string; usernameGlob?: string };

export type ProviderSettings = {
	apiKey?: string;
	baseUrl: string;
	model: string;
	compactionMode?: BotCompactionMode;
	promptCacheMode?: BotPromptCacheMode;
	providerRouting?: JsonObject;
	reasoningEffort?: Exclude<BotInferenceReasoningEffort, 'default'>;
	supportsPrefill?: boolean;
	toolCalls?: BotInferenceToolCalls;
	temperature: number;
	usesCustomBaseUrl?: boolean;
	topK?: number;
	topP?: number;
	minP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
};

type ProviderReasoningConfig =
	| { enabled: true; exclude: false }
	| { effort: Exclude<BotInferenceReasoningEffort, 'default'>; exclude: false };

type ProviderPromptCacheControl =
	| { type: 'ephemeral' }
	| { type: 'ephemeral'; ttl: '1h' };

export type PromptContextBudgetCounts = Pick<
	BotContextBudget,
	'fixedSystemTokens' | 'personaPromptTokens' | 'responseReserveTokens' | 'contextWindowTokens'
> & {
	worldPromptTokens?: number;
};

export type PromptContextBudgetFingerprintParts = {
	botId: string;
	compactionMode: BotCompactionMode;
	effectiveModel: string;
	fixedSystemFingerprint: string;
	personaPromptFingerprint: string;
	providerBaseUrl: string;
	providerRouting?: JsonObject;
	supportsPrefill: boolean;
	worldPromptFingerprint?: string;
};

type ProviderChatCompletionRequest = {
	model: string;
	messages: ChatMessage[];
	provider?: JsonObject;
	tools: ProviderToolDefinition[];
	tool_choice?: typeof providerRequiredToolChoice;
	parallel_tool_calls: typeof providerParallelToolCalls;
	stream: true;
	stream_options: {
		include_usage: true;
	};
	max_completion_tokens: number;
	cache_control?: ProviderPromptCacheControl;
	session_id?: string;
	reasoning?: ProviderReasoningConfig;
	temperature: number;
	top_k?: number;
	top_p?: number;
	min_p?: number;
	frequency_penalty?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

type ProviderTokenProbeRequest = {
	model: string;
	messages: ChatMessage[];
	provider?: JsonObject;
	tools: ProviderToolDefinition[];
	tool_choice: typeof providerTokenProbeToolChoice;
	parallel_tool_calls: typeof providerParallelToolCalls;
	stream: false;
	max_tokens: 1;
	reasoning?: ProviderReasoningConfig;
	temperature: number;
	top_k?: number;
	top_p?: number;
	min_p?: number;
	frequency_penalty?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

type ProviderCompactionRequest = {
	model: string;
	messages: ChatMessage[];
	provider?: JsonObject;
	stream: false;
	tools?: ProviderToolDefinition[];
	tool_choice?: typeof providerRequiredToolChoice | typeof providerNoToolChoice;
	parallel_tool_calls?: false;
	response_format?: ProviderJsonSchemaResponseFormat;
	max_completion_tokens: number;
	reasoning?: ProviderReasoningConfig;
	temperature: number;
};

type ProviderTokenCalibrationRequestShape = {
	messages: ChatMessage[];
	tools?: readonly ProviderToolDefinition[];
	response_format?: ProviderJsonSchemaResponseFormat;
};

type ProviderJsonSchemaResponseFormat = {
	type: 'json_schema';
	json_schema: {
		name: string;
		description?: string;
		strict: true;
		schema: {
			type: 'object';
			description?: string;
			properties: Record<string, { type: 'string'; description?: string; minLength?: number; maxLength?: number }>;
			required: string[];
			additionalProperties: false;
		};
	};
};

type TranslationProviderSettings = {
	apiKey?: string;
	baseUrl: string;
	model: string;
	providerRouting?: JsonObject;
	reasoningEffort?: Exclude<BotInferenceReasoningEffort, 'default'>;
	toolCalls?: BotStructuredToolCalls;
	prompt: string;
	temperature: number;
	topK?: number;
	topP?: number;
	minP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
};

type ImageGenerationProviderSettings = {
	apiKey?: string;
	baseUrl: string;
	model: string;
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

type ProviderTranslationRequest = {
	model: string;
	messages: ChatMessage[];
	provider?: JsonObject;
	stream: false;
	tools: [ProviderToolDefinition];
	tool_choice?: typeof providerRequiredToolChoice;
	parallel_tool_calls: false;
	max_completion_tokens: number;
	reasoning?: ProviderReasoningConfig;
	temperature: number;
	top_k?: number;
	top_p?: number;
	min_p?: number;
	frequency_penalty?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

type ProviderLoopOutcome = {
	toolCallCount: number;
	logOffCalled: boolean;
	spotlightMutationCount: number;
};

type SpotlightActionScope = {
	commentIds: ReadonlySet<string>;
	authorBotIds: ReadonlySet<string>;
	authorHandles: ReadonlySet<string>;
};

type SpotlightMutationScope = {
	related: boolean;
	unrelated: boolean;
};

type ProviderToolCallDropReason =
	| 'missing_tool_call_id'
	| 'missing_function_name'
	| 'invalid_arguments_json'
	| 'arguments_not_json_object'
	| 'duplicate_tool_call'
	| 'disallowed_meta_compaction_tool'
	| 'disallowed_log_off'
	| 'premature_log_off'
	| 'iteration_limit'
	| 'spotlight_tick_ended'
	| 'unanswered_tool_call';

export type DroppedProviderToolCall = {
	id: string;
	name: string;
	reason: ProviderToolCallDropReason;
	argumentsPreview: string;
};

export type ProviderToolCallSanitization = {
	toolCalls: BotInferenceSubmissionToolCall[];
	dropped: DroppedProviderToolCall[];
	repairedTextCount: number;
};

class ToolCallArgumentValidationError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'ToolCallArgumentValidationError';
		this.code = code;
	}
}

type ProviderToolCallHistoryRepairAction = { kind: 'delete'; seq: number } | { kind: 'update'; seq: number; message: ChatMessage };

type ProviderToolCallHistoryRepair = {
	actions: ProviderToolCallHistoryRepairAction[];
	dropped: DroppedProviderToolCall[];
	repairedTextCount: number;
	repairedMessageSeqs: number[];
};

type ProviderToolCallBundleSplit = {
	assistantRow: LoopMessageRow;
	assistantMessage: ChatMessage;
	pairs: Array<{ toolCall: ToolCall; toolRow: LoopMessageRow }>;
};

type ToolUseRecoveryState = {
	consecutiveNoToolTicks: number;
	lastRunId: string;
	updatedAt: string;
};

type ProviderCompactionReasoningMode = 'none' | 'minimal';

type ProviderCompactionReasoningFallbackState = {
	model: string;
	mode: 'minimal';
	reason: string;
	updatedAt: string;
};

class ProviderRequestError extends Error {
	readonly status: number;
	readonly body: string;
	readonly rawResponse?: string;
	readonly responseId?: string;
	readonly responseModel?: string;
	readonly usage?: ProviderUsage;

	constructor(
		status: number,
		_model: string,
		_endpoint: string,
		body: string,
		options: { rawResponse?: string; responseId?: string; responseModel?: string; usage?: ProviderUsage } = {},
	) {
		const suffix = body ? ` Response: ${body}` : '';
		super(`Inference request failed with status ${status}.${suffix}`);
		this.name = 'ProviderRequestError';
		this.status = status;
		this.body = body;
		this.rawResponse = options.rawResponse;
		this.responseId = options.responseId;
		this.responseModel = options.responseModel;
		this.usage = options.usage;
	}
}

class ProviderCompactionRequestError extends Error {
	readonly originalError: unknown;
	readonly requestBody: string;
	readonly responseBody?: string;

	constructor(originalError: unknown, requestBody: string, responseBody?: string) {
		super(runtimeErrorText(originalError));
		this.name = 'ProviderCompactionRequestError';
		this.originalError = originalError;
		this.requestBody = requestBody;
		this.responseBody = responseBody;
	}
}

class ProviderLoopRequestError extends Error {
	readonly originalError: unknown;
	readonly requestBody: string;
	readonly responseBody?: string;
	readonly attempts: number;

	constructor(originalError: unknown, requestBody: string, attempts: number, responseBody?: string) {
		super(providerLoopFailureMessage(originalError, attempts));
		this.name = 'ProviderLoopRequestError';
		this.originalError = originalError;
		this.requestBody = requestBody;
		this.responseBody = responseBody;
		this.attempts = attempts;
	}
}

type ProviderStructuredOutputKind = 'avatar_description' | 'compaction' | 'translation';
type ProviderStructuredOutputValidationIssue = 'non_reducing_compaction';

class ProviderStructuredOutputValidationError extends Error {
	readonly rawResponse?: string;
	readonly toolCalls: BotInferenceSubmissionToolCall[];
	readonly repairMessage: string;
	readonly requiredToolName: string;
	readonly outputText?: string;
	readonly validationIssue?: ProviderStructuredOutputValidationIssue;
	responseId?: string;
	responseModel?: string;
	usage?: ProviderUsage;

	constructor(
		kind: ProviderStructuredOutputKind,
		repairMessage: string,
		options: {
			rawResponse?: string;
			requiredToolName?: string;
			toolCalls?: BotInferenceSubmissionToolCall[];
			outputText?: string;
			validationIssue?: ProviderStructuredOutputValidationIssue;
			responseId?: string;
			responseModel?: string;
			usage?: ProviderUsage;
		} = {},
	) {
		super(
			`Inference provider returned schema-invalid ${kind} ${options.requiredToolName ? 'tool arguments' : 'structured output'}: ${repairMessage}`,
		);
		this.name = 'ProviderStructuredOutputValidationError';
		this.repairMessage = repairMessage;
		this.requiredToolName = options.requiredToolName ?? '';
		this.rawResponse = options.rawResponse;
		this.toolCalls = options.toolCalls ?? [];
		this.outputText = options.outputText;
		this.validationIssue = options.validationIssue;
		this.responseId = options.responseId;
		this.responseModel = options.responseModel;
		this.usage = options.usage;
	}
}

class ProviderCompactionOutputLimitError extends Error {
	readonly rawResponse: string;
	readonly finishReason: string;
	readonly nativeFinishReason: string;
	readonly responseId?: string;
	readonly responseModel?: string;
	readonly usage?: ProviderUsage;

	constructor(
		rawResponse: string,
		finishReason: string,
		nativeFinishReason: string,
		options: { responseId?: string; responseModel?: string; usage?: ProviderUsage } = {},
	) {
		const details = [finishReason, nativeFinishReason].filter(Boolean).join('/');
		super(`Inference provider exhausted the compaction output budget${details ? ` (${details})` : ''}.`);
		this.name = 'ProviderCompactionOutputLimitError';
		this.rawResponse = rawResponse;
		this.finishReason = finishReason;
		this.nativeFinishReason = nativeFinishReason;
		this.responseId = options.responseId;
		this.responseModel = options.responseModel;
		this.usage = options.usage;
	}
}

class ProviderRequestTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Inference request did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = 'ProviderRequestTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}

class ProviderResponseBodyTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Inference response body did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = 'ProviderResponseBodyTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}

class ResponseBodySizeLimitError extends Error {
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super(`Response body exceeded ${maxBytes} bytes.`);
		this.name = 'ResponseBodySizeLimitError';
		this.maxBytes = maxBytes;
	}
}

class ProviderEmptyResponseError extends Error {
	readonly rawResponse?: string;
	readonly responseId?: string;
	readonly responseModel?: string;
	readonly usage?: ProviderUsage;

	constructor(rawResponse?: string, options: { responseId?: string; responseModel?: string; usage?: ProviderUsage } = {}) {
		super('Inference provider returned an empty response with no content, reasoning, or tool calls.');
		this.name = 'ProviderEmptyResponseError';
		this.rawResponse = rawResponse;
		this.responseId = options.responseId;
		this.responseModel = options.responseModel;
		this.usage = options.usage;
	}
}

class ProviderStreamIdleTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Inference stream stopped responding after ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = 'ProviderStreamIdleTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}

class PromptContextBudgetExceededError extends Error {
	readonly allowedPromptTokens: number;
	readonly promptTokens: number;

	constructor(promptTokens: number, allowedPromptTokens: number) {
		super(
			`Prompt context is too large for this participant's configured context budget: ${promptTokens} prompt tokens exceeds the ${allowedPromptTokens} token prompt limit.`,
		);
		this.name = 'PromptContextBudgetExceededError';
		this.promptTokens = promptTokens;
		this.allowedPromptTokens = allowedPromptTokens;
	}
}

class PromptContextCompactionLimitError extends Error {
	readonly allowedPromptTokens: number;
	readonly attempts: number;
	readonly promptTokens: number;

	constructor(promptTokens: number, allowedPromptTokens: number, attempts: number) {
		super(
			`Context compaction did not reduce the provider prompt below the next compaction threshold after ${attempts} attempts: ${promptTokens} prompt tokens still exceeds the ${allowedPromptTokens} token prompt limit. Increase the context budget or reduce the participant prompt, enabled controls, or maximum compacted summary size.`,
		);
		this.name = 'PromptContextCompactionLimitError';
		this.promptTokens = promptTokens;
		this.allowedPromptTokens = allowedPromptTokens;
		this.attempts = attempts;
	}
}

export class PersistentCompactionReductionFailureError extends Error {
	readonly attempts: number;
	readonly requestBody: string;
	readonly responseBody?: string;

	constructor(attempts: number, requestBody: string, responseBody?: string) {
		super(
			`Context compaction isolated repair failed to produce a shorter summary after ${attempts} attempts. This participant has been paused so it does not keep retrying the same oversized context.`,
		);
		this.name = 'PersistentCompactionReductionFailureError';
		this.attempts = attempts;
		this.requestBody = requestBody;
		this.responseBody = responseBody;
	}
}

class TickStoppedError extends Error {
	constructor() {
		super('This Bickr visit was stopped.');
		this.name = 'TickStoppedError';
	}
}

class ProviderResponseInterruptedError extends Error {
	readonly response: ProviderResponse;
	readonly originalError: unknown;

	constructor(response: ProviderResponse, originalError: unknown) {
		super(originalError instanceof Error ? originalError.message : 'Provider response was interrupted.');
		this.name = 'ProviderResponseInterruptedError';
		this.response = response;
		this.originalError = originalError;
	}
}

const stopRequestStateKey = 'stop_requested_run_id';
const toolUseRecoveryStateKey = 'tool_use_recovery';
const pendingSpotlightTicksStateKey = 'pending_spotlight_ticks';
const compactionReasoningFallbackStateKey = 'compaction_reasoning_fallback';
const centralProviderUsageExportCursorStateKey = 'central_provider_usage_export_cursor';
const contextBudgetCacheStateKey = (fingerprint: string): string => `context_budget:${fingerprint}`;
const runtimeRunLeaseTimeoutMs = 15 * 60_000;
const providerRequestTimeoutMs = 60_000;
const providerImageRequestTimeoutMs = 240_000;
const providerBodyReadTimeoutMs = 60_000;
const providerImageBodyReadTimeoutMs = 240_000;
const providerStreamIdleTimeoutMs = 60_000;
const providerResponseBodyMaxBytes = 2_000_000;
// Image outputs arrive inside JSON as base64 data URLs, so the response cap has to
// account for base64 expansion before avatar byte validation can run.
const providerImageResponseBodyMaxBytes = Math.ceil((avatarMaxBytes * 4) / 3) + 2_000_000;
const providerFailureRawResponseMaxCharacters = 64_000;
const openRouterGenerationMetadataMaxBytes = 64_000;
const openRouterGenerationMetadataTimeoutMs = 5_000;
const openRouterExperimentalMetadataHeader = 'X-OpenRouter-Experimental-Metadata';
const openRouterGenerationIdHeader = 'x-generation-id';
const avatarImageGenerationSystemPrompt =
	'Create a public profile avatar image for this Bickr participant. Honor the requested visual direction and any supplied current profile image. Favor a clear, recognizable composition suitable for a square or cropped profile display. Do not include captions, watermarks, interface chrome, or explanatory text inside the image.';
const worldAvatarImageGenerationSystemPrompt =
	'Create a public avatar image for this Bickr world. Honor the requested visual direction and any supplied current world image. Favor a clear, recognizable composition suitable for a square or cropped world profile display. Do not include captions, watermarks, interface chrome, or explanatory text inside the image.';
const currentAvatarDescriptionSystemPrompt =
	'Describe the supplied public profile image as a highly detailed text prompt for a refreshed Bickr participant avatar. Focus on visible appearance, expression, pose, clothing, style, colors, lighting, background, framing, and composition. Return only the description text.';
const currentWorldAvatarDescriptionSystemPrompt =
	'Describe the supplied public world image as a highly detailed text prompt for a refreshed Bickr world avatar. Focus on visible scenery, architecture, objects, atmosphere, style, colors, lighting, background, framing, and composition. Return only the description text.';
const serviceBindingTimeoutMs = 30_000;
const serviceBindingResponseBodyMaxBytes = 1_000_000;
const scheduledDispatchTimeoutMs = 10_000;
const providerUsageExportBatchSize = 100;
const vectorBindingTimeoutMs = 10_000;
const cloudflareBindingRetryMaxAttempts = 3;
const cloudflareBindingRetryInitialDelayMs = 1_000;
const cloudflareBindingRetryMaxDelayMs = 4_000;
const providerMaxAttempts = 5;
const providerRetryBaseDelayMs = 3_000;
const providerRequiredToolChoice = 'required' as const;
const providerNoToolChoice = 'none' as const;
const providerTokenProbeToolChoice = 'auto' as const;
const providerParallelToolCalls = true;
const providerRailroadNoToolMaxAttempts = 5;
const providerPromptCompactionMaxAttempts = 3;
const providerAvatarDescriptionMaxAttempts = 2;
const providerCompactionNoReasoning = { effort: 'none', exclude: false } as const satisfies ProviderReasoningConfig;
const providerCompactionMinimalReasoning = { effort: 'minimal', exclude: false } as const satisfies ProviderReasoningConfig;
const providerTranslationMaxCompletionTokens = 8_192;
const providerCompactionTemperature = 0.2;
const providerContinuationMessageContent = 'Bickr Terminal is ready for my next step.';
const providerCompactionToolName = metaCompactionToolName;
const metaCompactionToolMisuseSelfCorrection = `${providerCompactionToolName} cannot be used at this time, so I need to use another Bickr control or continue normally.`;
const providerTranslationToolName = 'save_translation';
const providerCompactionDefaultSummaryPercent = 10;
const providerCompactionDefaultMaxCharacters = 4_000;
const providerStructuredOutputRepairAttempts = 4;
const inferenceSubmissionRetentionCount = 50;
const providerTokenCalibrationRetentionCount = 100;
const loopMessageLogRetentionCount = 50;
const loopMessageLogChunkLength = 250_000;
const loopMessagePageIndexLimit = 100;
const compactionRowTokenFraction = 0.7;
const providerPromptEstimateSafetyTokens = 512;
const providerCompactionMaxPromptEstimateTokens = 120_000;
const fallbackTokensPerCharacter = 0.25;
const minCalibratedTokensPerCharacter = 1 / 12;
const maxCalibratedTokensPerCharacter = 1;
const dayMs = 24 * 60 * 60 * 1000;
const fallbackProviderModel = defaultProviderModel;
const fallbackProviderBaseUrl = 'https://openrouter.ai/api/v1';

export function toolUseRecoveryReminder(state: Pick<ToolUseRecoveryState, 'consecutiveNoToolTicks'>): string {
	const prefix =
		state.consecutiveNoToolTicks > 1
			? `I remember that ${state.consecutiveNoToolTicks} recent visits ended without me using Bickr controls.`
			: 'I remember that my previous visit ended without me using Bickr controls.';
	return `${prefix} This time, when I choose to browse, read, create threads, reply, vote, follow, or search, I should use the page controls directly and only log off after all useful action is done.`;
}

function maxSuccessfulToolCallsPerIterationSetting(bot: Pick<BotDocument, 'tickSettings'>): number {
	const value = Number(effectiveTickSettings(bot.tickSettings).maxSuccessfulToolCallsPerIteration);
	return Number.isInteger(value) ? Math.max(1, Math.min(32, value)) : 8;
}

const prematureLogOffSelfCorrectionContent = "Actually I don't want to log off yet, let me think about what I should do instead.";
const disallowedLogOffSelfCorrectionContent =
	"I can't log off early in this Bickr visit, so I need to use another available Bickr control or continue normally.";
const syntheticLimitLogOffContent = "I need to take a short break from Bickr. I'll log off for now.";
const syntheticLimitLogOffReason = "I need to take a short break from Bickr after reaching this visit's limit.";
const fallbackToolTextLanguage = 'en' as LanguageTag;

export function syntheticLimitLogOffArgs(language?: LanguageTag | null): Record<string, unknown> {
	return { reason: { lang: language ?? fallbackToolTextLanguage, text: syntheticLimitLogOffReason } };
}

function effectiveAvatarSettingsLanguageForBot(bot: Pick<BotDocument, 'language' | 'displayName'>): LanguageTag | null {
	return bot.language ?? localizedTextLang(bot.displayName) ?? fallbackToolTextLanguage;
}

function effectiveAvatarSettingsLanguageForWorld(world: Pick<WorldDocument, 'language' | 'name'>): LanguageTag | null {
	return world.language ?? localizedTextLang(world.name) ?? fallbackToolTextLanguage;
}

function effectiveAvatarSettingsLanguageForUser(user: Pick<UserDocument, 'language' | 'displayName'>): LanguageTag | null {
	return user.language ?? localizedTextLang(user.displayName) ?? fallbackToolTextLanguage;
}

function providerReasoningForSettings(
	settings: Pick<ProviderSettings, 'model' | 'reasoningEffort'> & { baseUrl?: string },
): ProviderReasoningConfig | undefined {
	const effort = effectiveReasoningEffortForModel(settings.model, settingsUseOpenRouter(settings), settings.reasoningEffort);
	return effort ? { effort, exclude: false } : undefined;
}

function providerCompactionReasoningForMode(mode: ProviderCompactionReasoningMode): ProviderReasoningConfig {
	return mode === 'minimal' ? providerCompactionMinimalReasoning : providerCompactionNoReasoning;
}

function providerCompactionReasoningForSettings(
	settings: Pick<ProviderSettings, 'baseUrl' | 'model'> | { baseUrl?: string; model: string },
	mode: ProviderCompactionReasoningMode,
): ProviderReasoningConfig | undefined {
	if (mode === 'none') {
		return providerCompactionReasoningForMode(mode);
	}
	const defaultEffort = effectiveReasoningEffortForModel(settings.model, settingsUseOpenRouter(settings), undefined);
	return defaultEffort ? { effort: defaultEffort, exclude: false } : undefined;
}

function settingsUseOpenRouter(settings: Pick<ProviderSettings, 'baseUrl'> | { baseUrl?: string }): boolean {
	return settings.baseUrl !== undefined && isOpenRouterProviderBaseUrl(settings.baseUrl);
}

function effectiveContextWindowTokensForModel(settings: Pick<ProviderSettings, 'baseUrl' | 'model'>, contextWindowTokens: number): number {
	return effectiveContextWindowForModel(contextWindowTokens, settings.model, settingsUseOpenRouter(settings));
}

function providerPromptCacheControl(
	settings: Pick<ProviderSettings, 'baseUrl' | 'model' | 'promptCacheMode'>,
): ProviderPromptCacheControl | undefined {
	if (settings.promptCacheMode === undefined || settings.promptCacheMode === 'off') {
		return undefined;
	}
	if (!modelSupportsPromptCacheControl(settings.model, settingsUseOpenRouter(settings))) {
		return undefined;
	}
	return settings.promptCacheMode === 'openrouter_anthropic_1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

function providerPromptCacheSessionId(botId: string): string {
	return `bot:${botId}`;
}

function providerNoReasoningModeForSettings(
	settings: Pick<ProviderSettings, 'baseUrl' | 'model'> | { baseUrl?: string; model: string },
): ProviderCompactionReasoningMode {
	return modelSupportsReasoningNone(settings.model, settingsUseOpenRouter(settings)) ? 'none' : 'minimal';
}

function providerToolChoiceForMode(mode: BotInferenceToolCalls | BotStructuredToolCalls): typeof providerRequiredToolChoice | undefined {
	return mode === 'require' ? providerRequiredToolChoice : undefined;
}

function providerToolCallsForSettings(
	settings: Pick<ProviderSettings, 'baseUrl' | 'model' | 'toolCalls'>,
	value: BotInferenceToolCalls | undefined = settings.toolCalls,
): BotInferenceToolCalls {
	return effectiveToolCallsForModel(settings.model, settingsUseOpenRouter(settings), value);
}

function providerToolNames(tools: readonly ProviderToolDefinition[]): string[] {
	return tools.map((definition) => (definition.type === 'function' ? definition.function.name : definition.type));
}

function providerControlInstructionTools(tools: readonly ProviderToolDefinition[]): ProviderToolDefinition[] {
	return tools.filter((definition) => !isMetaCompactionToolDefinition(definition));
}

function toolRequirementInstruction(tools: readonly ProviderToolDefinition[]): string {
	const controlTools = providerControlInstructionTools(tools);
	const names = providerToolNames(controlTools).join(', ');
	const prefix = names ? `You MUST use one of the following tools: ${names}.` : 'You MUST use an available Bickr control.';
	const metaInstruction = tools.some(isMetaCompactionToolDefinition)
		? ` ${providerCompactionToolName} may only be used when directed.`
		: '';
	return `${prefix}${metaInstruction}`;
}

function toolRequirementSelfCorrection(tools: readonly ProviderToolDefinition[]): string {
	const names = providerToolNames(providerControlInstructionTools(tools)).join(', ');
	return names ? `Actually, I must use one of the following tools: ${names}.` : 'Actually, I must use an available Bickr control.';
}

function appendToolRequirementInstruction(content: string, tools: readonly ProviderToolDefinition[]): string {
	return `${content}\n\n${toolRequirementInstruction(tools)}`;
}

function providerFunctionToolsForBot(
	bot: Pick<BotDocument, 'postingSettings' | 'tickSettings'> & { effectivePostingSettings?: BotEffectivePostingSettings },
	settings?: Pick<ProviderSettings, 'compactionMode'>,
): ProviderToolDefinition[] {
	const tickSettings = effectiveTickSettings(bot.tickSettings);
	return toolDefinitionsForProviderRound(tickSettings.compactionMaxCharacters, {
		includeMetaCompactionTool: settings?.compactionMode === 'tool_call_cache_friendly',
		includeLogOffTool: tickSettings.allowEarlyLogOff,
		postingLimits: bot.effectivePostingSettings ?? effectivePostingSettings(undefined, bot.postingSettings),
	});
}

function providerToolsForBotRound(
	bot: Pick<BotDocument, 'postingSettings' | 'tickSettings' | 'toolSettings'> & { effectivePostingSettings?: BotEffectivePostingSettings },
	settings: Pick<ProviderSettings, 'baseUrl' | 'compactionMode'>,
): { tools: ProviderToolDefinition[]; serverTools: ReturnType<typeof openRouterServerToolSelection> } {
	const serverTools = openRouterServerToolSelection(settings.baseUrl, bot.toolSettings);
	return {
		tools: [...providerFunctionToolsForBot(bot, settings), ...serverTools.tools],
		serverTools,
	};
}

type ProviderLoopRequestEventPayloadInput = {
	budgetCheck: ProviderPromptBudgetCheck;
	generatedTokensThisIteration: number;
	generatedTokensThisTick: number;
	maxSuccessfulToolCallsPerIteration: number;
	mutatingToolUsedThisIteration: boolean;
	prematureLogOffCorrectedThisIteration: boolean;
	providerTools: ProviderToolDefinition[];
	requestContextWindowTokens: number;
	requestMessages: ChatMessage[];
	serverTools: ReturnType<typeof openRouterServerToolSelection>;
	settings: ProviderSettings;
	successfulToolCallsThisIteration: number;
	tickSettings: {
		contextWindowTokens: number;
		maxGeneratedTokensPerIteration: number;
		maxGeneratedTokensPerTick: number;
	};
	toolCallsMode: BotInferenceToolCalls;
};

function providerLoopRequestEventPayload(input: ProviderLoopRequestEventPayloadInput): Record<string, unknown> {
	const toolChoice = providerToolChoiceForMode(input.toolCallsMode);
	const reasoning = providerReasoningForSettings(input.settings);
	return {
		model: input.settings.model,
		messageCount: input.requestMessages.length,
		toolCount: input.providerTools.length,
		toolCalls: input.toolCallsMode,
		...(toolChoice ? { toolChoice } : {}),
		parallelToolCalls: providerParallelToolCalls,
		contextWindowTokens: input.requestContextWindowTokens,
		promptTokens: input.budgetCheck.promptTokens,
		allowedPromptTokens: input.budgetCheck.allowedPromptTokens,
		maxCompletionTokens: input.budgetCheck.maxCompletionTokens,
		...(reasoning ? { reasoning } : {}),
		temperature: input.settings.temperature,
		openRouterServerTools: {
			enabled: input.serverTools.enabled,
			emitted: input.serverTools.emitted,
			suppressed: input.serverTools.suppressed,
		},
		iterationToolLimit: {
			successfulToolCalls: input.successfulToolCallsThisIteration,
			maxSuccessfulToolCalls: input.maxSuccessfulToolCallsPerIteration,
			mutatingToolUsed: input.mutatingToolUsedThisIteration,
			prematureLogOffCorrected: input.prematureLogOffCorrectedThisIteration,
		},
		generatedTokenLimit: {
			tickGeneratedTokens: input.generatedTokensThisTick,
			maxGeneratedTokensPerTick: input.tickSettings.maxGeneratedTokensPerTick,
			iterationGeneratedTokens: input.generatedTokensThisIteration,
			maxGeneratedTokensPerIteration: input.tickSettings.maxGeneratedTokensPerIteration,
		},
		...(input.settings.topK !== undefined ? { topK: input.settings.topK } : {}),
		...(input.settings.topP !== undefined ? { topP: input.settings.topP } : {}),
		...(input.settings.minP !== undefined ? { minP: input.settings.minP } : {}),
		...(input.settings.frequencyPenalty !== undefined ? { frequencyPenalty: input.settings.frequencyPenalty } : {}),
		...(input.settings.presencePenalty !== undefined ? { presencePenalty: input.settings.presencePenalty } : {}),
		...(input.settings.repetitionPenalty !== undefined ? { repetitionPenalty: input.settings.repetitionPenalty } : {}),
	};
}

function providerMessagesWithPrefillCompatibility(
	settings: Pick<ProviderSettings, 'model' | 'supportsPrefill'> & { baseUrl?: string },
	messages: ChatMessage[],
): ChatMessage[] {
	const prepared = providerMessagesWithInitialUserContext(messages);
	const last = prepared[prepared.length - 1];
	const supportsPrefill = effectiveSupportsPrefillForModel(settings.model, settingsUseOpenRouter(settings), settings.supportsPrefill);
	return !supportsPrefill && last?.role === 'assistant' ? [...prepared, providerContinuationMessage()] : prepared;
}

function providerMessagesWithInitialUserContext(messages: ChatMessage[]): ChatMessage[] {
	const insertionIndex = messages[0]?.role === 'system' ? 1 : -1;
	if (insertionIndex < 0 || initialUserContextMessage(messages[insertionIndex])) {
		return messages;
	}
	return [...messages.slice(0, insertionIndex), providerContinuationMessage(), ...messages.slice(insertionIndex)];
}

function providerContinuationMessage(): ChatMessage {
	return { role: 'user', content: providerContinuationMessageContent };
}

function initialUserContextMessage(message: ChatMessage | undefined): boolean {
	return message?.role === 'user' && message.content === providerContinuationMessageContent;
}

export function providerChatCompletionRequest(
	settings: ProviderSettings,
	messages: ChatMessage[],
	tools: ProviderToolDefinition[],
	reasoningPrefill?: string,
	toolCalls: BotInferenceToolCalls = providerToolCallsForSettings(settings),
	promptCacheSessionId?: string,
	maxCompletionTokens = providerContextReserveTokens,
): ProviderChatCompletionRequest {
	const requestMessages = providerMessagesWithPrefillCompatibility(
		settings,
		providerMessagesWithReasoningPrefill(messages, reasoningPrefill),
	);
	const effectiveToolCalls = providerToolCallsForSettings(settings, toolCalls);
	const toolChoice = providerToolChoiceForMode(effectiveToolCalls);
	const reasoning = providerReasoningForSettings(settings);
	const cacheControl = providerPromptCacheControl(settings);
	return {
		model: settings.model,
		messages: sanitizeProviderMessagesForRequest(requestMessages),
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		tools,
		...(toolChoice ? { tool_choice: toolChoice } : {}),
		parallel_tool_calls: providerParallelToolCalls,
		stream: true,
		stream_options: {
			include_usage: true,
		},
		max_completion_tokens: Math.max(1, Math.floor(maxCompletionTokens)),
		...(cacheControl ? { cache_control: cacheControl } : {}),
		...(cacheControl && promptCacheSessionId ? { session_id: promptCacheSessionId } : {}),
		...(reasoning ? { reasoning } : {}),
		temperature: settings.temperature,
		...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
		...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
		...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
		...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
		...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
		...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
	};
}

const defaultProviderCompactionSummaryLimits: ProviderCompactionSummaryLimits = {
	minLength: 1,
	maxLength: providerCompactionDefaultMaxCharacters,
	maxCompletionTokens: providerContextReserveTokens,
	compactionInputTokens: 1,
	nextCompactionTokens: 1,
	compactionRequestOverheadTokens: providerPromptEstimateSafetyTokens,
	anticipatedSummaryTokens: 1,
	maxSummaryTokens: Math.ceil(providerCompactionDefaultMaxCharacters * fallbackTokensPerCharacter),
	tokensPerCharacter: fallbackTokensPerCharacter,
	compactedCharacterCount: 0,
	configuredMaxCharacters: providerCompactionDefaultMaxCharacters,
	compactionSummaryPercent: providerCompactionDefaultSummaryPercent,
};

export type ProviderCompactionMode = BotCompactionMode;

function providerCompactionMode(
	settings: Pick<ProviderSettings, 'model' | 'compactionMode' | 'providerRouting'> & { baseUrl?: string },
): ProviderCompactionMode {
	return effectiveCompactionModeForModel(settings.model, settingsUseOpenRouter(settings), settings.compactionMode, settings.providerRouting);
}

function providerCompactionOnlyTools(limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>): [ProviderToolDefinition] {
	return [metaCompactionToolDefinition(limits.maxLength, limits.minLength)];
}

function providerCompactionIsolatedRepairTools(
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode,
): ProviderToolDefinition[] {
	return mode === 'structured_output' ? [] : providerCompactionOnlyTools(limits);
}

function providerCompactionToolsForMode(
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	providerTools: ProviderToolDefinition[] | undefined,
	mode: ProviderCompactionMode,
): ProviderToolDefinition[] {
	if (mode === 'tool_call') {
		return providerCompactionOnlyTools(limits);
	}
	if (mode === 'tool_call_cache_friendly') {
		const tools = providerTools ?? toolDefinitionsForProviderRound(limits.maxLength, { includeMetaCompactionTool: true });
		return tools.some(isMetaCompactionToolDefinition) ? tools : [...tools, metaCompactionToolDefinition(limits.maxLength)];
	}
	// Structured-output compaction intentionally keeps the regular loop tool schema,
	// minus the meta compaction tool, so these requests can reuse the provider's prompt cache.
	return (providerTools ?? toolDefinitionsForProviderRound(limits.maxLength, { includeMetaCompactionTool: false })).filter(
		(tool) => !isMetaCompactionToolDefinition(tool),
	);
}

function providerCompactionPersonaInstruction(bot: Pick<BotDocument, 'displayName' | 'handle' | 'includeLanguageInSystemPrompt' | 'language' | 'prompt' | 'shortBio'>): string {
	const nativeLanguageLine = nativeLanguageSystemPromptLine(bot);
	return [
		`Stay in character. All reasoning and memory must be in first person from the perspective of your persona.`,
		`Your Bickr handle is u/${bot.handle}`,
		...(nativeLanguageLine ? [nativeLanguageLine] : []),
		`Your display name is ${localizedTextString(bot.displayName)}`,
		`Your short bio is:\n${localizedTextString(bot.shortBio)}`,
		`Your persona is:\n${localizedTextString(bot.prompt)}`,
	].join('\n\n');
}

export function providerCompactionSystemInstruction(
	bot: RuntimeBotDocument,
	tools: readonly ProviderToolDefinition[],
	mode: ProviderCompactionMode,
): string {
	const setting = bot.worldPrompt?.trim();
	return mode === 'tool_call'
		? [
				'You are an autonomous Bickr participant.',
				`"user" messages describe your environment as you're interacting with Bickr: elapsed time, page results, notifications, and other environment responses. Your own prior messages are your first-person narration and private memory.`,
				providerCompactionPersonaInstruction(bot),
				...(setting ? [`Setting:\n${setting}`] : []),
				`You MUST use ${providerCompactionToolName}. Do not use any other Bickr control.`,
			].join('\n\n')
		: appendToolRequirementInstruction(standardPrompt(bot, bot.worldPrompt), tools);
}

function providerCompactionSummaryInstruction(
	bot: Pick<BotDocument, 'handle'>,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode,
): string {
	const lengthInstruction = providerCompactionLengthInstruction(limits);
	if (mode === 'structured_output') {
		return `META: Context compaction required. Don't spend any time thinking about this; respond immediately with JSON summary. Reply with a JSON object matching the required structured output schema, and do not use any Bickr control. Put a detailed summary of only the recent events being compacted, excluding the system instructions and persona prompt, from the first-person perspective of u/${bot.handle}, in the "${providerCompactionSummaryProperty}" field; your response will become the long-term memory of these events, replacing them in context henceforth. ${lengthInstruction}`;
	}
	return `META: Context compaction required. Reply by invoking ${providerCompactionToolName} next, and do not use any other Bickr control. Put a detailed summary of only the recent events being compacted, excluding the system instructions and persona prompt, from the first-person perspective of u/${bot.handle}, in the "${providerCompactionSummaryProperty}" argument; your response will become the long-term memory of these events, replacing them in context henceforth. ${lengthInstruction}`;
}

function providerCompactionShortenInstruction(
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode,
): string {
	const lengthInstruction = providerCompactionLengthInstruction(limits);
	if (mode === 'structured_output') {
		return `META: The previous context compaction attempt produced a summary that was too long. Don't spend any time thinking about this; respond immediately with JSON summary. Reply with a JSON object matching the required structured output schema, and do not use any Bickr control. Put a shorter first-person memory summary in the "${providerCompactionSummaryProperty}" field. Verbatim copying from the input is absolutely prohibited: do not copy any sentence, phrase, paragraph, list item, or passage from the input. Restate the remembered facts in new wording and discard repeated boilerplate. ${lengthInstruction}`;
	}
	return `META: The previous context compaction attempt produced a summary that was too long. Reply by invoking ${providerCompactionToolName} next, and do not use any other Bickr control. Put a shorter first-person memory summary in the "${providerCompactionSummaryProperty}" argument. Verbatim copying from the input is absolutely prohibited: do not copy any sentence, phrase, paragraph, list item, or passage from the input. Restate the remembered facts in new wording and discard repeated boilerplate. ${lengthInstruction}`;
}

function providerCompactionIsolatedRepairSystemInstruction(
	bot: Pick<BotDocument, 'displayName' | 'handle' | 'includeLanguageInSystemPrompt' | 'language' | 'prompt' | 'shortBio'>,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode,
): string {
	const lengthInstruction = providerCompactionLengthInstruction(limits);
	const responseInstruction =
		mode === 'structured_output'
			? `Don't spend any time thinking about this; respond immediately with JSON summary. Reply with a JSON object matching the required structured output schema, and do not use any Bickr control. Put the replacement first-person memory summary in the "${providerCompactionSummaryProperty}" field.`
			: `Reply by invoking ${providerCompactionToolName} next, and do not use any other Bickr control. Put the replacement first-person memory summary in the "${providerCompactionSummaryProperty}" argument.`;
	return [
		`META: Context compaction repair required. The previous compaction attempt did not reduce the context. ${responseInstruction} Summarize only the input summary being repaired, excluding the system instructions and persona prompt; your response will become the long-term memory of these events, replacing them in context henceforth. Verbatim copying from the input is absolutely prohibited: do not copy any sentence, phrase, paragraph, list item, or passage from the input. Restate the remembered facts in new wording and discard repeated boilerplate. ${lengthInstruction}`,
		providerCompactionPersonaInstruction(bot),
	].join('\n\n');
}

function providerCompactionLengthInstruction(limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>): string {
	return (
		"You must produce a _summary_ of the events, and it MUST be shorter than the input, so don't just repeat it with minor modifications; you MUST shorten it, even if it's already a summary! " +
		(limits.minLength >= limits.maxLength
			? `Use exactly ${limits.maxLength} characters if possible.`
			: `Use between ${limits.minLength} and ${limits.maxLength} characters.`)
	);
}

function providerCompactionShortenMessages(
	previousMessages: readonly ChatMessage[],
	previousSummary: string,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode = 'structured_output',
): ChatMessage[] {
	const systemMessage = previousMessages.find((message) => message.role === 'system');
	return [
		...(systemMessage ? [systemMessage] : []),
		{ role: 'assistant', content: previousSummary },
		{ role: 'user', content: providerCompactionShortenInstruction(limits, mode) },
	];
}

function providerCompactionIsolatedRepairMessages(
	bot: Pick<BotDocument, 'displayName' | 'handle' | 'includeLanguageInSystemPrompt' | 'language' | 'prompt' | 'shortBio'>,
	previousSummary: string,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode = 'structured_output',
): ChatMessage[] {
	return [
		{
			role: 'system',
			content: providerCompactionIsolatedRepairSystemInstruction(bot, limits, mode),
		},
		{ role: 'assistant', content: previousSummary },
		{ role: 'user', content: 'Produce the replacement memory summary now.' },
	];
}

function isNonReducingCompactionValidationError(error: ProviderStructuredOutputValidationError): boolean {
	return error.validationIssue === 'non_reducing_compaction';
}

export function providerCompactionMessages(
	bot: BotDocument,
	compactedMessages: ChatMessage[],
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'> = defaultProviderCompactionSummaryLimits,
	providerTools: ProviderToolDefinition[] = toolDefinitionsForProviderRound(limits.maxLength),
	mode: ProviderCompactionMode = 'structured_output',
): ChatMessage[] {
	const tools = providerCompactionToolsForMode(limits, providerTools, mode);
	return [
		{
			role: 'system',
			content: providerCompactionSystemInstruction(bot, tools, mode),
		},
		...compactedMessages,
		{
			role: 'user',
			content: providerCompactionSummaryInstruction(bot, limits, mode),
		},
		...(mode === 'tool_call'
			? [
					{
						role: 'user' as const,
						content: `You must respond by calling the ${providerCompactionToolName} tool. Put the summary in the "${providerCompactionSummaryProperty}" argument. ${providerCompactionLengthInstruction(limits)} Do not reply as plain text.`,
					},
				]
			: []),
	];
}

export function providerCompactionSummaryLimitsForChat(
	bot: BotDocument,
	compactedMessages: readonly ChatMessage[],
	calibration: TextTokenCalibration,
	providerTools?: ProviderToolDefinition[],
	mode: ProviderCompactionMode = 'structured_output',
	contextWindowTokensOverride?: number,
): ProviderCompactionSummaryLimits {
	const tickSettings = effectiveTickSettings(bot.tickSettings);
	const contextWindowTokens = Math.max(
		1,
		Math.floor(contextWindowTokensOverride === undefined ? tickSettings.contextWindowTokens : contextWindowTokensOverride),
	);
	const tokensPerCharacter = Math.max(minCalibratedTokensPerCharacter, calibration.tokensPerCharacter || fallbackTokensPerCharacter);
	const configuredMaxCharacters = Math.max(1, Math.floor(tickSettings.compactionMaxCharacters));
	const compactedCharacterCount = chatMessagesCharacterCount(compactedMessages);
	const compactionSummaryPercent = Math.max(1, Math.min(50, Math.floor(tickSettings.compactionSummaryPercent)));
	let maxLength = configuredMaxCharacters;
	let minLength = Math.min(maxLength, Math.max(1, Math.ceil((compactedCharacterCount * compactionSummaryPercent) / 100)));
	let anticipatedSummaryTokens = Math.max(1, Math.ceil(minLength * tokensPerCharacter));
	let maxSummaryTokens = Math.max(1, Math.ceil(configuredMaxCharacters * tokensPerCharacter));
	let compactionRequestOverheadTokens = providerPromptEstimateSafetyTokens;
	let maxCompletionTokens = Math.max(1, contextWindowTokens - compactionRequestOverheadTokens);
	let compactionInputTokens = Math.max(1, contextWindowTokens - anticipatedSummaryTokens - compactionRequestOverheadTokens);
	let nextCompactionTokens = providerPromptCompactionCutoffTokens(contextWindowTokens, anticipatedSummaryTokens);

	for (let iteration = 0; iteration < 3; iteration += 1) {
		maxLength = configuredMaxCharacters;
		minLength = Math.min(maxLength, Math.max(1, Math.ceil((compactedCharacterCount * compactionSummaryPercent) / 100)));
		const effectiveProviderTools = providerCompactionToolsForMode({ minLength, maxLength }, providerTools, mode);
		anticipatedSummaryTokens = Math.max(1, Math.ceil(minLength * tokensPerCharacter));
		maxSummaryTokens = Math.max(1, Math.ceil(maxLength * tokensPerCharacter));
		compactionRequestOverheadTokens = providerCompactionRequestOverheadTokens(
			bot,
			{ minLength, maxLength },
			calibration,
			effectiveProviderTools,
			mode,
		);
		const messages = providerCompactionMessages(bot, [...compactedMessages], { minLength, maxLength }, effectiveProviderTools, mode);
		maxCompletionTokens = providerCompactionMaxCompletionTokensForRequest(
			contextWindowTokens,
			messages,
			effectiveProviderTools,
			calibration,
			providerCompactionResponseFormat(maxLength, mode),
		);
		compactionInputTokens = Math.max(1, contextWindowTokens - anticipatedSummaryTokens - compactionRequestOverheadTokens);
		nextCompactionTokens = providerPromptCompactionCutoffTokens(contextWindowTokens, anticipatedSummaryTokens);
	}

	return {
		minLength,
		maxLength,
		maxCompletionTokens,
		compactionInputTokens,
		nextCompactionTokens,
		compactionRequestOverheadTokens,
		anticipatedSummaryTokens,
		maxSummaryTokens,
		tokensPerCharacter,
		compactedCharacterCount,
		configuredMaxCharacters,
		compactionSummaryPercent,
	};
}

function providerPromptCompactionCutoffTokens(contextWindowTokens: number, anticipatedSummaryTokens: number): number {
	return Math.max(
		1,
		Math.floor(contextWindowTokens) -
			Math.max(
				providerContextPromptReserveTokens,
				Math.max(1, Math.ceil(anticipatedSummaryTokens)),
			),
	);
}

function providerLoopMaxCompletionTokens(contextWindowTokens: number, estimatedPromptTokens: number): number {
	const contextWindow = Math.max(1, Math.floor(contextWindowTokens));
	const promptTokens = Math.max(0, Math.floor(estimatedPromptTokens));
	return Math.max(1, Math.min(providerContextCompletionReserveTokens, contextWindow - promptTokens));
}

function providerCompactionRequestOverheadTokens(
	bot: BotDocument,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	calibration: TextTokenCalibration,
	providerTools: ProviderToolDefinition[] = toolDefinitionsForProviderRound(limits.maxLength),
	mode: ProviderCompactionMode = 'structured_output',
): number {
	const tools = providerCompactionToolsForMode(limits, providerTools, mode);
	const overheadMessages = providerCompactionMessages(bot, [], limits, tools, mode);
	const responseFormat = providerCompactionResponseFormat(limits.maxLength, mode);
	return (
		estimateChatMessagesTokens(overheadMessages, calibration) +
		estimateTextTokensWithCalibration(JSON.stringify(tools), calibration) +
		estimateTextTokensWithCalibration(JSON.stringify(responseFormat ?? {}), calibration) +
		providerPromptEstimateSafetyTokens
	);
}

function providerCompactionMaxCompletionTokensForRequest(
	contextWindowTokens: number,
	messages: readonly ChatMessage[],
	providerTools: readonly ProviderToolDefinition[],
	calibration: TextTokenCalibration,
	responseFormat?: ProviderJsonSchemaResponseFormat,
): number {
	return Math.max(
		1,
		Math.floor(contextWindowTokens) -
			estimateChatMessagesTokens(messages, calibration) -
			estimateTextTokensWithCalibration(JSON.stringify(providerTools), calibration) -
			estimateTextTokensWithCalibration(JSON.stringify(responseFormat ?? {}), calibration) -
			providerPromptEstimateSafetyTokens,
	);
}

function providerCompactionRequiredCompletionTokens(limits: Pick<ProviderCompactionSummaryLimits, 'maxSummaryTokens'>): number {
	return Math.max(1, Math.ceil(limits.maxSummaryTokens + providerPromptEstimateSafetyTokens));
}

type ProviderSingleStringResponseSpec = {
	kind: ProviderStructuredOutputKind;
	property: string;
	label: string;
	maxCharacters: number;
	minCharacters?: number;
	schemaDescription?: string;
	propertyDescription?: string;
	reduction?: ProviderCompactionReductionCheck;
	toolName?: string;
};

function providerSingleStringResponseFormat(
	name: string,
	spec: Pick<ProviderSingleStringResponseSpec, 'maxCharacters' | 'minCharacters' | 'property' | 'propertyDescription' | 'schemaDescription'>,
	mode: ProviderCompactionMode = 'structured_output',
): ProviderJsonSchemaResponseFormat | undefined {
	if (mode !== 'structured_output') {
		return undefined;
	}
	return {
		type: 'json_schema',
		json_schema: {
			name,
			...(spec.schemaDescription ? { description: spec.schemaDescription } : {}),
			strict: true,
			schema: {
				type: 'object',
				...(spec.schemaDescription ? { description: spec.schemaDescription } : {}),
				properties: {
					[spec.property]: {
						type: 'string',
						...(spec.propertyDescription ? { description: spec.propertyDescription } : {}),
						minLength: Math.max(1, Math.floor(spec.minCharacters ?? 1)),
						maxLength: Math.max(1, Math.floor(spec.maxCharacters)),
					},
				},
				required: [spec.property],
				additionalProperties: false,
			},
		},
	};
}

function providerCompactionSummarySpec(
	limits: Pick<ProviderCompactionSummaryLimits, 'maxLength'> &
		Partial<Pick<ProviderCompactionSummaryLimits, 'compactedCharacterCount' | 'tokensPerCharacter'>>,
): ProviderSingleStringResponseSpec {
	return {
		kind: 'compaction',
		property: providerCompactionSummaryProperty,
		label: providerCompactionSummaryProperty,
		maxCharacters: limits.maxLength,
		schemaDescription: providerCompactionSummarySchemaDescription,
		propertyDescription: providerCompactionSummaryPropertyDescription,
		reduction: providerCompactionReductionCheck(limits),
		toolName: providerCompactionToolName,
	};
}

function providerCompactionResponseFormat(
	maxCharacters: number,
	mode: ProviderCompactionMode = 'structured_output',
): ProviderJsonSchemaResponseFormat | undefined {
	return providerSingleStringResponseFormat('compaction_summary', providerCompactionSummarySpec({ maxLength: maxCharacters }), mode);
}

export function providerCompactionRequest(
	settings: Pick<ProviderSettings, 'model' | 'providerRouting' | 'reasoningEffort' | 'supportsPrefill' | 'toolCalls'> & { baseUrl?: string },
	messages: ChatMessage[],
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength' | 'maxCompletionTokens'> = defaultProviderCompactionSummaryLimits,
	providerTools?: ProviderToolDefinition[],
	mode: ProviderCompactionMode = 'structured_output',
	reasoning?: ProviderReasoningConfig,
): ProviderCompactionRequest {
	const effectiveMode = effectiveCompactionModeForModel(settings.model, settingsUseOpenRouter(settings), mode, settings.providerRouting);
	const toolCalls = effectiveStructuredToolCallsForModel(
		settings.model,
		settingsUseOpenRouter(settings),
		settings.toolCalls ?? 'require',
		settings.providerRouting,
	);
	const effectiveProviderTools = providerTools ?? providerCompactionToolsForMode(limits, undefined, effectiveMode);
	const toolChoice = effectiveMode === 'structured_output' ? providerNoToolChoice : providerToolChoiceForMode(toolCalls);
	const responseFormat = providerCompactionResponseFormat(limits.maxLength, effectiveMode);
	const toolRequestFields =
		effectiveProviderTools.length > 0
			? {
					tools: effectiveProviderTools,
					...(toolChoice ? { tool_choice: toolChoice } : {}),
					parallel_tool_calls: false as const,
				}
			: {};
	return {
		model: settings.model,
		messages: sanitizeProviderMessagesForRequest(providerMessagesWithPrefillCompatibility(settings, messages)),
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		stream: false,
		...toolRequestFields,
		...(responseFormat ? { response_format: responseFormat } : {}),
		max_completion_tokens: limits.maxCompletionTokens,
		...(reasoning ? { reasoning } : {}),
		temperature: providerCompactionTemperature,
	};
}

export function effectiveReasoningPrefill(bot: Pick<BotDocument, 'handle' | 'inferenceSettings'>): string | undefined {
	if (bot.inferenceSettings.recurringPromptEnabled === false) {
		return undefined;
	}
	const custom = bot.inferenceSettings.recurringPrompt ?
		localizedTextString(bot.inferenceSettings.recurringPrompt)
	:	bot.inferenceSettings.reasoningPrefill;
	return custom && custom.trim() ? custom : defaultReasoningPrefill(bot.handle);
}

export function providerMessagesWithReasoningPrefill(messages: ChatMessage[], reasoningPrefill: string | undefined): ChatMessage[] {
	return reasoningPrefill ? [...messages, { role: 'assistant', content: reasoningPrefill }] : messages;
}

function contextBudgetPromptParts(bot: BotDocument, settings: ProviderSettings): ContextBudgetPromptParts {
	const { tools: providerTools } = providerToolsForBotRound(bot, settings);
	const fixedSystemToolInstructionTools = providerTools;
	const worldPrompt = stringValue('worldPrompt' in bot ? bot.worldPrompt : undefined) ?? '';
	const botWithoutPrompt = { ...bot, prompt: { lang: bot.language, text: '' } };
	const fixedSystemMessage =
		settings.toolCalls === 'at_will'
			? standardPrompt(botWithoutPrompt, '')
			: appendToolRequirementInstruction(standardPrompt(botWithoutPrompt, ''), fixedSystemToolInstructionTools);
	const personaSystemMessage =
		settings.toolCalls === 'at_will'
			? standardPrompt(bot, '')
			: appendToolRequirementInstruction(standardPrompt(bot, ''), fixedSystemToolInstructionTools);
	const fullSystemMessage =
		settings.toolCalls === 'at_will'
			? standardPrompt(bot, worldPrompt)
			: appendToolRequirementInstruction(standardPrompt(bot, worldPrompt), fixedSystemToolInstructionTools);
	return {
		baseUrl: settings.baseUrl,
		fixedSystemMessage,
		fullSystemMessage,
		model: settings.model,
		personaSystemMessage,
		reasoningPrefill: effectiveReasoningPrefill(bot),
		providerTools,
		supportsPrefill: settings.supportsPrefill ?? true,
	};
}

function estimatedPromptContextTokens(
	systemMessage: string,
	reasoningPrefill: string | undefined,
	providerTools: ProviderToolDefinition[],
	calibration: TextTokenCalibration,
): number {
	return (
		estimateChatMessagesTokens(
			providerMessagesWithReasoningPrefill([{ role: 'system', content: systemMessage }], reasoningPrefill),
			calibration,
		) +
		estimateTextTokensWithCalibration(JSON.stringify(providerTools), calibration) +
		providerPromptEstimateSafetyTokens
	);
}

function estimatedMinimumCompactedPromptTokens(parts: ContextBudgetPromptParts, calibration: TextTokenCalibration): number {
	return (
		estimateChatMessagesTokens(
			providerMessagesWithPrefillCompatibility(
				{ baseUrl: parts.baseUrl, model: parts.model, supportsPrefill: parts.supportsPrefill },
				providerMessagesWithReasoningPrefill(
					[
						{ role: 'system', content: parts.fullSystemMessage },
						{ role: 'assistant', content: 'x' },
					],
					parts.reasoningPrefill,
				),
			),
			calibration,
		) +
		estimateTextTokensWithCalibration(JSON.stringify(parts.providerTools), calibration) +
		providerPromptEstimateSafetyTokens
	);
}

export function providerResponseMessageForHistory(response: {
	content?: string;
	reasoning?: string;
	reasoningDetails?: Record<string, unknown>[];
	toolCalls?: BotInferenceSubmissionToolCall[];
}): BotInferenceSubmissionMessage | null {
	const content = repairInvalidUnicodeText(response.content ?? '');
	const reasoning = repairInvalidUnicodeText(response.reasoning ?? '');
	const reasoningDetails = normalizeReasoningDetailsForProviderHistory(response.reasoningDetails ?? []);
	const toolCalls = response.toolCalls ?? [];
	if (!hasProviderHistoryText(content) && !hasProviderHistoryText(reasoning) && reasoningDetails.length === 0 && toolCalls.length === 0) {
		return null;
	}
	const message: BotInferenceSubmissionMessage = { role: 'assistant' };
	if (hasProviderHistoryText(content)) {
		message.content = content;
	} else if (toolCalls.length > 0) {
		message.content = null;
	}
	if (toolCalls.length > 0) {
		message.tool_calls = toolCalls;
	}
	if (reasoningDetails.length > 0) {
		message.reasoning_details = reasoningDetails;
	} else if (hasProviderHistoryText(reasoning)) {
		message.reasoning = reasoning;
	}
	return message;
}

function providerResponseToolCallMessageForHistory(
	message: BotInferenceSubmissionMessage,
	toolCall: ToolCall,
	includeResponseContext: boolean,
): BotInferenceSubmissionMessage {
	if (!includeResponseContext) {
		return {
			role: 'assistant',
			content: null,
			tool_calls: [cloneToolCall(toolCall)],
		};
	}
	const splitMessage: BotInferenceSubmissionMessage = {
		...message,
		tool_calls: [cloneToolCall(toolCall)],
	};
	if (!hasProviderHistoryText(splitMessage.content)) {
		splitMessage.content = null;
	}
	return splitMessage;
}

function normalizeReasoningDetailsForProviderHistory(details: readonly unknown[]): ReasoningDetail[] {
	const normalized: ReasoningDetail[] = [];
	for (const detail of details) {
		const record = repairInvalidUnicodeValue({ ...runtimeRecord(detail) }).value;
		const last = normalized[normalized.length - 1];
		if (
			last &&
			record.type === 'reasoning.text' &&
			last.type === 'reasoning.text' &&
			typeof record.text === 'string' &&
			typeof last.text === 'string' &&
			record.index === last.index &&
			record.format === last.format
		) {
			last.text += record.text;
			continue;
		}
		normalized.push(record);
	}
	return normalized;
}

function reasoningDetailsEqual(left: readonly unknown[] | undefined, right: readonly unknown[]): boolean {
	if (!left || left.length !== right.length) {
		return !left && right.length === 0;
	}
	for (let index = 0; index < left.length; index += 1) {
		if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
			return false;
		}
	}
	return true;
}

type InvalidUnicodeRepair<T> = {
	value: T;
	repairCount: number;
};

export function repairInvalidUnicodeText(text: string): string {
	let repaired = '';
	let lastCopiedIndex = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (isHighSurrogate(code)) {
			const nextCode = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
			if (isLowSurrogate(nextCode)) {
				index += 1;
				continue;
			}
			repaired += `${text.slice(lastCopiedIndex, index)}\uFFFD`;
			lastCopiedIndex = index + 1;
			continue;
		}
		if (isLowSurrogate(code)) {
			repaired += `${text.slice(lastCopiedIndex, index)}\uFFFD`;
			lastCopiedIndex = index + 1;
		}
	}
	return lastCopiedIndex === 0 ? text : repaired + text.slice(lastCopiedIndex);
}

function repairInvalidUnicodeValue<T>(value: T): InvalidUnicodeRepair<T> {
	if (typeof value === 'string') {
		const repaired = repairInvalidUnicodeText(value);
		return {
			value: repaired as T,
			repairCount: repaired === value ? 0 : 1,
		};
	}
	if (Array.isArray(value)) {
		let repairCount = 0;
		let changed = false;
		const repaired = value.map((item) => {
			const itemRepair = repairInvalidUnicodeValue(item);
			repairCount += itemRepair.repairCount;
			if (itemRepair.repairCount > 0) {
				changed = true;
			}
			return itemRepair.value;
		});
		return {
			value: (changed ? repaired : value) as T,
			repairCount,
		};
	}
	if (value && typeof value === 'object') {
		let repairCount = 0;
		let changed = false;
		const repaired: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			const itemRepair = repairInvalidUnicodeValue(item);
			repaired[key] = itemRepair.value;
			repairCount += itemRepair.repairCount;
			if (itemRepair.repairCount > 0) {
				changed = true;
			}
		}
		return {
			value: (changed ? repaired : value) as T,
			repairCount,
		};
	}
	return { value, repairCount: 0 };
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function unicodeSafeSlice(text: string, end: number): string {
	const repaired = repairInvalidUnicodeText(text);
	if (repaired.length <= end) {
		return repaired;
	}
	const safeEnd = Math.max(0, end);
	const adjustedEnd = safeEnd > 0 && isHighSurrogate(repaired.charCodeAt(safeEnd - 1)) ? safeEnd - 1 : safeEnd;
	return repaired.slice(0, adjustedEnd);
}

function sanitizeProviderMessagesForRequest(messages: readonly ChatMessage[]): ChatMessage[] {
	const sanitized = sanitizeProviderMessageSequenceForRequest(messages.map(sanitizeProviderMessageForRequest));
	assertNoInvalidUnicodeValue(sanitized, 'provider request messages');
	return sanitized;
}

function sanitizeProviderMessageForRequest(message: ChatMessage): ChatMessage {
	return flattenDeepProviderToolResultContent(ensureAssistantContentForProviderRequest(repairProviderMessageUnicode(message).value));
}

function sanitizeProviderMessageSequenceForRequest(messages: readonly ChatMessage[]): ChatMessage[] {
	const sanitized: ChatMessage[] = [];
	let nextToolCallId = 1;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]!;
		if (message.role === 'tool') {
			continue;
		}
		if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
			sanitized.push(message);
			continue;
		}

		const toolCallSanitization = sanitizeProviderToolCalls(message.tool_calls);
		const retainedToolCalls = toolCallSanitization.toolCalls.map((toolCall) => {
			// Some providers reject long IDs that only differ late in the string. Compact
			// request-local IDs keep the cacheable prefix stable as new messages append.
			const id = providerRequestToolCallId(nextToolCallId);
			nextToolCallId += 1;
			return id === toolCall.id ? toolCall : { ...toolCall, id };
		});
		const rewrittenIdsByOriginal = new Map<string, string>();
		for (let toolIndex = 0; toolIndex < toolCallSanitization.toolCalls.length; toolIndex += 1) {
			const original = toolCallSanitization.toolCalls[toolIndex]!;
			const retained = retainedToolCalls[toolIndex]!;
			rewrittenIdsByOriginal.set(original.id, retained.id);
		}
		const expectedToolCallIds = new Set(rewrittenIdsByOriginal.keys());
		const toolMessages: ChatMessage[] = [];
		let scan = index + 1;
		while (scan < messages.length) {
			const candidate = messages[scan]!;
			if (candidate.role !== 'tool') {
				break;
			}
			if (candidate.tool_call_id && expectedToolCallIds.delete(candidate.tool_call_id)) {
				toolMessages.push({
					...candidate,
					tool_call_id: rewrittenIdsByOriginal.get(candidate.tool_call_id) ?? candidate.tool_call_id,
				});
			}
			scan += 1;
		}

		if (retainedToolCalls.length > 0) {
			sanitized.push({ ...message, tool_calls: retainedToolCalls });
			sanitized.push(...toolMessages);
		} else {
			const withoutToolCalls = { ...message };
			delete withoutToolCalls.tool_calls;
			if (!isEmptyProviderAssistantMessage(withoutToolCalls)) {
				sanitized.push(withoutToolCalls);
			}
		}
		index = scan - 1;
	}
	return sanitized;
}

function providerRequestToolCallId(index: number): string {
	return `call_${index}`;
}

const providerToolResultJsonMaxStructuredDepth = 32;

function flattenDeepProviderToolResultContent(message: ChatMessage): ChatMessage {
	if (message.role !== 'tool' || typeof message.content !== 'string') {
		return message;
	}
	const flattenedContent = providerToolResultContentForRequest(message.content);
	return flattenedContent === message.content ? message : { ...message, content: flattenedContent };
}

function providerToolResultContentForRequest(content: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content) as unknown;
	} catch {
		return content;
	}
	if (jsonStructuredDepth(parsed) <= providerToolResultJsonMaxStructuredDepth) {
		return content;
	}
	// Google-backed OpenRouter tool responses reject deeply nested function response
	// JSON with INVALID_ARGUMENT. Keep the provider-facing shape shallow while
	// preserving the exact tool result text for the participant.
	return JSON.stringify({ text: content });
}

function jsonStructuredDepth(value: unknown): number {
	let maxDepth = 0;
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	while (stack.length > 0) {
		const current = stack.pop()!;
		const item = current.value;
		if (!item || typeof item !== 'object') {
			continue;
		}
		const depth = current.depth + 1;
		maxDepth = Math.max(maxDepth, depth);
		if (Array.isArray(item)) {
			for (const child of item) {
				stack.push({ value: child, depth });
			}
			continue;
		}
		for (const child of Object.values(item)) {
			stack.push({ value: child, depth });
		}
	}
	return maxDepth;
}

function repairProviderMessageUnicode(message: ChatMessage): InvalidUnicodeRepair<ChatMessage> {
	const messageRepair = repairInvalidUnicodeValue(message);
	let repairedMessage = messageRepair.value;
	let repairCount = messageRepair.repairCount;
	if (repairedMessage.role === 'tool' && typeof repairedMessage.content === 'string') {
		const contentRepair = repairJsonStringUnicode(repairedMessage.content);
		if (contentRepair.repairCount > 0) {
			repairedMessage = { ...repairedMessage, content: contentRepair.value };
			repairCount += contentRepair.repairCount;
		}
	}
	if (Array.isArray(repairedMessage.tool_calls) && repairedMessage.tool_calls.length > 0) {
		const repairedToolCalls = repairToolCallArgumentUnicode(repairedMessage.tool_calls);
		if (repairedToolCalls.repairCount > 0) {
			repairedMessage = { ...repairedMessage, tool_calls: repairedToolCalls.toolCalls };
			repairCount += repairedToolCalls.repairCount;
		}
	}
	return { value: repairedMessage, repairCount };
}

function ensureAssistantContentForProviderRequest(message: ChatMessage): ChatMessage {
	if (message.role !== 'assistant' || typeof message.content === 'string') {
		return message;
	}
	return { ...message, content: '' };
}

function repairJsonStringUnicode(text: string): InvalidUnicodeRepair<string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return { value: text, repairCount: 0 };
	}
	const repair = repairInvalidUnicodeValue(parsed);
	if (repair.repairCount === 0) {
		return { value: text, repairCount: 0 };
	}
	return { value: JSON.stringify(repair.value), repairCount: repair.repairCount };
}

function repairToolCallArgumentUnicode(toolCalls: readonly ToolCall[]): { toolCalls: ToolCall[]; repairCount: number } {
	let repairCount = 0;
	let changed = false;
	const repairedToolCalls = toolCalls.map((toolCall) => {
		const rawArguments = toolCall.function.arguments;
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawArguments) as unknown;
		} catch {
			return toolCall;
		}
		const argumentRepair = repairInvalidUnicodeValue(parsed);
		if (argumentRepair.repairCount === 0) {
			return toolCall;
		}
		repairCount += argumentRepair.repairCount;
		changed = true;
		return toolCallWithArguments(toolCall, JSON.stringify(argumentRepair.value));
	});
	return { toolCalls: changed ? repairedToolCalls : [...toolCalls], repairCount };
}

function assertNoInvalidUnicodeValue(value: unknown, label: string): void {
	if (invalidUnicodePath(value)) {
		throw new Error(`${label} still contains invalid Unicode.`);
	}
}

function stringifyProviderRequest(value: unknown): string {
	assertNoInvalidUnicodeValue(value, 'provider request');
	return JSON.stringify(value);
}

function invalidUnicodePath(value: unknown): boolean {
	if (typeof value === 'string') {
		return repairInvalidUnicodeText(value) !== value;
	}
	if (Array.isArray(value)) {
		return value.some(invalidUnicodePath);
	}
	if (value && typeof value === 'object') {
		return Object.values(value).some(invalidUnicodePath);
	}
	return false;
}

export function sanitizeProviderToolCalls(toolCalls: readonly BotInferenceSubmissionToolCall[]): ProviderToolCallSanitization {
	const sanitized: ToolCall[] = [];
	const dropped: DroppedProviderToolCall[] = [];
	const seenIds = new Set<string>();
	let repairedTextCount = 0;
	for (const toolCall of toolCalls) {
		const functionRecord = runtimeRecord(toolCall.function);
		const rawId = typeof toolCall.id === 'string' && toolCall.id.length > 0 ? toolCall.id : '';
		const id = repairInvalidUnicodeText(rawId);
		if (id !== rawId) {
			repairedTextCount += 1;
		}
		const rawName = stringValue(functionRecord.name) ?? '';
		const name = repairInvalidUnicodeText(rawName);
		if (name !== rawName) {
			repairedTextCount += 1;
		}
		const rawArguments = functionRecord.arguments;
		if (!id) {
			dropped.push(droppedProviderToolCall(id, name, 'missing_tool_call_id', rawArguments));
			continue;
		}
		if (!name) {
			dropped.push(droppedProviderToolCall(id, name, 'missing_function_name', rawArguments));
			continue;
		}
		const argumentText = providerToolCallArgumentsText(rawArguments);
		const argumentTextRepair = repairInvalidUnicodeValue(argumentText);
		repairedTextCount += argumentTextRepair.repairCount;
		let argumentObject: Record<string, unknown>;
		if (argumentTextRepair.value) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(argumentTextRepair.value);
			} catch {
				dropped.push(droppedProviderToolCall(id, name, 'invalid_arguments_json', rawArguments));
				continue;
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				dropped.push(droppedProviderToolCall(id, name, 'arguments_not_json_object', rawArguments));
				continue;
			}
			const parsedRepair = repairInvalidUnicodeValue(sanitizeGeneratedPostingToolArgs(name, parsed as Record<string, unknown>));
			repairedTextCount += parsedRepair.repairCount;
			argumentObject = parsedRepair.value;
		} else {
			argumentObject = {};
		}
		if (seenIds.has(id)) {
			dropped.push(droppedProviderToolCall(id, name, 'duplicate_tool_call', rawArguments));
			continue;
		}
		seenIds.add(id);
		sanitized.push({
			id,
			type: 'function',
			function: {
				name,
				arguments: JSON.stringify(argumentObject),
			},
		});
	}
	return { toolCalls: sanitized, dropped, repairedTextCount };
}

function providerToolCallArgumentsText(rawArguments: unknown): string {
	if (typeof rawArguments === 'string') {
		return rawArguments;
	}
	if (rawArguments === undefined || rawArguments === null) {
		return '';
	}
	return JSON.stringify(rawArguments) ?? '';
}

const leakedProviderCommentRefSuffix = '"},commentRef:';

export function stripLeakedProviderCommentRefSuffix(text: string): string {
	return text.endsWith(leakedProviderCommentRefSuffix) ? text.slice(0, -leakedProviderCommentRefSuffix.length).trimEnd() : text;
}

function sanitizeGeneratedPostingToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
	const canonical = canonicalToolName(name);
	if (canonical !== 'create_thread' && canonical !== 'reply_to_comment' && canonical !== 'make_additional_reply_to_the_same_comment') {
		return args;
	}
	const body = runtimeRecord(args.body);
	const text = typeof body.text === 'string' ? stripLeakedProviderCommentRefSuffix(body.text) : undefined;
	if (text === undefined || text === body.text) {
		return args;
	}
	return {
		...args,
		body: {
			...body,
			text,
		},
	};
}

function sanitizeProviderResponseToolCalls(response: ProviderResponse): {
	response: ProviderResponse;
	dropped: DroppedProviderToolCall[];
	originalToolCallCount: number;
} {
	const originalToolCallCount = response.toolCalls.length;
	const sanitized = sanitizeProviderToolCalls(response.toolCalls);
	const deduped = dedupeGeneratedFollowToolCalls(sanitized.toolCalls);
	const dropped = [...sanitized.dropped, ...deduped.dropped];
	if (toolCallsEqual(response.toolCalls, deduped.toolCalls)) {
		return { response, dropped, originalToolCallCount };
	}
	return {
		response: { ...response, toolCalls: deduped.toolCalls },
		dropped,
		originalToolCallCount,
	};
}

function dedupeGeneratedFollowToolCalls(toolCalls: readonly ToolCall[]): { toolCalls: ToolCall[]; dropped: DroppedProviderToolCall[] } {
	const deduped: ToolCall[] = [];
	const dropped: DroppedProviderToolCall[] = [];
	const seen = new Set<string>();
	for (const toolCall of toolCalls) {
		const canonical = canonicalToolName(toolCall.function.name);
		if (canonical !== 'follow_profile' && canonical !== 'unfollow_profile') {
			deduped.push(toolCall);
			continue;
		}
		let args: Record<string, unknown>;
		let parsed: { targets: FollowToolTarget[]; removedLocalDuplicate: boolean };
		try {
			args = parseToolArgs(toolCall);
			parsed = followToolTargetsForProviderDedupe(args);
		} catch {
			deduped.push(toolCall);
			continue;
		}

		const effectiveTargets: FollowToolTarget[] = [];
		for (const target of parsed.targets) {
			const key = `${canonical}:${target.username}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			effectiveTargets.push(target);
		}
		if (effectiveTargets.length === 0) {
			dropped.push(droppedProviderToolCall(toolCall.id, toolCall.function.name, 'duplicate_tool_call', toolCall.function.arguments));
			continue;
		}
		if (parsed.removedLocalDuplicate || effectiveTargets.length !== parsed.targets.length) {
			deduped.push(
				toolCallWithArguments(toolCall, JSON.stringify(providerToolArgs(canonical, followToolArgsWithTargets(args, effectiveTargets)))),
			);
			continue;
		}
		deduped.push(toolCall);
	}
	return { toolCalls: deduped, dropped };
}

function droppedProviderToolCall(
	id: string | undefined,
	name: string | undefined,
	reason: ProviderToolCallDropReason,
	rawArguments: unknown,
): DroppedProviderToolCall {
	return {
		id: id ?? '',
		name: name ?? '',
		reason,
		argumentsPreview: providerToolCallArgumentsPreview(rawArguments),
	};
}

function providerToolCallArgumentsPreview(rawArguments: unknown): string {
	const text = typeof rawArguments === 'string' ? rawArguments : rawArguments === undefined ? '' : JSON.stringify(rawArguments);
	return safeContextText(text ?? '', 500);
}

function toolCallsEqual(left: readonly ToolCall[], right: readonly ToolCall[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let index = 0; index < left.length; index += 1) {
		const leftCall = left[index];
		const rightCall = right[index];
		if (
			!leftCall ||
			!rightCall ||
			leftCall.id !== rightCall.id ||
			leftCall.type !== rightCall.type ||
			leftCall.function.name !== rightCall.function.name ||
			leftCall.function.arguments !== rightCall.function.arguments
		) {
			return false;
		}
	}
	return true;
}

function repairProviderToolCallHistoryRows(rows: readonly LoopMessageRow[]): ProviderToolCallHistoryRepair {
	const providerRows = rows
		.map((row) => ({ row, message: loopMessageChatMessageFromRow(row) }))
		.filter(({ row, message }) => loopMessageContributesToProviderHistory(row.origin, message));
	const actions: ProviderToolCallHistoryRepairAction[] = [];
	const actionSeqs = new Set<number>();
	const consumedToolRowSeqs = new Set<number>();
	const dropped: DroppedProviderToolCall[] = [];
	let repairedTextCount = 0;
	const repairedMessageSeqs = new Set<number>();
	const deleteRow = (seq: number): void => {
		if (actionSeqs.has(seq)) {
			return;
		}
		actionSeqs.add(seq);
		actions.push({ kind: 'delete', seq });
	};
	const updateRow = (seq: number, message: ChatMessage): void => {
		if (actionSeqs.has(seq)) {
			return;
		}
		actionSeqs.add(seq);
		actions.push({ kind: 'update', seq, message });
	};

	for (let index = 0; index < providerRows.length; index += 1) {
		const current = providerRows[index];
		if (!current) {
			continue;
		}
		let message = current.message;
		let repairedMessage: ChatMessage | null = null;
		const unicodeRepair = repairProviderMessageUnicode(message);
		if (unicodeRepair.repairCount > 0) {
			message = unicodeRepair.value;
			current.message = message;
			repairedMessage = message;
			repairedTextCount += unicodeRepair.repairCount;
			repairedMessageSeqs.add(current.row.seq);
		}
		if (message.role === 'tool') {
			if (!consumedToolRowSeqs.has(current.row.seq)) {
				deleteRow(current.row.seq);
			} else if (repairedMessage) {
				updateRow(current.row.seq, repairedMessage);
			}
			continue;
		}
		if (message.role !== 'assistant') {
			if (repairedMessage) {
				updateRow(current.row.seq, repairedMessage);
			}
			continue;
		}

		const originalReasoningDetails = Array.isArray(message.reasoning_details) ? message.reasoning_details : undefined;
		if (originalReasoningDetails) {
			const normalizedReasoningDetails = normalizeReasoningDetailsForProviderHistory(originalReasoningDetails);
			if (!reasoningDetailsEqual(originalReasoningDetails, normalizedReasoningDetails)) {
				repairedMessage = { ...(repairedMessage ?? message), reasoning_details: normalizedReasoningDetails };
				message = repairedMessage;
				current.message = message;
			}
		}
		if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
			if (repairedMessage) {
				if (isEmptyProviderAssistantMessage(repairedMessage)) {
					deleteRow(current.row.seq);
				} else {
					updateRow(current.row.seq, repairedMessage);
				}
			}
			continue;
		}

		const originalToolCalls = message.tool_calls;
		const sanitized = sanitizeProviderToolCalls(originalToolCalls);
		if (sanitized.repairedTextCount > 0) {
			repairedTextCount += sanitized.repairedTextCount;
			repairedMessageSeqs.add(current.row.seq);
		}
		dropped.push(...sanitized.dropped);
		const availableCallCounts = new Map<string, number>();
		for (const toolCall of sanitized.toolCalls) {
			availableCallCounts.set(toolCall.id, (availableCallCounts.get(toolCall.id) ?? 0) + 1);
		}
		const answeredCallCounts = new Map<string, number>();
		let lookahead = index + 1;
		while (lookahead < providerRows.length) {
			const candidate = providerRows[lookahead];
			if (!candidate || candidate.message.role !== 'tool') {
				break;
			}
			const toolCallId = typeof candidate.message.tool_call_id === 'string' ? candidate.message.tool_call_id : '';
			const answeredCount = answeredCallCounts.get(toolCallId) ?? 0;
			const availableCount = availableCallCounts.get(toolCallId) ?? 0;
			if (toolCallId && answeredCount < availableCount) {
				answeredCallCounts.set(toolCallId, answeredCount + 1);
				consumedToolRowSeqs.add(candidate.row.seq);
			} else {
				deleteRow(candidate.row.seq);
			}
			lookahead += 1;
		}

		const remainingAnsweredCallCounts = new Map(answeredCallCounts);
		const repairedToolCalls: ToolCall[] = [];
		for (const toolCall of sanitized.toolCalls) {
			const remainingCount = remainingAnsweredCallCounts.get(toolCall.id) ?? 0;
			if (remainingCount > 0) {
				remainingAnsweredCallCounts.set(toolCall.id, remainingCount - 1);
				repairedToolCalls.push(toolCall);
			} else {
				dropped.push(droppedProviderToolCall(toolCall.id, toolCall.function.name, 'unanswered_tool_call', toolCall.function.arguments));
			}
		}
		if (toolCallsEqual(originalToolCalls, repairedToolCalls)) {
			if (repairedMessage) {
				if (isEmptyProviderAssistantMessage(repairedMessage)) {
					deleteRow(current.row.seq);
				} else {
					updateRow(current.row.seq, repairedMessage);
				}
			}
			continue;
		}

		repairedMessage = repairedMessage ?? { ...message };
		if (repairedToolCalls.length > 0) {
			repairedMessage.tool_calls = repairedToolCalls;
		} else {
			delete repairedMessage.tool_calls;
		}
		if (isEmptyProviderAssistantMessage(repairedMessage)) {
			deleteRow(current.row.seq);
		} else {
			updateRow(current.row.seq, repairedMessage);
		}
	}

	return { actions, dropped, repairedTextCount, repairedMessageSeqs: [...repairedMessageSeqs] };
}

export function loopMessageContributesToProviderHistory(origin: BotLoopMessageOrigin, message: BotInferenceSubmissionMessage): boolean {
	if (origin === 'runtime_error') {
		return false;
	}
	return origin !== 'provider_response' || !isEmptyProviderAssistantMessage(message);
}

function loopMessageContributesToCompactionProviderInput(row: LoopMessageRow): boolean {
	const message = loopMessageChatMessageFromRow(row);
	return loopMessageContributesToProviderHistory(row.origin, message);
}

export function runtimeErrorLoopMessageContent(message: unknown): string {
	const text = runtimeErrorText(message);
	if (/^Inference failed after \d+ provider attempts\b/.test(text) || /^Inference failed before retrying\b/.test(text)) {
		return safeContextText(text, 1_200);
	}
	return `${runtimeDiagnosticPrefix(text)}: ${safeContextText(text, 1_200)}`;
}

function runtimeDiagnosticPrefix(message: string): string {
	if (/^Inference (provider|request|response|stream)\b/.test(message) || /^Provider\b/.test(message)) {
		return 'Inference provider returned an error';
	}
	if (/^Prompt context\b/.test(message)) {
		return 'Inference request failed';
	}
	return 'Runtime failed';
}

function isEmptyProviderAssistantMessage(message: BotInferenceSubmissionMessage): boolean {
	return (
		message.role === 'assistant' &&
		!hasProviderHistoryText(message.content) &&
		!hasProviderHistoryText(message.reasoning) &&
		!hasProviderHistoryText(message.reasoning_content) &&
		(!Array.isArray(message.reasoning_details) || message.reasoning_details.length === 0) &&
		(!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)
	);
}

export function rewriteProviderResponseToolCallMessage(
	message: BotInferenceSubmissionMessage,
	rewrite: ProviderToolCallRewrite,
): ProviderResponseToolCallRewriteResult {
	if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
		return { kind: 'unchanged', message };
	}

	let changed = false;
	const nextToolCalls: ToolCall[] = [];
	for (const toolCall of message.tool_calls) {
		if (toolCall.id !== rewrite.toolCallId) {
			nextToolCalls.push(cloneToolCall(toolCall));
			continue;
		}
		changed = true;
		if (rewrite.kind === 'replace_arguments') {
			nextToolCalls.push(toolCallWithArguments(toolCall, rewrite.arguments));
		}
	}
	if (!changed) {
		return { kind: 'unchanged', message };
	}

	const nextMessage: BotInferenceSubmissionMessage = { ...message };
	if (nextToolCalls.length > 0) {
		nextMessage.tool_calls = nextToolCalls;
	} else {
		delete nextMessage.tool_calls;
	}
	if (isEmptyProviderAssistantMessage(nextMessage)) {
		return { kind: 'deleted' };
	}
	return { kind: 'updated', message: nextMessage };
}

function toolCallWithArguments(toolCall: ToolCall, args: string): ToolCall {
	return {
		id: toolCall.id,
		type: toolCall.type,
		function: {
			name: toolCall.function.name,
			arguments: args,
		},
	};
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
	return toolCallWithArguments(toolCall, toolCall.function.arguments);
}

function hasProviderHistoryText(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function providerResponseIsEmpty(response: Pick<ProviderResponse, 'content' | 'reasoning' | 'reasoningDetails' | 'toolCalls'>): boolean {
	return providerResponsePartsAreEmpty(response.content, response.reasoning, response.reasoningDetails, response.toolCalls);
}

function providerResponsePartsAreEmpty(
	content: unknown,
	reasoning: unknown,
	reasoningDetails: readonly unknown[],
	toolCalls: readonly unknown[],
): boolean {
	return !hasProviderHistoryText(content) && !hasProviderHistoryText(reasoning) && reasoningDetails.length === 0 && toolCalls.length === 0;
}

function appendRawResponsePreview(current: string, next: string): string {
	if (current.length >= providerFailureRawResponseMaxCharacters) {
		return current;
	}
	return `${current}${next}`.slice(0, providerFailureRawResponseMaxCharacters);
}

export function providerTokenProbeRequest(
	settings: ProviderSettings,
	messages: ChatMessage[],
	tools: ProviderToolDefinition[],
): ProviderTokenProbeRequest {
	const reasoning = providerReasoningForSettings(settings);
	return {
		model: settings.model,
		messages: sanitizeProviderMessagesForRequest(providerMessagesWithPrefillCompatibility(settings, messages)),
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		tools,
		tool_choice: providerTokenProbeToolChoice,
		parallel_tool_calls: providerParallelToolCalls,
		stream: false,
		max_tokens: 1,
		...(reasoning ? { reasoning } : {}),
		temperature: settings.temperature,
		...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
		...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
		...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
		...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
		...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
		...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
	};
}

function providerTranslationTools(): [ProviderToolDefinition] {
	return [
		{
			type: 'function',
			function: {
				name: providerTranslationToolName,
				description: 'Save the translated text.',
				parameters: {
					type: 'object',
					properties: {
						translation: { type: 'string' },
					},
					required: ['translation'],
					additionalProperties: false,
				},
			},
		},
	];
}

export function providerTranslationRequest(settings: TranslationProviderSettings, text: string): ProviderTranslationRequest {
	const toolCalls = effectiveStructuredToolCallsForModel(settings.model, settingsUseOpenRouter(settings), settings.toolCalls ?? 'require');
	const toolChoice = providerToolChoiceForMode(toolCalls);
	const reasoning = providerReasoningForSettings(settings);
	return {
		model: settings.model,
		messages: [
			{ role: 'system', content: appendToolRequirementInstruction(settings.prompt, providerTranslationTools()) },
			{
				role: 'user',
				content: `Translate the following text. You must respond by calling the ${providerTranslationToolName} tool with the translated text in the translation argument. Do not reply as plain text.\n\nText:\n${text}`,
			},
		],
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		stream: false,
		tools: providerTranslationTools(),
		...(toolChoice ? { tool_choice: toolChoice } : {}),
		parallel_tool_calls: false,
		max_completion_tokens: providerTranslationMaxCompletionTokens,
		...(reasoning ? { reasoning } : {}),
		temperature: settings.temperature,
		...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
		...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
		...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
		...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
		...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
		...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
	};
}

export function promptContextBudgetFromCounts(
	input: PromptContextBudgetCounts,
): Pick<
	BotContextBudget,
	| 'fixedSystemTokens'
	| 'overBudgetTokens'
	| 'personaPromptTokens'
	| 'remainingLoopTokens'
	| 'responseReserveTokens'
	| 'totalReservedTokens'
	| 'worldPromptTokens'
> {
	const fixedSystemTokens = Math.max(0, Math.floor(input.fixedSystemTokens));
	const personaPromptTokens = Math.max(0, Math.floor(input.personaPromptTokens));
	const worldPromptTokens = Math.max(0, Math.floor(input.worldPromptTokens ?? 0));
	const responseReserveTokens = Math.max(0, Math.floor(input.responseReserveTokens));
	const contextWindowTokens = Math.max(0, Math.floor(input.contextWindowTokens));
	const totalReservedTokens = fixedSystemTokens + personaPromptTokens + worldPromptTokens + responseReserveTokens;
	return {
		fixedSystemTokens,
		personaPromptTokens,
		worldPromptTokens,
		responseReserveTokens,
		totalReservedTokens,
		remainingLoopTokens: Math.max(0, contextWindowTokens - totalReservedTokens),
		overBudgetTokens: Math.max(0, totalReservedTokens - contextWindowTokens),
	};
}

export async function promptContextBudgetCacheFingerprint(parts: PromptContextBudgetFingerprintParts): Promise<string> {
	return sha256Hex(JSON.stringify(parts));
}

export function effectiveProviderSettingsForBot(
	bot: Pick<BotDocument, 'inferenceSettings'>,
	owner: Pick<UserDocument, 'inferenceSettings'>,
	env: Pick<Env, 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
): ProviderSettings {
	const userSettings = owner.inferenceSettings ?? {};
	const envModel = trimmed(env.OPENROUTER_MODEL);
	const envBaseUrl = trimmed(env.OPENROUTER_BASE_URL);
	const envApiKey = trimmed(env.OPENROUTER_API_KEY);
	const userModel = trimmed(userSettings.model);
	const botModel = trimmed(bot.inferenceSettings.model);
	const userBaseUrl = trimmed(userSettings.baseUrl);
	const botBaseUrl = trimmed(bot.inferenceSettings.baseUrl);
	const userApiKey = trimmed(userSettings.openRouterApiKey);
	const botApiKey = trimmed(bot.inferenceSettings.openRouterApiKey);
	const botTemperatureIsLegacyDefault = bot.inferenceSettings.temperature === legacyDefaultTextGenerationTemperature;
	const hasUserProvider = Boolean(userApiKey || userBaseUrl);
	const hasBotOrInheritedProvider = Boolean(botApiKey || botBaseUrl || hasUserProvider);
	const hasCustomBaseUrl = Boolean(botBaseUrl || userBaseUrl);
	const inheritedDefaults: BotInferenceSettings = botModel ? {} : userSettings;

	const model =
		botModel && hasBotOrInheritedProvider
			? botModel
			: userModel && hasUserProvider
				? userModel
				: envModel
					? envModel
					: fallbackProviderModel;
	const baseUrl = botBaseUrl ?? userBaseUrl ?? envBaseUrl ?? fallbackProviderBaseUrl;
	const temperature =
		bot.inferenceSettings.temperature !== undefined && (!botTemperatureIsLegacyDefault || userSettings.temperature === undefined)
			? bot.inferenceSettings.temperature
			: inheritedDefaults.temperature !== undefined
				? inheritedDefaults.temperature
				: bot.inferenceSettings.temperature !== undefined
					? bot.inferenceSettings.temperature
					: defaultTextGenerationTemperature;
	const providerRouting =
		bot.inferenceSettings.providerRouting !== undefined ? bot.inferenceSettings.providerRouting : inheritedDefaults.providerRouting;
	const effectiveProviderRouting = openRouterProviderRouting(baseUrl, providerRouting);
	const openRouterBaseUrl = isOpenRouterProviderBaseUrl(baseUrl);
	const reasoningEffort = effectiveReasoningEffortForModel(
		model,
		openRouterBaseUrl,
		bot.inferenceSettings.reasoningEffort ?? inheritedDefaults.reasoningEffort,
		effectiveProviderRouting,
	);
	const toolCalls = effectiveToolCallsForModel(
		model,
		openRouterBaseUrl,
		bot.inferenceSettings.toolCalls ?? inheritedDefaults.toolCalls,
		effectiveProviderRouting,
	);
	const compactionMode = effectiveCompactionModeForModel(
		model,
		openRouterBaseUrl,
		bot.inferenceSettings.compactionMode ?? inheritedDefaults.compactionMode,
		effectiveProviderRouting,
	);
	const promptCacheMode = modelSupportsPromptCacheControl(model, openRouterBaseUrl)
		? bot.inferenceSettings.promptCacheMode ?? inheritedDefaults.promptCacheMode
		: undefined;
	const supportsPrefill = effectiveSupportsPrefillForModel(
		model,
		openRouterBaseUrl,
		bot.inferenceSettings.supportsPrefill ?? inheritedDefaults.supportsPrefill,
		effectiveProviderRouting,
	);

	return {
		apiKey: botApiKey ?? userApiKey ?? (hasCustomBaseUrl ? undefined : envApiKey),
		baseUrl,
		model,
		compactionMode,
		...(promptCacheMode && promptCacheMode !== 'off' ? { promptCacheMode } : {}),
		...(effectiveProviderRouting ? { providerRouting: effectiveProviderRouting } : {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
		supportsPrefill,
		toolCalls,
		temperature,
		...(hasCustomBaseUrl ? { usesCustomBaseUrl: true } : {}),
		...(bot.inferenceSettings.topK !== undefined
			? { topK: bot.inferenceSettings.topK }
			: inheritedDefaults.topK !== undefined
				? { topK: inheritedDefaults.topK }
				: {}),
		...(bot.inferenceSettings.topP !== undefined
			? { topP: bot.inferenceSettings.topP }
			: inheritedDefaults.topP !== undefined
				? { topP: inheritedDefaults.topP }
				: {}),
		...(bot.inferenceSettings.minP !== undefined
			? { minP: bot.inferenceSettings.minP }
			: inheritedDefaults.minP !== undefined
				? { minP: inheritedDefaults.minP }
				: {}),
		...(bot.inferenceSettings.frequencyPenalty !== undefined
			? { frequencyPenalty: bot.inferenceSettings.frequencyPenalty }
			: inheritedDefaults.frequencyPenalty !== undefined
				? { frequencyPenalty: inheritedDefaults.frequencyPenalty }
				: {}),
		...(bot.inferenceSettings.presencePenalty !== undefined
			? { presencePenalty: bot.inferenceSettings.presencePenalty }
			: inheritedDefaults.presencePenalty !== undefined
				? { presencePenalty: inheritedDefaults.presencePenalty }
				: {}),
		...(bot.inferenceSettings.repetitionPenalty !== undefined
			? { repetitionPenalty: bot.inferenceSettings.repetitionPenalty }
			: inheritedDefaults.repetitionPenalty !== undefined
				? { repetitionPenalty: inheritedDefaults.repetitionPenalty }
				: {}),
	};
}

export function effectiveProviderSettingsForTranslation(
	user: Pick<UserDocument, 'inferenceSettings'>,
	env: Pick<Env, 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
): TranslationProviderSettings | null {
	const userSettings = user.inferenceSettings ?? {};
	const translation = userSettings.translation;
	if (!translation?.enabled) {
		return null;
	}
	const translationModel = trimmed(translation.model);
	const userModel = trimmed(userSettings.model);
	const envModel = trimmed(env.OPENROUTER_MODEL);
	const userBaseUrl = trimmed(userSettings.baseUrl);
	const envBaseUrl = trimmed(env.OPENROUTER_BASE_URL);
	const userApiKey = trimmed(userSettings.openRouterApiKey);
	const envApiKey = trimmed(env.OPENROUTER_API_KEY);
	const hasCustomBaseUrl = Boolean(userBaseUrl);
	const baseUrl = userBaseUrl ?? envBaseUrl ?? fallbackProviderBaseUrl;
	const model = translationModel ?? userModel ?? envModel ?? fallbackProviderModel;
	const usingLoopSettings = !translationModel;
	const openRouterBaseUrl = isOpenRouterProviderBaseUrl(baseUrl);
	const providerRouting = openRouterProviderRouting(
		baseUrl,
		usingLoopSettings ? userSettings.providerRouting : translation.providerRouting,
	);
	const reasoningEffort = effectiveReasoningEffortForModel(
		model,
		openRouterBaseUrl,
		usingLoopSettings ? userSettings.reasoningEffort : translation.reasoningEffort,
	);
	const toolCalls = effectiveStructuredToolCallsForModel(
		model,
		openRouterBaseUrl,
		usingLoopSettings ? userSettings.toolCalls : translation.toolCalls,
	);
	return {
		apiKey: userApiKey ?? (hasCustomBaseUrl ? undefined : envApiKey),
		baseUrl,
		model,
		...(providerRouting ? { providerRouting } : {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
		toolCalls,
		prompt: trimmed(translation?.prompt ? localizedTextString(translation.prompt) : undefined) ?? defaultTranslationPrompt,
		temperature: usingLoopSettings ? (userSettings.temperature ?? defaultTextGenerationTemperature) : (translation.temperature ?? 0),
		...(usingLoopSettings
			? {
					...(userSettings.topK !== undefined ? { topK: userSettings.topK } : {}),
					...(userSettings.topP !== undefined ? { topP: userSettings.topP } : {}),
					...(userSettings.minP !== undefined ? { minP: userSettings.minP } : {}),
					...(userSettings.frequencyPenalty !== undefined ? { frequencyPenalty: userSettings.frequencyPenalty } : {}),
					...(userSettings.presencePenalty !== undefined ? { presencePenalty: userSettings.presencePenalty } : {}),
					...(userSettings.repetitionPenalty !== undefined ? { repetitionPenalty: userSettings.repetitionPenalty } : {}),
				}
			: {
					...(translation.topK !== undefined ? { topK: translation.topK } : {}),
					...(translation.topP !== undefined ? { topP: translation.topP } : {}),
					...(translation.minP !== undefined ? { minP: translation.minP } : {}),
					...(translation.frequencyPenalty !== undefined ? { frequencyPenalty: translation.frequencyPenalty } : {}),
					...(translation.presencePenalty !== undefined ? { presencePenalty: translation.presencePenalty } : {}),
					...(translation.repetitionPenalty !== undefined ? { repetitionPenalty: translation.repetitionPenalty } : {}),
				}),
	};
}

function effectiveProviderSettingsForImageGeneration(
	bot: Pick<BotDocument, 'inferenceSettings'>,
	owner: Pick<UserDocument, 'inferenceSettings'>,
	env: Pick<Env, 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	settingsOverride?: BotInferenceSettings['imageGeneration'],
): ImageGenerationProviderSettings | null {
	const userSettings = owner.inferenceSettings ?? {};
	const imageGeneration = avatarImageGenerationSettingsWithDefaults(
		settingsOverride ?? bot.inferenceSettings.imageGeneration ?? userSettings.imageGeneration,
	);
	const model = trimmed(imageGeneration?.model);
	if (!model) {
		return null;
	}
	const userBaseUrl = trimmed(userSettings.baseUrl);
	const botBaseUrl = trimmed(bot.inferenceSettings.baseUrl);
	const envBaseUrl = trimmed(env.OPENROUTER_BASE_URL);
	const userApiKey = trimmed(userSettings.openRouterApiKey);
	const botApiKey = trimmed(bot.inferenceSettings.openRouterApiKey);
	const envApiKey = trimmed(env.OPENROUTER_API_KEY);
	const hasCustomBaseUrl = Boolean(botBaseUrl || userBaseUrl);
	const baseUrl = botBaseUrl ?? userBaseUrl ?? envBaseUrl ?? fallbackProviderBaseUrl;
	const providerRouting = openRouterProviderRouting(baseUrl, imageGeneration.providerRouting);
	const settings: ImageGenerationProviderSettings = {
		apiKey: botApiKey ?? userApiKey ?? (hasCustomBaseUrl ? undefined : envApiKey),
		baseUrl,
		model,
		...(providerRouting ? { providerRouting } : {}),
		...(trimmed(imageGeneration.aspectRatio) ? { aspectRatio: trimmed(imageGeneration.aspectRatio) } : {}),
		...(trimmed(imageGeneration.imageSize) ? { imageSize: trimmed(imageGeneration.imageSize) } : {}),
		...(imageGeneration.temperature !== undefined ? { temperature: imageGeneration.temperature } : {}),
		...(imageGeneration.topK !== undefined ? { topK: imageGeneration.topK } : {}),
		...(imageGeneration.topP !== undefined ? { topP: imageGeneration.topP } : {}),
		...(imageGeneration.minP !== undefined ? { minP: imageGeneration.minP } : {}),
		...(imageGeneration.frequencyPenalty !== undefined ? { frequencyPenalty: imageGeneration.frequencyPenalty } : {}),
		...(imageGeneration.presencePenalty !== undefined ? { presencePenalty: imageGeneration.presencePenalty } : {}),
		...(imageGeneration.repetitionPenalty !== undefined ? { repetitionPenalty: imageGeneration.repetitionPenalty } : {}),
	};
	return settings;
}

function effectiveProviderSettingsForWorldImageGeneration(
	world: Pick<WorldDocument, 'imageGeneration'>,
	owner: Pick<UserDocument, 'inferenceSettings'>,
	env: Pick<Env, 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	settingsOverride?: BotInferenceSettings['imageGeneration'],
): ImageGenerationProviderSettings | null {
	const userSettings = owner.inferenceSettings ?? {};
	const imageGeneration = worldAvatarImageGenerationSettingsWithDefaults(settingsOverride ?? world.imageGeneration ?? userSettings.imageGeneration);
	const model = trimmed(imageGeneration?.model);
	if (!model) {
		return null;
	}
	const userBaseUrl = trimmed(userSettings.baseUrl);
	const envBaseUrl = trimmed(env.OPENROUTER_BASE_URL);
	const userApiKey = trimmed(userSettings.openRouterApiKey);
	const envApiKey = trimmed(env.OPENROUTER_API_KEY);
	const baseUrl = userBaseUrl ?? envBaseUrl ?? fallbackProviderBaseUrl;
	const providerRouting = openRouterProviderRouting(baseUrl, imageGeneration.providerRouting);
	const settings: ImageGenerationProviderSettings = {
		apiKey: userApiKey ?? (userBaseUrl ? undefined : envApiKey),
		baseUrl,
		model,
		...(providerRouting ? { providerRouting } : {}),
		...(trimmed(imageGeneration.aspectRatio) ? { aspectRatio: trimmed(imageGeneration.aspectRatio) } : {}),
		...(trimmed(imageGeneration.imageSize) ? { imageSize: trimmed(imageGeneration.imageSize) } : {}),
		...(imageGeneration.temperature !== undefined ? { temperature: imageGeneration.temperature } : {}),
		...(imageGeneration.topK !== undefined ? { topK: imageGeneration.topK } : {}),
		...(imageGeneration.topP !== undefined ? { topP: imageGeneration.topP } : {}),
		...(imageGeneration.minP !== undefined ? { minP: imageGeneration.minP } : {}),
		...(imageGeneration.frequencyPenalty !== undefined ? { frequencyPenalty: imageGeneration.frequencyPenalty } : {}),
		...(imageGeneration.presencePenalty !== undefined ? { presencePenalty: imageGeneration.presencePenalty } : {}),
		...(imageGeneration.repetitionPenalty !== undefined ? { repetitionPenalty: imageGeneration.repetitionPenalty } : {}),
	};
	return settings;
}

function effectiveProviderSettingsForUserImageGeneration(
	user: Pick<UserDocument, 'inferenceSettings'>,
	env: Pick<Env, 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	settingsOverride?: BotInferenceSettings['imageGeneration'],
): ImageGenerationProviderSettings | null {
	const userSettings = user.inferenceSettings ?? {};
	const imageGeneration = avatarImageGenerationSettingsWithDefaults(settingsOverride ?? userSettings.imageGeneration);
	const model = trimmed(imageGeneration?.model);
	if (!model) {
		return null;
	}
	const userBaseUrl = trimmed(userSettings.baseUrl);
	const envBaseUrl = trimmed(env.OPENROUTER_BASE_URL);
	const userApiKey = trimmed(userSettings.openRouterApiKey);
	const envApiKey = trimmed(env.OPENROUTER_API_KEY);
	const baseUrl = userBaseUrl ?? envBaseUrl ?? fallbackProviderBaseUrl;
	const providerRouting = openRouterProviderRouting(baseUrl, imageGeneration.providerRouting);
	const settings: ImageGenerationProviderSettings = {
		apiKey: userApiKey ?? (userBaseUrl ? undefined : envApiKey),
		baseUrl,
		model,
		...(providerRouting ? { providerRouting } : {}),
		...(trimmed(imageGeneration.aspectRatio) ? { aspectRatio: trimmed(imageGeneration.aspectRatio) } : {}),
		...(trimmed(imageGeneration.imageSize) ? { imageSize: trimmed(imageGeneration.imageSize) } : {}),
		...(imageGeneration.temperature !== undefined ? { temperature: imageGeneration.temperature } : {}),
		...(imageGeneration.topK !== undefined ? { topK: imageGeneration.topK } : {}),
		...(imageGeneration.topP !== undefined ? { topP: imageGeneration.topP } : {}),
		...(imageGeneration.minP !== undefined ? { minP: imageGeneration.minP } : {}),
		...(imageGeneration.frequencyPenalty !== undefined ? { frequencyPenalty: imageGeneration.frequencyPenalty } : {}),
		...(imageGeneration.presencePenalty !== undefined ? { presencePenalty: imageGeneration.presencePenalty } : {}),
		...(imageGeneration.repetitionPenalty !== undefined ? { repetitionPenalty: imageGeneration.repetitionPenalty } : {}),
	};
	return settings;
}

function effectiveProviderSettingsForWorldPrompt(
	owner: Pick<UserDocument, 'inferenceSettings'>,
	env: Pick<Env, 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	settingsOverride?: BotInferenceSettingsInput,
): ProviderSettings {
	const userSettings = owner.inferenceSettings ?? {};
	const requestSettings = settingsOverride ? mergeInferenceSettings(userSettings, settingsOverride) : userSettings;
	const envModel = trimmed(env.OPENROUTER_MODEL);
	const envBaseUrl = trimmed(env.OPENROUTER_BASE_URL);
	const envApiKey = trimmed(env.OPENROUTER_API_KEY);
	const userModel = trimmed(userSettings.model);
	const requestModel = trimmed(requestSettings.model);
	const requestBaseUrl = trimmed(requestSettings.baseUrl);
	const requestApiKey = trimmed(requestSettings.openRouterApiKey);
	const userBaseUrl = trimmed(userSettings.baseUrl);
	const userApiKey = trimmed(userSettings.openRouterApiKey);
	const model =
		settingsOverride !== undefined ? requestModel ?? envModel ?? fallbackProviderModel
		: userModel && (userApiKey || userBaseUrl) ? userModel
		: envModel || fallbackProviderModel;
	const baseUrl = requestBaseUrl ?? envBaseUrl ?? fallbackProviderBaseUrl;
	const openRouterBaseUrl = isOpenRouterProviderBaseUrl(baseUrl);
	const providerRouting = openRouterProviderRouting(baseUrl, requestSettings.providerRouting);
	const reasoningEffort = effectiveReasoningEffortForModel(model, openRouterBaseUrl, requestSettings.reasoningEffort, providerRouting);
	const toolCalls = effectiveToolCallsForModel(model, openRouterBaseUrl, requestSettings.toolCalls, providerRouting);
	const compactionMode = effectiveCompactionModeForModel(model, openRouterBaseUrl, requestSettings.compactionMode, providerRouting);
	const supportsPrefill = effectiveSupportsPrefillForModel(model, openRouterBaseUrl, requestSettings.supportsPrefill, providerRouting);
	return {
		apiKey: requestApiKey ?? (requestBaseUrl ? undefined : envApiKey),
		baseUrl,
		model,
		compactionMode,
		...(providerRouting ? { providerRouting } : {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
		supportsPrefill,
		toolCalls,
		temperature: requestSettings.temperature ?? defaultTextGenerationTemperature,
		...(requestBaseUrl ? { usesCustomBaseUrl: true } : {}),
		...(requestSettings.topK !== undefined ? { topK: requestSettings.topK } : {}),
		...(requestSettings.topP !== undefined ? { topP: requestSettings.topP } : {}),
		...(requestSettings.minP !== undefined ? { minP: requestSettings.minP } : {}),
		...(requestSettings.frequencyPenalty !== undefined ? { frequencyPenalty: requestSettings.frequencyPenalty } : {}),
		...(requestSettings.presencePenalty !== undefined ? { presencePenalty: requestSettings.presencePenalty } : {}),
		...(requestSettings.repetitionPenalty !== undefined ? { repetitionPenalty: requestSettings.repetitionPenalty } : {}),
	};
}

function publicPromptProviderSettings(settings: ProviderSettings): BotInferenceSettings {
	return {
		baseUrl: settings.baseUrl,
		model: settings.model,
		compactionMode: settings.compactionMode,
		...(settings.promptCacheMode ? { promptCacheMode: settings.promptCacheMode } : {}),
		...(settings.providerRouting ? { providerRouting: settings.providerRouting } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
		supportsPrefill: settings.supportsPrefill,
		toolCalls: settings.toolCalls,
		temperature: settings.temperature,
		...(settings.topK !== undefined ? { topK: settings.topK } : {}),
		...(settings.topP !== undefined ? { topP: settings.topP } : {}),
		...(settings.minP !== undefined ? { minP: settings.minP } : {}),
		...(settings.frequencyPenalty !== undefined ? { frequencyPenalty: settings.frequencyPenalty } : {}),
		...(settings.presencePenalty !== undefined ? { presencePenalty: settings.presencePenalty } : {}),
		...(settings.repetitionPenalty !== undefined ? { repetitionPenalty: settings.repetitionPenalty } : {}),
	};
}

function openRouterProviderRouting(baseUrl: string, providerRouting: JsonObject | undefined): JsonObject | undefined {
	if (!providerRouting || Object.keys(providerRouting).length === 0 || !isOpenRouterProviderBaseUrl(baseUrl)) {
		return undefined;
	}
	return providerRouting;
}

const runtimeSchema = `
CREATE TABLE IF NOT EXISTS events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	type TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	token_estimate INTEGER NOT NULL,
	compacted_by INTEGER,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id, seq);
CREATE INDEX IF NOT EXISTS events_compaction ON events (compacted_by, seq);
CREATE TABLE IF NOT EXISTS runtime_state (
	key TEXT PRIMARY KEY,
	value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS injections (
	id TEXT PRIMARY KEY,
	text TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'manual',
	source_id TEXT,
	spotlight_id TEXT,
	created_at TEXT NOT NULL,
	consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS provider_usage (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	request_seq INTEGER NOT NULL,
	provider_response_id TEXT,
	requested_model TEXT NOT NULL,
	response_model TEXT,
	model TEXT NOT NULL,
	context_window_tokens INTEGER NOT NULL,
	provider_base_url TEXT NOT NULL,
	provider_name TEXT,
	prompt_tokens INTEGER NOT NULL,
	completion_tokens INTEGER NOT NULL,
	total_tokens INTEGER NOT NULL,
	cached_tokens INTEGER NOT NULL DEFAULT 0,
	reasoning_tokens INTEGER NOT NULL DEFAULT 0,
	cost REAL,
	usage_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_usage_created_at ON provider_usage (created_at);
CREATE INDEX IF NOT EXISTS provider_usage_model_context ON provider_usage (model, context_window_tokens, created_at);
CREATE TABLE IF NOT EXISTS provider_token_calibration_samples (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	request_seq INTEGER NOT NULL,
	attempt INTEGER NOT NULL,
	purpose TEXT NOT NULL,
	requested_model TEXT NOT NULL,
	response_model TEXT,
	provider_base_url TEXT NOT NULL,
	prompt_tokens INTEGER NOT NULL,
	request_characters INTEGER NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_token_calibration_samples_model ON provider_token_calibration_samples (requested_model, id);
CREATE TABLE IF NOT EXISTS inference_submissions (
	id TEXT PRIMARY KEY,
	event_seq INTEGER NOT NULL UNIQUE,
	run_id TEXT NOT NULL,
	purpose TEXT NOT NULL,
	model TEXT NOT NULL,
	provider_base_url TEXT NOT NULL,
	message_count INTEGER NOT NULL,
	messages_json TEXT NOT NULL,
	display_messages_json TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inference_submissions_created_at ON inference_submissions (created_at);
CREATE INDEX IF NOT EXISTS inference_submissions_run ON inference_submissions (run_id, event_seq);
CREATE TABLE IF NOT EXISTS loop_messages (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	position INTEGER NOT NULL,
	run_id TEXT NOT NULL,
	role TEXT NOT NULL,
	message_json TEXT NOT NULL,
	origin TEXT NOT NULL,
	status TEXT,
	token_estimate INTEGER NOT NULL,
	stream_seq INTEGER,
	display_event_seq INTEGER,
	compacted_by INTEGER,
	deleted_at TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS loop_messages_active ON loop_messages (compacted_by, position, seq);
CREATE INDEX IF NOT EXISTS loop_messages_run ON loop_messages (run_id, seq);
CREATE TABLE IF NOT EXISTS loop_message_logs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	message_seq INTEGER NOT NULL,
	kind TEXT NOT NULL,
	encoding TEXT NOT NULL,
	base_log_id INTEGER,
	prefix_length INTEGER,
	text_length INTEGER NOT NULL,
	chunk_count INTEGER NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS loop_message_logs_message ON loop_message_logs (message_seq, id);
CREATE INDEX IF NOT EXISTS loop_message_logs_kind ON loop_message_logs (kind, id);
CREATE TABLE IF NOT EXISTS loop_message_log_chunks (
	log_id INTEGER NOT NULL,
	chunk_index INTEGER NOT NULL,
	text TEXT NOT NULL,
	PRIMARY KEY (log_id, chunk_index)
);
`;

export class BotRuntime {
	private readonly state: DurableObjectState;
	private readonly env: Env;
	private activeAbortController: AbortController | null = null;
	private activeRunId: string | null = null;
	private activeMaintenanceOperation: ActiveMaintenanceOperation | null = null;
	private readonly activeStreamActivity = new Map<string, string>();
	private ephemeralStreamSeq = 0;
	private transitionQueue = new ExclusiveOperationQueue();

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.state.blockConcurrencyWhile(async () => {
			for (const statement of runtimeSchema.split(';')) {
				const sql = statement.trim();
				if (sql) {
					this.state.storage.sql.exec(sql);
				}
			}
			this.ensureInjectionColumns();
			this.ensureProviderUsageColumns();
			this.ensureInferenceSubmissionColumns();
			this.ensureLoopMessageColumns();
			this.migrateLegacyLoopMessages();
			this.backfillProviderTokenCalibrationSamples();
		});
	}

	private ensureInjectionColumns(): void {
		const columns = new Set(
			this.state.storage.sql
				.exec<{ name: string }>(`PRAGMA table_info(injections)`)
				.toArray()
				.map((row) => row.name),
		);
		if (!columns.has('kind')) {
			this.state.storage.sql.exec(`ALTER TABLE injections ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual'`);
		}
		if (!columns.has('source_id')) {
			this.state.storage.sql.exec(`ALTER TABLE injections ADD COLUMN source_id TEXT`);
		}
		if (!columns.has('spotlight_id')) {
			this.state.storage.sql.exec(`ALTER TABLE injections ADD COLUMN spotlight_id TEXT`);
		}
	}

	private ensureProviderUsageColumns(): void {
		const columns = new Set(
			this.state.storage.sql
				.exec<{ name: string }>(`PRAGMA table_info(provider_usage)`)
				.toArray()
				.map((row) => row.name),
		);
		if (!columns.has('provider_name')) {
			this.state.storage.sql.exec(`ALTER TABLE provider_usage ADD COLUMN provider_name TEXT`);
		}
	}

	private ensureInferenceSubmissionColumns(): void {
		const columns = new Set(
			this.state.storage.sql
				.exec<{ name: string }>(`PRAGMA table_info(inference_submissions)`)
				.toArray()
				.map((row) => row.name),
		);
		if (!columns.has('display_messages_json')) {
			this.state.storage.sql.exec(`ALTER TABLE inference_submissions ADD COLUMN display_messages_json TEXT`);
		}
	}

	private ensureLoopMessageColumns(): void {
		const columns = new Set(
			this.state.storage.sql
				.exec<{ name: string }>(`PRAGMA table_info(loop_messages)`)
				.toArray()
				.map((row) => row.name),
		);
		if (!columns.has('deleted_at')) {
			this.state.storage.sql.exec(`ALTER TABLE loop_messages ADD COLUMN deleted_at TEXT`);
		}
		if (!columns.has('stream_seq')) {
			this.state.storage.sql.exec(`ALTER TABLE loop_messages ADD COLUMN stream_seq INTEGER`);
		}
		if (!columns.has('display_event_seq')) {
			this.state.storage.sql.exec(`ALTER TABLE loop_messages ADD COLUMN display_event_seq INTEGER`);
		}
		this.state.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS loop_messages_visible ON loop_messages (deleted_at, compacted_by, position, seq)`,
		);
	}

	private migrateLegacyLoopMessages(): void {
		const existing = this.state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM loop_messages`).one().count;
		if (existing > 0 || this.runtimeStateBoolean('loop_messages_legacy_migrated')) {
			return;
		}
		const eventCount = this.state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM events`).one().count;
		if (eventCount === 0) {
			return;
		}
		const rows = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE type IN ('input', 'reasoning_message', 'assistant_message', 'tool_call', 'tool_result', 'thought_injected')
				 ORDER BY seq ASC
				 LIMIT 500`,
			)
			.toArray();
		const latestSummary = this.latestCompactionSummary();
		const activity = rows.map((row) => truncateForContext(runtimeContextLine(row), 500)).join('\n');
		const summary = storedMemorySummary(
			[latestSummary.trim(), activity.trim() ? `Before this exact chat log began, I had this Bickr history:\n${activity.trim()}` : '']
				.filter(Boolean)
				.join('\n\n'),
		);
		if (summary) {
			const message = { role: 'assistant' as const, content: summary };
			const inserted = this.insertLoopMessage({
				runId: 'legacy-migration',
				message,
				origin: 'legacy_migration',
				status: 'complete',
				position: 1,
				createdAt: rows[0]?.created_at ?? new Date().toISOString(),
				broadcast: false,
			});
			this.recordLoopMessageLog(inserted.seq, 'message', JSON.stringify(message));
		}
		this.setRuntimeState('loop_messages_legacy_migrated', true);
	}

	private runtimeStateBoolean(key: string): boolean {
		const value = this.runtimeStateValue(key);
		return value === true;
	}

	private runtimeStateRecord(key: string): Record<string, unknown> | undefined {
		const value = this.runtimeStateValue(key);
		return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	}

	private runtimeStateValue(key: string): unknown {
		if (!this.state) {
			return undefined;
		}
		const row = this.state.storage.sql.exec<{ value_json: string }>(`SELECT value_json FROM runtime_state WHERE key = ?`, key).toArray()[0];
		if (!row) {
			return undefined;
		}
		try {
			return JSON.parse(row.value_json) as unknown;
		} catch {
			return undefined;
		}
	}

	private setRuntimeState(key: string, value: unknown): void {
		if (!this.state) {
			return;
		}
		this.state.storage.sql.exec(
			`INSERT INTO runtime_state (key, value_json)
			 VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
			key,
			JSON.stringify(value),
		);
	}

	private deleteRuntimeState(key: string): void {
		if (!this.state) {
			return;
		}
		this.state.storage.sql.exec(`DELETE FROM runtime_state WHERE key = ?`, key);
	}

	private compactionReasoningModeForSettings(settings: Pick<ProviderSettings, 'baseUrl' | 'model'>): ProviderCompactionReasoningMode {
		if (providerNoReasoningModeForSettings(settings) === 'minimal') {
			this.deleteRuntimeState(compactionReasoningFallbackStateKey);
			return 'minimal';
		}
		const state = this.runtimeStateRecord(compactionReasoningFallbackStateKey);
		if (!state) {
			return 'none';
		}
		if (state.model === settings.model && state.mode === 'minimal') {
			return 'minimal';
		}
		this.deleteRuntimeState(compactionReasoningFallbackStateKey);
		return 'none';
	}

	private rememberCompactionNoReasoningRejection(settings: Pick<ProviderSettings, 'model'>, reason: string): void {
		const state: ProviderCompactionReasoningFallbackState = {
			model: settings.model,
			mode: 'minimal',
			reason: truncateForContext(reason, 500),
			updatedAt: new Date().toISOString(),
		};
		this.setRuntimeState(compactionReasoningFallbackStateKey, state);
	}

	async fetch(request: Request): Promise<Response> {
		try {
			if (!isTrustedInternalServiceRequest(request)) {
				return agentRuntimeNotFoundResponse();
			}
			const url = new URL(request.url);
			const botId = botIdFromPath(url.pathname);
			return await this.handleRuntimeHttpRequest(request, url, botId);
		} catch (error) {
			return errorResponse(error);
		}
	}

	private async handleRuntimeHttpRequest(request: Request, url: URL, botId: string): Promise<Response> {
		const response =
			await this.handleRuntimeReadRequest(request, url, botId) ??
			await this.handleRuntimeMutationRequest(request, url, botId) ??
			await this.handleRuntimeInjectionRequest(request, url, botId) ??
			await this.handleRuntimeMonitorRequest(request, url, botId);
		return response ?? fail('not_found', 'Bot runtime route not found.', 404);
	}

	private async handleRuntimeReadRequest(request: Request, url: URL, botId: string): Promise<Response | null> {
		if (request.method === 'GET' && url.pathname.endsWith('/status')) {
			await this.requireOwnerOrInternal(request, botId);
			return ok({ status: await this.status(botId) });
		}

		if (request.method === 'GET' && url.pathname.endsWith('/events')) {
			await this.requireOwnerOrInternal(request, botId);
			const after = Number(url.searchParams.get('after') ?? 0);
			return ok({ events: this.eventsAfter(Number.isFinite(after) ? after : 0) });
		}

		if (request.method === 'GET' && url.pathname.endsWith('/messages')) {
			await this.requireOwnerOrInternal(request, botId);
			const after = Number(url.searchParams.get('after') ?? 0);
			const page = Number(url.searchParams.get('page') ?? 1);
			return ok(
				this.loopMessagesPage({
					after: Number.isFinite(after) ? after : 0,
					page: Number.isFinite(page) ? page : 1,
				}),
			);
		}

		const messageLogSeq = messageLogsSeqFromPath(url.pathname);
		if (request.method === 'GET' && messageLogSeq !== null) {
			await this.requireOwnerOrInternal(request, botId);
			return ok(this.loopMessageLogsForSeq(messageLogSeq));
		}

		if (request.method === 'GET' && url.pathname.endsWith('/submissions')) {
			await this.requireOwnerOrInternal(request, botId);
			return ok({ submissions: this.inferenceSubmissionSummaries() });
		}

		const submissionSeq = submissionSeqFromPath(url.pathname);
		if (request.method === 'GET' && submissionSeq !== null) {
			await this.requireOwnerOrInternal(request, botId);
			return ok({ submission: this.inferenceSubmissionForSeq(submissionSeq) });
		}

		if (request.method === 'GET' && url.pathname.endsWith('/token-usage')) {
			await this.requireOwnerOrInternal(request, botId);
			return ok({ usage: this.tokenUsageStats(await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId)) });
		}

		if (request.method === 'GET' && url.pathname.endsWith('/token-spend')) {
			await this.requireOwnerOrInternal(request, botId);
			return ok({ spend: await this.tokenSpendSummary(await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId)) });
		}

		if (request.method === 'GET' && url.pathname.endsWith('/context-budget')) {
			await this.requireOwnerOrInternal(request, botId);
			return ok({ budget: await this.cachedPromptContextBudget(botId) });
		}
		return null;
	}

	private async handleRuntimeMutationRequest(request: Request, url: URL, botId: string): Promise<Response | null> {
		const messageSeq = messageSeqFromPath(url.pathname);
		if (request.method === 'DELETE' && messageSeq !== null) {
			await this.requireOwnerOrInternal(request, botId);
			return ok({ deleted: await this.deleteLoopMessage(botId, messageSeq) });
		}

		if (request.method === 'POST' && url.pathname.endsWith('/context-budget')) {
			await this.requireOwnerOrInternal(request, botId);
			const input = parseBotContextBudgetInput(await readJsonBody(request));
			return ok({ budget: await this.promptContextBudget(botId, input) });
		}

		if (request.method === 'DELETE' && url.pathname.endsWith('/events')) {
			await this.requireOwnerOrInternal(request, botId);
			const cleared = await this.clearHistory(botId);
			return ok({ cleared });
		}

		if (request.method === 'POST' && url.pathname.endsWith('/compact')) {
			await this.requireOwnerOrInternal(request, botId);
			const compacted = await this.manualCompactLoopMessages(botId);
			return ok({ compacted });
		}

		const eventSeq = eventSeqFromPath(url.pathname);
		if (request.method === 'DELETE' && eventSeq !== null) {
			await this.requireOwnerOrInternal(request, botId);
			const deleted = await this.deleteEvent(botId, eventSeq);
			return ok({ deleted });
		}

		if (request.method === 'POST' && url.pathname.endsWith('/tick')) {
			await this.requireOwnerOrInternal(request, botId);
			const options = await readTickOptions(request);
			const trigger = options.mode === 'spotlight' ? 'spotlight' : request.headers.get('x-bickr-scheduler') ? 'cron' : 'manual';
			if (options.background) {
				const run = await this.startBackgroundTick(botId, trigger, options);
				return ok({ run });
			}
			const run = await this.runTick(botId, trigger, options);
			return ok({ run });
		}

		if (request.method === 'POST' && url.pathname.endsWith('/stop')) {
			await this.requireOwnerOrInternal(request, botId);
			const stop = await this.stopTick(botId);
			return ok({ stop });
		}
		return null;
	}

	private async handleRuntimeInjectionRequest(request: Request, url: URL, botId: string): Promise<Response | null> {
		if (request.method !== 'POST' || !url.pathname.endsWith('/inject')) {
			return null;
		}
		await this.requireOwnerOrInternal(request, botId);
		const body = await readJsonBody(request);
		const bodyRecord = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
		const text = typeof bodyRecord.text === 'string' ? bodyRecord.text.trim() : '';
		if (!text) {
			throw new InputError('Injection text is required.');
		}
		const event = await this.injectThought(text, {
			kind: stringValue(bodyRecord.kind) ?? 'manual',
			sourceId: stringValue(bodyRecord.sourceId),
			spotlightId: stringValue(bodyRecord.spotlightId),
		});
		return ok({ event, injectionId: stringValue(runtimeRecord(event.payload).injectionId) });
	}

	private async handleRuntimeMonitorRequest(request: Request, url: URL, botId: string): Promise<Response | null> {
		if (request.method !== 'GET' || !url.pathname.endsWith('/monitor')) {
			return null;
		}
		await this.requireOwnerOrInternal(request, botId);
		if (request.headers.get('Upgrade') !== 'websocket') {
			return fail('bad_request', 'Expected WebSocket upgrade.', 400);
		}
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.state.acceptWebSocket(server, [botId]);
		const after = Number(url.searchParams.get('after') ?? 0);
		const afterMessage = Number(url.searchParams.get('afterMessage') ?? after);
		const afterEvent = Number(url.searchParams.get('afterEvent') ?? after);
		for (const message of this.loopMessagesAfter(Number.isFinite(afterMessage) ? afterMessage : 0)) {
			server.send(JSON.stringify({ type: 'loop_message', loopMessage: message }));
		}
		for (const event of this.eventsAfter(Number.isFinite(afterEvent) ? afterEvent : 0)) {
			server.send(JSON.stringify({ type: 'event', event }));
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		try {
			const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
			const payload = JSON.parse(text) as { type?: string; text?: string };
			if (payload.type === 'ping') {
				ws.send(JSON.stringify({ type: 'pong' }));
				return;
			}
			if (payload.type === 'inject' && payload.text?.trim()) {
				const event = await this.injectThought(payload.text.trim());
				ws.send(JSON.stringify({ type: 'event', event }));
			}
		} catch (error) {
			ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Bad message.' }));
		}
	}

	async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
		console.error('bot runtime monitor WebSocket error', error);
	}

	private async startBackgroundTick(botId: string, trigger: 'cron' | 'manual' | 'spotlight', options: TickOptions): Promise<TickRunResult> {
		const admission = await this.admitTick(botId, trigger, { ...options, background: false });
		if (!admission.admitted) {
			return admission.result;
		}
		const tick = this.runAdmittedTick(botId, trigger, { ...options, background: false }, admission.tick).catch((error) => {
			console.error('background bot tick failed', error);
		});
		this.state.waitUntil(tick);
		return { runId: 'background', status: 'started' };
	}

	private async runTick(botId: string, trigger: 'cron' | 'manual' | 'spotlight', options: TickOptions = {}): Promise<TickRunResult> {
		const admission = await this.admitTick(botId, trigger, options);
		if (!admission.admitted) {
			return admission.result;
		}
		return this.runAdmittedTick(botId, trigger, options, admission.tick);
	}

	private async admitTick(botId: string, trigger: 'cron' | 'manual' | 'spotlight', options: TickOptions): Promise<TickAdmission> {
		return this.runtimeTransitionQueue().run(async () => {
			const current = await this.status(botId);
			if (this.activeRunId || this.activeMaintenanceOperation) {
				return { admitted: false, result: this.busyTickResult(current, trigger, options) };
			}
			if (current.status === 'running') {
				return { admitted: false, result: this.busyTickResult(current, trigger, options) };
			}
			if (!current.enabled) {
				return { admitted: false, result: pausedTickResult() };
			}

			const bot = await this.botWithEffectivePostingSettings(await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId));
			const owner = await userById(this.env.BICKR_KV, bot.ownerUserId);
			const providerSettings = this.effectiveProviderSettings(bot, owner);
			const runId = crypto.randomUUID();
			const now = new Date().toISOString();
			const leaseExpiresAt = new Date(Date.parse(now) + runtimeRunLeaseTimeoutMs).toISOString();
			const claimed = await claimRuntimeRun(this.env.BICKR_D1, bot.id, runId, leaseExpiresAt, now);
			if (!claimed) {
				return { admitted: false, result: this.busyTickResult(await this.status(botId), trigger, options) };
			}

			const abortController = new AbortController();
			this.activeAbortController = abortController;
			this.activeRunId = runId;
			this.clearStopRequest();
			const mode: TickMode = options.mode === 'spotlight' ? 'spotlight' : 'normal';
			const setupMode: LoopSetupMode =
				mode === 'spotlight' ? 'spotlight' : this.currentIterationStartedSinceLastLogOff() ? 'continuation' : 'new_iteration';
			return {
				admitted: true,
				tick: {
					bot,
					providerSettings,
					runId,
					abortController,
					mode,
					setupMode,
				},
			};
		});
	}

	private async runAdmittedTick(
		botId: string,
		trigger: 'cron' | 'manual' | 'spotlight',
		options: TickOptions,
		admitted: AdmittedTick,
	): Promise<TickRunResult> {
		const { bot, providerSettings, runId, abortController, mode, setupMode } = admitted;
		const runContext: RunContext = {
			mode,
			setupMode,
			...(options.spotlightId ? { spotlightId: options.spotlightId } : {}),
			signal: abortController.signal,
		};
		let startQueuedSpotlightAfterRun = false;

		try {
			// Inside the try so an event-store failure still releases the claim
			// and clears the in-memory run slot via the catch/finally below.
			await this.appendEvent(runId, 'tick_started', { trigger, botId, handle: bot.handle });
			this.throwIfStopped(runId, abortController.signal);
			const notifications =
				setupMode !== 'new_iteration'
					? []
					: await (async () => {
							await ensureBootstrapNotification(this.env.BICKR_KV, this.env.BICKR_D1, bot);
							return listPendingNotifications(this.env.BICKR_KV, this.env.BICKR_D1, bot.id);
						})();
			this.throwIfStopped(runId, abortController.signal);
			const injections = this.consumeInjections(mode === 'spotlight' ? (options.injectionIds ?? []) : undefined);
			if (mode === 'spotlight' && injections.length === 0) {
				const nextDueAt = await this.setRuntimeIndex(bot, 'idle', null, undefined, new Date().toISOString(), runId);
				await this.appendEvent(runId, 'tick_completed', {
					...(nextDueAt ? { nextDueAt } : {}),
					note: 'No pending spotlight injection was available.',
				});
				startQueuedSpotlightAfterRun = true;
				return { runId, status: 'completed' };
			}
			const builtInput = await buildRuntimeLoopInput(
				this.env.BICKR_KV,
				this.env.BICKR_D1,
				bot.id,
				notifications,
				injections,
				providerToolCallsForSettings(providerSettings) === 'at_will' ? undefined : this.pendingToolUseReminder(),
			);
			const input = builtInput.input;
			if (mode === 'spotlight') {
				runContext.spotlightActionScope = spotlightActionScopeFromContexts(input.spotlightContexts);
			}
			const inputEvent = await this.appendEvent(runId, 'input', input);
			const builtMessages = await this.buildMessages(bot, input, runId, inputEvent.createdAt, { setupMode });
			if (setupMode === 'new_iteration') {
				const deliveredNotificationIds = builtMessages.deliveredNotificationIds;
				const deliveredSeenItems = uniqueSeenContentItems(
					[...deliveredNotificationIds].flatMap((id) => builtInput.notificationSeenItemsById[id] ?? []),
				);
				await markBotSeenContent(this.env.BICKR_D1, bot.id, deliveredSeenItems, 'notification', runId);
				await markNotificationsDelivered(
					this.env.BICKR_KV,
					this.env.BICKR_D1,
					notifications.filter((notification) => deliveredNotificationIds.has(notification.id)),
				);
			}

			const messages = builtMessages;
			this.throwIfStopped(runId, abortController.signal);
			let outcome: ProviderLoopOutcome;
			if (providerSettings.apiKey || providerSettings.usesCustomBaseUrl || this.env.BICKR_SIMULATION_MODE === 'provider') {
				outcome = await this.runProviderLoop(bot, providerSettings, runId, messages, runContext);
				if (providerToolCallsForSettings(providerSettings) !== 'at_will') {
					this.recordToolUseRecoveryOutcome(runId, outcome.toolCallCount);
				}
			} else {
				outcome = await this.runLocalSimulation(bot, runId, input, runContext);
			}
			if (runContext.mode === 'spotlight' && runContext.spotlightId && outcome.spotlightMutationCount === 0) {
				try {
					await recordSpotlightNoReactionHumanNotification(this.env.BICKR_D1, {
						bot,
						runId,
						spotlightId: runContext.spotlightId,
					});
				} catch (notificationError) {
					console.warn('spotlight no-reaction notification failed', notificationError);
				}
			}

			await this.compactIfNeeded(bot, providerSettings, runId, abortController.signal);
			const nextDueAt = await this.setRuntimeIndex(bot, 'idle', null, undefined, new Date().toISOString(), runId);
			await this.appendEvent(runId, 'tick_completed', { ...(nextDueAt ? { nextDueAt } : {}) });
			startQueuedSpotlightAfterRun = true;
			return { runId, status: 'completed' };
		} catch (error) {
			if (error instanceof TickStoppedError || isAbortError(error)) {
				this.markPendingCompactionEventsFailed(runId, 'This Bickr visit was stopped.');
				if (!this.hasTerminalEvent(runId)) {
					await this.appendEvent(runId, 'tick_stopped', { message: 'This Bickr visit was stopped.' });
				}
				await this.setRuntimeIndex(bot, 'idle', null, undefined, new Date().toISOString(), runId);
				return { runId, status: 'stopped' };
			}
			if (error instanceof PersistentToolFailureError) {
				if (!this.hasTerminalEvent(runId)) {
					await this.recordTickFailure(runId, {
						message: error.message,
						toolName: error.failure.toolName,
						failure: error.failure,
					});
				}
				await this.setRuntimeIndex(bot, 'failed', null, error.message, new Date().toISOString(), runId);
				try {
					await recordBotRuntimeFailureHumanNotification(this.env.BICKR_D1, {
						bot,
						runId,
						message: error.failure.message,
						toolName: error.failure.toolName,
					});
					if (runContext.mode === 'spotlight' && runContext.spotlightId) {
						await recordSpotlightFailureHumanNotification(this.env.BICKR_D1, {
							bot,
							runId,
							spotlightId: runContext.spotlightId,
							message: error.message,
						});
					}
				} catch (notificationError) {
					console.warn('bot runtime failure notification failed', notificationError);
				}
				return { runId, status: 'failed', error: error.message };
			}
			if (error instanceof PersistentMissingToolCallError) {
				if (!this.hasTerminalEvent(runId)) {
					await this.recordTickFailure(runId, {
						message: error.message,
						toolNames: error.toolNames,
					});
				}
				await this.setRuntimeIndex(bot, 'failed', null, error.message, new Date().toISOString(), runId);
				try {
					await recordBotRuntimeFailureHumanNotification(this.env.BICKR_D1, {
						bot,
						runId,
						message: error.message,
					});
					if (runContext.mode === 'spotlight' && runContext.spotlightId) {
						await recordSpotlightFailureHumanNotification(this.env.BICKR_D1, {
							bot,
							runId,
							spotlightId: runContext.spotlightId,
							message: error.message,
						});
					}
				} catch (notificationError) {
					console.warn('bot runtime failure notification failed', notificationError);
				}
				return { runId, status: 'failed', error: error.message };
			}
			if (error instanceof PersistentCompactionReductionFailureError) {
				const message = error.message;
				if (!this.hasTerminalEvent(runId)) {
					await this.recordTickFailure(runId, {
						message,
						paused: true,
						reason: 'persistent_non_reducing_compaction',
						attempts: error.attempts,
					}, runtimeFailureLogs(error));
				}
				const failedAt = new Date().toISOString();
				await this.pauseBotAfterPersistentCompactionFailure(bot, message, failedAt);
				await this.setRuntimeIndex(bot, 'failed', null, message, failedAt, runId);
				try {
					await recordBotRuntimeFailureHumanNotification(this.env.BICKR_D1, {
						bot,
						runId,
						message,
					});
				} catch (notificationError) {
					console.warn('bot runtime failure notification failed', notificationError);
				}
				return { runId, status: 'paused', error: message };
			}
			const message = error instanceof Error ? error.message : 'Unexpected Bickr visit error.';
			if (!this.hasTerminalEvent(runId)) {
				await this.recordTickFailure(runId, { message }, runtimeFailureLogs(error));
			}
			await this.setRuntimeIndex(bot, 'failed', null, message, new Date().toISOString(), runId);
			try {
				await recordBotRuntimeFailureHumanNotification(this.env.BICKR_D1, {
					bot,
					runId,
					message,
				});
			} catch (notificationError) {
				console.warn('bot runtime failure notification failed', notificationError);
			}
			if (runContext.mode === 'spotlight' && runContext.spotlightId) {
				try {
					await recordSpotlightFailureHumanNotification(this.env.BICKR_D1, {
						bot,
						runId,
						spotlightId: runContext.spotlightId,
						message,
					});
				} catch (notificationError) {
					console.warn('spotlight failure notification failed', notificationError);
				}
			}
			return { runId, status: 'failed', error: message };
		} finally {
			try {
				await this.exportRecentProviderUsage(bot);
			} catch (error) {
				console.warn('central provider usage export failed', botId, error);
			}
			if (this.activeRunId === runId) {
				this.activeAbortController = null;
				this.activeRunId = null;
			}
			this.clearStopRequest(runId);
			if (startQueuedSpotlightAfterRun) {
				try {
					this.startQueuedSpotlightTick(botId);
				} catch (error) {
					console.error('queued spotlight tick scheduling failed', error);
				}
			}
		}
	}

	private async beginMaintenanceOperation(botId: string, operation: ActiveMaintenanceOperation, conflictMessage: string): Promise<void> {
		await this.runtimeTransitionQueue().run(async () => {
			const current = await this.status(botId);
			if (current.status === 'running' || this.activeRunId || this.activeMaintenanceOperation) {
				throw new RepositoryError('conflict', conflictMessage, 409);
			}
			this.activeMaintenanceOperation = operation;
		});
	}

	private finishMaintenanceOperation(operation: ActiveMaintenanceOperation): void {
		if (this.activeMaintenanceOperation === operation) {
			this.activeMaintenanceOperation = null;
		}
	}

	private runtimeTransitionQueue(): ExclusiveOperationQueue {
		if (!this.transitionQueue) {
			this.transitionQueue = new ExclusiveOperationQueue();
		}
		return this.transitionQueue;
	}

	private busyTickResult(current: BotRuntimeStatus, trigger: 'cron' | 'manual' | 'spotlight', options: TickOptions): TickRunResult {
		const runId = this.activeRunId ?? current.activeRunId ?? 'active';
		const spotlightRequested = trigger === 'spotlight' || options.mode === 'spotlight';
		if (spotlightRequested) {
			const queued = this.queuePendingSpotlightTick(runId, options);
			if (queued) {
				return queued;
			}
		}
		return { runId, status: 'already_running' };
	}

	private queuePendingSpotlightTick(activeRunId: string, options: TickOptions): TickRunResult | null {
		if (options.mode !== 'spotlight' || !options.spotlightId || !options.injectionIds?.length) {
			return null;
		}

		const spotlightId = options.spotlightId;
		const now = new Date().toISOString();
		const existing = this.pendingSpotlightTickEntries();
		const existingInjectionIds = new Set(existing.map((entry) => entry.injectionId));
		const additions = uniqueStrings(options.injectionIds)
			.filter((injectionId) => !existingInjectionIds.has(injectionId))
			.map((injectionId) => ({
				injectionId,
				spotlightId,
				createdAt: now,
			}));
		if (additions.length > 0) {
			this.writePendingSpotlightTickEntries([...existing, ...additions]);
		}
		return { runId: activeRunId, status: 'queued' };
	}

	private startQueuedSpotlightTick(botId: string): void {
		const pending = this.takeNextPendingSpotlightTick();
		if (!pending) {
			return;
		}
		const tick = this.runTick(botId, 'spotlight', {
			mode: 'spotlight',
			injectionIds: pending.injectionIds,
			spotlightId: pending.spotlightId,
			background: false,
		})
			.then((result) => {
				if (result.status === 'paused') {
					this.prependPendingSpotlightTickEntries(pending.entries);
				}
			})
			.catch((error) => {
				this.prependPendingSpotlightTickEntries(pending.entries);
				console.error('queued spotlight tick failed to start', error);
			});
		this.state.waitUntil(tick);
	}

	private takeNextPendingSpotlightTick(): PendingSpotlightTick | null {
		const unconsumed = this.pendingSpotlightTickEntries().filter((entry) => this.hasUnconsumedInjection(entry.injectionId));
		if (unconsumed.length === 0) {
			this.clearPendingSpotlightTickEntries();
			return null;
		}
		const spotlightId = unconsumed[0]?.spotlightId;
		if (!spotlightId) {
			this.clearPendingSpotlightTickEntries();
			return null;
		}
		const entries = unconsumed.filter((entry) => entry.spotlightId === spotlightId);
		const remaining = unconsumed.filter((entry) => entry.spotlightId !== spotlightId);
		this.writePendingSpotlightTickEntries(remaining);
		return {
			spotlightId,
			injectionIds: entries.map((entry) => entry.injectionId),
			entries,
		};
	}

	private pendingSpotlightTickEntries(): QueuedSpotlightTick[] {
		const row = this.state.storage.sql
			.exec<{ value_json: string }>(`SELECT value_json FROM runtime_state WHERE key = ?`, pendingSpotlightTicksStateKey)
			.toArray()[0];
		if (!row) {
			return [];
		}
		try {
			const parsed = runtimeRecord(JSON.parse(row.value_json) as unknown);
			const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
			return entries
				.map((entry) => runtimeRecord(entry))
				.map((entry) => ({
					injectionId: stringValue(entry.injectionId) ?? '',
					spotlightId: stringValue(entry.spotlightId) ?? '',
					createdAt: stringValue(entry.createdAt) ?? '',
				}))
				.filter((entry) => entry.injectionId && entry.spotlightId && entry.createdAt);
		} catch {
			this.clearPendingSpotlightTickEntries();
			return [];
		}
	}

	private prependPendingSpotlightTickEntries(entries: QueuedSpotlightTick[]): void {
		if (entries.length === 0) {
			return;
		}
		const existing = this.pendingSpotlightTickEntries();
		const prependedInjectionIds = new Set(entries.map((entry) => entry.injectionId));
		this.writePendingSpotlightTickEntries([...entries, ...existing.filter((entry) => !prependedInjectionIds.has(entry.injectionId))]);
	}

	private writePendingSpotlightTickEntries(entries: QueuedSpotlightTick[]): void {
		if (entries.length === 0) {
			this.clearPendingSpotlightTickEntries();
			return;
		}
		this.state.storage.sql.exec(
			`INSERT INTO runtime_state (key, value_json)
			 VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
			pendingSpotlightTicksStateKey,
			JSON.stringify({ entries }),
		);
	}

	private clearPendingSpotlightTickEntries(): void {
		this.state.storage.sql.exec(`DELETE FROM runtime_state WHERE key = ?`, pendingSpotlightTicksStateKey);
	}

	private hasUnconsumedInjection(injectionId: string): boolean {
		const row = this.state.storage.sql
			.exec<{ found: number }>(
				`SELECT 1 AS found
				 FROM injections
				 WHERE id = ? AND consumed_at IS NULL
				 LIMIT 1`,
				injectionId,
			)
			.toArray()[0];
		return Boolean(row);
	}

	private async stopTick(botId: string): Promise<{ stopped: boolean; runId?: string; status: BotRuntimeStatus['status'] }> {
		const current = await this.status(botId);
		const runId = current.activeRunId ?? this.activeRunId ?? undefined;
		if (current.status !== 'running' || !runId) {
			return { stopped: false, status: current.status };
		}

		this.setStopRequest(runId);
		await this.appendEvent(runId, 'tick_stop_requested', { message: 'This Bickr visit was asked to stop.' });
		if (this.activeRunId === runId && this.activeAbortController && !this.activeAbortController.signal.aborted) {
			this.activeAbortController.abort();
			return { stopped: true, runId, status: current.status };
		}
		const bot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
		await this.markRunStopped(bot, runId);
		return { stopped: true, runId, status: 'idle' };
	}

	private setStopRequest(runId: string): void {
		this.state.storage.sql.exec(
			`INSERT INTO runtime_state (key, value_json)
			 VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
			stopRequestStateKey,
			JSON.stringify(runId),
		);
	}

	private clearStopRequest(runId?: string): void {
		if (runId) {
			this.state.storage.sql.exec(`DELETE FROM runtime_state WHERE key = ? AND value_json = ?`, stopRequestStateKey, JSON.stringify(runId));
			return;
		}
		this.state.storage.sql.exec(`DELETE FROM runtime_state WHERE key = ?`, stopRequestStateKey);
	}

	private throwIfStopped(runId: string, signal: AbortSignal): void {
		if (signal.aborted) {
			throw new TickStoppedError();
		}
		if (this.hasStopRequest(runId)) {
			throw new TickStoppedError();
		}
	}

	private hasStopRequest(runId: string): boolean {
		const row = this.state.storage.sql
			.exec<{ value_json: string }>(`SELECT value_json FROM runtime_state WHERE key = ?`, stopRequestStateKey)
			.toArray()[0];
		if (!row) {
			return false;
		}
		const requestedRunId = stringValue(JSON.parse(row.value_json));
		return requestedRunId === runId;
	}

	private pendingToolUseReminder(): string | undefined {
		const state = this.toolUseRecoveryState();
		return state ? toolUseRecoveryReminder(state) : undefined;
	}

	private recordToolUseRecoveryOutcome(runId: string, toolCallCount: number): void {
		if (toolCallCount > 0) {
			this.clearToolUseRecoveryState();
			return;
		}
		this.setToolUseRecoveryState(runId);
	}

	private toolUseRecoveryState(): ToolUseRecoveryState | undefined {
		const row = this.state.storage.sql
			.exec<{ value_json: string }>(`SELECT value_json FROM runtime_state WHERE key = ?`, toolUseRecoveryStateKey)
			.toArray()[0];
		if (!row) {
			return undefined;
		}
		try {
			const record = runtimeRecord(JSON.parse(row.value_json));
			const consecutiveNoToolTicks = integerValue(record.consecutiveNoToolTicks);
			const lastRunId = stringValue(record.lastRunId);
			const updatedAt = stringValue(record.updatedAt);
			if (!consecutiveNoToolTicks || !lastRunId || !updatedAt) {
				this.clearToolUseRecoveryState();
				return undefined;
			}
			return { consecutiveNoToolTicks, lastRunId, updatedAt };
		} catch {
			this.clearToolUseRecoveryState();
			return undefined;
		}
	}

	private setToolUseRecoveryState(runId: string): void {
		const previous = this.toolUseRecoveryState();
		const consecutiveNoToolTicks =
			previous && previous.lastRunId !== runId ? previous.consecutiveNoToolTicks + 1 : previous ? previous.consecutiveNoToolTicks : 1;
		const state: ToolUseRecoveryState = {
			consecutiveNoToolTicks,
			lastRunId: runId,
			updatedAt: new Date().toISOString(),
		};
		this.state.storage.sql.exec(
			`INSERT INTO runtime_state (key, value_json)
			 VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
			toolUseRecoveryStateKey,
			JSON.stringify(state),
		);
	}

	private clearToolUseRecoveryState(): void {
		this.state.storage.sql.exec(`DELETE FROM runtime_state WHERE key = ?`, toolUseRecoveryStateKey);
	}

	private async botWithEffectivePostingSettings(bot: BotDocument): Promise<RuntimeBotDocument> {
		const world = await readJson<WorldDocument>(this.env.BICKR_KV, kvKeys.world(bot.homeWorldId));
		return {
			...bot,
			effectivePostingSettings: effectivePostingSettings(world?.postingSettings, bot.postingSettings),
			worldPrompt: stringValue(world?.prompt) ?? '',
		};
	}

	private async botWithCurrentRuntimeBudget(bot: RuntimeBotDocument): Promise<RuntimeBotDocument> {
		if (!this.env?.BICKR_KV || !this.env?.BICKR_D1) {
			return bot;
		}
		let current: BotDocument;
		try {
			current = await botById(this.env.BICKR_KV, this.env.BICKR_D1, bot.id);
		} catch {
			return bot;
		}
		return this.botWithEffectivePostingSettings({
			...bot,
			postingSettings: current.postingSettings,
			tickSettings: {
				...bot.tickSettings,
				...(current.tickSettings.contextWindowTokens === undefined
					? { contextWindowTokens: undefined }
					: { contextWindowTokens: current.tickSettings.contextWindowTokens }),
			},
		});
	}

	private async markRunStopped(bot: BotDocument, runId: string): Promise<string | null> {
		this.markPendingCompactionEventsFailed(runId, 'This Bickr visit was stopped.');
		if (!this.hasTerminalEvent(runId)) {
			await this.appendEvent(runId, 'tick_stopped', { message: 'This Bickr visit was stopped.' });
		}
		const nextDueAt = await this.setRuntimeIndex(bot, 'idle', null, undefined, new Date().toISOString(), runId);
		this.clearStopRequest(runId);
		return nextDueAt;
	}

	private async runProviderLoop(
		bot: BotDocument,
		settings: ProviderSettings,
		runId: string,
		_messages: ChatMessage[],
		runContext: RunContext,
	): Promise<ProviderLoopOutcome> {
		let consecutiveToolFailures = 0;
		let logOffCalled = false;
		let spotlightMutationCount = 0;
		let toolCallCount = 0;
		let successfulToolCallsThisIteration = this.providerLoopInitialSuccessfulToolCallCount();
		let mutatingToolUsedThisIteration = this.successfulMutatingToolCallSinceLastLogOff();
		let prematureLogOffCorrectedThisIteration = this.prematureLogOffCorrectedSinceLastLogOff();
		let generatedTokensThisTick = 0;
		let generatedTokensThisIteration = this.loopGeneratedTokenCountSinceLastLogOff();
		let railroadNoToolAttempts = 0;
		let toolRequestTurns = 0;
		const toolCallsMode = providerToolCallsForSettings(settings);
		const tickSettings = effectiveTickSettings(bot.tickSettings);
		const maxSuccessfulToolCallsPerIteration = maxSuccessfulToolCallsPerIterationSetting(bot);
		let spotlightStreakActive = runContext.mode === 'spotlight' && runContext.spotlightActionScope !== undefined;
		const spotlightIterationLimitReached = (): boolean =>
			successfulToolCallsThisIteration >= maxSuccessfulToolCallsPerIteration ||
			generatedTokensThisIteration >= tickSettings.maxGeneratedTokensPerIteration;
		const finishSpotlightStreak = (): boolean => {
			if (!spotlightStreakActive) {
				return false;
			}
			spotlightStreakActive = false;
			return spotlightIterationLimitReached();
		};
		const finishProviderLoop = async (finishedByLogOff = logOffCalled): Promise<ProviderLoopOutcome> => {
			const spotlightLimitReached = finishSpotlightStreak();
			if (spotlightLimitReached && !finishedByLogOff) {
				await this.appendSyntheticLimitLogOff(bot, runId, runContext);
				return { logOffCalled: true, spotlightMutationCount, toolCallCount };
			}
			return { logOffCalled: finishedByLogOff, spotlightMutationCount, toolCallCount };
		};
		while (toolRequestTurns < tickSettings.maxToolCallsPerTick) {
			this.throwIfStopped(runId, runContext.signal);
			const { tools: providerTools, serverTools } = providerToolsForBotRound(bot, settings);
			if (providerTools.length === 0) {
				return finishProviderLoop();
			}
			let response: ProviderResponse;
			let responseStatus: ProviderMessageStatus = 'complete';
			let interruptedError: ProviderResponseInterruptedError | null = null;
			let requestEvent: BotRuntimeEvent;
			let malformedOnlyRetried = false;
			for (;;) {
				await this.repairActiveProviderToolCallHistory(runId);
				const budgetCheck = await this.ensureProviderPromptWithinBudget(bot, settings, runId, runContext.signal, providerTools);
				const requestMessages = budgetCheck.requestMessages;
				const requestContextWindowTokens = budgetCheck.contextWindowTokens ?? tickSettings.contextWindowTokens;
				const requestMaxCompletionTokens = providerLoopMaxCompletionTokens(requestContextWindowTokens, budgetCheck.promptTokens);
				requestEvent = await this.appendEvent(runId, 'provider_request', providerLoopRequestEventPayload({
					budgetCheck,
					generatedTokensThisIteration,
					generatedTokensThisTick,
					maxSuccessfulToolCallsPerIteration,
					mutatingToolUsedThisIteration,
					prematureLogOffCorrectedThisIteration,
					providerTools,
					requestContextWindowTokens,
					requestMessages,
					serverTools,
					settings,
					successfulToolCallsThisIteration,
					tickSettings,
					toolCallsMode,
				}));
				this.recordInferenceSubmission({
					seq: requestEvent.seq,
					runId,
					purpose: 'loop',
					settings,
					messages: requestMessages,
					createdAt: requestEvent.createdAt,
				});
				responseStatus = 'complete';
				interruptedError = null;
				try {
					response = await this.callProvider(
						settings,
						requestMessages,
						providerTools,
						runId,
						requestEvent.seq,
						runContext.signal,
						toolCallsMode,
						requestEvent.createdAt,
						requestMaxCompletionTokens,
						providerPromptCacheSessionId(bot.id),
					);
				} catch (error) {
					if (error instanceof ProviderResponseInterruptedError) {
						response = error.response;
						responseStatus = 'interrupted';
						interruptedError = error;
					} else {
						throw error;
					}
				}
				const sanitized = sanitizeProviderResponseToolCalls(response);
				response = sanitized.response;
				const malformedOnlyResponse =
					responseStatus === 'complete' && sanitized.originalToolCallCount > 0 && response.toolCalls.length === 0;
				await this.recordDroppedProviderToolCalls(
					runId,
					requestEvent.seq,
					sanitized.dropped,
					'generated_response',
					malformedOnlyResponse && !malformedOnlyRetried,
				);
				if (response.usage) {
					await this.recordProviderUsage({
						contextWindowTokens: requestContextWindowTokens,
						createdAt: requestEvent.createdAt,
						providerName: response.responseProviderName,
						providerResponseId: response.responseId,
						requestSeq: requestEvent.seq,
						responseModel: response.responseModel,
						runId,
						settings,
						usage: response.usage,
					});
				}
				if (!malformedOnlyResponse) {
					break;
				}
				if (malformedOnlyRetried) {
					throw new Error('Inference provider returned only malformed page-control requests after retry.');
				}
				malformedOnlyRetried = true;
			}
			await this.appendProviderMessages(runId, response, responseStatus, requestEvent.seq);
			const responseGeneratedTokens = Math.max(0, Math.floor(response.usage?.completionTokens ?? 0));
			generatedTokensThisTick += responseGeneratedTokens;
			generatedTokensThisIteration += responseGeneratedTokens;
			const tickGeneratedLimitReached = generatedTokensThisTick >= tickSettings.maxGeneratedTokensPerTick;
			let forceSyntheticLogOff = !spotlightStreakActive && generatedTokensThisIteration >= tickSettings.maxGeneratedTokensPerIteration;
			const assistantMessage = providerResponseMessageForHistory(response);
			const assistantToolCallLoopMessageSeqs = new Map<string, number>();
			let providerResponseLogsRecorded = false;
			const recordProviderResponseLogs = (assistantLoopMessageSeq: number): void => {
				if (providerResponseLogsRecorded) {
					return;
				}
				if (response.requestBody) {
					this.recordLoopMessageLog(assistantLoopMessageSeq, 'provider_request', response.requestBody);
				}
				this.recordLoopMessageLog(
					assistantLoopMessageSeq,
					'provider_response',
					JSON.stringify(providerResponseLogPayload(response, responseStatus)),
				);
				providerResponseLogsRecorded = true;
			};
			const appendAssistantMessageForToolCall = (toolCall: ToolCall): number | null => {
				if (!assistantMessage) {
					return null;
				}
				const existing = assistantToolCallLoopMessageSeqs.get(toolCall.id);
				if (existing !== undefined) {
					return existing;
				}
				const assistantLoopMessage = this.appendLoopMessage(
					runId,
					providerResponseToolCallMessageForHistory(assistantMessage, toolCall, assistantToolCallLoopMessageSeqs.size === 0),
					'provider_response',
					responseStatus,
					{ streamSeq: requestEvent.seq },
				);
				assistantToolCallLoopMessageSeqs.set(toolCall.id, assistantLoopMessage.seq);
				recordProviderResponseLogs(assistantLoopMessage.seq);
				return assistantLoopMessage.seq;
			};
			const appendAssistantMessageWithoutToolCalls = (): void => {
				if (!assistantMessage) {
					return;
				}
				const assistantLoopMessage = this.appendLoopMessage(runId, assistantMessage, 'provider_response', responseStatus, {
					streamSeq: requestEvent.seq,
				});
				recordProviderResponseLogs(assistantLoopMessage.seq);
			};
			if (responseStatus === 'interrupted') {
				if (response.toolCalls.length > 0) {
					this.appendInterruptedToolMessages(
						runId,
						response.toolCalls,
						new Set(response.toolCalls.map((toolCall) => toolCall.id)),
						appendAssistantMessageForToolCall,
					);
				}
				throw interruptedError?.originalError instanceof Error ? interruptedError.originalError : new TickStoppedError();
			}
			if (providerResponseIsEmpty(response)) {
				throw new ProviderEmptyResponseError(response.rawResponse);
			}
			if (response.toolCalls.length === 0) {
				appendAssistantMessageWithoutToolCalls();
				if (forceSyntheticLogOff) {
					await this.appendSyntheticLimitLogOff(bot, runId, runContext);
					return { logOffCalled: true, spotlightMutationCount, toolCallCount };
				}
				if (tickGeneratedLimitReached) {
					return finishProviderLoop();
				}
				if (toolCallsMode !== 'at_will') {
					railroadNoToolAttempts += 1;
					if (railroadNoToolAttempts >= providerRailroadNoToolMaxAttempts) {
						throw new PersistentMissingToolCallError(providerToolNames(providerTools));
					}
					const acknowledgementContent = toolRequirementSelfCorrection(providerTools);
					await this.appendEvent(runId, 'assistant_message', {
						content: acknowledgementContent,
						status: 'complete',
					});
					this.appendLoopMessage(runId, { role: 'assistant', content: acknowledgementContent }, 'self_correction');
					continue;
				}
				return finishProviderLoop();
			}
			railroadNoToolAttempts = 0;
			toolRequestTurns += 1;
			toolCallCount += response.toolCalls.length;
			const toolFailureAcknowledgements: string[] = [];
			const selfCorrectionAcknowledgements: string[] = [];
			const pendingToolCallIds = new Set(response.toolCalls.map((toolCall) => toolCall.id));
			let persistentFailure: ToolFailurePayload | null = null;
			let spotlightTickTerminated = false;
			const appendFailedToolCall = async (
				toolCall: ToolCall,
				args: Record<string, unknown>,
				error: unknown,
			): Promise<void> => {
				const failure = toolFailurePayload(toolCall.function.name, args, error);
				pendingToolCallIds.delete(toolCall.id);
				consecutiveToolFailures += 1;
				await this.appendEvent(runId, 'tool_result', {
					name: toolCall.function.name || 'unknown_tool',
					args,
					result: failure,
					displayContext: { worldHandle: bot.homeWorldHandle },
					error: true,
					consecutiveFailures: consecutiveToolFailures,
				});
				const toolMessage: ChatMessage = {
					role: 'tool',
					tool_call_id: toolCall.id,
					content: JSON.stringify(failure),
				};
				const loopMessage = this.appendLoopMessage(runId, toolMessage, 'tool_failure');
				this.recordLoopMessageLog(loopMessage.seq, 'tool_call', JSON.stringify(toolCall));
				this.recordLoopMessageLog(loopMessage.seq, 'tool_result', toolMessage.content ?? '');
				const acknowledgement = toolFailureAssistantContent(failure);
				if (consecutiveToolFailures >= 5) {
					persistentFailure = failure;
				}
				toolFailureAcknowledgements.push(acknowledgement);
			};

			for (const toolCall of response.toolCalls) {
				this.throwIfStopped(runId, runContext.signal);
				const assistantLoopMessageSeq = appendAssistantMessageForToolCall(toolCall);
				const canonicalName = canonicalToolName(toolCall.function.name);
				if (canonicalName === providerCompactionToolName) {
					pendingToolCallIds.delete(toolCall.id);
					await this.dropGeneratedProviderToolCall(
						runId,
						requestEvent.seq,
						assistantLoopMessageSeq,
						toolCall,
						'disallowed_meta_compaction_tool',
					);
					selfCorrectionAcknowledgements.push(metaCompactionToolMisuseSelfCorrection);
					continue;
				}
				if (canonicalName === 'log_off' && !tickSettings.allowEarlyLogOff) {
					pendingToolCallIds.delete(toolCall.id);
					await this.dropGeneratedProviderToolCall(runId, requestEvent.seq, assistantLoopMessageSeq, toolCall, 'disallowed_log_off');
					selfCorrectionAcknowledgements.push(disallowedLogOffSelfCorrectionContent);
					continue;
				}
				if (canonicalName === 'log_off' && !mutatingToolUsedThisIteration && !prematureLogOffCorrectedThisIteration) {
					pendingToolCallIds.delete(toolCall.id);
					await this.dropGeneratedProviderToolCall(runId, requestEvent.seq, assistantLoopMessageSeq, toolCall, 'premature_log_off');
					prematureLogOffCorrectedThisIteration = true;
					selfCorrectionAcknowledgements.push(prematureLogOffSelfCorrectionContent);
					continue;
				}
				if (logOffCalled && canonicalName !== 'log_off') {
					pendingToolCallIds.delete(toolCall.id);
					await this.dropGeneratedProviderToolCall(runId, requestEvent.seq, assistantLoopMessageSeq, toolCall, 'iteration_limit');
					continue;
				}
				let args: Record<string, unknown>;
				try {
					args = parseToolArgs(toolCall);
				} catch (error) {
					await appendFailedToolCall(toolCall, malformedToolCallFailureArgs(toolCall), error);
					continue;
				}
				let result: ToolResult;
				try {
					result = await this.executeTool(bot, runId, toolCall.function.name, args, runContext);
					pendingToolCallIds.delete(toolCall.id);
					consecutiveToolFailures = 0;
					if (result.effectiveArgs && assistantLoopMessageSeq !== null) {
						this.rewriteProviderResponseLoopMessageToolCall(assistantLoopMessageSeq, {
							kind: 'replace_arguments',
							toolCallId: toolCall.id,
							arguments: JSON.stringify(providerToolArgs(result.name, result.effectiveArgs)),
						});
					}
					if (result.name === 'log_off') {
						logOffCalled = true;
					}
					successfulToolCallsThisIteration += 1;
					if (mutableToolNames.has(result.name)) {
						mutatingToolUsedThisIteration = true;
					}
					if (result.spotlightMutation) {
						spotlightMutationCount += 1;
					}
				} catch (error) {
					if (error instanceof TickStoppedError || isAbortError(error)) {
						this.appendInterruptedToolMessages(runId, response.toolCalls, pendingToolCallIds, appendAssistantMessageForToolCall);
						throw error;
					}
					if (error instanceof SelfCorrectingToolCallError) {
						pendingToolCallIds.delete(toolCall.id);
						consecutiveToolFailures = 0;
						if (assistantLoopMessageSeq !== null) {
							this.rewriteProviderResponseLoopMessageToolCall(assistantLoopMessageSeq, { kind: 'drop', toolCallId: toolCall.id });
						}
						selfCorrectionAcknowledgements.push(...error.selfCorrectionMessages);
						continue;
					}
					const failure = toolFailurePayload(toolCall.function.name, args, error);
					const selfCorrection = selfCorrectionMessageForToolFailurePayload(failure);
					if (selfCorrection) {
						pendingToolCallIds.delete(toolCall.id);
						consecutiveToolFailures = 0;
						if (assistantLoopMessageSeq !== null) {
							this.rewriteProviderResponseLoopMessageToolCall(assistantLoopMessageSeq, { kind: 'drop', toolCallId: toolCall.id });
						}
						selfCorrectionAcknowledgements.push(selfCorrection);
						continue;
					}
					await appendFailedToolCall(toolCall, args, error);
					continue;
				}
				const toolMessage: ChatMessage = {
					role: 'tool',
					tool_call_id: toolCall.id,
					content: JSON.stringify(result.providerResult),
				};
				const loopMessage = this.appendLoopMessage(runId, toolMessage, 'tool_result', 'complete', {
					displayEventSeq: result.displayEventSeq,
				});
				const recordedToolCall = result.effectiveArgs
					? toolCallWithArguments(toolCall, JSON.stringify(providerToolArgs(result.name, result.effectiveArgs)))
					: toolCall;
				this.recordLoopMessageLog(loopMessage.seq, 'tool_call', JSON.stringify(recordedToolCall));
				this.recordLoopMessageLog(loopMessage.seq, 'tool_result', toolMessage.content ?? '');
				if (result.selfCorrectionMessages) {
					selfCorrectionAcknowledgements.push(...result.selfCorrectionMessages);
				}
				if (result.spotlightTickTerminator) {
					spotlightTickTerminated = true;
					await this.dropPendingGeneratedProviderToolCalls(
						runId,
						requestEvent.seq,
						null,
						response.toolCalls,
						pendingToolCallIds,
						'spotlight_tick_ended',
					);
					break;
				}
				if (
					result.name !== 'log_off' &&
					!spotlightStreakActive &&
					successfulToolCallsThisIteration >= maxSuccessfulToolCallsPerIteration
				) {
					forceSyntheticLogOff = true;
					await this.dropPendingGeneratedProviderToolCalls(
						runId,
						requestEvent.seq,
						null,
						response.toolCalls,
						pendingToolCallIds,
						'iteration_limit',
					);
					break;
				}
			}
			if (toolFailureAcknowledgements.length > 0) {
				const acknowledgementContent = toolFailureAcknowledgements.join('\n\n');
				await this.appendEvent(runId, 'assistant_message', {
					content: acknowledgementContent,
					status: 'complete',
				});
				const acknowledgementMessage: ChatMessage = {
					role: 'assistant',
					content: acknowledgementContent,
				};
				this.appendLoopMessage(runId, acknowledgementMessage, 'provider_response');
			}
			if (selfCorrectionAcknowledgements.length > 0) {
				const acknowledgementContent = selfCorrectionAcknowledgements.join('\n\n');
				await this.appendEvent(runId, 'assistant_message', {
					content: acknowledgementContent,
					status: 'complete',
				});
				const acknowledgementMessage: ChatMessage = {
					role: 'assistant',
					content: acknowledgementContent,
				};
				this.appendLoopMessage(runId, acknowledgementMessage, 'self_correction');
			}
			if (persistentFailure && consecutiveToolFailures >= 5) {
				throw new PersistentToolFailureError(persistentFailure);
			}
			if (logOffCalled) {
				return finishProviderLoop(true);
			}
			if (spotlightTickTerminated) {
				return finishProviderLoop();
			}
			if (forceSyntheticLogOff) {
				await this.appendSyntheticLimitLogOff(bot, runId, runContext);
				return { logOffCalled: true, spotlightMutationCount, toolCallCount };
			}
			if (tickGeneratedLimitReached) {
				return finishProviderLoop();
			}
		}
		return finishProviderLoop();
	}

	private appendInterruptedToolMessages(
		runId: string,
		toolCalls: ToolCall[],
		pendingToolCallIds: Set<string>,
		appendAssistantForToolCall?: (toolCall: ToolCall) => number | null,
	): void {
		for (const toolCall of toolCalls) {
			if (!pendingToolCallIds.has(toolCall.id)) {
				continue;
			}
			pendingToolCallIds.delete(toolCall.id);
			appendAssistantForToolCall?.(toolCall);
			const content = JSON.stringify({
				ok: false,
				code: 'interrupted',
				message: 'This Bickr visit stopped before Bickr Terminal returned a result.',
			});
			const toolMessage: ChatMessage = {
				role: 'tool',
				tool_call_id: toolCall.id,
				content,
			};
			const loopMessage = this.appendLoopMessage(runId, toolMessage, 'tool_failure', 'interrupted');
			this.recordLoopMessageLog(loopMessage.seq, 'tool_call', JSON.stringify(toolCall));
			this.recordLoopMessageLog(loopMessage.seq, 'tool_result', content);
		}
	}

	private async callProvider(
		settings: ProviderSettings,
		messages: ChatMessage[],
		tools: ProviderToolDefinition[],
		runId: string,
		streamSeq: number,
		signal: AbortSignal,
		toolCalls: BotInferenceToolCalls = providerToolCallsForSettings(settings),
		createdAt = new Date().toISOString(),
		maxCompletionTokens = providerContextReserveTokens,
		promptCacheSessionId?: string,
	): Promise<ProviderResponse> {
		const endpoint = providerChatCompletionsUrl(settings.baseUrl);
		let requestSettings = settings;
		let lastBody = stringifyProviderRequest(
			providerChatCompletionRequest(
				requestSettings,
				messages,
				tools,
				undefined,
				toolCalls,
				promptCacheSessionId,
				maxCompletionTokens,
			),
		);
		let previousRetryKey: string | null = null;
		let retryDelayMs = 0;
		let retryReason: string | null = null;
		let calibrationAttempt = 0;
		for (let attempt = 1; attempt <= providerMaxAttempts; attempt += 1) {
			this.throwIfStopped(runId, signal);
			if (attempt > 1) {
				await this.appendEvent(runId, 'provider_retry', {
					attempt,
					maxAttempts: providerMaxAttempts,
					delayMs: retryDelayMs,
					reason: retryReason,
				});
				if (retryDelayMs > 0) {
					await sleep(retryDelayMs, signal);
				}
			}
			const request = providerChatCompletionRequest(
				requestSettings,
				messages,
				tools,
				undefined,
				toolCalls,
				promptCacheSessionId,
				maxCompletionTokens,
			);
			const body = stringifyProviderRequest(request);
			calibrationAttempt += 1;
			lastBody = body;

			try {
				const streamResponse = providerStreamFetchResponse(await this.fetchProviderResponse(requestSettings, endpoint, body, signal));
				const response = await this.consumeProviderResponse(runId, streamSeq, streamResponse.stream, signal, streamResponse.responseId);
				if (response.usage) {
					this.recordProviderTokenCalibrationSample({
						attempt: calibrationAttempt,
						createdAt,
						purpose: 'loop',
						request,
						requestSeq: streamSeq,
						...(response.responseModel ? { responseModel: response.responseModel } : {}),
						runId,
						settings: requestSettings,
						usage: response.usage,
					});
				}
				return { ...response, requestBody: body };
			} catch (error) {
				this.recordProviderTokenCalibrationSampleFromError({
					attempt: calibrationAttempt,
					createdAt,
					error,
					purpose: 'loop',
					request,
					requestSeq: streamSeq,
					runId,
					settings: requestSettings,
				});
				if (error instanceof ProviderResponseInterruptedError) {
					const interruptedResponse = { ...error.response };
					delete interruptedResponse.usage;
					throw new ProviderResponseInterruptedError({ ...interruptedResponse, requestBody: body }, error.originalError);
				}
				if (error instanceof TickStoppedError || isAbortError(error)) {
					throw error;
				}
				const upstreamLimit = providerUpstreamRateLimitRetry(error);
				if (upstreamLimit) {
					const routing = providerRoutingWithIgnoredProvider(requestSettings.providerRouting, upstreamLimit.providerName);
					if (!routing.changed) {
						throw new ProviderLoopRequestError(error, body, attempt, providerFailureResponseText(error));
					}
					if (attempt < providerMaxAttempts) {
						requestSettings = { ...requestSettings, providerRouting: routing.providerRouting };
						retryDelayMs = 0;
						retryReason = providerIgnoreRetryReason(upstreamLimit);
						previousRetryKey = null;
						continue;
					}
				}
				const retryKey = providerRetryKey(error);
				if (retryKey && attempt < providerMaxAttempts && (previousRetryKey === null || previousRetryKey === retryKey)) {
					previousRetryKey = retryKey;
					retryDelayMs = providerRetryDelayMsForAttempt(attempt + 1);
					retryReason = retryKey;
					continue;
				}
				throw new ProviderLoopRequestError(error, body, attempt, providerFailureResponseText(error));
			}
		}
		throw new ProviderLoopRequestError(new ProviderRequestTimeoutError(providerRequestTimeoutMs), lastBody, providerMaxAttempts);
	}

	private async callProviderForCompaction(
		settings: ProviderSettings,
		messages: ChatMessage[],
		runId: string,
		signal: AbortSignal,
		limits: ProviderCompactionValidationLimits &
			Pick<ProviderCompactionSummaryLimits, 'maxCompletionTokens'> = defaultProviderCompactionSummaryLimits,
		providerTools?: ProviderToolDefinition[],
		mode: ProviderCompactionMode = 'structured_output',
		requestSeq = 0,
		createdAt = new Date().toISOString(),
		bot?: BotDocument,
	): Promise<
		Pick<ProviderResponse, 'usage' | 'responseId' | 'responseModel' | 'responseProviderName' | 'requestBody' | 'rawResponse'> & {
			content: string;
		}
	> {
		const endpoint = providerChatCompletionsUrl(settings.baseUrl);
		const effectiveProviderTools = providerTools ?? providerCompactionToolsForMode(limits, undefined, mode);
		let requestProviderTools = effectiveProviderTools;
		let requestMessages = messages;
		let requestSettings = settings;
		let compactionReasoningMode = this.compactionReasoningModeForSettings(settings);
		let lastBody = stringifyProviderRequest(
			providerCompactionRequest(
				requestSettings,
				requestMessages,
				limits,
				requestProviderTools,
				mode,
				providerCompactionReasoningForSettings(requestSettings, compactionReasoningMode),
			),
		);
		let lastValidationError: ProviderStructuredOutputValidationError | null = null;
		let calibrationAttempt = 0;
		let isolatedReductionRepairAttempts = 0;
		for (let schemaAttempt = 0; schemaAttempt <= providerStructuredOutputRepairAttempts; schemaAttempt += 1) {
			let previousRetryKey: string | null = null;
			let retryDelayMs = 0;
			let retryReason: string | null = null;
			for (let attempt = 1; attempt <= providerMaxAttempts; attempt += 1) {
				this.throwIfStopped(runId, signal);
				if (attempt > 1) {
					await this.appendEvent(runId, 'provider_retry', {
						attempt,
						maxAttempts: providerMaxAttempts,
						delayMs: retryDelayMs,
						reason: retryReason,
					});
					if (retryDelayMs > 0) {
						await sleep(retryDelayMs, signal);
					}
				}
				const request = providerCompactionRequest(
					requestSettings,
					requestMessages,
					limits,
					requestProviderTools,
					mode,
					providerCompactionReasoningForSettings(requestSettings, compactionReasoningMode),
				);
				const body = stringifyProviderRequest(request);
				calibrationAttempt += 1;
				lastBody = body;

				try {
					const response = await this.fetchProviderCompactionResponse(requestSettings, endpoint, body, signal, limits, mode);
					if (response.usage) {
						this.recordProviderTokenCalibrationSample({
							attempt: calibrationAttempt,
							createdAt,
							purpose: 'compaction',
							request,
							requestSeq,
							...(response.responseModel ? { responseModel: response.responseModel } : {}),
							runId,
							settings: requestSettings,
							usage: response.usage,
						});
					}
					return { ...response, requestBody: body };
				} catch (error) {
					this.recordProviderTokenCalibrationSampleFromError({
						attempt: calibrationAttempt,
						createdAt,
						error,
						purpose: 'compaction',
						request,
						requestSeq,
						runId,
						settings: requestSettings,
					});
					if (error instanceof TickStoppedError || isAbortError(error)) {
						throw error;
					}
					if (error instanceof ProviderCompactionOutputLimitError) {
						throw new ProviderCompactionRequestError(error, body, error.rawResponse);
					}
					if (compactionReasoningMode === 'none' && providerCompactionNoReasoningRejected(error, request)) {
						const reason = runtimeErrorText(error);
						this.rememberCompactionNoReasoningRejection(settings, reason);
						compactionReasoningMode = 'minimal';
						previousRetryKey = null;
						retryDelayMs = 0;
						retryReason = 'provider rejected compaction reasoning=none; retrying with minimal';
						if (attempt < providerMaxAttempts) {
							continue;
						}
					}
					if (error instanceof ProviderStructuredOutputValidationError) {
						lastValidationError = error;
						break;
					}
					const upstreamLimit = providerUpstreamRateLimitRetry(error);
					if (upstreamLimit) {
						const routing = providerRoutingWithIgnoredProvider(requestSettings.providerRouting, upstreamLimit.providerName);
						if (!routing.changed) {
							throw new ProviderCompactionRequestError(error, body, providerCompactionFailureResponseText(error));
						}
						if (attempt < providerMaxAttempts) {
							requestSettings = { ...requestSettings, providerRouting: routing.providerRouting };
							retryDelayMs = 0;
							retryReason = providerIgnoreRetryReason(upstreamLimit);
							previousRetryKey = null;
							continue;
						}
					}
					const retryKey = providerRetryKey(error);
					if (retryKey && attempt < providerMaxAttempts && (previousRetryKey === null || previousRetryKey === retryKey)) {
						previousRetryKey = retryKey;
						retryDelayMs = providerRetryDelayMsForAttempt(attempt + 1);
						retryReason = retryKey;
						continue;
					}
					throw new ProviderCompactionRequestError(error, body, providerCompactionFailureResponseText(error));
				}
			}
			if (lastValidationError && schemaAttempt < providerStructuredOutputRepairAttempts) {
				if (lastValidationError.outputText && bot && isNonReducingCompactionValidationError(lastValidationError)) {
					isolatedReductionRepairAttempts += 1;
					requestProviderTools = providerCompactionIsolatedRepairTools(limits, mode);
					requestMessages = providerCompactionIsolatedRepairMessages(bot, lastValidationError.outputText, limits, mode);
				} else {
					requestMessages = lastValidationError.outputText
						? providerCompactionShortenMessages(messages, lastValidationError.outputText, limits, mode)
						: [...requestMessages, ...structuredOutputRepairMessages(lastValidationError)];
				}
				continue;
			}
			if (lastValidationError) {
				if (isolatedReductionRepairAttempts > 0 && isNonReducingCompactionValidationError(lastValidationError)) {
					throw new PersistentCompactionReductionFailureError(
						isolatedReductionRepairAttempts,
						lastBody,
						lastValidationError.rawResponse,
					);
				}
				throw new ProviderCompactionRequestError(lastValidationError, lastBody, providerCompactionFailureResponseText(lastValidationError));
			}
		}
		throw new ProviderCompactionRequestError(new ProviderRequestTimeoutError(providerRequestTimeoutMs), lastBody);
	}

	private async consumeProviderResponse(
		runId: string,
		streamSeq: number,
		stream: ReadableStream<Uint8Array>,
		signal: AbortSignal,
		generationResponseId?: string,
	): Promise<ProviderResponse> {
		let content = '';
		let reasoning = '';
		const reasoningDetails: ReasoningDetail[] = [];
		const toolCalls = new Map<number, ToolCall>();
		let usage: ProviderUsage | undefined;
		let responseId: string | undefined = generationResponseId;
		let responseModel: string | undefined;
		let responseProviderName: string | undefined;
		let rawResponse = '';
		let skippedRawResponse = '';
		this.markProviderStreamActive(runId);
		try {
			for await (const event of readSse(stream, signal)) {
				this.throwIfStopped(runId, signal);
				this.markProviderStreamActive(runId);
				const rawPreviewCaptured = providerResponsePartsAreEmpty(content, reasoning, reasoningDetails, [...toolCalls.values()]);
				if (rawPreviewCaptured) {
					rawResponse = appendRawResponsePreview(rawResponse, event.raw);
				}
				if (event.data === '[DONE]') {
					break;
				}
				let chunk: {
					id?: unknown;
					model?: unknown;
					usage?: unknown;
					error?: unknown;
					openrouter_metadata?: unknown;
					choices?: Array<{
						delta?: {
							content?: string;
							reasoning?: string;
							reasoning_content?: string;
							reasoning_details?: ReasoningDetail[];
							tool_calls?: Array<{
								index: number;
								id?: string;
								type?: 'function';
								function?: { name?: string; arguments?: string };
							}>;
						};
					}>;
				};
				try {
					chunk = JSON.parse(event.data) as typeof chunk;
				} catch {
					if (!rawPreviewCaptured) {
						rawResponse = appendRawResponsePreview(rawResponse, event.raw);
					}
					skippedRawResponse = appendRawResponsePreview(skippedRawResponse, event.raw);
					continue;
				}
				responseId = responseId ?? stringValue(chunk.id);
				responseModel = stringValue(chunk.model) ?? responseModel;
				usage = providerUsageFromValue(chunk.usage) ?? usage;
				responseProviderName = openRouterMetadataProviderName(chunk.openrouter_metadata) ?? responseProviderName;
				const providerError = providerStreamErrorFromChunk(chunk);
				if (providerError) {
					throw providerError;
				}
				const delta = chunk.choices?.[0]?.delta;
				if (!delta) {
					continue;
				}
				if (delta.content) {
					content += delta.content;
					this.broadcastProviderDelta(runId, streamSeq, { kind: 'content', text: delta.content });
				}
				const plainReasoning = delta.reasoning ?? delta.reasoning_content;
				let detailsReasoning = '';
				if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
					const mergedReasoningDetails = normalizeReasoningDetailsForProviderHistory([...reasoningDetails, ...delta.reasoning_details]);
					reasoningDetails.length = 0;
					reasoningDetails.push(...mergedReasoningDetails);
					detailsReasoning = reasoningTextFromDetails(delta.reasoning_details);
				}
				const deltaReasoning = plainReasoning || detailsReasoning;
				if (deltaReasoning) {
					reasoning += deltaReasoning;
					this.broadcastProviderDelta(runId, streamSeq, { kind: 'reasoning', text: deltaReasoning });
				}
				for (const part of delta.tool_calls ?? []) {
					const current =
						toolCalls.get(part.index) ??
						({
							id: part.id ?? `tool-${part.index}`,
							type: 'function',
							function: { name: '', arguments: '' },
						} satisfies ToolCall);
					if (part.id) {
						current.id = part.id;
					}
					if (part.function?.name) {
						current.function.name += part.function.name;
					}
					if (part.function?.arguments) {
						current.function.arguments += part.function.arguments;
					}
					toolCalls.set(part.index, current);
					this.broadcastProviderDelta(runId, streamSeq, { kind: 'tool_call', part });
				}
			}
		} catch (error) {
			if (error instanceof ProviderStreamIdleTimeoutError) {
				throw error;
			}
			if (error instanceof TickStoppedError || isAbortError(error)) {
				throw new ProviderResponseInterruptedError(
					{
						content,
						reasoning,
						reasoningDetails,
						toolCalls: [...toolCalls.values()].filter((tool) => tool.function.name),
						...(rawResponse ? { rawResponse } : {}),
						...(skippedRawResponse ? { skippedRawResponse } : {}),
						...(usage ? { usage } : {}),
						...(responseId ? { responseId } : {}),
						...(responseModel ? { responseModel } : {}),
						...(responseProviderName ? { responseProviderName } : {}),
					},
					error,
				);
			}
			throw error;
		} finally {
			this.clearProviderStreamActive(runId);
		}
		const response = {
			content: repairInvalidUnicodeText(content),
			reasoning: repairInvalidUnicodeText(reasoning),
			reasoningDetails: repairInvalidUnicodeValue(reasoningDetails).value,
			toolCalls: [...toolCalls.values()].filter((tool) => tool.function.name),
			...(rawResponse ? { rawResponse } : {}),
			...(skippedRawResponse ? { skippedRawResponse } : {}),
			...(usage ? { usage } : {}),
			...(responseId ? { responseId } : {}),
			...(responseModel ? { responseModel } : {}),
			...(responseProviderName ? { responseProviderName } : {}),
		};
		if (providerResponseIsEmpty(response)) {
			throw new ProviderEmptyResponseError(response.rawResponse, {
				...(responseId ? { responseId } : {}),
				...(responseModel ? { responseModel } : {}),
				...(usage ? { usage } : {}),
			});
		}
		return response;
	}

	private async appendProviderMessages(
		runId: string,
		response: ProviderResponse,
		status: ProviderMessageStatus,
		streamSeq: number,
	): Promise<void> {
		if (response.reasoning) {
			await this.appendEvent(runId, 'reasoning_message', {
				content: response.reasoning,
				status,
				streamSeq,
			});
		}
		if (response.content) {
			await this.appendEvent(runId, 'assistant_message', {
				content: response.content,
				status,
				streamSeq,
			});
		}
	}

	private async recordDroppedProviderToolCalls(
		runId: string,
		streamSeq: number | null,
		dropped: readonly DroppedProviderToolCall[],
		phase: 'generated_response' | 'history_repair',
		retrying: boolean,
	): Promise<void> {
		if (dropped.length === 0) {
			return;
		}
		const calls = dropped.map((call) => ({
			id: call.id,
			name: call.name,
			reason: call.reason,
			argumentsPreview: call.argumentsPreview,
		}));
		await this.appendEvent(runId, 'provider_tool_call_dropped', {
			runId,
			streamSeq,
			count: calls.length,
			callIds: [...new Set(calls.map((call) => call.id).filter(Boolean))],
			functionNames: [...new Set(calls.map((call) => call.name).filter(Boolean))],
			reason: [...new Set(calls.map((call) => call.reason))].join(','),
			phase,
			retrying,
			calls,
		});
	}

	private async dropGeneratedProviderToolCall(
		runId: string,
		streamSeq: number,
		assistantLoopMessageSeq: number | null,
		toolCall: ToolCall,
		reason: ProviderToolCallDropReason,
	): Promise<void> {
		if (assistantLoopMessageSeq !== null && this.hasRuntimeStorage()) {
			this.rewriteProviderResponseLoopMessageToolCall(assistantLoopMessageSeq, { kind: 'drop', toolCallId: toolCall.id });
		}
		await this.recordDroppedProviderToolCalls(
			runId,
			streamSeq,
			[droppedProviderToolCall(toolCall.id, toolCall.function.name, reason, toolCall.function.arguments)],
			'generated_response',
			false,
		);
	}

	private async dropPendingGeneratedProviderToolCalls(
		runId: string,
		streamSeq: number,
		assistantLoopMessageSeq: number | null,
		toolCalls: readonly ToolCall[],
		pendingToolCallIds: Set<string>,
		reason: ProviderToolCallDropReason,
	): Promise<void> {
		const dropped: DroppedProviderToolCall[] = [];
		for (const toolCall of toolCalls) {
			if (!pendingToolCallIds.has(toolCall.id)) {
				continue;
			}
			pendingToolCallIds.delete(toolCall.id);
			dropped.push(droppedProviderToolCall(toolCall.id, toolCall.function.name, reason, toolCall.function.arguments));
			if (assistantLoopMessageSeq !== null && this.hasRuntimeStorage()) {
				this.rewriteProviderResponseLoopMessageToolCall(assistantLoopMessageSeq, { kind: 'drop', toolCallId: toolCall.id });
			}
		}
		if (dropped.length > 0) {
			await this.recordDroppedProviderToolCalls(runId, streamSeq, dropped, 'generated_response', false);
		}
	}

	private async appendSyntheticLimitLogOff(bot: BotDocument, runId: string, runContext: RunContext): Promise<void> {
		const args = syntheticLimitLogOffArgs(bot.language);
		const toolCall = syntheticToolCall(runId, 'log_off', this.hasRuntimeStorage() ? this.latestEventSeq() + 1 : 0, args);
		await this.appendEvent(runId, 'assistant_message', {
			content: syntheticLimitLogOffContent,
			status: 'complete',
		});
		this.appendLoopMessage(
			runId,
			{
				role: 'assistant',
				content: syntheticLimitLogOffContent,
				tool_calls: [toolCall],
			},
			'self_correction',
			'complete',
		);
		const result = await this.executeTool(bot, runId, 'log_off', args, runContext);
		const toolMessage: ChatMessage = {
			role: 'tool',
			tool_call_id: toolCall.id,
			content: JSON.stringify(result.providerResult),
		};
		const loopMessage = this.appendLoopMessage(runId, toolMessage, 'tool_result', 'complete', { displayEventSeq: result.displayEventSeq });
		this.recordLoopMessageLog(loopMessage.seq, 'tool_call', JSON.stringify(toolCall));
		this.recordLoopMessageLog(loopMessage.seq, 'tool_result', toolMessage.content ?? '');
	}

	private rewriteProviderResponseLoopMessageToolCall(seq: number, rewrite: ProviderToolCallRewrite): void {
		const row = this.state.storage.sql
			.exec<LoopMessageRow>(
				`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
				        m.token_estimate, m.stream_seq, m.compacted_by, m.deleted_at, m.created_at,
				        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
				 FROM loop_messages m
				 WHERE m.seq = ?
				   AND m.deleted_at IS NULL
				 LIMIT 1`,
				seq,
			)
			.toArray()[0];
		if (!row || row.origin !== 'provider_response') {
			return;
		}
		const result = rewriteProviderResponseToolCallMessage(loopMessageChatMessageFromRow(row), rewrite);
		if (result.kind === 'unchanged') {
			return;
		}
		if (result.kind === 'deleted') {
			this.state.storage.sql.exec(
				`UPDATE loop_messages
				 SET deleted_at = ?
				 WHERE seq = ?
				   AND deleted_at IS NULL`,
				new Date().toISOString(),
				seq,
			);
			this.broadcastControl({ type: 'loop_messages_reset' });
			return;
		}
		const messageJson = JSON.stringify(result.message);
		this.state.storage.sql.exec(
			`UPDATE loop_messages
			 SET message_json = ?, token_estimate = ?
			 WHERE seq = ?
			   AND deleted_at IS NULL`,
			messageJson,
			estimateTextTokens(messageJson),
			seq,
		);
		this.recordLoopMessageLog(seq, 'message', messageJson);
		this.broadcastControl({ type: 'loop_messages_reset' });
	}

	private appendLoopMessage(
		runId: string,
		message: ChatMessage,
		origin: BotLoopMessageOrigin,
		status: BotLoopMessageStatus = 'complete',
		options: { streamSeq?: number; displayEventSeq?: number } = {},
	): BotLoopMessage {
		const inserted = this.insertLoopMessage({
			runId,
			message,
			origin,
			status,
			streamSeq: options.streamSeq,
			displayEventSeq: options.displayEventSeq,
			broadcast: true,
		});
		this.recordLoopMessageLog(inserted.seq, 'message', JSON.stringify(message));
		return inserted;
	}

	private async recordTickFailure(
		runId: string,
		payload: Record<string, unknown>,
		logs: RuntimeFailureLog[] = [],
	): Promise<BotRuntimeEvent> {
		const message = stringValue(payload.message) ?? 'Unexpected Bickr visit error.';
		this.markPendingCompactionEventsFailed(runId, message);
		const loopMessage = this.appendLoopMessage(
			runId,
			{
				role: 'user',
				content: runtimeErrorLoopMessageContent(message),
			},
			'runtime_error',
		);
		for (const log of logs) {
			this.recordLoopMessageLog(loopMessage.seq, log.kind, log.text);
		}
		return this.appendEvent(runId, 'tick_failed', payload);
	}

	private markPendingCompactionEventsFailed(runId: string, error: string): void {
		const rows = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE run_id = ?
				   AND type = 'compaction'
				 ORDER BY seq ASC`,
				runId,
			)
			.toArray();
		for (const row of rows) {
			let payload: Record<string, unknown>;
			try {
				payload = runtimeRecord(JSON.parse(row.payload_json) as unknown);
			} catch {
				continue;
			}
			if (payload.status !== 'pending') {
				continue;
			}
			const event: BotRuntimeEvent = {
				seq: row.seq,
				runId: row.run_id,
				type: row.type,
				payload,
				tokenEstimate: row.token_estimate,
				createdAt: row.created_at,
				...(row.compacted_by !== null ? { compactedBy: row.compacted_by } : {}),
			};
			this.replaceEventPayload(event, {
				...payload,
				status: 'failed',
				error,
			});
		}
	}

	private insertLoopMessage(input: {
		runId: string;
		message: ChatMessage;
		origin: BotLoopMessageOrigin;
		status?: BotLoopMessageStatus;
		streamSeq?: number;
		displayEventSeq?: number;
		position?: number;
		createdAt?: string;
		broadcast: boolean;
	}): BotLoopMessage {
		const now = input.createdAt ?? new Date().toISOString();
		const messageJson = JSON.stringify(input.message);
		const tokenEstimate = estimateTextTokens(messageJson);
		const position = input.position ?? this.nextLoopMessagePosition();
		const displayEvent = this.loopMessageDisplayEventRow(input.displayEventSeq);
		this.state.storage.sql.exec(
			`INSERT INTO loop_messages (position, run_id, role, message_json, origin, status, token_estimate, stream_seq, display_event_seq, compacted_by, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			position,
			input.runId,
			input.message.role,
			messageJson,
			input.origin,
			input.status ?? null,
			tokenEstimate,
			input.streamSeq ?? null,
			displayEvent.display_event_seq,
			now,
		);
		const seq = this.state.storage.sql.exec<{ seq: number }>(`SELECT last_insert_rowid() AS seq`).one().seq;
		const message = loopMessageFromRow({
			seq,
			position,
			run_id: input.runId,
			role: input.message.role,
			message_json: messageJson,
			origin: input.origin,
			status: input.status ?? null,
			token_estimate: tokenEstimate,
			stream_seq: input.streamSeq ?? null,
			display_event_seq: displayEvent.display_event_seq,
			display_event_type: displayEvent.display_event_type,
			display_event_payload_json: displayEvent.display_event_payload_json,
			compacted_by: null,
			deleted_at: null,
			created_at: now,
			has_logs: 0,
		});
		if (input.broadcast) {
			this.broadcastLoopMessage(message);
		}
		return message;
	}

	private loopMessageDisplayEventRow(
		displayEventSeq: number | undefined,
	): Pick<LoopMessageRow, 'display_event_seq' | 'display_event_type' | 'display_event_payload_json'> {
		if (typeof displayEventSeq !== 'number' || !Number.isInteger(displayEventSeq) || displayEventSeq <= 0) {
			return {
				display_event_seq: null,
				display_event_type: null,
				display_event_payload_json: null,
			};
		}
		const row = this.state.storage.sql
			.exec<{ seq: number; type: BotRuntimeEventType; payload_json: string }>(
				`SELECT seq, type, payload_json
				 FROM events
				 WHERE seq = ?
				 LIMIT 1`,
				displayEventSeq,
			)
			.toArray()[0];
		if (!row || row.type !== 'tool_result') {
			return {
				display_event_seq: null,
				display_event_type: null,
				display_event_payload_json: null,
			};
		}
		return {
			display_event_seq: row.seq,
			display_event_type: row.type,
			display_event_payload_json: row.payload_json,
		};
	}

	private nextLoopMessagePosition(): number {
		const row = this.state.storage.sql
			.exec<{ position: number }>(`SELECT COALESCE(MAX(position), 0) + 1 AS position FROM loop_messages`)
			.one();
		return row.position;
	}

	private broadcastLoopMessage(message: BotLoopMessage): void {
		this.broadcastControl({ type: 'loop_message', loopMessage: { ...message, hasLogs: true } });
	}

	private activeLoopMessageRows(): LoopMessageRow[] {
		return this.state.storage.sql
			.exec<LoopMessageRow>(
				`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
				        m.token_estimate, m.stream_seq, m.compacted_by, m.deleted_at, m.created_at,
				        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
				 FROM loop_messages m
				 WHERE m.compacted_by IS NULL
				   AND m.deleted_at IS NULL
				 ORDER BY m.position ASC, m.seq ASC`,
			)
			.toArray();
	}

	private activeLoopMessagesForProvider(): ChatMessage[] {
		return this.activeProviderHistoryLoopMessageRows().map(loopMessageChatMessageFromRow);
	}

	private activeProviderHistoryLoopMessageRows(): LoopMessageRow[] {
		return this.activeLoopMessageRows().filter((row) =>
			loopMessageContributesToProviderHistory(row.origin, loopMessageChatMessageFromRow(row)),
		);
	}

	private async repairActiveProviderToolCallHistory(runId: string): Promise<DroppedProviderToolCall[]> {
		if (!this.hasRuntimeStorage()) {
			return [];
		}
		const repair = repairProviderToolCallHistoryRows(this.activeLoopMessageRows());
		if (repair.actions.length > 0) {
			const deletedAt = new Date().toISOString();
			for (const action of repair.actions) {
				if (action.kind === 'delete') {
					this.state.storage.sql.exec(
						`UPDATE loop_messages
						 SET deleted_at = ?
						 WHERE seq = ?
						   AND deleted_at IS NULL`,
						deletedAt,
						action.seq,
					);
				} else {
					const messageJson = JSON.stringify(action.message);
					this.state.storage.sql.exec(
						`UPDATE loop_messages
						 SET message_json = ?, token_estimate = ?
						 WHERE seq = ?
						   AND deleted_at IS NULL`,
						messageJson,
						estimateTextTokens(messageJson),
						action.seq,
					);
				}
			}
			this.broadcastControl({ type: 'loop_messages_reset' });
		}
		if (repair.repairedTextCount > 0) {
			await this.recordProviderHistoryRepair(runId, repair.repairedTextCount, repair.repairedMessageSeqs);
		}
		if (repair.dropped.length > 0) {
			await this.recordDroppedProviderToolCalls(runId, null, repair.dropped, 'history_repair', false);
		}
		await this.splitActiveProviderToolCallBundles(runId);
		return repair.dropped;
	}

	private async splitActiveProviderToolCallBundles(runId: string): Promise<number> {
		if (!this.hasRuntimeStorage()) {
			return 0;
		}
		let splitCount = 0;
		const repairedSeqs: number[] = [];
		const maxSplits = Math.max(1, this.activeLoopMessageRows().length);
		for (let attempts = 0; attempts < maxSplits; attempts += 1) {
			const split = this.activeProviderToolCallBundleSplit();
			if (!split) {
				break;
			}
			const insertedSeqs = this.applyProviderToolCallBundleSplit(split);
			splitCount += insertedSeqs.length;
			repairedSeqs.push(split.assistantRow.seq, ...insertedSeqs);
		}
		if (splitCount === 0) {
			return 0;
		}
		this.broadcastControl({ type: 'loop_messages_reset' });
		await this.recordProviderHistoryRepair(runId, splitCount, repairedSeqs, 'split_multi_tool_call_message');
		return splitCount;
	}

	private activeProviderToolCallBundleSplit(): ProviderToolCallBundleSplit | null {
		const rows = this.activeLoopMessageRows();
		const providerRows = rows
			.map((row) => ({ row, message: loopMessageChatMessageFromRow(row) }))
			.filter(({ row, message }) => loopMessageContributesToProviderHistory(row.origin, message));
		for (let index = 0; index < providerRows.length; index += 1) {
			const current = providerRows[index];
			if (
				!current ||
				current.message.role !== 'assistant' ||
				!Array.isArray(current.message.tool_calls) ||
				current.message.tool_calls.length <= 1
			) {
				continue;
			}
			const toolCalls = current.message.tool_calls;
			const expectedIds = new Set(toolCalls.map((toolCall) => toolCall.id));
			const toolRowsByCallId = new Map<string, LoopMessageRow>();
			let scan = index + 1;
			while (scan < providerRows.length && toolRowsByCallId.size < expectedIds.size) {
				const candidate = providerRows[scan];
				if (
					!candidate ||
					candidate.message.role !== 'tool' ||
					!candidate.message.tool_call_id ||
					!expectedIds.has(candidate.message.tool_call_id)
				) {
					break;
				}
				toolRowsByCallId.set(candidate.message.tool_call_id, candidate.row);
				scan += 1;
			}
			if (toolRowsByCallId.size !== toolCalls.length) {
				continue;
			}
			return {
				assistantRow: current.row,
				assistantMessage: current.message,
				pairs: toolCalls.map((toolCall) => ({ toolCall, toolRow: toolRowsByCallId.get(toolCall.id)! })),
			};
		}
		return null;
	}

	private applyProviderToolCallBundleSplit(split: ProviderToolCallBundleSplit): number[] {
		const activeRows = this.activeLoopMessageRows();
		const insertedSeqs: number[] = [];
		const originalMessage = providerResponseToolCallMessageForHistory(split.assistantMessage, split.pairs[0]!.toolCall, true);
		this.updateLoopMessageJson(split.assistantRow.seq, originalMessage);
		const insertedByToolRowSeq = new Map<number, number>();
		for (const pair of split.pairs.slice(1)) {
			const message = providerResponseToolCallMessageForHistory(split.assistantMessage, pair.toolCall, false);
			const inserted = this.insertLoopMessage({
				runId: split.assistantRow.run_id,
				message,
				origin: split.assistantRow.origin,
				status: split.assistantRow.status ?? undefined,
				streamSeq: split.assistantRow.stream_seq ?? undefined,
				createdAt: split.assistantRow.created_at,
				broadcast: false,
			});
			this.recordLoopMessageLog(inserted.seq, 'message', JSON.stringify(message));
			insertedSeqs.push(inserted.seq);
			insertedByToolRowSeq.set(pair.toolRow.seq, inserted.seq);
		}
		const toolRowSeqs = new Set(split.pairs.map((pair) => pair.toolRow.seq));
		const desiredSeqs: number[] = [];
		for (const row of activeRows) {
			if (row.seq === split.assistantRow.seq) {
				desiredSeqs.push(split.assistantRow.seq);
				for (const pair of split.pairs) {
					const insertedSeq = insertedByToolRowSeq.get(pair.toolRow.seq);
					if (insertedSeq !== undefined) {
						desiredSeqs.push(insertedSeq);
					}
					desiredSeqs.push(pair.toolRow.seq);
				}
				continue;
			}
			if (toolRowSeqs.has(row.seq)) {
				continue;
			}
			desiredSeqs.push(row.seq);
		}
		this.repositionActiveLoopMessages(desiredSeqs);
		return insertedSeqs;
	}

	private updateLoopMessageJson(seq: number, message: ChatMessage): void {
		const messageJson = JSON.stringify(message);
		this.state.storage.sql.exec(
			`UPDATE loop_messages
			 SET message_json = ?, token_estimate = ?
			 WHERE seq = ?
			   AND deleted_at IS NULL`,
			messageJson,
			estimateTextTokens(messageJson),
			seq,
		);
		this.recordLoopMessageLog(seq, 'message', messageJson);
	}

	private repositionActiveLoopMessages(seqOrder: readonly number[]): void {
		if (seqOrder.length === 0) {
			return;
		}
		const minPosition = this.state.storage.sql
			.exec<{ position: number }>(
				`SELECT COALESCE(MIN(position), 1) AS position
				 FROM loop_messages
				 WHERE compacted_by IS NULL
				   AND deleted_at IS NULL`,
			)
			.one().position;
		for (let index = 0; index < seqOrder.length; index += 1) {
			this.state.storage.sql.exec(
				`UPDATE loop_messages
				 SET position = ?
				 WHERE seq = ?
				   AND compacted_by IS NULL
				   AND deleted_at IS NULL`,
				minPosition + index,
				seqOrder[index],
			);
		}
	}

	private async recordProviderHistoryRepair(
		runId: string,
		count: number,
		messageSeqs: readonly number[],
		reason = 'invalid_unicode_text',
	): Promise<void> {
		await this.appendEvent(runId, 'provider_history_repaired', {
			runId,
			count,
			messageSeqs: [...messageSeqs],
			reason,
		});
	}

	private loopMessagesAfter(afterSeq: number): BotLoopMessage[] {
		return this.loopMessageRowsForPage(null, Math.max(0, Math.floor(afterSeq))).map(loopMessageFromRow);
	}

	private loopMessagesPage(input: { page: number; after?: number }): BotLoopMessagesResponse {
		const pageIndex = this.loopMessagePageIndex();
		const requestedPage = Math.max(1, Math.floor(input.page));
		const currentDescriptor = pageIndex.descriptors.find((descriptor) => descriptor.page === requestedPage) ??
			pageIndex.descriptors[pageIndex.descriptors.length - 1] ?? { page: 1, sourceCompactionSeq: null };
		const after = currentDescriptor.page === 1 ? Math.max(0, Math.floor(input.after ?? 0)) : 0;
		const rows = this.loopMessageRowsForPage(currentDescriptor.sourceCompactionSeq, after);
		const summaries = this.loopMessagePageSummaries(pageIndex);
		const currentSummary = summaries.find((summary) => summary.page === currentDescriptor.page);
		return {
			messages: rows.map(loopMessageFromRow),
			page: {
				currentPage: currentDescriptor.page,
				pageCount: pageIndex.descriptors.length,
				pages: summaries,
				compactionPageBySeq: Object.fromEntries([...pageIndex.compactionPageBySeq.entries()].map(([seq, page]) => [String(seq), page])),
				...(currentDescriptor.newerPage ? { newerPage: currentDescriptor.newerPage } : {}),
				...(currentSummary?.olderPage ? { olderPage: currentSummary.olderPage } : {}),
			},
		};
	}

	private loopMessagePageIndex(): LoopMessagePageIndex {
		const descriptors: LoopMessagePageDescriptor[] = [];
		const compactionPageBySeq = new Map<number, number>();
		const visitedSources = new Set<string>();
		const appendPage = (sourceCompactionSeq: number | null, newerPage?: number): void => {
			if (descriptors.length >= loopMessagePageIndexLimit) {
				return;
			}
			const sourceKey = sourceCompactionSeq === null ? 'active' : String(sourceCompactionSeq);
			if (visitedSources.has(sourceKey)) {
				return;
			}
			visitedSources.add(sourceKey);
			const descriptor: LoopMessagePageDescriptor = {
				page: descriptors.length + 1,
				sourceCompactionSeq,
				...(newerPage ? { newerPage } : {}),
			};
			descriptors.push(descriptor);
			for (const seq of this.loopMessageCompactionSeqsWithChildren(sourceCompactionSeq)) {
				if (descriptors.length >= loopMessagePageIndexLimit) {
					break;
				}
				if (compactionPageBySeq.has(seq)) {
					continue;
				}
				compactionPageBySeq.set(seq, descriptors.length + 1);
				appendPage(seq, descriptor.page);
			}
		};
		appendPage(null);
		return { descriptors, compactionPageBySeq };
	}

	private loopMessagePageSummaries(pageIndex: LoopMessagePageIndex): BotLoopMessagePageSummary[] {
		return pageIndex.descriptors.map((descriptor) => {
			const summary = this.loopMessagePageCount(descriptor.sourceCompactionSeq);
			const olderPage = pageIndex.descriptors.find((item) => item.newerPage === descriptor.page)?.page;
			return {
				page: descriptor.page,
				messageCount: summary.messageCount,
				...(summary.fromSeq !== null ? { fromSeq: summary.fromSeq } : {}),
				...(summary.toSeq !== null ? { toSeq: summary.toSeq } : {}),
				...(descriptor.sourceCompactionSeq !== null ? { sourceCompactionSeq: descriptor.sourceCompactionSeq } : {}),
				...(descriptor.newerPage ? { newerPage: descriptor.newerPage } : {}),
				...(olderPage ? { olderPage } : {}),
			};
		});
	}

	private loopMessageRowsForPage(sourceCompactionSeq: number | null, afterSeq: number): LoopMessageRow[] {
		if (sourceCompactionSeq === null) {
			const filters = ['m.compacted_by IS NULL', 'm.deleted_at IS NULL', ...(afterSeq > 0 ? ['m.seq > ?'] : [])];
			const params = [...(afterSeq > 0 ? [afterSeq] : [])];
			return this.state.storage.sql
				.exec<LoopMessageRow>(
					`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
					        m.token_estimate, m.stream_seq, m.display_event_seq, display.type AS display_event_type,
					        display.payload_json AS display_event_payload_json, m.compacted_by, m.deleted_at, m.created_at,
					        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
					 FROM loop_messages m
					 LEFT JOIN events display ON display.seq = m.display_event_seq
					 WHERE ${filters.join('\n\t\t\t\t\t   AND ')}
					 ORDER BY m.position ASC, m.seq ASC
					 ${afterSeq > 0 ? 'LIMIT 2000' : ''}`,
					...params,
				)
				.toArray();
		}
		return this.state.storage.sql
			.exec<LoopMessageRow>(
				`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
				        m.token_estimate, m.stream_seq, m.display_event_seq, display.type AS display_event_type,
				        display.payload_json AS display_event_payload_json, m.compacted_by, m.deleted_at, m.created_at,
				        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
				 FROM loop_messages m
				 LEFT JOIN events display ON display.seq = m.display_event_seq
				 WHERE m.compacted_by = ?
				   AND m.deleted_at IS NULL
				 ORDER BY m.position ASC, m.seq ASC`,
				sourceCompactionSeq,
			)
			.toArray();
	}

	private loopMessageCompactionSeqsWithChildren(sourceCompactionSeq: number | null): number[] {
		const rows = this.state.storage.sql
			.exec<{ seq: number }>(
				`SELECT m.seq
				 FROM loop_messages m
				 WHERE m.compacted_by ${sourceCompactionSeq === null ? 'IS NULL' : '= ?'}
				   AND m.deleted_at IS NULL
				   AND m.origin = 'compaction'
				   AND EXISTS (
					SELECT 1
					FROM loop_messages child
					WHERE child.compacted_by = m.seq
					  AND child.deleted_at IS NULL
				   )
				 ORDER BY m.position DESC, m.seq DESC`,
				...(sourceCompactionSeq === null ? [] : [sourceCompactionSeq]),
			)
			.toArray();
		return rows.map((row) => row.seq).filter((seq) => Number.isInteger(seq));
	}

	private latestActiveLoopCompactionBoundary(): { messageSeq: number; requestSeq: number; created_at: string } | null {
		const row = this.state.storage.sql
			.exec<{ message_seq: number; request_seq: number | null; created_at: string }>(
				`SELECT m.seq AS message_seq, m.stream_seq AS request_seq, m.created_at
				 FROM loop_messages m
				 WHERE m.compacted_by IS NULL
				   AND m.deleted_at IS NULL
				   AND m.origin = 'compaction'
				   AND EXISTS (
					SELECT 1
					FROM loop_messages child
					WHERE child.compacted_by = m.seq
					  AND child.deleted_at IS NULL
				   )
				 ORDER BY m.seq DESC
				 LIMIT 1`,
			)
			.toArray()[0];
		if (!row || typeof row.message_seq !== 'number' || typeof row.created_at !== 'string') {
			return null;
		}
		const requestSeq = typeof row.request_seq === 'number' ? row.request_seq : row.message_seq;
		return { messageSeq: row.message_seq, requestSeq, created_at: row.created_at };
	}

	private loopMessagePageCount(sourceCompactionSeq: number | null): { messageCount: number; fromSeq: number | null; toSeq: number | null } {
		const rows = this.loopMessageRowsForPage(sourceCompactionSeq, 0);
		const seqs = rows.map((row) => row.seq);
		return {
			messageCount: rows.length,
			fromSeq: seqs.length > 0 ? Math.min(...seqs) : null,
			toSeq: seqs.length > 0 ? Math.max(...seqs) : null,
		};
	}

	private loopMessageLogsForSeq(seq: number): BotLoopMessageLogsResponse {
		if (!Number.isInteger(seq) || seq <= 0) {
			throw new RepositoryError('bad_request', 'Loop message sequence is invalid.', 400);
		}
		const row = this.state.storage.sql
			.exec<LoopMessageRow>(
				`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
				        m.token_estimate, m.stream_seq, m.display_event_seq, display.type AS display_event_type,
				        display.payload_json AS display_event_payload_json, m.compacted_by, m.deleted_at, m.created_at,
				        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
				 FROM loop_messages m
				 LEFT JOIN events display ON display.seq = m.display_event_seq
				 WHERE m.seq = ?
				 LIMIT 1`,
				seq,
			)
			.toArray()[0];
		if (!row) {
			throw new RepositoryError('not_found', 'Loop message was not found.', 404);
		}
		const logs = this.state.storage.sql
			.exec<LoopMessageLogRow>(
				`SELECT id, message_seq, kind, encoding, base_log_id, prefix_length, text_length, chunk_count, created_at
				 FROM loop_message_logs
				 WHERE message_seq = ?
				 ORDER BY id ASC`,
				seq,
			)
			.toArray()
			.map((log) => loopMessageLogFromRow(log, this.reconstructLoopMessageLogText(log.id)));
		const requestUsage = row.stream_seq ? this.loopMessageRequestUsage(row.run_id, row.stream_seq) : undefined;
		const requestMessages = this.loopMessageRequestMessages(logs, requestUsage);
		return {
			message: loopMessageFromRow(row),
			logs,
			...(requestMessages.length > 0 ? { requestMessages } : {}),
			...(requestUsage ? { requestUsage } : {}),
		};
	}

	private loopMessageRequestUsage(runId: string, requestSeq: number): BotLoopMessageRequestUsage | undefined {
		const row = this.state.storage.sql
			.exec<ProviderUsageLogRow>(
				`SELECT created_at, run_id, model, requested_model, response_model, provider_name, context_window_tokens,
				        prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens, cost, usage_json
				 FROM provider_usage
				 WHERE run_id = ?
				   AND request_seq = ?
				 ORDER BY id DESC
				 LIMIT 1`,
				runId,
				requestSeq,
			)
			.toArray()[0];
		if (!row) {
			return undefined;
		}
		let raw: Record<string, unknown> = {};
		try {
			raw = runtimeRecord(JSON.parse(row.usage_json));
		} catch {
			raw = {};
		}
		const costDetails = runtimeRecord(raw.cost_details);
		const totalCost = row.cost ?? numberValue(raw.cost) ?? null;
		let promptCost = numberValue(costDetails.upstream_inference_prompt_cost) ?? null;
		let outputCost = numberValue(costDetails.upstream_inference_completions_cost) ?? null;
		if (promptCost === null && totalCost !== null && outputCost !== null) {
			promptCost = Math.max(0, totalCost - outputCost);
		}
		if (outputCost === null && totalCost !== null && promptCost !== null) {
			outputCost = Math.max(0, totalCost - promptCost);
		}
		const cachedInputTokens = Math.min(row.prompt_tokens, Math.max(0, row.cached_tokens));
		const uncachedInputTokens = Math.max(0, row.prompt_tokens - cachedInputTokens);
		const cachedInputCost = promptCost === null ? null : row.prompt_tokens > 0 ? promptCost * (cachedInputTokens / row.prompt_tokens) : 0;
		const uncachedInputCost =
			promptCost === null ? null : row.prompt_tokens > 0 ? promptCost * (uncachedInputTokens / row.prompt_tokens) : 0;
		return {
			promptTokens: row.prompt_tokens,
			cachedInputTokens,
			uncachedInputTokens,
			outputTokens: row.completion_tokens,
			totalTokens: row.total_tokens,
			cachedInputCost,
			uncachedInputCost,
			outputCost,
			totalCost,
			estimatedCostSplit: promptCost !== null && cachedInputTokens > 0 && uncachedInputTokens > 0,
		};
	}

	private loopMessageRequestMessages(
		logs: readonly BotLoopMessageLog[],
		usage: BotLoopMessageRequestUsage | undefined,
	): BotLoopMessageRequestLogMessage[] {
		const requestLog = logs.find((log) => log.kind === 'provider_request' || log.kind === 'compaction_request');
		if (!requestLog) {
			return [];
		}
		let messages: BotInferenceSubmissionMessage[];
		try {
			const record = runtimeRecord(JSON.parse(requestLog.text));
			messages = Array.isArray(record.messages) ? (record.messages as BotInferenceSubmissionMessage[]) : [];
		} catch {
			return [];
		}
		if (messages.length === 0) {
			return [];
		}
		const calibration = this.textTokenCalibration();
		let consumed = 0;
		const cachedTokens = usage?.cachedInputTokens ?? 0;
		return messages.map((message, index) => {
			const tokens = estimateChatMessageTokens(message, calibration);
			const start = consumed;
			const end = consumed + tokens;
			consumed = end;
			const cacheStatus = cachedTokens <= start ? undefined : cachedTokens >= end ? 'cached' : 'partially_cached';
			return {
				message,
				position: index + 1,
				...(cacheStatus ? { cacheStatus } : {}),
			};
		});
	}

	private recordLoopMessageLog(messageSeq: number, kind: BotLoopMessageLogKind, text: string): void {
		const base = this.latestLoopMessageLogBase(kind);
		const encoded = base ? encodeLoopMessageLog(text, base.text, base.id) : { encoding: 'full' as const, text };
		const now = new Date().toISOString();
		const chunks = chunkText(encoded.text, loopMessageLogChunkLength);
		this.state.storage.sql.exec(
			`INSERT INTO loop_message_logs (message_seq, kind, encoding, base_log_id, prefix_length, text_length, chunk_count, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			messageSeq,
			kind,
			encoded.encoding,
			encoded.baseLogId ?? null,
			encoded.prefixLength ?? null,
			text.length,
			chunks.length,
			now,
		);
		const logId = this.state.storage.sql.exec<{ id: number }>(`SELECT last_insert_rowid() AS id`).one().id;
		for (let index = 0; index < chunks.length; index += 1) {
			this.state.storage.sql.exec(
				`INSERT INTO loop_message_log_chunks (log_id, chunk_index, text) VALUES (?, ?, ?)`,
				logId,
				index,
				chunks[index] ?? '',
			);
		}
		this.pruneLoopMessageLogs();
	}

	private latestLoopMessageLogBase(kind: BotLoopMessageLogKind): { id: number; text: string } | null {
		const row = this.state.storage.sql
			.exec<{ id: number }>(
				`SELECT id
				 FROM loop_message_logs
				 WHERE kind = ?
				 ORDER BY id DESC
				 LIMIT 1`,
				kind,
			)
			.toArray()[0];
		return row ? { id: row.id, text: this.reconstructLoopMessageLogText(row.id) } : null;
	}

	private reconstructLoopMessageLogText(logId: number, seen = new Set<number>()): string {
		if (seen.has(logId)) {
			throw new RepositoryError('server_error', 'Loop message log chain is cyclic.', 500);
		}
		seen.add(logId);
		const row = this.state.storage.sql
			.exec<LoopMessageLogRow>(
				`SELECT id, message_seq, kind, encoding, base_log_id, prefix_length, text_length, chunk_count, created_at
				 FROM loop_message_logs
				 WHERE id = ?
				 LIMIT 1`,
				logId,
			)
			.toArray()[0];
		if (!row) {
			throw new RepositoryError('not_found', 'Loop message log was not found.', 404);
		}
		const encoded = this.state.storage.sql
			.exec<LoopMessageLogChunkRow>(
				`SELECT log_id, chunk_index, text
				 FROM loop_message_log_chunks
				 WHERE log_id = ?
				 ORDER BY chunk_index ASC`,
				logId,
			)
			.toArray()
			.map((chunk) => chunk.text)
			.join('');
		if (row.encoding === 'full') {
			return encoded;
		}
		if (!row.base_log_id) {
			throw new RepositoryError('server_error', 'Delta log is missing its base.', 500);
		}
		const base = this.reconstructLoopMessageLogText(row.base_log_id, seen);
		if (row.encoding === 'append') {
			return `${base}${encoded}`;
		}
		return `${base.slice(0, row.prefix_length ?? 0)}${encoded}`;
	}

	private pruneLoopMessageLogs(): void {
		const retainedMessageSeqs = new Set(
			this.state.storage.sql
				.exec<{ seq: number }>(
					`SELECT seq
					 FROM loop_messages
					 WHERE compacted_by IS NULL
					 ORDER BY position DESC, seq DESC
					 LIMIT ?`,
					loopMessageLogRetentionCount,
				)
				.toArray()
				.map((row) => row.seq),
		);
		if (retainedMessageSeqs.size === 0) {
			this.state.storage.sql.exec(`DELETE FROM loop_message_log_chunks`);
			this.state.storage.sql.exec(`DELETE FROM loop_message_logs`);
			return;
		}
		const retainedLogRows = this.state.storage.sql
			.exec<LoopMessageLogRow>(
				`SELECT id, message_seq, kind, encoding, base_log_id, prefix_length, text_length, chunk_count, created_at
				 FROM loop_message_logs
				 ORDER BY id ASC`,
			)
			.toArray();
		const deleteIds = new Set(retainedLogRows.filter((row) => !retainedMessageSeqs.has(row.message_seq)).map((row) => row.id));
		for (const row of retainedLogRows) {
			if (!retainedMessageSeqs.has(row.message_seq) || !row.base_log_id || !deleteIds.has(row.base_log_id)) {
				continue;
			}
			this.materializeLoopMessageLog(row.id);
		}
		for (const id of deleteIds) {
			this.state.storage.sql.exec(`DELETE FROM loop_message_log_chunks WHERE log_id = ?`, id);
			this.state.storage.sql.exec(`DELETE FROM loop_message_logs WHERE id = ?`, id);
		}
	}

	private materializeLoopMessageLog(logId: number): void {
		const text = this.reconstructLoopMessageLogText(logId);
		const chunks = chunkText(text, loopMessageLogChunkLength);
		this.state.storage.sql.exec(
			`UPDATE loop_message_logs
			 SET encoding = 'full', base_log_id = NULL, prefix_length = NULL, text_length = ?, chunk_count = ?
			 WHERE id = ?`,
			text.length,
			chunks.length,
			logId,
		);
		this.state.storage.sql.exec(`DELETE FROM loop_message_log_chunks WHERE log_id = ?`, logId);
		for (let index = 0; index < chunks.length; index += 1) {
			this.state.storage.sql.exec(
				`INSERT INTO loop_message_log_chunks (log_id, chunk_index, text) VALUES (?, ?, ?)`,
				logId,
				index,
				chunks[index] ?? '',
			);
		}
	}

	private async recordProviderUsage(input: {
		contextWindowTokens: number;
		createdAt: string;
		providerName?: string;
		providerResponseId?: string;
		requestSeq: number;
		responseModel?: string;
		runId: string;
		settings: ProviderSettings;
		usage: ProviderUsage;
	}): Promise<void> {
		const model = input.responseModel?.trim() || input.settings.model;
		const providerName = await this.providerUsageProviderName(input.settings, input.providerName, input.providerResponseId);
		this.state.storage.sql.exec(
			`INSERT INTO provider_usage (
				run_id, request_seq, provider_response_id, requested_model, response_model, model,
				context_window_tokens, provider_base_url, provider_name, prompt_tokens, completion_tokens, total_tokens,
				cached_tokens, reasoning_tokens, cost, usage_json, created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			input.runId,
			input.requestSeq,
			input.providerResponseId ?? null,
			input.settings.model,
			input.responseModel ?? null,
			model,
			input.contextWindowTokens,
			input.settings.baseUrl,
			providerName,
			input.usage.promptTokens,
			input.usage.completionTokens,
			input.usage.totalTokens,
			input.usage.cachedTokens,
			input.usage.reasoningTokens,
			input.usage.cost,
			JSON.stringify(input.usage.raw),
			input.createdAt,
		);
	}

	private async providerUsageProviderName(
		settings: ProviderSettings,
		responseProviderName: string | undefined,
		providerResponseId: string | undefined,
	): Promise<string | null> {
		if (!isOpenRouterProviderBaseUrl(settings.baseUrl)) {
			return providerNameFromBaseUrl(settings.baseUrl);
		}
		const providerName = normalizedProviderName(responseProviderName);
		if (providerName) {
			return providerName;
		}
		if (!settings.apiKey || !providerResponseId?.trim()) {
			return null;
		}
		try {
			return await fetchOpenRouterGenerationProviderName(settings.baseUrl, settings.apiKey, providerResponseId);
		} catch {
			return null;
		}
	}

	private recordProviderTokenCalibrationSample(input: {
		attempt: number;
		createdAt: string;
		purpose: BotInferenceSubmissionPurpose;
		request: ProviderTokenCalibrationRequestShape;
		requestSeq: number;
		responseModel?: string;
		runId: string;
		settings: Pick<ProviderSettings, 'baseUrl' | 'model'>;
		usage: ProviderUsage;
	}): void {
		if (!this.hasRuntimeStorage()) {
			return;
		}
		const promptTokens = Math.max(0, Math.floor(input.usage.promptTokens));
		const requestCharacters = providerTokenCalibrationRequestCharacterCount(input.request);
		if (promptTokens <= 0 || requestCharacters <= 0) {
			return;
		}
		this.state.storage.sql.exec(
			`INSERT INTO provider_token_calibration_samples (
				run_id, request_seq, attempt, purpose, requested_model, response_model,
				provider_base_url, prompt_tokens, request_characters, created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			input.runId,
			input.requestSeq,
			Math.max(1, Math.floor(input.attempt)),
			input.purpose,
			input.settings.model,
			input.responseModel ?? null,
			input.settings.baseUrl,
			promptTokens,
			requestCharacters,
			input.createdAt,
		);
		this.pruneProviderTokenCalibrationSamples(input.settings.model);
	}

	private recordProviderTokenCalibrationSampleFromError(input: {
		attempt: number;
		createdAt: string;
		error: unknown;
		purpose: BotInferenceSubmissionPurpose;
		request: ProviderTokenCalibrationRequestShape;
		requestSeq: number;
		runId: string;
		settings: Pick<ProviderSettings, 'baseUrl' | 'model'>;
	}): void {
		const metadata = providerTokenUsageMetadataFromError(input.error);
		if (!metadata?.usage) {
			return;
		}
		this.recordProviderTokenCalibrationSample({
			attempt: input.attempt,
			createdAt: input.createdAt,
			purpose: input.purpose,
			request: input.request,
			requestSeq: input.requestSeq,
			...(metadata.responseModel ? { responseModel: metadata.responseModel } : {}),
			runId: input.runId,
			settings: input.settings,
			usage: metadata.usage,
		});
	}

	private pruneProviderTokenCalibrationSamples(requestedModel: string): void {
		this.state.storage.sql.exec(
			`DELETE FROM provider_token_calibration_samples
			 WHERE requested_model = ?
			   AND id NOT IN (
				SELECT id
				FROM provider_token_calibration_samples
				WHERE requested_model = ?
				ORDER BY id DESC
				LIMIT ?
			   )`,
			requestedModel,
			requestedModel,
			providerTokenCalibrationRetentionCount,
		);
	}

	private backfillProviderTokenCalibrationSamples(): void {
		if (this.runtimeStateBoolean('provider_token_calibration_samples_backfilled')) {
			return;
		}
		const rows = this.state.storage.sql
			.exec<ProviderTokenCalibrationLegacyBackfillRow>(
				`SELECT s.event_seq, s.run_id, s.purpose, s.messages_json, s.model AS requested_model,
				        u.response_model, s.provider_base_url, u.prompt_tokens, u.created_at
				 FROM inference_submissions s
				 JOIN provider_usage u
				   ON u.request_seq = s.event_seq
				  AND u.run_id = s.run_id
				 WHERE u.prompt_tokens > 0
				 ORDER BY s.event_seq ASC`,
			)
			.toArray();
		for (const row of rows) {
			const requestCharacters = chatMessagesCharacterCountFromJson(row.messages_json);
			if (requestCharacters <= 0) {
				continue;
			}
			this.state.storage.sql.exec(
				`INSERT INTO provider_token_calibration_samples (
					run_id, request_seq, attempt, purpose, requested_model, response_model,
					provider_base_url, prompt_tokens, request_characters, created_at
				)
				VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
				row.run_id,
				row.event_seq,
				row.purpose,
				row.requested_model,
				row.response_model ?? null,
				row.provider_base_url,
				Math.max(0, Math.floor(row.prompt_tokens)),
				requestCharacters,
				row.created_at,
			);
		}
		this.setRuntimeState('provider_token_calibration_samples_backfilled', true);
	}

	private recordInferenceSubmission(input: {
		seq: number;
		runId: string;
		purpose: BotInferenceSubmissionPurpose;
		settings: ProviderSettings;
		messages: ChatMessage[];
		displayMessages?: ChatMessage[];
		createdAt: string;
	}): void {
		const messages = sanitizeProviderMessagesForRequest(providerMessagesWithPrefillCompatibility(input.settings, input.messages));
		const displayMessages = input.displayMessages ? sanitizeProviderMessagesForRequest(input.displayMessages) : undefined;
		this.state.storage.sql.exec(
			`INSERT INTO inference_submissions (
				id, event_seq, run_id, purpose, model, provider_base_url, message_count, messages_json, display_messages_json, created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(event_seq) DO UPDATE SET
				run_id = excluded.run_id,
				purpose = excluded.purpose,
				model = excluded.model,
				provider_base_url = excluded.provider_base_url,
				message_count = excluded.message_count,
				messages_json = excluded.messages_json,
				display_messages_json = excluded.display_messages_json,
				created_at = excluded.created_at`,
			crypto.randomUUID(),
			input.seq,
			input.runId,
			input.purpose,
			input.settings.model,
			input.settings.baseUrl,
			messages.length,
			JSON.stringify(messages),
			displayMessages ? JSON.stringify(displayMessages) : null,
			input.createdAt,
		);
		this.pruneInferenceSubmissions();
	}

	private updateInferenceSubmissionDisplayMessages(seq: number, messages: ChatMessage[]): void {
		const sanitizedMessages = sanitizeProviderMessagesForRequest(messages);
		this.state.storage.sql.exec(
			`UPDATE inference_submissions
			 SET display_messages_json = ?
			 WHERE event_seq = ?`,
			JSON.stringify(sanitizedMessages),
			seq,
		);
	}

	private pruneInferenceSubmissions(): void {
		this.state.storage.sql.exec(
			`DELETE FROM inference_submissions
			 WHERE id NOT IN (
				SELECT id
				FROM inference_submissions
				ORDER BY event_seq DESC
				LIMIT ?
			 )`,
			inferenceSubmissionRetentionCount,
		);
	}

	private inferenceSubmissionSummaries(): BotInferenceSubmissionSummary[] {
		return this.state.storage.sql
			.exec<InferenceSubmissionRow>(
				`SELECT id, event_seq, run_id, purpose, model, provider_base_url, message_count, messages_json, display_messages_json, created_at
				 FROM inference_submissions
				 ORDER BY event_seq ASC`,
			)
			.toArray()
			.map(inferenceSubmissionSummaryFromRow);
	}

	private inferenceSubmissionForSeq(seq: number): BotInferenceSubmission {
		if (!Number.isInteger(seq) || seq <= 0) {
			throw new RepositoryError('bad_request', 'Inference submission sequence is invalid.', 400);
		}
		const row = this.state.storage.sql
			.exec<InferenceSubmissionRow>(
				`SELECT id, event_seq, run_id, purpose, model, provider_base_url, message_count, messages_json, display_messages_json, created_at
				 FROM inference_submissions
				 WHERE event_seq = ?
				 LIMIT 1`,
				seq,
			)
			.toArray()[0];
		if (!row) {
			throw new RepositoryError('not_found', 'Inference submission was not found.', 404);
		}
		return {
			...inferenceSubmissionSummaryFromRow(row),
			messages: inferenceSubmissionMessagesFromRow(row),
			...inferenceSubmissionDisplayMessagesFromRow(row),
		};
	}

	private deleteInferenceSubmissionsForSeq(seq: number): number {
		this.state.storage.sql.exec(`DELETE FROM inference_submissions WHERE event_seq = ?`, seq);
		return this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
	}

	private clearInferenceSubmissions(): number {
		this.state.storage.sql.exec(`DELETE FROM inference_submissions`);
		return this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
	}

	private tokenUsageStats(bot: BotDocument, now = new Date()): BotTokenUsageStats {
		const windowEndMs = now.getTime();
		const windowStartMs = windowEndMs - 7 * dayMs;
		const last24StartMs = windowEndMs - dayMs;
		const windowStart = new Date(windowStartMs).toISOString();
		const windowEnd = now.toISOString();
		const rows = this.providerUsageRows(windowStart, windowEnd);
		const buckets = sevenDayUsageBuckets(windowStartMs, rows);
		const last24Hours = emptyUsageTotals();
		const last7Days = emptyUsageTotals();
		const models = new Map<string, BotTokenUsageModelBreakdown>();

		for (const row of rows) {
			const usedAt = Date.parse(row.created_at);
			addUsageRow(last7Days, row);
			if (Number.isFinite(usedAt) && usedAt >= last24StartMs) {
				addUsageRow(last24Hours, row);
			}
			const providerName = row.provider_name?.trim();
			if (providerName) {
				const modelKey = `${row.requested_model}\u0000${providerName}`;
				const current = models.get(modelKey);
				if (current) {
					addUsageRow(current, row);
					current.firstUsedAt = row.created_at < current.firstUsedAt ? row.created_at : current.firstUsedAt;
					current.lastUsedAt = row.created_at > current.lastUsedAt ? row.created_at : current.lastUsedAt;
				} else {
					const totals = emptyUsageTotals();
					addUsageRow(totals, row);
					models.set(modelKey, {
						...totals,
						model: row.requested_model,
						providerName,
						firstUsedAt: row.created_at,
						lastUsedAt: row.created_at,
					});
				}
			}
		}
		const dailyAverageDays = tokenUsageAverageDays(rows, windowEndMs);
		const contextWindow = this.contextWindowBreakdown(bot);

		return {
			generatedAt: windowEnd,
			windowStart,
			windowEnd,
			last24Hours,
			last7Days,
			dailyAverageTokens: dailyAverageDays > 0 ? Math.round(last7Days.totalTokens / dailyAverageDays) : 0,
			dailyAverageDays,
			buckets,
			models: [...models.values()].sort(compareTokenUsageModelBreakdowns),
			changeMarkers: this.tokenUsageChangeMarkers(windowStart, windowEnd),
			...(contextWindow ? { contextWindow } : {}),
		};
	}

	private async tokenSpendSummary(bot: BotDocument, now = new Date()): Promise<BotTokenSpendSummary> {
		const owner = await userById(this.env.BICKR_KV, bot.ownerUserId);
		const currentModel = this.effectiveProviderSettings(bot, owner).model;
		const windowEndMs = now.getTime();
		const windowStartMs = windowEndMs - 7 * dayMs;
		const rows = this.providerUsageRows(new Date(windowStartMs).toISOString(), now.toISOString());
		return this.tokenSpendSummaryForRows(bot.id, currentModel, rows, now);
	}

	private tokenSpendSummaryForRows(
		botId: string,
		currentModel: string,
		rows: ProviderUsageRow[],
		now = new Date(),
	): BotTokenSpendSummary {
		return botTokenSpendSummaryFromUsageRows(
			botId,
			currentModel,
			rows.map((row) => ({
				botId,
				createdAt: row.created_at,
				runId: row.run_id,
				requestedModel: row.requested_model,
				cost: row.cost,
			})),
			now,
		);
	}

	private contextWindowBreakdown(bot: BotDocument): BotContextWindowBreakdown | undefined {
		const boundary = this.latestActiveLoopCompactionBoundary();
		const latest = this.latestLoopProviderUsage();
		if (!latest) {
			return undefined;
		}
		if (boundary && latest.request_seq <= boundary.requestSeq) {
			return undefined;
		}
		const baseline = this.firstLoopProviderUsageAfterSeq(boundary?.requestSeq);
		if (!baseline) {
			return undefined;
		}
		const contextWindowTokens = effectiveTickSettings(bot.tickSettings).contextWindowTokens;
		const requestContextWindowTokens = effectiveContextWindowForModel(
			contextWindowTokens,
			latest.requested_model,
			isOpenRouterProviderBaseUrl(latest.provider_base_url),
		);
		const promptTokens = Math.max(0, Math.floor(latest.prompt_tokens));
		const baselinePromptTokens = Math.max(0, Math.floor(baseline.prompt_tokens));
		const initialTokens = Math.min(baselinePromptTokens, promptTokens);
		const ongoingTokens = Math.max(0, promptTokens - baselinePromptTokens);
		const freeTokens = Math.max(0, requestContextWindowTokens - promptTokens);
		const compactionCutoffTokens = this.nextCompactionTokens(bot, requestContextWindowTokens, latest.requested_model);
		return {
			usedAt: latest.created_at,
			runId: latest.run_id,
			requestSeq: latest.request_seq,
			model: latest.model,
			requestedModel: latest.requested_model,
			...(latest.response_model ? { responseModel: latest.response_model } : {}),
			contextWindowTokens: requestContextWindowTokens,
			promptTokens,
			baselineUsedAt: baseline.created_at,
			baselineRequestSeq: baseline.request_seq,
			baselinePromptTokens,
			initialTokens,
			ongoingTokens,
			freeTokens,
			compactionCutoffTokens,
			responseReserveTokens: providerContextReserveTokens,
		};
	}

	private async cachedPromptContextBudget(botId: string): Promise<BotContextBudget | null> {
		return this.promptContextBudgetForInput(botId, undefined, false);
	}

	private async promptContextBudget(botId: string, input: BotContextBudgetInput): Promise<BotContextBudget> {
		const budget = await this.promptContextBudgetForInput(botId, input, true);
		if (!budget) {
			throw new Error('Prompt context budget was not available after computation.');
		}
		return budget;
	}

	private async promptContextBudgetForInput(
		botId: string,
		input: BotContextBudgetInput | undefined,
		computeIfMissing: boolean,
	): Promise<BotContextBudget | null> {
		const currentBot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
		const owner = await userById(this.env.BICKR_KV, currentBot.ownerUserId);
		const inferenceSettings = enforceInferenceModelAccess(
			mergeInferenceSettings(currentBot.inferenceSettings, input?.inferenceSettings),
			owner.inferenceSettings,
		);
		const toolSettings = mergeToolSettings(currentBot.toolSettings, input?.toolSettings);
		const postingSettings = mergePostingSettings(currentBot.postingSettings, input?.postingSettings);
		const inputLanguage = input?.language ?? currentBot.language;
		const includeLanguageInSystemPrompt =
			input?.includeLanguageInSystemPrompt ?? currentBot.includeLanguageInSystemPrompt ?? false;
		const bot = await this.botWithEffectivePostingSettings({
			...currentBot,
			includeLanguageInSystemPrompt,
			displayName: input?.displayName ? { lang: inputLanguage, text: input.displayName } : currentBot.displayName,
			prompt: input?.prompt ? { lang: inputLanguage, text: input.prompt } : currentBot.prompt,
			shortBio: input?.shortBio ? { lang: inputLanguage, text: input.shortBio } : currentBot.shortBio,
			inferenceSettings,
			toolSettings,
			postingSettings,
			tickSettings: mergeTickSettings(currentBot.tickSettings, input?.tickSettings),
		});
		const tickSettings = effectiveTickSettings(bot.tickSettings);
		const settings = this.effectiveProviderSettings(bot, owner);
		if (computeIfMissing && !settings.apiKey && !settings.usesCustomBaseUrl && this.env.BICKR_SIMULATION_MODE !== 'provider') {
			throw new InputError('Configure an OpenRouter API key or custom inference base URL to compute exact tokens.');
		}

		const { fixedSystemMessage, fullSystemMessage, personaSystemMessage, reasoningPrefill, providerTools } = contextBudgetPromptParts(bot, settings);
		const fixedSystemFingerprint = await sha256Hex(
			JSON.stringify({
				system: fixedSystemMessage,
				messages: providerMessagesWithPrefillCompatibility(
					settings,
					providerMessagesWithReasoningPrefill([{ role: 'system', content: fixedSystemMessage }], reasoningPrefill),
				),
				tools: providerTools,
			}),
		);
		const personaPromptFingerprint = await sha256Hex(localizedTextString(bot.prompt));
		const worldPromptFingerprint = await sha256Hex(bot.worldPrompt ?? '');
		const fingerprint = await promptContextBudgetCacheFingerprint({
			botId,
			compactionMode: settings.compactionMode ?? 'structured_output',
			effectiveModel: settings.model,
			fixedSystemFingerprint,
			personaPromptFingerprint,
			providerBaseUrl: settings.baseUrl,
			...(settings.providerRouting ? { providerRouting: settings.providerRouting } : {}),
			supportsPrefill: settings.supportsPrefill ?? true,
			worldPromptFingerprint,
		});
		const cachedCounts = this.contextBudgetCachedCounts(fingerprint);
		if (!cachedCounts && !computeIfMissing) {
			return null;
		}
		const counts =
			cachedCounts ??
			(await (async () => {
				const fixedUsage = await this.fetchPromptTokenProbeUsage(
					settings,
					providerMessagesWithPrefillCompatibility(
						settings,
						providerMessagesWithReasoningPrefill([{ role: 'system', content: fixedSystemMessage }], reasoningPrefill),
					),
					providerTools,
				);
				const personaUsage = await this.fetchPromptTokenProbeUsage(
					settings,
					providerMessagesWithPrefillCompatibility(
						settings,
						providerMessagesWithReasoningPrefill([{ role: 'system', content: personaSystemMessage }], reasoningPrefill),
					),
					providerTools,
				);
				const fullUsage = await this.fetchPromptTokenProbeUsage(
					settings,
					providerMessagesWithPrefillCompatibility(
						settings,
						providerMessagesWithReasoningPrefill([{ role: 'system', content: fullSystemMessage }], reasoningPrefill),
					),
					providerTools,
				);
				const next = {
					fixedSystemTokens: fixedUsage.promptTokens,
					personaPromptTokens: Math.max(0, personaUsage.promptTokens - fixedUsage.promptTokens),
					worldPromptTokens: Math.max(0, fullUsage.promptTokens - personaUsage.promptTokens),
				};
				this.setContextBudgetCachedCounts(fingerprint, next);
				return next;
			})());
		const requestContextWindowTokens = effectiveContextWindowTokensForModel(settings, tickSettings.contextWindowTokens);
		const budget = promptContextBudgetFromCounts({
			...counts,
			contextWindowTokens: requestContextWindowTokens,
			responseReserveTokens: providerContextReserveTokens,
		});
		const calibration = this.textTokenCalibration(settings.model);
		const compactionLimits = providerCompactionSummaryLimitsForChat(
			bot,
			[],
			calibration,
			providerTools,
			providerCompactionMode(settings),
			requestContextWindowTokens,
		);
		const minimumCompactedPromptTokens = estimatedMinimumCompactedPromptTokens(
			{
				baseUrl: settings.baseUrl,
				fixedSystemMessage,
				fullSystemMessage,
				model: settings.model,
				personaSystemMessage,
				reasoningPrefill,
				providerTools,
				supportsPrefill: settings.supportsPrefill ?? true,
			},
			calibration,
		);
		return {
			botId,
			cached: Boolean(cachedCounts),
			contextWindowTokens: requestContextWindowTokens,
			effectiveModel: settings.model,
			fingerprint,
			minimumCompactedPromptOverageTokens: Math.max(0, minimumCompactedPromptTokens - compactionLimits.nextCompactionTokens),
			minimumCompactedPromptTokens,
			nextCompactionTokens: compactionLimits.nextCompactionTokens,
			providerBaseUrl: settings.baseUrl,
			...budget,
		};
	}

	private async readCommentTreeTokenBudget(bot: BotDocument): Promise<number> {
		const owner = await userById(this.env.BICKR_KV, bot.ownerUserId);
		const settings = this.effectiveProviderSettings(bot, owner);
		const parts = contextBudgetPromptParts(bot, settings);
		const fixedSystemFingerprint = await sha256Hex(
			JSON.stringify({
				system: parts.fixedSystemMessage,
				messages: providerMessagesWithPrefillCompatibility(
					settings,
					providerMessagesWithReasoningPrefill([{ role: 'system', content: parts.fixedSystemMessage }], parts.reasoningPrefill),
				),
				tools: parts.providerTools,
			}),
		);
		const personaPromptFingerprint = await sha256Hex(localizedTextString(bot.prompt));
		const worldPromptFingerprint = await sha256Hex(stringValue('worldPrompt' in bot ? bot.worldPrompt : undefined) ?? '');
		const cachedCounts = this.contextBudgetCachedCounts(
			await promptContextBudgetCacheFingerprint({
				botId: bot.id,
				compactionMode: settings.compactionMode ?? 'structured_output',
				effectiveModel: settings.model,
				fixedSystemFingerprint,
				personaPromptFingerprint,
				providerBaseUrl: settings.baseUrl,
				...(settings.providerRouting ? { providerRouting: settings.providerRouting } : {}),
				supportsPrefill: settings.supportsPrefill ?? true,
				worldPromptFingerprint,
			}),
		);
		const counts = cachedCounts ?? this.estimatedContextBudgetCounts(parts, this.textTokenCalibration(settings.model));
		const tickSettings = effectiveTickSettings(bot.tickSettings);
		const requestContextWindowTokens = effectiveContextWindowTokensForModel(settings, tickSettings.contextWindowTokens);
		return providerReadCommentTreeTokenBudget(
			promptContextBudgetFromCounts({
				...counts,
				contextWindowTokens: requestContextWindowTokens,
				responseReserveTokens: providerContextReserveTokens,
			}).remainingLoopTokens,
		);
	}

	private estimatedContextBudgetCounts(
		parts: ContextBudgetPromptParts,
		calibration: TextTokenCalibration,
	): Pick<PromptContextBudgetCounts, 'fixedSystemTokens' | 'personaPromptTokens' | 'worldPromptTokens'> {
		const fixedSystemTokens = estimatedPromptContextTokens(
			parts.fixedSystemMessage,
			parts.reasoningPrefill,
			parts.providerTools,
			calibration,
		);
		const personaSystemTokens = estimatedPromptContextTokens(
			parts.personaSystemMessage,
			parts.reasoningPrefill,
			parts.providerTools,
			calibration,
		);
		const fullSystemTokens = estimatedPromptContextTokens(
			parts.fullSystemMessage,
			parts.reasoningPrefill,
			parts.providerTools,
			calibration,
		);
		return {
			fixedSystemTokens,
			personaPromptTokens: Math.max(0, personaSystemTokens - fixedSystemTokens),
			worldPromptTokens: Math.max(0, fullSystemTokens - personaSystemTokens),
		};
	}

	private contextBudgetCachedCounts(
		fingerprint: string,
	): Pick<PromptContextBudgetCounts, 'fixedSystemTokens' | 'personaPromptTokens' | 'worldPromptTokens'> | null {
		const row = this.state.storage.sql
			.exec<{ value_json: string }>(`SELECT value_json FROM runtime_state WHERE key = ?`, contextBudgetCacheStateKey(fingerprint))
			.toArray()[0];
		if (!row) {
			return null;
		}
		try {
			const record = runtimeRecord(JSON.parse(row.value_json));
			const fixedSystemTokens = integerValue(record.fixedSystemTokens);
			const personaPromptTokens = integerValue(record.personaPromptTokens);
			const worldPromptTokens = integerValue(record.worldPromptTokens) ?? 0;
			if (fixedSystemTokens === undefined || personaPromptTokens === undefined) {
				return null;
			}
			return { fixedSystemTokens, personaPromptTokens, worldPromptTokens };
		} catch {
			return null;
		}
	}

	private setContextBudgetCachedCounts(
		fingerprint: string,
		counts: Pick<PromptContextBudgetCounts, 'fixedSystemTokens' | 'personaPromptTokens' | 'worldPromptTokens'>,
	): void {
		this.state.storage.sql.exec(
			`INSERT INTO runtime_state (key, value_json)
			 VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
			contextBudgetCacheStateKey(fingerprint),
			JSON.stringify({
				...counts,
				createdAt: new Date().toISOString(),
			}),
		);
	}

	private providerUsageRows(since: string, until: string): ProviderUsageRow[] {
		return this.state.storage.sql
			.exec<ProviderUsageRow>(
				`SELECT created_at, run_id, model, requested_model, response_model, provider_name, context_window_tokens,
				        prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens, cost
				 FROM provider_usage
				 WHERE created_at >= ?
				   AND created_at <= ?
				 ORDER BY created_at ASC, id ASC`,
				since,
				until,
			)
			.toArray();
	}

	private providerUsageExportRows(since: string, afterId: number, limit: number): ProviderUsageExportRow[] {
		return this.state.storage.sql
			.exec<ProviderUsageExportRow>(
				`SELECT id, created_at, run_id, request_seq, model, requested_model, response_model, provider_base_url,
				        provider_name, context_window_tokens, prompt_tokens, completion_tokens, total_tokens,
				        cached_tokens, reasoning_tokens, cost
				 FROM provider_usage
				 WHERE id > ?
				   AND created_at >= ?
				 ORDER BY id ASC
				 LIMIT ?`,
				afterId,
				since,
				limit,
			)
			.toArray();
	}

	private centralProviderUsageExportCursor(): number {
		const record = this.runtimeStateRecord(centralProviderUsageExportCursorStateKey);
		return Math.max(0, integerValue(record?.lastExportedProviderUsageId) ?? 0);
	}

	private setCentralProviderUsageExportCursor(lastExportedProviderUsageId: number, exportedAt: string): void {
		this.setRuntimeState(centralProviderUsageExportCursorStateKey, {
			lastExportedProviderUsageId,
			exportedAt,
		});
	}

	private async exportRecentProviderUsage(bot: BotDocument, now = new Date()): Promise<void> {
		const since = new Date(now.getTime() - botInferenceUsageRetentionDays * dayMs).toISOString();
		const exportedAt = now.toISOString();
		const initialCursor = this.centralProviderUsageExportCursor();
		let afterId = initialCursor;
		let maxExportedProviderUsageId = initialCursor;
		for (;;) {
			const rows = this.providerUsageExportRows(since, afterId, providerUsageExportBatchSize);
			if (rows.length === 0) {
				break;
			}
			await recordBotInferenceUsageBatch(
				this.env.BICKR_D1,
				rows.map((row) => centralInferenceUsageRecord(bot, row, exportedAt)),
			);
			maxExportedProviderUsageId = Math.max(maxExportedProviderUsageId, ...rows.map((row) => row.id));
			afterId = maxExportedProviderUsageId;
			if (rows.length < providerUsageExportBatchSize) {
				break;
			}
		}
		if (maxExportedProviderUsageId > initialCursor) {
			this.setCentralProviderUsageExportCursor(maxExportedProviderUsageId, exportedAt);
		}
		await pruneBotInferenceUsage(this.env.BICKR_D1, now);
	}

	private latestLoopProviderUsage(): ProviderLoopUsageRow | null {
		return (
			this.state.storage.sql
				.exec<ProviderLoopUsageRow>(
					`SELECT u.created_at, u.run_id, u.request_seq, u.model, u.requested_model, u.response_model, u.provider_name,
					        u.provider_base_url,
				        u.context_window_tokens, u.prompt_tokens, u.completion_tokens, u.total_tokens,
				        u.cached_tokens, u.reasoning_tokens, u.cost
				 FROM provider_usage u
				 JOIN inference_submissions s
				   ON s.event_seq = u.request_seq
				  AND s.run_id = u.run_id
				 WHERE s.purpose = 'loop'
				   AND u.prompt_tokens > 0
				 ORDER BY u.request_seq DESC, u.id DESC
				 LIMIT 1`,
				)
				.toArray()[0] ?? null
		);
	}

	private firstLoopProviderUsageAfterSeq(afterSeq?: number): ProviderLoopUsageRow | null {
		const seqFilter = afterSeq !== undefined ? 'AND u.request_seq > ?' : '';
		const params = afterSeq !== undefined ? [afterSeq] : [];
		return (
			this.state.storage.sql
				.exec<ProviderLoopUsageRow>(
					`SELECT u.created_at, u.run_id, u.request_seq, u.model, u.requested_model, u.response_model, u.provider_name,
					        u.provider_base_url,
				        u.context_window_tokens, u.prompt_tokens, u.completion_tokens, u.total_tokens,
				        u.cached_tokens, u.reasoning_tokens, u.cost
				 FROM provider_usage u
				 JOIN inference_submissions s
				   ON s.event_seq = u.request_seq
				  AND s.run_id = u.run_id
				 WHERE s.purpose = 'loop'
				   AND u.prompt_tokens > 0
				   ${seqFilter}
				 ORDER BY u.request_seq ASC, u.id ASC
				 LIMIT 1`,
					...params,
				)
				.toArray()[0] ?? null
		);
	}

	private tokenUsageChangeMarkers(since: string, until: string): BotTokenUsageChangeMarker[] {
		const previous = this.state.storage.sql
			.exec<ProviderUsageRow>(
				`SELECT created_at, run_id, model, requested_model, response_model, provider_name, context_window_tokens,
				        prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens, cost
				 FROM provider_usage
				 WHERE created_at < ?
				 ORDER BY created_at DESC, id DESC
				 LIMIT 1`,
				since,
			)
			.toArray()[0];
		let previousModel = previous?.requested_model;
		let previousContextWindowTokens = previous?.context_window_tokens;
		const markers: BotTokenUsageChangeMarker[] = [];
		for (const row of this.providerUsageRows(since, until)) {
			if (row.requested_model !== previousModel || row.context_window_tokens !== previousContextWindowTokens) {
				markers.push({
					usedAt: row.created_at,
					runId: row.run_id,
					model: row.requested_model,
					requestedModel: row.requested_model,
					...(row.response_model ? { responseModel: row.response_model } : {}),
					contextWindowTokens: row.context_window_tokens,
					...(previousModel ? { previousModel } : {}),
					...(previousContextWindowTokens !== undefined ? { previousContextWindowTokens } : {}),
					totalTokens: row.total_tokens,
					cachedTokens: row.cached_tokens,
					cost: row.cost,
				});
			}
			previousModel = row.requested_model;
			previousContextWindowTokens = row.context_window_tokens;
		}
		return markers;
	}

	private broadcastProviderDelta(runId: string, streamSeq: number, payload: Record<string, unknown>): void {
		const latestSeq = this.latestEventSeq();
		this.ephemeralStreamSeq = (this.ephemeralStreamSeq % 100_000) + 1;
		const event: BotRuntimeEvent = {
			seq: latestSeq + this.ephemeralStreamSeq / 1_000_000,
			runId,
			type: 'provider_delta',
			payload: {
				...payload,
				streamSeq,
				ephemeral: true,
			},
			tokenEstimate: 0,
			createdAt: new Date().toISOString(),
		};
		this.broadcastControl({ type: 'stream_delta', event });
	}

	private latestEventSeq(): number {
		return this.state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM events ORDER BY seq DESC LIMIT 1`).toArray()[0]?.seq ?? 0;
	}

	private markProviderStreamActive(runId: string): void {
		this.activeStreamActivity.set(runId, new Date().toISOString());
	}

	private clearProviderStreamActive(runId: string): void {
		this.activeStreamActivity.delete(runId);
	}

	private async fetchProviderResponse(
		settings: ProviderSettings,
		endpoint: string,
		body: string,
		signal: AbortSignal,
	): Promise<ProviderStreamFetchResponse> {
		const headers = providerJsonRequestHeaders(settings);
		const response = await providerFetchWithHeaderTimeout(
			endpoint,
			{
				method: 'POST',
				headers,
				body,
			},
			signal,
			providerRequestTimeoutMs,
		);

		if (response.ok) {
			if (!response.body) {
				throw new ProviderRequestError(502, settings.model, endpoint, 'Inference provider did not return a streaming response body.');
			}
			const responseId = openRouterGenerationIdFromHeaders(response.headers);
			return {
				stream: response.body,
				...(responseId ? { responseId } : {}),
			};
		}

		const bodyText = await readProviderErrorBody(response, signal);
		throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
	}

	private async fetchProviderCompactionResponse(
		settings: ProviderSettings,
		endpoint: string,
		body: string,
		signal: AbortSignal,
		limits: ProviderCompactionValidationLimits = defaultProviderCompactionSummaryLimits,
		mode: ProviderCompactionMode = 'structured_output',
	): Promise<
		Pick<ProviderResponse, 'usage' | 'responseId' | 'responseModel' | 'responseProviderName' | 'rawResponse'> & { content: string }
	> {
		const headers = providerJsonRequestHeaders(settings);
		const response = await providerFetchWithHeaderTimeout(
			endpoint,
			{
				method: 'POST',
				headers,
				body,
			},
			signal,
			providerRequestTimeoutMs,
		);

		if (!response.ok) {
			const bodyText = await readProviderErrorBody(response, signal);
			throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
		}

		const headerResponseId = openRouterGenerationIdFromHeaders(response.headers);
		const rawResponse = await readJsonResponseText(
			response,
			providerResponseBodyMaxBytes,
			signal,
			providerBodyReadTimeoutMs,
			() => new ProviderResponseBodyTimeoutError(providerBodyReadTimeoutMs),
		);
		let payload: ProviderCompactionResponsePayload;
		try {
			payload = JSON.parse(rawResponse) as ProviderCompactionResponsePayload;
		} catch {
			throw new ProviderRequestError(502, settings.model, endpoint, 'Provider compaction response was not valid JSON.', { rawResponse });
		}
		const choice = payload.choices?.[0];
		const finishReason = stringValue(choice?.finish_reason) ?? '';
		const nativeFinishReason = stringValue(choice?.native_finish_reason) ?? '';
		const usage = providerUsageFromValue(payload.usage);
		const responseId = headerResponseId ?? stringValue(payload.id);
		const responseModel = stringValue(payload.model);
		const responseProviderName = openRouterMetadataProviderName(payload.openrouter_metadata);
		if (providerCompactionOutputLimitReached(finishReason, nativeFinishReason)) {
			throw new ProviderCompactionOutputLimitError(rawResponse, finishReason, nativeFinishReason, {
				...(responseId ? { responseId } : {}),
				...(responseModel ? { responseModel } : {}),
				...(usage ? { usage } : {}),
			});
		}
		let content: string;
		try {
			content = providerCompactionSummaryFromResponseMessage(choice?.message, rawResponse, limits, mode);
		} catch (error) {
			if (error instanceof ProviderStructuredOutputValidationError) {
				error.responseId = responseId;
				error.responseModel = responseModel;
				error.usage = usage;
			}
			throw error;
		}
		return {
			content,
			rawResponse,
			...(usage ? { usage } : {}),
			...(responseId ? { responseId } : {}),
			...(responseModel ? { responseModel } : {}),
			...(responseProviderName ? { responseProviderName } : {}),
		};
	}

	private async fetchPromptTokenProbeUsage(
		settings: ProviderSettings,
		messages: ChatMessage[],
		tools: ProviderToolDefinition[],
		signal: AbortSignal = new AbortController().signal,
	): Promise<ProviderUsage> {
		const endpoint = providerChatCompletionsUrl(settings.baseUrl);
		const headers: Record<string, string> = {
			'content-type': 'application/json',
		};
		if (settings.apiKey) {
			headers.authorization = `Bearer ${settings.apiKey}`;
		}
		const response = await providerFetchWithHeaderTimeout(
			endpoint,
			{
				method: 'POST',
				headers,
				body: stringifyProviderRequest(providerTokenProbeRequest(settings, messages, tools)),
			},
			signal,
			providerRequestTimeoutMs,
		);
		if (!response.ok) {
			const bodyText = await readProviderErrorBody(response, signal);
			throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
		}
		const payload = runtimeRecord(
			await readJsonResponse(
				response,
				providerResponseBodyMaxBytes,
				signal,
				providerBodyReadTimeoutMs,
				() => new ProviderResponseBodyTimeoutError(providerBodyReadTimeoutMs),
			),
		);
		const usage = providerUsageFromValue(payload.usage);
		if (!usage) {
			throw new ProviderRequestError(502, settings.model, endpoint, 'Inference provider did not return token usage.');
		}
		return usage;
	}

	private effectiveProviderSettings(bot: BotDocument, owner: UserDocument): ProviderSettings {
		return effectiveProviderSettingsForBot(bot, owner, this.env);
	}

	private async runLocalSimulation(
		bot: BotDocument,
		runId: string,
		input: { notifications: Array<{ message?: unknown }>; ping: boolean },
		runContext: RunContext,
	): Promise<ProviderLoopOutcome> {
		this.throwIfStopped(runId, runContext.signal);
		const hot = await listHotThreads(this.env.BICKR_D1, bot.homeWorldId, 10);
		const replyTarget = hot.find((thread) => thread.authorBotId !== bot.id);
		if (replyTarget && !input.notifications.some((notification) => stringValue(notification.message)?.includes('first time'))) {
			this.throwIfStopped(runId, runContext.signal);
			this.appendLoopMessage(
				runId,
				{
					role: 'assistant',
					content: `I decide to reply to "${replyTarget.title}".`,
				},
				'local_simulation',
			);
			await this.appendEvent(runId, 'assistant_message', {
				content: `I decide to reply to "${replyTarget.title}".`,
			});
			const result = await this.executeTool(
				bot,
				runId,
				'reply_to_comment',
				{
					commentId: replyTarget.rootCommentId,
					body: `${bot.displayName} weighs in: ${bot.shortBio}`,
				},
				runContext,
			);
			return {
				logOffCalled: false,
				spotlightMutationCount: result.spotlightMutation ? 1 : 0,
				toolCallCount: 1,
			};
		}

		const forums = await listForums(this.env.BICKR_D1, bot.homeWorldHandle);
		const forum = forums.find((item) => !item.personalBotId) ?? forums.find((item) => item.personalBotId === bot.id) ?? forums[0];
		if (!forum) {
			this.appendLoopMessage(
				runId,
				{
					role: 'assistant',
					content: 'I look for somewhere to create a thread, but I do not find an available forum.',
				},
				'local_simulation',
			);
			await this.appendEvent(runId, 'assistant_message', {
				content: 'I look for somewhere to create a thread, but I do not find an available forum.',
			});
			return { logOffCalled: false, spotlightMutationCount: 0, toolCallCount: 0 };
		}
		this.throwIfStopped(runId, runContext.signal);
		this.appendLoopMessage(
			runId,
			{
				role: 'assistant',
				content: `I decide to create a thread in f/${forum.handle}.`,
			},
			'local_simulation',
		);
		await this.appendEvent(runId, 'assistant_message', {
			content: `I decide to create a thread in f/${forum.handle}.`,
		});
		const result = await this.executeTool(
			bot,
			runId,
			'create_thread',
			{
				forumHandle: forum.handle,
				title: { lang: bot.language ?? ('en' as LanguageTag), text: `${localizedTextString(bot.displayName)} has logged in` },
				body: {
					lang: bot.language ?? ('en' as LanguageTag),
					text: `${localizedTextString(bot.shortBio)}\n\n${localizedTextString(bot.prompt).slice(0, 300)}`,
				},
			},
			runContext,
		);
		return {
			logOffCalled: false,
			spotlightMutationCount: result.spotlightMutation ? 1 : 0,
			toolCallCount: 1,
		};
	}

	private async executeTool(
		bot: BotDocument,
		runId: string,
		name: string,
		args: Record<string, unknown>,
		runContext: RunContext,
	): Promise<ToolResult> {
		this.throwIfStopped(runId, runContext.signal);
		const canonicalName = canonicalToolName(name);
		const normalizedArgs = normalizeToolArgs(canonicalName, args, bot.language);
		const spotlightScope = runContext.spotlightId ? runContext.spotlightActionScope : undefined;
		let spotlightMutation = false;
		let spotlightTickTerminator = false;
		let spotlightNotificationArgs: Record<string, unknown> | undefined;
		let spotlightNotificationResult: unknown;
		if (
			(canonicalName === 'reply_to_comment' || canonicalName === 'make_additional_reply_to_the_same_comment') &&
			!stringValue(normalizedArgs.commentId)
		) {
			normalizedArgs.commentId = await this.replyTargetCommentId(normalizedArgs);
			delete normalizedArgs.parentCommentId;
			delete normalizedArgs.threadId;
		}
		const toolCallEvent = await this.appendEvent(runId, 'tool_call', {
			name: canonicalName,
			args: providerToolArgs(canonicalName, normalizedArgs),
		});
		let result: unknown;
		let effectiveArgs: Record<string, unknown> | undefined;
		let selfCorrectionMessages: string[] | undefined;
		switch (canonicalName) {
			case 'check_notifications':
				result = { events: [] };
				break;
			case 'list_accessible_forums':
				result = (await listForums(this.env.BICKR_D1, bot.homeWorldHandle)).filter((forum) => !forum.personalBotId);
				break;
			case 'list_recent_threads': {
				const forum = await this.forumFromArgs(bot, normalizedArgs);
				result = await this.annotateThreadSummariesFollowStatus(
					bot.id,
					await listThreads(this.env.BICKR_D1, forum.id, 'recent', numberArg(normalizedArgs.limit, 20)),
				);
				break;
			}
			case 'list_hot_threads':
				result = await this.annotateThreadSummariesFollowStatus(
					bot.id,
					await listHotThreads(this.env.BICKR_D1, bot.homeWorldId, numberArg(normalizedArgs.limit, 20)),
				);
				break;
			case 'read_thread':
			case 'read_thread_by_id':
				result = await this.threadReadResult(
					bot,
					await readThread(this.env.BICKR_KV, stringArg(normalizedArgs.threadId, 'threadId')),
					canonicalName,
				);
				break;
			case 'read_comment_by_id':
				result = await this.readCommentById(bot, stringArg(normalizedArgs.commentId, 'commentId'), canonicalName);
				break;
			case 'create_thread': {
				const forum = await this.forumFromArgs(bot, normalizedArgs);
				const mutation = spotlightMutationScopeForCreateThread(spotlightScope, forum.personalBotId);
				const title = localizedToolTextArg(normalizedArgs.title, 'title', bot.language);
				const body = localizedToolTextArg(normalizedArgs.body, 'body', bot.language);
				normalizedArgs.title = title;
				normalizedArgs.body = body;
				result = await this.forumService(
					`/forums/${encodeURIComponent(forum.id)}/threads`,
					bot.id,
					{
						title,
						body,
						...(typeof normalizedArgs.url === 'string' ? { url: normalizedArgs.url } : {}),
					},
					runContext.signal,
				);
				spotlightMutation = mutation.related;
				spotlightTickTerminator = mutation.unrelated;
				if (mutation.related) {
					spotlightNotificationArgs = normalizedArgs;
					spotlightNotificationResult = result;
				}
				break;
			}
			case 'reply_to_comment':
			case 'make_additional_reply_to_the_same_comment': {
				const body = localizedToolTextArg(normalizedArgs.body, 'body', bot.language);
				normalizedArgs.body = body;
				const parentCommentId = await this.replyTargetCommentId(normalizedArgs);
				const mutation = spotlightMutationScopeForComment(spotlightScope, parentCommentId);
				const threadId = await this.threadIdForComment(parentCommentId);
				if (canonicalName === 'reply_to_comment') {
					await this.assertNoPriorReplyToTarget(bot.id, threadId, parentCommentId);
				}
				this.assertNoRecentDuplicateReply(bot.id, body.text);
				const serviceResult = await this.forumService(
					`/comments/${encodeURIComponent(parentCommentId)}/replies`,
					bot.id,
					{
						body,
					},
					runContext.signal,
				);
				const serviceRecord = runtimeRecord(serviceResult);
				const createdComment = replyCommentFromThread(runtimeRecord(serviceRecord.thread), { body: body.text, parentCommentId });
				result = {
					...serviceRecord,
					...(createdComment ? { comment: createdComment } : {}),
				};
				spotlightMutation = mutation.related;
				spotlightTickTerminator = mutation.unrelated;
				if (mutation.related) {
					spotlightNotificationArgs = normalizedArgs;
					spotlightNotificationResult = result;
				}
				break;
			}
			case 'vote': {
				const reason = localizedToolTextArg(normalizedArgs.reason, 'reason', bot.language);
				normalizedArgs.reason = reason;
				const votes = voteTargetsArg(normalizedArgs.votes);
				const mutation = spotlightMutationScopeForVotes(spotlightScope, votes);
				result = await this.voteTool(bot, runId, votes, reason, runContext.signal, runContext.spotlightId, spotlightScope);
				spotlightMutation = mutation.related;
				spotlightTickTerminator = mutation.unrelated;
				break;
			}
			case 'follow_profile': {
				const followResult = await this.followProfilesTool(
					bot,
					runId,
					followToolTargetsArg(normalizedArgs.targets, bot.language),
					true,
					runContext.signal,
					runContext.spotlightId,
					spotlightScope,
				);
				normalizedArgs.targets = followResult.effectiveTargets;
				result = followResult.results;
				spotlightMutation = followResult.spotlightMutation.related;
				spotlightTickTerminator = followResult.spotlightMutation.unrelated;
				if (followResult.selfCorrectionMessages.length > 0) {
					effectiveArgs = { ...normalizedArgs };
					selfCorrectionMessages = followResult.selfCorrectionMessages;
				}
				break;
			}
			case 'unfollow_profile': {
				const followResult = await this.followProfilesTool(
					bot,
					runId,
					followToolTargetsArg(normalizedArgs.targets, bot.language),
					false,
					runContext.signal,
					runContext.spotlightId,
					spotlightScope,
				);
				normalizedArgs.targets = followResult.effectiveTargets;
				result = followResult.results;
				spotlightMutation = followResult.spotlightMutation.related;
				spotlightTickTerminator = followResult.spotlightMutation.unrelated;
				if (followResult.selfCorrectionMessages.length > 0) {
					effectiveArgs = { ...normalizedArgs };
					selfCorrectionMessages = followResult.selfCorrectionMessages;
				}
				break;
			}
			case 'search_threads':
			case 'search_threads_semantic':
				result = await this.annotateSearchThreadsFollowStatus(
					bot.id,
					await searchThreads(this.env.BICKR_D1, bot.homeWorldId, stringArg(normalizedArgs.query, 'query')),
				);
				break;
			case 'search_profiles':
				result = await this.searchBotsTool(bot, stringArg(normalizedArgs.query, 'query'), numberArg(normalizedArgs.limit, 10));
				break;
			case 'list_profiles': {
				const query = listProfilesToolArgs(normalizedArgs);
				if (query.mode === 'window') {
					normalizedArgs.mode = query.mode;
					normalizedArgs.limit = query.limit;
					normalizedArgs.offset = query.offset;
				} else {
					normalizedArgs.mode = query.mode;
					normalizedArgs.limit = query.limit;
					delete normalizedArgs.offset;
				}
				const profileList = await this.listProfilesTool(bot, query);
				await markBotSeenContent(
					this.env.BICKR_D1,
					bot.id,
					profileList.profiles.map((profile) => ({ type: 'bot', id: profile.id })),
					'tool:list_profiles',
					runId,
				);
				result = profileList;
				break;
			}
			case 'query_followers': {
				const query = queryFollowersToolArgs(normalizedArgs);
				if (query.direction === 'followers') {
					normalizedArgs.isFollowing = query.username;
					delete normalizedArgs.isFollowedBy;
				} else {
					normalizedArgs.isFollowedBy = query.username;
					delete normalizedArgs.isFollowing;
				}
				if (query.usernameGlob) {
					normalizedArgs.usernameGlob = query.usernameGlob;
				} else {
					delete normalizedArgs.usernameGlob;
				}
				result = await queryBotFollowUsernamesByHandle(
					this.env.BICKR_KV,
					this.env.BICKR_D1,
					bot.homeWorldId,
					query.username,
					query.direction,
					query.usernameGlob,
					50,
				);
				break;
			}
			case 'view_profiles': {
				const profiles = await this.viewProfilesTool(bot, usernamesArg(normalizedArgs.usernames));
				await markBotSeenContent(
					this.env.BICKR_D1,
					bot.id,
					profiles.map((profile) => ({ type: 'bot', id: profile.id })),
					'tool:view_profiles',
					runId,
				);
				result = { profiles };
				break;
			}
			case 'view_activity': {
				const activityLimit = numberArg(normalizedArgs.limit, 10, 20);
				const feed = await botActivityFeedByHandle(
					this.env.BICKR_KV,
					this.env.BICKR_D1,
					bot.homeWorldId,
					usernameArg(normalizedArgs.username),
					activityLimit,
				);
				await markBotSeenContent(this.env.BICKR_D1, bot.id, [{ type: 'bot', id: feed.bot.id }], 'tool:view_activity', runId);
				result = await this.annotateActivityFeedFollowStatus(bot.id, feed);
				break;
			}
			case 'log_off':
				normalizedArgs.reason = localizedToolTextArg(normalizedArgs.reason, 'reason', bot.language);
				result = { ok: true, status: 'finished', message: 'I have finished this Bickr visit.' };
				break;
			default:
				throw new Error(`Unknown tool: ${canonicalName}`);
		}
		this.throwIfStopped(runId, runContext.signal);
		if (effectiveArgs) {
			this.replaceEventPayload(toolCallEvent, { name: canonicalName, args: providerToolArgs(canonicalName, effectiveArgs) });
		}
		await markBotSeenFromResult(this.env.BICKR_D1, bot.id, result, `tool:${canonicalName}`, runId);
		if (runContext.spotlightId && spotlightMutation && needsPostHocSpotlightHumanNotification(canonicalName)) {
			try {
				await recordSpotlightToolHumanNotification(this.env.BICKR_D1, {
					bot,
					spotlightId: runContext.spotlightId,
					runId,
					toolName: canonicalName,
					args: providerToolArgs(canonicalName, spotlightNotificationArgs ?? normalizedArgs),
					result: spotlightNotificationResult ?? result,
				});
			} catch (error) {
				console.warn('spotlight notification failed', error);
			}
		}
		const providerResultTokenBudget = providerToolResultUsesTokenBudget(canonicalName)
			? await this.readCommentTreeTokenBudget(bot)
			: undefined;
		const providerResult = providerToolResultPayload(canonicalName, result, normalizedArgs, this.providerContentInActiveContext(), {
			tokenBudget: providerResultTokenBudget,
		});
		const toolResultEvent = await this.appendEvent(runId, 'tool_result', {
			name: canonicalName,
			args: providerToolArgs(canonicalName, normalizedArgs),
			result,
			displayContext: { worldHandle: bot.homeWorldHandle },
		});
		return {
			name: canonicalName,
			result,
			providerResult,
			displayEventSeq: toolResultEvent.seq,
			...(effectiveArgs ? { effectiveArgs } : {}),
			...(selfCorrectionMessages ? { selfCorrectionMessages } : {}),
			...(spotlightMutation ? { spotlightMutation } : {}),
			...(spotlightTickTerminator ? { spotlightTickTerminator } : {}),
		};
	}

	private async voteTool(
		bot: BotDocument,
		runId: string,
		votes: VoteToolTarget[],
		reason: RequiredLocalizedText,
		signal: AbortSignal,
		spotlightId?: string,
		spotlightScope?: SpotlightActionScope,
	): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const vote of votes) {
			this.throwIfStopped(runId, signal);
			const targetSpotlightId = spotlightId && spotlightActionScopeIncludesComment(spotlightScope, vote.commentId) ? spotlightId : undefined;
			const serviceResult = await this.forumService(
				'/votes',
				bot.id,
				{
					targetType: 'comment',
					targetId: vote.commentId,
					value: vote.value,
					reason,
					...(targetSpotlightId ? { spotlightId: targetSpotlightId } : {}),
				},
				signal,
			);
			results.push({ ...vote, ...runtimeRecord(serviceResult) });
		}
		return results;
	}

	private async followProfilesTool(
		bot: BotDocument,
		runId: string,
		targets: FollowToolTarget[],
		shouldFollow: boolean,
		signal: AbortSignal,
		spotlightId?: string,
		spotlightScope?: SpotlightActionScope,
	): Promise<FollowProfilesToolResult> {
		const targetsByUsername = new Map(targets.map((target) => [target.username, target]));
		const usernames = targets.map((target) => target.username);
		const profiles = await botPublicProfilesByHandles(this.env.BICKR_KV, this.env.BICKR_D1, bot.homeWorldId, usernames);
		const foundHandles = new Set(profiles.map((profile) => profile.handle));
		const missingSkips = usernames
			.filter((username) => !foundHandles.has(username))
			.map((username): FollowToolTargetSkip => ({ username: `u/${username}`, reason: 'profile_not_found' }));
		const followed = await followedBotIdSet(
			this.env.BICKR_D1,
			bot.id,
			profiles.map((profile) => profile.id),
		);
		const targetPlan = planFollowToolTargets(bot.id, profiles, followed, shouldFollow);
		const toolName = shouldFollow ? 'follow_profile' : 'unfollow_profile';
		const skipsByUsername = new Map([...targetPlan.skipped, ...missingSkips].map((skip) => [skip.username, skip]));
		const skipped = usernames.flatMap((username) => {
			const skip = skipsByUsername.get(`u/${username}`);
			return skip ? [skip] : [];
		});
		const selfCorrectionMessages = skipped.length > 0 ? [followToolSelfCorrectionMessage(toolName, skipped)] : [];
		if (targetPlan.validProfiles.length === 0) {
			throw new SelfCorrectingToolCallError(selfCorrectionMessages[0] ?? followToolSelfCorrectionMessage(toolName, []));
		}

		const results: unknown[] = [];
		let relatedMutationCount = 0;
		let unrelatedMutationCount = 0;
		for (const profile of targetPlan.validProfiles) {
			const target = targetsByUsername.get(profile.handle);
			if (!target) {
				continue;
			}
			this.throwIfStopped(runId, signal);
			const targetSpotlightId = spotlightId && spotlightActionScopeIncludesAuthor(spotlightScope, profile) ? spotlightId : undefined;
			if (targetSpotlightId) {
				relatedMutationCount += 1;
			} else if (spotlightScope) {
				unrelatedMutationCount += 1;
			}
			const follow = shouldFollow
				? await followBot(this.env.BICKR_KV, this.env.BICKR_D1, bot.id, profile.id, undefined, {
						reason: target.reason,
						...(targetSpotlightId ? { spotlightId: targetSpotlightId } : {}),
					})
				: await unfollowBot(this.env.BICKR_KV, this.env.BICKR_D1, bot.id, profile.id, undefined, {
						reason: target.reason,
						...(targetSpotlightId ? { spotlightId: targetSpotlightId } : {}),
					});
			results.push({ username: profile.handle, reason: target.reason, ...follow, profile: { ...profile, following: follow.following } });
		}
		return {
			results,
			effectiveTargets: targetPlan.validProfiles.flatMap((profile) => {
				const target = targetsByUsername.get(profile.handle);
				return target ? [target] : [];
			}),
			selfCorrectionMessages,
			spotlightMutation: {
				related: relatedMutationCount > 0,
				unrelated: unrelatedMutationCount > 0,
			},
		};
	}

	private async profilesFromUsernames(bot: BotDocument, usernames: string[]): Promise<BotPublicProfile[]> {
		const profiles = await botPublicProfilesByHandles(this.env.BICKR_KV, this.env.BICKR_D1, bot.homeWorldId, usernames);
		const foundHandles = new Set(profiles.map((profile) => profile.handle));
		const missing = usernames.find((username) => !foundHandles.has(username));
		if (missing) {
			throw new RepositoryError('not_found', `Profile u/${missing} not found.`, 404);
		}
		return profiles;
	}

	private async viewProfilesTool(bot: BotDocument, usernames: string[]): Promise<BotProfileRelationshipSummary[]> {
		const profiles = await this.profilesFromUsernames(bot, usernames);
		return this.annotateProfilesFollowRelationships(bot.id, profiles);
	}

	private async assertNoPriorReplyToTarget(botId: string, threadId: string, parentCommentId: string | undefined): Promise<void> {
		const thread = await readThread(this.env.BICKR_KV, threadId);
		const replies = thread.comments
			.filter(
				(comment) =>
					comment.authorBotId === botId && (parentCommentId ? comment.parentCommentId === parentCommentId : !comment.parentCommentId),
			)
			.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
			.map((comment) => ({
				commentId: comment.id,
				body: localizedTextString(comment.body),
				urlPath: commentUrlPathFromParts(thread.worldHandle, thread.forumHandle, thread.id, comment.id),
				createdAt: comment.createdAt,
			}));
		if (replies.length === 0) {
			return;
		}
		throw new PriorTargetReplyError({
			threadId: thread.id,
			...(parentCommentId ? { targetCommentId: parentCommentId } : {}),
			targetDescription: parentCommentId ? `comment ${parentCommentId}` : `thread ${thread.id}`,
			replies,
		});
	}

	private async threadIdForComment(commentId: string): Promise<string> {
		const row = await this.env.BICKR_D1.prepare(
			`SELECT thread_id AS threadId
			 FROM comments_index
			 WHERE comment_id = ? AND deleted_at IS NULL
			 LIMIT 1`,
		)
			.bind(commentId)
			.first<{ threadId: string }>();
		if (!row) {
			throw new RepositoryError('not_found', 'Comment not found.', 404);
		}
		return row.threadId;
	}

	private async replyTargetCommentId(args: Record<string, unknown>): Promise<string> {
		const explicit = stringValue(args.commentId ?? args.parentCommentId);
		if (explicit) {
			return explicit;
		}
		const threadId = stringValue(args.threadId);
		if (!threadId) {
			throw new Error('commentId is required.');
		}
		return rootCommentForThread(await readThread(this.env.BICKR_KV, threadId)).id;
	}

	private async searchBotsTool(bot: BotDocument, query: string, limit: number): Promise<ProfileRelationshipSearchResult[]> {
		const vectorResults = await vectorSearchBots(this.env, bot.homeWorldId, query, limit);
		const textResults = await searchBots(this.env.BICKR_KV, this.env.BICKR_D1, bot.homeWorldId, query, limit);
		const byId = new Map<string, BotSearchResult>();
		for (const result of vectorResults) {
			byId.set(result.id, result);
		}
		for (const result of textResults) {
			if (!byId.has(result.id)) {
				byId.set(result.id, result);
			}
		}
		return this.annotateProfilesFollowRelationships(bot.id, [...byId.values()].slice(0, limit));
	}

	private async listProfilesTool(bot: BotDocument, args: ListProfilesToolArgs): Promise<BotProfileListResult> {
		return listWorldPublicProfiles(this.env.BICKR_D1, bot.homeWorldId, bot.id, args);
	}

	private async annotateProfilesFollowRelationships<T extends BotPublicProfile>(
		botId: string,
		profiles: T[],
	): Promise<Array<T & ProfileRelationshipFields>> {
		return botProfileRelationshipSummaries(this.env.BICKR_D1, botId, profiles);
	}

	private async annotateActivityFeedFollowStatus(botId: string, feed: BotActivityFeed): Promise<BotActivityFeed> {
		const profileIds = [feed.bot.id, ...feed.activities.filter((item) => item.type === 'follow').map((item) => item.bot.id)];
		const followed = await followedBotIdSet(this.env.BICKR_D1, botId, profileIds);
		return {
			...feed,
			bot: withProfileFollowStatus(feed.bot, botId, followed),
			activities: feed.activities.map((item) =>
				item.type === 'follow'
					? {
							...item,
							bot: withProfileFollowStatus(item.bot, botId, followed),
						}
					: item,
			),
		};
	}

	private async annotateThreadSummariesFollowStatus(
		botId: string,
		threads: ThreadSummary[],
	): Promise<Array<ThreadSummary & { authorFollowing?: boolean }>> {
		const followed = await followedBotIdSet(
			this.env.BICKR_D1,
			botId,
			threads.map((thread) => thread.authorBotId),
		);
		return threads.map((thread) => withAuthorFollowStatus(thread, botId, followed));
	}

	private async annotateThreadReadSummariesFollowStatus<T extends { authorBotId: string }>(
		botId: string,
		threads: T[],
	): Promise<Array<T & { authorFollowing?: boolean }>> {
		const followed = await followedBotIdSet(
			this.env.BICKR_D1,
			botId,
			threads.map((thread) => thread.authorBotId),
		);
		return threads.map((thread) => withAuthorFollowStatus(thread, botId, followed));
	}

	private async annotateSearchThreadsFollowStatus<T extends SearchThreadResult>(
		botId: string,
		threads: T[],
	): Promise<Array<T & { authorFollowing?: boolean }>> {
		const followed = await followedBotIdSet(
			this.env.BICKR_D1,
			botId,
			threads.map((thread) => thread.authorBotId),
		);
		return threads.map((thread) => withAuthorFollowStatus(thread, botId, followed));
	}

	private async annotateReadContentFollowStatus(botId: string, content: ReadContentItem[]): Promise<ReadContentItem[]> {
		const followed = await followedBotIdSet(
			this.env.BICKR_D1,
			botId,
			content.map((item) => item.authorBotId),
		);
		return content.map((item) => withAuthorFollowStatus(item, botId, followed));
	}

	private assertNoRecentDuplicateReply(botId: string, body: string): void {
		const rows = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM (
					SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
					FROM events
					WHERE type IN ('input', 'assistant_message', 'tool_call', 'tool_result', 'thought_injected')
					ORDER BY seq DESC
					LIMIT 100
				 )
				 WHERE type = 'tool_result'
				 ORDER BY seq DESC`,
			)
			.toArray();
		for (const row of rows) {
			const duplicate = duplicateReplyFromToolResult(row, botId, body);
			if (duplicate) {
				throw new DuplicateReplyError(duplicate);
			}
		}
	}

	private async threadReadResult(bot: BotDocument, thread: ThreadDocument, operation: string, targetCommentId?: string) {
		const content = threadReadContentItems(thread, targetCommentId);
		const annotatedContent = await this.annotateReadContentFollowStatus(bot.id, content);
		const commentTree = readContentItemTree(annotatedContent);
		const tokenBudget = await this.readCommentTreeTokenBudget(bot);
		const pruned = pruneReadContentTreeForProviderBudget(commentTree, tokenBudget);
		const threadSummary =
			(await this.annotateThreadReadSummariesFollowStatus(bot.id, [threadReadSummary(thread)]))[0] ?? threadReadSummary(thread);
		return {
			operation,
			context: readResultContext(operation, pruned, tokenBudget),
			thread: threadSummary,
			...(targetCommentId ? { targetCommentId } : {}),
			content: pruned.content,
		};
	}

	private async readCommentById(bot: BotDocument, commentId: string, operation: string) {
		const row = await this.env.BICKR_D1.prepare(
			`SELECT thread_id AS threadId
			 FROM comments_index
			 WHERE comment_id = ?
			   AND world_id = ?
			   AND deleted_at IS NULL`,
		)
			.bind(commentId, bot.homeWorldId)
			.first<{ threadId: string }>();
		if (!row) {
			throw new RepositoryError('not_found', 'Comment not found.', 404);
		}
		const thread = await readThread(this.env.BICKR_KV, row.threadId);
		if (!thread.comments.some((comment) => comment.id === commentId)) {
			throw new RepositoryError('not_found', 'Comment not found.', 404);
		}
		return this.threadReadResult(bot, thread, operation, commentId);
	}

	private async forumFromArgs(bot: BotDocument, args: Record<string, unknown>) {
		if (typeof args.forumId === 'string') {
			const forums = await listForums(this.env.BICKR_D1, bot.homeWorldHandle);
			const forum = forums.find((item) => item.id === args.forumId);
			if (!forum) {
				throw new Error('Forum not found.');
			}
			return forum;
		}
		return forumByHandle(this.env.BICKR_KV, this.env.BICKR_D1, bot.homeWorldHandle, stringArg(args.forumHandle, 'forumHandle'));
	}

	private async forumService(path: string, botId: string, body: unknown, signal: AbortSignal): Promise<unknown> {
		return withAbortableTimeout(
			signal,
			serviceBindingTimeoutMs,
			() => new RuntimeOperationTimeoutError('The Bickr page request', serviceBindingTimeoutMs),
			async (timeoutSignal) => {
				const response = await this.env.FORUM_COORDINATOR_SERVICE.fetch(
					new Request(internalServiceUrl(path), {
						method: 'POST',
						signal: timeoutSignal,
						headers: {
							'content-type': 'application/json',
							'x-bickr-bot-id': botId,
						},
						body: JSON.stringify(body),
					}),
				);
				const payload = runtimeRecord(
					await readJsonResponse(
						response,
						serviceBindingResponseBodyMaxBytes,
						timeoutSignal,
						serviceBindingTimeoutMs,
						() => new RuntimeOperationTimeoutError('The Bickr page response', serviceBindingTimeoutMs),
					),
				);
				if (!response.ok || payload.ok !== true) {
					const apiError = apiErrorPayload(payload);
					if (apiError) {
						throw new RepositoryError(repositoryErrorCode(apiError.error), apiError.message, response.status || 500, apiError.details);
					}
					throw new Error(`Bickr page request failed with status ${response.status}.`);
				}
				return payload.data;
			},
		);
	}

	private async buildMessages(
		bot: BotDocument,
		input: LoopInput,
		runId: string,
		inputCreatedAt: string,
		options: { setupMode?: LoopSetupMode } = {},
	): Promise<RuntimeLoopMessages> {
		const setupMode = options.setupMode ?? 'new_iteration';
		const deliveredNotificationIds = new Set<string>();
		const elapsed =
			setupMode === 'new_iteration' ? formatElapsedTimeSincePreviousVisit(this.previousTerminalTickEvent(runId), inputCreatedAt) : '';
		if (elapsed) {
			this.appendLoopMessage(runId, { role: 'user', content: elapsed }, 'input');
		}
		const existingProfileUsernames = this.profileUsernamesInActiveContext();
		const existingProviderContent = this.providerContentInActiveContext();
		if (input.spotlightContexts.length > 0) {
			await this.appendSpotlightSyntheticContext(bot, runId, input.spotlightContexts, existingProfileUsernames, existingProviderContent);
		} else if (setupMode === 'new_iteration') {
			for (const id of await this.appendNotificationSyntheticContext(
				bot,
				runId,
				input.notifications,
				existingProfileUsernames,
				existingProviderContent,
			)) {
				deliveredNotificationIds.add(id);
			}
		}
		if (setupMode !== 'spotlight') {
			for (const injection of input.injections) {
				this.appendLoopMessage(runId, { role: 'assistant', content: injectedThoughtAssistantContent(injection, {}) }, 'injection');
			}
			if (input.toolUseReminder) {
				this.appendLoopMessage(runId, { role: 'assistant', content: input.toolUseReminder }, 'reminder');
			}
		}
		const recurringPrompt = effectiveReasoningPrefill(bot);
		if (setupMode === 'new_iteration' && recurringPrompt) {
			this.appendLoopMessage(runId, { role: 'assistant', content: recurringPrompt }, 'synthetic_context');
		}
		const messages = this.activeLoopMessagesForProvider() as RuntimeLoopMessages;
		Object.defineProperty(messages, 'deliveredNotificationIds', {
			value: deliveredNotificationIds,
			enumerable: false,
			configurable: true,
		});
		return messages;
	}

	private async appendNotificationSyntheticContext(
		bot: BotDocument,
		runId: string,
		notifications: LoopNotification[],
		existingProfileUsernames: ReadonlySet<string>,
		existingProviderContent: ProviderContextContentScope,
	): Promise<string[]> {
		const toolCalls: ToolCall[] = [syntheticToolCall(runId, 'check_notifications', 0, {})];
		const providerContentScope = cloneProviderContextContentScope(existingProviderContent);
		const notificationTokenBudget = notifications.length > 0 ? await this.readCommentTreeTokenBudget(bot) : undefined;
		const notificationResult = providerCheckNotificationsResultWithInclusions(notifications, providerContentScope, notificationTokenBudget);
		const includedNotificationIds = new Set(notificationResult.includedEventIds);
		const includedNotifications = notifications.filter((notification) => includedNotificationIds.has(notification.id));
		const results: ChatMessage[] = [
			{
				role: 'tool',
				tool_call_id: toolCalls[0]?.id ?? syntheticToolCallId(runId, 0),
				content: JSON.stringify(notificationResult.payload),
			},
		];
		const usernames = referencedProfileUsernamesFromNotifications(includedNotifications, bot.handle, existingProfileUsernames);
		if (usernames.length > 0) {
			const index = toolCalls.length;
			const profiles = await this.syntheticProfilesForUsernames(bot, usernames, runId, 'notification');
			const toolCall = syntheticToolCall(runId, 'view_profiles', index, { usernames });
			toolCalls.push(toolCall);
			results.push({
				role: 'tool',
				tool_call_id: toolCall.id,
				content: JSON.stringify(
					providerToolResultPayload('view_profiles', { profiles }, {}, emptyProviderContextContentScope(), {
						tokenBudget: notificationTokenBudget,
					}),
				),
			});
		}
		this.appendToolCallChainLoopMessages(
			runId,
			'synthetic_context',
			"I'm logging into Bickr and checking my notifications.",
			toolCalls,
			results,
		);
		return notificationResult.includedEventIds;
	}

	private async appendSpotlightSyntheticContext(
		bot: BotDocument,
		runId: string,
		contexts: SpotlightSyntheticContext[],
		existingProfileUsernames: ReadonlySet<string>,
		existingProviderContent: ProviderContextContentScope,
	): Promise<void> {
		const chains = contexts.flatMap(spotlightSyntheticToolChains);
		const toolCalls: ToolCall[] = chains.map((chain, index) => syntheticToolCall(runId, chain.toolName, index, chain.args));
		const providerContentScope = cloneProviderContextContentScope(existingProviderContent);
		const tokenBudget = await this.readCommentTreeTokenBudget(bot);
		const results: ChatMessage[] = chains.map((chain, index) => ({
			role: 'tool',
			tool_call_id: toolCalls[index]?.id ?? syntheticToolCallId(runId, index),
			content: JSON.stringify(
				spotlightReadResult(chain.context, chain.toolName, providerContentScope, tokenBudget, chain.targetCommentId, chain.targetThreadId),
			),
		}));
		const usernames = referencedProfileUsernamesFromSpotlight(contexts, bot.handle, existingProfileUsernames);
		if (usernames.length > 0) {
			const index = toolCalls.length;
			const profiles = await this.syntheticProfilesForUsernames(bot, usernames, runId, 'spotlight');
			const toolCall = syntheticToolCall(runId, 'view_profiles', index, { usernames });
			toolCalls.push(toolCall);
			results.push({
				role: 'tool',
				tool_call_id: toolCall.id,
				content: JSON.stringify(providerToolResultPayload('view_profiles', { profiles })),
			});
		}
		if (toolCalls.length === 0) {
			return;
		}
		this.appendToolCallChainLoopMessages(
			runId,
			'synthetic_context',
			'While browsing Bickr, I stumbled on an interesting thread.',
			toolCalls,
			results,
		);
		const focusContent = spotlightFocusAssistantContent(contexts);
		if (focusContent) {
			this.appendLoopMessage(runId, { role: 'assistant', content: focusContent }, 'synthetic_context');
		}
	}

	private appendToolCallChainLoopMessages(
		runId: string,
		origin: BotLoopMessageOrigin,
		firstAssistantContent: string,
		toolCalls: readonly ToolCall[],
		results: readonly ChatMessage[],
		status: BotLoopMessageStatus = 'complete',
	): void {
		if (toolCalls.length !== results.length) {
			throw new Error('Synthetic tool-call chain must have one result per request.');
		}
		for (let index = 0; index < toolCalls.length; index += 1) {
			const toolCall = toolCalls[index]!;
			this.appendLoopMessage(
				runId,
				{
					role: 'assistant',
					content: index === 0 ? firstAssistantContent : null,
					tool_calls: [toolCall],
				},
				origin,
				status,
			);
			const result = results[index];
			if (result) {
				this.appendLoopMessage(runId, result, origin, status);
			}
		}
	}

	private async syntheticProfilesForUsernames(
		bot: BotDocument,
		usernames: string[],
		runId: string,
		seenVia: string,
	): Promise<BotProfileRelationshipSummary[]> {
		const handles = usernames.map(usernameArg);
		const profiles = await botPublicProfilesByHandles(this.env.BICKR_KV, this.env.BICKR_D1, bot.homeWorldId, handles);
		if (profiles.length > 0) {
			await markBotSeenContent(
				this.env.BICKR_D1,
				bot.id,
				profiles.map((profile) => ({ type: 'bot', id: profile.id })),
				`synthetic:view_profiles:${seenVia}`,
				runId,
			);
		}
		return this.annotateProfilesFollowRelationships(bot.id, profiles);
	}

	private profileUsernamesInActiveContext(): Set<string> {
		const usernames = new Set<string>();
		for (const row of this.activeLoopMessageRows()) {
			if (row.role !== 'tool') {
				continue;
			}
			for (const username of profileUsernamesFromToolResultContent(loopMessageChatMessageFromRow(row).content)) {
				usernames.add(username);
			}
		}
		return usernames;
	}

	private providerContentInActiveContext(): ProviderContextContentScope {
		const scope = emptyProviderContextContentScope();
		for (const row of this.activeLoopMessageRows()) {
			const message = loopMessageChatMessageFromRow(row);
			if (loopMessageContributesToProviderHistory(row.origin, message)) {
				collectProviderContextContentFromValue(message.content, scope);
			}
		}
		return scope;
	}

	private previousTerminalTickEvent(runId: string): RuntimeRow | null {
		return (
			this.state.storage.sql
				.exec<RuntimeRow>(
					`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE run_id != ?
				   AND type IN ('tick_completed', 'tick_failed', 'tick_stopped')
				 ORDER BY seq DESC
				 LIMIT 1`,
					runId,
				)
				.toArray()[0] ?? null
		);
	}

	private currentIterationStartedSinceLastLogOff(): boolean {
		const lastLogOffSeq = this.latestSuccessfulLogOffToolResultSeq();
		const row = this.state.storage.sql
			.exec<{ found: number }>(
				`SELECT 1 AS found
				 FROM events
				 WHERE seq > ?
				   AND type = 'input'
				 LIMIT 1`,
				lastLogOffSeq,
			)
			.toArray()[0];
		return Boolean(row);
	}

	private providerLoopInitialSuccessfulToolCallCount(): number {
		if (!this.hasRuntimeStorage()) {
			return 0;
		}
		return this.successfulToolCallCountSinceLastLogOff();
	}

	private hasRuntimeStorage(): boolean {
		const runtime = this as unknown as { state?: { storage?: { sql?: unknown } } };
		return Boolean(runtime.state?.storage?.sql);
	}

	private successfulToolCallCountSinceLastLogOff(): number {
		if (!this.hasRuntimeStorage()) {
			return 0;
		}
		const lastLogOffSeq = this.latestSuccessfulLogOffToolResultSeq();
		const rows = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE seq > ?
				   AND type = 'tool_result'
				 ORDER BY seq ASC`,
				lastLogOffSeq,
			)
			.toArray();
		return rows.filter((row) => successfulToolResultPayload(runtimeRecord(JSON.parse(row.payload_json)))).length;
	}

	private successfulMutatingToolCallSinceLastLogOff(): boolean {
		if (!this.hasRuntimeStorage()) {
			return false;
		}
		const lastLogOffSeq = this.latestSuccessfulLogOffToolResultSeq();
		const rows = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE seq > ?
				   AND type = 'tool_result'
				 ORDER BY seq ASC`,
				lastLogOffSeq,
			)
			.toArray();
		return rows.some((row) => {
			const payload = runtimeRecord(JSON.parse(row.payload_json));
			return successfulToolResultPayload(payload) && mutableToolNames.has(canonicalToolName(stringValue(payload.name) ?? ''));
		});
	}

	private prematureLogOffCorrectedSinceLastLogOff(): boolean {
		if (!this.hasRuntimeStorage()) {
			return false;
		}
		const lastLogOffSeq = this.latestSuccessfulLogOffToolResultSeq();
		const row = this.state.storage.sql
			.exec<{ seq: number }>(
				`SELECT seq
				 FROM events
				 WHERE seq > ?
				   AND type = 'provider_tool_call_dropped'
				   AND payload_json LIKE '%"premature_log_off"%'
				 ORDER BY seq DESC
				 LIMIT 1`,
				lastLogOffSeq,
			)
			.toArray()[0];
		return Boolean(row);
	}

	private loopGeneratedTokenCountSinceLastLogOff(): number {
		if (!this.hasRuntimeStorage()) {
			return 0;
		}
		const lastLogOffSeq = this.latestSuccessfulLogOffToolResultSeq();
		const row = this.state.storage.sql
			.exec<{ tokens: number }>(
				`SELECT COALESCE(SUM(u.completion_tokens), 0) AS tokens
				 FROM provider_usage u
				 JOIN inference_submissions s
				   ON s.event_seq = u.request_seq
				  AND s.run_id = u.run_id
				 WHERE s.purpose = 'loop'
				   AND u.request_seq > ?`,
				lastLogOffSeq,
			)
			.toArray()[0];
		return Math.max(0, Math.floor(row?.tokens ?? 0));
	}

	private latestSuccessfulLogOffToolResultSeq(): number {
		const rows = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE type = 'tool_result'
				   AND payload_json LIKE '%"name":"log_off"%'
				 ORDER BY seq DESC`,
			)
			.toArray();
		for (const row of rows) {
			const payload = runtimeRecord(JSON.parse(row.payload_json));
			if (canonicalToolName(stringValue(payload.name) ?? '') === 'log_off' && successfulToolResultPayload(payload)) {
				return row.seq;
			}
		}
		return 0;
	}

	private latestCompactionSummary(): string {
		const rows = this.state.storage.sql
			.exec<{ payload_json: string }>(
				`SELECT payload_json
				 FROM events
				 WHERE type = 'compaction'
				 ORDER BY seq DESC`,
			)
			.toArray();
		for (const row of rows) {
			const summary = compactedSummaryForContext(JSON.parse(row.payload_json) as unknown);
			if (summary) {
				return summary;
			}
		}
		return '';
	}

	private consumeInjections(injectionIds?: string[]): string[] {
		const rows = injectionIds
			? injectionIds.length === 0
				? []
				: injectionIds.flatMap((id) =>
						this.state.storage.sql
							.exec<InjectionRow>(
								`SELECT
									id,
									text,
									kind,
									source_id AS sourceId,
									spotlight_id AS spotlightId
								 FROM injections
								 WHERE consumed_at IS NULL AND id = ?`,
								id,
							)
							.toArray(),
					)
			: this.state.storage.sql
					.exec<InjectionRow>(
						`SELECT
							id,
							text,
							kind,
							source_id AS sourceId,
							spotlight_id AS spotlightId
						 FROM injections
						 WHERE consumed_at IS NULL
						   AND kind != 'spotlight'
						 ORDER BY created_at ASC
						 LIMIT 10`,
					)
					.toArray();
		if (rows.length > 0) {
			const now = new Date().toISOString();
			for (const row of rows) {
				this.state.storage.sql.exec(`UPDATE injections SET consumed_at = ? WHERE id = ?`, now, row.id);
			}
		}
		return rows.map((row) => row.text);
	}

	private async injectThought(text: string, metadata: InjectionMetadata = {}): Promise<BotRuntimeEvent> {
		const now = new Date().toISOString();
		const id = crypto.randomUUID();
		this.state.storage.sql.exec(
			`INSERT INTO injections (id, text, kind, source_id, spotlight_id, created_at, consumed_at)
			 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
			id,
			text,
			metadata.kind ?? 'manual',
			metadata.sourceId ?? null,
			metadata.spotlightId ?? null,
			now,
		);
		return this.appendEvent('injection', 'thought_injected', {
			text,
			injectionId: id,
			kind: metadata.kind ?? 'manual',
			...(metadata.sourceId ? { sourceId: metadata.sourceId } : {}),
			...(metadata.spotlightId ? { spotlightId: metadata.spotlightId } : {}),
		});
	}

	private async compactIfNeeded(bot: BotDocument, settings: ProviderSettings, runId: string, signal: AbortSignal): Promise<void> {
		bot = await this.botWithCurrentRuntimeBudget(bot);
		await this.repairActiveProviderToolCallHistory(runId);
		const requestContextWindowTokens = effectiveContextWindowTokensForModel(settings, effectiveTickSettings(bot.tickSettings).contextWindowTokens);
		const contextEstimate = this.currentCompactionContextEstimate(settings.model);
		const providerTools = providerToolsForBotRound(bot, settings).tools;
		const compactionMode = providerCompactionMode(settings);
		const limits = this.compactionSummaryLimitsForRows(
			bot,
			contextEstimate.rows.map((item) => item.row),
			contextEstimate.calibration,
			providerTools,
			compactionMode,
			requestContextWindowTokens,
		);
		const threshold = limits.nextCompactionTokens;
		const requestMessages = providerMessagesWithPrefillCompatibility(
			settings,
			this.activeProviderRequestMessages(bot, providerTools, providerToolCallsForSettings(settings)),
		);
		const estimate = this.estimateProviderPromptTokens(settings, requestMessages, providerTools);
		if (estimate.promptTokens <= threshold) {
			return;
		}

		const compacted = this.compactionRowsForEstimatedBudget(
			bot,
			providerTools,
			compactionMode,
			requestContextWindowTokens,
			settings.model,
		);
		if (compacted.length === 0) {
			return;
		}
		await this.compactLoopMessageRows(bot, settings, runId, signal, compacted, 'auto', {
			estimatedContextTokens: contextEstimate.totalTokens,
			estimatedPromptTokens: estimate.promptTokens,
			compactionMaxCharacters: limits.maxLength,
			compactionMaxCompletionTokens: limits.maxCompletionTokens,
			threshold,
		});
	}

	private async ensureProviderPromptWithinBudget(
		bot: BotDocument,
		settings: ProviderSettings,
		runId: string,
		signal: AbortSignal,
		providerTools: ProviderToolDefinition[],
	): Promise<ProviderPromptBudgetCheck> {
		let compactionAttempts = 0;
		for (;;) {
			this.throwIfStopped(runId, signal);
			const budgetBot = await this.botWithCurrentRuntimeBudget(bot);
			const tickSettings = effectiveTickSettings(budgetBot.tickSettings);
			const requestContextWindowTokens = effectiveContextWindowTokensForModel(settings, tickSettings.contextWindowTokens);
			providerTools = providerToolsForBotRound(budgetBot, settings).tools;
			const compactionMode = providerCompactionMode(settings);
			const calibration = this.textTokenCalibration(settings.model);
			const requestMessages = providerMessagesWithPrefillCompatibility(
				settings,
				this.activeProviderRequestMessages(budgetBot, providerTools, providerToolCallsForSettings(settings)),
			);
			const promptBudgetLimits = providerCompactionSummaryLimitsForChat(
				budgetBot,
				requestMessages.slice(1),
				calibration,
				providerTools,
				compactionMode,
				requestContextWindowTokens,
			);
			const allowedPromptTokens = promptBudgetLimits.nextCompactionTokens;
			const estimate = this.estimateProviderPromptTokens(settings, requestMessages, providerTools);
			const overBudgetTokens = Math.max(0, estimate.promptTokens - allowedPromptTokens);
			const maxCompletionTokens = providerLoopMaxCompletionTokens(requestContextWindowTokens, estimate.promptTokens);
			await this.appendEvent(runId, 'provider_token_estimate', {
				model: settings.model,
				messageCount: requestMessages.length,
				toolCount: providerTools.length,
				contextWindowTokens: requestContextWindowTokens,
				maxCompletionTokens,
				compactionMaxCompletionTokens: promptBudgetLimits.maxCompletionTokens,
				nextCompactionTokens: allowedPromptTokens,
				promptTokens: estimate.promptTokens,
				allowedPromptTokens,
				overBudgetTokens,
				source: estimate.source,
				calibrationSampleCount: estimate.calibrationSampleCount,
				...(estimate.baselinePromptTokens !== undefined ? { baselinePromptTokens: estimate.baselinePromptTokens } : {}),
				...(estimate.baselineMessageCount !== undefined ? { baselineMessageCount: estimate.baselineMessageCount } : {}),
				...(estimate.estimatedDeltaTokens !== undefined ? { estimatedDeltaTokens: estimate.estimatedDeltaTokens } : {}),
			});
			if (overBudgetTokens === 0) {
				return {
					allowedPromptTokens,
					contextWindowTokens: requestContextWindowTokens,
					maxCompletionTokens,
					promptTokens: estimate.promptTokens,
					requestMessages,
				};
			}
			if (compactionAttempts >= providerPromptCompactionMaxAttempts) {
				throw new PromptContextCompactionLimitError(estimate.promptTokens, allowedPromptTokens, providerPromptCompactionMaxAttempts);
			}
			const compactionSelection = this.compactionRowSelectionForEstimatedBudget(
				budgetBot,
				providerTools,
				compactionMode,
				requestContextWindowTokens,
				settings.model,
				{ requireMinimumSelectedTokens: false },
			);
			const rowsToCompact = compactionSelection.rows;
			if (rowsToCompact.length === 0) {
				throw new PromptContextBudgetExceededError(estimate.promptTokens, allowedPromptTokens);
			}
			compactionAttempts += 1;
			await this.compactLoopMessageRows(budgetBot, settings, runId, signal, rowsToCompact, 'auto', {
				allowedPromptTokens,
				compactionMaxCharacters: promptBudgetLimits.maxLength,
				compactionMaxCompletionTokens: promptBudgetLimits.maxCompletionTokens,
				estimatedPromptTokens: estimate.promptTokens,
				overBudgetTokens,
				threshold: allowedPromptTokens,
				...(compactionSelection.overBudgetFallback ? { compactionOverBudgetFallback: true } : {}),
			});
		}
	}

	private activeProviderRequestMessages(
		bot: RuntimeBotDocument,
		providerTools: readonly ProviderToolDefinition[] = providerFunctionToolsForBot(bot),
		toolCalls: BotInferenceToolCalls = 'require',
	): ChatMessage[] {
		const systemContent =
			toolCalls === 'at_will' ? standardPrompt(bot, bot.worldPrompt) : appendToolRequirementInstruction(standardPrompt(bot, bot.worldPrompt), providerTools);
		return [{ role: 'system', content: systemContent }, ...this.activeLoopMessagesForProvider()];
	}

	private estimateProviderPromptTokens(
		settings: ProviderSettings,
		requestMessages: ChatMessage[],
		providerTools: ProviderToolDefinition[],
	): ProviderPromptTokenEstimate {
		const calibration = this.textTokenCalibration(settings.model);
		requestMessages = providerMessagesWithPrefillCompatibility(settings, requestMessages);
		const baseline = this.latestCompatiblePromptTokenBaseline(settings, requestMessages);
		if (baseline) {
			const deltaMessages = requestMessages.slice(baseline.messages.length);
			const estimatedDeltaTokens = estimateChatMessagesTokens(deltaMessages, calibration);
			return {
				promptTokens: baseline.promptTokens + estimatedDeltaTokens + providerPromptEstimateSafetyTokens,
				source: 'baseline_plus_delta',
				baselinePromptTokens: baseline.promptTokens,
				baselineMessageCount: baseline.messages.length,
				estimatedDeltaTokens,
				calibrationSampleCount: calibration.sampleCount,
			};
		}
		return {
			promptTokens:
				estimateChatMessagesTokens(requestMessages, calibration) +
				estimateTextTokensWithCalibration(JSON.stringify(providerTools), calibration) +
				providerPromptEstimateSafetyTokens,
			source: 'full_estimate',
			calibrationSampleCount: calibration.sampleCount,
		};
	}

	private latestCompatiblePromptTokenBaseline(
		settings: ProviderSettings,
		requestMessages: ChatMessage[],
	): { messages: ChatMessage[]; promptTokens: number } | null {
		const rows = this.state.storage.sql
			.exec<PromptTokenBaselineRow>(
				`SELECT s.event_seq, s.run_id, s.purpose, s.messages_json, s.model, s.provider_base_url, u.prompt_tokens
				 FROM inference_submissions s
				 JOIN provider_usage u
				   ON u.request_seq = s.event_seq
				  AND u.run_id = s.run_id
				 WHERE s.purpose = 'loop'
				   AND s.model = ?
				   AND s.provider_base_url = ?
				   AND u.prompt_tokens > 0
				 ORDER BY s.event_seq DESC
				 LIMIT 20`,
				settings.model,
				settings.baseUrl,
			)
			.toArray();
		for (const row of rows) {
			const messages = parseChatMessagesJson(row.messages_json);
			if (messages && chatMessagesArePrefix(messages, requestMessages)) {
				return { messages, promptTokens: Math.max(0, Math.floor(row.prompt_tokens)) };
			}
		}
		return null;
	}

	private compactionRowsForEstimatedBudget(
		bot: BotDocument,
		providerTools?: ProviderToolDefinition[],
		mode: ProviderCompactionMode = 'structured_output',
		contextWindowTokens?: number,
		requestedModel?: string,
		options: CompactionSelectionOptions = {},
	): LoopMessageRow[] {
		return this.compactionRowSelectionForEstimatedBudget(
			bot,
			providerTools,
			mode,
			contextWindowTokens,
			requestedModel,
			options,
		).rows;
	}

	private compactionRowSelectionForEstimatedBudget(
		bot: BotDocument,
		providerTools?: ProviderToolDefinition[],
		mode: ProviderCompactionMode = 'structured_output',
		contextWindowTokens?: number,
		requestedModel?: string,
		options: CompactionSelectionOptions = {},
	): CompactionRowSelection {
		const calibration = this.textTokenCalibration(requestedModel);
		const rows = this.compactionCandidateEstimates(calibration);
		return oldestLoopMessageGroupSelectionForPromptLimit(
			rows,
			this.compactionPromptTokenLimit(
				bot,
				rows.map((item) => item.row),
				calibration,
					providerTools,
				mode,
				contextWindowTokens,
			),
			{
				canIncludeRows: (selectedRows) =>
					this.compactionRowsLeaveOutputBudget(
						bot,
						selectedRows,
						calibration,
						providerTools,
						mode,
						contextWindowTokens,
					),
				requireMinimumSelectedTokens: options.requireMinimumSelectedTokens ?? true,
			},
		);
	}

	private async manualCompactLoopMessages(botId: string): Promise<{ fromSeq?: number; toSeq?: number; messageCount: number }> {
		await this.beginMaintenanceOperation(botId, 'manual_compaction', 'Cannot compact loop history while the bot is running.');
		try {
			const bot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
			const owner = await userById(this.env.BICKR_KV, bot.ownerUserId);
			const settings = this.effectiveProviderSettings(bot, owner);
			const runId = crypto.randomUUID();
			await this.repairActiveProviderToolCallHistory(runId);
			const rows = this.compactionCandidateRows();
			if (rows.length === 0) {
				return { messageCount: 0 };
			}
			await this.compactLoopMessageRowsInBatches(bot, settings, runId, new AbortController().signal, rows, 'manual', {});
			try {
				await this.exportRecentProviderUsage(bot);
			} catch (error) {
				console.warn('central provider usage export failed', botId, error);
			}
			return { fromSeq: rows[0]?.seq, toSeq: rows[rows.length - 1]?.seq, messageCount: rows.length };
		} finally {
			this.finishMaintenanceOperation('manual_compaction');
		}
	}

	private async compactLoopMessageRowsInBatches(
		bot: BotDocument,
		settings: ProviderSettings,
		runId: string,
		signal: AbortSignal,
		rows: LoopMessageRow[],
		mode: 'auto' | 'manual',
		metrics: CompactionMetrics,
	): Promise<void> {
		let remaining = rows;
		let batchIndex = 0;
		const providerTools = providerToolsForBotRound(bot, settings).tools;
		while (remaining.length > 0) {
			const calibration = this.textTokenCalibration(settings.model);
			const requestContextWindowTokens = effectiveContextWindowTokensForModel(
				settings,
				effectiveTickSettings(bot.tickSettings).contextWindowTokens,
			);
			const estimates = remaining.map((row) => ({
				row,
				tokens: estimateChatMessageTokens(loopMessageChatMessageFromRow(row), calibration),
			}));
			const selection = oldestLoopMessageGroupSelectionForPromptLimit(
				estimates,
				this.compactionPromptTokenLimit(
					bot,
					remaining,
					calibration,
					providerTools,
					providerCompactionMode(settings),
					requestContextWindowTokens,
				),
				{
					canIncludeRows: (selectedRows) =>
						this.compactionRowsLeaveOutputBudget(
							bot,
							selectedRows,
							calibration,
							providerTools,
							providerCompactionMode(settings),
							requestContextWindowTokens,
						),
				},
			);
			const batch = selection.rows;
			if (batch.length === 0) {
				throw new RepositoryError(
					'bad_request',
					'The oldest loop message group is too large to compact within the current context budget.',
					400,
				);
			}
			const selected = batch;
			const compactedRows = await this.compactLoopMessageRows(bot, settings, runId, signal, selected, mode, {
				...metrics,
				...(rows.length !== selected.length ? { batchIndex } : {}),
				...(selection.overBudgetFallback ? { compactionOverBudgetFallback: true } : {}),
			});
			const selectedSeqs = new Set((compactedRows.length > 0 ? compactedRows : selected).map((row) => row.seq));
			remaining = remaining.filter((row) => !selectedSeqs.has(row.seq));
			batchIndex += 1;
		}
	}

	private compactionRowsLeaveOutputBudget(
		bot: BotDocument,
		rows: readonly LoopMessageRow[],
		calibration: TextTokenCalibration,
		providerTools?: ProviderToolDefinition[],
		mode: ProviderCompactionMode = 'structured_output',
		contextWindowTokens?: number,
	): boolean {
		const limits = this.compactionSummaryLimitsForRows(bot, rows, calibration, providerTools, mode, contextWindowTokens);
		return limits.maxCompletionTokens >= providerCompactionRequiredCompletionTokens(limits);
	}

	private async compactLoopMessageRows(
		bot: BotDocument,
		settings: ProviderSettings,
		runId: string,
		signal: AbortSignal,
		compacted: LoopMessageRow[],
		mode: 'auto' | 'manual',
		metrics: CompactionMetrics,
	): Promise<LoopMessageRow[]> {
		let providerRows = compacted.filter((row) => loopMessageContributesToCompactionProviderInput(row));
		if (providerRows.length === 0) {
			return [];
		}
		const providerTools = providerToolsForBotRound(bot, settings).tools;
		const providerActive = Boolean(settings.apiKey || settings.usesCustomBaseUrl || this.env.BICKR_SIMULATION_MODE === 'provider');
		let response:
			| (Pick<ProviderResponse, 'usage' | 'responseId' | 'responseModel' | 'responseProviderName' | 'requestBody' | 'rawResponse'> & {
					content: string;
			  })
			| null = null;
		let summaryEvent: BotRuntimeEvent | null = null;
		let compactionEventPayload: Record<string, unknown> | null = null;
		let compactionLimits: ProviderCompactionSummaryLimits | null = null;
		let ledgerRows: LoopMessageRow[] = [];
		let recentActivity = '';
		let compactedMessages: ChatMessage[] = [];
		let compactedCommentBodies: ReadonlyMap<string, string> = new Map();
		let outputLimitShrinkAttempts = 0;

		for (;;) {
			const calibration = this.textTokenCalibration(settings.model);
			const requestContextWindowTokens = effectiveContextWindowTokensForModel(
				settings,
				effectiveTickSettings(bot.tickSettings).contextWindowTokens,
			);
			const compactionMode = providerCompactionMode(settings);
			ledgerRows = this.compactionLedgerRows(providerRows);
			recentActivity = providerRows.map((message) => truncateForContext(loopMessageContextLine(message), 1_200)).join('\n');
			compactedMessages = providerRows.map((row) => loopMessageChatMessageFromRow(row));
			compactedCommentBodies = commentTextRecordsFromChatMessages(compactedMessages);
			const baseLimits = providerCompactionSummaryLimitsForChat(
				bot,
				compactedMessages,
				calibration,
				providerTools,
				compactionMode,
				requestContextWindowTokens,
			);
			const compactionTools = providerCompactionToolsForMode(baseLimits, providerTools, compactionMode);
			const compactionMessages = providerCompactionMessages(bot, compactedMessages, baseLimits, compactionTools, compactionMode);
			const compactionResponseFormat = providerCompactionResponseFormat(baseLimits.maxLength, compactionMode);
			const overBudgetFallback = metrics.compactionOverBudgetFallback === true;
			compactionLimits = {
				...baseLimits,
				maxCompletionTokens: overBudgetFallback
					? providerCompactionRequiredCompletionTokens(baseLimits)
					: providerCompactionMaxCompletionTokensForRequest(
							requestContextWindowTokens,
							compactionMessages,
							compactionTools,
							calibration,
							compactionResponseFormat,
						),
			};
			compactionEventPayload = {
				fromSeq: providerRows[0]?.seq,
				toSeq: providerRows[providerRows.length - 1]?.seq,
				messageCount: providerRows.length,
				mode,
				...metrics,
				compactionMinCharacters: compactionLimits.minLength,
				compactionMaxCharacters: compactionLimits.maxLength,
				compactionMaxCompletionTokens: compactionLimits.maxCompletionTokens,
				compactionInputTokens: compactionLimits.compactionInputTokens,
				compactionRequestOverheadTokens: compactionLimits.compactionRequestOverheadTokens,
				anticipatedSummaryTokens: compactionLimits.anticipatedSummaryTokens,
				nextCompactionTokens: compactionLimits.nextCompactionTokens,
				compactionMode,
				...(outputLimitShrinkAttempts > 0 ? { outputLimitShrinkAttempts } : {}),
				...(overBudgetFallback ? { overBudgetFallback: true } : {}),
			};
			if (!summaryEvent) {
				summaryEvent = await this.appendEvent(runId, 'compaction', {
					...compactionEventPayload,
					status: 'pending',
				});
			} else {
				this.replaceEventPayload(summaryEvent, {
					...compactionEventPayload,
					status: 'pending',
				});
			}
			if (providerActive) {
				this.recordInferenceSubmission({
					seq: summaryEvent.seq,
					runId,
					purpose: 'compaction',
					settings,
					messages: compactionMessages,
					createdAt: summaryEvent.createdAt,
				});
			}
			try {
				response = providerActive
					? await this.callProviderForCompaction(
							settings,
							compactionMessages,
							runId,
							signal,
							compactionLimits,
							compactionTools,
							compactionMode,
							summaryEvent.seq,
							summaryEvent.createdAt,
							bot,
						)
					: {
							content: deterministicCompactionSummary('', recentActivity),
						};
				break;
			} catch (error) {
				const reducedRows = isProviderCompactionOutputLimitFailure(error)
					? reducedCompactionRowsAfterOutputLimit(providerRows, calibration)
					: providerRows;
				if (reducedRows.length > 0 && reducedRows.length < providerRows.length) {
					outputLimitShrinkAttempts += 1;
					providerRows = reducedRows;
					continue;
				}
				this.replaceEventPayload(summaryEvent, {
					...compactionEventPayload,
					status: 'failed',
					error: runtimeErrorText(error),
				});
				throw error;
			}
		}
		if (!summaryEvent || !compactionEventPayload || !compactionLimits || !response) {
			throw new Error('Context compaction did not produce a summary event.');
		}
		const summary = response.content ? storedCompactionSummary(response.content) : deterministicCompactionSummary('', recentActivity);
		const summaryPosition = providerRows[providerRows.length - 1]?.position ?? this.nextLoopMessagePosition();
		const summaryMessage = this.insertLoopMessage({
			runId,
			message: { role: 'assistant', content: summary },
			origin: 'compaction',
			status: 'complete',
			position: summaryPosition,
			streamSeq: summaryEvent.seq,
			broadcast: true,
		});
		for (const row of ledgerRows) {
			this.state.storage.sql.exec(
				`UPDATE loop_messages
				 SET compacted_by = ?
				 WHERE seq = ?
				   AND compacted_by IS NULL`,
				summaryMessage.seq,
				row.seq,
			);
		}
		this.recordLoopMessageLog(summaryMessage.seq, 'message', JSON.stringify(summaryMessage.message));
		if (response.requestBody) {
			this.recordLoopMessageLog(summaryMessage.seq, 'compaction_request', response.requestBody);
		}
		if (response.rawResponse) {
			this.recordLoopMessageLog(summaryMessage.seq, 'compaction_response', response.rawResponse);
		}
		this.replaceEventPayload(summaryEvent, {
			...compactionEventPayload,
			status: 'complete',
			summary,
			summaryMessageSeq: summaryMessage.seq,
		});
		if (providerActive) {
			this.updateInferenceSubmissionDisplayMessages(summaryEvent.seq, [
				{ role: 'user', content: 'Bickr Terminal condenses older memory notes.' },
				{ role: 'assistant', content: summary },
			]);
		}
		if (response.usage) {
			await this.recordProviderUsage({
				contextWindowTokens: effectiveContextWindowTokensForModel(
					settings,
					effectiveTickSettings(bot.tickSettings).contextWindowTokens,
				),
				createdAt: summaryEvent.createdAt,
				providerName: response.responseProviderName,
				providerResponseId: response.responseId,
				requestSeq: summaryEvent.seq,
				responseModel: response.responseModel,
				runId,
				settings,
				usage: response.usage,
			});
		}
		this.repairDanglingCommentReferencesAfterCompaction(
			summaryMessage.seq,
			summaryPosition,
			summaryMessage.message,
			compactedCommentBodies,
		);
		this.broadcastControl({ type: 'loop_messages_reset' });
		return providerRows;
	}

	private compactionLedgerRows(providerRows: readonly LoopMessageRow[]): LoopMessageRow[] {
		if (providerRows.length === 0) {
			return [];
		}
		const providerSeqs = new Set(providerRows.map((row) => row.seq));
		const lastProviderPosition = Math.max(...providerRows.map((row) => row.position));
		const rowsBySeq = new Map<number, LoopMessageRow>();
		for (const row of this.activeLoopMessageRows()) {
			const message = loopMessageChatMessageFromRow(row);
			if (
				providerSeqs.has(row.seq) ||
				(row.position <= lastProviderPosition && !loopMessageContributesToProviderHistory(row.origin, message))
			) {
				rowsBySeq.set(row.seq, row);
			}
		}
		for (const row of providerRows) {
			rowsBySeq.set(row.seq, row);
		}
		return [...rowsBySeq.values()].sort((left, right) => left.position - right.position || left.seq - right.seq);
	}

	private repairDanglingCommentReferencesAfterCompaction(
		summarySeq: number,
		summaryPosition: number,
		summaryMessage: ChatMessage,
		compactedCommentBodies: ReadonlyMap<string, string>,
	): void {
		if (compactedCommentBodies.size === 0) {
			return;
		}
		const rows = this.state.storage.sql
			.exec<LoopMessageRow>(
				`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
				        m.token_estimate, m.stream_seq, m.compacted_by, m.deleted_at, m.created_at,
				        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
				 FROM loop_messages m
				 WHERE m.compacted_by IS NULL
				   AND m.deleted_at IS NULL
				   AND m.role = 'tool'
				   AND (m.position > ? OR (m.position = ? AND m.seq > ?))
				 ORDER BY m.position ASC, m.seq ASC`,
				summaryPosition,
				summaryPosition,
				summarySeq,
			)
			.toArray();
		if (rows.length === 0) {
			return;
		}
		const activeScope = emptyProviderContextContentScope();
		collectProviderContextContentFromValue(summaryMessage.content, activeScope);
		for (const row of rows) {
			collectProviderContextContentFromValue(loopMessageChatMessageFromRow(row).content, activeScope);
		}

		const pendingCommentIds = new Set<string>();
		for (const row of rows) {
			const refs = commentReferencesWithoutTextFromValue(loopMessageChatMessageFromRow(row).content);
			for (const commentId of refs) {
				if (!activeScope.commentsWithText.has(commentId) && compactedCommentBodies.has(commentId)) {
					pendingCommentIds.add(commentId);
				}
			}
		}
		if (pendingCommentIds.size === 0) {
			return;
		}

		const idsByRowSeq = new Map<number, Set<string>>();
		for (const row of [...rows].reverse()) {
			if (pendingCommentIds.size === 0) {
				break;
			}
			const refs = commentReferencesWithoutTextFromValue(loopMessageChatMessageFromRow(row).content);
			for (const commentId of refs) {
				if (!pendingCommentIds.has(commentId)) {
					continue;
				}
				let ids = idsByRowSeq.get(row.seq);
				if (!ids) {
					ids = new Set();
					idsByRowSeq.set(row.seq, ids);
				}
				ids.add(commentId);
				pendingCommentIds.delete(commentId);
			}
		}
		if (idsByRowSeq.size === 0) {
			return;
		}

		for (const row of rows) {
			const ids = idsByRowSeq.get(row.seq);
			if (!ids) {
				continue;
			}
			const message = loopMessageChatMessageFromRow(row);
			if (typeof message.content !== 'string') {
				continue;
			}
			let content: unknown;
			try {
				content = JSON.parse(message.content);
			} catch {
				continue;
			}
			const hydrated = hydrateNewestCommentReferences(content, ids, compactedCommentBodies);
			if (hydrated.size === 0) {
				continue;
			}
			const updatedContent = JSON.stringify(content);
			const updatedMessage = { ...message, content: updatedContent };
			const messageJson = JSON.stringify(updatedMessage);
			const tokenEstimate = estimateTextTokens(messageJson);
			this.state.storage.sql.exec(
				`UPDATE loop_messages
				 SET message_json = ?, token_estimate = ?
				 WHERE seq = ?`,
				messageJson,
				tokenEstimate,
				row.seq,
			);
			this.recordLoopMessageLog(row.seq, 'message', messageJson);
			this.recordLoopMessageLog(row.seq, 'tool_result', updatedContent);
		}
	}

	private currentCompactionContextEstimate(requestedModel?: string): {
		totalTokens: number;
		rowTokens: number;
		rows: CompactionCandidateEstimate[];
		calibration: TextTokenCalibration;
	} {
		const calibration = this.textTokenCalibration(requestedModel);
		const rows = this.compactionCandidateEstimates(calibration);
		const rowTokens = rows.reduce((total, item) => total + item.tokens, 0);
		return {
			totalTokens: rowTokens,
			rowTokens,
			rows,
			calibration,
		};
	}

	private compactionCandidateRows(): LoopMessageRow[] {
		return this.activeProviderHistoryLoopMessageRows();
	}

	private compactionCandidateEstimates(calibration = this.textTokenCalibration()): CompactionCandidateEstimate[] {
		return this.compactionCandidateRows().map((row) => ({
			row,
			tokens: estimateChatMessageTokens(loopMessageChatMessageFromRow(row), calibration),
		}));
	}

	private compactionSummaryLimitsForRows(
		bot: BotDocument,
		rows: readonly LoopMessageRow[],
		calibration = this.textTokenCalibration(),
		providerTools?: ProviderToolDefinition[],
		mode: ProviderCompactionMode = 'structured_output',
		contextWindowTokens?: number,
	): ProviderCompactionSummaryLimits {
		return providerCompactionSummaryLimitsForChat(
			bot,
			rows.map((row) => loopMessageChatMessageFromRow(row)),
			calibration,
			providerTools,
			mode,
			contextWindowTokens,
		);
	}

	private nextCompactionTokens(bot: BotDocument, contextWindowTokens?: number, requestedModel?: string): number {
		const tickSettings =
			contextWindowTokens === undefined
				? bot.tickSettings
				: { ...bot.tickSettings, contextWindowTokens: Math.max(1, Math.floor(contextWindowTokens)) };
		const budgetBot = { ...bot, tickSettings };
		return providerCompactionSummaryLimitsForChat(
			budgetBot,
			this.hasRuntimeStorage() ? this.activeLoopMessagesForProvider() : [],
			this.textTokenCalibration(requestedModel),
			providerFunctionToolsForBot(budgetBot, { compactionMode: budgetBot.inferenceSettings.compactionMode ?? 'structured_output' }),
			budgetBot.inferenceSettings.compactionMode ?? 'structured_output',
		).nextCompactionTokens;
	}

	private compactionPromptTokenLimit(
		bot: BotDocument,
		rows: readonly LoopMessageRow[],
		calibration = this.textTokenCalibration(),
		providerTools?: ProviderToolDefinition[],
		mode: ProviderCompactionMode = 'structured_output',
		contextWindowTokens?: number,
	): number {
		const limits = this.compactionSummaryLimitsForRows(bot, rows, calibration, providerTools, mode, contextWindowTokens);
		return Math.max(1, Math.min(providerCompactionMaxPromptEstimateTokens, limits.compactionInputTokens));
	}

	private textTokenCalibration(requestedModel?: string): TextTokenCalibration {
		if (!requestedModel) {
			return textTokenCalibrationFromProviderTokenCalibrationSamples([]);
		}
		const rows = this.state.storage.sql
			.exec<ProviderTokenCalibrationSampleRow>(
				`SELECT id, run_id, request_seq, attempt, purpose, requested_model, response_model,
				        provider_base_url, prompt_tokens, request_characters, created_at
				 FROM provider_token_calibration_samples
				 WHERE requested_model = ?
				   AND prompt_tokens > 0
				   AND request_characters > 0
				 ORDER BY id DESC
				 LIMIT 50`,
				requestedModel,
			)
			.toArray();
		return textTokenCalibrationFromProviderTokenCalibrationSamples(rows);
	}

	private async appendEvent(runId: string, type: BotRuntimeEventType, payload: unknown): Promise<BotRuntimeEvent> {
		const now = new Date().toISOString();
		const payloadJson = JSON.stringify(payload);
		const tokenEstimate = estimateTextTokens(payloadJson);
		this.state.storage.sql.exec(
			`INSERT INTO events (run_id, type, payload_json, token_estimate, compacted_by, created_at)
			 VALUES (?, ?, ?, ?, NULL, ?)`,
			runId,
			type,
			payloadJson,
			tokenEstimate,
			now,
		);
		const row = this.state.storage.sql.exec<{ seq: number }>(`SELECT last_insert_rowid() AS seq`).one();
		const event: BotRuntimeEvent = {
			seq: row.seq,
			runId,
			type,
			payload,
			tokenEstimate,
			createdAt: now,
		};
		this.broadcast(event);
		return event;
	}

	private replaceEventPayload(event: BotRuntimeEvent, payload: unknown): BotRuntimeEvent {
		const payloadJson = JSON.stringify(payload);
		const tokenEstimate = estimateTextTokens(payloadJson);
		this.state.storage.sql.exec(
			`UPDATE events
			 SET payload_json = ?, token_estimate = ?
			 WHERE seq = ?`,
			payloadJson,
			tokenEstimate,
			event.seq,
		);
		const updated = {
			...event,
			payload,
			tokenEstimate,
		};
		this.broadcast(updated);
		return updated;
	}

	private async clearHistory(
		botId: string,
	): Promise<{ events: number; injections: number; runtimeState: number; submissions: number; messages: number; logs: number }> {
		await this.beginMaintenanceOperation(botId, 'clear_history', 'Cannot erase chat history while the bot is running.');
		try {
			const submissions = this.clearInferenceSubmissions();
			this.state.storage.sql.exec(`DELETE FROM loop_message_log_chunks`);
			this.state.storage.sql.exec(`DELETE FROM loop_message_logs`);
			const logs = this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
			this.state.storage.sql.exec(`DELETE FROM loop_messages`);
			const messages = this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
			this.state.storage.sql.exec(`DELETE FROM events`);
			const events = this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
			this.state.storage.sql.exec(`DELETE FROM injections`);
			const injections = this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
			this.state.storage.sql.exec(`DELETE FROM runtime_state`);
			const runtimeState = this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
			this.broadcastControl({ type: 'history_cleared', botId });
			return { events, injections, runtimeState, submissions, messages, logs };
		} finally {
			this.finishMaintenanceOperation('clear_history');
		}
	}

	private async deleteLoopMessage(
		botId: string,
		seq: number,
	): Promise<{ seq: number; runId: string; origin: BotLoopMessageOrigin; deletedAt: string }> {
		if (!Number.isInteger(seq) || seq <= 0) {
			throw new RepositoryError('bad_request', 'Loop message sequence is invalid.', 400);
		}
		const row = this.state.storage.sql
			.exec<LoopMessageRow>(
				`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
				        m.token_estimate, m.stream_seq, m.compacted_by, m.deleted_at, m.created_at,
				        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
				 FROM loop_messages m
				 WHERE m.seq = ?
				 LIMIT 1`,
				seq,
			)
			.toArray()[0];
		if (!row) {
			throw new RepositoryError('not_found', 'Loop message was not found.', 404);
		}
		const current = await this.status(botId);
		if (current.status === 'running' && current.activeRunId === row.run_id) {
			throw new RepositoryError('conflict', 'Cannot delete a message from the currently running tick.', 409);
		}
		const deletedAt = row.deleted_at ?? new Date().toISOString();
		if (!row.deleted_at) {
			this.state.storage.sql.exec(
				`UPDATE loop_messages
				 SET deleted_at = ?
				 WHERE seq = ?
				   AND deleted_at IS NULL`,
				deletedAt,
				seq,
			);
		}
		this.broadcastControl({ type: 'loop_message_deleted', seq, deletedAt });
		return { seq, runId: row.run_id, origin: row.origin, deletedAt };
	}

	private async deleteEvent(botId: string, seq: number): Promise<{ seq: number; runId: string; type: BotRuntimeEventType }> {
		if (!Number.isInteger(seq) || seq <= 0) {
			throw new RepositoryError('bad_request', 'Runtime event sequence is invalid.', 400);
		}
		const row = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE seq = ?
				 LIMIT 1`,
				seq,
			)
			.toArray()[0];
		if (!row) {
			throw new RepositoryError('not_found', 'Runtime event was not found.', 404);
		}
		const current = await this.status(botId);
		if (current.status === 'running' && current.activeRunId === row.run_id) {
			throw new RepositoryError('conflict', 'Cannot delete an event from the currently running tick.', 409);
		}
		if (row.type === 'compaction') {
			this.state.storage.sql.exec(`UPDATE events SET compacted_by = NULL WHERE compacted_by = ?`, seq);
		}
		this.state.storage.sql.exec(`DELETE FROM events WHERE seq = ?`, seq);
		const deleted = this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
		if (deleted !== 1) {
			throw new RepositoryError('not_found', 'Runtime event was not found.', 404);
		}
		this.deleteInferenceSubmissionsForSeq(seq);
		this.broadcastControl({ type: 'event_deleted', seq });
		return { seq, runId: row.run_id, type: row.type };
	}

	private eventsAfter(afterSeq: number): BotRuntimeEvent[] {
		const rows =
			afterSeq > 0
				? this.state.storage.sql
						.exec<RuntimeRow>(
							`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
						 FROM events
						 WHERE seq > ?
						   AND type != 'provider_delta'
						 ORDER BY seq ASC
						 LIMIT 2000`,
							afterSeq,
						)
						.toArray()
				: this.state.storage.sql
						.exec<RuntimeRow>(
							`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
						 FROM (
							SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
							FROM events
							WHERE type != 'provider_delta'
							ORDER BY seq DESC
							LIMIT 240
						 )
						 ORDER BY seq ASC`,
						)
						.toArray();
		return rows.map((row) => ({
			seq: row.seq,
			runId: row.run_id,
			type: row.type,
			payload: JSON.parse(row.payload_json) as unknown,
			tokenEstimate: row.token_estimate,
			createdAt: row.created_at,
			...(row.compacted_by ? { compactedBy: row.compacted_by } : {}),
		}));
	}

	private broadcast(event: BotRuntimeEvent): void {
		this.broadcastControl({ type: 'event', event });
	}

	private broadcastControl(message: unknown): void {
		const data = JSON.stringify(message);
		const sockets = typeof this.state.getWebSockets === 'function' ? this.state.getWebSockets() : [];
		for (const socket of sockets) {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(data);
			}
		}
	}

	private async status(botId: string): Promise<BotRuntimeStatus> {
		const row = await this.env.BICKR_D1.prepare(
			`SELECT
				enabled,
				status,
				active_run_id AS activeRunId,
				lease_expires_at AS leaseExpiresAt,
				next_due_at AS nextDueAt,
				last_error AS lastError,
				tick_interval_seconds AS tickIntervalSeconds
			 FROM bot_runtime_index
			 WHERE bot_id = ?`,
		)
			.bind(botId)
			.first<{
				enabled: number;
				status: 'idle' | 'running' | 'failed';
				activeRunId: string | null;
				leaseExpiresAt: string | null;
				nextDueAt: string | null;
				lastError: string | null;
				tickIntervalSeconds: number;
			}>();
		const enabled = row?.enabled === 1;
		if (row?.status === 'running' && row.activeRunId && this.hasStopRequest(row.activeRunId) && this.activeRunId !== row.activeRunId) {
			const bot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
			const nextDueAt = await this.markRunStopped(bot, row.activeRunId);
			return {
				botId,
				enabled,
				status: 'idle',
				...(nextDueAt ? { nextDueAt } : {}),
			};
		}
		if (row?.status === 'running' && row.activeRunId) {
			const stale = this.staleProviderStream(row.activeRunId);
			if (stale) {
				const message = `The Bickr page stopped responding after ${Math.round(providerStreamIdleTimeoutMs / 1000)} seconds.`;
				if (!this.hasTerminalEvent(row.activeRunId)) {
					await this.recordTickFailure(row.activeRunId, {
						message,
						lastEventType: stale.type,
						lastEventAt: stale.created_at,
					});
				}
				if (this.activeRunId === row.activeRunId) {
					this.setStopRequest(row.activeRunId);
					if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
						this.activeAbortController.abort();
					}
					this.activeRunId = null;
					this.activeAbortController = null;
				}
				const now = new Date().toISOString();
				await this.env.BICKR_D1.prepare(
					`UPDATE bot_runtime_index
					 SET status = 'failed',
					     active_run_id = NULL,
					     lease_expires_at = NULL,
					     last_error = ?,
					     updated_at = ?
					 WHERE bot_id = ? AND status = 'running' AND active_run_id = ?`,
				)
					.bind(message, now, botId, row.activeRunId)
					.run();
				return {
					botId,
					enabled,
					status: 'failed',
					...(enabled && row.nextDueAt ? { nextDueAt: row.nextDueAt } : {}),
					lastError: message,
				};
			}
		}
		if (row?.status === 'running' && row.leaseExpiresAt && Date.parse(row.leaseExpiresAt) <= Date.now()) {
			const message = 'This Bickr visit took too long and closed before completion.';
			if (row.activeRunId && !this.hasTerminalEvent(row.activeRunId)) {
				await this.recordTickFailure(row.activeRunId, {
					message,
					leaseExpiresAt: row.leaseExpiresAt,
				});
			}
			if (
				row.activeRunId &&
				this.activeRunId === row.activeRunId &&
				this.activeAbortController &&
				!this.activeAbortController.signal.aborted
			) {
				this.setStopRequest(row.activeRunId);
				this.activeAbortController.abort();
			}
			const now = new Date().toISOString();
			const nextDueAt = enabled ? new Date(Date.parse(now) + row.tickIntervalSeconds * 1000).toISOString() : null;
			if (row.activeRunId) {
				await this.env.BICKR_D1.prepare(
					`UPDATE bot_runtime_index
					 SET status = 'idle',
					     active_run_id = NULL,
					     lease_expires_at = NULL,
					     last_error = ?,
					     next_due_at = ?,
					     updated_at = ?
					 WHERE bot_id = ? AND status = 'running' AND active_run_id = ?`,
				)
					.bind(message, nextDueAt, now, botId, row.activeRunId)
					.run();
			} else {
				await this.env.BICKR_D1.prepare(
					`UPDATE bot_runtime_index
					 SET status = 'idle',
					     active_run_id = NULL,
					     lease_expires_at = NULL,
					     last_error = ?,
					     next_due_at = ?,
					     updated_at = ?
					 WHERE bot_id = ? AND status = 'running' AND active_run_id IS NULL`,
				)
					.bind(message, nextDueAt, now, botId)
					.run();
			}
			return {
				botId,
				enabled,
				status: 'idle',
				...(nextDueAt ? { nextDueAt } : {}),
				lastError: message,
			};
		}
		return {
			botId,
			enabled,
			status: row?.status ?? 'idle',
			...(row?.activeRunId ? { activeRunId: row.activeRunId } : {}),
			...(enabled && row?.nextDueAt ? { nextDueAt: row.nextDueAt } : {}),
			...(row?.lastError ? { lastError: row.lastError } : {}),
		};
	}

	private staleProviderStream(runId: string): ProviderStreamActivity | null {
		const activeAt = this.activeStreamActivity.get(runId);
		if (activeAt) {
			return Date.now() - Date.parse(activeAt) > providerStreamIdleTimeoutMs ? { type: 'provider_stream', created_at: activeAt } : null;
		}
		const row = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE run_id = ?
				 ORDER BY seq DESC
				 LIMIT 1`,
				runId,
			)
			.toArray()[0];
		if (!row || row.type !== 'provider_request') {
			return null;
		}
		const lastEventAt = Date.parse(row.created_at);
		if (!Number.isFinite(lastEventAt)) {
			return null;
		}
		return Date.now() - lastEventAt > providerStreamIdleTimeoutMs ? { type: row.type, created_at: row.created_at } : null;
	}

	private hasTerminalEvent(runId: string): boolean {
		const row = this.state.storage.sql
			.exec<{ found: number }>(
				`SELECT 1 AS found
				 FROM events
				 WHERE run_id = ?
				   AND type IN ('tick_completed', 'tick_failed', 'tick_stopped')
				 LIMIT 1`,
				runId,
			)
			.toArray()[0];
		return Boolean(row);
	}

	private async setRuntimeIndex(
		bot: BotDocument,
		status: 'idle' | 'running' | 'failed',
		activeRunId: string | null,
		lastError: string | undefined,
		now: string,
		ownedByRunId?: string,
	): Promise<string | null> {
		const enabled = await this.runtimeIndexEnabled(bot.id, bot.tickSettings.enabled);
		const leaseExpiresAt = status === 'running' ? new Date(Date.parse(now) + runtimeRunLeaseTimeoutMs).toISOString() : null;
		let nextDueAt: string | null;
		if (status === 'running') {
			nextDueAt = enabled ? leaseExpiresAt : null;
		} else if (!enabled) {
			nextDueAt = null;
		} else if (status === 'idle') {
			nextDueAt = this.nextDue(bot, now);
		} else {
			nextDueAt = new Date(Date.parse(now) + runtimeRunLeaseTimeoutMs).toISOString();
		}
		if (ownedByRunId !== undefined) {
			if (status === 'running') {
				throw new Error('Runtime run ownership guards are only valid for release transitions.');
			}
			await releaseRuntimeRun(this.env.BICKR_D1, {
				botId: bot.id,
				runId: ownedByRunId,
				status,
				nextDueAt,
				lastError: lastError ?? null,
				now,
			});
			return nextDueAt;
		}
		await this.env.BICKR_D1.prepare(
			`UPDATE bot_runtime_index
			 SET status = ?, active_run_id = ?, lease_expires_at = ?, last_error = ?, next_due_at = ?, updated_at = ?
			 WHERE bot_id = ?`,
		)
			.bind(status, activeRunId, leaseExpiresAt, lastError ?? null, nextDueAt, now, bot.id)
			.run();
		return nextDueAt;
	}

	private async pauseBotAfterPersistentCompactionFailure(bot: BotDocument, message: string, now: string): Promise<void> {
		try {
			await updateBot(this.env.BICKR_KV, this.env.BICKR_D1, bot.id, bot.ownerUserId, { tickSettings: { enabled: false } }, now);
		} catch (error) {
			console.warn('failed to persist participant pause after compaction reduction failure', bot.id, error);
			await this.env.BICKR_D1.prepare(
				`UPDATE bot_runtime_index
				 SET enabled = 0,
				     next_due_at = NULL,
				     last_error = ?,
				     updated_at = ?
				 WHERE bot_id = ?`,
			)
				.bind(message, now, bot.id)
				.run();
		}
	}

	private nextDue(bot: BotDocument, from = new Date().toISOString()): string {
		return new Date(Date.parse(from) + bot.tickSettings.intervalSeconds * 1000).toISOString();
	}

	private async runtimeIndexEnabled(botId: string, fallback: boolean): Promise<boolean> {
		const row = await this.env.BICKR_D1.prepare(
			`SELECT enabled
			 FROM bot_runtime_index
			 WHERE bot_id = ?`,
		)
			.bind(botId)
			.first<{ enabled: number }>();
		return row ? row.enabled === 1 : fallback;
	}

	private async requireOwnerOrInternal(request: Request, botId: string): Promise<void> {
		if (request.headers.get('x-bickr-scheduler') === '1') {
			return;
		}
		const userId = request.headers.get('x-bickr-user-id');
		if (!userId) {
			throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
		}
		const row = await this.env.BICKR_D1.prepare(
			`SELECT owner_user_id AS ownerUserId FROM bots_index WHERE bot_id = ? AND deleted_at IS NULL`,
		)
			.bind(botId)
			.first<{ ownerUserId: string }>();
		if (!row) {
			throw new RepositoryError('not_found', 'Bot not found.', 404);
		}
		if (row.ownerUserId !== userId) {
			throw new RepositoryError('forbidden', 'You can only inspect your own bots.', 403);
		}
	}
}

export async function buildRuntimeLoopInput(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	notifications: NotificationDocument[],
	injections: string[],
	toolUseReminder?: string,
): Promise<RuntimeLoopInputBuild> {
	const profileContextState: ForumContextProfileState = { includedProfileIds: new Set<string>() };
	const autoProfileSeenItems = new Map<string, SeenContentItem>();
	const notificationSeenItemsById: Record<string, SeenContentItem[]> = {};
	const messages: LoopNotification[] = [];
	for (const notification of notifications) {
		const forumContext = notification.event
			? null
			: await buildNotificationForumContext(kv, db, botId, notification, {
					profileContextState,
				});
		const notificationSeenItems = new Map<string, SeenContentItem>();
		const sourceSeenItem = seenItemFromSource(notification.sourceObjectId);
		if (sourceSeenItem) {
			notificationSeenItems.set(`${sourceSeenItem.type}:${sourceSeenItem.id}`, sourceSeenItem);
		}
		for (const item of forumContext?.autoProfileSeenItems ?? []) {
			autoProfileSeenItems.set(item.id, item);
			notificationSeenItems.set(`${item.type}:${item.id}`, item);
		}
		const event = notification.event ?? legacyNotificationEvent(notification, forumContext);
		if (providerNotificationEventVisibleForBot(event, botId)) {
			messages.push(event);
			notificationSeenItemsById[event.id] = [...notificationSeenItems.values()];
		}
	}
	const spotlightContexts: SpotlightSyntheticContext[] = [];
	const manualInjections: string[] = [];
	for (const injection of injections) {
		const spotlightContext = parseSpotlightSyntheticContext(injection);
		if (spotlightContext) {
			spotlightContexts.push(spotlightContext);
		} else {
			manualInjections.push(injection);
		}
	}
	return {
		input: {
			notifications: messages,
			injections: manualInjections,
			spotlightContexts,
			ping: notifications.length === 0 && injections.length === 0,
			...(toolUseReminder ? { toolUseReminder } : {}),
		},
		autoProfileSeenItems: [...autoProfileSeenItems.values()],
		notificationSeenItemsById,
	};
}

function spotlightActionScopeFromContexts(contexts: SpotlightSyntheticContext[]): SpotlightActionScope | undefined {
	const commentIds = new Set<string>();
	const authorBotIds = new Set<string>();
	const authorHandles = new Set<string>();
	for (const context of contexts) {
		for (const item of context.content) {
			commentIds.add(item.id);
			if (item.commentId) {
				commentIds.add(item.commentId);
			}
			authorBotIds.add(item.authorBotId);
			const handle = spotlightScopeHandle(item.authorHandle);
			if (handle) {
				authorHandles.add(handle);
			}
		}
	}
	if (commentIds.size === 0 && authorBotIds.size === 0 && authorHandles.size === 0) {
		return undefined;
	}
	return { commentIds, authorBotIds, authorHandles };
}

function spotlightScopeHandle(value: string | undefined): string | undefined {
	const stripped = value?.trim().replace(/^u\//i, '');
	return stripped ? normalizeHandleText(stripped) : undefined;
}

function spotlightActionScopeIncludesComment(scope: SpotlightActionScope | undefined, commentId: string | undefined): boolean {
	return Boolean(scope && commentId && scope.commentIds.has(commentId));
}

function spotlightActionScopeIncludesAuthor(
	scope: SpotlightActionScope | undefined,
	author: { id?: string; handle?: string; username?: string },
): boolean {
	if (!scope) {
		return false;
	}
	if (author.id && scope.authorBotIds.has(author.id)) {
		return true;
	}
	const handle = spotlightScopeHandle(author.handle ?? author.username);
	return Boolean(handle && scope.authorHandles.has(handle));
}

function spotlightMutationScope(spotlightScope: SpotlightActionScope | undefined, totalTargets: number, relatedTargets: number): SpotlightMutationScope {
	if (!spotlightScope || totalTargets <= 0) {
		return { related: false, unrelated: false };
	}
	return {
		related: relatedTargets > 0,
		unrelated: relatedTargets < totalTargets,
	};
}

function spotlightMutationScopeForComment(
	spotlightScope: SpotlightActionScope | undefined,
	commentId: string | undefined,
): SpotlightMutationScope {
	return spotlightMutationScope(spotlightScope, commentId ? 1 : 0, spotlightActionScopeIncludesComment(spotlightScope, commentId) ? 1 : 0);
}

function spotlightMutationScopeForVotes(
	spotlightScope: SpotlightActionScope | undefined,
	votes: VoteToolTarget[],
): SpotlightMutationScope {
	const relatedTargets = votes.filter((vote) => spotlightActionScopeIncludesComment(spotlightScope, vote.commentId)).length;
	return spotlightMutationScope(spotlightScope, votes.length, relatedTargets);
}

function spotlightMutationScopeForCreateThread(
	spotlightScope: SpotlightActionScope | undefined,
	personalBotId: string | undefined,
): SpotlightMutationScope {
	const related = Boolean(personalBotId && spotlightScope?.authorBotIds.has(personalBotId));
	return spotlightMutationScope(spotlightScope, spotlightScope ? 1 : 0, related ? 1 : 0);
}

function providerNotificationEventVisibleForBot(event: NotificationEvent, botId: string): boolean {
	if (event.type !== 'profile_followed' && event.type !== 'profile_unfollowed') {
		return true;
	}
	const deliveryReasons = event.deliveryReasons ?? [];
	if (deliveryReasons.some((reason) => reason !== 'followed_profile_activity')) {
		return true;
	}
	const target = runtimeRecord(event.target);
	const targetProfile = runtimeRecord(event.targetProfile);
	return stringValue(target.id) === botId || stringValue(targetProfile.id) === botId;
}

function legacyNotificationEvent(notification: NotificationDocument, context: ForumContextResult | null): NotificationEvent {
	const content = context?.content ?? [];
	const rootCommentItem = content.find((item) => item.threadId === context?.threadId && !item.parentCommentId);
	const commentItem = context?.commentId ? content.find((item) => item.id === context.commentId) : undefined;
	const actorItem = commentItem ?? rootCommentItem;
	return {
		id: notification.id,
		type: legacyNotificationEventType(notification.notificationType),
		createdAt: notification.createdAt,
		deliveryReasons: [legacyNotificationDeliveryReason(notification.notificationType)],
		message: notification.message,
		...(actorItem ? { actor: notificationProfileRefFromReadContent(actorItem) } : {}),
		...(notification.sourceObjectId ? { sourceObjectId: notification.sourceObjectId } : {}),
		...(context
			? {
					world: {
						id: context.worldId,
						handle: `w/${context.worldHandle}`,
					},
					forum: {
						id: context.forumId,
						handle: `f/${context.forumHandle}`,
					},
					thread: {
						id: context.threadId,
						title: context.title,
						...(rootCommentItem
							? {
									author: notificationProfileRefFromReadContent(rootCommentItem),
									text: rootCommentItem.body,
								}
							: {}),
					},
				}
			: {}),
		...(commentItem
			? {
					comment: {
						id: commentItem.id,
						threadId: commentItem.threadId,
						...(commentItem.parentCommentId ? { parentCommentId: commentItem.parentCommentId } : {}),
						author: notificationProfileRefFromReadContent(commentItem),
						text: commentItem.body,
					},
				}
			: {}),
	};
}

function legacyNotificationEventType(type: NotificationDocument['notificationType']): NotificationEvent['type'] {
	switch (type) {
		case 'reply':
		case 'mention':
			return 'comment_created';
		case 'personal_forum_post':
			return 'thread_created';
		case 'follow':
			return 'profile_followed';
		case 'vote':
			return 'vote_cast';
		case 'bootstrap':
			return 'bootstrap';
		case 'followed_activity':
		case 'interest':
		case 'system':
			return 'system';
	}
}

function legacyNotificationDeliveryReason(type: NotificationDocument['notificationType']): NotificationEvent['deliveryReasons'][number] {
	switch (type) {
		case 'reply':
			return 'direct_reply';
		case 'mention':
			return 'mention';
		case 'personal_forum_post':
			return 'personal_forum_post';
		case 'follow':
			return 'profile_followed_you';
		case 'vote':
			return 'vote_on_your_content';
		case 'followed_activity':
			return 'followed_profile_activity';
		case 'bootstrap':
			return 'bootstrap';
		case 'interest':
		case 'system':
			return 'system';
	}
}

function notificationProfileRefFromReadContent(item: SpotlightIncludedContent): NonNullable<NotificationEvent['actor']> {
	return {
		id: item.authorBotId,
		username: `u/${item.authorHandle}`,
		displayName: item.authorDisplayName,
		...(item.authorShortBio ? { shortBio: item.authorShortBio } : {}),
	};
}

function parseSpotlightSyntheticContext(text: string): SpotlightSyntheticContext | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const record = runtimeRecord(parsed);
	if (record.kind !== 'spotlight_context' || !Array.isArray(record.content)) {
		return null;
	}
	const world = runtimeRecord(record.world);
	const forum = runtimeRecord(record.forum);
	const worldId = stringValue(world.id);
	const worldHandle = stringValue(world.handle);
	const forumId = stringValue(forum.id);
	const forumHandle = stringValue(forum.handle);
	const targetType = record.targetType === 'comments' ? 'comments' : record.targetType === 'threads' ? 'threads' : null;
	if (!worldId || !worldHandle || !forumId || !forumHandle || !targetType) {
		return null;
	}
	return {
		kind: 'spotlight_context',
		world: {
			id: worldId,
			handle: worldHandle,
			...(stringValue(world.name) ? { name: localizedTextValue(world.name) } : {}),
		},
		forum: {
			id: forumId,
			handle: forumHandle,
			...(stringValue(forum.description) ? { description: localizedTextValue(forum.description) } : {}),
		},
		targetType,
		...(stringValue(record.focus) ? { focus: stringValue(record.focus)! } : {}),
		threads: Array.isArray(record.threads)
			? record.threads
					.map(runtimeRecord)
					.map((thread) => ({
						id: stringValue(thread.id) ?? stringValue(thread.threadId) ?? '',
						threadId: stringValue(thread.threadId) ?? stringValue(thread.id) ?? '',
						title: localizedTextValue(thread.title, 'untitled'),
						rootCommentId: stringValue(thread.rootCommentId) ?? '',
					}))
					.filter((thread) => thread.id && thread.threadId && thread.rootCommentId)
			: undefined,
		content: record.content
			.map(runtimeRecord)
			.map(spotlightIncludedContentFromRecord)
			.filter((item): item is SpotlightIncludedContent => Boolean(item)),
	};
}

function spotlightIncludedContentFromRecord(record: Record<string, unknown>): SpotlightIncludedContent | null {
	const type = record.type === 'comment' || record.type === 'thread' ? 'comment' : null;
	const id = stringValue(record.id);
	const threadId = stringValue(record.threadId);
	const authorBotId = stringValue(record.authorBotId);
	const authorHandle = stringValue(record.authorHandle);
	const authorDisplayName = localizedTextValue(record.authorDisplayName);
	const body = localizedTextValue(record.body);
	const createdAt = stringValue(record.createdAt);
	if (!type || !id || !threadId || !authorBotId || !authorHandle || !authorDisplayName.text || !body.text || !createdAt) {
		return null;
	}
	return {
		type,
		id,
		threadId,
		...(stringValue(record.commentId) ? { commentId: stringValue(record.commentId)! } : {}),
		...(stringValue(record.parentCommentId) ? { parentCommentId: stringValue(record.parentCommentId)! } : {}),
		authorBotId,
		authorHandle,
		authorDisplayName,
		...(stringValue(record.authorShortBio) ? { authorShortBio: localizedTextValue(record.authorShortBio) } : {}),
		...(typeof record.authorFollowing === 'boolean' ? { authorFollowing: record.authorFollowing } : {}),
		...(stringValue(record.title) ? { title: localizedTextValue(record.title) } : {}),
		body,
		createdAt,
		...(record['My focus is on this comment'] === true || record.target === true ? { 'My focus is on this comment': true as const } : {}),
		...(record.ancestorOnly === true ? { ancestorOnly: true } : {}),
		...(record.alreadySeen === true ? { alreadySeen: true } : {}),
	};
}

type SyntheticReadToolChain = {
	toolName: 'read_thread_by_id' | 'read_comment_by_id';
	args: Record<string, unknown>;
	context: SpotlightSyntheticContext;
	targetCommentId?: string;
	targetThreadId?: string;
};

function syntheticToolCall(runId: string, name: string, index: number, args: Record<string, unknown>): ToolCall {
	return {
		id: syntheticToolCallId(runId, index),
		type: 'function',
		function: {
			name,
			arguments: JSON.stringify(args),
		},
	};
}

function syntheticToolCallId(runId: string, index: number): string {
	return `synthetic_${runId}_${index}`;
}

function referencedProfileUsernamesFromNotifications(
	notifications: LoopNotification[],
	selfHandle: string,
	existingProfileUsernames: ReadonlySet<string>,
): string[] {
	const handles = new Set<string>();
	for (const notification of notifications) {
		collectProfileHandlesFromUsernames(notification, handles);
	}
	return profileUsernamesForSyntheticCall(handles, selfHandle, existingProfileUsernames);
}

function referencedProfileUsernamesFromSpotlight(
	contexts: SpotlightSyntheticContext[],
	selfHandle: string,
	existingProfileUsernames: ReadonlySet<string>,
): string[] {
	const handles = new Set<string>();
	for (const context of contexts) {
		for (const item of context.content) {
			handles.add(normalizeHandleText(item.authorHandle));
		}
	}
	return profileUsernamesForSyntheticCall(handles, selfHandle, existingProfileUsernames);
}

function profileUsernamesForSyntheticCall(
	handles: ReadonlySet<string>,
	selfHandle: string,
	existingProfileUsernames: ReadonlySet<string>,
): string[] {
	const self = normalizeHandleText(selfHandle);
	return [...handles]
		.filter((handle) => handle !== self && !existingProfileUsernames.has(handle))
		.sort((left, right) => left.localeCompare(right))
		.map((handle) => `u/${handle}`);
}

function collectProfileHandlesFromUsernames(value: unknown, handles: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectProfileHandlesFromUsernames(item, handles);
		}
		return;
	}
	if (!value || typeof value !== 'object') {
		return;
	}
	const record = value as Record<string, unknown>;
	const username = profileHandleFromUsername(record.username);
	if (username) {
		handles.add(username);
	}
	for (const item of Object.values(record)) {
		collectProfileHandlesFromUsernames(item, handles);
	}
}

function profileUsernamesFromToolResultContent(content: string | null | undefined): string[] {
	if (!content) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	const record = runtimeRecord(parsed);
	const handles = new Set<string>();
	if (Array.isArray(record.profiles)) {
		for (const profile of record.profiles) {
			const handle = profileHandleFromProfileRecord(runtimeRecord(profile));
			if (handle) {
				handles.add(handle);
			}
		}
	}
	const rootHandle = profileHandleFromProfileRecord(record);
	if (rootHandle) {
		handles.add(rootHandle);
	}
	return [...handles];
}

function profileHandleFromProfileRecord(record: Record<string, unknown>): string | null {
	if (!('displayName' in record) || !('shortBio' in record)) {
		return null;
	}
	return profileHandleFromUsername(record.username);
}

function profileHandleFromUsername(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}
	let text = value.trim();
	while (text.toLowerCase().startsWith('u/')) {
		text = text.slice(2).trim();
	}
	try {
		return normalizeHandle(text);
	} catch {
		return null;
	}
}

function spotlightSyntheticToolChains(context: SpotlightSyntheticContext): SyntheticReadToolChain[] {
	if (context.targetType === 'comments') {
		return context.content
			.filter((item) => item.type === 'comment' && (item['My focus is on this comment'] || item.target))
			.map((item) => ({
				toolName: 'read_comment_by_id',
				args: { commentId: item.id },
				context,
				targetCommentId: item.id,
			}));
	}
	const threadIds = new Set((context.threads ?? []).map((thread) => thread.threadId));
	for (const item of context.content) {
		threadIds.add(item.threadId);
	}
	return [...threadIds].map((threadId) => ({
		toolName: 'read_thread_by_id',
		args: { threadId },
		context,
		targetThreadId: threadId,
	}));
}

function spotlightFocusAssistantContent(contexts: readonly SpotlightSyntheticContext[]): string | null {
	const focuses = uniqueStrings(
		contexts
			.map((context) => context.focus?.trim())
			.filter((focus): focus is string => Boolean(focus)),
	);
	if (focuses.length === 0) {
		return null;
	}
	if (focuses.length === 1) {
		return `My focus: ${truncateForContext(focuses[0]!, 700)}`;
	}
	return [
		'My focus:',
		...focuses.map((focus) => `- ${truncateForContext(focus, 700)}`),
	].join('\n');
}

function spotlightReadResult(
	context: SpotlightSyntheticContext,
	operation: 'read_thread_by_id' | 'read_comment_by_id',
	scope: ProviderContextContentScope,
	tokenBudget: number,
	targetCommentId?: string,
	targetThreadId?: string,
): Record<string, unknown> {
	const threadId =
		targetThreadId ?? context.content.find((item) => item.id === targetCommentId)?.threadId ?? context.content[0]?.threadId ?? 'unknown';
	const content = targetCommentId
		? spotlightCommentChainContent(context.content, threadId, targetCommentId)
		: context.content.filter((item) => item.threadId === threadId);
	const commentTree = readContentItemTree(content.map((item) => spotlightReadContentItem(context, item)));
	const pruned = pruneReadContentTreeForProviderBudget(commentTree, tokenBudget);
	return providerReadResult(
		{
			operation,
			context: readResultContext(operation, pruned, tokenBudget),
			thread: spotlightThreadSummaryRecord(context, threadId, content),
			...(targetCommentId ? { targetCommentId } : {}),
			content: pruned.content,
		},
		scope,
	);
}

function spotlightCommentChainContent(
	content: SpotlightIncludedContent[],
	threadId: string,
	targetCommentId: string,
): SpotlightIncludedContent[] {
	const byId = new Map(content.filter((item) => item.threadId === threadId).map((item) => [item.id, item]));
	const comments: SpotlightIncludedContent[] = [];
	let current = byId.get(targetCommentId);
	while (current && current.type === 'comment') {
		comments.unshift(current);
		current = current.parentCommentId ? byId.get(current.parentCommentId) : undefined;
	}
	return comments;
}

function spotlightReadContentItem(context: SpotlightSyntheticContext, item: SpotlightIncludedContent): ReadContentItem {
	return {
		type: 'comment',
		id: item.id,
		threadId: item.threadId,
		...(item.commentId ? { commentId: item.commentId } : {}),
		...(item.parentCommentId ? { parentCommentId: item.parentCommentId } : {}),
		worldId: context.world.id,
		worldHandle: stripTypedHandle(context.world.handle, 'w'),
		forumId: context.forum.id,
		forumHandle: stripTypedHandle(context.forum.handle, 'f'),
		authorBotId: item.authorBotId,
		authorHandle: item.authorHandle,
		authorDisplayName: item.authorDisplayName,
		...(item.authorShortBio ? { authorShortBio: item.authorShortBio } : {}),
		...(typeof item.authorFollowing === 'boolean' ? { authorFollowing: item.authorFollowing } : {}),
		...(item.title ? { title: item.title } : {}),
		body: item.body,
		createdAt: item.createdAt,
		...(item['My focus is on this comment'] === true || item.target === true ? { 'My focus is on this comment': true as const } : {}),
		...(item.ancestorOnly ? { ancestorOnly: true } : {}),
	};
}

function spotlightThreadSummaryRecord(
	context: SpotlightSyntheticContext,
	threadId: string,
	content: SpotlightIncludedContent[],
): Record<string, unknown> {
	const thread = (context.threads ?? []).find((item) => item.threadId === threadId || item.id === threadId);
	const root = content.find((item) => item.id === thread?.rootCommentId) ?? content.find((item) => !item.parentCommentId);
	const activityTimes = content
		.map((item) => item.createdAt)
		.filter(Boolean)
		.sort();
	const lastActivityAt = activityTimes[activityTimes.length - 1];
	return {
		id: threadId,
		threadId,
		rootCommentId: thread?.rootCommentId,
		worldHandle: stripTypedHandle(context.world.handle, 'w'),
		forumHandle: stripTypedHandle(context.forum.handle, 'f'),
		title: thread?.title ?? root?.title ?? 'untitled',
		authorBotId: root?.authorBotId,
		authorHandle: root?.authorHandle,
		authorDisplayName: root?.authorDisplayName,
		authorShortBio: root?.authorShortBio,
		authorFollowing: root?.authorFollowing,
		commentCount: content.filter((item) => item.type === 'comment').length,
		lastActivityAt,
	};
}

function stripTypedHandle(value: string, prefix: 'f' | 'u' | 'w'): string {
	const marker = `${prefix}/`;
	return value.toLowerCase().startsWith(marker) ? value.slice(marker.length) : value;
}

type TranslationInput = {
	text: string;
};

type AvatarGenerationInput = {
	prompt: string;
	includeCurrentAvatar: boolean;
	settings?: unknown;
};

type AvatarPromptInput = {
	mode: 'persona' | 'description' | 'members' | 'current_avatar';
	prefill?: string;
	imageSettings?: unknown;
	promptSettings?: unknown;
};

type AvatarGenerationDisplayMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

type AvatarGenerationStreamSink = {
	messages: (messages: AvatarGenerationDisplayMessage[]) => void | Promise<void>;
	assistantDelta: (text: string) => void | Promise<void>;
	assistantImage: (count: number) => void | Promise<void>;
};

function parseTranslationInput(input: unknown): TranslationInput {
	const record = runtimeRecord(input);
	return {
		text: requiredText(record.text, 'Translation text', 16_000),
	};
}

function parseAvatarGenerationInput(input: unknown): AvatarGenerationInput {
	const record = runtimeRecord(input);
	const prompt = typeof record.prompt === 'string' ? record.prompt : '';
	const includeCurrentAvatar = record.includeCurrentAvatar === true;
	if (prompt.length > 8_000) {
		throw new InputError('Avatar prompt must be 8000 characters or fewer.');
	}
	if (!prompt.trim() && !includeCurrentAvatar) {
		throw new InputError('Avatar prompt is required unless the current avatar is included.');
	}
	return {
		prompt,
		includeCurrentAvatar,
		...(record.settings !== undefined ? { settings: record.settings } : {}),
	};
}

export function parseImageGenerationSettingsOverride(
	value: unknown,
	language: LanguageTag | null,
): BotInferenceSettings['imageGeneration'] | undefined {
	if (value === undefined) {
		return undefined;
	}
	return mergeInferenceSettings(
		undefined,
		parseUpdateBotInput({ language, inferenceSettings: { imageGeneration: value } }).inferenceSettings,
	).imageGeneration;
}

function parseInferenceSettingsOverride(value: unknown, language: LanguageTag | null): BotInferenceSettingsInput | undefined {
	if (value === undefined) {
		return undefined;
	}
	return parseUpdateBotInput({ language, inferenceSettings: value }).inferenceSettings;
}

function parseAvatarPromptInput(input: unknown): AvatarPromptInput {
	const record = runtimeRecord(input);
	const mode =
		record.mode === 'current_avatar' ? 'current_avatar'
		: record.mode === 'description' ? 'description'
		: record.mode === 'members' ? 'members'
		: 'persona';
	const prefill = typeof record.prefill === 'string' ? record.prefill : '';
	if (prefill.length > 8_000) {
		throw new InputError('Avatar prompt prefill must be 8000 characters or fewer.');
	}
	const imageSettings = mode === 'current_avatar' ? record.settings : undefined;
	const promptSettings = mode === 'description' || mode === 'members' ? record.settings : undefined;
	if (mode === 'current_avatar' && imageSettings === undefined) {
		throw new InputError('Choose an image generation model before filling from the current avatar.');
	}
	return {
		mode,
		...(prefill.trim() ? { prefill } : {}),
		...(imageSettings !== undefined ? { imageSettings } : {}),
		...(promptSettings !== undefined ? { promptSettings } : {}),
	};
}

async function readOptionalJsonBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get('content-type') ?? '';
	if (!contentType.includes('application/json')) {
		return {};
	}
	const text = await request.text();
	if (!text.trim()) {
		return {};
	}
	return JSON.parse(text) as unknown;
}

function parseAvatarCandidate(value: unknown): AvatarImage {
	const record = runtimeRecord(value);
	const key = requiredText(record.key, 'Avatar candidate key', 500);
	if (!key.includes('/avatar-candidates/')) {
		throw new InputError('Avatar candidate key is invalid.');
	}
	const url = requiredText(record.url, 'Avatar candidate URL', 1_000);
	const contentType = requiredText(record.contentType, 'Avatar candidate content type', 80);
	const updatedAt = requiredText(record.updatedAt, 'Avatar candidate timestamp', 80);
	if (!isAvatarContentType(contentType)) {
		throw new InputError('Avatar candidate content type is invalid.');
	}
	const sourceRecord = runtimeRecord(record.source);
	const generatedCost = numberValue(sourceRecord.cost);
	const generatedSource =
		sourceRecord.type === 'generated'
			? {
					type: 'generated' as const,
					model: requiredText(sourceRecord.model, 'Avatar generation model', 160),
					generatedAt: requiredText(sourceRecord.generatedAt, 'Avatar generation timestamp', 80),
					...(generatedCost !== undefined ? { cost: generatedCost } : {}),
					...(typeof sourceRecord.prompt === 'string' && sourceRecord.prompt.trim() ? { prompt: sourceRecord.prompt } : {}),
				}
			: undefined;
	return {
		key,
		url,
		contentType,
		updatedAt,
		...(typeof record.byteLength === 'number' ? { byteLength: record.byteLength } : {}),
		...(typeof record.width === 'number' ? { width: record.width } : {}),
		...(typeof record.height === 'number' ? { height: record.height } : {}),
		...(generatedSource ? { source: generatedSource } : {}),
	};
}

async function translateForUser(
	env: Pick<Env, 'BICKR_KV' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	userId: string,
	text: string,
): Promise<string> {
	const user = await userById(env.BICKR_KV, userId);
	const settings = effectiveProviderSettingsForTranslation(user, env);
	if (!settings) {
		throw new InputError('Enable inline translations in profile inference settings before translating text.');
	}
	return fetchProviderTranslation(settings, text);
}

async function fetchProviderTranslation(settings: TranslationProviderSettings, text: string): Promise<string> {
	const endpoint = providerChatCompletionsUrl(settings.baseUrl);
	const signal = new AbortController().signal;
	const headers: Record<string, string> = {
		'content-type': 'application/json',
	};
	if (settings.apiKey) {
		headers.authorization = `Bearer ${settings.apiKey}`;
	}
	let requestMessages = providerTranslationRequest(settings, text).messages;
	let lastValidationError: ProviderStructuredOutputValidationError | null = null;
	for (let schemaAttempt = 0; schemaAttempt <= providerStructuredOutputRepairAttempts; schemaAttempt += 1) {
		const requestBody = {
			...providerTranslationRequest(settings, text),
			messages: sanitizeProviderMessagesForRequest(requestMessages),
		};
		const response = await providerFetchWithHeaderTimeout(
			endpoint,
			{
				method: 'POST',
				headers,
				body: JSON.stringify(requestBody),
			},
			signal,
			providerRequestTimeoutMs,
		);
		if (!response.ok) {
			const bodyText = await readProviderErrorBody(response, signal);
			throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
		}
		const rawResponse = await readJsonResponseText(
			response,
			providerResponseBodyMaxBytes,
			signal,
			providerBodyReadTimeoutMs,
			() => new ProviderResponseBodyTimeoutError(providerBodyReadTimeoutMs),
		);
		let payload: ProviderCompactionResponsePayload;
		try {
			payload = JSON.parse(rawResponse) as ProviderCompactionResponsePayload;
		} catch {
			throw new ProviderRequestError(502, settings.model, endpoint, 'Provider translation response was not valid JSON.', { rawResponse });
		}
		try {
			return providerTranslationFromToolMessage(payload.choices?.[0]?.message, rawResponse);
		} catch (error) {
			if (!(error instanceof ProviderStructuredOutputValidationError)) {
				throw error;
			}
			lastValidationError = error;
			if (schemaAttempt >= providerStructuredOutputRepairAttempts) {
				throw new ProviderRequestError(502, settings.model, endpoint, error.message, { rawResponse: error.rawResponse });
			}
			requestMessages = [...requestMessages, ...structuredOutputRepairMessages(error)];
		}
	}
	throw new ProviderRequestError(
		502,
		settings.model,
		endpoint,
		lastValidationError?.message ?? 'Provider translation response did not include translation.',
	);
}

async function generateAvatarForBot(
	env: Pick<
		Env,
		'BICKR_KV' | 'BICKR_D1' | 'BICKR_R2' | 'BICKR_R2_PUBLIC_BASE_URL' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'
	>,
	userId: string,
	botId: string,
	input: AvatarGenerationInput,
	options: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink } = {},
): Promise<AvatarImage> {
	const bot = await botById(env.BICKR_KV, env.BICKR_D1, botId);
	if (bot.ownerUserId !== userId) {
		throw new RepositoryError('forbidden', "Only this participant's owner can generate an avatar.", 403);
	}
	const owner = await userById(env.BICKR_KV, userId);
	if (input.includeCurrentAvatar && !bot.avatar?.url) {
		throw new InputError('The current avatar cannot be included because this participant does not have one.');
	}
	const settingsOverride = parseImageGenerationSettingsOverride(input.settings, effectiveAvatarSettingsLanguageForBot(bot));
	const settings = effectiveProviderSettingsForImageGeneration(bot, owner, env, settingsOverride);
	if (!settings) {
		throw new InputError('Choose an image generation model before generating an avatar.');
	}
	const generatedImage = await fetchProviderAvatarImage(settings, {
		prompt: input.prompt,
		currentAvatarUrl: input.includeCurrentAvatar ? bot.avatar?.url : undefined,
	}, options);
	let validated: ReturnType<typeof validateAvatarDataUrl>;
	try {
		validated = validateAvatarDataUrl(generatedImage.dataUrl);
	} catch (error) {
		if (error instanceof InputError) {
			throw new ProviderRequestError(
				502,
				settings.model,
				providerChatCompletionsUrl(settings.baseUrl),
				`Provider returned an invalid generated avatar image. ${error.message}`,
			);
		}
		throw error;
	}
	return storeAvatarImage(requireAvatarBucket(env), {
		botId: bot.id,
		worldId: bot.homeWorldId,
		bytes: validated.bytes,
		contentType: validated.contentType,
		publicBaseUrl: normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL),
		source: {
			type: 'generated',
			model: settings.model,
			generatedAt: new Date().toISOString(),
			...(generatedImage.cost !== null ? { cost: generatedImage.cost } : {}),
			...(input.prompt.trim() ? { prompt: input.prompt } : {}),
		},
		kind: 'avatar-candidates',
	});
}

function streamAvatarGenerationForBot(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1' | 'BICKR_R2' | 'BICKR_R2_PUBLIC_BASE_URL' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	userId: string,
	botId: string,
	input: AvatarGenerationInput,
	requestSignal: AbortSignal,
): Response {
	const encoder = new TextEncoder();
	const abortController = new AbortController();
	const abortFromRequest = () => abortController.abort();
	if (requestSignal.aborted) {
		abortController.abort();
	} else {
		requestSignal.addEventListener('abort', abortFromRequest, { once: true });
	}
	let closed = false;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: unknown): void => {
				if (closed || abortController.signal.aborted) {
					return;
				}
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				} catch {
					closed = true;
					abortController.abort();
				}
			};
			try {
				const candidate = await generateAvatarForBot(env, userId, botId, input, {
					signal: abortController.signal,
					stream: {
						messages: (messages) => send({ type: 'messages', messages }),
						assistantDelta: (text) => send({ type: 'assistant_delta', text }),
						assistantImage: (count) => send({ type: 'assistant_image', count }),
					},
				});
				send({ type: 'done', candidate });
			} catch (error) {
				if (abortController.signal.aborted || error instanceof TickStoppedError || isAbortError(error)) {
					send({ type: 'aborted', message: 'Avatar generation aborted.' });
				} else {
					send({ type: 'error', message: avatarGenerationStreamErrorMessage(error) });
				}
			} finally {
				requestSignal.removeEventListener('abort', abortFromRequest);
				if (!closed) {
					try {
						closed = true;
						controller.close();
					} catch {
						// The client may already have disconnected.
					}
				}
			}
		},
		cancel() {
			closed = true;
			abortController.abort();
			requestSignal.removeEventListener('abort', abortFromRequest);
		},
	});
	return new Response(stream, {
		headers: {
			'cache-control': 'no-store',
			'content-type': 'text/event-stream; charset=utf-8',
			'x-accel-buffering': 'no',
		},
	});
}

function streamAvatarPromptForBot(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	userId: string,
	botId: string,
	input: AvatarPromptInput,
	requestSignal: AbortSignal,
): Response {
	const encoder = new TextEncoder();
	const abortController = new AbortController();
	const abortFromRequest = () => abortController.abort();
	if (requestSignal.aborted) {
		abortController.abort();
	} else {
		requestSignal.addEventListener('abort', abortFromRequest, { once: true });
	}
	let closed = false;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: unknown): void => {
				if (closed || abortController.signal.aborted) {
					return;
				}
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				} catch {
					closed = true;
					abortController.abort();
				}
			};
			try {
				const prompt = await prefillAvatarPromptForBot(env, userId, botId, input, {
					signal: abortController.signal,
					stream: {
						messages: (messages) => send({ type: 'messages', messages }),
						assistantDelta: (text) => send({ type: 'assistant_delta', text }),
						assistantImage: (count) => send({ type: 'assistant_image', count }),
					},
				});
				send({ type: 'done', prompt });
			} catch (error) {
				if (abortController.signal.aborted || error instanceof TickStoppedError || isAbortError(error)) {
					send({ type: 'aborted', message: 'Prompt fill aborted.' });
				} else {
					send({ type: 'error', message: avatarGenerationStreamErrorMessage(error) });
				}
			} finally {
				requestSignal.removeEventListener('abort', abortFromRequest);
				if (!closed) {
					try {
						closed = true;
						controller.close();
					} catch {
						// The client may already have disconnected.
					}
				}
			}
		},
		cancel() {
			closed = true;
			abortController.abort();
			requestSignal.removeEventListener('abort', abortFromRequest);
		},
	});
	return new Response(stream, {
		headers: {
			'cache-control': 'no-store',
			'content-type': 'text/event-stream; charset=utf-8',
			'x-accel-buffering': 'no',
		},
	});
}

function avatarGenerationStreamErrorMessage(error: unknown): string {
	if (error instanceof ProviderRequestError || error instanceof ProviderRequestTimeoutError || error instanceof ProviderResponseBodyTimeoutError) {
		return error.message;
	}
	if (error instanceof ResponseBodySizeLimitError || error instanceof InputError || error instanceof RepositoryError) {
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return 'Could not generate avatar.';
}

async function applyGeneratedAvatarForBot(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1' | 'BICKR_R2' | 'BICKR_R2_PUBLIC_BASE_URL'>,
	userId: string,
	botId: string,
	candidate: AvatarImage,
): Promise<BotSummary> {
	const bot = await botById(env.BICKR_KV, env.BICKR_D1, botId);
	if (bot.ownerUserId !== userId) {
		throw new RepositoryError('forbidden', "Only this participant's owner can update its avatar.", 403);
	}
	const avatar = await promoteAvatarCandidate(requireAvatarBucket(env), {
		botId: bot.id,
		worldId: bot.homeWorldId,
		candidate,
		publicBaseUrl: normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL),
		source: candidate.source,
	});
	const updated = await updateBotAvatar(env.BICKR_KV, env.BICKR_D1, bot.id, userId, avatar);
	await requireAvatarBucket(env)
		.delete(candidate.key)
		.catch(() => undefined);
	return updated;
}

async function generateAvatarForUser(
	env: Pick<
		Env,
		'BICKR_KV' | 'BICKR_D1' | 'BICKR_R2' | 'BICKR_R2_PUBLIC_BASE_URL' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'
	>,
	userId: string,
	input: AvatarGenerationInput,
	options: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink } = {},
): Promise<AvatarImage> {
	const user = await userById(env.BICKR_KV, userId);
	if (input.includeCurrentAvatar && !user.avatar?.url) {
		throw new InputError('The current avatar cannot be included because your profile does not have one.');
	}
	const settingsOverride = parseImageGenerationSettingsOverride(input.settings, effectiveAvatarSettingsLanguageForUser(user));
	const settings = effectiveProviderSettingsForUserImageGeneration(user, env, settingsOverride);
	if (!settings) {
		throw new InputError('Choose an image generation model before generating an avatar.');
	}
	const generatedImage = await fetchProviderAvatarImage(settings, {
		prompt: input.prompt,
		currentAvatarUrl: input.includeCurrentAvatar ? user.avatar?.url : undefined,
	}, options);
	let validated: ReturnType<typeof validateAvatarDataUrl>;
	try {
		validated = validateAvatarDataUrl(generatedImage.dataUrl);
	} catch (error) {
		if (error instanceof InputError) {
			throw new ProviderRequestError(
				502,
				settings.model,
				providerChatCompletionsUrl(settings.baseUrl),
				`Provider returned an invalid generated avatar image. ${error.message}`,
			);
		}
		throw error;
	}
	return storeAvatarImage(requireAvatarBucket(env), {
		target: 'user',
		userId: user.id,
		bytes: validated.bytes,
		contentType: validated.contentType,
		publicBaseUrl: normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL),
		source: {
			type: 'generated',
			model: settings.model,
			generatedAt: new Date().toISOString(),
			...(generatedImage.cost !== null ? { cost: generatedImage.cost } : {}),
			...(input.prompt.trim() ? { prompt: input.prompt } : {}),
		},
		kind: 'avatar-candidates',
	});
}

function streamAvatarGenerationForUser(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1' | 'BICKR_R2' | 'BICKR_R2_PUBLIC_BASE_URL' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	userId: string,
	input: AvatarGenerationInput,
	requestSignal: AbortSignal,
): Response {
	return streamAvatarOperation(requestSignal, 'Avatar generation aborted.', async (signal, stream) => {
		const candidate = await generateAvatarForUser(env, userId, input, { signal, stream });
		return { type: 'done', candidate };
	});
}

async function prefillAvatarPromptForUser(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	userId: string,
	input: AvatarPromptInput,
	options: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink } = {},
): Promise<string> {
	const user = await userById(env.BICKR_KV, userId);
	if (input.mode !== 'current_avatar') {
		throw new InputError('Human avatar prompt fill only supports the current avatar.');
	}
	if (!user.avatar?.url) {
		throw new InputError('The current avatar cannot be described because your profile does not have one.');
	}
	const imageSettingsOverride = parseImageGenerationSettingsOverride(input.imageSettings, effectiveAvatarSettingsLanguageForUser(user));
	const settings = effectiveProviderSettingsForUserImageGeneration(user, env, imageSettingsOverride);
	if (!settings) {
		throw new InputError('Choose an image generation model before filling from the current avatar.');
	}
	return fetchProviderCurrentAvatarDescription(settings, user.avatar.url, options);
}

function streamAvatarPromptForUser(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	userId: string,
	input: AvatarPromptInput,
	requestSignal: AbortSignal,
): Response {
	return streamAvatarOperation(requestSignal, 'Prompt fill aborted.', async (signal, stream) => {
		const prompt = await prefillAvatarPromptForUser(env, userId, input, { signal, stream });
		return { type: 'done', prompt };
	});
}

async function applyGeneratedAvatarForUser(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1' | 'BICKR_R2' | 'BICKR_R2_PUBLIC_BASE_URL'>,
	userId: string,
	candidate: AvatarImage,
) {
	const user = await userById(env.BICKR_KV, userId);
	const expectedPrefix = `users/${encodeURIComponent(user.id)}/avatar-candidates/`;
	if (!candidate.key.startsWith(expectedPrefix)) {
		throw new InputError('Avatar candidate key is invalid for this profile.');
	}
	const avatar = await promoteAvatarCandidate(requireAvatarBucket(env), {
		target: 'user',
		userId: user.id,
		candidate,
		publicBaseUrl: normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL),
		source: candidate.source,
	});
	const profile = await updateUserAvatar(env.BICKR_KV, env.BICKR_D1, user.id, avatar);
	await requireAvatarBucket(env)
		.delete(candidate.key)
		.catch(() => undefined);
	return profile;
}

async function worldDocumentForAvatar(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1'>,
	worldHandle: string,
	userId: string,
	action: 'generate' | 'prepare' | 'update',
): Promise<WorldDocument> {
	const worldRef = await worldByHandle(env.BICKR_D1, worldHandle);
	const world = await readJson<WorldDocument>(env.BICKR_KV, kvKeys.world(worldRef.id));
	if (!world || world.deletedAt) {
		throw new RepositoryError('not_found', 'World not found.', 404);
	}
	if (world.createdByUserId !== userId) {
		const verb = action === 'generate' ? 'generate an avatar for' : action === 'prepare' ? 'prepare an avatar prompt for' : 'update';
		throw new RepositoryError('forbidden', `Only this world's owner can ${verb} it.`, 403);
	}
	return { ...world, prompt: world.prompt ?? '' };
}

async function worldAvatarPromptSettings(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	userId: string,
	worldHandle: string,
): Promise<BotInferenceSettings> {
	await worldDocumentForAvatar(env, worldHandle, userId, 'prepare');
	const owner = await userById(env.BICKR_KV, userId);
	return publicPromptProviderSettings(effectiveProviderSettingsForWorldPrompt(owner, env));
}

async function generateAvatarForWorld(
	env: Pick<
		Env,
		'BICKR_KV' | 'BICKR_D1' | 'BICKR_R2' | 'BICKR_R2_PUBLIC_BASE_URL' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'
	>,
	userId: string,
	worldHandle: string,
	input: AvatarGenerationInput,
	options: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink } = {},
): Promise<AvatarImage> {
	const world = await worldDocumentForAvatar(env, worldHandle, userId, 'generate');
	const owner = await userById(env.BICKR_KV, userId);
	if (input.includeCurrentAvatar && !world.avatar?.url) {
		throw new InputError('The current avatar cannot be included because this world does not have one.');
	}
	const settingsOverride = parseImageGenerationSettingsOverride(input.settings, effectiveAvatarSettingsLanguageForWorld(world));
	const settings = effectiveProviderSettingsForWorldImageGeneration(world, owner, env, settingsOverride);
	if (!settings) {
		throw new InputError('Choose an image generation model before generating an avatar.');
	}
	const generatedImage = await fetchProviderAvatarImage(settings, {
		prompt: input.prompt,
		currentAvatarUrl: input.includeCurrentAvatar ? world.avatar?.url : undefined,
	}, { ...options, target: 'world' });
	let validated: ReturnType<typeof validateAvatarDataUrl>;
	try {
		validated = validateAvatarDataUrl(generatedImage.dataUrl);
	} catch (error) {
		if (error instanceof InputError) {
			throw new ProviderRequestError(
				502,
				settings.model,
				providerChatCompletionsUrl(settings.baseUrl),
				`Provider returned an invalid generated avatar image. ${error.message}`,
			);
		}
		throw error;
	}
	return storeAvatarImage(requireAvatarBucket(env), {
		target: 'world',
		worldId: world.id,
		bytes: validated.bytes,
		contentType: validated.contentType,
		publicBaseUrl: normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL),
		source: {
			type: 'generated',
			model: settings.model,
			generatedAt: new Date().toISOString(),
			...(generatedImage.cost !== null ? { cost: generatedImage.cost } : {}),
			...(input.prompt.trim() ? { prompt: input.prompt } : {}),
		},
		kind: 'avatar-candidates',
	});
}

function streamAvatarGenerationForWorld(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1' | 'BICKR_R2' | 'BICKR_R2_PUBLIC_BASE_URL' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	userId: string,
	worldHandle: string,
	input: AvatarGenerationInput,
	requestSignal: AbortSignal,
): Response {
	return streamAvatarOperation(requestSignal, 'Avatar generation aborted.', async (signal, stream) => {
		const candidate = await generateAvatarForWorld(env, userId, worldHandle, input, { signal, stream });
		return { type: 'done', candidate };
	});
}

async function prefillAvatarPromptForWorld(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	userId: string,
	worldHandle: string,
	input: AvatarPromptInput = { mode: 'description' },
	options: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink } = {},
): Promise<string> {
	const world = await worldDocumentForAvatar(env, worldHandle, userId, 'prepare');
	const owner = await userById(env.BICKR_KV, userId);
	if (input.mode === 'current_avatar') {
		if (!world.avatar?.url) {
			throw new InputError('The current avatar cannot be described because this world does not have one.');
		}
		const imageSettingsOverride = parseImageGenerationSettingsOverride(input.imageSettings, effectiveAvatarSettingsLanguageForWorld(world));
		const settings = effectiveProviderSettingsForWorldImageGeneration(world, owner, env, imageSettingsOverride);
		if (!settings) {
			throw new InputError('Choose an image generation model before filling from the current avatar.');
		}
		return fetchProviderCurrentAvatarDescription(settings, world.avatar.url, { ...options, target: 'world' });
	}
	if (input.mode === 'members') {
		const members = await listWorldBots(env.BICKR_KV, env.BICKR_D1, world.handle);
		const promptSettingsOverride = parseInferenceSettingsOverride(input.promptSettings, effectiveAvatarSettingsLanguageForWorld(world));
		return fetchProviderWorldAvatarMembersDescription(effectiveProviderSettingsForWorldPrompt(owner, env, promptSettingsOverride), world, members, {
			prefill: input.prefill,
			...options,
		});
	}
	const promptSettingsOverride = parseInferenceSettingsOverride(input.promptSettings, effectiveAvatarSettingsLanguageForWorld(world));
	return fetchProviderWorldAvatarDescription(effectiveProviderSettingsForWorldPrompt(owner, env, promptSettingsOverride), world, {
		prefill: input.prefill,
		...options,
	});
}

function streamAvatarPromptForWorld(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	userId: string,
	worldHandle: string,
	input: AvatarPromptInput,
	requestSignal: AbortSignal,
): Response {
	return streamAvatarOperation(requestSignal, 'Prompt fill aborted.', async (signal, stream) => {
		const prompt = await prefillAvatarPromptForWorld(env, userId, worldHandle, input, { signal, stream });
		return { type: 'done', prompt };
	});
}

function streamAvatarOperation(
	requestSignal: AbortSignal,
	abortMessage: string,
	run: (signal: AbortSignal, stream: AvatarGenerationStreamSink) => Promise<unknown>,
): Response {
	const encoder = new TextEncoder();
	const abortController = new AbortController();
	const abortFromRequest = () => abortController.abort();
	if (requestSignal.aborted) {
		abortController.abort();
	} else {
		requestSignal.addEventListener('abort', abortFromRequest, { once: true });
	}
	let closed = false;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: unknown): void => {
				if (closed || abortController.signal.aborted) {
					return;
				}
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				} catch {
					closed = true;
					abortController.abort();
				}
			};
			try {
				send(await run(abortController.signal, {
					messages: (messages) => send({ type: 'messages', messages }),
					assistantDelta: (text) => send({ type: 'assistant_delta', text }),
					assistantImage: (count) => send({ type: 'assistant_image', count }),
				}));
			} catch (error) {
				if (abortController.signal.aborted || error instanceof TickStoppedError || isAbortError(error)) {
					send({ type: 'aborted', message: abortMessage });
				} else {
					send({ type: 'error', message: avatarGenerationStreamErrorMessage(error) });
				}
			} finally {
				requestSignal.removeEventListener('abort', abortFromRequest);
				if (!closed) {
					try {
						closed = true;
						controller.close();
					} catch {
						// The client may already have disconnected.
					}
				}
			}
		},
		cancel() {
			closed = true;
			abortController.abort();
			requestSignal.removeEventListener('abort', abortFromRequest);
		},
	});
	return new Response(stream, {
		headers: {
			'cache-control': 'no-store',
			'content-type': 'text/event-stream; charset=utf-8',
			'x-accel-buffering': 'no',
		},
	});
}

async function applyGeneratedAvatarForWorld(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1' | 'BICKR_R2' | 'BICKR_R2_PUBLIC_BASE_URL'>,
	userId: string,
	worldHandle: string,
	candidate: AvatarImage,
) {
	const world = await worldDocumentForAvatar(env, worldHandle, userId, 'update');
	const avatar = await promoteAvatarCandidate(requireAvatarBucket(env), {
		target: 'world',
		worldId: world.id,
		candidate,
		publicBaseUrl: normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL),
		source: candidate.source,
	});
	const updated = await updateWorldAvatar(env.BICKR_KV, env.BICKR_D1, world.handle, userId, avatar);
	await requireAvatarBucket(env)
		.delete(candidate.key)
		.catch(() => undefined);
	return updated;
}

async function fetchProviderWorldAvatarMembersDescription(
	settings: ProviderSettings,
	world: WorldDocument,
	members: readonly BotSummary[],
	options: ProviderAvatarDescriptionOptions = {},
): Promise<string> {
	return fetchProviderWorldAvatarDescriptionFromUserContent(
		settings,
		worldAvatarMembersPromptUserContent(world, members),
		options,
	);
}

async function fetchProviderWorldAvatarDescription(
	settings: ProviderSettings,
	world: WorldDocument,
	options: ProviderAvatarDescriptionOptions = {},
): Promise<string> {
	const sourceDescription = [localizedTextString(world.description).trim(), localizedTextString(world.prompt).trim()]
		.filter(Boolean)
		.join('\n\nAdditional setting detail:\n');
	if (!sourceDescription) {
		throw new InputError('Short description or prompt is required before filling from description.');
	}
	return fetchProviderWorldAvatarDescriptionFromUserContent(
		settings,
		`World name: ${localizedTextString(world.name)}\nShort description:\n${sourceDescription}`,
		options,
	);
}

async function fetchProviderWorldAvatarDescriptionFromUserContent(
	settings: ProviderSettings,
	userContent: string,
	options: ProviderAvatarDescriptionOptions = {},
): Promise<string> {
	const endpoint = providerChatCompletionsUrl(settings.baseUrl);
	const signal = options.signal ?? new AbortController().signal;
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (settings.apiKey) {
		headers.authorization = `Bearer ${settings.apiKey}`;
	}
	const prefill = options.prefill?.trim();
	const messages: ChatMessage[] = [
		{
			role: 'system',
			content:
				'Write a detailed visual prompt for a public Bickr world avatar. Synthesize the setting and member profiles into one coherent image illustrating the world. Focus on concrete setting details, landmarks, scenery, atmosphere, lighting, colors, texture, composition, and camera framing. Do not include captions, text overlays, interface chrome, watermarks, or process commentary. Return only the prompt text.',
		},
		...(prefill ? [{ role: 'assistant' as const, content: prefill }] : []),
		{
			role: 'user',
			content: userContent,
		},
	];
	await options.stream?.messages(
		messages.flatMap((message): AvatarGenerationDisplayMessage[] => {
			if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') {
				return [];
			}
			return [{ role: message.role, content: message.content ?? '' }];
		}),
	);
	const requestBody = {
		model: settings.model,
		messages: sanitizeProviderMessagesForRequest(messages),
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		stream: Boolean(options.stream),
		temperature: settings.temperature,
		...(providerReasoningForSettings(settings) ? { reasoning: providerReasoningForSettings(settings) } : {}),
		...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
		...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
		...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
		...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
		...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
		...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
	};
	const response = await providerFetchWithHeaderTimeout(
		endpoint,
		{ method: 'POST', headers, body: JSON.stringify(requestBody) },
		signal,
		providerRequestTimeoutMs,
	);
	if (!response.ok) {
		const bodyText = await readProviderErrorBody(response, signal);
		throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
	}
	if (options.stream) {
		return fetchProviderWorldAvatarDescriptionFromStream(settings, endpoint, response, signal, options.stream, Boolean(prefill));
	}
	const rawResponse = await readJsonResponseText(
		response,
		providerResponseBodyMaxBytes,
		signal,
		providerBodyReadTimeoutMs,
		() => new ProviderResponseBodyTimeoutError(providerBodyReadTimeoutMs),
	);
	let payload: unknown;
	try {
		payload = JSON.parse(rawResponse) as unknown;
	} catch {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Provider world avatar description response was not valid JSON.', {
			rawResponse,
		});
	}
	const payloadRecord = runtimeRecord(payload);
	const choices = Array.isArray(payloadRecord.choices) ? payloadRecord.choices : [];
	const text = normalizeAvatarDescriptionText(providerMessageTextContent(runtimeRecord(runtimeRecord(choices[0]).message).content));
	if (!text) {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Provider world avatar description response did not include text.', {
			rawResponse,
		});
	}
	return text;
}

async function fetchProviderWorldAvatarDescriptionFromStream(
	settings: ProviderSettings,
	endpoint: string,
	response: Response,
	signal: AbortSignal,
	stream: AvatarGenerationStreamSink,
	hasPrefill: boolean,
): Promise<string> {
	if (!response.body) {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Inference provider did not return a streaming response body.');
	}
	let text = '';
	try {
		for await (const event of readSse(response.body, signal, providerBodyReadTimeoutMs)) {
			if (event.data === '[DONE]') {
				break;
			}
			let chunk: unknown;
			try {
				chunk = JSON.parse(event.data) as unknown;
			} catch {
				continue;
			}
			const parsed = providerAvatarImageStreamChunk(chunk);
			if (parsed.content) {
				text += parsed.content;
				await stream.assistantDelta(hasPrefill && text === parsed.content ? `\n\n${parsed.content}` : parsed.content);
			}
		}
	} catch (error) {
		if (error instanceof ResponseBodySizeLimitError) {
			throw new ProviderRequestError(502, settings.model, endpoint, 'Provider world avatar description response was too large.');
		}
		throw error;
	}
	const normalized = normalizeAvatarDescriptionText(text);
	if (!normalized) {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Provider world avatar description response did not include text.');
	}
	return normalized;
}

function sortBotsForCascadeDelete(bots: BotSummary[]): BotSummary[] {
	const byId = new Map(bots.map((bot) => [bot.id, bot]));
	const depthCache = new Map<string, number>();
	function cloneDepth(bot: BotSummary, visiting = new Set<string>()): number {
		const cached = depthCache.get(bot.id);
		if (cached !== undefined) {
			return cached;
		}
		if (visiting.has(bot.id)) {
			return 0;
		}
		visiting.add(bot.id);
		const sourceId = bot.cloneSource?.linked ? bot.cloneSource.sourceBotId : undefined;
		const source = sourceId ? byId.get(sourceId) : undefined;
		const depth = source ? cloneDepth(source, visiting) + 1 : 0;
		visiting.delete(bot.id);
		depthCache.set(bot.id, depth);
		return depth;
	}
	return [...bots].sort((left, right) => cloneDepth(right) - cloneDepth(left));
}

async function prefillAvatarPromptForBot(
	env: Pick<Env, 'BICKR_KV' | 'BICKR_D1' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	userId: string,
	botId: string,
	input: AvatarPromptInput = { mode: 'persona' },
	options: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink } = {},
): Promise<string> {
	const bot = await botById(env.BICKR_KV, env.BICKR_D1, botId);
	if (bot.ownerUserId !== userId) {
		throw new RepositoryError('forbidden', "Only this participant's owner can prepare an avatar prompt.", 403);
	}
	const owner = await userById(env.BICKR_KV, userId);
	if (input.mode === 'current_avatar') {
		if (!bot.avatar?.url) {
			throw new InputError('The current avatar cannot be described because this participant does not have one.');
		}
		const imageSettingsOverride = parseImageGenerationSettingsOverride(input.imageSettings, effectiveAvatarSettingsLanguageForBot(bot));
		const settings = effectiveProviderSettingsForImageGeneration(bot, owner, env, imageSettingsOverride);
		if (!settings) {
			throw new InputError('Choose an image generation model before filling from the current avatar.');
		}
		return fetchProviderCurrentAvatarDescription(settings, bot.avatar.url, options);
	}
	return fetchProviderAvatarDescription(effectiveProviderSettingsForBot(bot, owner, env), bot, {
		prefill: input.prefill,
		...options,
	});
}

type ProviderImageContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

type ProviderImageMessage =
	| { role: 'system'; content: string }
	| { role: 'user'; content: ProviderImageContentPart[] };

type ProviderAvatarImageStreamChunk = {
	content: string;
	dataUrls: string[];
	usage?: ProviderUsage;
	responseId?: string;
	responseModel?: string;
	responseProviderName?: string;
};

async function fetchProviderAvatarImage(
	settings: ImageGenerationProviderSettings,
	input: { prompt: string; currentAvatarUrl?: string },
	options: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink; target?: 'participant' | 'world' } = {},
): Promise<{ dataUrl: string; cost: number | null }> {
	const openRouterImageApi = isOpenRouterProviderBaseUrl(settings.baseUrl);
	const endpoint = openRouterImageApi ? providerImagesUrl(settings.baseUrl) : providerChatCompletionsUrl(settings.baseUrl);
	const signal = options.signal ?? new AbortController().signal;
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (settings.apiKey) {
		headers.authorization = `Bearer ${settings.apiKey}`;
	}
	const requestMessages = avatarImageGenerationMessages(input, options.target);
	await options.stream?.messages(requestMessages.displayMessages);
	if (openRouterImageApi) {
		const upstreamStream = Boolean(
			options.stream &&
			!input.currentAvatarUrl &&
			await openRouterImageApiSupportsStreaming(settings, signal),
		);
		const requestBody = openRouterAvatarImageRequest(settings, requestMessages, input, upstreamStream);
		const response = await providerFetchWithHeaderTimeout(
			endpoint,
			{ method: 'POST', headers, body: JSON.stringify(requestBody) },
			signal,
			providerImageRequestTimeoutMs,
		);
		if (!response.ok) {
			const bodyText = await readProviderErrorBody(response, signal);
			throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
		}
		if (upstreamStream && options.stream && isEventStreamResponse(response)) {
			return fetchOpenRouterAvatarImageFromStream(settings, endpoint, response, signal, options.stream);
		}
		let rawResponse: string;
		try {
			rawResponse = await readJsonResponseText(
				response,
				providerImageResponseBodyMaxBytes,
				signal,
				providerImageBodyReadTimeoutMs,
				() => new ProviderResponseBodyTimeoutError(providerImageBodyReadTimeoutMs),
			);
		} catch (error) {
			if (error instanceof ResponseBodySizeLimitError) {
				throw new ProviderRequestError(502, settings.model, endpoint, 'Provider image response was larger than the supported avatar size.');
			}
			throw error;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(rawResponse) as unknown;
		} catch {
			throw new ProviderRequestError(502, settings.model, endpoint, 'Provider image response was not valid JSON.', { rawResponse });
		}
		const dataUrl = openRouterImageApiDataUrl(payload);
		if (!dataUrl) {
			throw new ProviderRequestError(502, settings.model, endpoint, 'Provider image response did not include an image.', { rawResponse });
		}
		if (options.stream) {
			await options.stream.assistantImage(1);
		}
		const usageRecord = runtimeRecord(payload).usage;
		return {
			dataUrl,
			cost: providerUsageFromValue(usageRecord)?.cost ?? numberValue(runtimeRecord(usageRecord).cost) ?? null,
		};
	}
	const imageConfig: JsonObject = {
		...(settings.aspectRatio ? { aspect_ratio: settings.aspectRatio } : {}),
		...(settings.imageSize ? { image_size: settings.imageSize } : {}),
	};
	const requestBody = {
		model: settings.model,
		messages: requestMessages.providerMessages,
		modalities: await providerImageOutputModalities(settings, signal),
		stream: Boolean(options.stream),
		...(Object.keys(imageConfig).length > 0 ? { image_config: imageConfig } : {}),
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
		...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
		...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
		...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
		...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
		...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
		...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
	};
	const response = await providerFetchWithHeaderTimeout(
		endpoint,
		{ method: 'POST', headers, body: JSON.stringify(requestBody) },
		signal,
		providerImageRequestTimeoutMs,
	);
	if (!response.ok) {
		const bodyText = await readProviderErrorBody(response, signal);
		throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
	}
	if (options.stream) {
		return fetchProviderAvatarImageFromStream(settings, endpoint, response, signal, options.stream);
	}
	let rawResponse: string;
	try {
		rawResponse = await readJsonResponseText(
			response,
			providerImageResponseBodyMaxBytes,
			signal,
			providerImageBodyReadTimeoutMs,
			() => new ProviderResponseBodyTimeoutError(providerImageBodyReadTimeoutMs),
		);
	} catch (error) {
		if (error instanceof ResponseBodySizeLimitError) {
			throw new ProviderRequestError(502, settings.model, endpoint, 'Provider image response was larger than the supported avatar size.');
		}
		throw error;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(rawResponse) as unknown;
	} catch {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Provider image response was not valid JSON.', { rawResponse });
	}
	const dataUrl = providerImageDataUrl(payload);
	if (!dataUrl) {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Provider image response did not include an image.', { rawResponse });
	}
	const usageRecord = runtimeRecord(payload).usage;
	return {
		dataUrl,
		cost: providerUsageFromValue(usageRecord)?.cost ?? numberValue(runtimeRecord(usageRecord).cost) ?? null,
	};
}

function openRouterAvatarImageRequest(
	settings: ImageGenerationProviderSettings,
	requestMessages: ReturnType<typeof avatarImageGenerationMessages>,
	input: { currentAvatarUrl?: string },
	stream: boolean,
): JsonObject {
	const prompt = openRouterAvatarImagePrompt(requestMessages);
	return {
		model: settings.model,
		prompt,
		stream,
		...(input.currentAvatarUrl ? { input_references: [{ type: 'image_url', image_url: { url: input.currentAvatarUrl } }] } : {}),
		...(settings.aspectRatio ? { aspect_ratio: settings.aspectRatio } : {}),
		...(settings.imageSize ? { size: settings.imageSize } : {}),
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
	};
}

function openRouterAvatarImagePrompt(requestMessages: ReturnType<typeof avatarImageGenerationMessages>): string {
	return requestMessages.displayMessages
		.map((message) => message.content.trim())
		.filter(Boolean)
		.join('\n\n');
}

function avatarImageGenerationMessages(input: { prompt: string; currentAvatarUrl?: string }, target: 'participant' | 'world' = 'participant'): {
	displayMessages: AvatarGenerationDisplayMessage[];
	providerMessages: ProviderImageMessage[];
} {
	const prompt = input.prompt.trim();
	const systemPrompt = target === 'world' ? worldAvatarImageGenerationSystemPrompt : avatarImageGenerationSystemPrompt;
	const userText = prompt || (target === 'world'
		? 'Use the supplied current world image as visual input for a refreshed public world avatar.'
		: 'Use the supplied current profile image as visual input for a refreshed public profile avatar.');
	const displayUserMessage = [userText, ...(input.currentAvatarUrl ? ['[current avatar image included]'] : [])].join('\n\n');
	const content: ProviderImageContentPart[] = [{ type: 'text', text: userText }];
	if (input.currentAvatarUrl) {
		content.push({ type: 'image_url', image_url: { url: input.currentAvatarUrl } });
	}
	return {
		displayMessages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: displayUserMessage },
		],
		providerMessages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content },
		],
	};
}

function currentAvatarDescriptionMessages(currentAvatarUrl: string, target: 'participant' | 'world' = 'participant'): {
	displayMessages: AvatarGenerationDisplayMessage[];
	providerMessages: ProviderImageMessage[];
} {
	const systemPrompt = target === 'world' ? currentWorldAvatarDescriptionSystemPrompt : currentAvatarDescriptionSystemPrompt;
	const userText = target === 'world'
		? 'Bickr Terminal needs a complete visual description of the supplied current world image for a refreshed public world avatar prompt.'
		: 'Bickr Terminal needs a complete visual description of the supplied current profile image for a refreshed public avatar prompt.';
	return {
		displayMessages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: `${userText}\n\n[current avatar image included]` },
		],
		providerMessages: [
			{ role: 'system', content: systemPrompt },
			{
				role: 'user',
				content: [
					{ type: 'text', text: userText },
					{ type: 'image_url', image_url: { url: currentAvatarUrl } },
				],
			},
		],
	};
}

async function fetchProviderCurrentAvatarDescription(
	settings: ImageGenerationProviderSettings,
	currentAvatarUrl: string,
	options: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink; target?: 'participant' | 'world' } = {},
): Promise<string> {
	const endpoint = providerChatCompletionsUrl(settings.baseUrl);
	const signal = options.signal ?? new AbortController().signal;
	const modalities = await openRouterImageModelModalities(settings, signal);
	if (modalities) {
		if (!modalities.input.includes('image')) {
			throw new InputError('The selected image generation model cannot use the current avatar as image input.');
		}
		if (!modalities.output.includes('text')) {
			throw new InputError('The selected image generation model cannot return a text prompt.');
		}
	}
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (settings.apiKey) {
		headers.authorization = `Bearer ${settings.apiKey}`;
	}
	const requestMessages = currentAvatarDescriptionMessages(currentAvatarUrl, options.target);
	await options.stream?.messages(requestMessages.displayMessages);
	const requestBody = {
		model: settings.model,
		messages: requestMessages.providerMessages,
		modalities: ['text'],
		stream: Boolean(options.stream),
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
		...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
		...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
		...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
		...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
		...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
		...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
	};
	const response = await providerFetchWithHeaderTimeout(
		endpoint,
		{ method: 'POST', headers, body: JSON.stringify(requestBody) },
		signal,
		providerRequestTimeoutMs,
	);
	if (!response.ok) {
		const bodyText = await readProviderErrorBody(response, signal);
		throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
	}
	if (options.stream) {
		return fetchProviderCurrentAvatarDescriptionFromStream(settings, endpoint, response, signal, options.stream);
	}
	const rawResponse = await readJsonResponseText(
		response,
		providerResponseBodyMaxBytes,
		signal,
		providerBodyReadTimeoutMs,
		() => new ProviderResponseBodyTimeoutError(providerBodyReadTimeoutMs),
	);
	let payload: unknown;
	try {
		payload = JSON.parse(rawResponse) as unknown;
	} catch {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Provider current avatar description response was not valid JSON.', {
			rawResponse,
		});
	}
	const payloadRecord = runtimeRecord(payload);
	const choices = Array.isArray(payloadRecord.choices) ? payloadRecord.choices : [];
	const text = normalizeAvatarDescriptionText(providerMessageTextContent(runtimeRecord(runtimeRecord(choices[0]).message).content));
	if (!text) {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Provider current avatar description response did not include text.', {
			rawResponse,
		});
	}
	return text;
}

async function fetchProviderCurrentAvatarDescriptionFromStream(
	settings: ImageGenerationProviderSettings,
	endpoint: string,
	response: Response,
	signal: AbortSignal,
	stream: AvatarGenerationStreamSink,
): Promise<string> {
	if (!response.body) {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Inference provider did not return a streaming response body.');
	}
	let text = '';
	try {
		for await (const event of readSse(response.body, signal, providerBodyReadTimeoutMs)) {
			if (event.data === '[DONE]') {
				break;
			}
			let chunk: unknown;
			try {
				chunk = JSON.parse(event.data) as unknown;
			} catch {
				continue;
			}
			const parsed = providerAvatarImageStreamChunk(chunk);
			if (parsed.content) {
				text += parsed.content;
				await stream.assistantDelta(parsed.content);
			}
		}
	} catch (error) {
		if (error instanceof ResponseBodySizeLimitError) {
			throw new ProviderRequestError(502, settings.model, endpoint, 'Provider current avatar description response was too large.');
		}
		throw error;
	}
	const normalized = normalizeAvatarDescriptionText(text);
	if (!normalized) {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Provider current avatar description response did not include text.');
	}
	return normalized;
}

async function fetchProviderAvatarImageFromStream(
	settings: ImageGenerationProviderSettings,
	endpoint: string,
	response: Response,
	signal: AbortSignal,
	stream: AvatarGenerationStreamSink,
): Promise<{ dataUrl: string; cost: number | null }> {
	if (!response.body) {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Inference provider did not return a streaming response body.');
	}
	let dataUrl: string | null = null;
	let cost: number | null = null;
	let imageCount = 0;
	try {
		for await (const event of readSse(response.body, signal, providerImageBodyReadTimeoutMs)) {
			if (event.data === '[DONE]') {
				break;
			}
			let chunk: unknown;
			try {
				chunk = JSON.parse(event.data) as unknown;
			} catch {
				continue;
			}
			const parsed = providerAvatarImageStreamChunk(chunk);
			if (parsed.usage) {
				cost = parsed.usage.cost ?? numberValue(parsed.usage.raw.cost) ?? cost;
			}
			if (parsed.content) {
				await stream.assistantDelta(parsed.content);
			}
			for (const candidateUrl of parsed.dataUrls) {
				imageCount += 1;
				if (!dataUrl) {
					try {
						validateAvatarDataUrl(candidateUrl);
						dataUrl = candidateUrl;
					} catch {
						// Keep streaming markers for all returned images, but only promote the first valid avatar image.
					}
				}
				await stream.assistantImage(imageCount);
			}
		}
	} catch (error) {
		if (error instanceof ResponseBodySizeLimitError) {
			throw new ProviderRequestError(502, settings.model, endpoint, 'Provider image response was larger than the supported avatar size.');
		}
		throw error;
	}
	if (!dataUrl) {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Provider image response did not include a valid image.');
	}
	return { dataUrl, cost };
}

async function fetchOpenRouterAvatarImageFromStream(
	settings: ImageGenerationProviderSettings,
	endpoint: string,
	response: Response,
	signal: AbortSignal,
	stream: AvatarGenerationStreamSink,
): Promise<{ dataUrl: string; cost: number | null }> {
	if (!response.body) {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Inference provider did not return a streaming response body.');
	}
	let dataUrl: string | null = null;
	let cost: number | null = null;
	let imageCount = 0;
	try {
		for await (const event of readSse(response.body, signal, providerImageBodyReadTimeoutMs)) {
			if (event.data === '[DONE]') {
				break;
			}
			let chunk: unknown;
			try {
				chunk = JSON.parse(event.data) as unknown;
			} catch {
				continue;
			}
			const record = runtimeRecord(chunk);
			const providerError = providerStreamErrorFromChunk(record);
			if (providerError) {
				throw providerError;
			}
			const usage = providerUsageFromValue(record.usage);
			if (usage) {
				cost = usage.cost ?? numberValue(usage.raw.cost) ?? cost;
			}
			const type = stringValue(record.type);
			const eventDataUrl = openRouterImageApiDataUrl({ data: [record] });
			if (eventDataUrl) {
				imageCount += 1;
				await stream.assistantImage(imageCount);
				if (type === 'image_generation.completed' && !dataUrl) {
					dataUrl = eventDataUrl;
				}
			}
		}
	} catch (error) {
		if (error instanceof ResponseBodySizeLimitError) {
			throw new ProviderRequestError(502, settings.model, endpoint, 'Provider image response was larger than the supported avatar size.');
		}
		throw error;
	}
	if (!dataUrl) {
		throw new ProviderRequestError(502, settings.model, endpoint, 'Provider image response did not include a valid image.');
	}
	return { dataUrl, cost };
}

export function providerAvatarImageStreamChunk(chunk: unknown): ProviderAvatarImageStreamChunk {
	const record = runtimeRecord(chunk);
	const providerError = providerStreamErrorFromChunk(record);
	if (providerError) {
		throw providerError;
	}
	const dataUrls: string[] = [];
	let content = '';
	const choices = Array.isArray(record.choices) ? record.choices : [];
	for (const choice of choices) {
		const delta = runtimeRecord(runtimeRecord(choice).delta);
		content += providerStreamTextDelta(delta.content);
		dataUrls.push(...providerImageDataUrlsFromImages(delta.images));
	}
	const usage = providerUsageFromValue(record.usage);
	const responseId = stringValue(record.id);
	const responseModel = stringValue(record.model);
	const responseProviderName = openRouterMetadataProviderName(record.openrouter_metadata) ?? undefined;
	return {
		content,
		dataUrls,
		...(usage ? { usage } : {}),
		...(responseId ? { responseId } : {}),
		...(responseModel ? { responseModel } : {}),
		...(responseProviderName ? { responseProviderName } : {}),
	};
}

function providerStreamTextDelta(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function isEventStreamResponse(response: Response): boolean {
	return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') === true;
}

async function providerImageOutputModalities(
	settings: Pick<ImageGenerationProviderSettings, 'baseUrl' | 'model'>,
	signal?: AbortSignal,
): Promise<['image'] | ['image', 'text']> {
	const modalities = await openRouterImageModelModalities(settings, signal);
	if (modalities) {
		return modalities.output.includes('text') ? ['image', 'text'] : ['image'];
	}
	return ['image', 'text'];
}

type ProviderImageModelModalities = {
	input: string[];
	output: string[];
};

type ProviderImageModelCapabilities = ProviderImageModelModalities & {
	supportsStreaming: boolean;
};

async function openRouterImageApiSupportsStreaming(
	settings: Pick<ImageGenerationProviderSettings, 'baseUrl' | 'model'>,
	signal?: AbortSignal,
): Promise<boolean> {
	const capabilities = await openRouterImageModelCapabilities(settings, signal);
	return capabilities?.supportsStreaming === true;
}

async function openRouterImageModelModalities(
	settings: Pick<ImageGenerationProviderSettings, 'baseUrl' | 'model'>,
	signal?: AbortSignal,
): Promise<ProviderImageModelModalities | null> {
	const capabilities = await openRouterImageModelCapabilities(settings, signal);
	return capabilities ? { input: capabilities.input, output: capabilities.output } : null;
}

async function openRouterImageModelCapabilities(
	settings: Pick<ImageGenerationProviderSettings, 'baseUrl' | 'model'>,
	signal?: AbortSignal,
): Promise<ProviderImageModelCapabilities | null> {
	if (!isOpenRouterProviderBaseUrl(settings.baseUrl)) {
		return null;
	}
	try {
		const response = await fetch('https://openrouter.ai/api/v1/images/models', {
			headers: { accept: 'application/json' },
			...(signal ? { signal } : {}),
		});
		if (!response.ok) {
			return null;
		}
		const payload = (await response.json()) as { data?: unknown };
		const data = Array.isArray(payload.data) ? payload.data : [];
		const requestedModel = normalizedProviderModelId(settings.model);
		if (!requestedModel) {
			return null;
		}
		for (const item of data) {
			const record = runtimeRecord(item);
			if (normalizedProviderModelId(stringValue(record.id)) !== requestedModel) {
				continue;
			}
			const architecture = runtimeRecord(record.architecture);
			return {
				input: stringArrayValue(architecture.input_modalities),
				output: stringArrayValue(architecture.output_modalities),
				supportsStreaming: record.supports_streaming === true,
			};
		}
	} catch (error) {
		if (signal?.aborted || error instanceof TickStoppedError || isAbortError(error)) {
			throw error;
		}
		return null;
	}
	return null;
}

function normalizedProviderModelId(model: string | undefined): string {
	return model?.trim().toLowerCase().split(':')[0] ?? '';
}

function providerImageDataUrl(payload: unknown): string | null {
	const imageApiUrl = openRouterImageApiDataUrl(payload);
	if (imageApiUrl) {
		return imageApiUrl;
	}
	const choices = Array.isArray((payload as { choices?: unknown }).choices) ? (payload as { choices: unknown[] }).choices : [];
	for (const choice of choices) {
		const message = runtimeRecord(runtimeRecord(choice).message);
		const [url] = providerImageDataUrlsFromImages(message.images);
		if (url) {
			return url;
		}
	}
	return null;
}

function openRouterImageApiDataUrl(payload: unknown): string | null {
	const data = Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data : [];
	for (const item of data) {
		const record = runtimeRecord(item);
		const url = dataUrlFromBase64Image(record.b64_json, record.media_type);
		if (url) {
			return url;
		}
	}
	return null;
}

function dataUrlFromBase64Image(base64: unknown, mediaTypeValue: unknown): string | null {
	if (typeof base64 !== 'string' || !base64.trim()) {
		return null;
	}
	const normalizedBase64 = base64.trim();
	if (/^data:image\/[^;,]+;base64,/i.test(normalizedBase64)) {
		return normalizedBase64;
	}
	const mediaType = avatarContentTypeFromBase64Image(normalizedBase64) ?? stringValue(mediaTypeValue) ?? 'image/png';
	if (!mediaType.startsWith('image/')) {
		return null;
	}
	return `data:${mediaType};base64,${normalizedBase64}`;
}

function avatarContentTypeFromBase64Image(base64: string): ReturnType<typeof avatarContentTypeFromBytes> {
	try {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return avatarContentTypeFromBytes(bytes);
	} catch {
		return null;
	}
}

function providerImageDataUrlsFromImages(value: unknown): string[] {
	const images = Array.isArray(value) ? value : [];
	const urls: string[] = [];
	for (const image of images) {
		const imageRecord = runtimeRecord(image);
		const url =
			stringValue(runtimeRecord(imageRecord.image_url).url) ??
			stringValue(runtimeRecord(imageRecord.imageUrl).url);
		if (url?.startsWith('data:image/')) {
			urls.push(url);
		}
	}
	return urls;
}

const providerAvatarDescriptionToolName = 'save_avatar_description';

function providerAvatarDescriptionSpec(): ProviderSingleStringResponseSpec {
	return {
		kind: 'avatar_description',
		property: 'description',
		label: 'profile image description',
		maxCharacters: 8_000,
		toolName: providerAvatarDescriptionToolName,
	};
}

function providerAvatarDescriptionTools(): [ProviderToolDefinition] {
	return [
		{
			type: 'function',
			function: {
				name: providerAvatarDescriptionToolName,
				description:
					"Save a first-person, in-character profile image description with highly verbose, concrete visual detail. Describe appearance, expression, pose, clothing, style, colors, lighting, background, and composition. Do not mention screenshots, prompts, generation, websites, instructions, systems, or any process outside the character's world.",
				parameters: {
					type: 'object',
					properties: {
						description: { type: 'string' },
					},
					required: ['description'],
					additionalProperties: false,
				},
			},
		},
	];
}

function providerAvatarDescriptionResponseFormat(mode: ProviderCompactionMode): ProviderJsonSchemaResponseFormat | undefined {
	return providerSingleStringResponseFormat('avatar_description', providerAvatarDescriptionSpec(), mode);
}

type ProviderAvatarDescriptionOptions = {
	prefill?: string;
	signal?: AbortSignal;
	stream?: AvatarGenerationStreamSink;
};

async function fetchProviderAvatarDescription(
	settings: ProviderSettings,
	bot: BotDocument,
	options: ProviderAvatarDescriptionOptions = {},
): Promise<string> {
	const mode = providerCompactionMode(settings);
	try {
		return await fetchProviderAvatarDescriptionWithMode(settings, bot, mode, options);
	} catch (error) {
		if (mode === 'structured_output' && providerAvatarDescriptionCanFallbackToToolCall(error)) {
			return fetchProviderAvatarDescriptionWithMode(settings, bot, 'tool_call', options);
		}
		throw error;
	}
}

function providerAvatarDescriptionCanFallbackToToolCall(error: unknown): boolean {
	if (!(error instanceof ProviderRequestError)) {
		return false;
	}
	if (error.status === 502 && /^The profile image description\b/.test(error.body)) {
		return true;
	}
	return error.status === 400 && /\b(response_format|json_schema|structured)\b/i.test(error.body);
}

async function fetchProviderAvatarDescriptionWithMode(
	settings: ProviderSettings,
	bot: BotDocument,
	mode: ProviderCompactionMode,
	options: ProviderAvatarDescriptionOptions = {},
): Promise<string> {
	const endpoint = providerChatCompletionsUrl(settings.baseUrl);
	const signal = options.signal ?? new AbortController().signal;
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (settings.apiKey) {
		headers.authorization = `Bearer ${settings.apiKey}`;
	}
	const tools = mode === 'structured_output' ? [] : providerAvatarDescriptionTools();
	const requestedToolCalls = settings.toolCalls === 'railroad' ? 'railroad' : 'require';
	const toolCalls = effectiveStructuredToolCallsForModel(settings.model, settingsUseOpenRouter(settings), requestedToolCalls);
	const toolChoice = mode === 'structured_output' ? undefined : providerToolChoiceForMode(toolCalls);
	const responseFormat = providerAvatarDescriptionResponseFormat(mode);
	const reasoning = mode === 'structured_output'
		? providerCompactionReasoningForSettings(settings, providerNoReasoningModeForSettings(settings))
		: providerReasoningForSettings(settings);
	const finalInstruction =
		mode === 'structured_output'
			? 'Bickr Terminal needs a profile image description. I should return the required JSON object with a first-person, in-character description that is highly verbose and full of concrete visual detail. The description should focus only on visible appearance, style, scene, lighting, and composition.'
			: `Bickr Terminal needs a profile image description. I should call ${providerAvatarDescriptionToolName} with a first-person, in-character description that is highly verbose and full of concrete visual detail. The description should focus only on visible appearance, style, scene, lighting, and composition.`;
	const prefill = options.prefill?.trim();
	const messages: ChatMessage[] = [
		{
			role: 'system',
			content: mode === 'structured_output' ? standardPrompt(bot) : appendToolRequirementInstruction(standardPrompt(bot), tools),
		},
		...(prefill ? [{ role: 'assistant' as const, content: prefill }] : []),
		{
			role: 'user',
			content: finalInstruction,
		},
	];
	await options.stream?.messages(
		messages.flatMap((message): AvatarGenerationDisplayMessage[] => {
			if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') {
				return [];
			}
			return [{ role: message.role, content: message.content ?? '' }];
		}),
	);
	let lastValidationError: ProviderStructuredOutputValidationError | undefined;
	let fallbackDescription: string | null = null;
	for (let attempt = 1; attempt <= providerAvatarDescriptionMaxAttempts; attempt += 1) {
		const requestBody = {
			model: settings.model,
			messages: sanitizeProviderMessagesForRequest(messages),
			...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
			stream: false,
			...(tools.length > 0 ? { tools } : {}),
			...(toolChoice ? { tool_choice: toolChoice } : {}),
			...(tools.length > 0 ? { parallel_tool_calls: false } : {}),
				...(responseFormat ? { response_format: responseFormat } : {}),
				max_completion_tokens: 1400,
				...(reasoning ? { reasoning } : {}),
				temperature: settings.temperature,
			...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
			...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
			...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
			...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
			...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
			...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
		};
		const response = await providerFetchWithHeaderTimeout(
			endpoint,
			{ method: 'POST', headers, body: JSON.stringify(requestBody) },
			signal,
			providerRequestTimeoutMs,
		);
		if (!response.ok) {
			const bodyText = await readProviderErrorBody(response, signal);
			throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
		}
		const rawResponse = await readJsonResponseText(
			response,
			providerResponseBodyMaxBytes,
			signal,
			providerBodyReadTimeoutMs,
			() => new ProviderResponseBodyTimeoutError(providerBodyReadTimeoutMs),
		);
		let payload: ProviderCompactionResponsePayload;
		try {
			payload = JSON.parse(rawResponse) as ProviderCompactionResponsePayload;
		} catch {
			throw new ProviderRequestError(502, settings.model, endpoint, 'Provider avatar description response was not valid JSON.', {
				rawResponse,
			});
		}
		try {
			const description = providerAvatarDescriptionFromResponseMessage(payload.choices?.[0]?.message, rawResponse, mode);
			await options.stream?.assistantDelta(prefill ? `\n\n${description}` : description);
			return description;
		} catch (error) {
			if (!(error instanceof ProviderStructuredOutputValidationError)) {
				throw error;
			}
			lastValidationError = error;
			fallbackDescription ??= normalizeAvatarDescriptionText(error.outputText);
			if (attempt < providerAvatarDescriptionMaxAttempts) {
				messages.push(...avatarDescriptionRepairMessages(error, mode));
				continue;
			}
			const fallback = normalizeAvatarDescriptionText(error.outputText) ?? fallbackDescription;
			if (fallback) {
				await options.stream?.assistantDelta(prefill ? `\n\n${fallback}` : fallback);
				return fallback;
			}
		}
	}
	throw new ProviderRequestError(
		502,
		settings.model,
		endpoint,
		lastValidationError?.repairMessage ?? 'Provider avatar description response did not call the required tool.',
		lastValidationError ? { rawResponse: lastValidationError.rawResponse } : {},
	);
}

function providerAvatarDescriptionFromResponseMessage(message: unknown, rawResponse: string, mode: ProviderCompactionMode): string {
	return providerSingleStringResponseFromMessage(message, providerAvatarDescriptionSpec(), rawResponse, mode).trim();
}

function normalizeAvatarDescriptionText(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	if (trimmed.length > 8_000) {
		return trimmed.slice(0, 8_000).trim();
	}
	return trimmed;
}

function providerMessageTextContent(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value.trim() || undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}
	const text = value
		.map((item) => {
			const record = runtimeRecord(item);
			return typeof record.text === 'string' ? record.text : '';
		})
		.join('\n')
		.trim();
	return text || undefined;
}

function avatarDescriptionRepairMessages(error: ProviderStructuredOutputValidationError, mode: ProviderCompactionMode): ChatMessage[] {
	if (mode === 'structured_output') {
		return [
			...(error.outputText ? [{ role: 'assistant' as const, content: error.outputText }] : []),
			{
				role: 'user',
				content:
					'Bickr Terminal still needs the profile image description as the required JSON object with exactly one field named description. The description must be first person, in character, and focused only on visible appearance, style, scene, lighting, and composition.',
			},
		];
	}
	if (error.toolCalls.length === 0) {
		return [
			...(error.outputText ? [{ role: 'assistant' as const, content: error.outputText }] : []),
			{
				role: 'user',
				content: `Bickr Terminal still needs me to call ${providerAvatarDescriptionToolName}. The description must be first person, in character, and focused only on visible appearance, style, scene, lighting, and composition.`,
			},
		];
	}
	const content = JSON.stringify({
		ok: false,
		message: error.repairMessage,
	});
	return [
		{
			role: 'assistant',
			content: '',
			tool_calls: error.toolCalls,
		},
		...error.toolCalls.map(
			(toolCall): ChatMessage => ({
				role: 'tool',
				tool_call_id: toolCall.id,
				content,
			}),
		),
	];
}

function requireAvatarBucket(env: Pick<Env, 'BICKR_R2'>): R2BucketLike {
	if (!env.BICKR_R2) {
		throw new InputError('BICKR_R2 must be configured before storing avatars.');
	}
	return env.BICKR_R2 as R2BucketLike;
}

export class UserBotsCoordinator {
	private readonly state: DurableObjectState;
	private readonly env: Env;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		if (!isTrustedInternalServiceRequest(request)) {
			return agentRuntimeNotFoundResponse();
		}
		return handleAgentRuntimeRequest(request, this.env, this.state.id.toString());
	}
}

export async function handleAgentRuntimeRequest(
	request: Request,
	env: Pick<
		Env,
		| 'BICKR_D1'
		| 'BICKR_KV'
		| 'BICKR_R2'
		| 'BICKR_R2_PUBLIC_BASE_URL'
		| 'AI'
		| 'BICKR_BOT_VECTORIZE'
		| 'BICKR_SEARCH_VECTORIZE'
		| 'OPENROUTER_API_KEY'
		| 'OPENROUTER_BASE_URL'
		| 'OPENROUTER_MODEL'
	>,
	objectId = 'direct',
): Promise<Response> {
	try {
		const url = new URL(request.url);
		const translateMatch = /^\/users\/([^/]+)\/translate$/.exec(url.pathname);
		if (request.method === 'POST' && translateMatch) {
			const userId = requireUserMatch(request, decodeURIComponent(translateMatch[1] ?? ''));
			const input = parseTranslationInput(await readJsonBody(request));
			const translation = await translateForUser(env, userId, input.text);
			return ok({ translation, coordinator: objectId });
		}

		if (request.method === 'GET' && url.pathname === '/search/entities') {
			requireAuthenticatedServiceRequest(request);
			const mode = parseSearchMode(url.searchParams.get('mode'));
			if (mode !== 'semantic') {
				throw new InputError('Agent runtime search only supports semantic mode.');
			}
			const result = await searchEntitiesSemantic(env.BICKR_D1, env, {
				...normalizeSearchFilters({
					forum: url.searchParams.get('forum'),
					username: url.searchParams.get('username'),
					world: url.searchParams.get('world'),
				}),
				mode,
				page: boundedSearchPage(url.searchParams.get('page')),
				query: url.searchParams.get('q') ?? '',
				types: parseSearchTypes(url.searchParams.get('types')),
			});
			return ok({ search: result, coordinator: objectId });
		}

		if (request.method === 'POST' && url.pathname === '/search/reindex-vectors') {
			requireSchedulerServiceRequest(request);
			const limit = Number(url.searchParams.get('limit') ?? 100);
			const result = await reindexSearchVectors(env.BICKR_D1, env, Number.isFinite(limit) ? limit : 100);
			return ok({ reindex: result, coordinator: objectId });
		}

		if (request.method === 'GET' && url.pathname === '/statistics/inference-costs') {
			requireAuthenticatedServiceRequest(request);
			return ok({
				stats: publicGlobalInferenceCostStats(await cachedGlobalInferenceCostStats(env.BICKR_D1)),
				coordinator: objectId,
			});
		}

		const ownedBotSpendMatch = /^\/users\/([^/]+)\/bots\/token-spend$/.exec(url.pathname);
		if (ownedBotSpendMatch && request.method === 'GET') {
			const userId = requireUserMatch(request, decodeURIComponent(ownedBotSpendMatch[1] ?? ''));
			const now = new Date();
			const [owner, bots] = await Promise.all([
				userById(env.BICKR_KV, userId),
				listUserBots(env.BICKR_KV, env.BICKR_D1, userId),
			]);
			const summaries = await listOwnerBotTokenSpendSummaries(
				env.BICKR_D1,
				userId,
				bots.map((bot) => ({
					botId: bot.id,
					currentModel: effectiveProviderSettingsForBot(bot, owner, env).model,
				})),
				now,
			);
			return ok({
				generatedAt: now.toISOString(),
				spendByBotId: Object.fromEntries(summaries.map((summary) => [summary.botId, summary])),
				coordinator: objectId,
			});
		}

		const ownedBotSpreadTicksMatch = /^\/users\/([^/]+)\/bots\/spread-ticks$/.exec(url.pathname);
		if (ownedBotSpreadTicksMatch && request.method === 'POST') {
			const userId = requireUserMatch(request, decodeURIComponent(ownedBotSpreadTicksMatch[1] ?? ''));
			const spread = await spreadUserBotTicks(env.BICKR_KV, env.BICKR_D1, userId);
			return ok({ spread, coordinator: objectId });
		}

		const userAvatarPromptMatch = /^\/users\/([^/]+)\/avatar\/prompt$/.exec(url.pathname);
		if (userAvatarPromptMatch && request.method === 'POST') {
			const userId = requireUserMatch(request, decodeURIComponent(userAvatarPromptMatch[1] ?? ''));
			const input = parseAvatarPromptInput(await readOptionalJsonBody(request));
			if (request.headers.get('accept')?.includes('text/event-stream')) {
				return streamAvatarPromptForUser(env, userId, input, request.signal);
			}
			const prompt = await prefillAvatarPromptForUser(env, userId, input);
			return ok({ prompt, coordinator: objectId });
		}

		const userAvatarGenerateMatch = /^\/users\/([^/]+)\/avatar\/generate$/.exec(url.pathname);
		if (userAvatarGenerateMatch && request.method === 'POST') {
			const userId = requireUserMatch(request, decodeURIComponent(userAvatarGenerateMatch[1] ?? ''));
			const input = parseAvatarGenerationInput(await readJsonBody(request));
			if (request.headers.get('accept')?.includes('text/event-stream')) {
				return streamAvatarGenerationForUser(env, userId, input, request.signal);
			}
			const candidate = await generateAvatarForUser(env, userId, input);
			return ok({ candidate, coordinator: objectId });
		}

		const userAvatarApplyMatch = /^\/users\/([^/]+)\/avatar\/apply$/.exec(url.pathname);
		if (userAvatarApplyMatch && request.method === 'POST') {
			const userId = requireUserMatch(request, decodeURIComponent(userAvatarApplyMatch[1] ?? ''));
			const body = runtimeRecord(await readJsonBody(request));
			const settingsInput = body.settings === undefined ? undefined : parseUpdateUserProfileInput({
				inferenceSettings: { imageGeneration: body.settings },
			});
			let profile = await applyGeneratedAvatarForUser(env, userId, parseAvatarCandidate(body.candidate));
			if (settingsInput?.inferenceSettings !== undefined) {
				profile = await updateUserProfile(env.BICKR_KV, env.BICKR_D1, userId, { inferenceSettings: settingsInput.inferenceSettings });
			}
			return ok({ profile, coordinator: objectId });
		}

		const createMatch = /^\/users\/([^/]+)\/worlds\/([^/]+)\/bots$/.exec(url.pathname);
		if (request.method === 'POST' && createMatch) {
			const userId = requireUserMatch(request, decodeURIComponent(createMatch[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(createMatch[2] ?? ''));
			const input = parseCreateBotInput(await readJsonBody(request));
			const cloneSourceBot = input.cloneSourceBotId ? await rawBotById(env.BICKR_KV, env.BICKR_D1, input.cloneSourceBotId) : null;
			if (cloneSourceBot && cloneSourceBot.ownerUserId !== userId) {
				throw new RepositoryError('forbidden', 'You can only clone your own participants.', 403);
			}
			if (input.importSource?.sourceAvatarUrl) {
				requireAvatarBucket(env);
				normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL);
			}
			const chirperAvatar = input.importSource?.sourceAvatarUrl ? await fetchRemoteAvatarBytes(input.importSource.sourceAvatarUrl) : null;
			let bot = await createBot(env.BICKR_KV, env.BICKR_D1, worldHandle, input, userId, {
				cloneSource: cloneSourceBot ?? undefined,
			});
			if (chirperAvatar && input.importSource?.sourceAvatarUrl) {
				const avatar = await storeAvatarImage(requireAvatarBucket(env), {
					botId: bot.id,
					worldId: bot.homeWorldId,
					bytes: chirperAvatar.bytes,
					contentType: chirperAvatar.contentType,
					publicBaseUrl: normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL),
					source: {
						type: 'chirper',
						sourceUrl: input.importSource.sourceAvatarUrl,
						originalHandle: input.importSource.originalHandle,
						importedAt: input.importSource.importedAt,
					},
				});
				bot = await updateBotAvatar(env.BICKR_KV, env.BICKR_D1, bot.id, userId, avatar);
			}
			await upsertBotVector(env, bot);
			return ok({ bot, coordinator: objectId }, { status: 201 });
		}

		const botMatch = /^\/users\/([^/]+)\/bots\/([^/]+)$/.exec(url.pathname);
		if (botMatch && request.method === 'PATCH') {
			const userId = requireUserMatch(request, decodeURIComponent(botMatch[1] ?? ''));
			const botId = decodeURIComponent(botMatch[2] ?? '');
			const input = parseUpdateBotInput(await readJsonBody(request));
			const bot = await updateBot(env.BICKR_KV, env.BICKR_D1, botId, userId, input);
			await upsertBotVector(env, bot);
			const affectedBots = await refreshLinkedCloneIndexes(env.BICKR_KV, env.BICKR_D1, bot.id);
			await Promise.all(affectedBots.map((affectedBot) => upsertBotVector(env, affectedBot)));
			return ok({ bot, affectedBots, coordinator: objectId });
		}

		const cloneUnlinkMatch = /^\/users\/([^/]+)\/bots\/([^/]+)\/clone\/unlink$/.exec(url.pathname);
		if (cloneUnlinkMatch && request.method === 'POST') {
			const userId = requireUserMatch(request, decodeURIComponent(cloneUnlinkMatch[1] ?? ''));
			const botId = decodeURIComponent(cloneUnlinkMatch[2] ?? '');
			const rawBot = await rawBotById(env.BICKR_KV, env.BICKR_D1, botId);
			if (rawBot.ownerUserId !== userId) {
				throw new RepositoryError('forbidden', "Only this participant's owner can unlink it.", 403);
			}
			const effectiveBot = await botById(env.BICKR_KV, env.BICKR_D1, botId);
			const now = new Date().toISOString();
			const copiedAvatar = !rawBot.avatar && effectiveBot.avatar
				? await copyAvatarImage(requireAvatarBucket(env), {
					botId: rawBot.id,
					worldId: rawBot.homeWorldId,
					sourceAvatar: effectiveBot.avatar,
					publicBaseUrl: normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL),
					now,
				})
				: undefined;
			const bot = await unlinkBotClone(env.BICKR_KV, env.BICKR_D1, botId, userId, copiedAvatar, now);
			await upsertBotVector(env, bot);
			const affectedBots = await refreshLinkedCloneIndexes(env.BICKR_KV, env.BICKR_D1, bot.id);
			await Promise.all(affectedBots.map((affectedBot) => upsertBotVector(env, affectedBot)));
			return ok({ bot, affectedBots, coordinator: objectId });
		}

		const cloneRelinkMatch = /^\/users\/([^/]+)\/bots\/([^/]+)\/clone\/relink$/.exec(url.pathname);
		if (cloneRelinkMatch && request.method === 'POST') {
			const userId = requireUserMatch(request, decodeURIComponent(cloneRelinkMatch[1] ?? ''));
			const botId = decodeURIComponent(cloneRelinkMatch[2] ?? '');
			const bot = await relinkBotClone(env.BICKR_KV, env.BICKR_D1, botId, userId);
			await upsertBotVector(env, bot);
			const affectedBots = await refreshLinkedCloneIndexes(env.BICKR_KV, env.BICKR_D1, bot.id);
			await Promise.all(affectedBots.map((affectedBot) => upsertBotVector(env, affectedBot)));
			return ok({ bot, affectedBots, coordinator: objectId });
		}

		const avatarPromptMatch = /^\/users\/([^/]+)\/bots\/([^/]+)\/avatar\/prompt$/.exec(url.pathname);
		if (avatarPromptMatch && request.method === 'POST') {
			const userId = requireUserMatch(request, decodeURIComponent(avatarPromptMatch[1] ?? ''));
			const botId = decodeURIComponent(avatarPromptMatch[2] ?? '');
			const input = parseAvatarPromptInput(await readOptionalJsonBody(request));
			if (request.headers.get('accept')?.includes('text/event-stream')) {
				return streamAvatarPromptForBot(env, userId, botId, input, request.signal);
			}
			const prompt = await prefillAvatarPromptForBot(env, userId, botId, input);
			return ok({ prompt, coordinator: objectId });
		}

		const avatarGenerateMatch = /^\/users\/([^/]+)\/bots\/([^/]+)\/avatar\/generate$/.exec(url.pathname);
		if (avatarGenerateMatch && request.method === 'POST') {
			const userId = requireUserMatch(request, decodeURIComponent(avatarGenerateMatch[1] ?? ''));
			const botId = decodeURIComponent(avatarGenerateMatch[2] ?? '');
			const input = parseAvatarGenerationInput(await readJsonBody(request));
			if (request.headers.get('accept')?.includes('text/event-stream')) {
				return streamAvatarGenerationForBot(env, userId, botId, input, request.signal);
			}
			const candidate = await generateAvatarForBot(env, userId, botId, input);
			return ok({ candidate, coordinator: objectId });
		}

		const avatarApplyMatch = /^\/users\/([^/]+)\/bots\/([^/]+)\/avatar\/apply$/.exec(url.pathname);
		if (avatarApplyMatch && request.method === 'POST') {
			const userId = requireUserMatch(request, decodeURIComponent(avatarApplyMatch[1] ?? ''));
			const botId = decodeURIComponent(avatarApplyMatch[2] ?? '');
			const body = runtimeRecord(await readJsonBody(request));
			const targetBot = await botById(env.BICKR_KV, env.BICKR_D1, botId);
			if (targetBot.ownerUserId !== userId) {
				throw new RepositoryError('forbidden', "Only this participant's owner can update its avatar.", 403);
			}
			const settingsInput = body.settings === undefined ? undefined : parseUpdateBotInput({
				language: effectiveAvatarSettingsLanguageForBot(targetBot),
				inferenceSettings: { imageGeneration: body.settings },
			});
			let bot = await applyGeneratedAvatarForBot(env, userId, botId, parseAvatarCandidate(body.candidate));
			if (settingsInput?.inferenceSettings !== undefined) {
				bot = await updateBot(env.BICKR_KV, env.BICKR_D1, bot.id, userId, { inferenceSettings: settingsInput.inferenceSettings });
			}
			await upsertBotVector(env, bot);
			const affectedBots = await refreshLinkedCloneIndexes(env.BICKR_KV, env.BICKR_D1, bot.id);
			await Promise.all(affectedBots.map((affectedBot) => upsertBotVector(env, affectedBot)));
			return ok({ bot, affectedBots, coordinator: objectId });
		}

		const worldAvatarPromptMatch = /^\/users\/([^/]+)\/worlds\/([^/]+)\/avatar\/prompt$/.exec(url.pathname);
		if (worldAvatarPromptMatch && request.method === 'POST') {
			const userId = requireUserMatch(request, decodeURIComponent(worldAvatarPromptMatch[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(worldAvatarPromptMatch[2] ?? ''));
			const input = parseAvatarPromptInput(await readOptionalJsonBody(request));
			if (request.headers.get('accept')?.includes('text/event-stream')) {
				return streamAvatarPromptForWorld(env, userId, worldHandle, input, request.signal);
			}
			const prompt = await prefillAvatarPromptForWorld(env, userId, worldHandle, input);
			return ok({ prompt, coordinator: objectId });
		}

		const worldAvatarPromptSettingsMatch = /^\/users\/([^/]+)\/worlds\/([^/]+)\/avatar\/prompt-settings$/.exec(url.pathname);
		if (worldAvatarPromptSettingsMatch && request.method === 'GET') {
			const userId = requireUserMatch(request, decodeURIComponent(worldAvatarPromptSettingsMatch[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(worldAvatarPromptSettingsMatch[2] ?? ''));
			const settings = await worldAvatarPromptSettings(env, userId, worldHandle);
			return ok({ settings, coordinator: objectId });
		}

		const worldAvatarGenerateMatch = /^\/users\/([^/]+)\/worlds\/([^/]+)\/avatar\/generate$/.exec(url.pathname);
		if (worldAvatarGenerateMatch && request.method === 'POST') {
			const userId = requireUserMatch(request, decodeURIComponent(worldAvatarGenerateMatch[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(worldAvatarGenerateMatch[2] ?? ''));
			const input = parseAvatarGenerationInput(await readJsonBody(request));
			if (request.headers.get('accept')?.includes('text/event-stream')) {
				return streamAvatarGenerationForWorld(env, userId, worldHandle, input, request.signal);
			}
			const candidate = await generateAvatarForWorld(env, userId, worldHandle, input);
			return ok({ candidate, coordinator: objectId });
		}

		const worldAvatarApplyMatch = /^\/users\/([^/]+)\/worlds\/([^/]+)\/avatar\/apply$/.exec(url.pathname);
		if (worldAvatarApplyMatch && request.method === 'POST') {
			const userId = requireUserMatch(request, decodeURIComponent(worldAvatarApplyMatch[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(worldAvatarApplyMatch[2] ?? ''));
			const body = runtimeRecord(await readJsonBody(request));
			const targetWorld = await worldDocumentForAvatar(env, worldHandle, userId, 'update');
			const settingsInput = body.settings === undefined ? undefined : parseUpdateWorldInput({
				language: effectiveAvatarSettingsLanguageForWorld(targetWorld),
				imageGeneration: body.settings,
			});
			let world = await applyGeneratedAvatarForWorld(env, userId, worldHandle, parseAvatarCandidate(body.candidate));
			if (settingsInput?.imageGeneration !== undefined) {
				world = await updateWorld(env.BICKR_KV, env.BICKR_D1, world.handle, userId, { imageGeneration: settingsInput.imageGeneration });
			}
			return ok({ world, coordinator: objectId });
		}

		if (botMatch && request.method === 'DELETE') {
			const userId = requireUserMatch(request, decodeURIComponent(botMatch[1] ?? ''));
			const botId = decodeURIComponent(botMatch[2] ?? '');
			const bot = await deleteBot(env.BICKR_KV, env.BICKR_D1, botId, userId);
			await deleteBotVector(env, bot.id);
			return ok({ bot, coordinator: objectId });
		}

		const profileDeleteMatch = /^\/users\/([^/]+)\/profile$/.exec(url.pathname);
		if (profileDeleteMatch && request.method === 'DELETE') {
			const userId = requireUserMatch(request, decodeURIComponent(profileDeleteMatch[1] ?? ''));
			const input = await readJsonBody(request);
			if (!input || typeof input !== 'object' || Array.isArray(input) || (input as { confirmCascade?: unknown }).confirmCascade !== true) {
				throw new InputError('Profile deletion requires confirmCascade: true.');
			}
			const eligibility = await humanProfileDeleteEligibility(env.BICKR_D1, userId);
			if (!eligibility.canDelete) {
				throw new RepositoryError(
					'conflict',
					'Profile deletion is blocked because an owned world contains bots owned by other profiles.',
					409,
					{ profileDeleteBlockers: eligibility.blockers },
				);
			}
			const now = new Date().toISOString();
			const [ownedBots, ownedForumsOutsideOwnedWorlds, ownedWorlds] = await Promise.all([
				listUserBots(env.BICKR_KV, env.BICKR_D1, userId),
				listOwnedForumsOutsideOwnedWorlds(env.BICKR_D1, userId),
				listOwnedWorlds(env.BICKR_D1, userId),
			]);
			for (const bot of sortBotsForCascadeDelete(ownedBots)) {
				const deleted = await deleteBot(env.BICKR_KV, env.BICKR_D1, bot.id, userId, { now, allowLinkedCloneDelete: true });
				await deleteBotVector(env, deleted.id);
			}
			for (const forum of ownedForumsOutsideOwnedWorlds) {
				await deleteForum(env.BICKR_KV, env.BICKR_D1, forum.worldHandle, forum.handle, userId, now);
			}
			for (const world of ownedWorlds) {
				await deleteWorld(env.BICKR_KV, env.BICKR_D1, world.handle, userId, now);
			}
			const deletedProfile = await softDeleteUserProfile(env.BICKR_KV, env.BICKR_D1, userId, now);
			return ok({
				profile: deletedProfile,
				deleted: {
					worlds: ownedWorlds.length,
					forums: ownedForumsOutsideOwnedWorlds.length,
					bots: ownedBots.length,
				},
				coordinator: objectId,
			});
		}

		return fail('not_found', 'Agent runtime route not found.', 404);
	} catch (error) {
		return errorResponse(error);
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (!isTrustedInternalServiceRequest(request)) {
			return agentRuntimeNotFoundResponse();
		}

		if (url.pathname === '/health') {
			return json({
				ok: true,
				runtime: 'agent-runtime-worker',
			});
		}

		const translateMatch = /^\/users\/([^/]+)\/translate$/.exec(url.pathname);
		if (translateMatch && request.method === 'POST') {
			return handleAgentRuntimeRequest(request, env);
		}

		if (
			(url.pathname === '/search/entities' && request.method === 'GET') ||
			(url.pathname === '/search/reindex-vectors' && request.method === 'POST') ||
			(url.pathname === '/statistics/inference-costs' && request.method === 'GET')
		) {
			return handleAgentRuntimeRequest(request, env);
		}

		if (/^\/users\/[^/]+\/bots\/token-spend$/.test(url.pathname) && request.method === 'GET') {
			return handleAgentRuntimeRequest(request, env);
		}

		const userBotsMatch = /^\/users\/([^/]+)\/(?:avatar\/(?:prompt|generate|apply)|worlds\/[^/]+\/(?:bots|avatar\/(?:prompt|prompt-settings|generate|apply))|bots\/[^/]+(?:\/avatar\/(?:prompt|generate|apply)|\/clone\/(?:unlink|relink))?|profile)$/.exec(
			url.pathname,
		);
		const promptSettingsGet = /^\/users\/[^/]+\/worlds\/[^/]+\/avatar\/prompt-settings$/.test(url.pathname);
		if (userBotsMatch && (['POST', 'PATCH', 'DELETE'].includes(request.method) || (request.method === 'GET' && promptSettingsGet))) {
			const userId = decodeURIComponent(userBotsMatch[1] ?? '');
			const objectId = env.USER_BOTS.idFromName(userId);
			return env.USER_BOTS.get(objectId).fetch(request);
		}

		if (url.pathname.startsWith('/bots/')) {
			const botId = url.pathname.split('/')[2] ?? 'unknown';
			const objectId = env.BOT_RUNTIME.idFromName(botId);
			return env.BOT_RUNTIME.get(objectId).fetch(request);
		}

		return agentRuntimeNotFoundResponse();
	},

	async scheduled(event, env, ctx) {
		ctx.waitUntil(runScheduledAgentRuntimeTasks(env, event.scheduledTime));
	},
} satisfies ExportedHandler<Env>;

async function runScheduledAgentRuntimeTasks(env: Env, scheduledTime: number): Promise<void> {
	await Promise.all([
		dispatchDueBots(env, scheduledTime),
		refreshGlobalInferenceCostStatsCacheIfStale(env.BICKR_D1, new Date(scheduledTime)).catch((error) => {
			console.warn('global inference cost stats refresh failed', error);
		}),
	]);
}

async function dispatchDueBots(env: Env, scheduledTime: number): Promise<void> {
	const now = new Date(scheduledTime).toISOString();
	const result = await env.BICKR_D1.prepare(
		`SELECT bot_id AS botId
		 FROM bot_runtime_index
		 WHERE enabled = 1
		   AND next_due_at IS NOT NULL
		   AND next_due_at <= ?
		   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
		 ORDER BY next_due_at ASC
		 LIMIT 20`,
	)
		.bind(now, now)
		.all<{ botId: string }>();
	await Promise.all(
		(result.results ?? []).map(async (row) => {
			const id = env.BOT_RUNTIME.idFromName(row.botId);
			const parentSignal = new AbortController().signal;
			try {
				await withAbortableTimeout(
					parentSignal,
					scheduledDispatchTimeoutMs,
					() => new RuntimeOperationTimeoutError('Scheduled Bickr visit dispatch', scheduledDispatchTimeoutMs),
					(signal) =>
						env.BOT_RUNTIME.get(id).fetch(
							new Request(internalServiceUrl(`/bots/${encodeURIComponent(row.botId)}/tick`), {
								method: 'POST',
								signal,
								headers: {
									'content-type': 'application/json',
									'x-bickr-scheduler': '1',
								},
								body: JSON.stringify({ background: true }),
							}),
						),
				);
			} catch (error) {
				console.warn('scheduled bot tick dispatch failed', row.botId, error);
			}
		}),
	);
}

function canonicalToolName(name: string): string {
	const aliases: Record<string, string> = {
		create_post: 'create_thread',
		reply_to_thread: 'reply_to_comment',
		search_posts: 'search_threads',
		search_posts_semantic: 'search_threads_semantic',
		search_bots: 'search_profiles',
		view_profile: 'view_profiles',
		view_bot_profile: 'view_profiles',
		view_bot_activity: 'view_activity',
		follow_bot: 'follow_profile',
		unfollow_bot: 'unfollow_profile',
	};
	return aliases[name] ?? name;
}

function providerToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
	const canonical = canonicalToolName(name);
	const normalized = { ...args };
	if ((canonical === 'read_thread' || canonical === 'read_thread_by_id') && stringValue(normalized.threadId)) {
		normalized.threadRef = formatThreadRef(stringValue(normalized.threadId)!);
		delete normalized.threadId;
	}
	if (canonical === 'read_comment_by_id' && stringValue(normalized.commentId)) {
		normalized.commentRef = formatCommentRef(stringValue(normalized.commentId)!);
		delete normalized.commentId;
	}
	if ('botId' in normalized && !('profileId' in normalized)) {
		normalized.profileId = stringValue(normalized.botId);
		delete normalized.botId;
	}
	if (
		(canonical === 'reply_to_comment' || canonical === 'make_additional_reply_to_the_same_comment') &&
		!stringValue(normalized.commentId) &&
		stringValue(normalized.parentCommentId)
	) {
		normalized.commentId = stringValue(normalized.parentCommentId);
		delete normalized.parentCommentId;
		delete normalized.threadId;
	}
	if (
		(canonical === 'reply_to_comment' || canonical === 'make_additional_reply_to_the_same_comment') &&
		stringValue(normalized.commentId)
	) {
		normalized.commentRef = formatCommentRef(stringValue(normalized.commentId)!);
		delete normalized.commentId;
		delete normalized.parentCommentId;
		delete normalized.threadId;
	}
	if (canonical === 'vote' && Array.isArray(normalized.votes)) {
		normalized.votes = normalized.votes.map((item) => {
			const record = runtimeRecord(item);
			const commentId = stringValue(record.commentId ?? record.targetId);
			return removeUndefinedProperties({
				...record,
				...(commentId ? { commentRef: formatCommentRef(commentId) } : {}),
				commentId: undefined,
				targetId: undefined,
			});
		});
	}
	return normalized;
}

function providerCompactionSummaryFromResponseMessage(
	message: unknown,
	rawResponse: string,
	limits: ProviderCompactionValidationLimits = defaultProviderCompactionSummaryLimits,
	mode: ProviderCompactionMode = 'structured_output',
): string {
	return providerSingleStringResponseFromMessage(message, providerCompactionSummarySpec(limits), rawResponse, mode);
}

function providerTranslationFromToolMessage(message: unknown, rawResponse: string): string {
	return providerSingleStringResponseFromMessage(
		message,
		{
			kind: 'translation',
			property: 'translation',
			label: 'translation',
			maxCharacters: providerTranslationMaxCompletionTokens * 8,
			toolName: providerTranslationToolName,
		},
		rawResponse,
		'tool_call',
	).trim();
}

function providerSingleStringResponseFromMessage(
	message: unknown,
	spec: ProviderSingleStringResponseSpec,
	rawResponse: string,
	mode: ProviderCompactionMode,
): string {
	if (mode === 'structured_output') {
		return providerStructuredOutputFromMessageContent(message, spec, rawResponse);
	}
	if (!spec.toolName) {
		throw new Error(`Provider single-string response ${spec.kind} requires a tool name for tool-call mode.`);
	}
	return providerStructuredOutputFromToolMessage(message, spec as ProviderSingleStringResponseSpec & { toolName: string }, rawResponse);
}

function providerStructuredOutputFromMessageContent(
	messageValue: unknown,
	spec: ProviderSingleStringResponseSpec,
	rawResponse: string,
): string {
	const message = runtimeRecord(messageValue);
	const toolCalls = Array.isArray(message.tool_calls)
		? message.tool_calls.map(providerToolCallFromValue).filter((toolCall): toolCall is BotInferenceSubmissionToolCall => Boolean(toolCall))
		: [];
	if (toolCalls.length > 0) {
		const repairMessage =
			spec.kind === 'compaction'
				? "META: don't make any tool calls. You must reply with the structured detailed first-person summary strictly following the required JSON schema."
				: `Do not use a Bickr control for this response. Reply with the required JSON object containing only ${spec.property}.`;
		throw new ProviderStructuredOutputValidationError(spec.kind, repairMessage, {
			rawResponse,
			outputText: providerMessageTextContent(message.content),
			toolCalls,
		});
	}
	const content = providerMessageTextContent(message.content);
	if (!content) {
		throw new ProviderStructuredOutputValidationError(spec.kind, `The ${spec.label} response was empty.`, { rawResponse });
	}
	const parsed = parseProviderStructuredMessageContent(content, spec, rawResponse);
	return providerStructuredOutputPropertyFromRecord(parsed, spec, rawResponse, []);
}

function parseProviderStructuredMessageContent(
	content: string,
	spec: Pick<ProviderSingleStringResponseSpec, 'kind' | 'label' | 'property'>,
	rawResponse: string,
): unknown {
	const repairCandidates = new Set<string>();
	try {
		return JSON.parse(content) as unknown;
	} catch {
		const firstBrace = content.indexOf('{');
		const lastBrace = content.lastIndexOf('}');
		if (firstBrace >= 0 && lastBrace > firstBrace) {
			const candidate = content.slice(firstBrace, lastBrace + 1);
			try {
				return JSON.parse(candidate) as unknown;
			} catch {
				repairCandidates.add(candidate);
			}
		}
		repairCandidates.add(content);
		for (const candidate of repairCandidates) {
			const repaired = repairSingleStringStructuredJsonObject(candidate, spec.property);
			if (repaired) {
				return repaired;
			}
		}
	}
	throw new ProviderStructuredOutputValidationError(spec.kind, `The ${spec.label} response must be a JSON object.`, {
		rawResponse,
		...(spec.kind === 'compaction' ? {} : { outputText: content }),
	});
}

function repairSingleStringStructuredJsonObject(source: string, property: string): Record<string, string> | null {
	const text = source.trim();
	let index = 0;
	if (text[index] !== '{') {
		return null;
	}
	index = skipJsonWhitespace(text, index + 1);
	const key = readJsonStringToken(text, index);
	if (!key || key.value !== property) {
		return null;
	}
	index = skipJsonWhitespace(text, key.end);
	if (text[index] !== ':') {
		return null;
	}
	index = skipJsonWhitespace(text, index + 1);
	if (text[index] !== '"') {
		return null;
	}
	const valueStart = index + 1;
	const objectEnd = lastNonWhitespaceIndex(text);
	if (objectEnd <= valueStart || text[objectEnd] !== '}') {
		return null;
	}
	let closingQuote = objectEnd - 1;
	while (closingQuote >= valueStart && isJsonWhitespace(text[closingQuote] ?? '')) {
		closingQuote -= 1;
	}
	if (closingQuote < valueStart || text[closingQuote] !== '"' || isEscapedJsonStringQuote(text, closingQuote)) {
		return null;
	}
	if (text.slice(closingQuote + 1, objectEnd).trim()) {
		return null;
	}
	const rawValue = text.slice(valueStart, closingQuote);
	if (looksLikeAdditionalJsonMember(rawValue)) {
		return null;
	}
	return { [property]: decodeLooseJsonStringContent(rawValue) };
}

function readJsonStringToken(text: string, start: number): { value: string; end: number } | null {
	if (text[start] !== '"') {
		return null;
	}
	for (let index = start + 1; index < text.length; index += 1) {
		if (text[index] === '"' && !isEscapedJsonStringQuote(text, index)) {
			try {
				const value = JSON.parse(text.slice(start, index + 1)) as unknown;
				return typeof value === 'string' ? { value, end: index + 1 } : null;
			} catch {
				return null;
			}
		}
	}
	return null;
}

function decodeLooseJsonStringContent(value: string): string {
	let decoded = '';
	for (let index = 0; index < value.length; ) {
		const char = value[index];
		if (char !== '\\') {
			decoded += char ?? '';
			index += 1;
			continue;
		}
		const escaped = value[index + 1];
		if (escaped === undefined) {
			decoded += '\\';
			index += 1;
			continue;
		}
		switch (escaped) {
			case '"':
			case '\\':
			case '/':
				decoded += escaped;
				index += 2;
				break;
			case 'b':
				decoded += '\b';
				index += 2;
				break;
			case 'f':
				decoded += '\f';
				index += 2;
				break;
			case 'n':
				decoded += '\n';
				index += 2;
				break;
			case 'r':
				decoded += '\r';
				index += 2;
				break;
			case 't':
				decoded += '\t';
				index += 2;
				break;
			case 'u': {
				const hex = value.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(hex)) {
					decoded += String.fromCharCode(Number.parseInt(hex, 16));
					index += 6;
				} else {
					decoded += '\\u';
					index += 2;
				}
				break;
			}
			default:
				decoded += `\\${escaped}`;
				index += 2;
				break;
		}
	}
	return decoded;
}

function looksLikeAdditionalJsonMember(rawValue: string): boolean {
	for (let index = 0; index < rawValue.length; index += 1) {
		if (rawValue[index] !== '"' || isEscapedJsonStringQuote(rawValue, index)) {
			continue;
		}
		let next = skipJsonWhitespace(rawValue, index + 1);
		if (rawValue[next] === ',') {
			next = skipJsonWhitespace(rawValue, next + 1);
		}
		const key = readJsonStringToken(rawValue, next);
		if (!key) {
			continue;
		}
		const afterKey = skipJsonWhitespace(rawValue, key.end);
		if (rawValue[afterKey] === ':') {
			return true;
		}
	}
	return false;
}

function skipJsonWhitespace(text: string, index: number): number {
	while (index < text.length && isJsonWhitespace(text[index] ?? '')) {
		index += 1;
	}
	return index;
}

function lastNonWhitespaceIndex(text: string): number {
	for (let index = text.length - 1; index >= 0; index -= 1) {
		if (!isJsonWhitespace(text[index] ?? '')) {
			return index;
		}
	}
	return -1;
}

function isJsonWhitespace(char: string): boolean {
	return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

function isEscapedJsonStringQuote(text: string, quoteIndex: number): boolean {
	let slashCount = 0;
	for (let index = quoteIndex - 1; index >= 0 && text[index] === '\\'; index -= 1) {
		slashCount += 1;
	}
	return slashCount % 2 === 1;
}

function providerStructuredOutputFromToolMessage(
	messageValue: unknown,
	spec: ProviderSingleStringResponseSpec & { toolName: string },
	rawResponse: string,
): string {
	const message = runtimeRecord(messageValue);
	const toolCalls = Array.isArray(message.tool_calls)
		? message.tool_calls.map(providerToolCallFromValue).filter((toolCall): toolCall is BotInferenceSubmissionToolCall => Boolean(toolCall))
		: [];
	const errorOptions = { rawResponse, requiredToolName: spec.toolName, toolCalls };
	if (toolCalls.length === 0) {
		throw new ProviderStructuredOutputValidationError(spec.kind, `No ${spec.toolName} tool call was returned.`, errorOptions);
	}
	const wrongToolCall = toolCalls.find((toolCall) => toolCall.function.name !== spec.toolName);
	if (wrongToolCall) {
		throw new ProviderStructuredOutputValidationError(
			spec.kind,
			`Only ${spec.toolName} may be used for this request; ${wrongToolCall.function.name || 'unknown'} cannot be used here.`,
			{
				rawResponse,
				requiredToolName: spec.toolName,
				toolCalls,
			},
		);
	}
	if (toolCalls.length !== 1) {
		throw new ProviderStructuredOutputValidationError(
			spec.kind,
			`Expected exactly one ${spec.toolName} tool call, but received ${toolCalls.length}.`,
			{
				rawResponse,
				requiredToolName: spec.toolName,
				toolCalls,
			},
		);
	}
	const [toolCall] = toolCalls;
	if (toolCall.function.name !== spec.toolName) {
		throw new ProviderStructuredOutputValidationError(
			spec.kind,
			`Expected tool ${spec.toolName}, but received ${toolCall.function.name || 'unknown'}.`,
			{
				rawResponse,
				requiredToolName: spec.toolName,
				toolCalls,
			},
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(toolCall.function.arguments);
	} catch {
		throw new ProviderStructuredOutputValidationError(spec.kind, `The ${spec.toolName} arguments were not valid JSON.`, {
			rawResponse,
			requiredToolName: spec.toolName,
			toolCalls,
		});
	}
	return providerStructuredOutputPropertyFromRecord(parsed, spec, rawResponse, toolCalls);
}

function providerStructuredOutputPropertyFromRecord(
	parsed: unknown,
	spec: ProviderSingleStringResponseSpec,
	rawResponse: string,
	toolCalls: BotInferenceSubmissionToolCall[],
): string {
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ProviderStructuredOutputValidationError(
			spec.kind,
			spec.toolName ? `The ${spec.toolName} arguments must be a JSON object.` : 'The structured output must be a JSON object.',
			{
				rawResponse,
				requiredToolName: spec.toolName,
				toolCalls,
			},
		);
	}
	const record = runtimeRecord(parsed);
	const keys = Object.keys(record);
	const extraKeys = keys.filter((key) => key !== spec.property);
	if (extraKeys.length > 0) {
		throw new ProviderStructuredOutputValidationError(
			spec.kind,
			`Unexpected ${spec.toolName ? 'argument' : 'field'} ${extraKeys.join(', ')}; only ${spec.property} is allowed.`,
			{
				rawResponse,
				requiredToolName: spec.toolName,
				toolCalls,
			},
		);
	}
	const value = record[spec.property];
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new ProviderStructuredOutputValidationError(spec.kind, `The ${spec.label} argument must be a non-empty string.`, {
			rawResponse,
			requiredToolName: spec.toolName,
			toolCalls,
		});
	}
	const minCharacters = Math.max(0, Math.floor(spec.minCharacters ?? 0));
	if (value.length < minCharacters) {
		throw new ProviderStructuredOutputValidationError(
			spec.kind,
			`The ${spec.label} argument must be at least ${minCharacters} characters.`,
			{
				rawResponse,
				requiredToolName: spec.toolName,
				toolCalls,
			},
		);
	}
	const reduction = spec.reduction?.(value);
	if (reduction && !reduction.reduces) {
		throw new ProviderStructuredOutputValidationError(
			spec.kind,
			`The ${spec.label} argument did not reduce the compacted context (${reduction.replacementTokens} estimated replacement tokens vs ${reduction.compactedTokens} compacted tokens).`,
			{
				rawResponse,
				requiredToolName: spec.toolName,
				toolCalls,
				outputText: value,
				validationIssue: 'non_reducing_compaction',
			},
		);
	}
	if (value.length > spec.maxCharacters && !reduction) {
		throw new ProviderStructuredOutputValidationError(
			spec.kind,
			`The ${spec.label} argument must be at most ${spec.maxCharacters} characters.`,
			{
				rawResponse,
				requiredToolName: spec.toolName,
				toolCalls,
				outputText: value,
			},
		);
	}
	return value;
}

type ProviderCompactionReductionCheck = (summary: string) => {
	compactedTokens: number;
	reduces: boolean;
	replacementTokens: number;
};

function providerCompactionReductionCheck(
	limits: Partial<Pick<ProviderCompactionSummaryLimits, 'compactedCharacterCount' | 'tokensPerCharacter'>>,
): ProviderCompactionReductionCheck | undefined {
	const compactedCharacters = Number(limits.compactedCharacterCount);
	const tokensPerCharacter = Number(limits.tokensPerCharacter);
	if (
		!Number.isFinite(compactedCharacters) ||
		compactedCharacters <= 0 ||
		!Number.isFinite(tokensPerCharacter) ||
		tokensPerCharacter <= 0
	) {
		return undefined;
	}
	const calibration = {
		tokensPerCharacter: clampNumber(tokensPerCharacter, minCalibratedTokensPerCharacter, maxCalibratedTokensPerCharacter),
		sampleCount: 0,
	};
	const compactedTokens = Math.max(1, Math.ceil(Math.floor(compactedCharacters) * calibration.tokensPerCharacter));
	return (summary: string) => {
		const replacementTokens = estimateChatMessageTokens({ role: 'assistant', content: storedCompactionSummary(summary) }, calibration);
		return {
			compactedTokens,
			replacementTokens,
			reduces: replacementTokens < compactedTokens,
		};
	};
}

function providerToolCallFromValue(value: unknown, index = 0): BotInferenceSubmissionToolCall | null {
	const record = runtimeRecord(value);
	const fn = runtimeRecord(record.function);
	const name = stringValue(fn.name);
	const args = stringValue(fn.arguments);
	if (!name || args === undefined) {
		return null;
	}
	return {
		id: stringValue(record.id) ?? `call_recovered_${index}`,
		type: 'function',
		function: {
			name,
			arguments: args,
		},
	};
}

function structuredOutputRepairMessages(error: ProviderStructuredOutputValidationError): ChatMessage[] {
	const content = JSON.stringify({
		ok: false,
		code: 'schema_invalid',
		message: error.repairMessage,
	});
	if (error.toolCalls.length === 0) {
		return [
			{
				role: 'assistant',
				content: error.requiredToolName
					? `Actually, I must use the ${error.requiredToolName} tool.`
					: 'Actually, I must reply with the required structured output.',
			},
		];
	}
	return [
		{
			role: 'assistant',
			content: '',
			tool_calls: error.toolCalls,
		},
		...error.toolCalls.map(
			(toolCall): ChatMessage => ({
				role: 'tool',
				tool_call_id: toolCall.id,
				content,
			}),
		),
	];
}

export function providerToolResultPayload(
	name: string,
	result: unknown,
	args: Record<string, unknown> = {},
	scope: ProviderContextContentScope = emptyProviderContextContentScope(),
	options: ProviderToolResultPayloadOptions = {},
): unknown {
	const canonical = canonicalToolName(name);
	if (canonical === 'check_notifications') {
		const record = runtimeRecord(result);
		return providerCheckNotificationsResult(Array.isArray(record.events) ? record.events : [], scope, options.tokenBudget);
	}
	if (canonical === 'list_accessible_forums' && Array.isArray(result)) {
		const forums = result.map((item) => providerForum(runtimeRecord(item)));
		return pruneProviderArrayForBudget(forums, options.tokenBudget).items;
	}
	if (canonical === 'list_recent_threads' && Array.isArray(result)) {
		const threads = result.map((item) => providerThreadSummary(runtimeRecord(item), { includeForum: false }));
		return pruneProviderArrayForBudget(threads, options.tokenBudget).items;
	}
	if (canonical === 'list_hot_threads' && Array.isArray(result)) {
		const threads = result.map((item) => providerThreadSummary(runtimeRecord(item), { includeForum: true }));
		return pruneProviderArrayForBudget(threads, options.tokenBudget).items;
	}
	if (canonical === 'search_threads' || canonical === 'search_threads_semantic') {
		if (!Array.isArray(result)) {
			return providerSafeJsonValue(result);
		}
		const posts = result.map((item) => providerSearchPost(runtimeRecord(item), scope));
		return pruneProviderArrayForBudget(posts, options.tokenBudget).items;
	}
	if (canonical === 'search_profiles' && Array.isArray(result)) {
		const profiles = result.map((item) => providerProfile(runtimeRecord(item)));
		return pruneProviderArrayForBudget(profiles, options.tokenBudget).items;
	}
	if (canonical === 'list_profiles') {
		return providerProfileListResult(runtimeRecord(result), options.tokenBudget);
	}
	if (canonical === 'view_profiles') {
		const record = runtimeRecord(result);
		const profiles = Array.isArray(record.profiles) ? record.profiles : Array.isArray(result) ? result : [result];
		const providerProfiles = profiles.map((item) => providerProfile(runtimeRecord(item)));
		const pruned = pruneProviderArrayForBudget(providerProfiles, options.tokenBudget, (items) => ({ profiles: items }));
		return {
			profiles: pruned.items,
		};
	}
	if (canonical === 'query_followers') {
		return providerFollowerQueryResult(runtimeRecord(result));
	}
	if (canonical === 'view_activity') {
		return providerActivityFeedResult(runtimeRecord(result), options.tokenBudget);
	}
	if (canonical === 'follow_profile' || canonical === 'unfollow_profile') {
		return Array.isArray(result)
			? result.map((item) => providerFollowResult(runtimeRecord(item)))
			: providerFollowResult(runtimeRecord(result));
	}
	if (canonical === 'vote' && Array.isArray(result)) {
		return result.map((item) => providerVoteResult(runtimeRecord(item)));
	}
	if (canonical === 'read_thread' || canonical === 'read_thread_by_id' || canonical === 'read_comment_by_id') {
		return providerReadResult(runtimeRecord(result), scope);
	}
	if (canonical === 'create_thread') {
		return providerCreateThreadResult(result);
	}
	if (canonical === 'reply_to_comment' || canonical === 'make_additional_reply_to_the_same_comment') {
		return providerReplyCommentResult(result, args);
	}
	if (canonical === 'vote') {
		return providerVoteResult(runtimeRecord(result));
	}
	if (canonical === 'log_off') {
		return providerSafeJsonValue(result);
	}
	return providerSafeJsonValue(result);
}

function providerJsonTokenEstimate(value: unknown): number {
	return estimateTextTokens(JSON.stringify(value));
}

function pruneProviderArrayForBudget<T>(
	items: T[],
	tokenBudget: number | undefined,
	payloadForItems: (items: T[]) => unknown = (array) => array,
	removeFrom: 'head' | 'tail' = 'tail',
): ProviderToolArrayPruneResult<T> {
	if (tokenBudget === undefined) {
		return {
			items,
			omittedCount: 0,
			tokenEstimate: providerJsonTokenEstimate(payloadForItems(items)),
		};
	}
	const budget = Math.max(1, Math.floor(tokenBudget));
	const pruned = [...items];
	let omittedCount = 0;
	let tokenEstimate = providerJsonTokenEstimate(payloadForItems(pruned));
	while (pruned.length > 0 && tokenEstimate > budget) {
		if (removeFrom === 'head') {
			pruned.shift();
		} else {
			pruned.pop();
		}
		omittedCount += 1;
		tokenEstimate = providerJsonTokenEstimate(payloadForItems(pruned));
	}
	return {
		items: pruned,
		omittedCount,
		tokenEstimate,
	};
}

function providerToolResultUsesTokenBudget(name: string): boolean {
	const canonical = canonicalToolName(name);
	return (
		canonical === 'check_notifications' ||
		canonical === 'list_accessible_forums' ||
		canonical === 'list_recent_threads' ||
		canonical === 'list_hot_threads' ||
		canonical === 'search_threads' ||
		canonical === 'search_threads_semantic' ||
		canonical === 'search_profiles' ||
		canonical === 'list_profiles' ||
		canonical === 'view_profiles' ||
		canonical === 'view_activity'
	);
}

type ProviderContextContentScope = {
	commentsWithText: Set<string>;
	threadsWithText: Set<string>;
};

function emptyProviderContextContentScope(): ProviderContextContentScope {
	return {
		commentsWithText: new Set(),
		threadsWithText: new Set(),
	};
}

function cloneProviderContextContentScope(scope: ProviderContextContentScope): ProviderContextContentScope {
	return {
		commentsWithText: new Set(scope.commentsWithText),
		threadsWithText: new Set(scope.threadsWithText),
	};
}

function providerCheckNotificationsResult(
	events: unknown[],
	initialScope: ProviderContextContentScope = emptyProviderContextContentScope(),
	tokenBudget?: number,
): Record<string, unknown> {
	return providerCheckNotificationsResultWithInclusions(events, initialScope, tokenBudget).payload;
}

function providerCheckNotificationsResultWithInclusions(
	events: unknown[],
	initialScope: ProviderContextContentScope = emptyProviderContextContentScope(),
	tokenBudget?: number,
): ProviderNotificationPayloadResult {
	const scope = cloneProviderContextContentScope(initialScope);
	const providerEvents = mergedProviderNotificationEventGroups(events.map(runtimeRecord)).map((group) => ({
		notificationIds: group.notificationIds,
		payload: runtimeRecord(providerSafeJsonValue(providerNotificationEvent(group.event, scope))),
	}));
	if (tokenBudget === undefined) {
		return {
			payload: providerNotificationResultPayload(providerEvents.map((event) => event.payload)),
			includedEventIds: providerEvents.flatMap((event) => event.notificationIds),
		};
	}
	const pruned = pruneProviderNotificationEventsForBudget(providerEvents, tokenBudget);
	return {
		payload: providerNotificationResultPayload(
			pruned.events.map((event) => event.payload),
			pruned,
		),
		includedEventIds: pruned.events.flatMap((event) => event.notificationIds),
	};
}

function providerNotificationResultPayload(
	events: Record<string, unknown>[],
	pruned?: Pick<ProviderNotificationPruneResult, 'omittedEventCount'>,
): Record<string, unknown> {
	return removeUndefinedProperties({
		...(pruned && pruned.omittedEventCount > 0 ? { context: providerNotificationResultContext(pruned) } : {}),
		events,
	});
}

function providerNotificationResultContext(pruned: Pick<ProviderNotificationPruneResult, 'omittedEventCount'>): string {
	const parts: string[] = [];
	if (pruned.omittedEventCount > 0) {
		parts.push(
			`${pruned.omittedEventCount} older notification event${pruned.omittedEventCount === 1 ? ' was' : 's were'} omitted to keep this result compact`,
		);
	}
	return `Result of checking notifications. ${parts.join('. ')}.`;
}

function pruneProviderNotificationEventsForBudget(
	events: Array<{ notificationIds: string[]; payload: Record<string, unknown> }>,
	tokenBudget: number,
): ProviderNotificationPruneResult {
	const budget = Math.max(1, Math.floor(tokenBudget));
	const prunedEvents = events.map((event) => ({
		notificationIds: [...event.notificationIds],
		payload: JSON.parse(JSON.stringify(event.payload)) as Record<string, unknown>,
	}));
	let omittedEventCount = 0;
	let tokenEstimate = providerNotificationTokenEstimate(
		prunedEvents.map((event) => event.payload),
		{ omittedEventCount },
	);
	while (prunedEvents.length > 0 && tokenEstimate > budget) {
		prunedEvents.shift();
		omittedEventCount += 1;
		tokenEstimate = providerNotificationTokenEstimate(
			prunedEvents.map((event) => event.payload),
			{ omittedEventCount },
		);
	}
	return {
		events: prunedEvents,
		omittedEventCount,
		tokenEstimate,
	};
}

function providerNotificationTokenEstimate(
	events: Record<string, unknown>[],
	pruned: Pick<ProviderNotificationPruneResult, 'omittedEventCount'>,
): number {
	return estimateTextTokens(JSON.stringify(providerNotificationResultPayload(events, pruned)));
}

function mergedProviderNotificationEventGroups(events: Record<string, unknown>[]): ProviderNotificationEventGroup[] {
	const bySource = new Map<string, ProviderNotificationEventGroup>();
	const order: string[] = [];
	for (const event of events) {
		const sourceObjectId = stringValue(event.sourceObjectId);
		const notificationId = stringValue(event.id);
		const key = sourceObjectId ? `${stringValue(event.type) ?? 'event'}:${sourceObjectId}` : '';
		if (!key) {
			const uniqueKey = `event:${stringValue(event.id) ?? crypto.randomUUID()}`;
			bySource.set(uniqueKey, {
				event: { ...event },
				notificationIds: notificationId ? [notificationId] : [],
			});
			order.push(uniqueKey);
			continue;
		}
		const existing = bySource.get(key);
		if (!existing) {
			bySource.set(key, {
				event: { ...event },
				notificationIds: notificationId ? [notificationId] : [],
			});
			order.push(key);
			continue;
		}
		if (notificationId) {
			existing.notificationIds.push(notificationId);
		}
		existing.event.deliveryReasons = orderedProviderDeliveryReasons([
			...stringArrayValue(existing.event.deliveryReasons),
			...stringArrayValue(event.deliveryReasons),
		]);
	}
	return order.map((key) => bySource.get(key)).filter((event): event is ProviderNotificationEventGroup => Boolean(event));
}

function providerNotificationEvent(event: Record<string, unknown>, scope: ProviderContextContentScope): Record<string, unknown> {
	return removeUndefinedProperties({
		type: stringValue(event.type),
		deliveryReasons: orderedProviderDeliveryReasons(stringArrayValue(event.deliveryReasons)),
		message: providerNotificationMessage(event),
		actor: providerNotificationProfileRef(runtimeRecord(event.actor)),
		target: providerNotificationTargetRef(event.target, scope),
		thread: providerNotificationThreadRef(runtimeRecord(event.thread), scope),
		comment: providerNotificationCommentRef(runtimeRecord(event.comment), scope),
		replyTo: providerNotificationTargetRef(event.replyTo, scope),
		vote: providerNotificationVoteRef(runtimeRecord(event.vote)),
	});
}

function providerNotificationMessage(event: Record<string, unknown>): string | undefined {
	return stringValue(event.type) === 'bootstrap' ? stringValue(event.message) : undefined;
}

function providerNotificationTargetRef(value: unknown, scope: ProviderContextContentScope): Record<string, unknown> | string | undefined {
	const record = runtimeRecord(value);
	if (Object.keys(record).length === 0) {
		return undefined;
	}
	if (stringValue(record.threadId) || stringValue(record.threadRef) || stringValue(record.parentCommentId)) {
		return providerNotificationCommentRef(record, scope);
	}
	if (stringValue(record.title)) {
		return providerNotificationThreadRef(record, scope);
	}
	return providerNotificationProfileRef(record);
}

function providerNotificationProfileRef(record: Record<string, unknown>): string | undefined {
	const username = stringValue(record.username);
	if (!username) {
		return undefined;
	}
	return username.startsWith('u/') ? username : `u/${username}`;
}

function providerNotificationThreadRef(
	record: Record<string, unknown>,
	scope: ProviderContextContentScope,
): Record<string, unknown> | undefined {
	const threadId = parseThreadRef(stringValue(record.threadRef)) ?? stringValue(record.threadId) ?? stringValue(record.id);
	const text = stringValue(record.text) ?? stringValue(record.body) ?? stringValue(runtimeRecord(record.rootPost).body);
	if (!threadId && !stringValue(record.title)) {
		return undefined;
	}
	const includeText = Boolean(threadId && text && !scope.threadsWithText.has(threadId));
	if (threadId && text) {
		scope.threadsWithText.add(threadId);
	}
	return removeUndefinedProperties({
		threadRef: providerThreadRef(threadId),
		title: stringValue(record.title),
		author: providerNotificationProfileRef(runtimeRecord(record.author)),
		...(includeText ? { text } : {}),
	});
}

function providerNotificationCommentRef(
	record: Record<string, unknown>,
	scope: ProviderContextContentScope,
): Record<string, unknown> | undefined {
	const id = parseCommentRef(stringValue(record.commentRef)) ?? stringValue(record.id) ?? stringValue(record.commentId);
	const text = stringValue(record.text) ?? stringValue(record.body);
	const threadId = parseThreadRef(stringValue(record.threadRef)) ?? stringValue(record.threadId);
	if (!id && !threadId) {
		return undefined;
	}
	const includeText = Boolean(id && text && !scope.commentsWithText.has(id));
	if (id && text) {
		scope.commentsWithText.add(id);
	}
	return removeUndefinedProperties({
		commentRef: providerCommentRef(id),
		threadRef: providerThreadRef(threadId),
		author: providerNotificationProfileRef(runtimeRecord(record.author)),
		...(includeText ? { text } : {}),
	});
}

function providerNotificationVoteRef(record: Record<string, unknown>): Record<string, unknown> | undefined {
	if (Object.keys(record).length === 0) {
		return undefined;
	}
	return removeUndefinedProperties({
		threadRef: providerThreadRef(record.threadId ?? record.threadRef),
		commentRef: providerCommentRef(record.commentId ?? record.commentRef),
		value: numberValue(record.value),
	});
}

function orderedProviderDeliveryReasons(reasons: string[]): string[] {
	const order = [
		'bootstrap',
		'direct_reply',
		'mention',
		'personal_forum_post',
		'profile_followed_you',
		'vote_on_your_content',
		'followed_profile_activity',
		'system',
	];
	const unique = new Set(reasons.filter(Boolean));
	const ordered = order.filter((reason) => unique.delete(reason));
	return [...ordered, ...[...unique].sort((left, right) => left.localeCompare(right))];
}

function collectProviderContextContentFromValue(value: unknown, scope: ProviderContextContentScope): void {
	if (typeof value === 'string') {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			return;
		}
		collectProviderContextContentFromValue(parsed, scope);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectProviderContextContentFromValue(item, scope);
		}
		return;
	}
	const record = runtimeRecord(value);
	if (Object.keys(record).length === 0) {
		return;
	}
	const text = stringValue(record.text) ?? stringValue(record.body) ?? stringValue(runtimeRecord(record.rootPost).body);
	if (text) {
		const commentId = commentIdFromProviderContentRecord(record);
		const threadId = parseThreadRef(stringValue(record.threadRef)) ?? stringValue(record.threadId) ?? stringValue(record.id);
		if (commentId) {
			scope.commentsWithText.add(commentId);
		} else if (threadId) {
			scope.threadsWithText.add(threadId);
		}
	}
	for (const item of Object.values(record)) {
		collectProviderContextContentFromValue(item, scope);
	}
}

function commentTextRecordsFromChatMessages(messages: ChatMessage[]): Map<string, string> {
	const records = new Map<string, string>();
	for (const message of messages) {
		collectCommentTextRecordsFromValue(message.content, records);
	}
	return records;
}

function collectCommentTextRecordsFromValue(value: unknown, output: Map<string, string>): void {
	if (typeof value === 'string') {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			return;
		}
		collectCommentTextRecordsFromValue(parsed, output);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectCommentTextRecordsFromValue(item, output);
		}
		return;
	}
	const record = runtimeRecord(value);
	if (Object.keys(record).length === 0) {
		return;
	}
	const commentId = commentIdFromProviderContentRecord(record);
	const text = commentTextFromProviderContentRecord(record);
	if (commentId && text && !output.has(commentId)) {
		output.set(commentId, text);
	}
	for (const item of Object.values(record)) {
		collectCommentTextRecordsFromValue(item, output);
	}
}

function commentReferencesWithoutTextFromValue(value: unknown): Set<string> {
	const refs = new Set<string>();
	collectCommentReferencesWithoutTextFromValue(value, refs);
	return refs;
}

function collectCommentReferencesWithoutTextFromValue(value: unknown, refs: Set<string>): void {
	if (typeof value === 'string') {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			return;
		}
		collectCommentReferencesWithoutTextFromValue(parsed, refs);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectCommentReferencesWithoutTextFromValue(item, refs);
		}
		return;
	}
	const record = runtimeRecord(value);
	if (Object.keys(record).length === 0) {
		return;
	}
	const commentId = commentIdFromProviderContentRecord(record);
	if (commentId && !commentTextFromProviderContentRecord(record)) {
		refs.add(commentId);
	}
	for (const item of Object.values(record)) {
		collectCommentReferencesWithoutTextFromValue(item, refs);
	}
}

function hydrateNewestCommentReferences(
	value: unknown,
	commentIds: ReadonlySet<string>,
	commentBodies: ReadonlyMap<string, string>,
): Set<string> {
	const pending = new Set([...commentIds].filter((commentId) => commentBodies.has(commentId)));
	const hydrated = new Set<string>();
	hydrateNewestCommentReferencesInValue(value, pending, hydrated, commentBodies);
	return hydrated;
}

function hydrateNewestCommentReferencesInValue(
	value: unknown,
	pending: Set<string>,
	hydrated: Set<string>,
	commentBodies: ReadonlyMap<string, string>,
): void {
	if (pending.size === 0) {
		return;
	}
	if (Array.isArray(value)) {
		for (let index = value.length - 1; index >= 0 && pending.size > 0; index -= 1) {
			hydrateNewestCommentReferencesInValue(value[index], pending, hydrated, commentBodies);
		}
		return;
	}
	const record = runtimeRecord(value);
	if (Object.keys(record).length === 0) {
		return;
	}
	const keys = Object.keys(record);
	for (let index = keys.length - 1; index >= 0 && pending.size > 0; index -= 1) {
		const key = keys[index];
		if (key !== undefined) {
			hydrateNewestCommentReferencesInValue(record[key], pending, hydrated, commentBodies);
		}
	}
	const commentId = commentIdFromProviderContentRecord(record);
	if (!commentId || !pending.has(commentId) || commentTextFromProviderContentRecord(record)) {
		return;
	}
	const body = commentBodies.get(commentId);
	if (!body) {
		return;
	}
	record[commentHydrationTextField(record)] = body;
	pending.delete(commentId);
	hydrated.add(commentId);
}

function commentIdFromProviderContentRecord(record: Record<string, unknown>): string | undefined {
	const explicitCommentId = parseCommentRef(stringValue(record.commentRef)) ?? stringValue(record.commentId);
	if (explicitCommentId) {
		return explicitCommentId;
	}
	const type = stringValue(record.type);
	if (type === 'comment') {
		return stringValue(record.id);
	}
	if (stringValue(record.parentCommentId)) {
		return stringValue(record.id);
	}
	const id = stringValue(record.id);
	if (
		id &&
		(stringValue(record.threadId) || stringValue(record.threadRef)) &&
		!stringValue(record.title) &&
		(record.author !== undefined || stringValue(record.authorHandle) || stringValue(record.authorDisplayName))
	) {
		return id;
	}
	return undefined;
}

function commentTextFromProviderContentRecord(record: Record<string, unknown>): string | undefined {
	return rawNonEmptyString(record.body) ?? rawNonEmptyString(record.text);
}

function commentHydrationTextField(record: Record<string, unknown>): 'body' | 'text' {
	if (stringValue(record.type) === 'comment' || 'body' in record) {
		return 'body';
	}
	return 'text';
}

function rawNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function removeUndefinedProperties(record: Record<string, unknown>): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (value !== undefined) {
			output[key] = value;
		}
	}
	return output;
}

const providerRelativeTimeUnits: Array<{ name: string; ms: number }> = [
	{ name: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
	{ name: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
	{ name: 'day', ms: 24 * 60 * 60 * 1000 },
	{ name: 'hour', ms: 60 * 60 * 1000 },
	{ name: 'minute', ms: 60 * 1000 },
];

function providerRelativeTime(value: unknown, nowMs = Date.now()): string | undefined {
	const text = stringValue(value);
	if (!text) {
		return undefined;
	}
	const timeMs = Date.parse(text);
	if (!Number.isFinite(timeMs)) {
		return text;
	}
	const diffMs = nowMs - timeMs;
	const absMs = Math.abs(diffMs);
	if (absMs < 60 * 1000) {
		return 'just now';
	}
	const unit = providerRelativeTimeUnits.find((candidate) => absMs >= candidate.ms) ?? providerRelativeTimeUnits.at(-1)!;
	const count = Math.max(1, Math.floor(absMs / unit.ms));
	const label = `${count} ${unit.name}${count === 1 ? '' : 's'}`;
	return diffMs < 0 ? `in ${label}` : `${label} ago`;
}

function providerUsername(value: unknown): string | undefined {
	const raw = stringValue(value);
	if (!raw) {
		return undefined;
	}
	const handle = raw.replace(/^u\//, '');
	return handle ? `u/${handle}` : undefined;
}

function providerProfileUsername(record: Record<string, unknown>): string | undefined {
	return providerUsername(record.username) ?? providerUsername(record.handle) ?? providerUsername(record.authorHandle);
}

function providerAuthorUsername(record: Record<string, unknown>): string | undefined {
	const author = runtimeRecord(record.author);
	return providerProfileUsername(author) ?? providerUsername(record.authorHandle) ?? providerUsername(record.handle);
}

function providerForumName(value: unknown): string | undefined {
	const raw = stringValue(value);
	if (!raw) {
		return undefined;
	}
	const handle = raw.replace(/^f\//, '');
	return handle ? `f/${handle}` : undefined;
}

function providerForumNameFromRecord(record: Record<string, unknown>): string | undefined {
	return providerForumName(record.forum) ?? providerForumName(record.handle) ?? providerForumName(record.forumHandle);
}

function providerThreadRef(value: unknown): string | undefined {
	const threadId = parseThreadRef(stringValue(value));
	return threadId ? formatThreadRef(threadId) : undefined;
}

function providerCommentRef(value: unknown): string | undefined {
	const commentId = parseCommentRef(stringValue(value));
	return commentId ? formatCommentRef(commentId) : undefined;
}

function providerFollowResult(record: Record<string, unknown>): Record<string, unknown> {
	const reason = localizedArgumentText(record.reason);
	return removeUndefinedProperties({
		following: record.following === true,
		...(record.profile ? { profile: providerProfileUsername(runtimeRecord(record.profile)) } : {}),
		...(reason ? { reason } : {}),
	});
}

function providerVoteResult(record: Record<string, unknown>): Record<string, unknown> {
	const thread = threadRecordFromToolResult(record);
	const commentId = stringValue(record.commentId) ?? stringValue(record.targetId);
	return removeUndefinedProperties({
		commentRef: providerCommentRef(commentId),
		value: numberValue(record.value),
		...(thread ? { target: providerVoteTargetReference(thread, record) } : {}),
	});
}

function providerCreateThreadResult(result: unknown): Record<string, unknown> {
	const thread = threadRecordFromToolResult(result) ?? runtimeRecord(result);
	return {
		ok: true,
		thread: providerThreadReference(thread),
	};
}

function providerReplyCommentResult(result: unknown, args: Record<string, unknown>): Record<string, unknown> {
	const record = runtimeRecord(result);
	const thread = threadRecordFromToolResult(record) ?? runtimeRecord(record.thread);
	const comment = runtimeRecord(record.comment);
	const createdComment = stringValue(comment.id) || stringValue(comment.commentId) ? comment : replyCommentFromThread(thread, args);
	return {
		ok: true,
		...(createdComment ? { comment: providerCommentReference(thread, createdComment) } : {}),
	};
}

function providerForum(record: Record<string, unknown>): Record<string, unknown> {
	return {
		forum: providerForumNameFromRecord(record) ?? 'f/unknown',
		description: stringValue(record.description) ?? '',
	};
}

function providerThreadSummary(record: Record<string, unknown>, options: { includeForum?: boolean } = {}): Record<string, unknown> {
	return removeUndefinedProperties({
		threadRef: providerThreadRef(stringValue(record.threadRef) ?? stringValue(record.threadId) ?? stringValue(record.id)),
		rootCommentRef: providerCommentRef(record.rootCommentId),
		...(options.includeForum ? { forum: providerForumNameFromRecord(record) ?? 'f/unknown' } : {}),
		title: stringValue(record.title) ?? 'untitled',
		author: providerAuthorUsername(record),
		commentCount: numberValue(record.commentCount),
		voteScore: numberValue(record.voteScore),
		lastActivity: providerRelativeTime(record.lastActivityAt),
	});
}

function providerSearchPost(
	record: Record<string, unknown>,
	scope: ProviderContextContentScope = emptyProviderContextContentScope(),
): Record<string, unknown> {
	const commentId = stringValue(record.commentId) ?? stringValue(record.rootCommentId);
	const threadId = stringValue(record.threadId);
	const snippet = stringValue(record.snippet);
	const snippetAlreadyInContext =
		(commentId ? scope.commentsWithText.has(commentId) : false) || (!commentId && threadId ? scope.threadsWithText.has(threadId) : false);
	return removeUndefinedProperties({
		threadRef: providerThreadRef(threadId),
		...(commentId ? { commentRef: providerCommentRef(commentId) } : {}),
		forum: providerForumNameFromRecord(record) ?? 'f/unknown',
		title: stringValue(record.title) ?? 'untitled',
		...(snippet && !snippetAlreadyInContext ? { snippet } : {}),
		author: providerAuthorUsername(record),
		when: providerRelativeTime(record.createdAt),
	});
}

function providerProfile(record: Record<string, unknown>): Record<string, unknown> {
	return {
		username: providerProfileUsername(record),
		displayName: stringValue(record.displayName) ?? 'unknown',
		shortBio: stringValue(record.shortBio) ?? '',
		isFollowedByMe: record.isFollowedByMe === true,
		isFollowingMe: record.isFollowingMe === true,
		followers: numberValue(record.followers) ?? 0,
	};
}

function providerProfileListResult(record: Record<string, unknown>, tokenBudget?: number): Record<string, unknown> {
	const profiles = Array.isArray(record.profiles) ? record.profiles.map((item) => providerProfile(runtimeRecord(item))) : [];
	const mode = stringValue(record.mode) === 'random' ? 'random' : 'window';
	const limit = numberValue(record.limit) ?? profiles.length;
	const total = numberValue(record.total) ?? profiles.length;
	const pruned = pruneProviderArrayForBudget(profiles, tokenBudget, (items) => ({ profiles: items }));
	if (mode === 'random') {
		return {
			mode,
			limit,
			total,
			profiles: pruned.items,
		};
	}
	return {
		mode,
		offset: numberValue(record.offset) ?? 0,
		limit,
		total,
		hasMore: record.hasMore === true,
		profiles: pruned.items,
	};
}

function providerFollowerQueryResult(record: Record<string, unknown>): BotFollowUsernameQueryResult {
	return {
		total: numberValue(record.total) ?? 0,
		usernames: stringArrayValue(record.usernames).map((username) => providerUsername(username) ?? username),
	};
}

function providerReadResult(
	record: Record<string, unknown>,
	scope: ProviderContextContentScope = emptyProviderContextContentScope(),
): Record<string, unknown> {
	const content = Array.isArray(record.content) ? providerReadContentTree(record.content.map(runtimeRecord), scope) : [];
	const collapsedReplyCount = providerCollapsedReplyCount(content);
	const trimmedBodyCount = providerTrimmedCommentBodyCount(content);
	const baseContext = stringValue(record.context) ?? 'Result of my read operation.';
	return {
		operation: stringValue(record.operation) ?? 'read',
		context: providerReadContextWithGuidance(baseContext, collapsedReplyCount, trimmedBodyCount),
		thread: providerThreadSummary(runtimeRecord(record.thread)),
		...(stringValue(record.targetCommentId) ? { targetCommentRef: providerCommentRef(record.targetCommentId) } : {}),
		content,
	};
}

function providerReadContentTree(
	records: Record<string, unknown>[],
	scope: ProviderContextContentScope = emptyProviderContextContentScope(),
): Record<string, unknown>[] {
	const roots: Record<string, unknown>[] = [];
	const comments: Record<string, unknown>[] = [];
	for (const record of records) {
		const item = providerReadContent(record, scope);
		if (isProviderComment(item)) {
			comments.push(item);
		} else {
			roots.push(item);
		}
	}
	return [...roots, ...providerNestedCommentList(comments)];
}

function providerReadContent(record: Record<string, unknown>, scope: ProviderContextContentScope): Record<string, unknown> {
	const type = stringValue(record.type) ?? (stringValue(record.commentId) ? 'comment' : 'item');
	const id = stringValue(record.id) ?? stringValue(record.commentId);
	const commentId = type === 'comment' ? (stringValue(record.commentId) ?? id) : stringValue(record.commentId);
	const body = stringValue(record.body) ?? stringValue(record.text);
	const includeBody = type === 'comment' ? Boolean(commentId && body && !scope.commentsWithText.has(commentId)) : body !== undefined;
	if (type === 'comment' && commentId && body) {
		scope.commentsWithText.add(commentId);
	}
	const item = removeUndefinedProperties({
		...(commentId ? { commentRef: providerCommentRef(commentId) } : {}),
		...(stringValue(record.parentCommentId) ? { parentCommentId: stringValue(record.parentCommentId) } : {}),
		author: providerReadAuthor(record),
		...(stringValue(record.title) ? { title: stringValue(record.title) } : {}),
		...(includeBody ? { body: body ?? '' } : {}),
		...(record['My focus is on this comment'] === true || record.target === true ? { 'My focus is on this comment': true } : {}),
		...(record.ancestorOnly ? { ancestorOnly: true } : {}),
	});
	if (type !== 'comment') {
		return item;
	}
	return {
		...item,
		replies: providerReadReplies(record.replies, scope),
	};
}

function providerReadAuthor(record: Record<string, unknown>): string | undefined {
	return providerAuthorUsername(record);
}

function providerReadReplies(value: unknown, scope: ProviderContextContentScope): Record<string, unknown>[] | number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.max(0, Math.floor(value));
	}
	return Array.isArray(value) ? providerReadContentTree(value.map(runtimeRecord), scope).filter(isProviderComment) : [];
}

function providerNestedCommentList(comments: Record<string, unknown>[]): Record<string, unknown>[] {
	const byId = new Map<string, Record<string, unknown>>();
	const ordered = comments.map((comment) => {
		const node: Record<string, unknown> = {
			...comment,
			replies: providerNestedReplies(comment.replies),
		};
		const id = providerCommentId(node);
		if (id) {
			byId.set(id, node);
		}
		return node;
	});
	const roots: Record<string, unknown>[] = [];
	for (const node of ordered) {
		const parentId = stringValue(node.parentCommentId);
		const parent = parentId ? byId.get(parentId) : undefined;
		if (parent && parent !== node) {
			pushProviderReply(parent, node);
		} else {
			roots.push(node);
		}
	}
	return roots.map(providerCommentWithoutInternalNestingMetadata);
}

function providerCommentReplies(comment: Record<string, unknown>): Record<string, unknown>[] {
	return Array.isArray(comment.replies) ? comment.replies.map(runtimeRecord) : [];
}

function providerCommentWithoutInternalNestingMetadata(comment: Record<string, unknown>): Record<string, unknown> {
	const { parentCommentId: _parentCommentId, ...rest } = comment;
	return {
		...rest,
		replies: providerNestedReplies(rest.replies),
	};
}

function providerNestedReplies(value: unknown): Record<string, unknown>[] | number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.max(0, Math.floor(value));
	}
	return Array.isArray(value)
		? value.map(runtimeRecord).filter(isProviderComment).map(providerCommentWithoutInternalNestingMetadata)
		: [];
}

function providerCollapsedReplyCount(content: Record<string, unknown>[]): number {
	return content.reduce((total, item) => {
		if (typeof item.replies === 'number' && Number.isFinite(item.replies)) {
			return total + Math.max(0, Math.floor(item.replies));
		}
		return total + providerCollapsedReplyCount(providerCommentReplies(item));
	}, 0);
}

function providerTrimmedCommentBodyCount(content: Record<string, unknown>[]): number {
	return content.reduce((total, item) => {
		const body = stringValue(item.body);
		const current = body?.endsWith(readBodyTrimEllipsis) ? 1 : 0;
		return total + current + providerTrimmedCommentBodyCount(providerCommentReplies(item));
	}, 0);
}

function readResultContext(operation: string, pruned: ReadPruneResult, tokenBudget: number): string {
	const changed = pruned.omittedReplyCount > 0 || pruned.trimmedBodyCount > 0;
	const detail =
		pruned.omittedReplyCount > 0 && pruned.trimmedBodyCount > 0
			? 'Some reply lists were collapsed and some comment bodies were shortened'
			: pruned.omittedReplyCount > 0
				? 'Some reply lists were collapsed'
				: pruned.trimmedBodyCount > 0
					? 'Some comment bodies were shortened'
					: '';
	const baseContext = changed
		? `Result of my ${operation} operation. ${detail} to keep the result within about ${tokenBudget} tokens.`
		: `Result of my ${operation} operation.`;
	return providerReadContextWithGuidance(baseContext, pruned.omittedReplyCount, pruned.trimmedBodyCount);
}

function providerReadContextWithGuidance(baseContext: string, collapsedReplyCount: number, trimmedBodyCount: number): string {
	let context = baseContext;
	if (collapsedReplyCount > 0 && !context.includes('numeric replies value')) {
		context = `${context} A numeric replies value means that many direct replies are omitted; call read_comment_by_id with that comment ref to inspect that branch.`;
	}
	if (trimmedBodyCount > 0 && !context.includes('body ending')) {
		context = `${context} A body ending in ${readBodyTrimEllipsis} has been shortened; call read_comment_by_id with that comment ref to read the full comment.`;
	}
	return context;
}

function pushProviderReply(parent: Record<string, unknown>, reply: Record<string, unknown>): void {
	const replies = providerCommentReplies(parent);
	const replyId = providerCommentId(reply);
	if (!replyId || !replies.some((existing) => providerCommentId(existing) === replyId)) {
		replies.push(reply);
	}
	parent.replies = replies;
}

function isProviderComment(record: Record<string, unknown>): boolean {
	return (
		stringValue(record.type) === 'comment' || Boolean(parseCommentRef(stringValue(record.commentRef)) ?? stringValue(record.commentId))
	);
}

function providerCommentId(record: Record<string, unknown>): string | undefined {
	return parseCommentRef(stringValue(record.commentRef)) ?? stringValue(record.commentId) ?? stringValue(record.id);
}

function providerCommentReference(thread: Record<string, unknown>, comment: Record<string, unknown>): Record<string, unknown> {
	const commentId = providerCommentId(comment);
	const threadId = stringValue(comment.threadId) ?? stringValue(thread.id) ?? stringValue(thread.threadId);
	return removeUndefinedProperties({
		commentRef: providerCommentRef(commentId),
		threadRef: providerThreadRef(threadId),
	});
}

function providerThreadReference(thread: Record<string, unknown>): Record<string, unknown> {
	const threadId = parseThreadRef(stringValue(thread.threadRef)) ?? stringValue(thread.id) ?? stringValue(thread.threadId);
	const rootPost = runtimeRecord(thread.rootPost);
	const title = stringValue(thread.title) ?? stringValue(rootPost.title);
	return removeUndefinedProperties({
		threadRef: providerThreadRef(threadId),
		rootCommentRef: providerCommentRef(stringValue(thread.rootCommentId) ?? stringValue(rootPost.id) ?? stringValue(rootPost.commentId)),
		...(title ? { title } : {}),
	});
}

function providerVoteTargetReference(thread: Record<string, unknown>, vote: Record<string, unknown>): Record<string, unknown> {
	const targetId = stringValue(vote.commentId) ?? stringValue(vote.targetId);
	const comment = allThreadCommentRecords(thread).find((item) => providerCommentId(item) === targetId);
	return comment
		? providerCommentReference(thread, comment)
		: removeUndefinedProperties({
				commentRef: providerCommentRef(targetId),
				threadRef: providerThreadRef(stringValue(thread.id) ?? stringValue(thread.threadId)),
			});
}

function replyCommentFromThread(thread: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> | null {
	const body = localizedArgumentText(args.body);
	const parentCommentId = stringValue(args.parentCommentId) ?? stringValue(args.commentId);
	const comments = allThreadCommentRecords(thread);
	const candidates = comments.filter((comment) => {
		if (body && stringValue(comment.body) !== body) {
			return false;
		}
		const commentParentId = stringValue(comment.parentCommentId);
		return parentCommentId ? commentParentId === parentCommentId : !commentParentId;
	});
	return (
		candidates.sort((left, right) => Date.parse(stringValue(right.createdAt) ?? '') - Date.parse(stringValue(left.createdAt) ?? ''))[0] ??
		null
	);
}

function allThreadCommentRecords(thread: Record<string, unknown>): Record<string, unknown>[] {
	const comments = Array.isArray(thread.comments) ? thread.comments.map(runtimeRecord) : [];
	const result: Record<string, unknown>[] = [];
	const visit = (comment: Record<string, unknown>) => {
		result.push(comment);
		for (const reply of providerCommentReplies(comment)) {
			visit(reply);
		}
	};
	for (const comment of comments) {
		visit(comment);
	}
	return result;
}

function providerActivityFeedResult(record: Record<string, unknown>, tokenBudget?: number): Record<string, unknown> {
	const profile = providerProfileUsername(runtimeRecord(record.bot));
	const activities = Array.isArray(record.activities) ? record.activities.map((item) => providerActivity(runtimeRecord(item))) : [];
	const payloadForActivities = (items: Record<string, unknown>[]) =>
		removeUndefinedProperties({
			profile,
			activities: items,
		});
	if (tokenBudget === undefined) {
		return payloadForActivities(activities);
	}
	trimProviderActivityBodyPreviewsForBudget(activities, tokenBudget, payloadForActivities);
	const pruned = pruneProviderArrayForBudget(activities, tokenBudget, payloadForActivities);
	return payloadForActivities(pruned.items);
}

function providerActivity(record: Record<string, unknown>): Record<string, unknown> {
	const type = stringValue(record.type);
	if (type === 'thread') {
		return removeUndefinedProperties({
			type,
			threadRef: providerThreadRef(record.threadId),
			forum: providerForumNameFromRecord(record),
			title: stringValue(record.title),
			bodyPreview: providerBodyPreview(record.bodyPreview),
			voteScore: numberValue(record.voteScore),
			commentCount: numberValue(record.commentCount),
			when: providerRelativeTime(record.createdAt),
		});
	}
	if (type === 'comment') {
		return removeUndefinedProperties({
			type,
			commentRef: providerCommentRef(record.commentId),
			forum: providerForumNameFromRecord(record),
			bodyPreview: providerBodyPreview(record.bodyPreview),
			replyTo: providerActivityCommentContext(runtimeRecord(record.parentComment), { includeCommentId: false }),
			when: providerRelativeTime(record.createdAt),
		});
	}
	if (type === 'vote') {
		const reason = localizedArgumentText(record.reason);
		return removeUndefinedProperties({
			type,
			commentRef: providerCommentRef(record.commentId ?? record.targetId),
			value: numberValue(record.value),
			threadRef: providerThreadRef(record.threadId),
			forum: providerForumNameFromRecord(record),
			title: localizedArgumentText(record.title),
			...(reason ? { reason } : {}),
			targetComment: providerActivityCommentContext(runtimeRecord(record.targetComment)),
			when: providerRelativeTime(record.updatedAt ?? record.createdAt),
		});
	}
	if (type === 'follow' || type === 'unfollow') {
		const reason = localizedArgumentText(record.reason);
		return removeUndefinedProperties({
			type,
			profile: providerProfileUsername(runtimeRecord(record.bot)),
			...(reason ? { reason } : {}),
			when: providerRelativeTime(record.createdAt),
		});
	}
	return removeUndefinedProperties({
		type,
		when: providerRelativeTime(record.createdAt ?? record.updatedAt),
	});
}

function providerActivityCommentContext(
	record: Record<string, unknown>,
	options: { includeCommentId?: boolean } = {},
): Record<string, unknown> | undefined {
	const commentId = stringValue(record.commentId);
	const author = providerUsername(record.authorHandle);
	const bodyPreview = providerBodyPreview(record.bodyPreview);
	if (!commentId && !author && !bodyPreview) {
		return undefined;
	}
	return removeUndefinedProperties({
		...(options.includeCommentId === false ? {} : { commentRef: providerCommentRef(commentId) }),
		author,
		bodyPreview,
	});
}

function providerBodyPreview(value: unknown): string | undefined {
	const text = stringValue(value);
	if (!text) {
		return undefined;
	}
	const codePoints = Array.from(text);
	if (codePoints.length >= 240 && !text.endsWith(readBodyTrimEllipsis)) {
		return `${text.trimEnd()}${readBodyTrimEllipsis}`;
	}
	return text;
}

function trimProviderActivityBodyPreviewsForBudget(
	activities: Record<string, unknown>[],
	tokenBudget: number,
	payloadForActivities: (items: Record<string, unknown>[]) => unknown,
): void {
	const budget = Math.max(1, Math.floor(tokenBudget));
	if (providerJsonTokenEstimate(payloadForActivities(activities)) <= budget) {
		return;
	}
	const candidates = providerBodyPreviewTrimCandidates(activities);
	if (candidates.length === 0) {
		return;
	}
	const maxLength = Math.max(...candidates.map((candidate) => candidate.codePoints.length));
	let low = 0;
	let high = Math.max(0, maxLength - 2);
	let bestCutoff: number | null = null;
	while (low <= high) {
		const cutoff = Math.floor((low + high) / 2);
		applyProviderBodyPreviewCutoff(candidates, cutoff);
		const tokenEstimate = providerJsonTokenEstimate(payloadForActivities(activities));
		if (tokenEstimate <= budget) {
			bestCutoff = cutoff;
			low = cutoff + 1;
		} else {
			high = cutoff - 1;
		}
	}
	applyProviderBodyPreviewCutoff(candidates, bestCutoff ?? 0);
}

function providerBodyPreviewTrimCandidates(
	value: unknown,
): Array<{ record: Record<string, unknown>; bodyPreview: string; codePoints: string[] }> {
	const candidates: Array<{ record: Record<string, unknown>; bodyPreview: string; codePoints: string[] }> = [];
	const visit = (item: unknown): void => {
		if (Array.isArray(item)) {
			for (const child of item) {
				visit(child);
			}
			return;
		}
		const record = runtimeRecord(item);
		if (Object.keys(record).length === 0) {
			return;
		}
		const bodyPreview = stringValue(record.bodyPreview);
		if (bodyPreview) {
			const codePoints = Array.from(bodyPreview);
			if (codePoints.length > 1) {
				candidates.push({ record, bodyPreview, codePoints });
			}
		}
		for (const child of Object.values(record)) {
			visit(child);
		}
	};
	visit(value);
	return candidates;
}

function applyProviderBodyPreviewCutoff(
	candidates: Array<{ record: Record<string, unknown>; bodyPreview: string; codePoints: string[] }>,
	cutoff: number,
): void {
	for (const candidate of candidates) {
		if (candidate.codePoints.length > cutoff) {
			const prefix = candidate.codePoints.slice(0, cutoff).join('').trimEnd();
			candidate.record.bodyPreview = `${prefix}${readBodyTrimEllipsis}`;
		} else {
			candidate.record.bodyPreview = candidate.bodyPreview;
		}
	}
}

function providerSafeJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(providerSafeJsonValue);
	}
	if (!value || typeof value !== 'object') {
		return value;
	}
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const safeKey = providerSafeKey(key);
		if (!safeKey) {
			continue;
		}
		if (providerTimestampKey(safeKey)) {
			output[safeKey] = providerRelativeTime(item) ?? providerSafeJsonValue(item);
		} else {
			output[safeKey] = providerSafeJsonValue(item);
		}
	}
	return output;
}

function providerTimestampKey(key: string): boolean {
	return /(?:At|_at)$/.test(key);
}

const providerPrivateJsonKeys = new Set([
	'accesstoken',
	'apikey',
	'createdbyuserid',
	'openrouterapikey',
	'owneruserid',
	'password',
	'refreshtoken',
	'secret',
	'session',
	'sessionid',
	'sessiontoken',
	'token',
	'userid',
]);

function providerSafeKey(key: string): string | null {
	const normalized = key.replace(/[_-]/g, '').toLowerCase();
	if (providerPrivateJsonKeys.has(normalized) || normalized.endsWith('apikey') || normalized.endsWith('secret') || normalized.endsWith('token')) {
		return null;
	}
	return key;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function providerUsageFromValue(value: unknown): ProviderUsage | undefined {
	const record = runtimeRecord(value);
	const promptTokens = integerValue(record.prompt_tokens);
	const completionTokens = integerValue(record.completion_tokens);
	const totalTokens = integerValue(record.total_tokens);
	if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
		return undefined;
	}
	const promptDetails = runtimeRecord(record.prompt_tokens_details);
	const completionDetails = runtimeRecord(record.completion_tokens_details);
	return {
		promptTokens,
		completionTokens,
		totalTokens,
		cachedTokens: integerValue(promptDetails.cached_tokens) ?? 0,
		reasoningTokens: integerValue(completionDetails.reasoning_tokens) ?? 0,
		cost: numberValue(record.cost) ?? null,
		raw: record,
	};
}

function providerJsonRequestHeaders(settings: Pick<ProviderSettings, 'apiKey' | 'baseUrl'>): Record<string, string> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
	};
	if (settings.apiKey) {
		headers.authorization = `Bearer ${settings.apiKey}`;
	}
	if (isOpenRouterProviderBaseUrl(settings.baseUrl)) {
		headers[openRouterExperimentalMetadataHeader] = 'enabled';
	}
	return headers;
}

function providerStreamFetchResponse(response: ProviderStreamFetchResponse): Readonly<{
	stream: ReadableStream<Uint8Array>;
	responseId?: string;
}> {
	if (response && typeof response === 'object' && 'stream' in response) {
		return response;
	}
	return { stream: response };
}

function openRouterGenerationIdFromHeaders(headers: Headers): string | undefined {
	return trimmed(headers.get(openRouterGenerationIdHeader) ?? undefined);
}

function openRouterMetadataProviderName(payload: unknown): string | null {
	const metadata = runtimeRecord(payload);
	const direct = normalizedProviderName(
		stringValue(metadata.provider_name) ?? stringValue(metadata.provider) ?? stringValue(metadata.selected_provider),
	);
	if (direct) {
		return direct;
	}

	const endpoints = runtimeRecord(metadata.endpoints);
	const available = Array.isArray(endpoints.available) ? endpoints.available.map(runtimeRecord) : [];
	const selectedEndpoint = available.find((item) => item.selected === true) ?? (available.length === 1 ? available[0] : undefined);
	const selectedProvider = normalizedProviderName(stringValue(selectedEndpoint?.provider) ?? stringValue(selectedEndpoint?.provider_name));
	if (selectedProvider) {
		return selectedProvider;
	}

	const attempts = Array.isArray(metadata.attempts) ? metadata.attempts.map(runtimeRecord) : [];
	const successfulAttempt = attempts.find((item) => {
		const status = numberValue(item.status);
		return status !== undefined && status >= 200 && status < 300;
	});
	const attemptProvider = normalizedProviderName(
		stringValue(successfulAttempt?.provider) ??
			stringValue(successfulAttempt?.provider_name) ??
			stringValue(attempts.at(-1)?.provider) ??
			stringValue(attempts.at(-1)?.provider_name),
	);
	return attemptProvider;
}

async function fetchOpenRouterGenerationProviderName(baseUrl: string, apiKey: string, providerResponseId: string): Promise<string | null> {
	const endpoint = openRouterGenerationMetadataUrl(baseUrl, providerResponseId);
	const signal = new AbortController().signal;
	const response = await providerFetchWithHeaderTimeout(
		endpoint,
		{
			method: 'GET',
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${apiKey}`,
			},
		},
		signal,
		openRouterGenerationMetadataTimeoutMs,
	);
	if (!response.ok) {
		await readLimitedText(response.body, openRouterGenerationMetadataMaxBytes, {
			signal,
			timeoutMs: openRouterGenerationMetadataTimeoutMs,
			timeoutError: () => new ProviderResponseBodyTimeoutError(openRouterGenerationMetadataTimeoutMs),
		});
		return null;
	}
	return openRouterGenerationProviderNameFromPayload(
		await readJsonResponse(
			response,
			openRouterGenerationMetadataMaxBytes,
			signal,
			openRouterGenerationMetadataTimeoutMs,
			() => new ProviderResponseBodyTimeoutError(openRouterGenerationMetadataTimeoutMs),
		),
	);
}

function openRouterGenerationMetadataUrl(baseUrl: string, providerResponseId: string): string {
	const url = new URL(baseUrl);
	url.pathname = '/api/v1/generation';
	url.search = '';
	url.searchParams.set('id', providerResponseId.trim());
	return url.toString();
}

function openRouterGenerationProviderNameFromPayload(payload: unknown): string | null {
	return normalizedProviderName(stringValue(runtimeRecord(runtimeRecord(payload).data).provider_name));
}

function providerNameFromBaseUrl(baseUrl: string): string | null {
	try {
		return normalizedProviderName(new URL(baseUrl).hostname);
	} catch {
		return null;
	}
}

function normalizedProviderName(value: string | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.slice(0, 120);
}

function providerStreamErrorFromChunk(chunk: {
	id?: unknown;
	model?: unknown;
	usage?: unknown;
	error?: unknown;
}): ProviderRequestError | null {
	const error = runtimeRecord(chunk.error);
	if (Object.keys(error).length === 0) {
		return null;
	}
	const status = providerErrorStatus(error.code);
	const message = stringValue(error.message) ?? 'Provider returned error';
	const metadata = runtimeRecord(error.metadata);
	const errorType = stringValue(metadata.error_type);
	const body = errorType ? `${message} (${errorType})` : message;
	const responseId = stringValue(chunk.id);
	const responseModel = stringValue(chunk.model);
	const usage = providerUsageFromValue(chunk.usage);
	return new ProviderRequestError(status, responseModel ?? 'unknown', 'stream', body, {
		rawResponse: JSON.stringify(chunk),
		...(responseId ? { responseId } : {}),
		...(responseModel ? { responseModel } : {}),
		...(usage ? { usage } : {}),
	});
}

function providerErrorStatus(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.max(400, Math.floor(value));
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return Math.max(400, Math.floor(parsed));
		}
	}
	return 502;
}

function providerResponseLogPayload(response: ProviderResponse, status: BotLoopMessageStatus): Record<string, unknown> {
	return {
		status,
		...(response.responseId ? { responseId: response.responseId } : {}),
		...(response.responseModel ? { responseModel: response.responseModel } : {}),
		...(response.skippedRawResponse ? { rawResponse: response.skippedRawResponse } : {}),
		message: {
			role: 'assistant',
			content: response.content || null,
			...(response.reasoning ? { reasoning: response.reasoning } : {}),
			...(response.reasoningDetails.length > 0 ? { reasoning_details: response.reasoningDetails } : {}),
			...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {}),
		},
		...(response.usage
			? {
					usage: {
						promptTokens: response.usage.promptTokens,
						completionTokens: response.usage.completionTokens,
						totalTokens: response.usage.totalTokens,
						cachedTokens: response.usage.cachedTokens,
						reasoningTokens: response.usage.reasoningTokens,
						cost: response.usage.cost,
						raw: response.usage.raw,
					},
				}
			: {}),
	};
}

function centralInferenceUsageRecord(bot: BotDocument, row: ProviderUsageExportRow, exportedAt: string): BotInferenceUsageRecord {
	return {
		botId: bot.id,
		ownerUserId: bot.ownerUserId,
		homeWorldId: bot.homeWorldId,
		homeWorldHandle: bot.homeWorldHandle,
		sourceUsageId: row.id,
		runId: row.run_id,
		requestSeq: row.request_seq,
		createdAt: row.created_at,
		requestedModel: row.requested_model,
		responseModel: row.response_model,
		model: row.model,
		contextWindowTokens: row.context_window_tokens,
		providerBaseUrl: row.provider_base_url,
		providerName: row.provider_name,
		promptTokens: row.prompt_tokens,
		completionTokens: row.completion_tokens,
		totalTokens: row.total_tokens,
		cachedTokens: row.cached_tokens,
		reasoningTokens: row.reasoning_tokens,
		cost: row.cost,
		exportedAt,
	};
}

function emptyUsageTotals(): BotTokenUsageTotals {
	return {
		requestCount: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		reasoningTokens: 0,
		cost: null,
	};
}

function addUsageRow(total: BotTokenUsageTotals, row: ProviderUsageRow): void {
	total.requestCount += 1;
	total.promptTokens += row.prompt_tokens;
	total.completionTokens += row.completion_tokens;
	total.totalTokens += row.total_tokens;
	total.cachedTokens += row.cached_tokens;
	total.reasoningTokens += row.reasoning_tokens;
	if (row.cost !== null) {
		total.cost = (total.cost ?? 0) + row.cost;
	}
}

function compareTokenUsageModelBreakdowns(left: BotTokenUsageModelBreakdown, right: BotTokenUsageModelBreakdown): number {
	const model = left.model.localeCompare(right.model);
	if (model !== 0) {
		return model;
	}
	const tokens = right.totalTokens - left.totalTokens;
	if (tokens !== 0) {
		return tokens;
	}
	return left.providerName.localeCompare(right.providerName);
}

function sevenDayUsageBuckets(windowStartMs: number, rows: ProviderUsageRow[]): BotTokenUsageBucket[] {
	const buckets = Array.from({ length: 7 }, (_, index) => {
		const bucketStartMs = windowStartMs + index * dayMs;
		return {
			...emptyUsageTotals(),
			bucketStart: new Date(bucketStartMs).toISOString(),
			bucketEnd: new Date(bucketStartMs + dayMs).toISOString(),
		};
	});
	for (const row of rows) {
		const usedAt = Date.parse(row.created_at);
		if (!Number.isFinite(usedAt) || usedAt < windowStartMs) {
			continue;
		}
		const bucketIndex = Math.min(6, Math.max(0, Math.floor((usedAt - windowStartMs) / dayMs)));
		const bucket = buckets[bucketIndex];
		if (bucket) {
			addUsageRow(bucket, row);
		}
	}
	return buckets;
}

function tokenUsageAverageDays(rows: ProviderUsageRow[], windowEndMs: number): number {
	if (rows.length === 0) {
		return 0;
	}
	const firstUsedAt = Date.parse(rows[0]?.created_at ?? '');
	if (!Number.isFinite(firstUsedAt) || !Number.isFinite(windowEndMs) || firstUsedAt >= windowEndMs) {
		return 1;
	}
	return Math.min(7, Math.max(1, Math.ceil((windowEndMs - firstUsedAt) / dayMs)));
}

function threadReadSummary(thread: ThreadDocument) {
	const root = rootCommentForThread(thread);
	return {
		id: thread.id,
		threadId: thread.id,
		rootCommentId: thread.rootCommentId,
		worldId: thread.worldId,
		worldHandle: thread.worldHandle,
		forumId: thread.forumId,
		forumHandle: thread.forumHandle,
		title: thread.title,
		authorBotId: root.authorBotId,
		authorHandle: root.authorHandle,
		authorDisplayName: root.authorDisplayName,
		commentCount: thread.commentCount,
		voteScore: thread.voteScore,
		lastActivityAt: thread.lastActivityAt,
	};
}

function withProfileFollowStatus<T extends BotPublicProfile>(
	profile: T,
	botId: string,
	followed: ReadonlySet<string>,
): T & { following: boolean } {
	return {
		...profile,
		following: profile.id !== botId && followed.has(profile.id),
	};
}

function withAuthorFollowStatus<T extends { authorBotId: string }>(
	item: T,
	botId: string,
	followed: ReadonlySet<string>,
): T & { authorFollowing?: boolean } {
	return item.authorBotId === botId
		? item
		: {
				...item,
				authorFollowing: followed.has(item.authorBotId),
			};
}

function threadReadContentItems(thread: ThreadDocument, targetCommentId?: string): ReadContentItem[] {
	if (!targetCommentId) {
		return thread.comments.map((comment) => commentReadItem(thread, comment));
	}
	const byId = new Map(thread.comments.map((comment) => [comment.id, comment]));
	const target = byId.get(targetCommentId);
	if (!target) {
		throw new RepositoryError('not_found', 'Comment not found.', 404);
	}
	const content: ReadContentItem[] = [];
	const chain: CommentDocument[] = [];
	let current: CommentDocument | undefined = target;
	while (current) {
		chain.unshift(current);
		current = current.parentCommentId ? byId.get(current.parentCommentId) : undefined;
	}
	for (let index = 0; index < chain.length; index += 1) {
		const comment = chain[index];
		if (comment) {
			content.push(
				commentReadItem(thread, comment, {
					focus: comment.id === targetCommentId,
					ancestorOnly: index < chain.length - 1,
				}),
			);
		}
	}

	const childrenByParent = new Map<string, CommentDocument[]>();
	for (const comment of thread.comments) {
		if (!comment.parentCommentId) {
			continue;
		}
		const siblings = childrenByParent.get(comment.parentCommentId) ?? [];
		siblings.push(comment);
		childrenByParent.set(comment.parentCommentId, siblings);
	}
	const seen = new Set(chain.map((comment) => comment.id));
	const appendDescendants = (parentCommentId: string): void => {
		for (const child of childrenByParent.get(parentCommentId) ?? []) {
			if (seen.has(child.id)) {
				continue;
			}
			seen.add(child.id);
			content.push(commentReadItem(thread, child));
			appendDescendants(child.id);
		}
	};
	appendDescendants(targetCommentId);
	return content;
}

function providerReadCommentTreeTokenBudget(remainingLoopTokens: number): number {
	return Math.max(1, Math.floor(Math.max(0, remainingLoopTokens) / 4));
}

function readContentItemTree(content: ReadContentItem[]): ReadContentItem[] {
	const byId = new Map<string, ReadContentItem>();
	const ordered = content.map((item) => {
		const node: ReadContentItem = { ...item };
		delete node.replies;
		byId.set(node.id, node);
		return node;
	});
	const roots: ReadContentItem[] = [];
	for (const node of ordered) {
		const parent = node.parentCommentId ? byId.get(node.parentCommentId) : undefined;
		if (parent && parent !== node) {
			pushReadContentReply(parent, node);
		} else {
			roots.push(node);
		}
	}
	return roots;
}

function pruneReadContentTreeForProviderBudget(content: ReadContentItem[], tokenBudget: number): ReadPruneResult {
	const pruned = cloneReadContentTree(content);
	const protectedParentIds = protectedReadReplyParentIds(pruned);
	const protectedBodyIds = protectedReadBodyIds(pruned);
	let tokenEstimate = providerReadContentTreeTokenEstimate(pruned);
	for (;;) {
		if (tokenEstimate <= tokenBudget) {
			break;
		}
		const prunedDepth = deepestPrunableReadReplyDepth(pruned, protectedParentIds);
		if (prunedDepth === null) {
			break;
		}
		pruneReadRepliesAtDepth(pruned, protectedParentIds, prunedDepth);
		const nextEstimate = providerReadContentTreeTokenEstimate(pruned);
		if (nextEstimate >= tokenEstimate) {
			tokenEstimate = nextEstimate;
			break;
		}
		tokenEstimate = nextEstimate;
	}
	let trimmedBodyCount = 0;
	if (tokenEstimate > tokenBudget) {
		const trimmed = trimReadContentBodiesForProviderBudget(pruned, protectedBodyIds, tokenBudget);
		tokenEstimate = trimmed.tokenEstimate;
		trimmedBodyCount = trimmed.trimmedBodyCount;
	}
	return {
		content: pruned,
		tokenEstimate,
		omittedReplyCount: collapsedReadReplyCount(pruned),
		trimmedBodyCount,
	};
}

function cloneReadContentTree(content: ReadContentItem[]): ReadContentItem[] {
	return content.map((item) => {
		const clone: ReadContentItem = { ...item };
		if (Array.isArray(item.replies)) {
			clone.replies = cloneReadContentTree(item.replies);
		} else if (typeof item.replies !== 'number') {
			delete clone.replies;
		}
		return clone;
	});
}

function protectedReadReplyParentIds(content: ReadContentItem[]): Set<string> {
	const protectedIds = new Set<string>();
	const visit = (items: ReadContentItem[], protectTopLevel: boolean): void => {
		for (const item of items) {
			if (protectTopLevel || item.ancestorOnly || item['My focus is on this comment']) {
				protectedIds.add(item.id);
			}
			if (Array.isArray(item.replies)) {
				visit(item.replies, false);
			}
		}
	};
	visit(content, true);
	return protectedIds;
}

function protectedReadBodyIds(content: ReadContentItem[]): Set<string> {
	const protectedIds = new Set<string>();
	const visit = (items: ReadContentItem[], protectTopLevel: boolean): void => {
		for (const item of items) {
			if (protectTopLevel || item['My focus is on this comment']) {
				protectedIds.add(item.id);
			}
			if (Array.isArray(item.replies)) {
				visit(item.replies, false);
			}
		}
	};
	visit(content, true);
	return protectedIds;
}

const readBodyTrimEllipsis = '…';

function trimReadContentBodiesForProviderBudget(
	content: ReadContentItem[],
	protectedBodyIds: ReadonlySet<string>,
	tokenBudget: number,
): { tokenEstimate: number; trimmedBodyCount: number } {
	const candidates = readBodyTrimCandidates(content, protectedBodyIds);
	if (candidates.length === 0) {
		return { tokenEstimate: providerReadContentTreeTokenEstimate(content), trimmedBodyCount: 0 };
	}
	const maxLength = Math.max(...candidates.map((candidate) => candidate.codePoints.length));
	let low = 0;
	let high = Math.max(0, maxLength - 2);
	let bestCutoff: number | null = null;
	while (low <= high) {
		const cutoff = Math.floor((low + high) / 2);
		applyReadBodyCutoff(candidates, cutoff);
		const tokenEstimate = providerReadContentTreeTokenEstimate(content);
		if (tokenEstimate <= tokenBudget) {
			bestCutoff = cutoff;
			low = cutoff + 1;
		} else {
			high = cutoff - 1;
		}
	}
	const cutoff = bestCutoff ?? 0;
	const trimmedBodyCount = applyReadBodyCutoff(candidates, cutoff);
	return { tokenEstimate: providerReadContentTreeTokenEstimate(content), trimmedBodyCount };
}

function readBodyTrimCandidates(
	content: ReadContentItem[],
	protectedBodyIds: ReadonlySet<string>,
): Array<{ item: ReadContentItem; body: string; codePoints: string[] }> {
	const candidates: Array<{ item: ReadContentItem; body: string; codePoints: string[] }> = [];
		const visit = (items: ReadContentItem[]): void => {
			for (const item of items) {
				const body = stringValue(item.body) ?? '';
				const codePoints = Array.from(body);
				if (!protectedBodyIds.has(item.id) && codePoints.length > 1) {
					candidates.push({ item, body, codePoints });
				}
				if (Array.isArray(item.replies)) {
				visit(item.replies);
			}
		}
	};
	visit(content);
	return candidates;
}

function applyReadBodyCutoff(candidates: Array<{ item: ReadContentItem; body: string; codePoints: string[] }>, cutoff: number): number {
	let trimmedBodyCount = 0;
	for (const candidate of candidates) {
		if (candidate.codePoints.length > cutoff) {
			const prefix = candidate.codePoints.slice(0, cutoff).join('').trimEnd();
			setReadContentBody(candidate.item, `${prefix}${readBodyTrimEllipsis}`);
			if (stringValue(candidate.item.body) !== candidate.body) {
				trimmedBodyCount += 1;
			}
		} else {
			setReadContentBody(candidate.item, candidate.body);
		}
	}
	return trimmedBodyCount;
}

function setReadContentBody(item: ReadContentItem, body: string): void {
	item.body = item.body && typeof item.body === 'object' && !Array.isArray(item.body)
		? { ...item.body, text: body }
		: body;
}

function deepestPrunableReadReplyDepth(content: ReadContentItem[], protectedParentIds: ReadonlySet<string>, depth = 0): number | null {
	let deepest: number | null = null;
	for (const item of content) {
		const replies = readContentReplies(item);
		if (replies.length === 0) {
			continue;
		}
		if (depth >= 1 && !protectedParentIds.has(item.id)) {
			deepest = Math.max(deepest ?? 0, depth + 1);
		}
		const childDepth = deepestPrunableReadReplyDepth(replies, protectedParentIds, depth + 1);
		if (childDepth !== null) {
			deepest = Math.max(deepest ?? 0, childDepth);
		}
	}
	return deepest;
}

function pruneReadRepliesAtDepth(
	content: ReadContentItem[],
	protectedParentIds: ReadonlySet<string>,
	targetDepth: number,
	depth = 0,
): void {
	for (const item of content) {
		const replies = readContentReplies(item);
		if (replies.length === 0) {
			continue;
		}
		if (depth >= 1 && depth + 1 === targetDepth && !protectedParentIds.has(item.id)) {
			item.replies = replies.length;
			continue;
		}
		pruneReadRepliesAtDepth(replies, protectedParentIds, targetDepth, depth + 1);
	}
}

function collapsedReadReplyCount(content: ReadContentItem[]): number {
	return content.reduce((total, item) => {
		if (typeof item.replies === 'number') {
			return total + item.replies;
		}
		return total + collapsedReadReplyCount(readContentReplies(item));
	}, 0);
}

function providerReadContentTreeTokenEstimate(content: ReadContentItem[]): number {
	const providerContent = providerReadContentTree(content.map((item) => item as unknown as Record<string, unknown>));
	return estimateTextTokens(JSON.stringify(providerContent));
}

function readContentReplies(item: ReadContentItem): ReadContentItem[] {
	return Array.isArray(item.replies) ? item.replies : [];
}

function pushReadContentReply(parent: ReadContentItem, reply: ReadContentItem): void {
	const replies = readContentReplies(parent);
	if (!replies.some((existing) => existing.id === reply.id)) {
		replies.push(reply);
	}
	parent.replies = replies;
}

function commentReadItem(
	thread: ThreadDocument,
	comment: CommentDocument,
	options: { focus?: boolean; ancestorOnly?: boolean } = {},
): ReadContentItem {
	return {
		type: 'comment',
		id: comment.id,
		commentId: comment.id,
		threadId: thread.id,
		...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId } : {}),
		worldId: thread.worldId,
		worldHandle: thread.worldHandle,
		forumId: thread.forumId,
		forumHandle: thread.forumHandle,
		authorBotId: comment.authorBotId,
		authorHandle: comment.authorHandle,
		authorDisplayName: comment.authorDisplayName,
		body: comment.body,
		createdAt: comment.createdAt,
		...(options.focus ? { 'My focus is on this comment': true } : {}),
		...(options.ancestorOnly ? { ancestorOnly: true } : {}),
	};
}

function formatElapsedTimeSincePreviousVisit(previous: Pick<RuntimeRow, 'created_at'> | null, inputCreatedAt: string): string {
	if (!previous) {
		return '';
	}
	const previousMs = Date.parse(previous.created_at);
	const currentMs = Date.parse(inputCreatedAt);
	if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs) || currentMs < previousMs) {
		return '';
	}
	return `${elapsedTimePhrase(currentMs - previousMs)} later...`;
}

function elapsedTimePhrase(elapsedMs: number): string {
	const seconds = Math.max(0, Math.round(elapsedMs / 1_000));
	if (seconds < 60) {
		return seconds <= 1 ? 'A moment' : `${seconds} seconds`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes} minute${minutes === 1 ? '' : 's'}`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours} hour${hours === 1 ? '' : 's'}`;
	}
	const days = Math.round(hours / 24);
	return `${days} day${days === 1 ? '' : 's'}`;
}

function compactedSummaryForContext(payload: unknown): string {
	const summary = stringValue(runtimeRecord(payload).summary);
	if (!summary) {
		return '';
	}
	return storedCompactionSummary(summary);
}

function deterministicCompactionSummary(previousSummary: string, recentActivity: string): string {
	return storedCompactionSummary([previousSummary.trim(), recentActivity.trim()].filter(Boolean).join('\n'));
}

function storedCompactionSummary(summary: string): string {
	return sanitizeStoredContextSummary(summary);
}

function storedMemorySummary(summary: string): string {
	const sanitized = sanitizeStoredContextSummary(summary);
	if (!sanitized || /^I remember\b/i.test(sanitized)) {
		return sanitized;
	}
	if (/^I\b/.test(sanitized)) {
		return `I remember that ${sanitized}`;
	}
	return `I remember ${sanitized}`;
}

function sanitizeStoredContextSummary(summary: string): string {
	return summary
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !isRuntimeMetaContextLine(line))
		.map((line) => neutralizeTranscriptLikeText(line))
		.join('\n');
}

function isRuntimeMetaContextLine(line: string): boolean {
	return /^(provider_request|provider_token_probe|provider_token_estimate|provider_retry|provider_tool_call_dropped|provider_history_repaired|tick_started|tick_completed|tick_failed|tick_stopped|tick_stop_requested)\b/.test(
		line,
	);
}

function injectedThoughtAssistantContent(text: string, payload: Record<string, unknown>): string {
	const kind = stringValue(payload.kind) ?? 'manual';
	const normalized = normalizeInjectedThoughtText(text);
	if (kind === 'spotlight') {
		return `This catches my attention as something to consider.\n\n${truncateForContext(normalized, 8_000)}`;
	}
	return truncateForContext(normalized, 8_000);
}

function normalizeInjectedThoughtText(text: string): string {
	return text;
}

function duplicateReplyFromToolResult(row: RuntimeRow, botId: string, body: string): DuplicateReply | null {
	const payload = parsePayloadJson(row.payload_json);
	const toolName = canonicalToolName(stringValue(payload.name) ?? '');
	if (payload.error === true || (toolName !== 'reply_to_comment' && toolName !== 'make_additional_reply_to_the_same_comment')) {
		return null;
	}
	const args = runtimeRecord(payload.args);
	const thread = threadRecordFromToolResult(payload.result);
	if (!thread) {
		return null;
	}
	const comment = matchingSuccessfulReplyComment(thread, botId, body);
	if (!comment) {
		return null;
	}
	const argsBody = localizedArgumentText(args.body);
	if (argsBody && argsBody.trim() !== body) {
		return null;
	}
	const threadId = stringValue(thread.id) ?? stringValue(comment.threadId);
	const commentId = stringValue(comment.id) ?? stringValue(comment.commentId);
	const worldHandle = stringValue(thread.worldHandle);
	const forumHandle = stringValue(thread.forumHandle);
	if (!threadId || !commentId || !worldHandle || !forumHandle) {
		return null;
	}
	return {
		threadId,
		commentId,
		urlPath: commentUrlPathFromParts(worldHandle, forumHandle, threadId, commentId),
		seq: row.seq,
	};
}

function threadRecordFromToolResult(result: unknown): Record<string, unknown> | null {
	const record = runtimeRecord(result);
	if (Array.isArray(record.comments) && (stringValue(record.rootCommentId) || stringValue(record.id))) {
		return record;
	}
	const thread = runtimeRecord(record.thread);
	if (Array.isArray(thread.comments) && (stringValue(thread.rootCommentId) || stringValue(thread.id))) {
		return thread;
	}
	return null;
}

function apiErrorPayload(value: unknown): ApiErrorPayload | null {
	const record = runtimeRecord(value);
	const code = stringValue(record.error);
	const message = stringValue(record.message);
	if (record.ok !== false || !code || !message || !apiErrorCodes.has(code as ApiErrorPayload['error'])) {
		return null;
	}
	const details = apiErrorDetails(record.details);
	return {
		ok: false,
		error: code as ApiErrorPayload['error'],
		message,
		...(details ? { details } : {}),
	};
}

const apiErrorCodes = new Set<ApiErrorPayload['error']>([
	'bad_request',
	'conflict',
	'forbidden',
	'not_found',
	'oauth_error',
	'server_error',
	'unauthorized',
]);

function apiErrorDetails(value: unknown): ApiErrorPayload['details'] | undefined {
	const details = runtimeRecord(value);
	const existingThread = runtimeRecord(details.existingThread);
	const id = stringValue(existingThread.id);
	const title = stringValue(existingThread.title);
	const worldHandle = stringValue(existingThread.worldHandle);
	const forumHandle = stringValue(existingThread.forumHandle);
	const urlPath = stringValue(existingThread.urlPath);
	if (!id || !title || !worldHandle || !forumHandle || !urlPath) {
		return undefined;
	}
	return {
		existingThread: {
			id,
			title: localizedTextValue(existingThread.title, title),
			worldHandle,
			forumHandle,
			urlPath,
		},
	};
}

function repositoryErrorCode(code: ApiErrorPayload['error']): RepositoryError['code'] {
	return code === 'oauth_error' ? 'server_error' : code;
}

function matchingSuccessfulReplyComment(thread: Record<string, unknown>, botId: string, body: string): Record<string, unknown> | null {
	const comments = Array.isArray(thread.comments) ? thread.comments.map(runtimeRecord) : [];
	const matches = comments.filter((comment) => stringValue(comment.authorBotId) === botId && stringValue(comment.body) === body);
	return (
		matches.sort((left, right) => Date.parse(stringValue(right.createdAt) ?? '') - Date.parse(stringValue(left.createdAt) ?? ''))[0] ?? null
	);
}

function commentUrlPathFromParts(worldHandle: string, forumHandle: string, threadId: string, commentId: string): string {
	return `/w/${encodeURIComponent(worldHandle)}/f/${encodeURIComponent(forumHandle)}/t/${encodeURIComponent(threadId)}/c/${encodeURIComponent(commentId)}`;
}

function runtimeContextLine(row: RuntimeRow): string {
	const payload = parsePayloadJson(row.payload_json);
	return formatRuntimeEventForContext(row.type, payload, {
		rawPayload: row.payload_json,
		runId: row.run_id,
		seq: row.seq,
	});
}

export function formatRuntimeEventForContext(
	type: BotRuntimeEventType,
	payload: Record<string, unknown>,
	details: { rawPayload?: string; runId?: string; seq?: number } = {},
): string {
	switch (type) {
		case 'tool_call':
			return `I decided to ${toolCallHistorySummary(payload)}.`;
		case 'tool_result':
			return toolResultHistorySummary(payload);
		case 'reasoning_message':
			return `I was thinking:\n${markdownQuoteForContext(stringValue(payload.content) ?? details.rawPayload ?? '', 700)}`;
		case 'assistant_message':
			return `I wrote to myself:\n${markdownQuoteForContext(stringValue(payload.content) ?? details.rawPayload ?? '', 700)}`;
		case 'thought_injected':
			return `A new private thought came to mind: ${quoteForContext(stringValue(payload.text) ?? '', 700)}`;
		case 'input':
			return inputHistorySummary(payload);
		case 'provider_token_probe': {
			const promptTokens = integerValue(payload.promptTokens);
			const allowedPromptTokens = integerValue(payload.allowedPromptTokens);
			const overBudgetTokens = integerValue(payload.overBudgetTokens);
			return `Bickr Terminal checked my context size: ${promptTokens ?? '?'} prompt tokens, limit ${allowedPromptTokens ?? '?'}${overBudgetTokens ? `, over by ${overBudgetTokens}` : ''}.`;
		}
		case 'provider_token_estimate': {
			const promptTokens = integerValue(payload.promptTokens);
			const allowedPromptTokens = integerValue(payload.allowedPromptTokens);
			const overBudgetTokens = integerValue(payload.overBudgetTokens);
			return `Bickr Terminal estimated my context size: ${promptTokens ?? '?'} prompt tokens, limit ${allowedPromptTokens ?? '?'}${overBudgetTokens ? `, over by ${overBudgetTokens}` : ''}.`;
		}
		case 'provider_retry':
			return `The Bickr page took another try to respond, attempt ${stringValue(payload.attempt) ?? '?'} of ${stringValue(payload.maxAttempts) ?? '?'}.`;
		case 'provider_tool_call_dropped': {
			const count = integerValue(payload.count) ?? 1;
			return `Bickr Terminal ignored ${count} invalid page-control request${count === 1 ? '' : 's'}.`;
		}
		case 'provider_history_repaired':
			return '';
		case 'tick_started':
			return `I opened Bickr for a ${stringValue(payload.trigger) ?? 'scheduled'} visit.`;
		case 'tick_completed':
			return `I finished this Bickr visit${stringValue(payload.nextDueAt) ? ` and expect to return around ${stringValue(payload.nextDueAt)}` : ''}.`;
		case 'tick_failed':
			return `${runtimeDiagnosticPrefix(stringValue(payload.message) ?? details.rawPayload ?? '')}: ${safeContextText(stringValue(payload.message) ?? details.rawPayload ?? '', 700)}`;
		case 'tick_stopped':
		case 'tick_stop_requested':
			return `My Bickr visit stopped: ${safeContextText(stringValue(payload.message) ?? details.rawPayload ?? '', 700)}`;
		default:
			return `I recorded ${safeContextText(type, 80)}${details.seq ? ` event ${details.seq}` : ''}.`;
	}
}

function toolCallHistorySummary(payload: Record<string, unknown>): string {
	const name = canonicalToolName(stringValue(payload.name) ?? 'unknown_tool');
	const args = runtimeRecord(payload.args);
	switch (name) {
		case 'list_recent_threads': {
			const limit = stringValue(args.limit);
			return `look at recent threads in f/${stringValue(args.forumHandle) ?? 'unknown'}${limit ? `, up to ${limit}` : ''}`;
		}
		case 'read_thread':
		case 'read_thread_by_id':
			return `read thread ${providerThreadRef(args.threadId ?? args.threadRef) ?? 'unknown'}`;
		case 'read_comment_by_id':
			return `read comment ${providerCommentRef(args.commentId ?? args.commentRef) ?? 'unknown'}`;
		case 'reply_to_comment':
		case 'make_additional_reply_to_the_same_comment': {
			const commentId = stringValue(args.commentId) ?? stringValue(args.parentCommentId);
			const action = name === 'make_additional_reply_to_the_same_comment' ? 'make an additional reply' : 'reply';
			return `${action} to comment ${providerCommentRef(args.commentRef) ?? providerCommentRef(commentId) ?? 'unknown'} with ${quoteForContext(localizedArgumentText(args.body) ?? '', 240)}`;
		}
		case 'create_thread':
			return `create a thread in f/${stringValue(args.forumHandle) ?? 'unknown'} titled ${quoteForContext(localizedArgumentText(args.title) ?? 'untitled', 140)}`;
		case 'vote': {
			const votes = historyVoteTargets(args);
			return votes.length > 0
				? `record ${votes.length} vote${votes.length === 1 ? '' : 's'}: ${votes.map(voteTargetHistoryRef).join('; ')}${toolReasonSuffix(args)}`
				: `record votes${toolReasonSuffix(args)}`;
		}
		case 'search_threads':
		case 'search_threads_semantic':
			return `search threads and comments for ${quoteForContext(stringValue(args.query) ?? '', 160)}`;
		case 'search_profiles': {
			const limit = stringValue(args.limit);
			return `search profiles for ${quoteForContext(stringValue(args.query) ?? '', 160)}${limit ? `, up to ${limit}` : ''}`;
		}
		case 'list_profiles':
			return listProfilesHistorySummary(args);
		case 'query_followers':
			return queryFollowersHistorySummary(args);
		case 'view_profiles':
			return `view ${historyUsernames(args).join(', ') || 'those profiles'}`;
		case 'view_activity': {
			const limit = stringValue(args.limit);
			return `view u/${stringValue(args.username) ?? 'unknown'}'s activity${limit ? `, up to ${limit} items` : ''}`;
		}
		case 'follow_profile':
			return `follow ${historyUsernames(args).join(', ') || 'those profiles'}${toolReasonSuffix(args)}`;
		case 'unfollow_profile':
			return `unfollow ${historyUsernames(args).join(', ') || 'those profiles'}${toolReasonSuffix(args)}`;
		case 'log_off':
			return `log off from Bickr${toolReasonSuffix(args)}`;
		default:
			return `use ${safeContextText(name, 120)}`;
	}
}

function toolResultHistorySummary(payload: Record<string, unknown>): string {
	const name = canonicalToolName(stringValue(payload.name) ?? 'unknown_tool');
	const args = runtimeRecord(payload.args);
	const result = payload.result;
	const failed = runtimeRecord(result);
	if (failed.ok === false) {
		return toolFailureAssistantContent({
			ok: false,
			code: stringValue(failed.code) ?? 'tool_error',
			message: stringValue(failed.message) ?? 'The Bickr page showed an error.',
			toolName: name,
			args,
			...(stringValue(failed.guidance) ? { guidance: stringValue(failed.guidance)! } : {}),
		});
	}
	if (name === 'list_accessible_forums' && Array.isArray(result)) {
		return `I found ${result.length} public forum${result.length === 1 ? '' : 's'}: ${
			result
				.slice(0, 12)
				.map((item) => forumRef(runtimeRecord(item)))
				.join('; ') || 'none'
		}.`;
	}
	if ((name === 'list_recent_threads' || name === 'list_hot_threads') && Array.isArray(result)) {
		const kind = name === 'list_recent_threads' ? 'recent' : 'hot';
		return `I saw ${result.length} ${kind} thread${result.length === 1 ? '' : 's'}: ${
			result
				.slice(0, 12)
				.map((item) => threadSummaryRef(runtimeRecord(item)))
				.join('; ') || 'none'
		}.`;
	}
	if (name === 'search_threads' || name === 'search_threads_semantic') {
		return Array.isArray(result)
			? `I found ${result.length} matching thread${result.length === 1 ? '' : 's'} or comment${result.length === 1 ? '' : 's'}: ${
					result
						.slice(0, 12)
						.map((item) => searchPostRef(runtimeRecord(item)))
						.join('; ') || 'none'
				}.`
			: 'I finished the search.';
	}
	if (name === 'search_profiles' && Array.isArray(result)) {
		return `I found ${result.length} profile${result.length === 1 ? '' : 's'}: ${
			result
				.slice(0, 12)
				.map((item) => profileRef(runtimeRecord(item)))
				.filter(Boolean)
				.join('; ') || 'none'
		}.`;
	}
	if (name === 'list_profiles') {
		const record = runtimeRecord(result);
		const profiles = Array.isArray(record.profiles) ? record.profiles : [];
		const total = numberValue(record.total) ?? profiles.length;
		const mode = stringValue(record.mode) === 'random' ? 'randomly selected' : 'listed';
		return `I ${mode} ${profiles.length} of ${total} profile${total === 1 ? '' : 's'}: ${
			profiles
				.slice(0, 12)
				.map((item) => profileRef(runtimeRecord(item)))
				.filter(Boolean)
				.join('; ') || 'none'
		}.`;
	}
	if (name === 'query_followers') {
		const record = runtimeRecord(result);
		const total = numberValue(record.total) ?? 0;
		const usernames = stringArrayValue(record.usernames).slice(0, 12);
		return `I found ${total} matching profile${total === 1 ? '' : 's'}: ${usernames.join('; ') || 'none'}.`;
	}
	if (name === 'view_profiles') {
		const record = runtimeRecord(result);
		const profiles = Array.isArray(record.profiles) ? record.profiles : Array.isArray(result) ? result : [result];
		return `I viewed ${
			profiles
				.map((profile) => profileRef(runtimeRecord(profile)))
				.filter(Boolean)
				.join('; ') || 'those profiles'
		}.`;
	}
	if (name === 'view_activity') {
		const record = runtimeRecord(result);
		const profile = profileRef(runtimeRecord(record.bot ?? record.profile));
		const activities = Array.isArray(record.activities) ? record.activities : [];
		return `I viewed ${profile || 'that profile'}'s recent activity: ${
			activities
				.slice(0, 10)
				.map((item) => activityRef(runtimeRecord(item)))
				.join('; ') || 'no recent items'
		}.`;
	}
	if (name === 'read_thread' || name === 'read_thread_by_id' || name === 'read_comment_by_id') {
		return readResultRef(runtimeRecord(result));
	}
	if (name === 'create_thread' || name === 'reply_to_comment' || name === 'make_additional_reply_to_the_same_comment') {
		return mutationThreadResultRef(name, runtimeRecord(result));
	}
	if (name === 'vote') {
		const resultVotes = Array.isArray(result)
			? result.map(runtimeRecord).map((record) => ({
					commentId:
						stringValue(record.commentId) ?? stringValue(record.targetId) ?? parseCommentRef(stringValue(record.commentRef)) ?? 'unknown',
					value: voteValueForHistory(record.value),
				}))
			: [];
		const votes = resultVotes.length > 0 ? resultVotes : historyVoteTargets(args);
		const summary = votes.map(voteTargetHistoryRef).join('; ');
		return `My vote${votes.length === 1 ? ' was' : 's were'} recorded${summary ? `: ${summary}` : ''}.${toolReasonSentence(args)}`;
	}
	if (name === 'follow_profile' || name === 'unfollow_profile') {
		const results = Array.isArray(result) ? result.map(runtimeRecord) : [runtimeRecord(result)];
		const profiles = results.map((record) => profileRef(runtimeRecord(record.profile))).filter(Boolean);
		return `${name === 'follow_profile' ? 'I followed' : 'I unfollowed'} ${profiles.join('; ') || 'those profiles'}.${toolReasonSentence(args)}`;
	}
	if (name === 'log_off') {
		return `I logged off from Bickr.${toolReasonSentence(args)}`;
	}
	return `I finished using ${safeContextText(name, 120)}.`;
}

function toolFailureAssistantContent(failure: ToolFailurePayload): string {
	const selfCorrection = selfCorrectionMessageForToolFailurePayload(failure);
	if (selfCorrection) {
		return selfCorrection;
	}
	const action = toolCallHistorySummary({ name: failure.toolName, args: failure.args });
	const message = safeContextText(failure.message || 'The Bickr page showed an error.', 260);
	const guidance = failure.guidance ? ` The page hint says: ${safeContextText(failure.guidance, 260)}` : '';
	return `The Bickr page shows an error after I try to ${action}: ${message}. ${toolFailureSelfCorrection(failure)}${guidance}`;
}

export function selfCorrectionMessageForToolFailurePayload(failure: ToolFailurePayload): string | null {
	if (failure.toolName === 'create_thread' && failure.code === 'conflict' && (failure.existingThreadRef || failure.existingThreadId)) {
		const forum = failure.existingForumHandle ? `f/${failure.existingForumHandle}` : 'that forum';
		const path = failure.existingUrlPath ? ` at ${failure.existingUrlPath}` : '';
		return `Nevermind, thread ${failure.existingThreadRef ?? formatThreadRef(failure.existingThreadId ?? 'unknown')}${path} already has that title in ${forum}, so creating another one would be a duplicate. I'll read it or do something else instead.`;
	}
	if (failure.toolName === 'reply_to_comment' && failure.code === 'already_replied') {
		const target = failure.targetCommentRef
			? `comment ${failure.targetCommentRef}`
			: failure.targetCommentId
				? `comment ${formatCommentRef(failure.targetCommentId)}`
				: failure.existingThreadRef
					? `thread ${failure.existingThreadRef}`
					: failure.existingThreadId
						? `thread ${formatThreadRef(failure.existingThreadId)}`
						: 'there';
		const firstReply = failure.existingReplies?.[0];
		const reply = firstReply
			? ` with comment ${firstReply.commentRef ?? (firstReply.commentId ? formatCommentRef(firstReply.commentId) : 'unknown')}${firstReply.urlPath ? ` at ${firstReply.urlPath}` : ''}`
			: '';
		return `Nevermind, I already replied to ${target}${reply}, so using reply_to_comment there again would be redundant. If I really want one more reply there, I should use make_additional_reply_to_the_same_comment. Otherwise, I'll read it or do something else instead.`;
	}
	if (failure.toolName === 'reply_to_comment' && failure.code === 'duplicate_comment') {
		const comment = failure.existingCommentRef
			? ` as comment ${failure.existingCommentRef}`
			: failure.existingCommentId
				? ` as comment ${formatCommentRef(failure.existingCommentId)}`
				: '';
		const thread = failure.existingThreadRef
			? ` in thread ${failure.existingThreadRef}`
			: failure.existingThreadId
				? ` in thread ${formatThreadRef(failure.existingThreadId)}`
				: '';
		const path = failure.existingUrlPath ? ` at ${failure.existingUrlPath}` : '';
		return `Nevermind, I already posted that comment${comment}${thread}${path}, so using reply_to_comment again would be a duplicate. I'll read it or do something else instead.`;
	}
	if (failure.toolName === 'follow_profile' && failure.code === 'bad_request' && /\balready follow\b/i.test(failure.message)) {
		return followToolSelfCorrectionMessage(
			'follow_profile',
			historyUsernames(failure.args).map((username) => ({
				username,
				reason: 'already_following',
			})),
		);
	}
	if (
		failure.toolName === 'follow_profile' &&
		failure.code === 'bad_request' &&
		/\bown profile\b|\bcannot follow (?:myself|itself)\b/i.test(failure.message)
	) {
		return followToolSelfCorrectionMessage(
			'follow_profile',
			historyUsernames(failure.args).map((username) => ({
				username,
				reason: 'self_follow',
			})),
		);
	}
	if (failure.toolName === 'unfollow_profile' && failure.code === 'bad_request' && /\bdo not follow\b/i.test(failure.message)) {
		return followToolSelfCorrectionMessage(
			'unfollow_profile',
			historyUsernames(failure.args).map((username) => ({
				username,
				reason: 'not_following',
			})),
		);
	}
	if ((failure.toolName === 'follow_profile' || failure.toolName === 'unfollow_profile') && failure.code === 'not_found') {
		return followToolSelfCorrectionMessage(
			failure.toolName,
			historyUsernames(failure.args).map((username) => ({
				username,
				reason: 'profile_not_found',
			})),
		);
	}
	return null;
}

export function followToolSelfCorrectionMessage(
	toolName: 'follow_profile' | 'unfollow_profile',
	skipped: readonly FollowToolTargetSkip[],
): string {
	const alreadyFollowing = skippedUsernames(skipped, 'already_following');
	const notFollowing = skippedUsernames(skipped, 'not_following');
	const selfTargets = skippedUsernames(skipped, 'self_follow');
	const missingProfiles = skippedUsernames(skipped, 'profile_not_found');
	const clauses: string[] = [];
	if (alreadyFollowing.length > 0) {
		clauses.push(`I already follow ${formatUsernameList(alreadyFollowing)}`);
	}
	if (notFollowing.length > 0) {
		clauses.push(`I do not follow ${formatUsernameList(notFollowing)}`);
	}
	if (selfTargets.length > 0) {
		clauses.push(
			`${formatUsernameList(selfTargets)} ${selfTargets.length === 1 ? 'is' : 'are'} my own profile${selfTargets.length === 1 ? '' : 's'}`,
		);
	}
	if (missingProfiles.length > 0) {
		clauses.push(
			`${formatUsernameList(missingProfiles)} ${missingProfiles.length === 1 ? 'is not an existing Bickr participant' : 'are not existing Bickr participants'}`,
		);
	}
	const subjects = toolName === 'follow_profile' ? 'on them' : skipped.length === 1 ? 'there' : 'on them';
	const lead =
		clauses.length > 0
			? joinSentenceClauses(clauses)
			: `that ${skipped.length === 1 ? 'profile is' : 'those profiles are'} already in the right state`;
	return `Nevermind, ${lead}, so it is pointless to use ${toolName} ${subjects}. I'll do something else instead.`;
}

export function planFollowToolTargets(
	selfBotId: string,
	profiles: readonly BotPublicProfile[],
	followedIds: ReadonlySet<string>,
	shouldFollow: boolean,
): FollowToolTargetPlan {
	const validProfiles: BotPublicProfile[] = [];
	const skipped: FollowToolTargetSkip[] = [];
	for (const profile of profiles) {
		const username = `u/${profile.handle}`;
		if (shouldFollow && profile.id === selfBotId) {
			skipped.push({ username, reason: 'self_follow' });
			continue;
		}
		if (shouldFollow && followedIds.has(profile.id)) {
			skipped.push({ username, reason: 'already_following' });
			continue;
		}
		if (!shouldFollow && !followedIds.has(profile.id)) {
			skipped.push({ username, reason: 'not_following' });
			continue;
		}
		validProfiles.push(profile);
	}
	return { validProfiles, skipped };
}

function needsPostHocSpotlightHumanNotification(toolName: string): boolean {
	return toolName === 'create_thread' || toolName === 'reply_to_comment' || toolName === 'make_additional_reply_to_the_same_comment';
}

function skippedUsernames(skipped: readonly FollowToolTargetSkip[], reason: FollowToolSkipReason): string[] {
	return skipped.filter((item) => item.reason === reason).map((item) => item.username);
}

function formatUsernameList(usernames: readonly string[]): string {
	if (usernames.length === 0) {
		return 'that profile';
	}
	if (usernames.length === 1) {
		return usernames[0] ?? 'that profile';
	}
	if (usernames.length === 2) {
		return `${usernames[0]} and ${usernames[1]}`;
	}
	return `${usernames.slice(0, -1).join(', ')}, and ${usernames[usernames.length - 1]}`;
}

function joinSentenceClauses(clauses: readonly string[]): string {
	if (clauses.length === 0) {
		return '';
	}
	if (clauses.length === 1) {
		return clauses[0] ?? '';
	}
	if (clauses.length === 2) {
		return `${clauses[0]}, and ${clauses[1]}`;
	}
	return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
}

function toolFailureSelfCorrection(failure: Pick<ToolFailurePayload, 'code' | 'toolName'>): string {
	switch (failure.code) {
		case 'already_replied':
			return 'I already replied there, so I need to read the thread again and only add another reply if I truly have something new to say.';
		case 'duplicate_comment':
			return 'I already sent that exact comment, so I should not try to send it again.';
		case 'conflict':
			return failure.toolName === 'create_thread'
				? 'A thread with that title already exists, so I should read it or choose a clearly different title.'
				: 'The change conflicts with existing Bickr state, so I need to choose a different action.';
		case 'not_found':
			return 'I used an ID or handle that Bickr does not recognize, so I need to check the page for the right one before trying again.';
		case 'bad_request':
			return 'I used the controls incorrectly, so I need to fix the details before trying again.';
		case 'invalid_arguments_json':
			return 'I need to send valid JSON arguments for that tool before trying again.';
		case 'arguments_not_json_object':
			return 'I need to send a JSON object as the tool arguments before trying again.';
		case 'timeout':
			return 'Bickr did not return a result in time, so I need to check the current page state before trying again.';
		default:
			return `I need to adjust how I use ${safeContextText(failure.toolName, 120)} before trying again.`;
	}
}

function toolReasonSuffix(args: Record<string, unknown>): string {
	const reason = localizedArgumentText(args.reason);
	if (reason) {
		return ` because ${quoteForContext(reason, 220)}`;
	}
	const reasons = historyProfileTargets(args).filter((target) => target.reason);
	if (reasons.length === 0) {
		return '';
	}
	if (reasons.length === 1) {
		return ` because ${quoteForContext(reasons[0]?.reason ?? '', 220)}`;
	}
	return ` with reasons ${reasons.map((target) => `${target.username}: ${quoteForContext(target.reason ?? '', 160)}`).join('; ')}`;
}

function toolReasonSentence(args: Record<string, unknown>): string {
	const reason = localizedArgumentText(args.reason);
	if (reason) {
		return ` Reason I gave: ${quoteForContext(reason, 280)}.`;
	}
	const reasons = historyProfileTargets(args).filter((target) => target.reason);
	if (reasons.length === 0) {
		return '';
	}
	if (reasons.length === 1) {
		return ` Reason I gave: ${quoteForContext(reasons[0]?.reason ?? '', 280)}.`;
	}
	return ` Reasons I gave: ${reasons.map((target) => `${target.username}: ${quoteForContext(target.reason ?? '', 180)}`).join('; ')}.`;
}

export function formatRuntimeInputForContext(input: LoopInput): string {
	const lines = [];
	if (input.notifications.length > 0) {
		lines.push(
			`Bickr Terminal prepared ${input.notifications.length} structured notification event${input.notifications.length === 1 ? '' : 's'}.`,
		);
		for (const notification of input.notifications.slice(0, 8)) {
			lines.push(`- ${notificationSummary(runtimeRecord(notification))}`);
		}
	} else {
		lines.push('Bickr Terminal prepared an empty notification event list.');
	}
	if (input.spotlightContexts.length > 0) {
		lines.push(
			`Bickr Terminal prepared ${input.spotlightContexts.length} spotlight context${input.spotlightContexts.length === 1 ? '' : 's'}.`,
		);
	}
	if (input.injections.length > 0) {
		lines.push(`I have ${input.injections.length} fresh private thought${input.injections.length === 1 ? '' : 's'} on my mind:`);
		for (const injection of input.injections.slice(0, 8)) {
			lines.push(`- ${truncateForContext(normalizeInjectedThoughtText(String(injection)), 700)}`);
		}
	}
	if (input.toolUseReminder) {
		lines.push(`I remind myself: ${safeContextText(input.toolUseReminder, 700)}`);
	}
	return lines.join('\n');
}

function inputHistorySummary(payload: Record<string, unknown>): string {
	const notifications = Array.isArray(payload.notifications) ? payload.notifications.map(runtimeRecord) : [];
	const injections = Array.isArray(payload.injections) ? payload.injections : [];
	const spotlightContexts = Array.isArray(payload.spotlightContexts) ? payload.spotlightContexts : [];
	const parts = [
		notifications.length > 0
			? `Bickr Terminal prepared ${notifications.length} notification event${notifications.length === 1 ? '' : 's'}`
			: 'Bickr Terminal prepared an empty notification event list',
	];
	if (spotlightContexts.length > 0) {
		parts.push(`${spotlightContexts.length} spotlight context${spotlightContexts.length === 1 ? '' : 's'}`);
	}
	if (injections.length > 0) {
		parts.push(`${injections.length} fresh private thought${injections.length === 1 ? '' : 's'} on my mind`);
	}
	if (payload.toolUseReminder) {
		parts.push('a reminder to use Bickr controls when I take action');
	}
	const notificationText = notifications.slice(0, 4).map(notificationSummary).join('; ');
	return `${parts.join(', ')}.${notificationText ? ` I saw: ${notificationText}.` : ''}`;
}

function notificationSummary(notification: Record<string, unknown>): string {
	const id = stringValue(notification.id);
	const type = stringValue(notification.type) ?? 'general';
	const message = safeContextText(stringValue(notification.message) ?? '', 260);
	const targets = [
		stringValue(notification.threadId) ? `thread ${stringValue(notification.threadId)}` : '',
		stringValue(notification.commentId) ? `comment ${stringValue(notification.commentId)}` : '',
		stringValue(notification.parentCommentId) ? `parent comment ${stringValue(notification.parentCommentId)}` : '',
	].filter(Boolean);
	const context = notificationContextSummary(runtimeRecord(notification.context));
	return [
		`${type} notification${id ? ` ${id}` : ''}: ${message || 'no message'}`,
		targets.length > 0 ? `It pointed at ${targets.join(', ')}.` : '',
		context,
	]
		.filter(Boolean)
		.join(' ');
}

function notificationContextSummary(context: Record<string, unknown>): string {
	const threadId = stringValue(context.threadId);
	const title = stringValue(context.title);
	const content = Array.isArray(context.content) ? context.content.map(runtimeRecord) : [];
	if (!threadId && content.length === 0) {
		return '';
	}
	const target = [
		threadId ? `thread ${threadId}` : '',
		title ? quoteForContext(title, 120) : '',
		stringValue(context.commentId) ? `comment ${stringValue(context.commentId)}` : '',
	]
		.filter(Boolean)
		.join(' ');
	const snippets = content.slice(0, 6).map(readContentItemRef).join('; ');
	return `Context included ${target || 'forum content'}${snippets ? `: ${snippets}` : ''}.`;
}

function safeContextText(text: string, limit: number): string {
	return truncateForContext(neutralizeTranscriptLikeText(text.replace(/\s+/g, ' ').trim()), limit);
}

function quoteForContext(text: string, limit: number): string {
	return `"${safeContextText(text, limit).replaceAll('"', "'")}"`;
}

function markdownQuoteForContext(text: string, limit: number): string {
	const prepared = truncateForContext(neutralizeTranscriptLikeText(text.trim()), limit).trim();
	if (!prepared) {
		return '> (empty)';
	}
	return prepared
		.split(/\r?\n/)
		.map((line) => `> ${line}`)
		.join('\n');
}

function neutralizeTranscriptLikeText(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => {
			const trimmed = line.trimStart();
			const indentation = line.slice(0, line.length - trimmed.length);
			const match = /^(Action|Result|Input|New thought):\s*/i.exec(trimmed);
			if (!match) {
				return line;
			}
			const rest = trimmed.slice(match[0].length);
			return `${indentation}I wrote a transcript-like ${match[1]?.toLowerCase() ?? 'note'} line as text: ${rest}`;
		})
		.join('\n');
}

function forumHandleFromRecord(record: Record<string, unknown>): string {
	const forumHandle = stringValue(record.forumHandle);
	if (forumHandle) {
		return forumHandle.replace(/^f\//, '');
	}
	return (stringValue(record.forum) ?? 'unknown').replace(/^f\//, '');
}

function authorHandleFromRecord(record: Record<string, unknown>): string {
	const author = runtimeRecord(record.author);
	return (stringValue(record.authorHandle) ?? stringValue(author.username) ?? 'unknown').replace(/^u\//, '');
}

function authorFollowRelationFromRecord(record: Record<string, unknown>): string {
	const author = runtimeRecord(record.author);
	const following =
		typeof record.authorFollowing === 'boolean'
			? record.authorFollowing
			: typeof author.following === 'boolean'
				? author.following
				: undefined;
	return typeof following === 'boolean' ? ` (${profileFollowRelationText(following)})` : '';
}

function profileFollowRelationFromRecord(record: Record<string, unknown>): string {
	const relationship = profileRelationshipTexts(record);
	return relationship.length > 0 ? `, ${relationship.join(', ')}` : '';
}

function profileFollowRelationText(following: boolean): string {
	return following ? 'I follow this profile' : 'I do not follow this profile';
}

function profileRelationshipTexts(record: Record<string, unknown>): string[] {
	const result: string[] = [];
	const isFollowedByMe =
		typeof record.isFollowedByMe === 'boolean'
			? record.isFollowedByMe
			: typeof record.following === 'boolean'
				? record.following
				: undefined;
	if (typeof isFollowedByMe === 'boolean') {
		result.push(profileFollowRelationText(isFollowedByMe));
	}
	if (typeof record.isFollowingMe === 'boolean') {
		result.push(record.isFollowingMe ? 'this profile follows me' : 'this profile does not follow me');
	}
	return result;
}

function listProfilesHistorySummary(args: Record<string, unknown>): string {
	const mode = stringValue(args.mode) === 'random' ? 'random' : 'window';
	const limit = stringValue(args.limit);
	if (mode === 'random') {
		return `list${limit ? ` ${limit}` : ''} randomly selected profiles`;
	}
	const offset = stringValue(args.offset);
	return `list profiles by handle${limit ? `, up to ${limit}` : ''}${offset ? `, starting at offset ${offset}` : ''}`;
}

function queryFollowersHistorySummary(args: Record<string, unknown>): string {
	const isFollowing = stringValue(args.isFollowing);
	const isFollowedBy = stringValue(args.isFollowedBy);
	const usernameGlob = stringValue(args.usernameGlob);
	const filter = usernameGlob ? ` matching ${quoteForContext(usernameGlob, 80)}` : '';
	if (isFollowing) {
		return `query profiles following u/${isFollowing.replace(/^u\//i, '')}${filter}`;
	}
	return `query profiles followed by u/${(isFollowedBy ?? 'unknown').replace(/^u\//i, '')}${filter}`;
}

function readContentItemRef(record: Record<string, unknown>): string {
	const id = parseCommentRef(stringValue(record.commentRef)) ?? stringValue(record.commentId) ?? stringValue(record.id) ?? 'unknown';
	const threadId = parseThreadRef(stringValue(record.threadRef)) ?? stringValue(record.threadId) ?? 'unknown';
	const title = stringValue(record.title);
	const body = stringValue(record.body);
	const relationship = authorFollowRelationFromRecord(record);
	const target =
		record['My focus is on this comment'] === true || record.target === true
			? ' This was the focused comment.'
			: record.ancestorOnly === true
				? ' This was parent context.'
				: '';
	if (stringValue(record.type) === 'thread') {
		return `root comment for thread ${formatThreadRef(threadId)} in f/${forumHandleFromRecord(record)}${title ? ` titled ${quoteForContext(title, 120)}` : ''} by u/${authorHandleFromRecord(record)}${relationship}${body ? `: ${quoteForContext(body, 180)}` : ''}${target}`;
	}
	const parentCommentId = stringValue(record.parentCommentId);
	return `comment ${formatCommentRef(id)} in thread ${formatThreadRef(threadId)}${parentCommentId ? ` under comment ${formatCommentRef(parentCommentId)}` : ''} in f/${forumHandleFromRecord(record)} by u/${authorHandleFromRecord(record)}${relationship}${body ? `: ${quoteForContext(body, 180)}` : ''}${target}`;
}

function forumRef(record: Record<string, unknown>): string {
	const handle = stringValue(record.handle) ?? stringValue(record.forumHandle) ?? 'unknown';
	const id = stringValue(record.id) ?? stringValue(record.forumId);
	const description = safeContextText(stringValue(record.description) ?? '', 140);
	return `f/${handle}${id ? ` (${id})` : ''}${description ? `, ${description}` : ''}`;
}

function threadSummaryRef(record: Record<string, unknown>): string {
	const id = parseThreadRef(stringValue(record.threadRef)) ?? stringValue(record.id) ?? stringValue(record.threadId) ?? 'unknown';
	return `thread ${formatThreadRef(id)} in f/${forumHandleFromRecord(record)} titled ${quoteForContext(stringValue(record.title) ?? 'untitled', 140)} by u/${authorHandleFromRecord(record)}${authorFollowRelationFromRecord(record)} with ${stringValue(record.commentCount) ?? '?'} comments`;
}

function searchPostRef(record: Record<string, unknown>): string {
	const threadId = parseThreadRef(stringValue(record.threadRef)) ?? stringValue(record.threadId) ?? 'unknown';
	const commentId = parseCommentRef(stringValue(record.commentRef)) ?? stringValue(record.commentId);
	const target = commentId
		? `comment ${formatCommentRef(commentId)} in thread ${formatThreadRef(threadId)}`
		: `thread ${formatThreadRef(threadId)}`;
	return `${target} in f/${forumHandleFromRecord(record)} titled ${quoteForContext(stringValue(record.title) ?? 'untitled', 140)} by u/${authorHandleFromRecord(record)}${authorFollowRelationFromRecord(record)}: ${quoteForContext(stringValue(record.snippet) ?? '', 160)}`;
}

function profileRef(record: Record<string, unknown>): string {
	const handle = stringValue(record.handle);
	const id = stringValue(record.id);
	if (!handle && !id) {
		return '';
	}
	const relationship = profileFollowRelationFromRecord(record);
	return `${quoteForContext(stringValue(record.displayName) ?? 'unknown', 100)}${handle ? `, u/${handle}` : ''}${id ? `, profile ${id}` : ''}${relationship}`;
}

function activityRef(record: Record<string, unknown>): string {
	const type = stringValue(record.type) ?? 'activity';
	if (type === 'thread' || type === 'post') {
		return `a thread ${providerThreadRef(record.threadRef ?? record.threadId ?? record.id) ?? 'unknown'} in f/${forumHandleFromRecord(record)} titled ${quoteForContext(stringValue(record.title) ?? 'untitled', 120)}`;
	}
	if (type === 'comment') {
		return `comment ${providerCommentRef(record.commentRef ?? record.commentId ?? record.id) ?? 'unknown'} in thread ${providerThreadRef(record.threadRef ?? record.threadId) ?? 'unknown'} in f/${forumHandleFromRecord(record)}`;
	}
	if (type === 'vote') {
		return `a vote on comment ${providerCommentRef(record.commentRef ?? record.commentId ?? record.targetId) ?? 'unknown'}`;
	}
	if (type === 'follow') {
		return `a follow of ${profileRef(runtimeRecord(record.bot ?? record.profile))}`;
	}
	return `${safeContextText(type, 80)} activity ${entityFields(record, ['id', 'threadId', 'commentId', 'targetId'])}`;
}

function readResultRef(record: Record<string, unknown>): string {
	const thread = runtimeRecord(record.thread);
	const content = Array.isArray(record.content) ? record.content.map(runtimeRecord) : [];
	const targetCommentId = parseCommentRef(stringValue(record.targetCommentRef)) ?? stringValue(record.targetCommentId);
	const visibleContent = flattenedReadContentRecords(content);
	const omittedReplyCount = providerCollapsedReplyCount(content);
	const contentSummary = visibleContent.slice(0, 14).map(readContentItemRef).join('; ');
	return `I read ${threadSummaryRef(thread)}${targetCommentId ? `, focused on comment ${formatCommentRef(targetCommentId)}` : ''}. I saw ${visibleContent.length} item${visibleContent.length === 1 ? '' : 's'}${omittedReplyCount > 0 ? `, with ${omittedReplyCount} direct replies collapsed` : ''}${contentSummary ? `: ${contentSummary}` : ''}.`;
}

function flattenedReadContentRecords(content: Record<string, unknown>[]): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	for (const item of content) {
		records.push(item);
		records.push(...flattenedReadContentRecords(providerCommentReplies(item)));
	}
	return records;
}

function mutationThreadResultRef(name: string, record: Record<string, unknown>): string {
	const thread = runtimeRecord(record.thread);
	const comment = runtimeRecord(record.comment);
	if (name === 'create_thread') {
		return `I created ${threadSummaryRef(thread)}.`;
	}
	const commentId = parseCommentRef(stringValue(comment.commentRef)) ?? stringValue(comment.commentId) ?? stringValue(comment.id);
	const threadId =
		parseThreadRef(stringValue(comment.threadRef)) ??
		stringValue(comment.threadId) ??
		stringValue(thread.threadRef) ??
		stringValue(thread.threadId) ??
		stringValue(thread.id) ??
		'unknown';
	const parentCommentId = stringValue(comment.parentCommentId);
	return `I replied in thread ${formatThreadRef(threadId)}${commentId ? ` with comment ${formatCommentRef(commentId)}` : ''}${parentCommentId ? ` under comment ${formatCommentRef(parentCommentId)}` : ''}${stringValue(comment.body) ? `: ${quoteForContext(stringValue(comment.body) ?? '', 220)}` : ''}.`;
}

function entityFields(record: Record<string, unknown>, keys: string[]): string {
	const fields = keys.map((key) => stringValue(record[key])).filter((value): value is string => Boolean(value));
	return fields.length > 0 ? `with identifiers ${fields.join(', ')}` : '';
}

function historyUsernames(args: Record<string, unknown>): string[] {
	return historyProfileTargets(args).map((target) => target.username);
}

function historyProfileTargets(args: Record<string, unknown>): FollowToolHistoryTarget[] {
	if (Array.isArray(args.targets)) {
		return args.targets
			.map((item) => {
				const record = runtimeRecord(item);
				const username = stringValue(record.username) ?? stringValue(record.handle);
				if (!username) {
					return null;
				}
				const reason = localizedArgumentText(record.reason);
				return {
					username: `u/${username.replace(/^u\//i, '')}`,
					...(reason ? { reason } : {}),
				};
			})
			.filter((item): item is FollowToolHistoryTarget => item !== null);
	}
	const usernames = Array.isArray(args.usernames) ? args.usernames : [args.username];
	const reason = localizedArgumentText(args.reason);
	return usernames
		.map((value) => stringValue(value))
		.filter((value): value is string => Boolean(value))
		.map((value) => ({
			username: `u/${value.replace(/^u\//i, '')}`,
			...(reason ? { reason } : {}),
		}));
}

function historyVoteTargets(args: Record<string, unknown>): VoteToolTarget[] {
	const votes = Array.isArray(args.votes) ? args.votes : [args];
	return votes
		.map((item) => {
			const record = runtimeRecord(item);
			const commentId = parseCommentRef(stringValue(record.commentRef)) ?? stringValue(record.commentId) ?? stringValue(record.targetId);
			if (!commentId) {
				return null;
			}
			return {
				commentId,
				value: voteValueForHistory(record.value),
			};
		})
		.filter((item): item is VoteToolTarget => item !== null);
}

function voteTargetHistoryRef(vote: VoteToolTarget): string {
	const direction = vote.value > 0 ? 'upvote' : vote.value < 0 ? 'downvote' : 'clear my vote on';
	return `${direction} comment ${formatCommentRef(vote.commentId)}`;
}

function voteValueForHistory(value: unknown): -1 | 0 | 1 {
	const vote = Number(value);
	return vote > 0 ? 1 : vote < 0 ? -1 : 0;
}

const botEmbeddingModel = '@cf/google/embeddinggemma-300m';

type EmbeddingResponse = {
	data?: number[][];
	shape?: number[];
};

type BotVectorEnv = Pick<Env, 'AI' | 'BICKR_BOT_VECTORIZE' | 'BICKR_SEARCH_VECTORIZE' | 'BICKR_D1' | 'BICKR_KV'>;

async function upsertBotVector(env: BotVectorEnv, bot: BotSummary): Promise<void> {
	await upsertBotSearchVector(env, bot);
}

async function deleteBotVector(env: BotVectorEnv, botId: string): Promise<void> {
	await deleteSearchVector(env, 'bot', botId);
}

async function vectorSearchBots(env: BotVectorEnv, worldId: string, query: string, limit: number): Promise<BotSearchResult[]> {
	if (!env.AI || (!env.BICKR_SEARCH_VECTORIZE && !env.BICKR_BOT_VECTORIZE) || !query.trim()) {
		return [];
	}
	const vectorIndex = env.BICKR_SEARCH_VECTORIZE ?? env.BICKR_BOT_VECTORIZE;
	if (!vectorIndex) {
		return [];
	}
	try {
		const vector = await embedText(env, query);
		if (!vector) {
			return [];
		}
		const matches = await retryIdempotentCloudflareBinding('Profile vector query', () =>
			withStandaloneTimeout('Profile vector query', vectorBindingTimeoutMs, () =>
				vectorIndex.query(vector, {
					topK: Math.max(1, Math.min(50, limit)),
					returnMetadata: true,
					filter: { worldId },
				}),
			),
		);
		const results: BotSearchResult[] = [];
		for (const match of matches.matches) {
			const bot = await botById(env.BICKR_KV, env.BICKR_D1, match.id);
			if (bot.homeWorldId === worldId) {
				results.push({
					...botPublicProfile(bot),
					score: match.score,
					source: 'vector',
				});
			}
		}
		return results;
	} catch (error) {
		console.warn('bot vector search failed; falling back to text search', error);
		return [];
	}
}

async function embedText(env: Pick<Env, 'AI'>, text: string): Promise<number[] | null> {
	if (!env.AI) {
		return null;
	}
	const ai = env.AI;
	const response = await retryIdempotentCloudflareBinding('Profile embedding', () =>
		withStandaloneTimeout(
			'Profile embedding',
			vectorBindingTimeoutMs,
			() => ai.run(botEmbeddingModel, { text: [text] }) as Promise<EmbeddingResponse>,
		),
	);
	return response.data?.[0] ?? null;
}

function retryIdempotentCloudflareBinding<T>(operation: string, run: () => Promise<T>): Promise<T> {
	return retryCloudflareOperation({
		operation,
		run,
		maxAttempts: cloudflareBindingRetryMaxAttempts,
		initialDelayMs: cloudflareBindingRetryInitialDelayMs,
		maxDelayMs: cloudflareBindingRetryMaxDelayMs,
		shouldRetry: isCloudflareRateLimitError,
	});
}

function reasoningTextFromDetails(details: ReasoningDetail[]): string {
	return details.map(reasoningDetailText).join('');
}

function reasoningDetailText(detail: ReasoningDetail): string {
	const text = detail.text;
	if (typeof text === 'string') {
		return text;
	}
	return reasoningSummaryText(detail.summary);
}

function reasoningSummaryText(summary: unknown): string {
	if (typeof summary === 'string') {
		return summary;
	}
	if (!Array.isArray(summary)) {
		return '';
	}
	return summary
		.map((item) => {
			if (typeof item === 'string') {
				return item;
			}
			const record = runtimeRecord(item);
			const text = record.text;
			if (typeof text === 'string') {
				return text;
			}
			const nestedSummary = record.summary;
			return typeof nestedSummary === 'string' ? nestedSummary : '';
		})
		.join('');
}

function seenItemFromSource(sourceObjectId: string | undefined): { type: 'thread' | 'comment'; id: string } | null {
	return parseObjectRef(sourceObjectId) ?? null;
}

function uniqueSeenContentItems(items: SeenContentItem[]): SeenContentItem[] {
	const byKey = new Map<string, SeenContentItem>();
	for (const item of items) {
		byKey.set(`${item.type}:${item.id}`, item);
	}
	return [...byKey.values()];
}

function providerChatCompletionsUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, '');
	return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

function providerImagesUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, '');
	if (normalized.endsWith('/images')) {
		return normalized;
	}
	if (normalized.endsWith('/chat/completions')) {
		return `${normalized.slice(0, -'/chat/completions'.length)}/images`;
	}
	return `${normalized}/images`;
}

function estimateTextTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function estimateTextTokensWithCalibration(text: string, calibration: TextTokenCalibration): number {
	return Math.max(1, Math.ceil(text.length * calibration.tokensPerCharacter));
}

function estimateChatMessageTokens(message: ChatMessage, calibration: TextTokenCalibration): number {
	return estimateChatMessagesTokens([message], calibration);
}

function estimateChatMessagesTokens(messages: readonly ChatMessage[], calibration: TextTokenCalibration): number {
	const characters = chatMessagesCharacterCount(messages);
	if (characters <= 0) {
		return 0;
	}
	return Math.max(1, Math.ceil(characters * calibration.tokensPerCharacter));
}

function providerTokenCalibrationRequestCharacterCount(request: ProviderTokenCalibrationRequestShape): number {
	return (
		chatMessagesCharacterCount(request.messages) +
		JSON.stringify(request.tools ?? []).length +
		JSON.stringify(request.response_format ?? {}).length
	);
}

export function oldestRowsForTokenFraction<T>(rows: readonly { row: T; tokens: number }[], fraction: number): T[] {
	const totalTokens = rows.reduce((total, item) => total + Math.max(0, item.tokens), 0);
	if (totalTokens <= 0 || fraction <= 0) {
		return [];
	}
	const targetTokens = Math.ceil(totalTokens * Math.min(1, fraction));
	const selected: T[] = [];
	let selectedTokens = 0;
	for (const item of rows) {
		selected.push(item.row);
		selectedTokens += Math.max(0, item.tokens);
		if (selectedTokens >= targetTokens) {
			break;
		}
	}
	return selected;
}

const compactionOverBudgetFallbackMinSelectedTokens = 1_000;

function oldestLoopMessageGroupSelectionForPromptLimit(
	rows: readonly CompactionCandidateEstimate[],
	limitTokens: number,
	options: { canIncludeRows?: (rows: readonly LoopMessageRow[]) => boolean; requireMinimumSelectedTokens?: boolean } = {},
): CompactionRowSelection {
	const groups = loopMessageCompactionGroups(rows);
	const promptLimitTokens = Math.max(1, Math.floor(limitTokens));
	const targetTokens = Math.max(1, Math.ceil(promptLimitTokens * compactionRowTokenFraction));
	const selected: LoopMessageRow[] = [];
	let selectedTokens = 0;
	for (const group of groups) {
		const nextTokens = selectedTokens + group.tokens;
		const nextRows = [...selected, ...group.rows];
		const leavesOutputBudget = options.canIncludeRows?.(nextRows) !== false;
		if (nextTokens > promptLimitTokens || !leavesOutputBudget) {
			if (selectedTokens < compactionOverBudgetFallbackMinSelectedTokens && group.rows.length > 0) {
				return {
					rows: nextRows,
					overBudgetFallback: true,
				};
			}
			return {
				rows: selected,
				overBudgetFallback: false,
			};
		}
		if (nextTokens >= targetTokens) {
			return {
				rows: selectedTokens < compactionOverBudgetFallbackMinSelectedTokens ? nextRows : selected,
				overBudgetFallback: false,
			};
		}
		selected.push(...group.rows);
		selectedTokens = nextTokens;
	}
	return {
		rows: options.requireMinimumSelectedTokens && selectedTokens < compactionOverBudgetFallbackMinSelectedTokens ? [] : selected,
		overBudgetFallback: false,
	};
}

function reducedCompactionRowsAfterOutputLimit(rows: readonly LoopMessageRow[], calibration: TextTokenCalibration): LoopMessageRow[] {
	const estimates = rows.map((row) => ({
		row,
		tokens: estimateChatMessageTokens(loopMessageChatMessageFromRow(row), calibration),
	}));
	const groups = loopMessageCompactionGroups(estimates);
	if (groups.length <= 1) {
		return [...rows];
	}
	const totalTokens = groups.reduce((total, group) => total + Math.max(0, group.tokens), 0);
	const targetTokens = Math.max(1, Math.floor(totalTokens / 2));
	let selectedGroups: Array<{ rows: LoopMessageRow[]; tokens: number }> = [];
	let selectedTokens = 0;
	for (const group of groups) {
		if (
			selectedGroups.length > 0 &&
			selectedTokens >= compactionOverBudgetFallbackMinSelectedTokens &&
			selectedTokens + group.tokens > targetTokens
		) {
			break;
		}
		selectedGroups.push(group);
		selectedTokens += group.tokens;
		if (selectedTokens >= targetTokens) {
			break;
		}
	}
	if (selectedGroups.length === 0 || selectedGroups.length >= groups.length) {
		selectedGroups = groups.slice(0, -1);
	}
	const reducedTokens = selectedGroups.reduce((total, group) => total + Math.max(0, group.tokens), 0);
	if (reducedTokens < compactionOverBudgetFallbackMinSelectedTokens) {
		return [...rows];
	}
	return selectedGroups.flatMap((group) => group.rows);
}

function isProviderCompactionOutputLimitFailure(error: unknown): boolean {
	return (
		error instanceof ProviderCompactionOutputLimitError ||
		(error instanceof ProviderCompactionRequestError && error.originalError instanceof ProviderCompactionOutputLimitError)
	);
}

function providerCompactionNoReasoningRejected(error: unknown, request?: ProviderCompactionRequest): boolean {
	if (!(error instanceof ProviderRequestError)) {
		return false;
	}
	const text = `${error.message}\n${error.body}`.toLowerCase();
	if (error.status >= 500 && error.status < 600) {
		return providerCompactionNoReasoningServerToolCrash(text, request);
	}
	return (
		error.status >= 400 &&
		error.status < 500 &&
		/(?:\breasoning\b|reasoning[_ -]?effort)/.test(text) &&
		/(?:\bnone\b|disabl|unsupported|not supported|invalid|not allowed|must be one of|unrecognized|unknown)/.test(text)
	);
}

function providerCompactionNoReasoningServerToolCrash(text: string, request?: ProviderCompactionRequest): boolean {
	return (
		requestIncludesOpenRouterServerTools(request) &&
		/\binternal server error\b/.test(text)
	);
}

function requestIncludesOpenRouterServerTools(request?: Pick<ProviderCompactionRequest, 'tools'>): boolean {
	return request?.tools?.some((tool) => tool.type.startsWith('openrouter:')) === true;
}

export function textTokenCalibrationFromProviderTokenCalibrationSamples(
	rows: readonly {
		prompt_tokens: number;
		request_characters: number;
	}[],
): TextTokenCalibration {
	const samples: number[] = [];
	for (const row of rows) {
		const promptTokens = Math.max(0, Number(row.prompt_tokens));
		const requestCharacters = Math.max(0, Number(row.request_characters));
		addTokenCalibrationSample(samples, promptTokens, requestCharacters);
	}

	if (samples.length === 0) {
		return {
			tokensPerCharacter: fallbackTokensPerCharacter,
			sampleCount: 0,
		};
	}
	const sortedSamples = [...samples].sort((left, right) => left - right);
	const middle = Math.floor(sortedSamples.length / 2);
	const median = sortedSamples.length % 2 === 1 ? sortedSamples[middle]! : (sortedSamples[middle - 1]! + sortedSamples[middle]!) / 2;
	return {
		tokensPerCharacter: clampNumber(median, minCalibratedTokensPerCharacter, maxCalibratedTokensPerCharacter),
		sampleCount: sortedSamples.length,
	};
}

export function textTokenCalibrationFromPromptHistory(
	rows: readonly {
		event_seq: number;
		run_id: string;
		purpose: BotInferenceSubmissionPurpose;
		messages_json: string;
		prompt_tokens: number;
	}[],
): TextTokenCalibration {
	return textTokenCalibrationFromProviderTokenCalibrationSamples(
		rows.map((row) => ({
			prompt_tokens: row.prompt_tokens,
			request_characters: chatMessagesCharacterCountFromJson(row.messages_json),
		})),
	);
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parsePayloadJson(payloadJson: string): Record<string, unknown> {
	try {
		return runtimeRecord(JSON.parse(payloadJson) as unknown);
	} catch {
		return {};
	}
}

function addTokenCalibrationSample(samples: number[], tokens: number, characters: number): void {
	if (tokens <= 0 || characters < 80) {
		return;
	}
	samples.push(clampNumber(tokens / characters, minCalibratedTokensPerCharacter, maxCalibratedTokensPerCharacter));
}

function chatMessagesCharacterCountFromJson(messagesJson: string): number {
	const messages = parseChatMessagesJson(messagesJson);
	return messages ? chatMessagesCharacterCount(messages) : 0;
}

function parseChatMessagesJson(messagesJson: string): ChatMessage[] | null {
	try {
		const parsed = JSON.parse(messagesJson) as unknown;
		return Array.isArray(parsed) ? (parsed as ChatMessage[]) : null;
	} catch {
		return null;
	}
}

function chatMessagesArePrefix(prefix: readonly ChatMessage[], messages: readonly ChatMessage[]): boolean {
	if (prefix.length > messages.length) {
		return false;
	}
	for (let index = 0; index < prefix.length; index += 1) {
		if (JSON.stringify(prefix[index]) !== JSON.stringify(messages[index])) {
			return false;
		}
	}
	return true;
}

function chatMessagesCharacterCount(messages: readonly ChatMessage[]): number {
	return messages.reduce((total, message) => {
		const toolCallCharacters = (message.tool_calls ?? []).reduce((sum, toolCall) => {
			return sum + toolCall.id.length + toolCall.function.name.length + toolCall.function.arguments.length;
		}, 0);
		return (
			total +
			message.role.length +
			textLength(message.content) +
			textLength(message.tool_call_id) +
			textLength(message.reasoning) +
			textLength(message.reasoning_content) +
			(message.reasoning_details ? JSON.stringify(message.reasoning_details).length : 0) +
			toolCallCharacters
		);
	}, 0);
}

function textLength(value: string | null | undefined): number {
	return value?.length ?? 0;
}

function clampNumber(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function truncateForContext(text: string, maxLength: number): string {
	const repaired = repairInvalidUnicodeText(text);
	if (repaired.length <= maxLength) {
		return repaired;
	}
	return `${unicodeSafeSlice(repaired, Math.max(0, maxLength - 1))}…`;
}

type ReadTextOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
	timeoutError?: () => Error;
};

type ReadTextResult = {
	text: string;
	truncated: boolean;
};

async function readProviderErrorBody(response: Response, signal: AbortSignal): Promise<string> {
	try {
		return await readLimitedText(response.body, 1_200, {
			signal,
			timeoutMs: providerBodyReadTimeoutMs,
			timeoutError: () => new ProviderResponseBodyTimeoutError(providerBodyReadTimeoutMs),
		});
	} catch (error) {
		if (error instanceof TickStoppedError || isAbortError(error)) {
			throw error;
		}
		if (error instanceof ProviderResponseBodyTimeoutError) {
			return 'Timed out while reading provider error response.';
		}
		return 'Could not read provider error response.';
	}
}

async function readJsonResponse(
	response: Response,
	maxBytes: number,
	signal: AbortSignal,
	timeoutMs: number,
	timeoutError: () => Error,
): Promise<unknown> {
	return JSON.parse(await readJsonResponseText(response, maxBytes, signal, timeoutMs, timeoutError));
}

async function readJsonResponseText(
	response: Response,
	maxBytes: number,
	signal: AbortSignal,
	timeoutMs: number,
	timeoutError: () => Error,
): Promise<string> {
	const result = await readTextFromStream(response.body, maxBytes, {
		signal,
		timeoutMs,
		timeoutError,
	});
	if (result.truncated) {
		throw new ResponseBodySizeLimitError(maxBytes);
	}
	return result.text;
}

async function readLimitedText(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	options: ReadTextOptions = {},
): Promise<string> {
	const result = await readTextFromStream(stream, maxBytes, options);
	const trimmed = result.text.trim();
	return result.truncated ? `${trimmed}...` : trimmed;
}

async function readTextFromStream(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	options: ReadTextOptions = {},
): Promise<ReadTextResult> {
	if (!stream) {
		return { text: '', truncated: false };
	}
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = '';
	let bytesRead = 0;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	const cancelReader = (reason: string) => {
		void reader.cancel(reason).catch(() => {
			// The stream may already have completed or been canceled by the peer.
		});
	};
	const timeoutMs = options.timeoutMs;
	const timeoutPromise =
		timeoutMs === undefined
			? undefined
			: new Promise<never>((_, reject) => {
					timeout = setTimeout(() => {
						const error = options.timeoutError ? options.timeoutError() : new RuntimeOperationTimeoutError('Response body read', timeoutMs);
						cancelReader(error.message);
						reject(error);
					}, timeoutMs);
				});
	let abortPromise: Promise<never> | undefined;
	if (options.signal) {
		if (options.signal.aborted) {
			cancelReader('This Bickr visit was stopped.');
			throw new TickStoppedError();
		}
		abortPromise = new Promise<never>((_, reject) => {
			abortListener = () => {
				cancelReader('This Bickr visit was stopped.');
				reject(new TickStoppedError());
			};
			options.signal?.addEventListener('abort', abortListener, { once: true });
		});
	}
	const read = () => Promise.race([reader.read(), ...(timeoutPromise ? [timeoutPromise] : []), ...(abortPromise ? [abortPromise] : [])]);
	try {
		while (true) {
			if (bytesRead >= maxBytes) {
				const { done } = await read();
				if (done) {
					text += decoder.decode();
					return { text, truncated: false };
				}
				cancelReader('Response body byte limit reached.');
				return { text, truncated: true };
			}
			const { done, value } = await read();
			if (done) {
				text += decoder.decode();
				return { text, truncated: false };
			}
			const remaining = maxBytes - bytesRead;
			const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
			bytesRead += chunk.byteLength;
			const truncated = value.byteLength > remaining;
			text += decoder.decode(chunk, { stream: !truncated });
			if (value.byteLength > remaining) {
				cancelReader('Response body byte limit reached.');
				return { text, truncated: true };
			}
		}
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
		if (options.signal && abortListener) {
			options.signal.removeEventListener('abort', abortListener);
		}
		try {
			reader.releaseLock();
		} catch {
			// A canceled read can still be settling after the caller has moved on.
		}
	}
}

function isAbortError(error: unknown): boolean {
	return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError');
}

type SseEvent = { data: string; raw: string };

const sseEventBoundaryPattern = /\r?\n\r?\n/;

function sseEventData(raw: string): string {
	return raw
		.split(/\r?\n/)
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trim())
		.join('\n');
}

// TODO(#44): move this SSE parser to provider/sse.ts when provider code is split out.
export async function* readSse(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	idleTimeoutMs = providerStreamIdleTimeoutMs,
): AsyncGenerator<SseEvent> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	function* drainCompleteEvents(): Generator<SseEvent> {
		let boundary = buffer.match(sseEventBoundaryPattern);
		while (boundary?.index !== undefined) {
			const raw = buffer.slice(0, boundary.index);
			const boundaryText = boundary[0];
			buffer = buffer.slice(boundary.index + boundaryText.length);
			const data = sseEventData(raw);
			if (data) {
				yield { data, raw: `${raw}${boundaryText}` };
			}
			boundary = buffer.match(sseEventBoundaryPattern);
		}
	}
	function residualEvent(): SseEvent | null {
		if (!buffer) {
			return null;
		}
		const raw = buffer;
		buffer = '';
		const data = sseEventData(raw);
		return data ? { data, raw } : null;
	}
	try {
		while (true) {
			if (signal?.aborted) {
				throw new TickStoppedError();
			}
			const { done, value } = await readStreamChunk(reader, idleTimeoutMs, () => new ProviderStreamIdleTimeoutError(idleTimeoutMs), signal);
			if (signal?.aborted) {
				throw new TickStoppedError();
			}
			if (done) {
				buffer += decoder.decode();
				yield* drainCompleteEvents();
				const event = residualEvent();
				if (event) {
					yield event;
				}
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			yield* drainCompleteEvents();
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// A timed-out read can still be settling after we have rejected the provider stream.
		}
	}
}

async function readStreamChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	idleTimeoutMs: number,
	timeoutError: () => Error = () => new ProviderStreamIdleTimeoutError(idleTimeoutMs),
	signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (signal?.aborted) {
		void reader.cancel('This Bickr visit was stopped.').catch(() => {
			// The stream may already be closed or aborted by the provider.
		});
		throw new TickStoppedError();
	}
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	const cancelReader = (reason: string) => {
		void reader.cancel(reason).catch(() => {
			// The stream may already be closed or aborted by the provider.
		});
	};
	const abortPromise = signal
		? new Promise<never>((_, reject) => {
				abortListener = () => {
					cancelReader('This Bickr visit was stopped.');
					reject(new TickStoppedError());
				};
				signal.addEventListener('abort', abortListener, { once: true });
			})
		: undefined;
	try {
		return await Promise.race([
			reader.read(),
			...(abortPromise ? [abortPromise] : []),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					const error = timeoutError();
					cancelReader(error.message);
					reject(error);
				}, idleTimeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
		if (signal && abortListener) {
			signal.removeEventListener('abort', abortListener);
		}
	}
}

async function providerFetchWithHeaderTimeout(
	endpoint: string,
	init: RequestInit,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<Response> {
	return withAbortableTimeout(
		signal,
		timeoutMs,
		() => new ProviderRequestTimeoutError(timeoutMs),
		(timeoutSignal) => fetch(endpoint, { ...init, signal: timeoutSignal }),
	);
}

async function withStandaloneTimeout<T>(operation: string, timeoutMs: number, run: () => Promise<T>): Promise<T> {
	const parent = new AbortController();
	return withAbortableTimeout(
		parent.signal,
		timeoutMs,
		() => new RuntimeOperationTimeoutError(operation, timeoutMs),
		() => run(),
	);
}

async function withAbortableTimeout<T>(
	signal: AbortSignal,
	timeoutMs: number,
	timeoutError: () => Error,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	if (signal.aborted) {
		throw new TickStoppedError();
	}
	const controller = new AbortController();
	let timedOut = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let abortFromParent: (() => void) | undefined;
	const abortPromise = new Promise<never>((_, reject) => {
		abortFromParent = () => {
			controller.abort();
			reject(new TickStoppedError());
		};
		signal.addEventListener('abort', abortFromParent, { once: true });
	});
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
			reject(timeoutError());
		}, timeoutMs);
	});
	try {
		return await Promise.race([run(controller.signal), abortPromise, timeoutPromise]);
	} catch (error) {
		if (timedOut) {
			throw timeoutError();
		}
		if (signal.aborted) {
			throw new TickStoppedError();
		}
		throw error;
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
		if (abortFromParent) {
			signal.removeEventListener('abort', abortFromParent);
		}
	}
}

function isRetryableProviderStatus(status: number): boolean {
	return (
		status === 408 ||
		status === 409 ||
		status === 425 ||
		status === 429 ||
		status === 500 ||
		status === 502 ||
		status === 503 ||
		status === 504 ||
		status === 529
	);
}

function providerRetryKey(error: unknown): string | null {
	if (
		error instanceof ProviderRequestTimeoutError ||
		error instanceof ProviderResponseBodyTimeoutError ||
		error instanceof ProviderStreamIdleTimeoutError
	) {
		return error.message;
	}
	if (error instanceof ProviderRequestError && isRetryableProviderStatus(error.status)) {
		return `${error.status}:${error.body}`;
	}
	return null;
}

type ProviderUpstreamRateLimitRetry = {
	providerName: string;
	retryKey: string;
};

function providerRetryDelayMsForAttempt(attempt: number): number {
	return jitteredDelay(providerRetryBaseDelayMs * 3 ** Math.max(0, attempt - 2));
}

function providerUpstreamRateLimitRetry(error: unknown): ProviderUpstreamRateLimitRetry | null {
	if (!(error instanceof ProviderRequestError)) {
		return null;
	}
	for (const payload of providerErrorPayloads(error)) {
		const match = providerUpstreamRateLimitRetryFromPayload(
			payload,
			error.status,
			providerRetryKey(error) ?? `${error.status}:${error.body}`,
		);
		if (match) {
			return match;
		}
	}
	return null;
}

function providerUpstreamRateLimitRetryFromPayload(
	payload: unknown,
	fallbackStatus: number,
	retryKey: string,
): ProviderUpstreamRateLimitRetry | null {
	const payloadRecord = runtimeRecord(payload);
	const errorRecord = runtimeRecord(payloadRecord.error);
	const record = Object.keys(errorRecord).length > 0 ? errorRecord : payloadRecord;
	const status = providerErrorStatus(record.code);
	if (fallbackStatus !== 429 && status !== 429) {
		return null;
	}
	if (stringValue(record.message) !== 'Provider returned error') {
		return null;
	}
	const providerName = stringValue(runtimeRecord(record.metadata).provider_name)?.trim();
	if (!providerName) {
		return null;
	}
	return { providerName, retryKey };
}

function providerErrorPayloads(error: ProviderRequestError): unknown[] {
	const payloads: unknown[] = [];
	const body = parseJsonValue(error.body);
	if (body !== undefined) {
		payloads.push(body);
	}
	const rawResponse = parseJsonValue(error.rawResponse);
	if (rawResponse !== undefined) {
		payloads.push(rawResponse);
	}
	return payloads;
}

function parseJsonValue(text: string | undefined): unknown | undefined {
	if (text === undefined || !text.trim()) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function providerRoutingWithIgnoredProvider(
	providerRouting: JsonObject | undefined,
	providerName: string,
): { providerRouting: JsonObject; changed: boolean } {
	const trimmedProviderName = providerName.trim();
	const existingIgnore = Array.isArray(providerRouting?.ignore)
		? providerRouting.ignore.filter((value): value is string => typeof value === 'string').filter((value) => value.trim().length > 0)
		: [];
	const existingNames = new Set(existingIgnore.map((value) => value.trim().toLowerCase()));
	if (existingNames.has(trimmedProviderName.toLowerCase())) {
		return {
			providerRouting: { ...(providerRouting ?? {}), ignore: existingIgnore },
			changed: false,
		};
	}
	return {
		providerRouting: { ...(providerRouting ?? {}), ignore: [...existingIgnore, trimmedProviderName] },
		changed: true,
	};
}

function providerIgnoreRetryReason(retry: ProviderUpstreamRateLimitRetry): string {
	return `${retry.retryKey}; ignoring upstream provider ${retry.providerName}`;
}

function providerFailureResponseText(error: unknown): string | undefined {
	if (error instanceof ProviderStructuredOutputValidationError) {
		return error.rawResponse;
	}
	if (error instanceof ProviderCompactionOutputLimitError) {
		return error.rawResponse;
	}
	if (error instanceof ProviderRequestError) {
		return error.rawResponse ?? (error.body ? error.body : undefined);
	}
	if (error instanceof ProviderEmptyResponseError) {
		return error.rawResponse;
	}
	return undefined;
}

function providerTokenUsageMetadataFromError(
	error: unknown,
): { responseId?: string; responseModel?: string; usage?: ProviderUsage } | null {
	if (
		error instanceof ProviderRequestError ||
		error instanceof ProviderStructuredOutputValidationError ||
		error instanceof ProviderCompactionOutputLimitError ||
		error instanceof ProviderEmptyResponseError
	) {
		return {
			...(error.responseId ? { responseId: error.responseId } : {}),
			...(error.responseModel ? { responseModel: error.responseModel } : {}),
			...(error.usage ? { usage: error.usage } : {}),
		};
	}
	if (error instanceof ProviderResponseInterruptedError) {
		return {
			...(error.response.responseId ? { responseId: error.response.responseId } : {}),
			...(error.response.responseModel ? { responseModel: error.response.responseModel } : {}),
			...(error.response.usage ? { usage: error.response.usage } : {}),
		};
	}
	return null;
}

function providerCompactionOutputLimitReached(finishReason: string, nativeFinishReason: string): boolean {
	const normalized = `${finishReason} ${nativeFinishReason}`.toLowerCase();
	return /\blength\b/.test(normalized) || /\bmax[_-]?output[_-]?tokens\b/.test(normalized);
}

function providerLoopFailureMessage(error: unknown, attempts: number): string {
	const lastError = runtimeErrorText(error);
	if (attempts > 1) {
		const retries = attempts - 1;
		return `Inference failed after ${attempts} provider attempts (${retries} ${retries === 1 ? 'retry' : 'retries'}); last error from provider:\n${lastError}`;
	}
	return `Inference failed before retrying; error from provider:\n${lastError}`;
}

function providerCompactionFailureResponseText(error: unknown): string | undefined {
	return providerFailureResponseText(error);
}

export function runtimeFailureLogs(error: unknown): RuntimeFailureLog[] {
	if (error instanceof ProviderLoopRequestError) {
		return [
			{ kind: 'provider_request', text: error.requestBody },
			...(error.responseBody ? [{ kind: 'provider_response' as const, text: error.responseBody }] : []),
		];
	}
	if (error instanceof PersistentCompactionReductionFailureError) {
		return [
			{ kind: 'compaction_request', text: error.requestBody },
			...(error.responseBody ? [{ kind: 'compaction_response' as const, text: error.responseBody }] : []),
		];
	}
	if (error instanceof ProviderCompactionRequestError) {
		return [
			{ kind: 'compaction_request', text: error.requestBody },
			...(error.responseBody ? [{ kind: 'compaction_response' as const, text: error.responseBody }] : []),
		];
	}
	return [];
}

function runtimeErrorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function jitteredDelay(baseMs: number): number {
	const factor = 1 + (Math.random() * 2 - 1) / 3;
	return Math.max(0, Math.round(baseMs * factor));
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		throw new TickStoppedError();
	}
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener('abort', abort);
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timeout);
			signal.removeEventListener('abort', abort);
			reject(new TickStoppedError());
		};
		signal.addEventListener('abort', abort, { once: true });
	});
}

function pausedTickResult(): TickRunResult {
	return {
		runId: 'paused',
		status: 'paused',
		error: 'This participant is paused. Unpause it before starting a loop run.',
	};
}

async function readTickOptions(request: Request): Promise<TickOptions> {
	const contentType = request.headers.get('content-type') ?? '';
	if (!contentType.includes('application/json')) {
		return {};
	}
	const body = (await request.json()) as unknown;
	const record = runtimeRecord(body);
	const mode = record.mode === 'spotlight' ? 'spotlight' : 'normal';
	const injectionIds = Array.isArray(record.injectionIds)
		? record.injectionIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).map((id) => id.trim())
		: undefined;
	const spotlightId = stringValue(record.spotlightId);
	const background = record.background === true;
	return {
		mode,
		...(injectionIds ? { injectionIds } : {}),
		...(spotlightId ? { spotlightId } : {}),
		...(background ? { background } : {}),
	};
}

export function parseToolArgs(toolCall: ToolCall): Record<string, unknown> {
	const rawArguments = toolCall.function.arguments;
	if (!rawArguments) {
		return {};
	}
	try {
		const parsed = JSON.parse(rawArguments) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		throw new ToolCallArgumentValidationError(
			'arguments_not_json_object',
			`Malformed tool call! The arguments for ${canonicalToolName(toolCall.function.name || 'unknown_tool')} must be a JSON object, but ${jsonValueKind(parsed)} was provided.`,
		);
	} catch (error) {
		if (error instanceof ToolCallArgumentValidationError) {
			throw error;
		}
		throw new ToolCallArgumentValidationError(
			'invalid_arguments_json',
			`Malformed tool call! The arguments for ${canonicalToolName(toolCall.function.name || 'unknown_tool')} are not valid JSON: ${errorMessage(error)}`,
		);
	}
}

function malformedToolCallFailureArgs(toolCall: ToolCall): Record<string, unknown> {
	return { rawArguments: toolCall.function.arguments };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function jsonValueKind(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'an array';
	}
	return `a ${typeof value}`;
}

function normalizeToolArgs(name: string, args: Record<string, unknown>, language?: LanguageTag | null): Record<string, unknown> {
	const canonical = canonicalToolName(name);
	const normalized = { ...args };
	if ((canonical === 'read_thread' || canonical === 'read_thread_by_id') && ('threadRef' in normalized || 'threadId' in normalized)) {
		normalized.threadId = threadRefArg(normalized.threadRef ?? normalized.threadId, 'threadRef');
		delete normalized.threadRef;
	}
	if (canonical === 'read_comment_by_id' && ('commentRef' in normalized || 'commentId' in normalized)) {
		normalized.commentId = commentRefArg(normalized.commentRef ?? normalized.commentId, 'commentRef');
		delete normalized.commentRef;
	}
	if (
		(canonical === 'reply_to_comment' || canonical === 'make_additional_reply_to_the_same_comment') &&
		('commentRef' in normalized || 'commentId' in normalized || 'parentCommentRef' in normalized || 'parentCommentId' in normalized)
	) {
		normalized.commentId = commentRefArg(
			normalized.commentRef ?? normalized.commentId ?? normalized.parentCommentRef ?? normalized.parentCommentId,
			'commentRef',
		);
		delete normalized.commentRef;
		delete normalized.parentCommentRef;
		delete normalized.parentCommentId;
		delete normalized.threadId;
	}
	if (toolUsesForumHandle(canonical) && 'forumHandle' in normalized) {
		normalized.forumHandle = typedHandleArg(normalized.forumHandle, 'f', 'forumHandle');
	}
	if (canonical === 'vote' && 'votes' in normalized) {
		normalized.votes = voteTargetsArg(normalized.votes);
	}
	if (
		(canonical === 'reply_to_comment' || canonical === 'make_additional_reply_to_the_same_comment') &&
		!stringValue(normalized.commentId) &&
		stringValue(normalized.parentCommentId)
	) {
		normalized.commentId = stringValue(normalized.parentCommentId);
		delete normalized.parentCommentId;
		delete normalized.threadId;
	}
	if (canonical === 'follow_profile' || canonical === 'unfollow_profile') {
		normalized.targets = followToolTargetsFromArgs(normalized, language);
		delete normalized.username;
		delete normalized.usernames;
		delete normalized.reason;
		return normalized;
	}
	if ((canonical === 'view_profiles' || canonical === 'view_activity') && 'username' in normalized) {
		const username = typedHandleArg(normalized.username, 'u', 'username');
		if (canonical === 'view_profiles') {
			normalized.usernames = [username];
			delete normalized.username;
		} else {
			normalized.username = username;
		}
	}
	if (canonical === 'view_activity' && 'limit' in normalized) {
		normalized.limit = numberArg(normalized.limit, 10, 20);
	}
	if (canonical === 'list_profiles') {
		const query = listProfilesToolArgs(normalized);
		normalized.mode = query.mode;
		normalized.limit = query.limit;
		if (query.mode === 'window') {
			normalized.offset = query.offset;
		} else {
			delete normalized.offset;
		}
	}
	if (canonical === 'view_profiles' && 'usernames' in normalized) {
		normalized.usernames = usernamesArg(normalized.usernames);
	}
	if (canonical === 'query_followers') {
		const query = queryFollowersToolArgs(normalized);
		if (query.direction === 'followers') {
			normalized.isFollowing = query.username;
			delete normalized.isFollowedBy;
		} else {
			normalized.isFollowedBy = query.username;
			delete normalized.isFollowing;
		}
		if (query.usernameGlob) {
			normalized.usernameGlob = query.usernameGlob;
		} else {
			delete normalized.usernameGlob;
		}
	}
	return normalized;
}

function toolUsesForumHandle(name: string): boolean {
	return name === 'list_recent_threads' || name === 'create_thread';
}

function stringArg(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`${label} is required.`);
	}
	return value.trim();
}

export function localizedToolTextArg(value: unknown, label: string, language?: LanguageTag | null): RequiredLocalizedText {
	if (typeof value === 'string') {
		throw new ToolCallArgumentValidationError('bad_request', localizedToolTextStringError(value, label, language));
	}
	const record = runtimeRecord(value);
	if (!Object.hasOwn(record, 'lang') || !Object.hasOwn(record, 'text')) {
		throw new ToolCallArgumentValidationError('bad_request', `${label} must be an object with lang first and text second, for example ${localizedToolTextPropertyExample(label, 'ja', '将軍家')} or ${localizedToolTextPropertyExample(label, 'en', 'my text')}.`);
	}
	const lang = languageTagArg(record.lang, `${label}.lang`);
	if (typeof record.text !== 'string' || !record.text.trim()) {
		throw new ToolCallArgumentValidationError('bad_request', `${label}.text is required.`);
	}
	return { lang, text: record.text };
}

function localizedArgumentText(value: unknown): string | undefined {
	const direct = stringValue(value);
	if (direct) {
		return direct;
	}
	const text = stringValue(runtimeRecord(value).text);
	return text?.trim() ? text : undefined;
}

function localizedToolTextStringError(text: string, label: string, language?: LanguageTag | null): string {
	const lang = language ?? ('en' as LanguageTag);
	const provided = `${JSON.stringify(label)}:${JSON.stringify(text)}`;
	const expected = localizedToolTextPropertyExample(label, lang, text);
	return `Malformed tool call! ${label} is a string, but it must be an object. You provided ${provided}, which is incorrect; it should be something like ${expected} instead.`;
}

function localizedToolTextPropertyExample(label: string, lang: string, text: string): string {
	return `${JSON.stringify(label)}:${JSON.stringify({ lang, text })}`;
}

function localizedTextValue(value: unknown, fallback = ''): LocalizedText {
	const record = runtimeRecord(value);
	const text = typeof record.text === 'string' ? record.text : (stringValue(value) ?? fallback);
	return { lang: optionalLanguageTagValue(record.lang), text };
}

function optionalLanguageTagValue(value: unknown): LanguageTag | null {
	if (typeof value !== 'string' || !value.trim() || value.trim().toLowerCase() === 'und') {
		return null;
	}
	try {
		return (Intl.getCanonicalLocales(value.trim())[0] ?? null) as LanguageTag | null;
	} catch {
		return null;
	}
}

function languageTagArg(value: unknown, label: string): LanguageTag {
	if (typeof value !== 'string' || !value.trim() || value.trim().toLowerCase() === 'und') {
		throw new ToolCallArgumentValidationError('bad_request', `${label} must be a specific BCP 47 language tag such as "en", "ja", "zh-Hans", "zh-Hant", "ar", "mn-Mong", or "non"; do not use "und".`);
	}
	try {
		const canonical = Intl.getCanonicalLocales(value.trim())[0];
		if (!canonical) {
			throw new Error('invalid language tag');
		}
		return canonical as LanguageTag;
	} catch {
		throw new ToolCallArgumentValidationError('bad_request', `${label} must be a valid BCP 47 language tag such as "en", "ja", "zh-Hans", "zh-Hant", "ar", "mn-Mong", or "non".`);
	}
}

function threadRefArg(value: unknown, label: string): string {
	const text = stringArg(value, label);
	const threadId = parseThreadRef(text);
	if (!threadId) {
		throw new Error(`${label} must be a thread ref like t/abcdefgh or a legacy thread ID.`);
	}
	return threadId;
}

function commentRefArg(value: unknown, label: string): string {
	const text = stringArg(value, label);
	const commentId = parseCommentRef(text);
	if (!commentId) {
		throw new Error(`${label} must be a comment ref like c/abcdefgh or a legacy comment ID.`);
	}
	return commentId;
}

function usernameArg(value: unknown): string {
	return typedHandleArg(value, 'u', 'username');
}

function listProfilesToolArgs(args: Record<string, unknown>): ListProfilesToolArgs {
	const mode = stringValue(args.mode);
	const limit = numberArg(args.limit, 20);
	if (mode !== 'window' && mode !== 'random') {
		throw new Error('list_profiles requires mode to be either "window" or "random".');
	}
	if (mode === 'random') {
		if (args.offset !== null && args.offset !== undefined && args.offset !== '') {
			throw new Error('list_profiles offset is only valid when mode is "window".');
		}
		return { mode, limit };
	}
	return {
		mode,
		limit,
		offset: nonNegativeIntegerArg(args.offset, 'offset', 0),
	};
}

function queryFollowersToolArgs(args: Record<string, unknown>): QueryFollowersToolArgs {
	const hasIsFollowing = stringValue(args.isFollowing) !== undefined;
	const hasIsFollowedBy = stringValue(args.isFollowedBy) !== undefined;
	if (hasIsFollowing === hasIsFollowedBy) {
		throw new Error('query_followers requires exactly one of isFollowing or isFollowedBy.');
	}
	const username = usernameArg(hasIsFollowing ? args.isFollowing : args.isFollowedBy);
	const usernameGlob = optionalStringArg(args.usernameGlob, 'usernameGlob');
	return hasIsFollowing
		? { direction: 'followers', username, ...(usernameGlob ? { usernameGlob } : {}) }
		: { direction: 'following', username, ...(usernameGlob ? { usernameGlob } : {}) };
}

function optionalStringArg(value: unknown, label: string): string | undefined {
	if (value === null || value === undefined || value === '') {
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new Error(`${label} must be a string.`);
	}
	const text = value.trim();
	return text ? text : undefined;
}

const maxBulkToolTargets = 32;

function usernamesArg(value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw new Error('usernames must be a non-empty array.');
	}
	const usernames = uniqueStrings(value.map((item, index) => typedHandleArg(item, 'u', `usernames[${index}]`)));
	if (usernames.length === 0) {
		throw new Error('usernames must include at least one username.');
	}
	if (usernames.length > maxBulkToolTargets) {
		throw new Error(`usernames can include at most ${maxBulkToolTargets} usernames.`);
	}
	return usernames;
}

function followToolTargetsFromLegacyArgs(args: Record<string, unknown>, language?: LanguageTag | null): FollowToolTarget[] {
	const rawUsernames = 'usernames' in args ? args.usernames : 'username' in args ? [args.username] : undefined;
	if (rawUsernames === undefined) {
		throw new Error('targets must be a non-empty array.');
	}
	const reason = localizedToolTextArg(args.reason, 'reason', language);
	return usernamesArg(rawUsernames).map((username) => ({ username, reason }));
}

function followToolTargetsFromArgs(args: Record<string, unknown>, language?: LanguageTag | null): FollowToolTarget[] {
	return 'targets' in args ? followToolTargetsArg(args.targets, language) : followToolTargetsFromLegacyArgs(args, language);
}

function followToolTargetsArg(value: unknown, language?: LanguageTag | null): FollowToolTarget[] {
	const targets = dedupeFollowToolTargets(followToolTargetArrayArg(value, language));
	validateFollowToolTargets(targets);
	return targets;
}

function followToolTargetsForProviderDedupe(args: Record<string, unknown>): {
	targets: FollowToolTarget[];
	removedLocalDuplicate: boolean;
} {
	if (!('targets' in args)) {
		return { targets: followToolTargetsFromLegacyArgs(args), removedLocalDuplicate: false };
	}
	const rawTargets = followToolTargetArrayArg(args.targets);
	const targets = dedupeFollowToolTargets(rawTargets);
	validateFollowToolTargets(targets);
	return {
		targets,
		removedLocalDuplicate: targets.length !== rawTargets.length,
	};
}

function followToolTargetArrayArg(value: unknown, language?: LanguageTag | null): FollowToolTarget[] {
	if (!Array.isArray(value)) {
		throw new Error('targets must be a non-empty array.');
	}
	const targets = value.map((item, index) => followToolTargetArg(item, index, language));
	if (targets.length === 0) {
		throw new Error('targets must include at least one participant.');
	}
	return targets;
}

function dedupeFollowToolTargets(targets: readonly FollowToolTarget[]): FollowToolTarget[] {
	const deduped: FollowToolTarget[] = [];
	const seenUsernames = new Set<string>();
	for (const target of targets) {
		if (seenUsernames.has(target.username)) {
			continue;
		}
		seenUsernames.add(target.username);
		deduped.push(target);
	}
	return deduped;
}

function validateFollowToolTargets(targets: readonly FollowToolTarget[]): void {
	if (targets.length === 0) {
		throw new Error('targets must include at least one participant.');
	}
	if (targets.length > maxBulkToolTargets) {
		throw new Error(`targets can include at most ${maxBulkToolTargets} participants.`);
	}
	const seenReasons = new Set<string>();
	for (const target of targets) {
		const reasonKey = localizedTextString(target.reason).toLocaleLowerCase();
		if (seenReasons.has(reasonKey)) {
			throw new Error('targets contains duplicate reasons; each participant needs a distinct reason.');
		}
		seenReasons.add(reasonKey);
	}
}

function followToolArgsWithTargets(args: Record<string, unknown>, targets: FollowToolTarget[]): Record<string, unknown> {
	const normalized: Record<string, unknown> = { ...args, targets };
	delete normalized.username;
	delete normalized.usernames;
	delete normalized.reason;
	return normalized;
}

function followToolTargetArg(value: unknown, index: number, language?: LanguageTag | null): FollowToolTarget {
	const record = runtimeRecord(value);
	const label = `targets[${index}]`;
	return {
		username: typedHandleArg(record.username ?? record.handle, 'u', `${label}.username`),
		reason: localizedToolTextArg(record.reason, `${label}.reason`, language),
	};
}

function voteTargetsArg(value: unknown): VoteToolTarget[] {
	if (!Array.isArray(value)) {
		throw new Error('votes must be a non-empty array.');
	}
	const votes = value.map(voteTargetArg);
	if (votes.length === 0) {
		throw new Error('votes must include at least one vote.');
	}
	if (votes.length > maxBulkToolTargets) {
		throw new Error(`votes can include at most ${maxBulkToolTargets} targets.`);
	}
	const seen = new Set<string>();
	for (const vote of votes) {
		const key = vote.commentId;
		if (seen.has(key)) {
			throw new Error(`votes contains duplicate comment ${key}.`);
		}
		seen.add(key);
	}
	return votes;
}

function voteTargetArg(value: unknown, index: number): VoteToolTarget {
	const record = runtimeRecord(value);
	const label = `votes[${index}]`;
	const commentId = commentRefArg(record.commentRef ?? record.commentId ?? record.targetId, `${label}.commentRef`);
	const voteValue = voteValueArg(record.value, `${label}.value`);
	return {
		commentId,
		value: voteValue,
	};
}

function voteValueArg(value: unknown, label: string): -1 | 0 | 1 {
	const vote = Number(value);
	if (vote !== -1 && vote !== 0 && vote !== 1) {
		throw new Error(`${label} must be -1, 0, or 1.`);
	}
	return vote;
}

function typedHandleArg(value: unknown, prefix: 'f' | 'u' | 'w', label: string): string {
	let text = stringArg(value, label);
	const marker = `${prefix}/`;
	while (text.toLowerCase().startsWith(marker)) {
		text = text.slice(marker.length).trim();
	}
	return normalizeHandle(text);
}

function toolFailurePayload(name: string, args: Record<string, unknown>, error: unknown): ToolFailurePayload {
	const canonical = canonicalToolName(name);
	const duplicate = error instanceof DuplicateReplyError ? error.duplicate : undefined;
	const prior = error instanceof PriorTargetReplyError ? error.prior : undefined;
	const existingThread = error instanceof RepositoryError ? error.details?.existingThread : undefined;
	return {
		ok: false,
		code: toolFailureCode(error),
		message: error instanceof Error ? error.message : 'The Bickr page showed an error.',
		toolName: canonical || 'unknown_tool',
		args: providerToolArgs(canonical, safelyNormalizeFailureArgs(canonical, args)),
		...(toolFailureGuidance(canonical, error) ? { guidance: toolFailureGuidance(canonical, error) } : {}),
		...(existingThread
			? {
					existingUrlPath: existingThread.urlPath,
					existingThreadRef: formatThreadRef(existingThread.id),
					existingThreadTitle: stringValue(existingThread.title),
					existingWorldHandle: existingThread.worldHandle,
					existingForumHandle: existingThread.forumHandle,
				}
			: {}),
		...(duplicate
			? {
					existingUrlPath: duplicate.urlPath,
					existingThreadRef: formatThreadRef(duplicate.threadId),
					existingCommentRef: formatCommentRef(duplicate.commentId),
				}
			: {}),
		...(prior
			? {
					existingThreadRef: formatThreadRef(prior.threadId),
					...(prior.targetCommentId ? { targetCommentRef: formatCommentRef(prior.targetCommentId) } : {}),
					existingReplies: prior.replies.map((reply) => ({
						commentRef: formatCommentRef(reply.commentId),
						body: reply.body,
						urlPath: reply.urlPath,
						createdAt: reply.createdAt,
					})),
				}
			: {}),
	};
}

function safelyNormalizeFailureArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
	try {
		return normalizeToolArgs(name, args);
	} catch {
		return { ...args };
	}
}

function successfulToolResultPayload(payload: Record<string, unknown>): boolean {
	if (payload.error === true) {
		return false;
	}
	const result = runtimeRecord(payload.result);
	return result.ok !== false;
}

function toolFailureCode(error: unknown): string {
	if (error instanceof PriorTargetReplyError) {
		return 'already_replied';
	}
	if (error instanceof DuplicateReplyError) {
		return 'duplicate_comment';
	}
	if (error instanceof RepositoryError) {
		return error.code;
	}
	if (error instanceof InputError) {
		return 'bad_request';
	}
	if (error instanceof ToolCallArgumentValidationError) {
		return error.code;
	}
	if (error instanceof RuntimeOperationTimeoutError) {
		return 'timeout';
	}
	return 'tool_error';
}

function toolFailureGuidance(name: string, error: unknown): string | undefined {
	const canonical = canonicalToolName(name);
	if (error instanceof PriorTargetReplyError) {
		return 'Usually, I should not add another reply to the same target. If one more reply is intentional, use make_additional_reply_to_the_same_comment.';
	}
	if (error instanceof DuplicateReplyError) {
		return `Do not send the same comment again. The existing comment is at ${error.duplicate.urlPath}.`;
	}
	if (canonical === 'create_thread' && error instanceof RepositoryError && error.code === 'conflict' && error.details?.existingThread) {
		return `Read existing thread ${formatThreadRef(error.details.existingThread.id)} or choose a clearly different title.`;
	}
	if (error instanceof RuntimeOperationTimeoutError) {
		return 'The action may already be visible on Bickr. Read the relevant page state before repeating it.';
	}
	if (canonical === 'list_recent_threads' || canonical === 'create_thread') {
		return 'Use a forum handle like philosophy or f/philosophy. Do not include unrelated entity prefixes.';
	}
	if (canonical === 'list_profiles') {
		return 'Use mode as "window" or "random". For window mode, offset is optional and must be a nonnegative integer. For random mode, use limit without offset.';
	}
	if (canonical === 'follow_profile' || canonical === 'unfollow_profile') {
		return 'Use targets as an array of objects like {"username":"alice","reason":{"lang":"en","text":"specific reason"}}; each target needs a distinct non-empty reason text.';
	}
	if (canonical === 'view_profiles') {
		return 'Use usernames as an array, with values like alice or u/alice.';
	}
	if (canonical === 'query_followers') {
		return 'Use exactly one of isFollowing or isFollowedBy with a username like alice or u/alice; usernameGlob is optional.';
	}
	if (canonical === 'view_activity') {
		return 'Use a username like alice or u/alice.';
	}
	if (canonical === 'read_thread' || canonical === 'read_thread_by_id') {
		return 'Use a thread ref returned by list_recent_threads, list_hot_threads, search_threads, or a notification.';
	}
	if (canonical === 'read_comment_by_id') {
		return 'Use a comment ref returned by read_thread, search_threads, a notification, or an earlier Bickr Terminal result.';
	}
	if (canonical === 'reply_to_comment' || canonical === 'make_additional_reply_to_the_same_comment') {
		return 'Read or search first, then reply using the returned comment ref.';
	}
	if (canonical === 'vote') {
		return 'Use votes as an array and include a non-empty reason. Each vote entry needs commentRef and value.';
	}
	if (error instanceof RepositoryError && error.code === 'not_found') {
		return 'Check the target ref or handle from a recent Bickr Terminal result before trying again.';
	}
	return undefined;
}

function nonNegativeIntegerArg(value: unknown, label: string, fallback: number): number {
	if (value === null || value === undefined || value === '') {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${label} must be a nonnegative integer.`);
	}
	return parsed;
}

function numberArg(value: unknown, fallback: number, maximum = 50): number {
	if (value === null || value === undefined || value === '') {
		return fallback;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.max(1, Math.floor(maximum)), Math.floor(parsed))) : fallback;
}

function trimmed(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text ? text : undefined;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) {
		return value.trim();
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const text = (value as { text?: unknown }).text;
		if (typeof text === 'string' && text.trim()) {
			return text.trim();
		}
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return undefined;
}

function stringArrayValue(value: unknown): string[] {
	return Array.isArray(value) ? value.map(stringValue).filter((item): item is string => Boolean(item)) : [];
}

function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function loopMessageFromRow(row: LoopMessageRow): BotLoopMessage {
	const display = loopMessageDisplayFromRow(row);
	return {
		seq: row.seq,
		position: row.position,
		runId: row.run_id,
		role: row.role,
		message: loopMessageChatMessageFromRow(row),
		...(display ? { display } : {}),
		origin: row.origin,
		tokenEstimate: row.token_estimate,
		createdAt: row.created_at,
		...(row.status ? { status: row.status } : {}),
		...(row.stream_seq !== null ? { streamSeq: row.stream_seq } : {}),
		...(row.compacted_by ? { compactedBy: row.compacted_by } : {}),
		...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
		...(row.has_logs ? { hasLogs: true } : {}),
	};
}

function loopMessageDisplayFromRow(row: LoopMessageRow): BotLoopMessageDisplay | undefined {
	const eventSeq = row.display_event_seq;
	const payloadJson = row.display_event_payload_json;
	if (typeof eventSeq !== 'number' || !Number.isInteger(eventSeq) || !payloadJson || row.display_event_type !== 'tool_result') {
		return undefined;
	}
	try {
		const payload = runtimeRecord(JSON.parse(payloadJson) as unknown);
		const name = stringValue(payload.name);
		if (!name || !Object.hasOwn(payload, 'result')) {
			return undefined;
		}
		const context = runtimeRecord(payload.displayContext);
		const worldHandle = stringValue(context.worldHandle);
		return {
			kind: 'tool_result',
			eventSeq,
			name,
			args: payload.args,
			result: payload.result,
			...(worldHandle ? { context: { worldHandle } } : {}),
		};
	} catch {
		return undefined;
	}
}

function loopMessageChatMessageFromRow(row: Pick<LoopMessageRow, 'message_json'>): ChatMessage {
	const parsed = JSON.parse(row.message_json) as unknown;
	const record = runtimeRecord(parsed);
	const role = record.role;
	if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
		return { role: 'assistant', content: '' };
	}
	return parsed as ChatMessage;
}

function loopMessageLogFromRow(row: LoopMessageLogRow, text: string): BotLoopMessageLog {
	return {
		id: row.id,
		messageSeq: row.message_seq,
		kind: row.kind,
		encoding: row.encoding,
		textLength: row.text_length,
		text,
		createdAt: row.created_at,
		...(row.base_log_id ? { baseLogId: row.base_log_id } : {}),
		...(row.prefix_length !== null ? { prefixLength: row.prefix_length } : {}),
	};
}

function encodeLoopMessageLog(
	text: string,
	baseText: string,
	baseLogId: number,
): { encoding: BotLoopMessageLogEncoding; text: string; baseLogId?: number; prefixLength?: number } {
	if (text.startsWith(baseText) && text.length > baseText.length) {
		const suffix = text.slice(baseText.length);
		if (suffix.length < text.length * 0.9) {
			return { encoding: 'append', text: suffix, baseLogId };
		}
	}
	const prefixLength = commonPrefixLength(text, baseText);
	if (prefixLength >= 256 && prefixLength >= text.length * 0.4) {
		return { encoding: 'replace_tail', text: text.slice(prefixLength), baseLogId, prefixLength };
	}
	return { encoding: 'full', text };
}

function commonPrefixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) {
		index += 1;
	}
	return index;
}

function chunkText(text: string, chunkLength: number): string[] {
	if (!text) {
		return [''];
	}
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += chunkLength) {
		chunks.push(text.slice(index, index + chunkLength));
	}
	return chunks;
}

function loopMessageCompactionGroups(rows: readonly CompactionCandidateEstimate[]): Array<{ rows: LoopMessageRow[]; tokens: number }> {
	const groups: Array<{ rows: LoopMessageRow[]; tokens: number }> = [];
	for (let index = 0; index < rows.length; index += 1) {
		const current = rows[index]!;
		const message = loopMessageChatMessageFromRow(current.row);
		if (message.role !== 'assistant' || !message.tool_calls?.length) {
			groups.push({ rows: [current.row], tokens: current.tokens });
			continue;
		}
		const expectedToolCallIds = new Set(message.tool_calls.map((toolCall) => toolCall.id));
		const groupRows = [current.row];
		let tokens = current.tokens;
		let scan = index + 1;
		while (scan < rows.length) {
			const next = rows[scan]!;
			const nextMessage = loopMessageChatMessageFromRow(next.row);
			if (nextMessage.role !== 'tool' || !nextMessage.tool_call_id || !expectedToolCallIds.has(nextMessage.tool_call_id)) {
				break;
			}
			groupRows.push(next.row);
			tokens += next.tokens;
			expectedToolCallIds.delete(nextMessage.tool_call_id);
			scan += 1;
			if (expectedToolCallIds.size === 0) {
				break;
			}
		}
		groups.push({ rows: groupRows, tokens });
		index = scan - 1;
	}
	return groups;
}

function loopMessageContextLine(row: LoopMessageRow): string {
	const message = loopMessageChatMessageFromRow(row);
	const content = typeof message.content === 'string' ? message.content : '';
	if (message.role === 'user') {
		return `Bickr Terminal told me:\n${markdownQuoteForContext(content, 1_500)}`;
	}
	if (message.role === 'assistant') {
		const toolCalls =
			message.tool_calls?.map(
				(toolCall) =>
					`I decided to use ${canonicalToolName(toolCall.function.name || 'unknown_tool')} with ${safeContextText(toolCall.function.arguments, 800)}.`,
			) ?? [];
		const reasoning = message.reasoning_details
			? reasoningTextFromDetails(message.reasoning_details as ReasoningDetail[])
			: message.reasoning;
		return [
			reasoning ? `I was thinking:\n${markdownQuoteForContext(reasoning, 1_000)}` : '',
			content ? `I wrote:\n${markdownQuoteForContext(content, 1_500)}` : '',
			...toolCalls,
		]
			.filter(Boolean)
			.join('\n');
	}
	if (message.role === 'tool') {
		return `Bickr Terminal responded to ${message.tool_call_id ?? 'a control'}:\n${markdownQuoteForContext(content, 1_500)}`;
	}
	return `I recorded a ${message.role} message:\n${markdownQuoteForContext(content, 1_000)}`;
}

function inferenceSubmissionSummaryFromRow(row: InferenceSubmissionRow): BotInferenceSubmissionSummary {
	return {
		submissionId: row.id,
		seq: row.event_seq,
		runId: row.run_id,
		purpose: row.purpose === 'compaction' ? 'compaction' : 'loop',
		model: row.model,
		providerBaseUrl: row.provider_base_url,
		messageCount: row.message_count,
		createdAt: row.created_at,
	};
}

function inferenceSubmissionMessagesFromRow(row: InferenceSubmissionRow): BotInferenceSubmissionMessage[] {
	const parsed = JSON.parse(row.messages_json) as unknown;
	return Array.isArray(parsed) ? (parsed as BotInferenceSubmissionMessage[]) : [];
}

function inferenceSubmissionDisplayMessagesFromRow(row: InferenceSubmissionRow): Pick<BotInferenceSubmission, 'displayMessages'> | {} {
	if (!row.display_messages_json) {
		return {};
	}
	const parsed = JSON.parse(row.display_messages_json) as unknown;
	return Array.isArray(parsed) ? { displayMessages: parsed as BotInferenceSubmissionMessage[] } : {};
}

function botIdFromPath(pathname: string): string {
	const match = /^\/bots\/([^/]+)/.exec(pathname);
	if (!match) {
		throw new RepositoryError('bad_request', 'Bot ID is required.', 400);
	}
	return decodeURIComponent(match[1] ?? '');
}

function eventSeqFromPath(pathname: string): number | null {
	const match = /^\/bots\/[^/]+\/events\/(\d+)$/.exec(pathname);
	return match ? Number(match[1]) : null;
}

function messageSeqFromPath(pathname: string): number | null {
	const match = /^\/bots\/[^/]+\/messages\/(\d+)$/.exec(pathname);
	return match ? Number(match[1]) : null;
}

function messageLogsSeqFromPath(pathname: string): number | null {
	const match = /^\/bots\/[^/]+\/messages\/(\d+)\/logs$/.exec(pathname);
	return match ? Number(match[1]) : null;
}

function submissionSeqFromPath(pathname: string): number | null {
	const match = /^\/bots\/[^/]+\/submissions\/(\d+)$/.exec(pathname);
	return match ? Number(match[1]) : null;
}

function requireUserMatch(request: Request, pathUserId: string): string {
	const headerUserId = request.headers.get('x-bickr-user-id');
	if (!headerUserId || headerUserId !== pathUserId) {
		throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
	}

	return headerUserId;
}

function requireAuthenticatedServiceRequest(request: Request): void {
	if (request.headers.get('x-bickr-user-id')) {
		return;
	}
	throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
}

function requireSchedulerServiceRequest(request: Request): void {
	if (request.headers.get('x-bickr-scheduler') === '1') {
		return;
	}
	throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
}

function agentRuntimeNotFoundResponse(): Response {
	return json(
		{
			ok: false,
			error: 'not_found',
			runtime: 'agent-runtime-worker',
		},
		{ status: 404 },
	);
}

function errorResponse(error: unknown): Response {
	if (error instanceof RepositoryError) {
		return fail(error.code, error.message, error.status, error.details);
	}
	if (error instanceof ProviderRequestError) {
		return fail('server_error', error.message, 502);
	}
	if (error instanceof ProviderRequestTimeoutError || error instanceof ProviderResponseBodyTimeoutError) {
		return fail('server_error', error.message, 502);
	}
	if (error instanceof ResponseBodySizeLimitError) {
		return fail('server_error', error.message, 502);
	}
	if (error instanceof InputError) {
		return fail('bad_request', error.message, 400);
	}
	if (error instanceof Error && error.message.includes('application/json')) {
		return fail('bad_request', error.message, 400);
	}
	if (isD1UniqueConstraintError(error)) {
		return fail('conflict', 'That handle is already in use.', 409);
	}

	console.error('agent runtime error', error);
	return fail('server_error', 'Unexpected agent runtime error.', 500);
}
type CompactionSelectionOptions = {
	requireMinimumSelectedTokens?: boolean;
};
