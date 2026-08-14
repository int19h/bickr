import type {
	BotCompactionMode,
	BotContextBudget,
	BotDocument,
	BotEffectivePostingSettings,
	BotInferenceSubmissionMessage,
	BotInferenceSubmissionPurpose,
	BotInferenceSubmissionToolCall,
	BotInferenceToolCallIntent,
	BotLoopMessageLogEncoding,
	BotLoopMessageLogKind,
	BotLoopMessageOrigin,
	BotLoopMessageStatus,
	BotProfileRelationshipSummary,
	BotPublicProfile,
	BotRuntimeEventType,
	BotSearchResult,
	BotStructuredToolCalls,
	ForumWriteErrorCause,
	JsonObject,
	LocalizedText,
	NotificationEvent,
	RequiredLocalizedText,
	SpotlightSyntheticContext,
} from '@bickr/shared/model';
import type { SeenContentItem } from '@bickr/shared/social';
import type { ToolResultEnvelope, ToolResultProfileAction } from '@bickr/shared/tool-results';
import type { ProviderToolDefinition } from './prompt-and-tools';
import type { ProviderSettings } from './provider-requests';

export interface Env {
	BICKR_D1: D1Database;
	BICKR_KV: KVNamespace;
	BOT_RUNTIME: DurableObjectNamespace;
	USER_BOTS: DurableObjectNamespace;
	FORUM_COORDINATOR_SERVICE: Fetcher;
	AI?: Ai;
	BICKR_R2?: R2Bucket;
	BICKR_R2_PUBLIC_BASE_URL?: string;
	BICKR_SEARCH_VECTORIZE?: Vectorize;
	INTERNAL_SERVICE_SECRET?: string;
	OPENROUTER_API_KEY?: string;
	OPENROUTER_BASE_URL?: string;
	OPENROUTER_MODEL?: string;
	BICKR_SIMULATION_MODE?: string;
}

export type RuntimeBotDocument = BotDocument & {
	effectivePostingSettings?: BotEffectivePostingSettings;
	worldPrompt?: string;
	worldRecurringPrompt?: string;
};

export type RuntimeRow = {
	seq: number;
	run_id: string;
	type: BotRuntimeEventType;
	payload_json: string;
	token_estimate: number;
	created_at: string;
	compacted_by: number | null;
};

export type CompactionMetrics = {
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

export type InferenceSubmissionRow = {
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

export type LoopMessageRow = {
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

export type LoopMessagePageDescriptor = {
	page: number;
	sourceCompactionSeq: number | null;
	newerPage?: number;
};

export type LoopMessagePageIndex = {
	descriptors: LoopMessagePageDescriptor[];
	compactionPageBySeq: Map<number, number>;
};

export type LoopMessageLogRow = {
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

export type RuntimeFailureLogKind = Extract<
	BotLoopMessageLogKind,
	'provider_request' | 'provider_response' | 'compaction_request' | 'compaction_response'
>;

export type RuntimeFailureLog = {
	kind: RuntimeFailureLogKind;
	text: string;
};

export type LoopMessageAppendLog = {
	kind: BotLoopMessageLogKind;
	text: string;
};

export type LoopMessageGroupEntry = {
	runId: string;
	message: ChatMessage;
	origin: BotLoopMessageOrigin;
	status?: BotLoopMessageStatus;
	options?: { streamSeq?: number; displayEventSeq?: number };
	extraLogs?: LoopMessageAppendLog[];
};

export type ProviderCompactionResponsePayload = {
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

export type LoopMessageLogChunkRow = {
	log_id: number;
	chunk_index: number;
	text: string;
};

export type ChatMessage = BotInferenceSubmissionMessage;

export type ReasoningDetail = Record<string, unknown>;

export type ToolCall = BotInferenceSubmissionToolCall;

export type ToolResult = {
	name: string;
	result: unknown;
	providerResult: unknown;
	envelope: ToolResultEnvelope;
	displayEventSeq?: number;
	effectiveArgs?: Record<string, unknown>;
	selfCorrectionMessages?: string[];
	spotlightMutation?: boolean;
	spotlightTickTerminator?: boolean;
};

export type VoteToolTarget = {
	commentId: string;
	value: -1 | 0 | 1;
};

export type FollowToolTarget = {
	username: string;
	reason: RequiredLocalizedText;
};

export type FollowToolHistoryTarget = {
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

export type FollowProfilesToolResult = {
	results: ToolResultProfileAction[];
	effectiveTargets: FollowToolTarget[];
	selfCorrectionMessages: string[];
	spotlightMutation: SpotlightMutationScope;
};

export type ProviderUsage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	cost: number | null;
	raw: Record<string, unknown>;
};

export type ProviderResponse = {
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

export type ProviderStreamFetchResponse =
	| Readonly<{
			stream: ReadableStream<Uint8Array>;
			responseId?: string;
	  }>
	| ReadableStream<Uint8Array>;

export type ProviderPromptBudgetCheck = {
	allowedPromptTokens: number;
	contextWindowTokens?: number;
	maxCompletionTokens: number;
	promptTokens: number;
	providerTools: ProviderToolDefinition[];
	requestMessages: ChatMessage[];
};

export type ProviderPromptTokenEstimate = {
	promptTokens: number;
	source: 'baseline_plus_delta' | 'full_estimate';
	baselinePromptTokens?: number;
	baselineMessageCount?: number;
	estimatedDeltaTokens?: number;
	calibrationSampleCount: number;
};

export type ProviderUsageRow = {
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

export type ProviderUsageExportRow = ProviderUsageRow & {
	id: number;
	request_seq: number;
	provider_base_url: string;
};

export type ProviderTokenCalibrationSampleRow = {
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

export type ProviderUsageLogRow = ProviderUsageRow & {
	usage_json: string;
};

export type ProviderLoopUsageRow = ProviderUsageRow & {
	request_seq: number;
	provider_base_url: string;
};

export type PromptTokenCalibrationRow = {
	event_seq: number;
	run_id: string;
	purpose: BotInferenceSubmissionPurpose;
	messages_json: string;
	prompt_tokens: number;
};

export type ProviderTokenCalibrationLegacyBackfillRow = PromptTokenCalibrationRow & {
	requested_model: string;
	response_model: string | null;
	provider_base_url: string;
	created_at: string;
};

export type PromptTokenBaselineRow = PromptTokenCalibrationRow & {
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
	/**
	 * Typed cause when the forum coordinator refused an authored content write.
	 * Carried through so participant-facing wording is composed from the cause
	 * rather than sniffed out of the failure message.
	 */
	forumWriteCause?: ForumWriteErrorCause;
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

export type DuplicateReply = {
	threadId: string;
	commentId: string;
	urlPath: string;
	seq: number;
};

export type PriorReply = {
	commentId: string;
	body: string;
	urlPath: string;
	createdAt: string;
};

export type PriorTargetReplies = {
	threadId: string;
	targetCommentId?: string;
	targetDescription: string;
	replies: PriorReply[];
};

export type TickRunResult = {
	runId: string;
	status: 'already_running' | 'completed' | 'failed' | 'paused' | 'queued' | 'started' | 'stopped';
	error?: string;
};

export type TickMode = 'normal' | 'spotlight';

export type LoopSetupMode = 'new_iteration' | 'continuation' | 'spotlight';

export type RuntimeReleaseStatus = 'idle' | 'failed';

export type ActiveMaintenanceOperation = 'clear_history' | 'manual_compaction';

export type TickOptions = {
	mode?: TickMode;
	injectionIds?: string[];
	spotlightId?: string;
	background?: boolean;
};

export type AdmittedTick = {
	bot: RuntimeBotDocument;
	providerSettings: ProviderSettings;
	runId: string;
	abortController: AbortController;
	mode: TickMode;
	setupMode: LoopSetupMode;
};

export type TickAdmission =
	| {
			admitted: true;
			tick: AdmittedTick;
		}
	| {
			admitted: false;
			result: TickRunResult;
		};

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

export type RuntimeLoopMessages = ChatMessage[] & {
	deliveredNotificationIds: Set<string>;
};

export type InjectionMetadata = {
	kind?: string;
	sourceId?: string;
	spotlightId?: string;
};

export type InjectionRow = {
	id: string;
	text: string;
	kind: string;
	sourceId: string | null;
	spotlightId: string | null;
};

export type QueuedSpotlightTick = {
	injectionId: string;
	spotlightId: string;
	createdAt: string;
};

export type PendingSpotlightTick = {
	spotlightId: string;
	injectionIds: string[];
	entries: QueuedSpotlightTick[];
};

export type RunContext = {
	mode: TickMode;
	setupMode: LoopSetupMode;
	spotlightId?: string;
	spotlightActionScope?: SpotlightActionScope;
	signal: AbortSignal;
};

export type ProviderMessageStatus = 'complete' | 'interrupted';

export type ProviderStreamActivity = {
	type: string;
	created_at: string;
};

export type ReadContentItem = {
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

export type ReadPruneResult = {
	content: ReadContentItem[];
	tokenEstimate: number;
	omittedReplyCount: number;
	trimmedBodyCount: number;
};

export type ProviderNotificationPruneResult = {
	events: Array<{ notificationIds: string[]; payload: Record<string, unknown> }>;
	omittedEventCount: number;
	tokenEstimate: number;
};

export type ProviderNotificationPayloadResult = {
	payload: Record<string, unknown>;
	includedEventIds: string[];
};

export type ProviderNotificationEventGroup = {
	event: Record<string, unknown>;
	notificationIds: string[];
};

export type ProviderToolResultPayloadOptions = {
	tokenBudget?: number;
};

export type ProviderToolArrayPruneResult<T> = {
	items: T[];
	omittedCount: number;
	tokenEstimate: number;
};

export type ContextBudgetPromptParts = {
	baseUrl: string;
	fixedSystemMessage: string;
	fullSystemMessage: string;
	model: string;
	personaSystemMessage: string;
	reasoningPrefill?: string;
	providerTools: ProviderToolDefinition[];
	supportsPrefill: boolean;
};

export type ProfileRelationshipFields = Pick<BotProfileRelationshipSummary, 'isFollowedByMe' | 'isFollowingMe' | 'followers'>;

export type ProfileRelationshipSearchResult = BotSearchResult & ProfileRelationshipFields;

export type ListProfilesToolArgs =
	| { mode: 'window'; limit: number; offset: number }
	| { mode: 'random'; limit: number };

export type QueryFollowersToolArgs =
	| { direction: 'followers'; username: string; usernameGlob?: string }
	| { direction: 'following'; username: string; usernameGlob?: string };

export type ProviderPromptCacheControl =
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

/**
 * `toolCallRequest` is the requested typed intent and `toolCalls` is the
 * structured-role value a translation-aware resolver already applied. The
 * request is required here so the translation request builder never has to
 * reconstruct intent from an applied value: both production resolvers carry the
 * typed request, and a caller that cannot state one has no requested intent to
 * honour.
 */
export type TranslationProviderSettings = Omit<Pick<ProviderSettings,
	'apiKey' | 'baseUrl' | 'model' | 'providerRouting' | 'reasoningEffort' | 'reasoningRequest' |
	'toolCalls' | 'toolCallRequest' | 'temperature' | 'topK' | 'topP' | 'minP' |
	'frequencyPenalty' | 'presencePenalty' | 'repetitionPenalty'
>, 'toolCalls' | 'toolCallRequest'> & {
	toolCalls?: BotStructuredToolCalls;
	toolCallRequest: BotInferenceToolCallIntent;
	prompt: string;
};

export type ProviderLoopOutcome = {
	toolCallCount: number;
	logOffCalled: boolean;
	spotlightMutationCount: number;
};

export type SpotlightActionScope = {
	commentIds: ReadonlySet<string>;
	authorBotIds: ReadonlySet<string>;
	authorHandles: ReadonlySet<string>;
};

export type SpotlightMutationScope = {
	related: boolean;
	unrelated: boolean;
};

export type ProviderToolCallDropReason =
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
	repaired: RepairedProviderToolCall[];
	repairedTextCount: number;
};

export type RepairedProviderToolCall = {
	id: string;
	name: string;
	reason: 'leaked_argument_fragment';
	field: 'body.text' | 'title' | 'title.text';
	leakedArgumentKey: string;
	removedSuffix: string;
};

export type LegacyProviderToolCallHistoryNormalizationOperation =
	| { kind: 'delete'; seq: number }
	| { kind: 'update'; seq: number; message: ChatMessage }
	| { kind: 'insert'; id: string; sourceRow: LoopMessageRow; message: ChatMessage };

export type LegacyProviderToolCallHistoryNormalizationOrderItem = { kind: 'existing'; seq: number } | { kind: 'insert'; id: string };

export type LegacyProviderToolCallHistoryNormalization = {
	operations: LegacyProviderToolCallHistoryNormalizationOperation[];
	order: LegacyProviderToolCallHistoryNormalizationOrderItem[];
	dropped: DroppedProviderToolCall[];
	repairedTextCount: number;
	repairedMessageSeqs: number[];
};

export type ToolUseRecoveryState = {
	consecutiveNoToolTicks: number;
	lastRunId: string;
	updatedAt: string;
};

export type ProviderCompactionReasoningFallbackState = {
	model: string;
	mode: 'minimal';
	reason: string;
	updatedAt: string;
};

export type ProviderStructuredOutputKind = 'avatar_description' | 'compaction' | 'translation';
export type ProviderStructuredOutputValidationIssue = 'non_reducing_compaction' | 'transcript_like_compaction';

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

export type ProviderCompactionValidationLimits = Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'> &
	Partial<Pick<ProviderCompactionSummaryLimits, 'compactedCharacterCount' | 'tokensPerCharacter'>>;
