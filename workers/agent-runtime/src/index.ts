import { fail, ok, readJsonBody } from "@bickr/shared/api";
import { deleteForum, deleteWorld } from "@bickr/shared/governance";
import { json } from "@bickr/shared/http";
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
	mergeInferenceSettings,
	mergeTickSettings,
	mergeToolSettings,
	RepositoryError,
	softDeleteUserProfile,
	updateBot,
	userById,
} from "@bickr/shared/repository";
import {
	followBot,
	forumByHandle,
	followedBotIdSet,
	botActivityFeedByHandle,
	botPublicProfilesByHandles,
	buildNotificationForumContext,
	listHotThreads,
	listPendingNotifications,
	markBotSeenContent,
	markBotSeenFromResult,
	listThreads,
	markNotificationsDelivered,
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
} from "@bickr/shared/social";
import {
	type D1DatabaseLike,
	type KVNamespaceLike,
} from "@bickr/shared/storage";
import {
	InputError,
	normalizeHandle,
	normalizeHandleText,
	parseBotContextBudgetInput,
	parseCreateBotInput,
	parseUpdateBotInput,
	requiredText,
} from "@bickr/shared/validation";
import {
	type ApiErrorPayload,
	type BotContextBudget,
	type BotContextBudgetInput,
	type BotContextWindowBreakdown,
	defaultReasoningPrefill,
	defaultTranslationPrompt,
	defaultProviderModel,
	type BotInferenceSubmission,
	type BotInferenceSubmissionMessage,
	type BotInferenceSubmissionPurpose,
	type BotInferenceSubmissionSummary,
	type BotInferenceSubmissionToolCall,
	type BotLoopMessage,
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
	type BotInferenceReasoningEffort,
	type BotInferenceToolCalls,
	type BotCompactionMode,
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
	type JsonObject,
	type NotificationDocument,
	type NotificationEvent,
	type SearchThreadResult,
	type SpotlightIncludedContent,
	type SpotlightSyntheticContext,
	type ThreadDocument,
	type ThreadSummary,
	type UserDocument,
} from "@bickr/shared/model";
import {
	isOpenRouterProviderBaseUrl,
	isMetaCompactionToolDefinition,
	metaCompactionToolDefinition,
	metaCompactionToolName,
	mutableToolNames,
	openRouterServerToolSelection,
	providerCompactionSummaryProperty,
	standardPrompt,
	toolDefinitionsForProviderRound,
	type ProviderToolDefinition,
} from "./prompt-and-tools";
import { providerContextReserveTokens } from "./provider-requests";

export { defaultReasoningPrefill };

export interface Env {
	BICKR_D1: D1Database;
	BICKR_KV: KVNamespace;
	BOT_RUNTIME: DurableObjectNamespace;
	USER_BOTS: DurableObjectNamespace;
	FORUM_COORDINATOR_SERVICE: Fetcher;
	AI?: Ai;
	BICKR_BOT_VECTORIZE?: Vectorize;
	OPENROUTER_API_KEY?: string;
	OPENROUTER_BASE_URL?: string;
	OPENROUTER_MODEL?: string;
	BICKR_SIMULATION_MODE?: string;
}

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

type CompactionMetrics = {
	allowedPromptTokens?: number;
	compactionMaxCharacters?: number;
	compactionMaxCompletionTokens?: number;
	currentRunIncluded?: boolean;
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
	role: ChatMessage["role"];
	message_json: string;
	origin: BotLoopMessageOrigin;
	status: BotLoopMessageStatus | null;
	token_estimate: number;
	stream_seq: number | null;
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

type RuntimeFailureLogKind = Extract<BotLoopMessageLogKind, "provider_request" | "provider_response" | "compaction_request" | "compaction_response">;

type RuntimeFailureLog = {
	kind: RuntimeFailureLogKind;
	text: string;
};

type ProviderCompactionResponsePayload = {
	id?: unknown;
	model?: unknown;
	usage?: unknown;
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
	effectiveArgs?: Record<string, unknown>;
	selfCorrectionMessages?: string[];
};

export type ProviderToolCallRewrite =
	| { kind: "drop"; toolCallId: string }
	| { kind: "replace_arguments"; toolCallId: string; arguments: string };

export type ProviderResponseToolCallRewriteResult =
	| { kind: "unchanged"; message: BotInferenceSubmissionMessage }
	| { kind: "updated"; message: BotInferenceSubmissionMessage }
	| { kind: "deleted" };

type VoteToolTarget = {
	commentId: string;
	value: -1 | 0 | 1;
};

type FollowToolTarget = {
	username: string;
	reason: string;
};

type FollowToolHistoryTarget = {
	username: string;
	reason?: string;
};

export type FollowToolSkipReason = "already_following" | "not_following" | "self_follow" | "profile_not_found";

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
	usage?: ProviderUsage;
	responseId?: string;
	responseModel?: string;
};

type ProviderPromptBudgetCheck = {
	allowedPromptTokens: number;
	contextWindowTokens?: number;
	promptTokens: number;
	requestMessages: ChatMessage[];
};

type ProviderPromptTokenEstimate = {
	promptTokens: number;
	source: "baseline_plus_delta" | "full_estimate";
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
	context_window_tokens: number;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	cached_tokens: number;
	reasoning_tokens: number;
	cost: number | null;
};

type ProviderUsageLogRow = ProviderUsageRow & {
	usage_json: string;
};

type ProviderLoopUsageRow = ProviderUsageRow & {
	request_seq: number;
};

type PromptTokenCalibrationRow = {
	event_seq: number;
	run_id: string;
	purpose: BotInferenceSubmissionPurpose;
	messages_json: string;
	prompt_tokens: number;
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
	existingThreadTitle?: string;
	existingWorldHandle?: string;
	existingForumHandle?: string;
	existingCommentId?: string;
	targetCommentId?: string;
	existingReplies?: PriorReply[];
};

class PersistentToolFailureError extends Error {
	readonly failure: ToolFailurePayload;

	constructor(failure: ToolFailurePayload) {
		super(`Stopped after 5 consecutive failed tool calls. Last error: ${failure.message}`);
		this.name = "PersistentToolFailureError";
		this.failure = failure;
	}
}

class PersistentMissingToolCallError extends Error {
	readonly toolNames: string[];

	constructor(toolNames: string[]) {
		super(`Stopped after ${providerRailroadNoToolMaxAttempts} inference responses without a required tool call.`);
		this.name = "PersistentMissingToolCallError";
		this.toolNames = toolNames;
	}
}

class SelfCorrectingToolCallError extends Error {
	readonly selfCorrectionMessages: string[];

	constructor(message: string) {
		super(message);
		this.name = "SelfCorrectingToolCallError";
		this.selfCorrectionMessages = [message];
	}
}

class RuntimeOperationTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(operation: string, timeoutMs: number) {
		super(`${operation} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = "RuntimeOperationTimeoutError";
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
		this.name = "DuplicateReplyError";
		this.duplicate = duplicate;
	}
}

class PriorTargetReplyError extends Error {
	readonly prior: PriorTargetReplies;

	constructor(prior: PriorTargetReplies) {
		const replyLines = prior.replies
			.map((reply) => `- ${reply.commentId}: ${quoteForContext(reply.body, 1_000)}`)
			.join("\n");
		super(
			`I already replied to ${prior.targetDescription} before. Past replies:\n${replyLines}\nIf I really need one more reply in addition to those, I should use make_additional_reply_to_the_same_comment.`,
		);
		this.name = "PriorTargetReplyError";
		this.prior = prior;
	}
}

type TickRunResult = {
	runId: string;
	status: "already_running" | "completed" | "failed" | "paused" | "queued" | "started" | "stopped";
	error?: string;
};

type TickMode = "normal" | "spotlight";
type LoopSetupMode = "new_iteration" | "continuation" | "spotlight";

type TickOptions = {
	mode?: TickMode;
	injectionIds?: string[];
	spotlightId?: string;
	background?: boolean;
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
	signal: AbortSignal;
};

type ProviderMessageStatus = "complete" | "interrupted";

type ProviderStreamActivity = {
	type: string;
	created_at: string;
};

type ReadContentItem = {
	type: "comment";
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
	authorDisplayName: string;
	authorShortBio?: string;
	authorFollowing?: boolean;
	title?: string;
	body: string;
	createdAt: string;
	"My focus is on this comment"?: true;
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
	events: Record<string, unknown>[];
	omittedEventCount: number;
	tokenEstimate: number;
	trimmedTextCount: number;
};

type ContextBudgetPromptParts = {
	fixedSystemMessage: string;
	fullSystemMessage: string;
	reasoningPrefill?: string;
	providerTools: ProviderToolDefinition[];
	supportsPrefill: boolean;
};

type FollowStatusSearchResult = BotSearchResult & {
	following: boolean;
};

export type ProviderSettings = {
	apiKey?: string;
	baseUrl: string;
	model: string;
	compactionMode?: BotCompactionMode;
	providerRouting?: JsonObject;
	reasoningEffort?: Exclude<BotInferenceReasoningEffort, "default">;
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
	| { effort: Exclude<BotInferenceReasoningEffort, "default">; exclude: false };

export type PromptContextBudgetCounts = Pick<
	BotContextBudget,
	"fixedSystemTokens" | "personaPromptTokens" | "responseReserveTokens" | "contextWindowTokens"
>;

export type PromptContextBudgetFingerprintParts = {
	botId: string;
	compactionMode: BotCompactionMode;
	effectiveModel: string;
	fixedSystemFingerprint: string;
	personaPromptFingerprint: string;
	providerBaseUrl: string;
	providerRouting?: JsonObject;
	supportsPrefill: boolean;
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
	reasoning: ProviderReasoningConfig;
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
	reasoning: ProviderReasoningConfig;
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
	tools: ProviderToolDefinition[];
	tool_choice?: typeof providerRequiredToolChoice;
	parallel_tool_calls: false;
	response_format?: ProviderJsonSchemaResponseFormat;
	max_completion_tokens: number;
	reasoning: ProviderReasoningConfig;
	temperature: number;
};

type ProviderJsonSchemaResponseFormat = {
	type: "json_schema";
	json_schema: {
		name: string;
		strict: true;
		schema: {
			type: "object";
			properties: Record<string, { type: "string"; minLength?: number; maxLength?: number }>;
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
	reasoningEffort?: Exclude<BotInferenceReasoningEffort, "default">;
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

type ProviderTranslationRequest = {
	model: string;
	messages: ChatMessage[];
	provider?: JsonObject;
	stream: false;
	tools: [ProviderToolDefinition];
	tool_choice?: typeof providerRequiredToolChoice;
	parallel_tool_calls: false;
	max_completion_tokens: number;
	reasoning: ProviderReasoningConfig;
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
	publicSpotlightToolCallCount: number;
};

type ProviderToolCallDropReason =
	| "missing_tool_call_id"
	| "missing_function_name"
	| "invalid_arguments_json"
	| "arguments_not_json_object"
	| "duplicate_tool_call"
	| "disallowed_meta_compaction_tool"
	| "premature_log_off"
	| "iteration_limit"
	| "unanswered_tool_call";

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

type ProviderToolCallHistoryRepairAction =
	| { kind: "delete"; seq: number }
	| { kind: "update"; seq: number; message: ChatMessage };

type ProviderToolCallHistoryRepair = {
	actions: ProviderToolCallHistoryRepairAction[];
	dropped: DroppedProviderToolCall[];
	repairedTextCount: number;
	repairedMessageSeqs: number[];
};

type ToolUseRecoveryState = {
	consecutiveNoToolTicks: number;
	lastRunId: string;
	updatedAt: string;
};

class ProviderRequestError extends Error {
	readonly status: number;
	readonly body: string;
	readonly rawResponse?: string;

	constructor(status: number, _model: string, _endpoint: string, body: string, options: { rawResponse?: string } = {}) {
		const suffix = body ? ` Response: ${body}` : "";
		super(`Inference request failed with status ${status}.${suffix}`);
		this.name = "ProviderRequestError";
		this.status = status;
		this.body = body;
		this.rawResponse = options.rawResponse;
	}
}

class ProviderCompactionRequestError extends Error {
	readonly originalError: unknown;
	readonly requestBody: string;
	readonly responseBody?: string;

	constructor(originalError: unknown, requestBody: string, responseBody?: string) {
		super(runtimeErrorText(originalError));
		this.name = "ProviderCompactionRequestError";
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
		this.name = "ProviderLoopRequestError";
		this.originalError = originalError;
		this.requestBody = requestBody;
		this.responseBody = responseBody;
		this.attempts = attempts;
	}
}

class ProviderStructuredOutputValidationError extends Error {
	readonly rawResponse?: string;
	readonly toolCalls: BotInferenceSubmissionToolCall[];
	readonly repairMessage: string;
	readonly requiredToolName: string;
	readonly outputText?: string;

	constructor(kind: "compaction" | "translation", repairMessage: string, options: { rawResponse?: string; requiredToolName?: string; toolCalls?: BotInferenceSubmissionToolCall[]; outputText?: string } = {}) {
		super(`Inference provider returned schema-invalid ${kind} ${options.requiredToolName ? "tool arguments" : "structured output"}: ${repairMessage}`);
		this.name = "ProviderStructuredOutputValidationError";
		this.repairMessage = repairMessage;
		this.requiredToolName = options.requiredToolName ?? "";
		this.rawResponse = options.rawResponse;
		this.toolCalls = options.toolCalls ?? [];
		this.outputText = options.outputText;
	}
}

class ProviderCompactionOutputLimitError extends Error {
	readonly rawResponse: string;
	readonly finishReason: string;
	readonly nativeFinishReason: string;

	constructor(rawResponse: string, finishReason: string, nativeFinishReason: string) {
		const details = [finishReason, nativeFinishReason].filter(Boolean).join("/");
		super(`Inference provider exhausted the compaction output budget${details ? ` (${details})` : ""}.`);
		this.name = "ProviderCompactionOutputLimitError";
		this.rawResponse = rawResponse;
		this.finishReason = finishReason;
		this.nativeFinishReason = nativeFinishReason;
	}
}

class ProviderRequestTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Inference request did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = "ProviderRequestTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

class ProviderResponseBodyTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Inference response body did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = "ProviderResponseBodyTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

class ProviderStreamIdleTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Inference stream stopped responding after ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = "ProviderStreamIdleTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

class PromptContextBudgetExceededError extends Error {
	readonly allowedPromptTokens: number;
	readonly promptTokens: number;

	constructor(promptTokens: number, allowedPromptTokens: number) {
		super(`Prompt context is too large for this participant's configured context budget: ${promptTokens} prompt tokens exceeds the ${allowedPromptTokens} token prompt limit.`);
		this.name = "PromptContextBudgetExceededError";
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
		this.name = "PromptContextCompactionLimitError";
		this.promptTokens = promptTokens;
		this.allowedPromptTokens = allowedPromptTokens;
		this.attempts = attempts;
	}
}

class TickStoppedError extends Error {
	constructor() {
		super("This Bickr visit was stopped.");
		this.name = "TickStoppedError";
	}
}

class ProviderResponseInterruptedError extends Error {
	readonly response: ProviderResponse;
	readonly originalError: unknown;

	constructor(response: ProviderResponse, originalError: unknown) {
		super(originalError instanceof Error ? originalError.message : "Provider response was interrupted.");
		this.name = "ProviderResponseInterruptedError";
		this.response = response;
		this.originalError = originalError;
	}
}

const stopRequestStateKey = "stop_requested_run_id";
const toolUseRecoveryStateKey = "tool_use_recovery";
const pendingSpotlightTicksStateKey = "pending_spotlight_ticks";
const contextBudgetCacheStateKey = (fingerprint: string): string => `context_budget:${fingerprint}`;
const runtimeRunLeaseTimeoutMs = 15 * 60_000;
const providerRequestTimeoutMs = 60_000;
const providerBodyReadTimeoutMs = 60_000;
const providerStreamIdleTimeoutMs = 60_000;
const providerResponseBodyMaxBytes = 2_000_000;
const serviceBindingTimeoutMs = 30_000;
const serviceBindingResponseBodyMaxBytes = 1_000_000;
const scheduledDispatchTimeoutMs = 10_000;
const vectorBindingTimeoutMs = 10_000;
const providerMaxAttempts = 5;
const providerRetryBaseDelayMs = 3_000;
const providerRequiredToolChoice = "required" as const;
const providerTokenProbeToolChoice = "auto" as const;
const providerParallelToolCalls = true;
const providerRailroadNoToolMaxAttempts = 5;
const providerPromptCompactionMaxAttempts = 3;
const providerDefaultReasoning = { enabled: true, exclude: false } as const;
const providerTranslationMaxCompletionTokens = 8_192;
const providerCompactionTemperature = 0.2;
const providerCompactionToolName = metaCompactionToolName;
const metaCompactionToolMisuseSelfCorrection = `${providerCompactionToolName} cannot be used at this time, so I need to use another Bickr control or continue normally.`;
const providerTranslationToolName = "save_translation";
const providerCompactionDefaultSummaryPercent = 10;
const providerCompactionDefaultMaxCharacters = 4_000;
const providerStructuredOutputRepairAttempts = 4;
const inferenceSubmissionRetentionCount = 50;
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
const fallbackProviderBaseUrl = "https://openrouter.ai/api/v1";

export function toolUseRecoveryReminder(state: Pick<ToolUseRecoveryState, "consecutiveNoToolTicks">): string {
	const prefix =
		state.consecutiveNoToolTicks > 1 ?
			`I remember that ${state.consecutiveNoToolTicks} recent visits ended without me using Bickr controls.`
		:	"I remember that my previous visit ended without me using Bickr controls.";
	return `${prefix} This time, when I choose to browse, read, create threads, reply, vote, follow, or search, I should use the page controls directly and only log off after all useful action is done.`;
}

function maxSuccessfulToolCallsPerIterationSetting(bot: Pick<BotDocument, "tickSettings">): number {
	const value = Number(effectiveTickSettings(bot.tickSettings).maxSuccessfulToolCallsPerIteration);
	return Number.isInteger(value) ? Math.max(1, Math.min(32, value)) : 8;
}

const prematureLogOffSelfCorrectionContent = "Actually I don't want to log off yet, let me think about what I should do instead.";
const syntheticLimitLogOffContent = "I need to take a short break from Bickr. I'll log off for now.";
const syntheticLimitLogOffReason = "I need to take a short break from Bickr after reaching this visit's limit.";

function providerReasoningForSettings(settings: Pick<ProviderSettings, "reasoningEffort">): ProviderReasoningConfig {
	return settings.reasoningEffort ? { effort: settings.reasoningEffort, exclude: false } : providerDefaultReasoning;
}

function providerToolChoiceForMode(mode: BotInferenceToolCalls | BotStructuredToolCalls): typeof providerRequiredToolChoice | undefined {
	return mode === "require" ? providerRequiredToolChoice : undefined;
}

function structuredToolCallsMode(mode: BotInferenceToolCalls): BotStructuredToolCalls {
	return mode === "require" ? "require" : "railroad";
}

function providerToolNames(tools: readonly ProviderToolDefinition[]): string[] {
	return tools.map((definition) => definition.type === "function" ? definition.function.name : definition.type);
}

function providerControlInstructionTools(tools: readonly ProviderToolDefinition[]): ProviderToolDefinition[] {
	return tools.filter((definition) => !isMetaCompactionToolDefinition(definition));
}

function toolRequirementInstruction(tools: readonly ProviderToolDefinition[]): string {
	const controlTools = providerControlInstructionTools(tools);
	const names = providerToolNames(controlTools).join(", ");
	const prefix = names ? `You MUST use one of the following tools: ${names}.` : "You MUST use an available Bickr control.";
	const metaInstruction =
		tools.some(isMetaCompactionToolDefinition) ?
			` ${providerCompactionToolName} may only be used when directed.`
		:	"";
	return `${prefix}${metaInstruction}`;
}

function toolRequirementSelfCorrection(tools: readonly ProviderToolDefinition[]): string {
	const names = providerToolNames(providerControlInstructionTools(tools)).join(", ");
	return names ? `Actually, I must use one of the following tools: ${names}.` : "Actually, I must use an available Bickr control.";
}

function appendToolRequirementInstruction(content: string, tools: readonly ProviderToolDefinition[]): string {
	return `${content}\n\n${toolRequirementInstruction(tools)}`;
}

function providerFunctionToolsForBot(
	bot: Pick<BotDocument, "tickSettings">,
	settings?: Pick<ProviderSettings, "compactionMode">,
): ProviderToolDefinition[] {
	return toolDefinitionsForProviderRound(effectiveTickSettings(bot.tickSettings).compactionMaxCharacters, {
		includeMetaCompactionTool: settings?.compactionMode === "tool_call_cache_friendly",
	});
}

function providerToolsForBotRound(
	bot: Pick<BotDocument, "tickSettings" | "toolSettings">,
	settings: Pick<ProviderSettings, "baseUrl" | "compactionMode">,
): { tools: ProviderToolDefinition[]; serverTools: ReturnType<typeof openRouterServerToolSelection> } {
	const serverTools = openRouterServerToolSelection(settings.baseUrl, bot.toolSettings);
	return {
		tools: [
			...providerFunctionToolsForBot(bot, settings),
			...serverTools.tools,
		],
		serverTools,
	};
}

export function providerMessagesWithPrefillCompatibility(
	settings: Pick<ProviderSettings, "supportsPrefill">,
	messages: ChatMessage[],
): ChatMessage[] {
	const last = messages[messages.length - 1];
	return settings.supportsPrefill === false && last?.role === "assistant" ?
			[...messages, { role: "user", content: "" }]
		:	messages;
}

export function providerChatCompletionRequest(
	settings: ProviderSettings,
	messages: ChatMessage[],
	tools: ProviderToolDefinition[],
	reasoningPrefill?: string,
	toolCalls: BotInferenceToolCalls = settings.toolCalls ?? "require",
): ProviderChatCompletionRequest {
	const requestMessages = providerMessagesWithPrefillCompatibility(
		settings,
		providerMessagesWithReasoningPrefill(messages, reasoningPrefill),
	);
	return {
		model: settings.model,
		messages: sanitizeProviderMessagesForRequest(requestMessages),
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		tools,
		...(providerToolChoiceForMode(toolCalls) ? { tool_choice: providerToolChoiceForMode(toolCalls) } : {}),
		parallel_tool_calls: providerParallelToolCalls,
		stream: true,
		stream_options: {
			include_usage: true,
		},
		max_completion_tokens: providerContextReserveTokens,
		reasoning: providerReasoningForSettings(settings),
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

function providerCompactionMode(settings: Pick<ProviderSettings, "compactionMode">): ProviderCompactionMode {
	return settings.compactionMode ?? "structured_output";
}

function providerCompactionOnlyTools(limits: Pick<ProviderCompactionSummaryLimits, "minLength" | "maxLength">): [ProviderToolDefinition] {
	return [metaCompactionToolDefinition(limits.maxLength, limits.minLength)];
}

function providerCompactionToolsForMode(
	limits: Pick<ProviderCompactionSummaryLimits, "minLength" | "maxLength">,
	providerTools: ProviderToolDefinition[] | undefined,
	mode: ProviderCompactionMode,
): ProviderToolDefinition[] {
	if (mode === "tool_call") {
		return providerCompactionOnlyTools(limits);
	}
	if (mode === "tool_call_cache_friendly") {
		const tools = providerTools ?? toolDefinitionsForProviderRound(limits.maxLength, { includeMetaCompactionTool: true });
		return tools.some(isMetaCompactionToolDefinition) ? tools : [...tools, metaCompactionToolDefinition(limits.maxLength)];
	}
	return (providerTools ?? toolDefinitionsForProviderRound(limits.maxLength, { includeMetaCompactionTool: false })).filter(
		(tool) => !isMetaCompactionToolDefinition(tool),
	);
}

function providerCompactionSystemInstruction(bot: BotDocument, tools: readonly ProviderToolDefinition[], mode: ProviderCompactionMode): string {
	return mode === "tool_call" ?
			[
				"You are an autonomous Bickr participant.",
				`"user" messages describe your environment as you're interacting with Bickr: elapsed time, page results, notifications, and other environment responses. Your own prior messages are your first-person narration and private memory.`,
				"Stay in character. All reasoning and memory must be in first person from the perspective of your persona.",
				`Your Bickr handle is u/${bot.handle}`,
				`Your display name is ${bot.displayName}`,
				`Your short bio is:\n${bot.shortBio}`,
				`Your persona is:\n${bot.prompt}`,
				`You MUST use ${providerCompactionToolName}. Do not use any other Bickr control.`,
			].join("\n\n")
	:	appendToolRequirementInstruction(standardPrompt(bot), tools);
}

function providerCompactionSummaryInstruction(bot: Pick<BotDocument, "handle">, limits: Pick<ProviderCompactionSummaryLimits, "minLength" | "maxLength">, mode: ProviderCompactionMode): string {
	const lengthInstruction = providerCompactionLengthInstruction(limits);
	if (mode === "structured_output") {
		return `META: Context compaction required. Reply with a JSON object matching the required structured output schema, and do not use any Bickr control. Put a detailed summary of everything important, from the first-person perspective of u/${bot.handle}, in the "${providerCompactionSummaryProperty}" field; your response will become the long-term memory of these events, replacing them in context henceforth. ${lengthInstruction}`;
	}
	return `META: Context compaction required. Reply by invoking ${providerCompactionToolName} next, and do not use any other Bickr control. Put a detailed summary of everything important, from the first-person perspective of u/${bot.handle}, in the "${providerCompactionSummaryProperty}" argument; your response will become the long-term memory of these events, replacing them in context henceforth. ${lengthInstruction}`;
}

function providerCompactionShortenInstruction(limits: Pick<ProviderCompactionSummaryLimits, "minLength" | "maxLength">, mode: ProviderCompactionMode): string {
	const lengthInstruction = providerCompactionLengthInstruction(limits);
	if (mode === "structured_output") {
		return `META: The previous context compaction attempt produced a summary that was too long. Reply with a JSON object matching the required structured output schema, and do not use any Bickr control. Put a shorter first-person memory summary in the "${providerCompactionSummaryProperty}" field. ${lengthInstruction}`;
	}
	return `META: The previous context compaction attempt produced a summary that was too long. Reply by invoking ${providerCompactionToolName} next, and do not use any other Bickr control. Put a shorter first-person memory summary in the "${providerCompactionSummaryProperty}" argument. ${lengthInstruction}`;
}

function providerCompactionLengthInstruction(limits: Pick<ProviderCompactionSummaryLimits, "minLength" | "maxLength">): string {
	return limits.minLength >= limits.maxLength ?
			`Use exactly ${limits.maxLength} characters if possible.`
		:	`Use between ${limits.minLength} and ${limits.maxLength} characters.`;
}

function providerCompactionShortenMessages(
	previousMessages: readonly ChatMessage[],
	previousSummary: string,
	limits: Pick<ProviderCompactionSummaryLimits, "minLength" | "maxLength">,
	mode: ProviderCompactionMode = "structured_output",
): ChatMessage[] {
	const systemMessage = previousMessages.find((message) => message.role === "system");
	return [
		...(systemMessage ? [systemMessage] : []),
		{ role: "assistant", content: previousSummary },
		{ role: "user", content: providerCompactionShortenInstruction(limits, mode) },
	];
}

export function providerCompactionMessages(
	bot: BotDocument,
	compactedMessages: ChatMessage[],
	limits: Pick<ProviderCompactionSummaryLimits, "minLength" | "maxLength"> = defaultProviderCompactionSummaryLimits,
	providerTools: ProviderToolDefinition[] = toolDefinitionsForProviderRound(limits.maxLength),
	mode: ProviderCompactionMode = "structured_output",
): ChatMessage[] {
	const tools = providerCompactionToolsForMode(limits, providerTools, mode);
	return [
		{
			role: "system",
			content: providerCompactionSystemInstruction(bot, tools, mode),
		},
		...compactedMessages,
		{
			role: "user",
			content: providerCompactionSummaryInstruction(bot, limits, mode),
		},
		...(mode === "tool_call" ?
			[{
				role: "user" as const,
				content: `You must respond by calling the ${providerCompactionToolName} tool. Put the summary in the "${providerCompactionSummaryProperty}" argument. ${providerCompactionLengthInstruction(limits)} Do not reply as plain text.`,
			}]
		:	[]),
	];
}

export function providerCompactionSummaryLimitsForChat(
	bot: BotDocument,
	compactedMessages: readonly ChatMessage[],
	calibration: TextTokenCalibration,
	providerTools?: ProviderToolDefinition[],
	mode: ProviderCompactionMode = "structured_output",
): ProviderCompactionSummaryLimits {
	const tickSettings = effectiveTickSettings(bot.tickSettings);
	const contextWindowTokens = Math.max(1, Math.floor(tickSettings.contextWindowTokens));
	const tokensPerCharacter = Math.max(minCalibratedTokensPerCharacter, calibration.tokensPerCharacter || fallbackTokensPerCharacter);
	const configuredMaxCharacters = Math.max(1, Math.floor(tickSettings.compactionMaxCharacters));
	const compactedCharacterCount = chatMessagesCharacterCount(compactedMessages);
	const compactionSummaryPercent = Math.max(1, Math.min(50, Math.floor(tickSettings.compactionSummaryPercent)));
	let maxLength = configuredMaxCharacters;
	let minLength = Math.min(maxLength, Math.max(1, Math.ceil(compactedCharacterCount * compactionSummaryPercent / 100)));
	let anticipatedSummaryTokens = Math.max(1, Math.ceil(minLength * tokensPerCharacter));
	let maxSummaryTokens = Math.max(1, Math.ceil(configuredMaxCharacters * tokensPerCharacter));
	let compactionRequestOverheadTokens = providerPromptEstimateSafetyTokens;
	let maxCompletionTokens = Math.max(1, contextWindowTokens - compactionRequestOverheadTokens);
	let compactionInputTokens = Math.max(1, contextWindowTokens - anticipatedSummaryTokens - compactionRequestOverheadTokens);
	let nextCompactionTokens = providerPromptCompactionCutoffTokens(contextWindowTokens, anticipatedSummaryTokens);

	for (let iteration = 0; iteration < 3; iteration += 1) {
		maxLength = configuredMaxCharacters;
		minLength = Math.min(maxLength, Math.max(1, Math.ceil(compactedCharacterCount * compactionSummaryPercent / 100)));
		const effectiveProviderTools = providerCompactionToolsForMode({ minLength, maxLength }, providerTools, mode);
		anticipatedSummaryTokens = Math.max(1, Math.ceil(minLength * tokensPerCharacter));
		maxSummaryTokens = Math.max(1, Math.ceil(maxLength * tokensPerCharacter));
		compactionRequestOverheadTokens = providerCompactionRequestOverheadTokens(bot, { minLength, maxLength }, calibration, effectiveProviderTools, mode);
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
		Math.floor(contextWindowTokens) - Math.max(providerContextReserveTokens, Math.max(1, Math.ceil(anticipatedSummaryTokens))),
	);
}

function providerCompactionRequestOverheadTokens(
	bot: BotDocument,
	limits: Pick<ProviderCompactionSummaryLimits, "minLength" | "maxLength">,
	calibration: TextTokenCalibration,
	providerTools: ProviderToolDefinition[] = toolDefinitionsForProviderRound(limits.maxLength),
	mode: ProviderCompactionMode = "structured_output",
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

function providerCompactionResponseFormat(
	maxCharacters: number,
	mode: ProviderCompactionMode = "structured_output",
): ProviderJsonSchemaResponseFormat | undefined {
	if (mode !== "structured_output") {
		return undefined;
	}
	return {
		type: "json_schema",
		json_schema: {
			name: "compaction_summary",
			strict: true,
			schema: {
				type: "object",
				properties: {
					[providerCompactionSummaryProperty]: {
						type: "string",
						minLength: 1,
						maxLength: Math.max(1, Math.floor(maxCharacters)),
					},
				},
				required: [providerCompactionSummaryProperty],
				additionalProperties: false,
			},
		},
	};
}

export function providerCompactionRequest(
	settings: Pick<ProviderSettings, "model" | "providerRouting" | "reasoningEffort" | "supportsPrefill" | "toolCalls">,
	messages: ChatMessage[],
	limits: Pick<ProviderCompactionSummaryLimits, "minLength" | "maxLength" | "maxCompletionTokens"> = defaultProviderCompactionSummaryLimits,
	providerTools?: ProviderToolDefinition[],
	mode: ProviderCompactionMode = "structured_output",
): ProviderCompactionRequest {
	const toolCalls = structuredToolCallsMode(settings.toolCalls ?? "require");
	const effectiveProviderTools = providerTools ?? providerCompactionToolsForMode(limits, undefined, mode);
	const toolChoice = mode === "structured_output" ? undefined : providerToolChoiceForMode(toolCalls);
	const responseFormat = providerCompactionResponseFormat(limits.maxLength, mode);
	return {
		model: settings.model,
		messages: sanitizeProviderMessagesForRequest(providerMessagesWithPrefillCompatibility(settings, messages)),
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		stream: false,
		tools: effectiveProviderTools,
		...(toolChoice ? { tool_choice: toolChoice } : {}),
		parallel_tool_calls: false,
		...(responseFormat ? { response_format: responseFormat } : {}),
		max_completion_tokens: limits.maxCompletionTokens,
		reasoning: providerReasoningForSettings(settings),
		temperature: providerCompactionTemperature,
	};
}

export function effectiveReasoningPrefill(bot: Pick<BotDocument, "handle" | "inferenceSettings">): string | undefined {
	if (bot.inferenceSettings.recurringPromptEnabled === false) {
		return undefined;
	}
	const custom = bot.inferenceSettings.recurringPrompt ?? bot.inferenceSettings.reasoningPrefill;
	return custom && custom.trim() ? custom : defaultReasoningPrefill(bot.handle);
}

export function providerMessagesWithReasoningPrefill(
	messages: ChatMessage[],
	reasoningPrefill: string | undefined,
): ChatMessage[] {
	return reasoningPrefill ? [...messages, { role: "assistant", content: reasoningPrefill }] : messages;
}

function contextBudgetPromptParts(bot: BotDocument, settings: ProviderSettings): ContextBudgetPromptParts {
	const { tools: providerTools } = providerToolsForBotRound(bot, settings);
	const fixedSystemToolInstructionTools = providerTools;
	const fixedSystemMessage =
		settings.toolCalls === "at_will" ? standardPrompt({ ...bot, prompt: "" }) : appendToolRequirementInstruction(standardPrompt({ ...bot, prompt: "" }), fixedSystemToolInstructionTools);
	const fullSystemMessage =
		settings.toolCalls === "at_will" ? standardPrompt(bot) : appendToolRequirementInstruction(standardPrompt(bot), fixedSystemToolInstructionTools);
	return {
		fixedSystemMessage,
		fullSystemMessage,
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
			providerMessagesWithReasoningPrefill([{ role: "system", content: systemMessage }], reasoningPrefill),
			calibration,
		) +
		estimateTextTokensWithCalibration(JSON.stringify(providerTools), calibration) +
		providerPromptEstimateSafetyTokens
	);
}

function estimatedMinimumCompactedPromptTokens(
	parts: ContextBudgetPromptParts,
	calibration: TextTokenCalibration,
): number {
	return (
		estimateChatMessagesTokens(
			providerMessagesWithPrefillCompatibility(
				{ supportsPrefill: parts.supportsPrefill },
				providerMessagesWithReasoningPrefill(
					[
						{ role: "system", content: parts.fullSystemMessage },
						{ role: "assistant", content: "x" },
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
	const content = repairInvalidUnicodeText(response.content ?? "");
	const reasoning = repairInvalidUnicodeText(response.reasoning ?? "");
	const reasoningDetails = normalizeReasoningDetailsForProviderHistory(response.reasoningDetails ?? []);
	const toolCalls = response.toolCalls ?? [];
	if (
		!hasProviderHistoryText(content) &&
		!hasProviderHistoryText(reasoning) &&
		reasoningDetails.length === 0 &&
		toolCalls.length === 0
	) {
		return null;
	}
	const message: BotInferenceSubmissionMessage = { role: "assistant" };
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

function normalizeReasoningDetailsForProviderHistory(details: readonly unknown[]): ReasoningDetail[] {
	const normalized: ReasoningDetail[] = [];
	for (const detail of details) {
		const record = repairInvalidUnicodeValue({ ...runtimeRecord(detail) }).value;
		const last = normalized[normalized.length - 1];
		if (
			last &&
			record.type === "reasoning.text" &&
			last.type === "reasoning.text" &&
			typeof record.text === "string" &&
			typeof last.text === "string" &&
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
	let repaired = "";
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
	if (typeof value === "string") {
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
	if (value && typeof value === "object") {
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
	return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xDC00 && code <= 0xDFFF;
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
	const sanitized = messages.map(sanitizeProviderMessageForRequest);
	assertNoInvalidUnicodeValue(sanitized, "provider request messages");
	return sanitized;
}

function sanitizeProviderMessageForRequest(message: ChatMessage): ChatMessage {
	return ensureAssistantContentForProviderRequest(repairProviderMessageUnicode(message).value);
}

function repairProviderMessageUnicode(message: ChatMessage): InvalidUnicodeRepair<ChatMessage> {
	const messageRepair = repairInvalidUnicodeValue(message);
	let repairedMessage = messageRepair.value;
	let repairCount = messageRepair.repairCount;
	if (repairedMessage.role === "tool" && typeof repairedMessage.content === "string") {
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
	if (message.role !== "assistant" || typeof message.content === "string") {
		return message;
	}
	return { ...message, content: "" };
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
	assertNoInvalidUnicodeValue(value, "provider request");
	return JSON.stringify(value);
}

function invalidUnicodePath(value: unknown): boolean {
	if (typeof value === "string") {
		return repairInvalidUnicodeText(value) !== value;
	}
	if (Array.isArray(value)) {
		return value.some(invalidUnicodePath);
	}
	if (value && typeof value === "object") {
		return Object.values(value).some(invalidUnicodePath);
	}
	return false;
}

export function sanitizeProviderToolCalls(toolCalls: readonly BotInferenceSubmissionToolCall[]): ProviderToolCallSanitization {
	const sanitized: ToolCall[] = [];
	const dropped: DroppedProviderToolCall[] = [];
	let repairedTextCount = 0;
	for (const toolCall of toolCalls) {
		const functionRecord = runtimeRecord(toolCall.function);
		const rawId = typeof toolCall.id === "string" && toolCall.id.length > 0 ? toolCall.id : "";
		const id = repairInvalidUnicodeText(rawId);
		if (id !== rawId) {
			repairedTextCount += 1;
		}
		const rawName = stringValue(functionRecord.name) ?? "";
		const name = repairInvalidUnicodeText(rawName);
		if (name !== rawName) {
			repairedTextCount += 1;
		}
		const rawArguments = functionRecord.arguments;
		if (!id) {
			dropped.push(droppedProviderToolCall(id, name, "missing_tool_call_id", rawArguments));
			continue;
		}
		if (!name) {
			dropped.push(droppedProviderToolCall(id, name, "missing_function_name", rawArguments));
			continue;
		}
		if (typeof rawArguments !== "string") {
			dropped.push(droppedProviderToolCall(id, name, "invalid_arguments_json", rawArguments));
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawArguments) as unknown;
		} catch {
			dropped.push(droppedProviderToolCall(id, name, "invalid_arguments_json", rawArguments));
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			dropped.push(droppedProviderToolCall(id, name, "arguments_not_json_object", rawArguments));
			continue;
		}
		const argumentRepair = repairInvalidUnicodeValue(parsed);
		repairedTextCount += argumentRepair.repairCount;
		sanitized.push({
			id,
			type: "function",
			function: {
				name,
				arguments: JSON.stringify(argumentRepair.value),
			},
		});
	}
	return { toolCalls: sanitized, dropped, repairedTextCount };
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
		if (canonical !== "follow_profile" && canonical !== "unfollow_profile") {
			deduped.push(toolCall);
			continue;
		}
		const args = parseToolArgs(toolCall);
		let parsed: { targets: FollowToolTarget[]; removedLocalDuplicate: boolean };
		try {
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
			dropped.push(droppedProviderToolCall(toolCall.id, toolCall.function.name, "duplicate_tool_call", toolCall.function.arguments));
			continue;
		}
		if (parsed.removedLocalDuplicate || effectiveTargets.length !== parsed.targets.length) {
			deduped.push(toolCallWithArguments(
				toolCall,
				JSON.stringify(providerToolArgs(canonical, followToolArgsWithTargets(args, effectiveTargets))),
			));
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
		id: id ?? "",
		name: name ?? "",
		reason,
		argumentsPreview: providerToolCallArgumentsPreview(rawArguments),
	};
}

function providerToolCallArgumentsPreview(rawArguments: unknown): string {
	const text =
		typeof rawArguments === "string" ? rawArguments
		: rawArguments === undefined ? ""
		: JSON.stringify(rawArguments);
	return safeContextText(text ?? "", 500);
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
		actions.push({ kind: "delete", seq });
	};
	const updateRow = (seq: number, message: ChatMessage): void => {
		if (actionSeqs.has(seq)) {
			return;
		}
		actionSeqs.add(seq);
		actions.push({ kind: "update", seq, message });
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
		if (message.role === "tool") {
			if (!consumedToolRowSeqs.has(current.row.seq)) {
				deleteRow(current.row.seq);
			} else if (repairedMessage) {
				updateRow(current.row.seq, repairedMessage);
			}
			continue;
		}
		if (message.role !== "assistant") {
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
			if (!candidate || candidate.message.role !== "tool") {
				break;
			}
			const toolCallId = typeof candidate.message.tool_call_id === "string" ? candidate.message.tool_call_id : "";
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
				dropped.push(droppedProviderToolCall(toolCall.id, toolCall.function.name, "unanswered_tool_call", toolCall.function.arguments));
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

export function loopMessageContributesToProviderHistory(
	origin: BotLoopMessageOrigin,
	message: BotInferenceSubmissionMessage,
): boolean {
	if (origin === "runtime_error") {
		return false;
	}
	return origin !== "provider_response" || !isEmptyProviderAssistantMessage(message);
}

function loopMessageContributesToCompactionProviderInput(row: LoopMessageRow): boolean {
	const message = loopMessageChatMessageFromRow(row);
	return loopMessageContributesToProviderHistory(row.origin, message) && !isRecurringPromptSyntheticContext(row.origin, message);
}

function isRecurringPromptSyntheticContext(
	origin: BotLoopMessageOrigin,
	message: BotInferenceSubmissionMessage,
): boolean {
	return (
		origin === "synthetic_context" &&
		message.role === "assistant" &&
		!message.tool_calls?.length &&
		typeof message.content === "string" &&
		Boolean(message.content.trim())
	);
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
		return "Inference provider returned an error";
	}
	if (/^Prompt context\b/.test(message)) {
		return "Inference request failed";
	}
	return "Runtime failed";
}

function isEmptyProviderAssistantMessage(message: BotInferenceSubmissionMessage): boolean {
	return (
		message.role === "assistant" &&
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
	if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
		return { kind: "unchanged", message };
	}

	let changed = false;
	const nextToolCalls: ToolCall[] = [];
	for (const toolCall of message.tool_calls) {
		if (toolCall.id !== rewrite.toolCallId) {
			nextToolCalls.push(cloneToolCall(toolCall));
			continue;
		}
		changed = true;
		if (rewrite.kind === "replace_arguments") {
			nextToolCalls.push(toolCallWithArguments(toolCall, rewrite.arguments));
		}
	}
	if (!changed) {
		return { kind: "unchanged", message };
	}

	const nextMessage: BotInferenceSubmissionMessage = { ...message };
	if (nextToolCalls.length > 0) {
		nextMessage.tool_calls = nextToolCalls;
	} else {
		delete nextMessage.tool_calls;
	}
	if (isEmptyProviderAssistantMessage(nextMessage)) {
		return { kind: "deleted" };
	}
	return { kind: "updated", message: nextMessage };
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
	return typeof value === "string" && value.trim().length > 0;
}

export function providerTokenProbeRequest(
	settings: ProviderSettings,
	messages: ChatMessage[],
	tools: ProviderToolDefinition[],
): ProviderTokenProbeRequest {
	return {
		model: settings.model,
		messages: sanitizeProviderMessagesForRequest(providerMessagesWithPrefillCompatibility(settings, messages)),
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		tools,
		tool_choice: providerTokenProbeToolChoice,
		parallel_tool_calls: providerParallelToolCalls,
		stream: false,
		max_tokens: 1,
		reasoning: providerReasoningForSettings(settings),
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
			type: "function",
			function: {
				name: providerTranslationToolName,
				description: "Save the translated text.",
				parameters: {
					type: "object",
					properties: {
						translation: { type: "string" },
					},
					required: ["translation"],
					additionalProperties: false,
				},
			},
		},
	];
}

export function providerTranslationRequest(
	settings: TranslationProviderSettings,
	text: string,
): ProviderTranslationRequest {
	return {
		model: settings.model,
		messages: [
			{ role: "system", content: appendToolRequirementInstruction(settings.prompt, providerTranslationTools()) },
			{
				role: "user",
				content: `Translate the following text. You must respond by calling the ${providerTranslationToolName} tool with the translated text in the translation argument. Do not reply as plain text.\n\nText:\n${text}`,
			},
		],
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		stream: false,
		tools: providerTranslationTools(),
		...(providerToolChoiceForMode(settings.toolCalls ?? "require") ? { tool_choice: providerToolChoiceForMode(settings.toolCalls ?? "require") } : {}),
		parallel_tool_calls: false,
		max_completion_tokens: providerTranslationMaxCompletionTokens,
		reasoning: providerReasoningForSettings(settings),
		temperature: settings.temperature,
		...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
		...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
		...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
		...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
		...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
		...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
	};
}

export function promptContextBudgetFromCounts(input: PromptContextBudgetCounts): Pick<
	BotContextBudget,
	"fixedSystemTokens" | "overBudgetTokens" | "personaPromptTokens" | "remainingLoopTokens" | "responseReserveTokens" | "totalReservedTokens"
> {
	const fixedSystemTokens = Math.max(0, Math.floor(input.fixedSystemTokens));
	const personaPromptTokens = Math.max(0, Math.floor(input.personaPromptTokens));
	const responseReserveTokens = Math.max(0, Math.floor(input.responseReserveTokens));
	const contextWindowTokens = Math.max(0, Math.floor(input.contextWindowTokens));
	const totalReservedTokens = fixedSystemTokens + personaPromptTokens + responseReserveTokens;
	return {
		fixedSystemTokens,
		personaPromptTokens,
		responseReserveTokens,
		totalReservedTokens,
		remainingLoopTokens: Math.max(0, contextWindowTokens - totalReservedTokens),
		overBudgetTokens: Math.max(0, totalReservedTokens - contextWindowTokens),
	};
}

export async function promptContextBudgetCacheFingerprint(
	parts: PromptContextBudgetFingerprintParts,
): Promise<string> {
	return sha256Hex(JSON.stringify(parts));
}

export function effectiveProviderSettingsForBot(
	bot: Pick<BotDocument, "inferenceSettings">,
	owner: Pick<UserDocument, "inferenceSettings">,
	env: Pick<Env, "OPENROUTER_API_KEY" | "OPENROUTER_BASE_URL" | "OPENROUTER_MODEL">,
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
	const botTemperatureIsLegacyDefault = bot.inferenceSettings.temperature === 0.9;
	const hasUserProvider = Boolean(userApiKey || userBaseUrl);
	const hasBotOrInheritedProvider = Boolean(botApiKey || botBaseUrl || hasUserProvider);
	const hasCustomBaseUrl = Boolean(botBaseUrl || userBaseUrl);

	const model =
		botModel && hasBotOrInheritedProvider ? botModel
		: userModel && hasUserProvider ? userModel
		: envModel ? envModel
		: fallbackProviderModel;
	const baseUrl = botBaseUrl ?? userBaseUrl ?? envBaseUrl ?? fallbackProviderBaseUrl;
	const temperature =
		bot.inferenceSettings.temperature !== undefined &&
		(!botTemperatureIsLegacyDefault || userSettings.temperature === undefined) ?
			bot.inferenceSettings.temperature
		: userSettings.temperature !== undefined ? userSettings.temperature
		: bot.inferenceSettings.temperature !== undefined ? bot.inferenceSettings.temperature
		: 0.9;
		const providerRouting =
			bot.inferenceSettings.providerRouting !== undefined ? bot.inferenceSettings.providerRouting : userSettings.providerRouting;
		const effectiveProviderRouting = openRouterProviderRouting(baseUrl, providerRouting);
		const reasoningEffort = bot.inferenceSettings.reasoningEffort ?? userSettings.reasoningEffort;
		const toolCalls = bot.inferenceSettings.toolCalls ?? userSettings.toolCalls ?? "require";

		return {
			apiKey: botApiKey ?? userApiKey ?? (hasCustomBaseUrl ? undefined : envApiKey),
			baseUrl,
			model,
			compactionMode: bot.inferenceSettings.compactionMode ?? userSettings.compactionMode ?? "structured_output",
			...(effectiveProviderRouting ? { providerRouting: effectiveProviderRouting } : {}),
			...(reasoningEffort && reasoningEffort !== "default" ? { reasoningEffort } : {}),
			supportsPrefill: bot.inferenceSettings.supportsPrefill ?? userSettings.supportsPrefill ?? true,
			toolCalls,
			temperature,
		...(hasCustomBaseUrl ? { usesCustomBaseUrl: true } : {}),
		...(bot.inferenceSettings.topK !== undefined ? { topK: bot.inferenceSettings.topK }
		: userSettings.topK !== undefined ? { topK: userSettings.topK }
		: {}),
		...(bot.inferenceSettings.topP !== undefined ? { topP: bot.inferenceSettings.topP }
		: userSettings.topP !== undefined ? { topP: userSettings.topP }
		: {}),
		...(bot.inferenceSettings.minP !== undefined ? { minP: bot.inferenceSettings.minP }
		: userSettings.minP !== undefined ? { minP: userSettings.minP }
		: {}),
		...(bot.inferenceSettings.frequencyPenalty !== undefined ? { frequencyPenalty: bot.inferenceSettings.frequencyPenalty }
		: userSettings.frequencyPenalty !== undefined ? { frequencyPenalty: userSettings.frequencyPenalty }
		: {}),
		...(bot.inferenceSettings.presencePenalty !== undefined ? { presencePenalty: bot.inferenceSettings.presencePenalty }
		: userSettings.presencePenalty !== undefined ? { presencePenalty: userSettings.presencePenalty }
		: {}),
		...(bot.inferenceSettings.repetitionPenalty !== undefined ? { repetitionPenalty: bot.inferenceSettings.repetitionPenalty }
		: userSettings.repetitionPenalty !== undefined ? { repetitionPenalty: userSettings.repetitionPenalty }
		: {}),
	};
}

export function effectiveProviderSettingsForTranslation(
	user: Pick<UserDocument, "inferenceSettings">,
	env: Pick<Env, "OPENROUTER_API_KEY" | "OPENROUTER_BASE_URL" | "OPENROUTER_MODEL">,
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
	const providerRouting = openRouterProviderRouting(
		baseUrl,
		usingLoopSettings ? userSettings.providerRouting : translation.providerRouting,
	);
	const reasoningEffort = usingLoopSettings ? userSettings.reasoningEffort : translation.reasoningEffort;
	const toolCalls = structuredToolCallsMode(usingLoopSettings ? userSettings.toolCalls ?? "require" : translation.toolCalls ?? "require");
	return {
		apiKey: userApiKey ?? (hasCustomBaseUrl ? undefined : envApiKey),
		baseUrl,
		model,
		...(providerRouting ? { providerRouting } : {}),
		...(reasoningEffort && reasoningEffort !== "default" ? { reasoningEffort } : {}),
		toolCalls,
		prompt: trimmed(translation?.prompt) ?? defaultTranslationPrompt,
		temperature: usingLoopSettings ? userSettings.temperature ?? 0.9 : translation.temperature ?? 0,
		...(usingLoopSettings ?
			{
				...(userSettings.topK !== undefined ? { topK: userSettings.topK } : {}),
				...(userSettings.topP !== undefined ? { topP: userSettings.topP } : {}),
				...(userSettings.minP !== undefined ? { minP: userSettings.minP } : {}),
				...(userSettings.frequencyPenalty !== undefined ? { frequencyPenalty: userSettings.frequencyPenalty } : {}),
				...(userSettings.presencePenalty !== undefined ? { presencePenalty: userSettings.presencePenalty } : {}),
				...(userSettings.repetitionPenalty !== undefined ? { repetitionPenalty: userSettings.repetitionPenalty } : {}),
			}
		:	{
				...(translation.topK !== undefined ? { topK: translation.topK } : {}),
				...(translation.topP !== undefined ? { topP: translation.topP } : {}),
				...(translation.minP !== undefined ? { minP: translation.minP } : {}),
				...(translation.frequencyPenalty !== undefined ? { frequencyPenalty: translation.frequencyPenalty } : {}),
				...(translation.presencePenalty !== undefined ? { presencePenalty: translation.presencePenalty } : {}),
				...(translation.repetitionPenalty !== undefined ? { repetitionPenalty: translation.repetitionPenalty } : {}),
			}),
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
	private readonly activeStreamActivity = new Map<string, string>();
	private ephemeralStreamSeq = 0;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.state.blockConcurrencyWhile(async () => {
			for (const statement of runtimeSchema.split(";")) {
				const sql = statement.trim();
				if (sql) {
					this.state.storage.sql.exec(sql);
				}
			}
			this.ensureInjectionColumns();
			this.ensureInferenceSubmissionColumns();
			this.ensureLoopMessageColumns();
			this.migrateLegacyLoopMessages();
		});
	}

	private ensureInjectionColumns(): void {
		const columns = new Set(
			this.state.storage.sql
				.exec<{ name: string }>(`PRAGMA table_info(injections)`)
				.toArray()
				.map((row) => row.name),
		);
		if (!columns.has("kind")) {
			this.state.storage.sql.exec(`ALTER TABLE injections ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual'`);
		}
		if (!columns.has("source_id")) {
			this.state.storage.sql.exec(`ALTER TABLE injections ADD COLUMN source_id TEXT`);
		}
		if (!columns.has("spotlight_id")) {
			this.state.storage.sql.exec(`ALTER TABLE injections ADD COLUMN spotlight_id TEXT`);
		}
	}

	private ensureInferenceSubmissionColumns(): void {
		const columns = new Set(
			this.state.storage.sql
				.exec<{ name: string }>(`PRAGMA table_info(inference_submissions)`)
				.toArray()
				.map((row) => row.name),
		);
		if (!columns.has("display_messages_json")) {
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
		if (!columns.has("deleted_at")) {
			this.state.storage.sql.exec(`ALTER TABLE loop_messages ADD COLUMN deleted_at TEXT`);
		}
		if (!columns.has("stream_seq")) {
			this.state.storage.sql.exec(`ALTER TABLE loop_messages ADD COLUMN stream_seq INTEGER`);
		}
		this.state.storage.sql.exec(`CREATE INDEX IF NOT EXISTS loop_messages_visible ON loop_messages (deleted_at, compacted_by, position, seq)`);
	}

	private migrateLegacyLoopMessages(): void {
		const existing = this.state.storage.sql
			.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM loop_messages`)
			.one().count;
		if (existing > 0 || this.runtimeStateBoolean("loop_messages_legacy_migrated")) {
			return;
		}
		const eventCount = this.state.storage.sql
			.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM events`)
			.one().count;
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
		const activity = rows.map((row) => truncateForContext(runtimeContextLine(row), 500)).join("\n");
		const summary = storedMemorySummary(
			[
				latestSummary.trim(),
				activity.trim() ?
					`Before this exact chat log began, I had this Bickr history:\n${activity.trim()}`
				:	"",
			].filter(Boolean).join("\n\n"),
		);
		if (summary) {
			const message = { role: "assistant" as const, content: summary };
			const inserted = this.insertLoopMessage({
				runId: "legacy-migration",
				message,
				origin: "legacy_migration",
				status: "complete",
				position: 1,
				createdAt: rows[0]?.created_at ?? new Date().toISOString(),
				broadcast: false,
			});
			this.recordLoopMessageLog(inserted.seq, "message", JSON.stringify(message));
		}
		this.setRuntimeState("loop_messages_legacy_migrated", true);
	}

	private runtimeStateBoolean(key: string): boolean {
		const row = this.state.storage.sql
			.exec<{ value_json: string }>(`SELECT value_json FROM runtime_state WHERE key = ?`, key)
			.toArray()[0];
		if (!row) {
			return false;
		}
		try {
			return JSON.parse(row.value_json) === true;
		} catch {
			return false;
		}
	}

	private setRuntimeState(key: string, value: unknown): void {
		this.state.storage.sql.exec(
			`INSERT INTO runtime_state (key, value_json)
			 VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
			key,
			JSON.stringify(value),
		);
	}

	async fetch(request: Request): Promise<Response> {
		try {
			const url = new URL(request.url);
			const botId = botIdFromPath(url.pathname);

			if (request.method === "GET" && url.pathname.endsWith("/status")) {
				await this.requireOwnerOrInternal(request, botId);
				return ok({ status: await this.status(botId) });
			}

			if (request.method === "GET" && url.pathname.endsWith("/events")) {
				await this.requireOwnerOrInternal(request, botId);
				const after = Number(url.searchParams.get("after") ?? 0);
				return ok({ events: this.eventsAfter(Number.isFinite(after) ? after : 0) });
			}

			if (request.method === "GET" && url.pathname.endsWith("/messages")) {
				await this.requireOwnerOrInternal(request, botId);
				const after = Number(url.searchParams.get("after") ?? 0);
				const page = Number(url.searchParams.get("page") ?? 1);
				return ok(this.loopMessagesPage({
					after: Number.isFinite(after) ? after : 0,
					page: Number.isFinite(page) ? page : 1,
				}));
			}

			const messageLogSeq = messageLogsSeqFromPath(url.pathname);
			if (request.method === "GET" && messageLogSeq !== null) {
				await this.requireOwnerOrInternal(request, botId);
				return ok(this.loopMessageLogsForSeq(messageLogSeq));
			}

			const messageSeq = messageSeqFromPath(url.pathname);
			if (request.method === "DELETE" && messageSeq !== null) {
				await this.requireOwnerOrInternal(request, botId);
				return ok({ deleted: await this.deleteLoopMessage(botId, messageSeq) });
			}

			if (request.method === "GET" && url.pathname.endsWith("/submissions")) {
				await this.requireOwnerOrInternal(request, botId);
				return ok({ submissions: this.inferenceSubmissionSummaries() });
			}

			const submissionSeq = submissionSeqFromPath(url.pathname);
			if (request.method === "GET" && submissionSeq !== null) {
				await this.requireOwnerOrInternal(request, botId);
				return ok({ submission: this.inferenceSubmissionForSeq(submissionSeq) });
			}

			if (request.method === "GET" && url.pathname.endsWith("/token-usage")) {
				await this.requireOwnerOrInternal(request, botId);
				return ok({ usage: this.tokenUsageStats(await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId)) });
			}

			if (request.method === "GET" && url.pathname.endsWith("/context-budget")) {
				await this.requireOwnerOrInternal(request, botId);
				return ok({ budget: await this.cachedPromptContextBudget(botId) });
			}

			if (request.method === "POST" && url.pathname.endsWith("/context-budget")) {
				await this.requireOwnerOrInternal(request, botId);
				const input = parseBotContextBudgetInput(await readJsonBody(request));
				return ok({ budget: await this.promptContextBudget(botId, input) });
			}

			if (request.method === "DELETE" && url.pathname.endsWith("/events")) {
				await this.requireOwnerOrInternal(request, botId);
				const cleared = await this.clearHistory(botId);
				return ok({ cleared });
			}

			if (request.method === "POST" && url.pathname.endsWith("/compact")) {
				await this.requireOwnerOrInternal(request, botId);
				const compacted = await this.manualCompactLoopMessages(botId);
				return ok({ compacted });
			}

			if (request.method === "DELETE" && eventSeqFromPath(url.pathname) !== null) {
				await this.requireOwnerOrInternal(request, botId);
				const deleted = await this.deleteEvent(botId, eventSeqFromPath(url.pathname) ?? 0);
				return ok({ deleted });
			}

			if (request.method === "POST" && url.pathname.endsWith("/tick")) {
				await this.requireOwnerOrInternal(request, botId);
				const options = await readTickOptions(request);
				const trigger =
					options.mode === "spotlight" ? "spotlight"
					: request.headers.get("x-bickr-scheduler") ? "cron"
					: "manual";
				if (options.background) {
					const run = await this.startBackgroundTick(botId, trigger, options);
					return ok({ run });
				}
				const run = await this.runTick(botId, trigger, options);
				return ok({ run });
			}

			if (request.method === "POST" && url.pathname.endsWith("/stop")) {
				await this.requireOwnerOrInternal(request, botId);
				const stop = await this.stopTick(botId);
				return ok({ stop });
			}

			if (request.method === "POST" && url.pathname.endsWith("/inject")) {
				await this.requireOwnerOrInternal(request, botId);
				const body = await readJsonBody(request);
				const text =
					body && typeof body === "object" && "text" in body && typeof body.text === "string" ?
						body.text.trim()
					:	"";
				if (!text) {
					throw new InputError("Injection text is required.");
				}
				const event = await this.injectThought(text, {
					kind: stringValue(body && typeof body === "object" ? (body as Record<string, unknown>).kind : undefined) ?? "manual",
					sourceId: stringValue(body && typeof body === "object" ? (body as Record<string, unknown>).sourceId : undefined),
					spotlightId: stringValue(body && typeof body === "object" ? (body as Record<string, unknown>).spotlightId : undefined),
				});
				return ok({ event, injectionId: stringValue(runtimeRecord(event.payload).injectionId) });
			}

			if (request.method === "GET" && url.pathname.endsWith("/monitor")) {
				await this.requireOwnerOrInternal(request, botId);
				if (request.headers.get("Upgrade") !== "websocket") {
					return fail("bad_request", "Expected WebSocket upgrade.", 400);
				}
				const pair = new WebSocketPair();
				const [client, server] = Object.values(pair);
				this.state.acceptWebSocket(server, [botId]);
				const after = Number(url.searchParams.get("after") ?? 0);
				const afterMessage = Number(url.searchParams.get("afterMessage") ?? after);
				const afterEvent = Number(url.searchParams.get("afterEvent") ?? after);
				for (const message of this.loopMessagesAfter(Number.isFinite(afterMessage) ? afterMessage : 0)) {
					server.send(JSON.stringify({ type: "loop_message", loopMessage: message }));
				}
				for (const event of this.eventsAfter(Number.isFinite(afterEvent) ? afterEvent : 0)) {
					server.send(JSON.stringify({ type: "event", event }));
				}
				return new Response(null, { status: 101, webSocket: client });
			}

			return fail("not_found", "Bot runtime route not found.", 404);
		} catch (error) {
			return errorResponse(error);
		}
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		try {
			const text = typeof message === "string" ? message : new TextDecoder().decode(message);
			const payload = JSON.parse(text) as { type?: string; text?: string };
			if (payload.type === "ping") {
				ws.send(JSON.stringify({ type: "pong" }));
				return;
			}
			if (payload.type === "inject" && payload.text?.trim()) {
				const event = await this.injectThought(payload.text.trim());
				ws.send(JSON.stringify({ type: "event", event }));
			}
		} catch (error) {
			ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Bad message." }));
		}
	}

	async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
		console.error("bot runtime monitor WebSocket error", error);
	}

	private async startBackgroundTick(
		botId: string,
		trigger: "cron" | "manual" | "spotlight",
		options: TickOptions,
	): Promise<TickRunResult> {
		const current = await this.status(botId);
		if (this.activeRunId) {
			return this.busyTickResult(current, trigger, options);
		}
		if (current.status === "running") {
			return this.busyTickResult(current, trigger, options);
		}
		if (!current.enabled) {
			return pausedTickResult();
		}
		const tick = this.runTick(botId, trigger, { ...options, background: false }).catch((error) => {
			console.error("background bot tick failed", error);
		});
		this.state.waitUntil(tick);
		return { runId: "background", status: "started" };
	}

	private async runTick(botId: string, trigger: "cron" | "manual" | "spotlight", options: TickOptions = {}): Promise<TickRunResult> {
		const current = await this.status(botId);
		if (this.activeRunId) {
			return this.busyTickResult(current, trigger, options);
		}
		if (current.status === "running") {
			return this.busyTickResult(current, trigger, options);
		}
		if (!current.enabled) {
			return pausedTickResult();
		}

		const bot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
		const owner = await userById(this.env.BICKR_KV, bot.ownerUserId);
		const providerSettings = this.effectiveProviderSettings(bot, owner);
		const runId = crypto.randomUUID();
		const now = new Date().toISOString();
		const abortController = new AbortController();
		this.activeAbortController = abortController;
		this.activeRunId = runId;
		this.clearStopRequest();
		await this.setRuntimeIndex(bot, "running", runId, undefined, now);
		await this.appendEvent(runId, "tick_started", { trigger, botId, handle: bot.handle });
		const mode: TickMode = options.mode === "spotlight" ? "spotlight" : "normal";
		const setupMode: LoopSetupMode =
			mode === "spotlight" ? "spotlight"
			: this.currentIterationStartedSinceLastLogOff() ? "continuation"
			: "new_iteration";
		const runContext: RunContext = {
			mode,
			setupMode,
			...(options.spotlightId ? { spotlightId: options.spotlightId } : {}),
			signal: abortController.signal,
		};
		let startQueuedSpotlightAfterRun = false;

		try {
			this.throwIfStopped(runId, abortController.signal);
			const notifications =
				setupMode !== "new_iteration" ? []
				: await (async () => {
						await ensureBootstrapNotification(this.env.BICKR_KV, this.env.BICKR_D1, bot);
						return listPendingNotifications(this.env.BICKR_KV, this.env.BICKR_D1, bot.id);
					})();
			this.throwIfStopped(runId, abortController.signal);
			const injections = this.consumeInjections(mode === "spotlight" ? options.injectionIds ?? [] : undefined);
			if (mode === "spotlight" && injections.length === 0) {
				const nextDueAt = await this.setRuntimeIndex(bot, "idle", null, undefined, new Date().toISOString());
				await this.appendEvent(runId, "tick_completed", {
					...(nextDueAt ? { nextDueAt } : {}),
					note: "No pending spotlight injection was available.",
				});
				startQueuedSpotlightAfterRun = true;
				return { runId, status: "completed" };
			}
			const builtInput = await buildRuntimeLoopInput(
				this.env.BICKR_KV,
				this.env.BICKR_D1,
				bot.id,
				notifications,
				injections,
				(providerSettings.toolCalls ?? "require") === "at_will" ? undefined : this.pendingToolUseReminder(),
			);
			const input = builtInput.input;
			const inputEvent = await this.appendEvent(runId, "input", input);
			if (setupMode === "new_iteration") {
				await markBotSeenContent(
					this.env.BICKR_D1,
					bot.id,
					[
						...notifications
							.map((notification) => seenItemFromSource(notification.sourceObjectId))
							.filter((item): item is { type: "thread" | "comment"; id: string } => Boolean(item)),
						...builtInput.autoProfileSeenItems,
					],
					"notification",
					runId,
				);
				await markNotificationsDelivered(this.env.BICKR_KV, this.env.BICKR_D1, notifications);
			}

			const messages = await this.buildMessages(bot, input, runId, inputEvent.createdAt, { setupMode });
			this.throwIfStopped(runId, abortController.signal);
			if (providerSettings.apiKey || providerSettings.usesCustomBaseUrl || this.env.BICKR_SIMULATION_MODE === "provider") {
				const outcome = await this.runProviderLoop(bot, providerSettings, runId, messages, runContext);
				if ((providerSettings.toolCalls ?? "require") !== "at_will") {
					this.recordToolUseRecoveryOutcome(runId, outcome.toolCallCount);
				}
				if (
					runContext.mode === "spotlight" &&
					runContext.spotlightId &&
					outcome.logOffCalled &&
					outcome.publicSpotlightToolCallCount === 0
				) {
					try {
						await recordSpotlightNoReactionHumanNotification(this.env.BICKR_D1, {
							bot,
							runId,
							spotlightId: runContext.spotlightId,
						});
					} catch (notificationError) {
						console.warn("spotlight no-reaction notification failed", notificationError);
					}
				}
			} else {
				await this.runLocalSimulation(bot, runId, input, runContext);
			}

			await this.compactIfNeeded(bot, providerSettings, runId, abortController.signal);
			const nextDueAt = await this.setRuntimeIndex(bot, "idle", null, undefined, new Date().toISOString());
			await this.appendEvent(runId, "tick_completed", { ...(nextDueAt ? { nextDueAt } : {}) });
			startQueuedSpotlightAfterRun = true;
			return { runId, status: "completed" };
		} catch (error) {
			if (error instanceof TickStoppedError || isAbortError(error)) {
				if (!this.hasTerminalEvent(runId)) {
					await this.appendEvent(runId, "tick_stopped", { message: "This Bickr visit was stopped." });
				}
				await this.setRuntimeIndex(bot, "idle", null, undefined, new Date().toISOString());
				return { runId, status: "stopped" };
			}
			if (error instanceof PersistentToolFailureError) {
				if (!this.hasTerminalEvent(runId)) {
					await this.recordTickFailure(runId, {
						message: error.message,
						toolName: error.failure.toolName,
						failure: error.failure,
					});
				}
				await this.setRuntimeIndex(bot, "failed", null, error.message, new Date().toISOString());
				try {
					await recordBotRuntimeFailureHumanNotification(this.env.BICKR_D1, {
						bot,
						runId,
						message: error.failure.message,
						toolName: error.failure.toolName,
					});
					if (runContext.mode === "spotlight" && runContext.spotlightId) {
						await recordSpotlightFailureHumanNotification(this.env.BICKR_D1, {
							bot,
							runId,
							spotlightId: runContext.spotlightId,
							message: error.message,
						});
					}
				} catch (notificationError) {
					console.warn("bot runtime failure notification failed", notificationError);
				}
				return { runId, status: "failed", error: error.message };
			}
			if (error instanceof PersistentMissingToolCallError) {
				if (!this.hasTerminalEvent(runId)) {
					await this.recordTickFailure(runId, {
						message: error.message,
						toolNames: error.toolNames,
					});
				}
				await this.setRuntimeIndex(bot, "failed", null, error.message, new Date().toISOString());
				try {
					await recordBotRuntimeFailureHumanNotification(this.env.BICKR_D1, {
						bot,
						runId,
						message: error.message,
					});
					if (runContext.mode === "spotlight" && runContext.spotlightId) {
						await recordSpotlightFailureHumanNotification(this.env.BICKR_D1, {
							bot,
							runId,
							spotlightId: runContext.spotlightId,
							message: error.message,
						});
					}
				} catch (notificationError) {
					console.warn("bot runtime failure notification failed", notificationError);
				}
				return { runId, status: "failed", error: error.message };
			}
			const message = error instanceof Error ? error.message : "Unexpected Bickr visit error.";
			if (!this.hasTerminalEvent(runId)) {
				await this.recordTickFailure(runId, { message }, runtimeFailureLogs(error));
			}
			await this.setRuntimeIndex(bot, "failed", null, message, new Date().toISOString());
			try {
				await recordBotRuntimeFailureHumanNotification(this.env.BICKR_D1, {
					bot,
					runId,
					message,
				});
			} catch (notificationError) {
				console.warn("bot runtime failure notification failed", notificationError);
			}
			if (runContext.mode === "spotlight" && runContext.spotlightId) {
				try {
					await recordSpotlightFailureHumanNotification(this.env.BICKR_D1, {
						bot,
						runId,
						spotlightId: runContext.spotlightId,
						message,
					});
				} catch (notificationError) {
					console.warn("spotlight failure notification failed", notificationError);
				}
			}
			return { runId, status: "failed", error: message };
		} finally {
			if (this.activeRunId === runId) {
				this.activeAbortController = null;
				this.activeRunId = null;
			}
			this.clearStopRequest(runId);
			if (startQueuedSpotlightAfterRun) {
				try {
					this.startQueuedSpotlightTick(botId);
				} catch (error) {
					console.error("queued spotlight tick scheduling failed", error);
				}
			}
		}
	}

	private busyTickResult(
		current: BotRuntimeStatus,
		trigger: "cron" | "manual" | "spotlight",
		options: TickOptions,
	): TickRunResult {
		const runId = this.activeRunId ?? current.activeRunId ?? "active";
		const spotlightRequested = trigger === "spotlight" || options.mode === "spotlight";
		if (spotlightRequested) {
			const queued = this.queuePendingSpotlightTick(runId, options);
			if (queued) {
				return queued;
			}
		}
		return { runId, status: "already_running" };
	}

	private queuePendingSpotlightTick(activeRunId: string, options: TickOptions): TickRunResult | null {
		if (options.mode !== "spotlight" || !options.spotlightId || !options.injectionIds?.length) {
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
		return { runId: activeRunId, status: "queued" };
	}

	private startQueuedSpotlightTick(botId: string): void {
		const pending = this.takeNextPendingSpotlightTick();
		if (!pending) {
			return;
		}
		const tick = this.runTick(botId, "spotlight", {
			mode: "spotlight",
			injectionIds: pending.injectionIds,
			spotlightId: pending.spotlightId,
			background: false,
		})
			.then((result) => {
				if (result.status === "paused") {
					this.prependPendingSpotlightTickEntries(pending.entries);
				}
			})
			.catch((error) => {
				this.prependPendingSpotlightTickEntries(pending.entries);
				console.error("queued spotlight tick failed to start", error);
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
					injectionId: stringValue(entry.injectionId) ?? "",
					spotlightId: stringValue(entry.spotlightId) ?? "",
					createdAt: stringValue(entry.createdAt) ?? "",
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
		this.writePendingSpotlightTickEntries([
			...entries,
			...existing.filter((entry) => !prependedInjectionIds.has(entry.injectionId)),
		]);
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

	private async stopTick(botId: string): Promise<{ stopped: boolean; runId?: string; status: BotRuntimeStatus["status"] }> {
		const current = await this.status(botId);
		const runId = current.activeRunId ?? this.activeRunId ?? undefined;
		if (current.status !== "running" || !runId) {
			return { stopped: false, status: current.status };
		}

		this.setStopRequest(runId);
		await this.appendEvent(runId, "tick_stop_requested", { message: "This Bickr visit was asked to stop." });
		if (this.activeRunId === runId && this.activeAbortController && !this.activeAbortController.signal.aborted) {
			this.activeAbortController.abort();
			return { stopped: true, runId, status: current.status };
		}
		const bot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
		await this.markRunStopped(bot, runId);
		return { stopped: true, runId, status: "idle" };
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
			this.state.storage.sql.exec(
				`DELETE FROM runtime_state WHERE key = ? AND value_json = ?`,
				stopRequestStateKey,
				JSON.stringify(runId),
			);
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
			previous && previous.lastRunId !== runId ? previous.consecutiveNoToolTicks + 1
			: previous ? previous.consecutiveNoToolTicks
			: 1;
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

	private async botWithCurrentRuntimeBudget(bot: BotDocument): Promise<BotDocument> {
		if (!this.env?.BICKR_KV || !this.env?.BICKR_D1) {
			return bot;
		}
		let current: BotDocument;
		try {
			current = await botById(this.env.BICKR_KV, this.env.BICKR_D1, bot.id);
		} catch {
			return bot;
		}
		return {
			...bot,
			tickSettings: {
				...bot.tickSettings,
				...(current.tickSettings.contextWindowTokens === undefined ?
					{ contextWindowTokens: undefined }
				:	{ contextWindowTokens: current.tickSettings.contextWindowTokens }),
			},
		};
	}

	private async markRunStopped(bot: BotDocument, runId: string): Promise<string | null> {
		if (!this.hasTerminalEvent(runId)) {
			await this.appendEvent(runId, "tick_stopped", { message: "This Bickr visit was stopped." });
		}
		const nextDueAt = await this.setRuntimeIndex(bot, "idle", null, undefined, new Date().toISOString());
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
		let publicSpotlightToolCallCount = 0;
		let toolCallCount = 0;
		let successfulToolCallsThisIteration = this.providerLoopInitialSuccessfulToolCallCount();
		let mutatingToolUsedThisIteration = this.successfulMutatingToolCallSinceLastLogOff();
		let prematureLogOffCorrectedThisIteration = this.prematureLogOffCorrectedSinceLastLogOff();
		let generatedTokensThisTick = 0;
		let generatedTokensThisIteration = this.loopGeneratedTokenCountSinceLastLogOff();
		let railroadNoToolAttempts = 0;
		let toolRequestTurns = 0;
		const toolCallsMode = settings.toolCalls ?? "require";
		const tickSettings = effectiveTickSettings(bot.tickSettings);
		const maxSuccessfulToolCallsPerIteration = maxSuccessfulToolCallsPerIterationSetting(bot);
		while (toolRequestTurns < tickSettings.maxToolCallsPerTick) {
			this.throwIfStopped(runId, runContext.signal);
			const { tools: providerTools, serverTools } = providerToolsForBotRound(bot, settings);
			if (providerTools.length === 0) {
				return { logOffCalled, publicSpotlightToolCallCount, toolCallCount };
			}
			let response: ProviderResponse;
			let responseStatus: ProviderMessageStatus = "complete";
			let interruptedError: ProviderResponseInterruptedError | null = null;
			let requestEvent: BotRuntimeEvent;
			let malformedOnlyRetried = false;
			for (;;) {
				await this.repairActiveProviderToolCallHistory(runId);
				const budgetCheck = await this.ensureProviderPromptWithinBudget(bot, settings, runId, runContext.signal, providerTools);
				const requestMessages = budgetCheck.requestMessages;
				const requestContextWindowTokens = budgetCheck.contextWindowTokens ?? tickSettings.contextWindowTokens;
				requestEvent = await this.appendEvent(runId, "provider_request", {
					model: settings.model,
					messageCount: requestMessages.length,
					toolCount: providerTools.length,
					toolCalls: toolCallsMode,
					...(providerToolChoiceForMode(toolCallsMode) ? { toolChoice: providerToolChoiceForMode(toolCallsMode) } : {}),
					parallelToolCalls: providerParallelToolCalls,
					contextWindowTokens: requestContextWindowTokens,
					promptTokens: budgetCheck.promptTokens,
					allowedPromptTokens: budgetCheck.allowedPromptTokens,
					maxCompletionTokens: providerContextReserveTokens,
					reasoning: providerReasoningForSettings(settings),
					temperature: settings.temperature,
					openRouterServerTools: {
						enabled: serverTools.enabled,
						emitted: serverTools.emitted,
						suppressed: serverTools.suppressed,
					},
					iterationToolLimit: {
						successfulToolCalls: successfulToolCallsThisIteration,
						maxSuccessfulToolCalls: maxSuccessfulToolCallsPerIteration,
						mutatingToolUsed: mutatingToolUsedThisIteration,
						prematureLogOffCorrected: prematureLogOffCorrectedThisIteration,
					},
					generatedTokenLimit: {
						tickGeneratedTokens: generatedTokensThisTick,
						maxGeneratedTokensPerTick: tickSettings.maxGeneratedTokensPerTick,
						iterationGeneratedTokens: generatedTokensThisIteration,
						maxGeneratedTokensPerIteration: tickSettings.maxGeneratedTokensPerIteration,
					},
					...(settings.topK !== undefined ? { topK: settings.topK } : {}),
					...(settings.topP !== undefined ? { topP: settings.topP } : {}),
					...(settings.minP !== undefined ? { minP: settings.minP } : {}),
					...(settings.frequencyPenalty !== undefined ? { frequencyPenalty: settings.frequencyPenalty } : {}),
					...(settings.presencePenalty !== undefined ? { presencePenalty: settings.presencePenalty } : {}),
					...(settings.repetitionPenalty !== undefined ? { repetitionPenalty: settings.repetitionPenalty } : {}),
				});
				this.recordInferenceSubmission({
					seq: requestEvent.seq,
					runId,
					purpose: "loop",
					settings,
					messages: requestMessages,
					createdAt: requestEvent.createdAt,
				});
				responseStatus = "complete";
				interruptedError = null;
				try {
					response = await this.callProvider(settings, requestMessages, providerTools, runId, requestEvent.seq, runContext.signal, toolCallsMode);
				} catch (error) {
					if (error instanceof ProviderResponseInterruptedError) {
						response = error.response;
						responseStatus = "interrupted";
						interruptedError = error;
					} else {
						throw error;
					}
				}
				const sanitized = sanitizeProviderResponseToolCalls(response);
				response = sanitized.response;
				const malformedOnlyResponse =
					responseStatus === "complete" &&
					sanitized.originalToolCallCount > 0 &&
					response.toolCalls.length === 0;
				await this.recordDroppedProviderToolCalls(
					runId,
					requestEvent.seq,
					sanitized.dropped,
					"generated_response",
					malformedOnlyResponse && !malformedOnlyRetried,
				);
				if (response.usage) {
					this.recordProviderUsage({
						contextWindowTokens: requestContextWindowTokens,
						createdAt: requestEvent.createdAt,
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
					throw new Error("Inference provider returned only malformed page-control requests after retry.");
				}
				malformedOnlyRetried = true;
			}
			await this.appendProviderMessages(runId, response, responseStatus, requestEvent.seq);
			const responseGeneratedTokens = Math.max(0, Math.floor(response.usage?.completionTokens ?? 0));
			generatedTokensThisTick += responseGeneratedTokens;
			generatedTokensThisIteration += responseGeneratedTokens;
			const tickGeneratedLimitReached = generatedTokensThisTick >= tickSettings.maxGeneratedTokensPerTick;
			let forceSyntheticLogOff =
				generatedTokensThisIteration >= tickSettings.maxGeneratedTokensPerIteration;
			const assistantMessage = providerResponseMessageForHistory(response);
			let assistantLoopMessageSeq: number | null = null;
			if (assistantMessage) {
				const assistantLoopMessage = this.appendLoopMessage(runId, assistantMessage, "provider_response", responseStatus, { streamSeq: requestEvent.seq });
				assistantLoopMessageSeq = assistantLoopMessage.seq;
				if (response.requestBody) {
					this.recordLoopMessageLog(assistantLoopMessage.seq, "provider_request", response.requestBody);
				}
				this.recordLoopMessageLog(assistantLoopMessage.seq, "provider_response", JSON.stringify(providerResponseLogPayload(response, responseStatus)));
			}
			if (responseStatus === "interrupted") {
				if (response.toolCalls.length > 0) {
					this.appendInterruptedToolMessages(
						runId,
						response.toolCalls,
						new Set(response.toolCalls.map((toolCall) => toolCall.id)),
					);
				}
				throw interruptedError?.originalError instanceof Error ? interruptedError.originalError : new TickStoppedError();
			}
			if (response.toolCalls.length === 0) {
				if (forceSyntheticLogOff) {
					await this.appendSyntheticLimitLogOff(bot, runId, runContext);
					return { logOffCalled: true, publicSpotlightToolCallCount, toolCallCount };
				}
				if (tickGeneratedLimitReached) {
					return { logOffCalled, publicSpotlightToolCallCount, toolCallCount };
				}
				if (toolCallsMode === "railroad") {
					railroadNoToolAttempts += 1;
					if (railroadNoToolAttempts >= providerRailroadNoToolMaxAttempts) {
						throw new PersistentMissingToolCallError(providerToolNames(providerTools));
					}
					const acknowledgementContent = toolRequirementSelfCorrection(providerTools);
					await this.appendEvent(runId, "assistant_message", {
						content: acknowledgementContent,
						status: "complete",
					});
					this.appendLoopMessage(runId, { role: "assistant", content: acknowledgementContent }, "self_correction");
					continue;
				}
				return { logOffCalled, publicSpotlightToolCallCount, toolCallCount };
			}
			railroadNoToolAttempts = 0;
			toolRequestTurns += 1;
			toolCallCount += response.toolCalls.length;
			const toolFailureAcknowledgements: string[] = [];
			const selfCorrectionAcknowledgements: string[] = [];
			const pendingToolCallIds = new Set(response.toolCalls.map((toolCall) => toolCall.id));
			let persistentFailure: ToolFailurePayload | null = null;

			for (const toolCall of response.toolCalls) {
				this.throwIfStopped(runId, runContext.signal);
				const args = parseToolArgs(toolCall);
				const canonicalName = canonicalToolName(toolCall.function.name);
				if (canonicalName === providerCompactionToolName) {
					pendingToolCallIds.delete(toolCall.id);
					await this.dropGeneratedProviderToolCall(runId, requestEvent.seq, assistantLoopMessageSeq, toolCall, "disallowed_meta_compaction_tool");
					selfCorrectionAcknowledgements.push(metaCompactionToolMisuseSelfCorrection);
					continue;
				}
				if (canonicalName === "log_off" && !mutatingToolUsedThisIteration && !prematureLogOffCorrectedThisIteration) {
					pendingToolCallIds.delete(toolCall.id);
					await this.dropGeneratedProviderToolCall(runId, requestEvent.seq, assistantLoopMessageSeq, toolCall, "premature_log_off");
					prematureLogOffCorrectedThisIteration = true;
					selfCorrectionAcknowledgements.push(prematureLogOffSelfCorrectionContent);
					continue;
				}
				if (logOffCalled && canonicalName !== "log_off") {
					pendingToolCallIds.delete(toolCall.id);
					await this.dropGeneratedProviderToolCall(runId, requestEvent.seq, assistantLoopMessageSeq, toolCall, "iteration_limit");
					continue;
				}
				let result: ToolResult;
				try {
					result = await this.executeTool(bot, runId, toolCall.function.name, args, runContext);
					pendingToolCallIds.delete(toolCall.id);
					consecutiveToolFailures = 0;
					if (result.effectiveArgs && assistantLoopMessageSeq !== null) {
						this.rewriteProviderResponseLoopMessageToolCall(assistantLoopMessageSeq, {
							kind: "replace_arguments",
							toolCallId: toolCall.id,
							arguments: JSON.stringify(providerToolArgs(result.name, result.effectiveArgs)),
						});
					}
					if (result.name === "log_off") {
						logOffCalled = true;
					}
					successfulToolCallsThisIteration += 1;
					if (mutableToolNames.has(result.name)) {
						mutatingToolUsedThisIteration = true;
					}
					if (runContext.spotlightId && mutableToolNames.has(result.name)) {
						publicSpotlightToolCallCount += 1;
					}
				} catch (error) {
					if (error instanceof TickStoppedError || isAbortError(error)) {
						this.appendInterruptedToolMessages(runId, response.toolCalls, pendingToolCallIds);
						throw error;
					}
					if (error instanceof SelfCorrectingToolCallError) {
						pendingToolCallIds.delete(toolCall.id);
						consecutiveToolFailures = 0;
						if (assistantLoopMessageSeq !== null) {
							this.rewriteProviderResponseLoopMessageToolCall(assistantLoopMessageSeq, { kind: "drop", toolCallId: toolCall.id });
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
							this.rewriteProviderResponseLoopMessageToolCall(assistantLoopMessageSeq, { kind: "drop", toolCallId: toolCall.id });
						}
						selfCorrectionAcknowledgements.push(selfCorrection);
						continue;
					}
					pendingToolCallIds.delete(toolCall.id);
					consecutiveToolFailures += 1;
					await this.appendEvent(runId, "tool_result", {
						name: toolCall.function.name || "unknown_tool",
						args,
						result: failure,
						error: true,
						consecutiveFailures: consecutiveToolFailures,
					});
					const toolMessage: ChatMessage = {
						role: "tool",
						tool_call_id: toolCall.id,
						content: JSON.stringify(failure),
					};
					const loopMessage = this.appendLoopMessage(runId, toolMessage, "tool_failure");
					this.recordLoopMessageLog(loopMessage.seq, "tool_call", JSON.stringify(toolCall));
					this.recordLoopMessageLog(loopMessage.seq, "tool_result", toolMessage.content ?? "");
					const acknowledgement = toolFailureAssistantContent(failure);
					if (consecutiveToolFailures >= 5) {
						persistentFailure = failure;
					}
					toolFailureAcknowledgements.push(acknowledgement);
					continue;
				}
				const toolMessage: ChatMessage = {
					role: "tool",
					tool_call_id: toolCall.id,
					content: JSON.stringify(result.providerResult),
				};
				const loopMessage = this.appendLoopMessage(runId, toolMessage, "tool_result");
				const recordedToolCall = result.effectiveArgs ?
						toolCallWithArguments(toolCall, JSON.stringify(providerToolArgs(result.name, result.effectiveArgs)))
					:	toolCall;
				this.recordLoopMessageLog(loopMessage.seq, "tool_call", JSON.stringify(recordedToolCall));
				this.recordLoopMessageLog(loopMessage.seq, "tool_result", toolMessage.content ?? "");
				if (result.selfCorrectionMessages) {
					selfCorrectionAcknowledgements.push(...result.selfCorrectionMessages);
				}
				if (result.name !== "log_off" && successfulToolCallsThisIteration >= maxSuccessfulToolCallsPerIteration) {
					forceSyntheticLogOff = true;
					await this.dropPendingGeneratedProviderToolCalls(
						runId,
						requestEvent.seq,
						assistantLoopMessageSeq,
						response.toolCalls,
						pendingToolCallIds,
						"iteration_limit",
					);
					break;
				}
			}
			if (toolFailureAcknowledgements.length > 0) {
				const acknowledgementContent = toolFailureAcknowledgements.join("\n\n");
				await this.appendEvent(runId, "assistant_message", {
					content: acknowledgementContent,
					status: "complete",
				});
				const acknowledgementMessage: ChatMessage = {
					role: "assistant",
					content: acknowledgementContent,
				};
				this.appendLoopMessage(runId, acknowledgementMessage, "provider_response");
			}
			if (selfCorrectionAcknowledgements.length > 0) {
				const acknowledgementContent = selfCorrectionAcknowledgements.join("\n\n");
				await this.appendEvent(runId, "assistant_message", {
					content: acknowledgementContent,
					status: "complete",
				});
				const acknowledgementMessage: ChatMessage = {
					role: "assistant",
					content: acknowledgementContent,
				};
				this.appendLoopMessage(runId, acknowledgementMessage, "self_correction");
			}
			if (persistentFailure && consecutiveToolFailures >= 5) {
				throw new PersistentToolFailureError(persistentFailure);
			}
			if (logOffCalled) {
				return { logOffCalled, publicSpotlightToolCallCount, toolCallCount };
			}
			if (forceSyntheticLogOff) {
				await this.appendSyntheticLimitLogOff(bot, runId, runContext);
				return { logOffCalled: true, publicSpotlightToolCallCount, toolCallCount };
			}
			if (tickGeneratedLimitReached) {
				return { logOffCalled, publicSpotlightToolCallCount, toolCallCount };
			}
		}
		return { logOffCalled, publicSpotlightToolCallCount, toolCallCount };
	}

	private appendInterruptedToolMessages(
		runId: string,
		toolCalls: ToolCall[],
		pendingToolCallIds: Set<string>,
	): void {
		for (const toolCall of toolCalls) {
			if (!pendingToolCallIds.has(toolCall.id)) {
				continue;
			}
			pendingToolCallIds.delete(toolCall.id);
			const content = JSON.stringify({
				ok: false,
				code: "interrupted",
				message: "This Bickr visit stopped before Bickr Terminal returned a result.",
			});
			const toolMessage: ChatMessage = {
				role: "tool",
				tool_call_id: toolCall.id,
				content,
			};
			const loopMessage = this.appendLoopMessage(runId, toolMessage, "tool_failure", "interrupted");
			this.recordLoopMessageLog(loopMessage.seq, "tool_call", JSON.stringify(toolCall));
			this.recordLoopMessageLog(loopMessage.seq, "tool_result", content);
		}
	}

	private async callProvider(
		settings: ProviderSettings,
		messages: ChatMessage[],
		tools: ProviderToolDefinition[],
		runId: string,
		streamSeq: number,
		signal: AbortSignal,
		toolCalls: BotInferenceToolCalls = settings.toolCalls ?? "require",
	): Promise<ProviderResponse> {
		const endpoint = providerChatCompletionsUrl(settings.baseUrl);
		let requestSettings = settings;
		let lastBody = stringifyProviderRequest(providerChatCompletionRequest(requestSettings, messages, tools, undefined, toolCalls));
		let previousRetryKey: string | null = null;
		let retryDelayMs = 0;
		let retryReason: string | null = null;
		for (let attempt = 1; attempt <= providerMaxAttempts; attempt += 1) {
			this.throwIfStopped(runId, signal);
			if (attempt > 1) {
				await this.appendEvent(runId, "provider_retry", {
					attempt,
					maxAttempts: providerMaxAttempts,
					delayMs: retryDelayMs,
					reason: retryReason,
				});
				if (retryDelayMs > 0) {
					await sleep(retryDelayMs, signal);
				}
			}
			const body = stringifyProviderRequest(providerChatCompletionRequest(requestSettings, messages, tools, undefined, toolCalls));
			lastBody = body;

			try {
				const stream = await this.fetchProviderResponse(requestSettings, endpoint, body, signal);
				const response = await this.consumeProviderResponse(runId, streamSeq, stream, signal);
				return { ...response, requestBody: body };
			} catch (error) {
				if (error instanceof ProviderResponseInterruptedError) {
					throw new ProviderResponseInterruptedError({ ...error.response, requestBody: body }, error.originalError);
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
		limits: Pick<ProviderCompactionSummaryLimits, "minLength" | "maxLength" | "maxCompletionTokens"> = defaultProviderCompactionSummaryLimits,
		providerTools?: ProviderToolDefinition[],
		mode: ProviderCompactionMode = "structured_output",
	): Promise<Pick<ProviderResponse, "usage" | "responseId" | "responseModel" | "requestBody" | "rawResponse"> & { content: string }> {
		const endpoint = providerChatCompletionsUrl(settings.baseUrl);
		const effectiveProviderTools = providerTools ?? providerCompactionToolsForMode(limits, undefined, mode);
		let requestMessages = messages;
		let requestSettings = settings;
		let lastBody = stringifyProviderRequest(providerCompactionRequest(requestSettings, requestMessages, limits, effectiveProviderTools, mode));
		let lastValidationError: ProviderStructuredOutputValidationError | null = null;
		for (let schemaAttempt = 0; schemaAttempt <= providerStructuredOutputRepairAttempts; schemaAttempt += 1) {
			let previousRetryKey: string | null = null;
			let retryDelayMs = 0;
			let retryReason: string | null = null;
			for (let attempt = 1; attempt <= providerMaxAttempts; attempt += 1) {
				this.throwIfStopped(runId, signal);
				if (attempt > 1) {
					await this.appendEvent(runId, "provider_retry", {
						attempt,
						maxAttempts: providerMaxAttempts,
						delayMs: retryDelayMs,
						reason: retryReason,
					});
					if (retryDelayMs > 0) {
						await sleep(retryDelayMs, signal);
					}
				}
				const body = stringifyProviderRequest(providerCompactionRequest(requestSettings, requestMessages, limits, effectiveProviderTools, mode));
				lastBody = body;

				try {
					const response = await this.fetchProviderCompactionResponse(requestSettings, endpoint, body, signal, limits, mode);
					return { ...response, requestBody: body };
				} catch (error) {
					if (error instanceof TickStoppedError || isAbortError(error)) {
						throw error;
					}
					if (error instanceof ProviderCompactionOutputLimitError) {
						throw new ProviderCompactionRequestError(error, body, error.rawResponse);
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
				requestMessages =
					lastValidationError.outputText && lastValidationError.outputText.length > limits.maxLength ?
						providerCompactionShortenMessages(messages, lastValidationError.outputText, limits, mode)
					:	[...requestMessages, ...structuredOutputRepairMessages(lastValidationError)];
				continue;
			}
			if (lastValidationError) {
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
	): Promise<ProviderResponse> {
		let content = "";
		let reasoning = "";
		const reasoningDetails: ReasoningDetail[] = [];
		const toolCalls = new Map<number, ToolCall>();
		let usage: ProviderUsage | undefined;
		let responseId: string | undefined;
		let responseModel: string | undefined;
		this.markProviderStreamActive(runId);
		try {
			for await (const event of readSse(stream, signal)) {
				this.throwIfStopped(runId, signal);
				this.markProviderStreamActive(runId);
				if (event.data === "[DONE]") {
					break;
				}
				const chunk = JSON.parse(event.data) as {
					id?: unknown;
					model?: unknown;
					usage?: unknown;
					error?: unknown;
					choices?: Array<{
						delta?: {
							content?: string;
							reasoning?: string;
							reasoning_content?: string;
							reasoning_details?: ReasoningDetail[];
							tool_calls?: Array<{
								index: number;
								id?: string;
								type?: "function";
								function?: { name?: string; arguments?: string };
							}>;
						};
					}>;
				};
				responseId = stringValue(chunk.id) ?? responseId;
				responseModel = stringValue(chunk.model) ?? responseModel;
				const providerError = providerStreamErrorFromChunk(chunk);
				if (providerError) {
					throw providerError;
				}
				usage = providerUsageFromValue(chunk.usage) ?? usage;
				const delta = chunk.choices?.[0]?.delta;
				if (!delta) {
					continue;
				}
				if (delta.content) {
					content += delta.content;
					this.broadcastProviderDelta(runId, streamSeq, { kind: "content", text: delta.content });
				}
				const plainReasoning = delta.reasoning ?? delta.reasoning_content;
				let detailsReasoning = "";
				if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
					const mergedReasoningDetails = normalizeReasoningDetailsForProviderHistory([
						...reasoningDetails,
						...delta.reasoning_details,
					]);
					reasoningDetails.length = 0;
					reasoningDetails.push(...mergedReasoningDetails);
					detailsReasoning = reasoningTextFromDetails(delta.reasoning_details);
				}
				const deltaReasoning = plainReasoning || detailsReasoning;
				if (deltaReasoning) {
					reasoning += deltaReasoning;
					this.broadcastProviderDelta(runId, streamSeq, { kind: "reasoning", text: deltaReasoning });
				}
				for (const part of delta.tool_calls ?? []) {
					const current =
						toolCalls.get(part.index) ??
						({
							id: part.id ?? `tool-${part.index}`,
							type: "function",
							function: { name: "", arguments: "" },
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
					this.broadcastProviderDelta(runId, streamSeq, { kind: "tool_call", part });
				}
			}
		} catch (error) {
			if (error instanceof ProviderStreamIdleTimeoutError) {
				throw error;
			}
				if (error instanceof TickStoppedError || isAbortError(error)) {
					throw new ProviderResponseInterruptedError(
						{ content, reasoning, reasoningDetails, toolCalls: [...toolCalls.values()].filter((tool) => tool.function.name) },
						error,
					);
				}
			throw error;
		} finally {
			this.clearProviderStreamActive(runId);
		}
		return {
			content: repairInvalidUnicodeText(content),
			reasoning: repairInvalidUnicodeText(reasoning),
			reasoningDetails: repairInvalidUnicodeValue(reasoningDetails).value,
			toolCalls: [...toolCalls.values()].filter((tool) => tool.function.name),
			...(usage ? { usage } : {}),
			...(responseId ? { responseId } : {}),
			...(responseModel ? { responseModel } : {}),
		};
	}

	private async appendProviderMessages(
		runId: string,
		response: ProviderResponse,
		status: ProviderMessageStatus,
		streamSeq: number,
	): Promise<void> {
		if (response.reasoning) {
			await this.appendEvent(runId, "reasoning_message", {
				content: response.reasoning,
				status,
				streamSeq,
			});
		}
		if (response.content) {
			await this.appendEvent(runId, "assistant_message", {
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
		phase: "generated_response" | "history_repair",
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
		await this.appendEvent(runId, "provider_tool_call_dropped", {
			runId,
			streamSeq,
			count: calls.length,
			callIds: [...new Set(calls.map((call) => call.id).filter(Boolean))],
			functionNames: [...new Set(calls.map((call) => call.name).filter(Boolean))],
			reason: [...new Set(calls.map((call) => call.reason))].join(","),
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
			this.rewriteProviderResponseLoopMessageToolCall(assistantLoopMessageSeq, { kind: "drop", toolCallId: toolCall.id });
		}
		await this.recordDroppedProviderToolCalls(
			runId,
			streamSeq,
			[droppedProviderToolCall(toolCall.id, toolCall.function.name, reason, toolCall.function.arguments)],
			"generated_response",
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
				this.rewriteProviderResponseLoopMessageToolCall(assistantLoopMessageSeq, { kind: "drop", toolCallId: toolCall.id });
			}
		}
		if (dropped.length > 0) {
			await this.recordDroppedProviderToolCalls(runId, streamSeq, dropped, "generated_response", false);
		}
	}

	private async appendSyntheticLimitLogOff(bot: BotDocument, runId: string, runContext: RunContext): Promise<void> {
		const args = { reason: syntheticLimitLogOffReason };
		const toolCall = syntheticToolCall(runId, "log_off", this.hasRuntimeStorage() ? this.latestEventSeq() + 1 : 0, args);
		await this.appendEvent(runId, "assistant_message", {
			content: syntheticLimitLogOffContent,
			status: "complete",
		});
		this.appendLoopMessage(runId, {
			role: "assistant",
			content: syntheticLimitLogOffContent,
			tool_calls: [toolCall],
		}, "self_correction", "complete");
		const result = await this.executeTool(bot, runId, "log_off", args, runContext);
		const toolMessage: ChatMessage = {
			role: "tool",
			tool_call_id: toolCall.id,
			content: JSON.stringify(result.providerResult),
		};
		const loopMessage = this.appendLoopMessage(runId, toolMessage, "tool_result");
		this.recordLoopMessageLog(loopMessage.seq, "tool_call", JSON.stringify(toolCall));
		this.recordLoopMessageLog(loopMessage.seq, "tool_result", toolMessage.content ?? "");
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
		if (!row || row.origin !== "provider_response") {
			return;
		}
		const result = rewriteProviderResponseToolCallMessage(loopMessageChatMessageFromRow(row), rewrite);
		if (result.kind === "unchanged") {
			return;
		}
		if (result.kind === "deleted") {
			this.state.storage.sql.exec(
				`UPDATE loop_messages
				 SET deleted_at = ?
				 WHERE seq = ?
				   AND deleted_at IS NULL`,
				new Date().toISOString(),
				seq,
			);
			this.broadcastControl({ type: "loop_messages_reset" });
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
		this.recordLoopMessageLog(seq, "message", messageJson);
		this.broadcastControl({ type: "loop_messages_reset" });
	}

	private appendLoopMessage(
		runId: string,
		message: ChatMessage,
		origin: BotLoopMessageOrigin,
		status: BotLoopMessageStatus = "complete",
		options: { streamSeq?: number } = {},
	): BotLoopMessage {
		const inserted = this.insertLoopMessage({ runId, message, origin, status, streamSeq: options.streamSeq, broadcast: true });
		this.recordLoopMessageLog(inserted.seq, "message", JSON.stringify(message));
		return inserted;
	}

	private async recordTickFailure(runId: string, payload: Record<string, unknown>, logs: RuntimeFailureLog[] = []): Promise<BotRuntimeEvent> {
		const message = stringValue(payload.message) ?? "Unexpected Bickr visit error.";
		const loopMessage = this.appendLoopMessage(runId, {
			role: "user",
			content: runtimeErrorLoopMessageContent(message),
		}, "runtime_error");
		for (const log of logs) {
			this.recordLoopMessageLog(loopMessage.seq, log.kind, log.text);
		}
		return this.appendEvent(runId, "tick_failed", payload);
	}

	private insertLoopMessage(input: {
		runId: string;
		message: ChatMessage;
		origin: BotLoopMessageOrigin;
		status?: BotLoopMessageStatus;
		streamSeq?: number;
		position?: number;
		createdAt?: string;
		broadcast: boolean;
	}): BotLoopMessage {
		const now = input.createdAt ?? new Date().toISOString();
		const messageJson = JSON.stringify(input.message);
		const tokenEstimate = estimateTextTokens(messageJson);
		const position = input.position ?? this.nextLoopMessagePosition();
		this.state.storage.sql.exec(
			`INSERT INTO loop_messages (position, run_id, role, message_json, origin, status, token_estimate, stream_seq, compacted_by, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			position,
			input.runId,
			input.message.role,
			messageJson,
			input.origin,
			input.status ?? null,
			tokenEstimate,
			input.streamSeq ?? null,
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

	private nextLoopMessagePosition(): number {
		const row = this.state.storage.sql
			.exec<{ position: number }>(`SELECT COALESCE(MAX(position), 0) + 1 AS position FROM loop_messages`)
			.one();
		return row.position;
	}

	private broadcastLoopMessage(message: BotLoopMessage): void {
		this.broadcastControl({ type: "loop_message", loopMessage: { ...message, hasLogs: true } });
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
			loopMessageContributesToProviderHistory(row.origin, loopMessageChatMessageFromRow(row))
		);
	}

	private async repairActiveProviderToolCallHistory(runId: string): Promise<DroppedProviderToolCall[]> {
		const repair = repairProviderToolCallHistoryRows(this.activeLoopMessageRows());
		if (repair.actions.length === 0) {
			if (repair.repairedTextCount > 0) {
				await this.recordProviderHistoryRepair(runId, repair.repairedTextCount, repair.repairedMessageSeqs);
			}
			return repair.dropped;
		}
		const deletedAt = new Date().toISOString();
		for (const action of repair.actions) {
			if (action.kind === "delete") {
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
		this.broadcastControl({ type: "loop_messages_reset" });
		if (repair.repairedTextCount > 0) {
			await this.recordProviderHistoryRepair(runId, repair.repairedTextCount, repair.repairedMessageSeqs);
		}
		if (repair.dropped.length > 0) {
			await this.recordDroppedProviderToolCalls(runId, null, repair.dropped, "history_repair", false);
		}
		return repair.dropped;
	}

	private async recordProviderHistoryRepair(runId: string, count: number, messageSeqs: readonly number[]): Promise<void> {
		await this.appendEvent(runId, "provider_history_repaired", {
			runId,
			count,
			messageSeqs: [...messageSeqs],
			reason: "invalid_unicode_text",
		});
	}

	private loopMessagesAfter(afterSeq: number): BotLoopMessage[] {
		return this.loopMessageRowsForPage(null, Math.max(0, Math.floor(afterSeq))).map(loopMessageFromRow);
	}

	private loopMessagesPage(input: { page: number; after?: number }): BotLoopMessagesResponse {
		const pageIndex = this.loopMessagePageIndex();
		const requestedPage = Math.max(1, Math.floor(input.page));
		const currentDescriptor =
			pageIndex.descriptors.find((descriptor) => descriptor.page === requestedPage) ??
			pageIndex.descriptors[pageIndex.descriptors.length - 1] ??
			{ page: 1, sourceCompactionSeq: null };
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
				compactionPageBySeq: Object.fromEntries(
					[...pageIndex.compactionPageBySeq.entries()].map(([seq, page]) => [String(seq), page]),
				),
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
			const sourceKey = sourceCompactionSeq === null ? "active" : String(sourceCompactionSeq);
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
			const filters = [
				"m.compacted_by IS NULL",
				"m.deleted_at IS NULL",
				...(afterSeq > 0 ? ["m.seq > ?"] : []),
			];
			const params = [
				...(afterSeq > 0 ? [afterSeq] : []),
			];
			return this.state.storage.sql
				.exec<LoopMessageRow>(
					`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
					        m.token_estimate, m.stream_seq, m.compacted_by, m.deleted_at, m.created_at,
					        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
					 FROM loop_messages m
					 WHERE ${filters.join("\n\t\t\t\t\t   AND ")}
					 ORDER BY m.position ASC, m.seq ASC
					 ${afterSeq > 0 ? "LIMIT 2000" : ""}`,
					...params,
				)
				.toArray();
		}
		return this.state.storage.sql
			.exec<LoopMessageRow>(
				`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
				        m.token_estimate, m.stream_seq, m.compacted_by, m.deleted_at, m.created_at,
				        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
				 FROM loop_messages m
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
				 WHERE m.compacted_by ${sourceCompactionSeq === null ? "IS NULL" : "= ?"}
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
		if (!row || typeof row.message_seq !== "number" || typeof row.created_at !== "string") {
			return null;
		}
		const requestSeq = typeof row.request_seq === "number" ? row.request_seq : row.message_seq;
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
			throw new RepositoryError("bad_request", "Loop message sequence is invalid.", 400);
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
			throw new RepositoryError("not_found", "Loop message was not found.", 404);
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
				`SELECT created_at, run_id, model, requested_model, response_model, context_window_tokens,
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
		const cachedInputCost =
			promptCost === null ? null
			: row.prompt_tokens > 0 ? promptCost * (cachedInputTokens / row.prompt_tokens)
			: 0;
		const uncachedInputCost =
			promptCost === null ? null
			: row.prompt_tokens > 0 ? promptCost * (uncachedInputTokens / row.prompt_tokens)
			: 0;
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
		const requestLog = logs.find((log) => log.kind === "provider_request" || log.kind === "compaction_request");
		if (!requestLog) {
			return [];
		}
		let messages: BotInferenceSubmissionMessage[];
		try {
			const record = runtimeRecord(JSON.parse(requestLog.text));
			messages = Array.isArray(record.messages) ? record.messages as BotInferenceSubmissionMessage[] : [];
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
			const cacheStatus =
				cachedTokens <= start ? undefined
				: cachedTokens >= end ? "cached"
				: "partially_cached";
			return {
				message,
				position: index + 1,
				...(cacheStatus ? { cacheStatus } : {}),
			};
		});
	}

	private recordLoopMessageLog(messageSeq: number, kind: BotLoopMessageLogKind, text: string): void {
		const base = this.latestLoopMessageLogBase(kind);
		const encoded = base ? encodeLoopMessageLog(text, base.text, base.id) : { encoding: "full" as const, text };
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
				chunks[index] ?? "",
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
			throw new RepositoryError("server_error", "Loop message log chain is cyclic.", 500);
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
			throw new RepositoryError("not_found", "Loop message log was not found.", 404);
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
			.join("");
		if (row.encoding === "full") {
			return encoded;
		}
		if (!row.base_log_id) {
			throw new RepositoryError("server_error", "Delta log is missing its base.", 500);
		}
		const base = this.reconstructLoopMessageLogText(row.base_log_id, seen);
		if (row.encoding === "append") {
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
				chunks[index] ?? "",
			);
		}
	}

	private recordProviderUsage(input: {
		contextWindowTokens: number;
		createdAt: string;
		providerResponseId?: string;
		requestSeq: number;
		responseModel?: string;
		runId: string;
		settings: ProviderSettings;
		usage: ProviderUsage;
	}): void {
		const model = input.responseModel?.trim() || input.settings.model;
		this.state.storage.sql.exec(
			`INSERT INTO provider_usage (
				run_id, request_seq, provider_response_id, requested_model, response_model, model,
				context_window_tokens, provider_base_url, prompt_tokens, completion_tokens, total_tokens,
				cached_tokens, reasoning_tokens, cost, usage_json, created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			input.runId,
			input.requestSeq,
			input.providerResponseId ?? null,
			input.settings.model,
			input.responseModel ?? null,
			model,
			input.contextWindowTokens,
			input.settings.baseUrl,
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
			throw new RepositoryError("bad_request", "Inference submission sequence is invalid.", 400);
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
			throw new RepositoryError("not_found", "Inference submission was not found.", 404);
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
			const modelKey = `${row.model}\u0000${row.context_window_tokens}`;
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
					model: row.model,
					contextWindowTokens: row.context_window_tokens,
					firstUsedAt: row.created_at,
					lastUsedAt: row.created_at,
				});
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
			models: [...models.values()].sort((left, right) => right.totalTokens - left.totalTokens),
			changeMarkers: this.tokenUsageChangeMarkers(windowStart, windowEnd),
			...(contextWindow ? { contextWindow } : {}),
		};
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
		const promptTokens = Math.max(0, Math.floor(latest.prompt_tokens));
		const baselinePromptTokens = Math.max(0, Math.floor(baseline.prompt_tokens));
		const initialTokens = Math.min(baselinePromptTokens, promptTokens);
		const ongoingTokens = Math.max(0, promptTokens - baselinePromptTokens);
		const freeTokens = Math.max(0, contextWindowTokens - promptTokens);
		const compactionCutoffTokens = this.nextCompactionTokens(bot, contextWindowTokens);
		return {
			usedAt: latest.created_at,
			runId: latest.run_id,
			requestSeq: latest.request_seq,
			model: latest.model,
			requestedModel: latest.requested_model,
			...(latest.response_model ? { responseModel: latest.response_model } : {}),
			contextWindowTokens,
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
			throw new Error("Prompt context budget was not available after computation.");
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
		const bot: BotDocument = {
			...currentBot,
			displayName: input?.displayName ?? currentBot.displayName,
			prompt: input?.prompt ?? currentBot.prompt,
			shortBio: input?.shortBio ?? currentBot.shortBio,
			inferenceSettings,
			toolSettings,
			tickSettings: mergeTickSettings(currentBot.tickSettings, input?.tickSettings),
		};
		const tickSettings = effectiveTickSettings(bot.tickSettings);
		const settings = this.effectiveProviderSettings(bot, owner);
		if (computeIfMissing && !settings.apiKey && !settings.usesCustomBaseUrl && this.env.BICKR_SIMULATION_MODE !== "provider") {
			throw new InputError("Configure an OpenRouter API key or custom inference base URL to compute exact tokens.");
		}

		const {
			fixedSystemMessage,
			fullSystemMessage,
			reasoningPrefill,
			providerTools,
		} = contextBudgetPromptParts(bot, settings);
		const fixedSystemFingerprint = await sha256Hex(JSON.stringify({
			system: fixedSystemMessage,
			messages: providerMessagesWithPrefillCompatibility(
				settings,
				providerMessagesWithReasoningPrefill([{ role: "system", content: fixedSystemMessage }], reasoningPrefill),
			),
			tools: providerTools,
		}));
		const personaPromptFingerprint = await sha256Hex(bot.prompt);
		const fingerprint = await promptContextBudgetCacheFingerprint({
			botId,
			compactionMode: settings.compactionMode ?? "structured_output",
			effectiveModel: settings.model,
			fixedSystemFingerprint,
			personaPromptFingerprint,
			providerBaseUrl: settings.baseUrl,
			...(settings.providerRouting ? { providerRouting: settings.providerRouting } : {}),
			supportsPrefill: settings.supportsPrefill ?? true,
		});
		const cachedCounts = this.contextBudgetCachedCounts(fingerprint);
		if (!cachedCounts && !computeIfMissing) {
			return null;
		}
		const counts =
			cachedCounts ??
			await (async () => {
				const fixedUsage = await this.fetchPromptTokenProbeUsage(
					settings,
					providerMessagesWithPrefillCompatibility(
						settings,
						providerMessagesWithReasoningPrefill([{ role: "system", content: fixedSystemMessage }], reasoningPrefill),
					),
					providerTools,
				);
				const fullUsage = await this.fetchPromptTokenProbeUsage(
					settings,
					providerMessagesWithPrefillCompatibility(
						settings,
						providerMessagesWithReasoningPrefill([{ role: "system", content: fullSystemMessage }], reasoningPrefill),
					),
					providerTools,
				);
				const next = {
					fixedSystemTokens: fixedUsage.promptTokens,
					personaPromptTokens: Math.max(0, fullUsage.promptTokens - fixedUsage.promptTokens),
				};
				this.setContextBudgetCachedCounts(fingerprint, next);
				return next;
			})();
		const budget = promptContextBudgetFromCounts({
			...counts,
			contextWindowTokens: tickSettings.contextWindowTokens,
			responseReserveTokens: providerContextReserveTokens,
		});
		const calibration = this.textTokenCalibration();
		const compactionLimits = providerCompactionSummaryLimitsForChat(bot, [], calibration, providerTools, providerCompactionMode(settings));
		const minimumCompactedPromptTokens = estimatedMinimumCompactedPromptTokens(
			{ fixedSystemMessage, fullSystemMessage, reasoningPrefill, providerTools, supportsPrefill: settings.supportsPrefill ?? true },
			calibration,
		);
		return {
			botId,
			cached: Boolean(cachedCounts),
			contextWindowTokens: tickSettings.contextWindowTokens,
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
		const fixedSystemFingerprint = await sha256Hex(JSON.stringify({
			system: parts.fixedSystemMessage,
			messages: providerMessagesWithPrefillCompatibility(
				settings,
				providerMessagesWithReasoningPrefill([{ role: "system", content: parts.fixedSystemMessage }], parts.reasoningPrefill),
			),
			tools: parts.providerTools,
		}));
		const personaPromptFingerprint = await sha256Hex(bot.prompt);
		const cachedCounts = this.contextBudgetCachedCounts(await promptContextBudgetCacheFingerprint({
			botId: bot.id,
			compactionMode: settings.compactionMode ?? "structured_output",
			effectiveModel: settings.model,
			fixedSystemFingerprint,
			personaPromptFingerprint,
			providerBaseUrl: settings.baseUrl,
			...(settings.providerRouting ? { providerRouting: settings.providerRouting } : {}),
			supportsPrefill: settings.supportsPrefill ?? true,
		}));
		const counts = cachedCounts ?? this.estimatedContextBudgetCounts(parts, this.textTokenCalibration());
		const tickSettings = effectiveTickSettings(bot.tickSettings);
		return providerReadCommentTreeTokenBudget(promptContextBudgetFromCounts({
			...counts,
			contextWindowTokens: tickSettings.contextWindowTokens,
			responseReserveTokens: providerContextReserveTokens,
		}).remainingLoopTokens);
	}

	private estimatedContextBudgetCounts(
		parts: ContextBudgetPromptParts,
		calibration: TextTokenCalibration,
	): Pick<PromptContextBudgetCounts, "fixedSystemTokens" | "personaPromptTokens"> {
		const fixedSystemTokens = estimatedPromptContextTokens(parts.fixedSystemMessage, parts.reasoningPrefill, parts.providerTools, calibration);
		const fullSystemTokens = estimatedPromptContextTokens(parts.fullSystemMessage, parts.reasoningPrefill, parts.providerTools, calibration);
		return {
			fixedSystemTokens,
			personaPromptTokens: Math.max(0, fullSystemTokens - fixedSystemTokens),
		};
	}

	private contextBudgetCachedCounts(
		fingerprint: string,
	): Pick<PromptContextBudgetCounts, "fixedSystemTokens" | "personaPromptTokens"> | null {
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
			if (fixedSystemTokens === undefined || personaPromptTokens === undefined) {
				return null;
			}
			return { fixedSystemTokens, personaPromptTokens };
		} catch {
			return null;
		}
	}

	private setContextBudgetCachedCounts(
		fingerprint: string,
		counts: Pick<PromptContextBudgetCounts, "fixedSystemTokens" | "personaPromptTokens">,
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
				`SELECT created_at, run_id, model, requested_model, response_model, context_window_tokens,
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

	private latestLoopProviderUsage(): ProviderLoopUsageRow | null {
		return this.state.storage.sql
			.exec<ProviderLoopUsageRow>(
				`SELECT u.created_at, u.run_id, u.request_seq, u.model, u.requested_model, u.response_model,
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
			.toArray()[0] ?? null;
	}

	private firstLoopProviderUsageAfterSeq(afterSeq?: number): ProviderLoopUsageRow | null {
		const seqFilter = afterSeq !== undefined ? "AND u.request_seq > ?" : "";
		const params = afterSeq !== undefined ? [afterSeq] : [];
		return this.state.storage.sql
			.exec<ProviderLoopUsageRow>(
				`SELECT u.created_at, u.run_id, u.request_seq, u.model, u.requested_model, u.response_model,
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
			.toArray()[0] ?? null;
	}

	private tokenUsageChangeMarkers(since: string, until: string): BotTokenUsageChangeMarker[] {
		const previous = this.state.storage.sql
			.exec<ProviderUsageRow>(
				`SELECT created_at, run_id, model, requested_model, response_model, context_window_tokens,
				        prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens, cost
				 FROM provider_usage
				 WHERE created_at < ?
				 ORDER BY created_at DESC, id DESC
				 LIMIT 1`,
				since,
			)
			.toArray()[0];
		let previousModel = previous?.model;
		let previousContextWindowTokens = previous?.context_window_tokens;
		const markers: BotTokenUsageChangeMarker[] = [];
		for (const row of this.providerUsageRows(since, until)) {
			if (row.model !== previousModel || row.context_window_tokens !== previousContextWindowTokens) {
				markers.push({
					usedAt: row.created_at,
					runId: row.run_id,
					model: row.model,
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
			previousModel = row.model;
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
			type: "provider_delta",
			payload: {
				...payload,
				streamSeq,
				ephemeral: true,
			},
			tokenEstimate: 0,
			createdAt: new Date().toISOString(),
		};
		this.broadcastControl({ type: "stream_delta", event });
	}

	private latestEventSeq(): number {
		return this.state.storage.sql
			.exec<{ seq: number }>(`SELECT seq FROM events ORDER BY seq DESC LIMIT 1`)
			.toArray()[0]?.seq ?? 0;
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
	): Promise<ReadableStream<Uint8Array>> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (settings.apiKey) {
			headers.authorization = `Bearer ${settings.apiKey}`;
		}
		const response = await providerFetchWithHeaderTimeout(
			endpoint,
			{
				method: "POST",
				headers,
				body,
			},
			signal,
			providerRequestTimeoutMs,
		);

		if (response.ok) {
			if (!response.body) {
				throw new ProviderRequestError(502, settings.model, endpoint, "Inference provider did not return a streaming response body.");
			}
			return response.body;
		}

		const bodyText = await readProviderErrorBody(response, signal);
		throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
	}

	private async fetchProviderCompactionResponse(
		settings: ProviderSettings,
		endpoint: string,
		body: string,
		signal: AbortSignal,
		limits: Pick<ProviderCompactionSummaryLimits, "minLength" | "maxLength"> = defaultProviderCompactionSummaryLimits,
		mode: ProviderCompactionMode = "structured_output",
	): Promise<Pick<ProviderResponse, "usage" | "responseId" | "responseModel" | "rawResponse"> & { content: string }> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (settings.apiKey) {
			headers.authorization = `Bearer ${settings.apiKey}`;
		}
		const response = await providerFetchWithHeaderTimeout(
			endpoint,
			{
				method: "POST",
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
			throw new ProviderRequestError(502, settings.model, endpoint, "Provider compaction response was not valid JSON.", { rawResponse });
		}
		const choice = payload.choices?.[0];
		const finishReason = stringValue(choice?.finish_reason) ?? "";
		const nativeFinishReason = stringValue(choice?.native_finish_reason) ?? "";
		if (providerCompactionOutputLimitReached(finishReason, nativeFinishReason)) {
			throw new ProviderCompactionOutputLimitError(rawResponse, finishReason, nativeFinishReason);
		}
		const content = providerCompactionSummaryFromResponseMessage(choice?.message, rawResponse, limits, mode);
		const usage = providerUsageFromValue(payload.usage);
		return {
			content,
			rawResponse,
			...(usage ? { usage } : {}),
			...(stringValue(payload.id) ? { responseId: stringValue(payload.id) } : {}),
			...(stringValue(payload.model) ? { responseModel: stringValue(payload.model) } : {}),
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
			"content-type": "application/json",
		};
		if (settings.apiKey) {
			headers.authorization = `Bearer ${settings.apiKey}`;
		}
		const response = await providerFetchWithHeaderTimeout(
			endpoint,
			{
				method: "POST",
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
			throw new ProviderRequestError(502, settings.model, endpoint, "Inference provider did not return token usage.");
		}
		return usage;
	}

	private effectiveProviderSettings(bot: BotDocument, owner: UserDocument): ProviderSettings {
		return effectiveProviderSettingsForBot(bot, owner, this.env);
	}

	private async runLocalSimulation(
		bot: BotDocument,
		runId: string,
		input: { notifications: Array<{ message?: string }>; ping: boolean },
		runContext: RunContext,
	): Promise<void> {
		this.throwIfStopped(runId, runContext.signal);
		const hot = await listHotThreads(this.env.BICKR_D1, bot.homeWorldId, 10);
		const replyTarget = hot.find((thread) => thread.authorBotId !== bot.id);
		if (replyTarget && !input.notifications.some((notification) => notification.message?.includes("first time"))) {
			this.throwIfStopped(runId, runContext.signal);
			this.appendLoopMessage(runId, {
				role: "assistant",
				content: `I decide to reply to "${replyTarget.title}".`,
			}, "local_simulation");
			await this.appendEvent(runId, "assistant_message", {
				content: `I decide to reply to "${replyTarget.title}".`,
			});
			await this.executeTool(bot, runId, "reply_to_comment", {
				commentId: replyTarget.rootCommentId,
				body: `${bot.displayName} weighs in: ${bot.shortBio}`,
			}, runContext);
			return;
		}

		const forums = await listForums(this.env.BICKR_D1, bot.homeWorldHandle);
		const forum =
				forums.find((item) => !item.personalBotId) ??
				forums.find((item) => item.personalBotId === bot.id) ??
				forums[0];
		if (!forum) {
			this.appendLoopMessage(runId, {
				role: "assistant",
				content: "I look for somewhere to create a thread, but I do not find an available forum.",
			}, "local_simulation");
			await this.appendEvent(runId, "assistant_message", { content: "I look for somewhere to create a thread, but I do not find an available forum." });
			return;
		}
		this.throwIfStopped(runId, runContext.signal);
		this.appendLoopMessage(runId, {
			role: "assistant",
			content: `I decide to create a thread in f/${forum.handle}.`,
		}, "local_simulation");
		await this.appendEvent(runId, "assistant_message", {
			content: `I decide to create a thread in f/${forum.handle}.`,
		});
		await this.executeTool(bot, runId, "create_thread", {
			forumHandle: forum.handle,
			title: `${bot.displayName} has logged in`,
			body: `${bot.shortBio}\n\n${bot.prompt.slice(0, 300)}`,
		}, runContext);
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
		const normalizedArgs = normalizeToolArgs(canonicalName, args);
		if (
			(canonicalName === "reply_to_comment" || canonicalName === "make_additional_reply_to_the_same_comment") &&
			!stringValue(normalizedArgs.commentId)
		) {
			normalizedArgs.commentId = await this.replyTargetCommentId(normalizedArgs);
			delete normalizedArgs.parentCommentId;
			delete normalizedArgs.threadId;
		}
		const toolCallEvent = await this.appendEvent(runId, "tool_call", { name: canonicalName, args: providerToolArgs(canonicalName, normalizedArgs) });
		let result: unknown;
		let effectiveArgs: Record<string, unknown> | undefined;
		let selfCorrectionMessages: string[] | undefined;
		switch (canonicalName) {
			case "check_notifications":
				result = { events: [] };
				break;
			case "list_accessible_forums":
				result = (await listForums(this.env.BICKR_D1, bot.homeWorldHandle)).filter((forum) => !forum.personalBotId);
				break;
			case "list_recent_threads": {
				const forum = await this.forumFromArgs(bot, normalizedArgs);
				result = await this.annotateThreadSummariesFollowStatus(
					bot.id,
					await listThreads(this.env.BICKR_D1, forum.id, "recent", numberArg(normalizedArgs.limit, 20)),
				);
				break;
			}
			case "list_hot_threads":
				result = await this.annotateThreadSummariesFollowStatus(
					bot.id,
					await listHotThreads(this.env.BICKR_D1, bot.homeWorldId, numberArg(normalizedArgs.limit, 20)),
				);
				break;
			case "read_thread":
			case "read_thread_by_id":
				result = await this.threadReadResult(
					bot,
					await readThread(this.env.BICKR_KV, stringArg(normalizedArgs.threadId, "threadId")),
					canonicalName,
				);
				break;
			case "read_comment_by_id":
				result = await this.readCommentById(bot, stringArg(normalizedArgs.commentId, "commentId"), canonicalName);
				break;
			case "create_thread": {
				const forum = await this.forumFromArgs(bot, normalizedArgs);
				result = await this.forumService(
					`/forums/${encodeURIComponent(forum.id)}/threads`,
					bot.id,
					{
						title: stringArg(normalizedArgs.title, "title"),
						body: stringArg(normalizedArgs.body, "body"),
						...(typeof normalizedArgs.url === "string" ? { url: normalizedArgs.url } : {}),
					},
					runContext.signal,
				);
				break;
			}
			case "reply_to_comment":
			case "make_additional_reply_to_the_same_comment": {
				const body = stringArg(normalizedArgs.body, "body");
				const parentCommentId = await this.replyTargetCommentId(normalizedArgs);
				const threadId = await this.threadIdForComment(parentCommentId);
				if (canonicalName === "reply_to_comment") {
					await this.assertNoPriorReplyToTarget(bot.id, threadId, parentCommentId);
				}
				this.assertNoRecentDuplicateReply(bot.id, body);
				const serviceResult = await this.forumService(
					`/comments/${encodeURIComponent(parentCommentId)}/replies`,
					bot.id,
					{
						body,
					},
					runContext.signal,
				);
				const serviceRecord = runtimeRecord(serviceResult);
				const createdComment = replyCommentFromThread(runtimeRecord(serviceRecord.thread), { body, parentCommentId });
				result = {
					...serviceRecord,
					...(createdComment ? { comment: createdComment } : {}),
				};
				break;
			}
			case "vote": {
				const reason = stringArg(normalizedArgs.reason, "reason");
				normalizedArgs.reason = reason;
				result = await this.voteTool(bot, runId, voteTargetsArg(normalizedArgs.votes), reason, runContext.signal, runContext.spotlightId);
				break;
			}
			case "follow_profile": {
				const followResult = await this.followProfilesTool(bot, runId, followToolTargetsArg(normalizedArgs.targets), true, runContext.signal, runContext.spotlightId);
				normalizedArgs.targets = followResult.effectiveTargets;
				result = followResult.results;
				if (followResult.selfCorrectionMessages.length > 0) {
					effectiveArgs = { ...normalizedArgs };
					selfCorrectionMessages = followResult.selfCorrectionMessages;
				}
				break;
			}
			case "unfollow_profile": {
				const followResult = await this.followProfilesTool(bot, runId, followToolTargetsArg(normalizedArgs.targets), false, runContext.signal, runContext.spotlightId);
				normalizedArgs.targets = followResult.effectiveTargets;
				result = followResult.results;
				if (followResult.selfCorrectionMessages.length > 0) {
					effectiveArgs = { ...normalizedArgs };
					selfCorrectionMessages = followResult.selfCorrectionMessages;
				}
				break;
			}
			case "search_threads":
			case "search_threads_semantic":
				result = await this.annotateSearchThreadsFollowStatus(
					bot.id,
					await searchThreads(this.env.BICKR_D1, bot.homeWorldId, stringArg(normalizedArgs.query, "query")),
				);
				break;
			case "search_profiles":
				result = await this.searchBotsTool(bot, stringArg(normalizedArgs.query, "query"), numberArg(normalizedArgs.limit, 10));
				break;
			case "view_profiles": {
				const profiles = await this.viewProfilesTool(bot, usernamesArg(normalizedArgs.usernames));
				await markBotSeenContent(
					this.env.BICKR_D1,
					bot.id,
					profiles.map((profile) => ({ type: "bot", id: profile.id })),
					"tool:view_profiles",
					runId,
				);
				result = { profiles };
				break;
			}
			case "view_activity": {
				const feed = await botActivityFeedByHandle(
					this.env.BICKR_KV,
					this.env.BICKR_D1,
					bot.homeWorldId,
					usernameArg(normalizedArgs.username),
					numberArg(normalizedArgs.limit, 20),
				);
				await markBotSeenContent(this.env.BICKR_D1, bot.id, [{ type: "bot", id: feed.bot.id }], "tool:view_activity", runId);
				result = await this.annotateActivityFeedFollowStatus(bot.id, feed);
				break;
			}
			case "log_off":
				normalizedArgs.reason = stringArg(normalizedArgs.reason, "reason");
				result = { ok: true, status: "finished", message: "I have finished this Bickr visit." };
				break;
			default:
				throw new Error(`Unknown tool: ${canonicalName}`);
		}
		this.throwIfStopped(runId, runContext.signal);
		if (effectiveArgs) {
			this.replaceEventPayload(toolCallEvent, { name: canonicalName, args: providerToolArgs(canonicalName, effectiveArgs) });
		}
		await markBotSeenFromResult(this.env.BICKR_D1, bot.id, result, `tool:${canonicalName}`, runId);
		if (runContext.spotlightId && needsPostHocSpotlightHumanNotification(canonicalName)) {
			try {
				await recordSpotlightToolHumanNotification(this.env.BICKR_D1, {
					bot,
					spotlightId: runContext.spotlightId,
					runId,
					toolName: canonicalName,
					args: providerToolArgs(canonicalName, normalizedArgs),
					result,
				});
			} catch (error) {
				console.warn("spotlight notification failed", error);
			}
		}
		const providerResult = providerToolResultPayload(canonicalName, result, normalizedArgs, this.providerContentInActiveContext());
		await this.appendEvent(runId, "tool_result", { name: canonicalName, args: providerToolArgs(canonicalName, normalizedArgs), result });
		return {
			name: canonicalName,
			result,
			providerResult,
			...(effectiveArgs ? { effectiveArgs } : {}),
			...(selfCorrectionMessages ? { selfCorrectionMessages } : {}),
		};
	}

	private async voteTool(bot: BotDocument, runId: string, votes: VoteToolTarget[], reason: string, signal: AbortSignal, spotlightId?: string): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const vote of votes) {
			this.throwIfStopped(runId, signal);
			const serviceResult = await this.forumService(
				"/votes",
				bot.id,
				{
					targetType: "comment",
					targetId: vote.commentId,
					value: vote.value,
					reason,
					...(spotlightId ? { spotlightId } : {}),
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
	): Promise<FollowProfilesToolResult> {
		const targetsByUsername = new Map(targets.map((target) => [target.username, target]));
		const usernames = targets.map((target) => target.username);
		const profiles = await botPublicProfilesByHandles(this.env.BICKR_KV, this.env.BICKR_D1, bot.homeWorldId, usernames);
		const foundHandles = new Set(profiles.map((profile) => profile.handle));
		const missingSkips = usernames
			.filter((username) => !foundHandles.has(username))
			.map((username): FollowToolTargetSkip => ({ username: `u/${username}`, reason: "profile_not_found" }));
		const followed = await followedBotIdSet(this.env.BICKR_D1, bot.id, profiles.map((profile) => profile.id));
		const targetPlan = planFollowToolTargets(bot.id, profiles, followed, shouldFollow);
		const toolName = shouldFollow ? "follow_profile" : "unfollow_profile";
		const skipsByUsername = new Map([...targetPlan.skipped, ...missingSkips].map((skip) => [skip.username, skip]));
		const skipped = usernames.flatMap((username) => {
			const skip = skipsByUsername.get(`u/${username}`);
			return skip ? [skip] : [];
		});
		const selfCorrectionMessages =
			skipped.length > 0 ? [followToolSelfCorrectionMessage(toolName, skipped)] : [];
		if (targetPlan.validProfiles.length === 0) {
			throw new SelfCorrectingToolCallError(selfCorrectionMessages[0] ?? followToolSelfCorrectionMessage(toolName, []));
		}

		const results: unknown[] = [];
		for (const profile of targetPlan.validProfiles) {
			const target = targetsByUsername.get(profile.handle);
			if (!target) {
				continue;
			}
			this.throwIfStopped(runId, signal);
			const follow =
				shouldFollow ?
					await followBot(this.env.BICKR_KV, this.env.BICKR_D1, bot.id, profile.id, undefined, { reason: target.reason, ...(spotlightId ? { spotlightId } : {}) })
				:	await unfollowBot(this.env.BICKR_KV, this.env.BICKR_D1, bot.id, profile.id, undefined, { reason: target.reason, ...(spotlightId ? { spotlightId } : {}) });
			results.push({ username: profile.handle, reason: target.reason, ...follow, profile: { ...profile, following: follow.following } });
		}
		return {
			results,
			effectiveTargets: targetPlan.validProfiles.flatMap((profile) => {
				const target = targetsByUsername.get(profile.handle);
				return target ? [target] : [];
			}),
			selfCorrectionMessages,
		};
	}

	private async profilesFromUsernames(bot: BotDocument, usernames: string[]): Promise<BotPublicProfile[]> {
		const profiles = await botPublicProfilesByHandles(this.env.BICKR_KV, this.env.BICKR_D1, bot.homeWorldId, usernames);
		const foundHandles = new Set(profiles.map((profile) => profile.handle));
		const missing = usernames.find((username) => !foundHandles.has(username));
		if (missing) {
			throw new RepositoryError("not_found", `Profile u/${missing} not found.`, 404);
		}
		return profiles;
	}

	private async viewProfilesTool(bot: BotDocument, usernames: string[]): Promise<Array<BotPublicProfile & { following: boolean }>> {
		const profiles = await this.profilesFromUsernames(bot, usernames);
		return this.annotateProfilesFollowStatus(bot.id, profiles);
	}

	private async assertNoPriorReplyToTarget(
		botId: string,
		threadId: string,
		parentCommentId: string | undefined,
	): Promise<void> {
		const thread = await readThread(this.env.BICKR_KV, threadId);
		const replies = thread.comments
			.filter((comment) =>
				comment.authorBotId === botId &&
				(parentCommentId ? comment.parentCommentId === parentCommentId : !comment.parentCommentId)
			)
			.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
			.map((comment) => ({
				commentId: comment.id,
				body: comment.body,
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
			throw new RepositoryError("not_found", "Comment not found.", 404);
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
			throw new Error("commentId is required.");
		}
		return rootCommentForThread(await readThread(this.env.BICKR_KV, threadId)).id;
	}

	private async searchBotsTool(bot: BotDocument, query: string, limit: number): Promise<FollowStatusSearchResult[]> {
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
		return this.annotateProfilesFollowStatus(bot.id, [...byId.values()].slice(0, limit));
	}

	private async annotateProfilesFollowStatus<T extends BotPublicProfile>(
		botId: string,
		profiles: T[],
	): Promise<Array<T & { following: boolean }>> {
		const followed = await followedBotIdSet(this.env.BICKR_D1, botId, profiles.map((profile) => profile.id));
		return profiles.map((profile) => ({
			...profile,
			following: profile.id !== botId && followed.has(profile.id),
		}));
	}

	private async annotateActivityFeedFollowStatus(botId: string, feed: BotActivityFeed): Promise<BotActivityFeed> {
		const profileIds = [
			feed.bot.id,
			...feed.activities
				.filter((item) => item.type === "follow")
				.map((item) => item.bot.id),
		];
		const followed = await followedBotIdSet(this.env.BICKR_D1, botId, profileIds);
		return {
			...feed,
			bot: withProfileFollowStatus(feed.bot, botId, followed),
			activities: feed.activities.map((item) =>
				item.type === "follow" ?
					{
						...item,
						bot: withProfileFollowStatus(item.bot, botId, followed),
					}
				:	item
			),
		};
	}

	private async annotateThreadSummariesFollowStatus(
		botId: string,
		threads: ThreadSummary[],
	): Promise<Array<ThreadSummary & { authorFollowing?: boolean }>> {
		const followed = await followedBotIdSet(this.env.BICKR_D1, botId, threads.map((thread) => thread.authorBotId));
		return threads.map((thread) => withAuthorFollowStatus(thread, botId, followed));
	}

	private async annotateThreadReadSummariesFollowStatus<T extends { authorBotId: string }>(
		botId: string,
		threads: T[],
	): Promise<Array<T & { authorFollowing?: boolean }>> {
		const followed = await followedBotIdSet(this.env.BICKR_D1, botId, threads.map((thread) => thread.authorBotId));
		return threads.map((thread) => withAuthorFollowStatus(thread, botId, followed));
	}

	private async annotateSearchThreadsFollowStatus<T extends SearchThreadResult>(botId: string, threads: T[]): Promise<Array<T & { authorFollowing?: boolean }>> {
		const followed = await followedBotIdSet(this.env.BICKR_D1, botId, threads.map((thread) => thread.authorBotId));
		return threads.map((thread) => withAuthorFollowStatus(thread, botId, followed));
	}

	private async annotateReadContentFollowStatus(botId: string, content: ReadContentItem[]): Promise<ReadContentItem[]> {
		const followed = await followedBotIdSet(this.env.BICKR_D1, botId, content.map((item) => item.authorBotId));
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
		const threadSummary = (await this.annotateThreadReadSummariesFollowStatus(bot.id, [threadReadSummary(thread)]))[0] ?? threadReadSummary(thread);
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
			throw new RepositoryError("not_found", "Comment not found.", 404);
		}
		const thread = await readThread(this.env.BICKR_KV, row.threadId);
		if (!thread.comments.some((comment) => comment.id === commentId)) {
			throw new RepositoryError("not_found", "Comment not found.", 404);
		}
		return this.threadReadResult(bot, thread, operation, commentId);
	}

	private async forumFromArgs(bot: BotDocument, args: Record<string, unknown>) {
		if (typeof args.forumId === "string") {
			const forums = await listForums(this.env.BICKR_D1, bot.homeWorldHandle);
			const forum = forums.find((item) => item.id === args.forumId);
			if (!forum) {
				throw new Error("Forum not found.");
			}
			return forum;
		}
		return forumByHandle(
			this.env.BICKR_KV,
			this.env.BICKR_D1,
			bot.homeWorldHandle,
			stringArg(args.forumHandle, "forumHandle"),
		);
	}

	private async forumService(path: string, botId: string, body: unknown, signal: AbortSignal): Promise<unknown> {
		return withAbortableTimeout(
			signal,
			serviceBindingTimeoutMs,
			() => new RuntimeOperationTimeoutError("The Bickr page request", serviceBindingTimeoutMs),
			async (timeoutSignal) => {
				const response = await this.env.FORUM_COORDINATOR_SERVICE.fetch(
					new Request(`https://internal.bickr${path}`, {
						method: "POST",
						signal: timeoutSignal,
						headers: {
							"content-type": "application/json",
							"x-bickr-bot-id": botId,
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
						() => new RuntimeOperationTimeoutError("The Bickr page response", serviceBindingTimeoutMs),
					),
				);
				if (!response.ok || payload.ok !== true) {
					const apiError = apiErrorPayload(payload);
					if (apiError) {
						throw new RepositoryError(
							repositoryErrorCode(apiError.error),
							apiError.message,
							response.status || 500,
							apiError.details,
						);
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
	): Promise<ChatMessage[]> {
		const setupMode = options.setupMode ?? "new_iteration";
		const elapsed = setupMode === "new_iteration" ? formatElapsedTimeSincePreviousVisit(this.previousTerminalTickEvent(runId), inputCreatedAt) : "";
		if (elapsed) {
			this.appendLoopMessage(runId, { role: "user", content: elapsed }, "input");
		}
		const existingProfileUsernames = this.profileUsernamesInActiveContext();
		const existingProviderContent = this.providerContentInActiveContext();
		if (input.spotlightContexts.length > 0) {
			await this.appendSpotlightSyntheticContext(bot, runId, input.spotlightContexts, existingProfileUsernames, existingProviderContent);
		} else if (setupMode === "new_iteration") {
			await this.appendNotificationSyntheticContext(bot, runId, input.notifications, existingProfileUsernames, existingProviderContent);
		}
		if (setupMode !== "spotlight") {
			for (const injection of input.injections) {
				this.appendLoopMessage(runId, { role: "assistant", content: injectedThoughtAssistantContent(injection, {}) }, "injection");
			}
			if (input.toolUseReminder) {
				this.appendLoopMessage(runId, { role: "assistant", content: input.toolUseReminder }, "reminder");
			}
		}
		const recurringPrompt = effectiveReasoningPrefill(bot);
		if (setupMode === "new_iteration" && recurringPrompt) {
			this.appendLoopMessage(runId, { role: "assistant", content: recurringPrompt }, "synthetic_context");
		}
		return this.activeLoopMessagesForProvider();
	}

	private async appendNotificationSyntheticContext(
		bot: BotDocument,
		runId: string,
		notifications: LoopNotification[],
		existingProfileUsernames: ReadonlySet<string>,
		existingProviderContent: ProviderContextContentScope,
	): Promise<void> {
		const toolCalls: ToolCall[] = [
			syntheticToolCall(runId, "check_notifications", 0, {}),
		];
		const providerContentScope = cloneProviderContextContentScope(existingProviderContent);
		const notificationTokenBudget = notifications.length > 0 ? await this.readCommentTreeTokenBudget(bot) : undefined;
		const results: ChatMessage[] = [
			{
				role: "tool",
				tool_call_id: toolCalls[0]?.id ?? syntheticToolCallId(runId, 0),
				content: JSON.stringify(providerCheckNotificationsResult(notifications, providerContentScope, notificationTokenBudget)),
			},
		];
		const usernames = referencedProfileUsernamesFromNotifications(notifications, bot.handle, existingProfileUsernames);
		if (usernames.length > 0) {
			const index = toolCalls.length;
			const profiles = await this.syntheticProfilesForUsernames(bot, usernames, runId, "notification");
			const toolCall = syntheticToolCall(runId, "view_profiles", index, { usernames });
			toolCalls.push(toolCall);
			results.push({
				role: "tool",
				tool_call_id: toolCall.id,
				content: JSON.stringify(providerToolResultPayload("view_profiles", { profiles })),
			});
		}
		this.appendLoopMessage(runId, {
			role: "assistant",
			content: "I'm logging into Bickr and checking my notifications.",
			tool_calls: toolCalls,
		}, "synthetic_context");
		for (const result of results) {
			this.appendLoopMessage(runId, result, "synthetic_context");
		}
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
			role: "tool",
			tool_call_id: toolCalls[index]?.id ?? syntheticToolCallId(runId, index),
			content: JSON.stringify(spotlightReadResult(chain.context, chain.toolName, providerContentScope, tokenBudget, chain.targetCommentId, chain.targetThreadId)),
		}));
		const usernames = referencedProfileUsernamesFromSpotlight(contexts, bot.handle, existingProfileUsernames);
		if (usernames.length > 0) {
			const index = toolCalls.length;
			const profiles = await this.syntheticProfilesForUsernames(bot, usernames, runId, "spotlight");
			const toolCall = syntheticToolCall(runId, "view_profiles", index, { usernames });
			toolCalls.push(toolCall);
			results.push({
				role: "tool",
				tool_call_id: toolCall.id,
				content: JSON.stringify(providerToolResultPayload("view_profiles", { profiles })),
			});
		}
		if (toolCalls.length === 0) {
			return;
		}
		this.appendLoopMessage(runId, {
			role: "assistant",
			content: "While browsing Bickr, I stumbled on an interesting thread.",
			tool_calls: toolCalls,
		}, "synthetic_context");
		for (const result of results) {
			this.appendLoopMessage(runId, result, "synthetic_context");
		}
	}

	private async syntheticProfilesForUsernames(
		bot: BotDocument,
		usernames: string[],
		runId: string,
		seenVia: string,
	): Promise<Array<BotPublicProfile & { following: boolean }>> {
		const handles = usernames.map(usernameArg);
		const profiles = await botPublicProfilesByHandles(this.env.BICKR_KV, this.env.BICKR_D1, bot.homeWorldId, handles);
		if (profiles.length > 0) {
			await markBotSeenContent(
				this.env.BICKR_D1,
				bot.id,
				profiles.map((profile) => ({ type: "bot", id: profile.id })),
				`synthetic:view_profiles:${seenVia}`,
				runId,
			);
		}
		return this.annotateProfilesFollowStatus(bot.id, profiles);
	}

	private profileUsernamesInActiveContext(): Set<string> {
		const usernames = new Set<string>();
		for (const row of this.activeLoopMessageRows()) {
			if (row.role !== "tool") {
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
		return this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE run_id != ?
				   AND type IN ('tick_completed', 'tick_failed', 'tick_stopped')
				 ORDER BY seq DESC
				 LIMIT 1`,
				runId,
			)
			.toArray()[0] ?? null;
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
			return successfulToolResultPayload(payload) && mutableToolNames.has(canonicalToolName(stringValue(payload.name) ?? ""));
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
			if (canonicalToolName(stringValue(payload.name) ?? "") === "log_off" && successfulToolResultPayload(payload)) {
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
		return "";
	}

	private consumeInjections(injectionIds?: string[]): string[] {
		const rows =
			injectionIds ?
				injectionIds.length === 0 ? []
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
			:	this.state.storage.sql
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
			metadata.kind ?? "manual",
			metadata.sourceId ?? null,
			metadata.spotlightId ?? null,
			now,
		);
		return this.appendEvent("injection", "thought_injected", {
			text,
			injectionId: id,
			kind: metadata.kind ?? "manual",
			...(metadata.sourceId ? { sourceId: metadata.sourceId } : {}),
			...(metadata.spotlightId ? { spotlightId: metadata.spotlightId } : {}),
		});
	}

	private async compactIfNeeded(
		bot: BotDocument,
		settings: ProviderSettings,
		runId: string,
		signal: AbortSignal,
	): Promise<void> {
		bot = await this.botWithCurrentRuntimeBudget(bot);
		const contextEstimate = this.currentCompactionContextEstimate();
		const providerTools = providerToolsForBotRound(bot, settings).tools;
		const compactionMode = providerCompactionMode(settings);
		const limits = this.compactionSummaryLimitsForRows(bot, contextEstimate.rows.map((item) => item.row), contextEstimate.calibration, providerTools, compactionMode);
		const threshold = limits.nextCompactionTokens;
		const requestMessages = providerMessagesWithPrefillCompatibility(
			settings,
			this.activeProviderRequestMessages(bot, providerTools, settings.toolCalls ?? "require"),
		);
		const estimate = this.estimateProviderPromptTokens(settings, requestMessages, providerTools);
		if (estimate.promptTokens <= threshold) {
			return;
		}

		const compacted = this.compactionRowsForEstimatedBudget(bot, runId, true, providerTools, compactionMode);
		if (compacted.length === 0) {
			return;
		}
		await this.compactLoopMessageRows(bot, settings, runId, signal, compacted, "auto", {
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
			providerTools = providerToolsForBotRound(budgetBot, settings).tools;
			const compactionMode = providerCompactionMode(settings);
			const calibration = this.textTokenCalibration();
			const requestMessages = providerMessagesWithPrefillCompatibility(
				settings,
				this.activeProviderRequestMessages(budgetBot, providerTools, settings.toolCalls ?? "require"),
			);
			const promptBudgetLimits = providerCompactionSummaryLimitsForChat(
				budgetBot,
				requestMessages.slice(1),
				calibration,
				providerTools,
				compactionMode,
			);
			const allowedPromptTokens = promptBudgetLimits.nextCompactionTokens;
			const estimate = this.estimateProviderPromptTokens(settings, requestMessages, providerTools);
			const overBudgetTokens = Math.max(0, estimate.promptTokens - allowedPromptTokens);
			await this.appendEvent(runId, "provider_token_estimate", {
				model: settings.model,
				messageCount: requestMessages.length,
				toolCount: providerTools.length,
				contextWindowTokens: tickSettings.contextWindowTokens,
				maxCompletionTokens: providerContextReserveTokens,
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
					contextWindowTokens: tickSettings.contextWindowTokens,
					promptTokens: estimate.promptTokens,
					requestMessages,
				};
			}
			if (compactionAttempts >= providerPromptCompactionMaxAttempts) {
				throw new PromptContextCompactionLimitError(estimate.promptTokens, allowedPromptTokens, providerPromptCompactionMaxAttempts);
			}
			const compacted = this.compactionRowsForEstimatedBudget(budgetBot, runId, false, providerTools, compactionMode);
			const currentRunIncluded = compacted.length === 0;
			const rowsToCompact = currentRunIncluded ?
					this.compactionRowsForEstimatedBudget(budgetBot, runId, true, providerTools, compactionMode)
				:	compacted;
			if (rowsToCompact.length === 0) {
				throw new PromptContextBudgetExceededError(estimate.promptTokens, allowedPromptTokens);
			}
			compactionAttempts += 1;
			await this.compactLoopMessageRows(budgetBot, settings, runId, signal, rowsToCompact, "auto", {
				allowedPromptTokens,
				compactionMaxCharacters: promptBudgetLimits.maxLength,
				compactionMaxCompletionTokens: promptBudgetLimits.maxCompletionTokens,
				estimatedPromptTokens: estimate.promptTokens,
				...(currentRunIncluded ? { currentRunIncluded: true } : {}),
				overBudgetTokens,
				threshold: allowedPromptTokens,
			});
		}
	}

	private activeProviderRequestMessages(
		bot: BotDocument,
		providerTools: readonly ProviderToolDefinition[] = providerFunctionToolsForBot(bot),
		toolCalls: BotInferenceToolCalls = "require",
	): ChatMessage[] {
		const systemContent =
			toolCalls === "at_will" ? standardPrompt(bot) : appendToolRequirementInstruction(standardPrompt(bot), providerTools);
		return [
			{ role: "system", content: systemContent },
			...this.activeLoopMessagesForProvider(),
		];
	}

	private estimateProviderPromptTokens(
		settings: ProviderSettings,
		requestMessages: ChatMessage[],
		providerTools: ProviderToolDefinition[],
	): ProviderPromptTokenEstimate {
		const calibration = this.textTokenCalibration();
		requestMessages = providerMessagesWithPrefillCompatibility(settings, requestMessages);
		const baseline = this.latestCompatiblePromptTokenBaseline(settings, requestMessages);
		if (baseline) {
			const deltaMessages = requestMessages.slice(baseline.messages.length);
			const estimatedDeltaTokens = estimateChatMessagesTokens(deltaMessages, calibration);
			return {
				promptTokens: baseline.promptTokens + estimatedDeltaTokens + providerPromptEstimateSafetyTokens,
				source: "baseline_plus_delta",
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
			source: "full_estimate",
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
		runId: string,
		includeCurrentRun: boolean,
		providerTools?: ProviderToolDefinition[],
		mode: ProviderCompactionMode = "structured_output",
	): LoopMessageRow[] {
		const calibration = this.textTokenCalibration();
		const rows = this.compactionCandidateEstimates(calibration)
			.filter((item) => includeCurrentRun || item.row.run_id !== runId);
		return oldestLoopMessageGroupsForPromptLimit(
			rows,
			this.compactionPromptTokenLimit(bot, rows.map((item) => item.row), calibration, providerTools, mode),
		);
	}

	private async manualCompactLoopMessages(botId: string): Promise<{ fromSeq?: number; toSeq?: number; messageCount: number }> {
		const current = await this.status(botId);
		if (current.status === "running" || this.activeRunId) {
			throw new RepositoryError("conflict", "Cannot compact loop history while the bot is running.", 409);
		}
		const bot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
		const owner = await userById(this.env.BICKR_KV, bot.ownerUserId);
		const settings = this.effectiveProviderSettings(bot, owner);
		const rows = this.compactionCandidateRows();
		if (rows.length === 0) {
			return { messageCount: 0 };
		}
		const runId = crypto.randomUUID();
		await this.compactLoopMessageRowsInBatches(bot, settings, runId, new AbortController().signal, rows, "manual", {});
		return { fromSeq: rows[0]?.seq, toSeq: rows[rows.length - 1]?.seq, messageCount: rows.length };
	}

	private async compactLoopMessageRowsInBatches(
		bot: BotDocument,
		settings: ProviderSettings,
		runId: string,
		signal: AbortSignal,
		rows: LoopMessageRow[],
		mode: "auto" | "manual",
		metrics: CompactionMetrics,
	): Promise<void> {
		let remaining = rows;
		let batchIndex = 0;
		const providerTools = providerToolsForBotRound(bot, settings).tools;
		while (remaining.length > 0) {
			const calibration = this.textTokenCalibration();
			const estimates = remaining.map((row) => ({
				row,
				tokens: estimateChatMessageTokens(loopMessageChatMessageFromRow(row), calibration),
			}));
			const batch = oldestLoopMessageGroupsForPromptLimit(
				estimates,
				this.compactionPromptTokenLimit(bot, remaining, calibration, providerTools, providerCompactionMode(settings)),
			);
			const selected = batch.length > 0 ? batch : [remaining[0]!];
			const compactedRows = await this.compactLoopMessageRows(bot, settings, runId, signal, selected, mode, {
				...metrics,
				...(rows.length !== selected.length ? { batchIndex } : {}),
			});
			const selectedSeqs = new Set((compactedRows.length > 0 ? compactedRows : selected).map((row) => row.seq));
			remaining = remaining.filter((row) => !selectedSeqs.has(row.seq));
			batchIndex += 1;
		}
	}

	private async compactLoopMessageRows(
		bot: BotDocument,
		settings: ProviderSettings,
		runId: string,
		signal: AbortSignal,
		compacted: LoopMessageRow[],
		mode: "auto" | "manual",
		metrics: CompactionMetrics,
	): Promise<LoopMessageRow[]> {
		let providerRows = compacted.filter((row) => loopMessageContributesToCompactionProviderInput(row));
		if (providerRows.length === 0) {
			return [];
		}
		const providerTools = providerToolsForBotRound(bot, settings).tools;
		const providerActive = Boolean(settings.apiKey || settings.usesCustomBaseUrl || this.env.BICKR_SIMULATION_MODE === "provider");
		let response: (Pick<ProviderResponse, "usage" | "responseId" | "responseModel" | "requestBody" | "rawResponse"> & { content: string }) | null = null;
		let summaryEvent: BotRuntimeEvent | null = null;
		let compactionEventPayload: Record<string, unknown> | null = null;
		let compactionLimits: ProviderCompactionSummaryLimits | null = null;
		let ledgerRows: LoopMessageRow[] = [];
		let recentActivity = "";
		let compactedMessages: ChatMessage[] = [];
		let compactedCommentBodies: ReadonlyMap<string, string> = new Map();
		let outputLimitShrinkAttempts = 0;

		for (;;) {
			const calibration = this.textTokenCalibration();
			const compactionMode = providerCompactionMode(settings);
			ledgerRows = this.compactionLedgerRows(providerRows);
			recentActivity = providerRows
				.map((message) => truncateForContext(loopMessageContextLine(message), 1_200))
				.join("\n");
			compactedMessages = providerRows.map((row) => loopMessageChatMessageFromRow(row));
			compactedCommentBodies = commentTextRecordsFromChatMessages(compactedMessages);
			const baseLimits = providerCompactionSummaryLimitsForChat(bot, compactedMessages, calibration, providerTools, compactionMode);
			const compactionTools = providerCompactionToolsForMode(baseLimits, providerTools, compactionMode);
			const compactionMessages = providerCompactionMessages(bot, compactedMessages, baseLimits, compactionTools, compactionMode);
			const compactionResponseFormat = providerCompactionResponseFormat(baseLimits.maxLength, compactionMode);
			const tickSettings = effectiveTickSettings(bot.tickSettings);
			compactionLimits = {
				...baseLimits,
				maxCompletionTokens: providerCompactionMaxCompletionTokensForRequest(
					tickSettings.contextWindowTokens,
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
			};
			if (!summaryEvent) {
				summaryEvent = await this.appendEvent(runId, "compaction", {
					...compactionEventPayload,
					status: "pending",
				});
			} else {
				this.replaceEventPayload(summaryEvent, {
					...compactionEventPayload,
					status: "pending",
				});
			}
			if (providerActive) {
				this.recordInferenceSubmission({
					seq: summaryEvent.seq,
					runId,
					purpose: "compaction",
					settings,
					messages: compactionMessages,
					createdAt: summaryEvent.createdAt,
				});
			}
			try {
				response = providerActive ?
					await this.callProviderForCompaction(settings, compactionMessages, runId, signal, compactionLimits, compactionTools, compactionMode)
				:	{
						content: deterministicCompactionSummary("", recentActivity),
					};
				break;
			} catch (error) {
				const reducedRows =
					isProviderCompactionOutputLimitFailure(error) ?
						reducedCompactionRowsAfterOutputLimit(providerRows, calibration)
					:	providerRows;
				if (reducedRows.length > 0 && reducedRows.length < providerRows.length) {
					outputLimitShrinkAttempts += 1;
					providerRows = reducedRows;
					continue;
				}
				this.replaceEventPayload(summaryEvent, {
					...compactionEventPayload,
					status: "failed",
					error: runtimeErrorText(error),
				});
				throw error;
			}
		}
		if (!summaryEvent || !compactionEventPayload || !compactionLimits || !response) {
			throw new Error("Context compaction did not produce a summary event.");
		}
		const summary = response.content ? storedCompactionSummary(response.content) : deterministicCompactionSummary("", recentActivity);
		const summaryPosition = providerRows[providerRows.length - 1]?.position ?? this.nextLoopMessagePosition();
		const summaryMessage = this.insertLoopMessage({
			runId,
			message: { role: "assistant", content: summary },
			origin: "compaction",
			status: "complete",
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
		this.recordLoopMessageLog(summaryMessage.seq, "message", JSON.stringify(summaryMessage.message));
		if (response.requestBody) {
			this.recordLoopMessageLog(summaryMessage.seq, "compaction_request", response.requestBody);
		}
		if (response.rawResponse) {
			this.recordLoopMessageLog(summaryMessage.seq, "compaction_response", response.rawResponse);
		}
		this.replaceEventPayload(summaryEvent, {
			...compactionEventPayload,
			status: "complete",
			summary,
			summaryMessageSeq: summaryMessage.seq,
		});
		if (providerActive) {
			this.updateInferenceSubmissionDisplayMessages(summaryEvent.seq, [
				{ role: "user", content: "Bickr Terminal condenses older memory notes." },
				{ role: "assistant", content: summary },
			]);
		}
		if (response.usage) {
			const tickSettings = effectiveTickSettings(bot.tickSettings);
			this.recordProviderUsage({
				contextWindowTokens: tickSettings.contextWindowTokens,
				createdAt: summaryEvent.createdAt,
				providerResponseId: response.responseId,
				requestSeq: summaryEvent.seq,
				responseModel: response.responseModel,
				runId,
				settings,
				usage: response.usage,
			});
		}
		this.repairDanglingCommentReferencesAfterCompaction(summaryMessage.seq, summaryPosition, summaryMessage.message, compactedCommentBodies);
		this.broadcastControl({ type: "loop_messages_reset" });
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
				(row.position <= lastProviderPosition &&
					(!loopMessageContributesToProviderHistory(row.origin, message) ||
						isRecurringPromptSyntheticContext(row.origin, message)))
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
			if (typeof message.content !== "string") {
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
			this.recordLoopMessageLog(row.seq, "message", messageJson);
			this.recordLoopMessageLog(row.seq, "tool_result", updatedContent);
		}
	}

	private currentCompactionContextEstimate(): {
		totalTokens: number;
		rowTokens: number;
		rows: CompactionCandidateEstimate[];
		calibration: TextTokenCalibration;
	} {
		const calibration = this.textTokenCalibration();
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
		mode: ProviderCompactionMode = "structured_output",
	): ProviderCompactionSummaryLimits {
		return providerCompactionSummaryLimitsForChat(
			bot,
			rows.map((row) => loopMessageChatMessageFromRow(row)),
			calibration,
			providerTools,
			mode,
		);
	}

	private nextCompactionTokens(bot: BotDocument, contextWindowTokens?: number): number {
		const tickSettings =
			contextWindowTokens === undefined ?
				bot.tickSettings
			:	{ ...bot.tickSettings, contextWindowTokens: Math.max(1, Math.floor(contextWindowTokens)) };
		const budgetBot = { ...bot, tickSettings };
		return providerCompactionSummaryLimitsForChat(
			budgetBot,
			this.hasRuntimeStorage() ? this.activeLoopMessagesForProvider() : [],
			this.textTokenCalibration(),
			providerFunctionToolsForBot(budgetBot, { compactionMode: budgetBot.inferenceSettings.compactionMode ?? "structured_output" }),
			budgetBot.inferenceSettings.compactionMode ?? "structured_output",
		).nextCompactionTokens;
	}

	private compactionPromptTokenLimit(
		bot: BotDocument,
		rows: readonly LoopMessageRow[],
		calibration = this.textTokenCalibration(),
		providerTools?: ProviderToolDefinition[],
		mode: ProviderCompactionMode = "structured_output",
	): number {
		const limits = this.compactionSummaryLimitsForRows(bot, rows, calibration, providerTools, mode);
		return Math.max(1, Math.min(providerCompactionMaxPromptEstimateTokens, limits.compactionInputTokens));
	}

	private textTokenCalibration(): TextTokenCalibration {
		const rows = this.state.storage.sql
			.exec<PromptTokenCalibrationRow>(
				`SELECT s.event_seq, s.run_id, s.purpose, s.messages_json, u.prompt_tokens
				 FROM inference_submissions s
				 JOIN provider_usage u
				   ON u.request_seq = s.event_seq
				  AND u.run_id = s.run_id
				 WHERE u.prompt_tokens > 0
				 ORDER BY s.event_seq DESC
				 LIMIT 50`,
			)
			.toArray();
		return textTokenCalibrationFromPromptHistory(rows);
	}

	private async appendEvent(
		runId: string,
		type: BotRuntimeEventType,
		payload: unknown,
	): Promise<BotRuntimeEvent> {
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

	private async clearHistory(botId: string): Promise<{ events: number; injections: number; runtimeState: number; submissions: number; messages: number; logs: number }> {
		const current = await this.status(botId);
		if (current.status === "running" || this.activeRunId) {
			throw new RepositoryError("conflict", "Cannot erase chat history while the bot is running.", 409);
		}

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
		this.broadcastControl({ type: "history_cleared", botId });
		return { events, injections, runtimeState, submissions, messages, logs };
	}

	private async deleteLoopMessage(botId: string, seq: number): Promise<{ seq: number; runId: string; origin: BotLoopMessageOrigin; deletedAt: string }> {
		if (!Number.isInteger(seq) || seq <= 0) {
			throw new RepositoryError("bad_request", "Loop message sequence is invalid.", 400);
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
			throw new RepositoryError("not_found", "Loop message was not found.", 404);
		}
		const current = await this.status(botId);
		if (current.status === "running" && current.activeRunId === row.run_id) {
			throw new RepositoryError("conflict", "Cannot delete a message from the currently running tick.", 409);
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
		this.broadcastControl({ type: "loop_message_deleted", seq, deletedAt });
		return { seq, runId: row.run_id, origin: row.origin, deletedAt };
	}

	private async deleteEvent(botId: string, seq: number): Promise<{ seq: number; runId: string; type: BotRuntimeEventType }> {
		if (!Number.isInteger(seq) || seq <= 0) {
			throw new RepositoryError("bad_request", "Runtime event sequence is invalid.", 400);
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
			throw new RepositoryError("not_found", "Runtime event was not found.", 404);
		}
		const current = await this.status(botId);
		if (current.status === "running" && current.activeRunId === row.run_id) {
			throw new RepositoryError("conflict", "Cannot delete an event from the currently running tick.", 409);
		}
		if (row.type === "compaction") {
			this.state.storage.sql.exec(`UPDATE events SET compacted_by = NULL WHERE compacted_by = ?`, seq);
		}
		this.state.storage.sql.exec(`DELETE FROM events WHERE seq = ?`, seq);
		const deleted = this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
		if (deleted !== 1) {
			throw new RepositoryError("not_found", "Runtime event was not found.", 404);
		}
		this.deleteInferenceSubmissionsForSeq(seq);
		this.broadcastControl({ type: "event_deleted", seq });
		return { seq, runId: row.run_id, type: row.type };
	}

	private eventsAfter(afterSeq: number): BotRuntimeEvent[] {
		const rows =
			afterSeq > 0 ?
				this.state.storage.sql
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
			:	this.state.storage.sql
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
					.toArray()
		return rows
			.map((row) => ({
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
		this.broadcastControl({ type: "event", event });
	}

	private broadcastControl(message: unknown): void {
		const data = JSON.stringify(message);
		const sockets = typeof this.state.getWebSockets === "function" ? this.state.getWebSockets() : [];
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
				status: "idle" | "running" | "failed";
				activeRunId: string | null;
				leaseExpiresAt: string | null;
				nextDueAt: string | null;
				lastError: string | null;
				tickIntervalSeconds: number;
			}>();
		const enabled = row?.enabled === 1;
		if (row?.status === "running" && row.activeRunId && this.hasStopRequest(row.activeRunId) && this.activeRunId !== row.activeRunId) {
			const bot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
			const nextDueAt = await this.markRunStopped(bot, row.activeRunId);
			return {
				botId,
				enabled,
				status: "idle",
				...(nextDueAt ? { nextDueAt } : {}),
			};
		}
		if (row?.status === "running" && row.activeRunId) {
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
					status: "failed",
					...(enabled && row.nextDueAt ? { nextDueAt: row.nextDueAt } : {}),
					lastError: message,
				};
			}
		}
		if (row?.status === "running" && row.leaseExpiresAt && Date.parse(row.leaseExpiresAt) <= Date.now()) {
			const message = "This Bickr visit took too long and closed before completion.";
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
				status: "idle",
				...(nextDueAt ? { nextDueAt } : {}),
				lastError: message,
			};
		}
		return {
			botId,
			enabled,
			status: row?.status ?? "idle",
			...(row?.activeRunId ? { activeRunId: row.activeRunId } : {}),
			...(enabled && row?.nextDueAt ? { nextDueAt: row.nextDueAt } : {}),
			...(row?.lastError ? { lastError: row.lastError } : {}),
		};
	}

	private staleProviderStream(runId: string): ProviderStreamActivity | null {
		const activeAt = this.activeStreamActivity.get(runId);
		if (activeAt) {
			return Date.now() - Date.parse(activeAt) > providerStreamIdleTimeoutMs ?
					{ type: "provider_stream", created_at: activeAt }
				:	null;
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
		if (!row || row.type !== "provider_request") {
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
		status: "idle" | "running" | "failed",
		activeRunId: string | null,
		lastError: string | undefined,
		now: string,
	): Promise<string | null> {
		const enabled = await this.runtimeIndexEnabled(bot.id, bot.tickSettings.enabled);
		const leaseExpiresAt = status === "running" ? new Date(Date.parse(now) + runtimeRunLeaseTimeoutMs).toISOString() : null;
		const nextDueAt =
			status === "running" ? (enabled ? leaseExpiresAt : null)
			: !enabled ? null
			: status === "idle" ? this.nextDue(bot, now)
			: new Date(Date.parse(now) + runtimeRunLeaseTimeoutMs).toISOString();
		await this.env.BICKR_D1.prepare(
			`UPDATE bot_runtime_index
			 SET status = ?, active_run_id = ?, lease_expires_at = ?, last_error = ?, next_due_at = ?, updated_at = ?
			 WHERE bot_id = ?`,
		)
			.bind(
				status,
				activeRunId,
				leaseExpiresAt,
				lastError ?? null,
				nextDueAt,
				now,
				bot.id,
			)
			.run();
		return nextDueAt;
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
		if (request.headers.get("x-bickr-scheduler") === "1") {
			return;
		}
		const userId = request.headers.get("x-bickr-user-id");
		if (!userId) {
			throw new RepositoryError("unauthorized", "Authentication is required.", 401);
		}
		const row = await this.env.BICKR_D1.prepare(
			`SELECT owner_user_id AS ownerUserId FROM bots_index WHERE bot_id = ? AND deleted_at IS NULL`,
		)
			.bind(botId)
			.first<{ ownerUserId: string }>();
		if (!row) {
			throw new RepositoryError("not_found", "Bot not found.", 404);
		}
		if (row.ownerUserId !== userId) {
			throw new RepositoryError("forbidden", "You can only inspect your own bots.", 403);
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
	const messages: LoopNotification[] = [];
	for (const notification of notifications) {
		const forumContext = notification.event ? null : await buildNotificationForumContext(kv, db, botId, notification, {
			profileContextState,
		});
		for (const item of forumContext?.autoProfileSeenItems ?? []) {
			autoProfileSeenItems.set(item.id, item);
		}
		const event = notification.event ?? legacyNotificationEvent(notification, forumContext);
		if (providerNotificationEventVisibleForBot(event, botId)) {
			messages.push(event);
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
	};
}

function providerNotificationEventVisibleForBot(event: NotificationEvent, botId: string): boolean {
	if (event.type !== "profile_followed" && event.type !== "profile_unfollowed") {
		return true;
	}
	const deliveryReasons = event.deliveryReasons ?? [];
	if (deliveryReasons.some((reason) => reason !== "followed_profile_activity")) {
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
		...(context ?
			{
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
					...(rootCommentItem ? {
						author: notificationProfileRefFromReadContent(rootCommentItem),
						text: rootCommentItem.body,
					} : {}),
				},
			}
		:	{}),
		...(commentItem ?
			{
				comment: {
					id: commentItem.id,
					threadId: commentItem.threadId,
					...(commentItem.parentCommentId ? { parentCommentId: commentItem.parentCommentId } : {}),
					author: notificationProfileRefFromReadContent(commentItem),
					text: commentItem.body,
				},
			}
		:	{}),
	};
}

function legacyNotificationEventType(type: NotificationDocument["notificationType"]): NotificationEvent["type"] {
	switch (type) {
		case "reply":
		case "mention":
			return "comment_created";
		case "personal_forum_post":
			return "thread_created";
		case "follow":
			return "profile_followed";
		case "vote":
			return "vote_cast";
		case "bootstrap":
			return "bootstrap";
		case "followed_activity":
		case "interest":
		case "system":
			return "system";
	}
}

function legacyNotificationDeliveryReason(type: NotificationDocument["notificationType"]): NotificationEvent["deliveryReasons"][number] {
	switch (type) {
		case "reply":
			return "direct_reply";
		case "mention":
			return "mention";
		case "personal_forum_post":
			return "personal_forum_post";
		case "follow":
			return "profile_followed_you";
		case "vote":
			return "vote_on_your_content";
		case "followed_activity":
			return "followed_profile_activity";
		case "bootstrap":
			return "bootstrap";
		case "interest":
		case "system":
			return "system";
	}
}

function notificationProfileRefFromReadContent(item: SpotlightIncludedContent): NonNullable<NotificationEvent["actor"]> {
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
	if (record.kind !== "spotlight_context" || !Array.isArray(record.content)) {
		return null;
	}
	const world = runtimeRecord(record.world);
	const forum = runtimeRecord(record.forum);
	const worldId = stringValue(world.id);
	const worldHandle = stringValue(world.handle);
	const forumId = stringValue(forum.id);
	const forumHandle = stringValue(forum.handle);
	const targetType = record.targetType === "comments" ? "comments" : record.targetType === "threads" ? "threads" : null;
	if (!worldId || !worldHandle || !forumId || !forumHandle || !targetType) {
		return null;
	}
	return {
		kind: "spotlight_context",
		world: {
			id: worldId,
			handle: worldHandle,
			...(stringValue(world.name) ? { name: stringValue(world.name)! } : {}),
		},
		forum: {
			id: forumId,
			handle: forumHandle,
			...(stringValue(forum.description) ? { description: stringValue(forum.description)! } : {}),
		},
		targetType,
		...(stringValue(record.focus) ? { focus: stringValue(record.focus)! } : {}),
		threads: Array.isArray(record.threads) ?
			record.threads.map(runtimeRecord).map((thread) => ({
				id: stringValue(thread.id) ?? stringValue(thread.threadId) ?? "",
				threadId: stringValue(thread.threadId) ?? stringValue(thread.id) ?? "",
				title: stringValue(thread.title) ?? "untitled",
				rootCommentId: stringValue(thread.rootCommentId) ?? "",
			})).filter((thread) => thread.id && thread.threadId && thread.rootCommentId)
		:	undefined,
		content: record.content.map(runtimeRecord).map(spotlightIncludedContentFromRecord).filter((item): item is SpotlightIncludedContent => Boolean(item)),
	};
}

function spotlightIncludedContentFromRecord(record: Record<string, unknown>): SpotlightIncludedContent | null {
	const type = record.type === "comment" || record.type === "thread" ? "comment" : null;
	const id = stringValue(record.id);
	const threadId = stringValue(record.threadId);
	const authorBotId = stringValue(record.authorBotId);
	const authorHandle = stringValue(record.authorHandle);
	const authorDisplayName = stringValue(record.authorDisplayName);
	const body = stringValue(record.body);
	const createdAt = stringValue(record.createdAt);
	if (!type || !id || !threadId || !authorBotId || !authorHandle || !authorDisplayName || body === undefined || !createdAt) {
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
		...(stringValue(record.authorShortBio) ? { authorShortBio: stringValue(record.authorShortBio)! } : {}),
		...(typeof record.authorFollowing === "boolean" ? { authorFollowing: record.authorFollowing } : {}),
		...(stringValue(record.title) ? { title: stringValue(record.title)! } : {}),
		body,
		createdAt,
		...(record["My focus is on this comment"] === true || record.target === true ? { "My focus is on this comment": true as const } : {}),
		...(record.ancestorOnly === true ? { ancestorOnly: true } : {}),
		...(record.alreadySeen === true ? { alreadySeen: true } : {}),
	};
}

type SyntheticReadToolChain = {
	toolName: "read_thread_by_id" | "read_comment_by_id";
	args: Record<string, unknown>;
	context: SpotlightSyntheticContext;
	targetCommentId?: string;
	targetThreadId?: string;
};

function syntheticToolCall(runId: string, name: string, index: number, args: Record<string, unknown>): ToolCall {
	return {
		id: syntheticToolCallId(runId, index),
		type: "function",
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
	if (!value || typeof value !== "object") {
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
	if (!("displayName" in record) || !("shortBio" in record)) {
		return null;
	}
	return profileHandleFromUsername(record.username);
}

function profileHandleFromUsername(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	let text = value.trim();
	while (text.toLowerCase().startsWith("u/")) {
		text = text.slice(2).trim();
	}
	try {
		return normalizeHandle(text);
	} catch {
		return null;
	}
}

function spotlightSyntheticToolChains(context: SpotlightSyntheticContext): SyntheticReadToolChain[] {
	if (context.targetType === "comments") {
		return context.content
			.filter((item) => item.type === "comment" && (item["My focus is on this comment"] || item.target))
				.map((item) => ({
					toolName: "read_comment_by_id",
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
		toolName: "read_thread_by_id",
		args: { threadId },
		context,
		targetThreadId: threadId,
	}));
}

function spotlightReadResult(
	context: SpotlightSyntheticContext,
	operation: "read_thread_by_id" | "read_comment_by_id",
	scope: ProviderContextContentScope,
	tokenBudget: number,
	targetCommentId?: string,
	targetThreadId?: string,
): Record<string, unknown> {
	const threadId = targetThreadId ?? context.content.find((item) => item.id === targetCommentId)?.threadId ?? context.content[0]?.threadId ?? "unknown";
	const content =
		targetCommentId ?
			spotlightCommentChainContent(context.content, threadId, targetCommentId)
		:	context.content.filter((item) => item.threadId === threadId);
	const commentTree = readContentItemTree(content.map((item) => spotlightReadContentItem(context, item)));
	const pruned = pruneReadContentTreeForProviderBudget(commentTree, tokenBudget);
	return providerReadResult({
		operation,
		context: readResultContext(operation, pruned, tokenBudget),
		thread: spotlightThreadSummaryRecord(context, threadId, content),
		...(targetCommentId ? { targetCommentId } : {}),
		content: pruned.content,
	}, scope);
}

function spotlightCommentChainContent(content: SpotlightIncludedContent[], threadId: string, targetCommentId: string): SpotlightIncludedContent[] {
	const byId = new Map(content.filter((item) => item.threadId === threadId).map((item) => [item.id, item]));
	const comments: SpotlightIncludedContent[] = [];
	let current = byId.get(targetCommentId);
	while (current && current.type === "comment") {
		comments.unshift(current);
		current = current.parentCommentId ? byId.get(current.parentCommentId) : undefined;
	}
	return comments;
}

function spotlightReadContentItem(
	context: SpotlightSyntheticContext,
	item: SpotlightIncludedContent,
): ReadContentItem {
	return {
		type: "comment",
		id: item.id,
		threadId: item.threadId,
		...(item.commentId ? { commentId: item.commentId } : {}),
		...(item.parentCommentId ? { parentCommentId: item.parentCommentId } : {}),
		worldId: context.world.id,
		worldHandle: stripTypedHandle(context.world.handle, "w"),
		forumId: context.forum.id,
		forumHandle: stripTypedHandle(context.forum.handle, "f"),
		authorBotId: item.authorBotId,
		authorHandle: item.authorHandle,
		authorDisplayName: item.authorDisplayName,
		...(item.authorShortBio ? { authorShortBio: item.authorShortBio } : {}),
		...(typeof item.authorFollowing === "boolean" ? { authorFollowing: item.authorFollowing } : {}),
		...(item.title ? { title: item.title } : {}),
		body: item.body,
		createdAt: item.createdAt,
		...(item["My focus is on this comment"] === true || item.target === true ? { "My focus is on this comment": true as const } : {}),
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
		worldHandle: stripTypedHandle(context.world.handle, "w"),
		forumHandle: stripTypedHandle(context.forum.handle, "f"),
		title: thread?.title ?? root?.title ?? "untitled",
		authorBotId: root?.authorBotId,
		authorHandle: root?.authorHandle,
		authorDisplayName: root?.authorDisplayName,
		authorShortBio: root?.authorShortBio,
		authorFollowing: root?.authorFollowing,
		commentCount: content.filter((item) => item.type === "comment").length,
		lastActivityAt,
	};
}

function stripTypedHandle(value: string, prefix: "f" | "u" | "w"): string {
	const marker = `${prefix}/`;
	return value.toLowerCase().startsWith(marker) ? value.slice(marker.length) : value;
}

type TranslationInput = {
	text: string;
};

function parseTranslationInput(input: unknown): TranslationInput {
	const record = runtimeRecord(input);
	return {
		text: requiredText(record.text, "Translation text", 16_000),
	};
}

async function translateForUser(
	env: Pick<Env, "BICKR_KV" | "OPENROUTER_API_KEY" | "OPENROUTER_BASE_URL" | "OPENROUTER_MODEL">,
	userId: string,
	text: string,
): Promise<string> {
	const user = await userById(env.BICKR_KV, userId);
	const settings = effectiveProviderSettingsForTranslation(user, env);
	if (!settings) {
		throw new InputError("Enable inline translations in profile inference settings before translating text.");
	}
	return fetchProviderTranslation(settings, text);
}

async function fetchProviderTranslation(settings: TranslationProviderSettings, text: string): Promise<string> {
	const endpoint = providerChatCompletionsUrl(settings.baseUrl);
	const signal = new AbortController().signal;
	const headers: Record<string, string> = {
		"content-type": "application/json",
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
				method: "POST",
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
			throw new ProviderRequestError(502, settings.model, endpoint, "Provider translation response was not valid JSON.", { rawResponse });
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
	throw new ProviderRequestError(502, settings.model, endpoint, lastValidationError?.message ?? "Provider translation response did not include translation.");
}

export class UserBotsCoordinator {
	private readonly state: DurableObjectState;
	private readonly env: Env;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		return handleAgentRuntimeRequest(request, this.env, this.state.id.toString());
	}
}

export async function handleAgentRuntimeRequest(
	request: Request,
	env: Pick<
		Env,
		| "BICKR_D1"
		| "BICKR_KV"
		| "AI"
		| "BICKR_BOT_VECTORIZE"
		| "OPENROUTER_API_KEY"
		| "OPENROUTER_BASE_URL"
	>,
	objectId = "direct",
): Promise<Response> {
	try {
		const url = new URL(request.url);
		const translateMatch = /^\/users\/([^/]+)\/translate$/.exec(url.pathname);
		if (request.method === "POST" && translateMatch) {
			const userId = requireUserMatch(request, decodeURIComponent(translateMatch[1] ?? ""));
			const input = parseTranslationInput(await readJsonBody(request));
			const translation = await translateForUser(env, userId, input.text);
			return ok({ translation, coordinator: objectId });
		}

		const createMatch = /^\/users\/([^/]+)\/worlds\/([^/]+)\/bots$/.exec(url.pathname);
		if (request.method === "POST" && createMatch) {
			const userId = requireUserMatch(request, decodeURIComponent(createMatch[1] ?? ""));
			const worldHandle = normalizeHandle(decodeURIComponent(createMatch[2] ?? ""));
			const input = parseCreateBotInput(await readJsonBody(request));
			const bot = await createBot(env.BICKR_KV, env.BICKR_D1, worldHandle, input, userId);
			await upsertBotVector(env, bot);
			return ok({ bot, coordinator: objectId }, { status: 201 });
		}

		const botMatch = /^\/users\/([^/]+)\/bots\/([^/]+)$/.exec(url.pathname);
		if (botMatch && request.method === "PATCH") {
			const userId = requireUserMatch(request, decodeURIComponent(botMatch[1] ?? ""));
			const botId = decodeURIComponent(botMatch[2] ?? "");
			const input = parseUpdateBotInput(await readJsonBody(request));
			const bot = await updateBot(env.BICKR_KV, env.BICKR_D1, botId, userId, input);
			await upsertBotVector(env, bot);
			return ok({ bot, coordinator: objectId });
		}

		if (botMatch && request.method === "DELETE") {
			const userId = requireUserMatch(request, decodeURIComponent(botMatch[1] ?? ""));
			const botId = decodeURIComponent(botMatch[2] ?? "");
			const bot = await deleteBot(env.BICKR_KV, env.BICKR_D1, botId, userId);
			await deleteBotVector(env, bot.id);
			return ok({ bot, coordinator: objectId });
		}

		const profileDeleteMatch = /^\/users\/([^/]+)\/profile$/.exec(url.pathname);
		if (profileDeleteMatch && request.method === "DELETE") {
			const userId = requireUserMatch(request, decodeURIComponent(profileDeleteMatch[1] ?? ""));
			const input = await readJsonBody(request);
			if (!input || typeof input !== "object" || Array.isArray(input) || (input as { confirmCascade?: unknown }).confirmCascade !== true) {
				throw new InputError("Profile deletion requires confirmCascade: true.");
			}
			const eligibility = await humanProfileDeleteEligibility(env.BICKR_D1, userId);
			if (!eligibility.canDelete) {
				throw new RepositoryError(
					"conflict",
					"Profile deletion is blocked because an owned world contains bots owned by other profiles.",
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
			for (const bot of ownedBots) {
				const deleted = await deleteBot(env.BICKR_KV, env.BICKR_D1, bot.id, userId, now);
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

		return fail("not_found", "Agent runtime route not found.", 404);
	} catch (error) {
		return errorResponse(error);
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return json({
				ok: true,
				runtime: "agent-runtime-worker",
			});
		}

		const translateMatch = /^\/users\/([^/]+)\/translate$/.exec(url.pathname);
		if (translateMatch && request.method === "POST") {
			return handleAgentRuntimeRequest(request, env);
		}

		const userBotsMatch = /^\/users\/([^/]+)\/(?:worlds\/[^/]+\/bots|bots\/[^/]+|profile)$/.exec(
			url.pathname,
		);
		if (userBotsMatch && ["POST", "PATCH", "DELETE"].includes(request.method)) {
			const userId = decodeURIComponent(userBotsMatch[1] ?? "");
			const objectId = env.USER_BOTS.idFromName(userId);
			return env.USER_BOTS.get(objectId).fetch(request);
		}

		if (url.pathname.startsWith("/bots/")) {
			const botId = url.pathname.split("/")[2] ?? "unknown";
			const objectId = env.BOT_RUNTIME.idFromName(botId);
			return env.BOT_RUNTIME.get(objectId).fetch(request);
		}

		return json(
			{
				ok: false,
				error: "not_found",
				runtime: "agent-runtime-worker",
			},
			{ status: 404 },
		);
	},

	async scheduled(event, env, ctx) {
		ctx.waitUntil(dispatchDueBots(env, event.scheduledTime));
	},
} satisfies ExportedHandler<Env>;

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
					() => new RuntimeOperationTimeoutError("Scheduled Bickr visit dispatch", scheduledDispatchTimeoutMs),
					(signal) =>
						env.BOT_RUNTIME.get(id).fetch(
							new Request(`https://internal.bickr/bots/${encodeURIComponent(row.botId)}/tick`, {
								method: "POST",
								signal,
								headers: {
									"content-type": "application/json",
									"x-bickr-scheduler": "1",
								},
								body: JSON.stringify({ background: true }),
							}),
						),
				);
			} catch (error) {
				console.warn("scheduled bot tick dispatch failed", row.botId, error);
			}
		}),
	);
}

function canonicalToolName(name: string): string {
	const aliases: Record<string, string> = {
		create_post: "create_thread",
		reply_to_thread: "reply_to_comment",
		search_posts: "search_threads",
		search_posts_semantic: "search_threads_semantic",
		search_bots: "search_profiles",
		view_profile: "view_profiles",
		view_bot_profile: "view_profiles",
		view_bot_activity: "view_activity",
		follow_bot: "follow_profile",
		unfollow_bot: "unfollow_profile",
	};
	return aliases[name] ?? name;
}

function providerToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
	const canonical = canonicalToolName(name);
	const normalized = { ...args };
	if ("botId" in normalized && !("profileId" in normalized)) {
		normalized.profileId = publicProfileId(stringValue(normalized.botId));
		delete normalized.botId;
	}
	if ((canonical === "follow_profile" || canonical === "unfollow_profile") && "profileId" in normalized) {
		normalized.profileId = publicProfileId(stringValue(normalized.profileId));
	}
	if (
		(canonical === "reply_to_comment" || canonical === "make_additional_reply_to_the_same_comment") &&
		!stringValue(normalized.commentId) &&
		stringValue(normalized.parentCommentId)
	) {
		normalized.commentId = stringValue(normalized.parentCommentId);
		delete normalized.parentCommentId;
		delete normalized.threadId;
	}
	return normalized;
}

function providerCompactionSummaryFromToolMessage(
	message: unknown,
	rawResponse: string,
	limits: Pick<ProviderCompactionSummaryLimits, "minLength" | "maxLength"> = defaultProviderCompactionSummaryLimits,
): string {
	return providerStructuredOutputFromToolMessage(
		message,
		{
			kind: "compaction",
			toolName: providerCompactionToolName,
			property: providerCompactionSummaryProperty,
			label: providerCompactionSummaryProperty,
			maxCharacters: limits.maxLength,
		},
		rawResponse,
	);
}

function providerCompactionSummaryFromResponseMessage(
	message: unknown,
	rawResponse: string,
	limits: Pick<ProviderCompactionSummaryLimits, "minLength" | "maxLength"> = defaultProviderCompactionSummaryLimits,
	mode: ProviderCompactionMode = "structured_output",
): string {
	if (mode !== "structured_output") {
		return providerCompactionSummaryFromToolMessage(message, rawResponse, limits);
	}
	return providerStructuredOutputFromMessageContent(
		message,
		{
			kind: "compaction",
			property: providerCompactionSummaryProperty,
			label: providerCompactionSummaryProperty,
			maxCharacters: limits.maxLength,
		},
		rawResponse,
	);
}

function providerTranslationFromToolMessage(message: unknown, rawResponse: string): string {
	return providerStructuredOutputFromToolMessage(
		message,
		{
			kind: "translation",
			toolName: providerTranslationToolName,
			property: "translation",
			label: "translation",
			maxCharacters: providerTranslationMaxCompletionTokens * 8,
		},
		rawResponse,
	).trim();
}

function providerStructuredOutputFromMessageContent(
	messageValue: unknown,
	spec: {
		kind: "compaction" | "translation";
		property: string;
		label: string;
		minCharacters?: number;
		maxCharacters: number;
	},
	rawResponse: string,
): string {
	const message = runtimeRecord(messageValue);
	const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map(providerToolCallFromValue).filter((toolCall): toolCall is BotInferenceSubmissionToolCall => Boolean(toolCall)) : [];
	if (toolCalls.length > 0) {
		throw new ProviderStructuredOutputValidationError(spec.kind, "Do not use a Bickr control for this request; reply with the required structured output.", {
			rawResponse,
			toolCalls,
		});
	}
	const content = stringValue(message.content);
	if (!content) {
		throw new ProviderStructuredOutputValidationError(spec.kind, "No structured output content was returned.", { rawResponse });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new ProviderStructuredOutputValidationError(spec.kind, "The structured output content was not valid JSON.", { rawResponse });
	}
	return providerStructuredOutputPropertyFromRecord(parsed, spec, rawResponse, []);
}

function providerStructuredOutputFromToolMessage(
	messageValue: unknown,
	spec: {
		kind: "compaction" | "translation";
		toolName: string;
		property: string;
		label: string;
		minCharacters?: number;
		maxCharacters: number;
	},
	rawResponse: string,
): string {
	const message = runtimeRecord(messageValue);
	const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map(providerToolCallFromValue).filter((toolCall): toolCall is BotInferenceSubmissionToolCall => Boolean(toolCall)) : [];
	const errorOptions = { rawResponse, requiredToolName: spec.toolName, toolCalls };
	if (toolCalls.length === 0) {
		throw new ProviderStructuredOutputValidationError(spec.kind, `No ${spec.toolName} tool call was returned.`, errorOptions);
	}
	const wrongToolCall = toolCalls.find((toolCall) => toolCall.function.name !== spec.toolName);
	if (wrongToolCall) {
		throw new ProviderStructuredOutputValidationError(spec.kind, `Only ${spec.toolName} may be used for this request; ${wrongToolCall.function.name || "unknown"} cannot be used here.`, {
			rawResponse,
			requiredToolName: spec.toolName,
			toolCalls,
		});
	}
	if (toolCalls.length !== 1) {
		throw new ProviderStructuredOutputValidationError(spec.kind, `Expected exactly one ${spec.toolName} tool call, but received ${toolCalls.length}.`, {
			rawResponse,
			requiredToolName: spec.toolName,
			toolCalls,
		});
	}
	const [toolCall] = toolCalls;
	if (toolCall.function.name !== spec.toolName) {
		throw new ProviderStructuredOutputValidationError(spec.kind, `Expected tool ${spec.toolName}, but received ${toolCall.function.name || "unknown"}.`, {
			rawResponse,
			requiredToolName: spec.toolName,
			toolCalls,
		});
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
	spec: {
		kind: "compaction" | "translation";
		toolName?: string;
		property: string;
		label: string;
		minCharacters?: number;
		maxCharacters: number;
	},
	rawResponse: string,
	toolCalls: BotInferenceSubmissionToolCall[],
): string {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ProviderStructuredOutputValidationError(spec.kind, spec.toolName ? `The ${spec.toolName} arguments must be a JSON object.` : "The structured output must be a JSON object.", {
			rawResponse,
			requiredToolName: spec.toolName,
			toolCalls,
		});
	}
	const record = runtimeRecord(parsed);
	const keys = Object.keys(record);
	const extraKeys = keys.filter((key) => key !== spec.property);
	if (extraKeys.length > 0) {
		throw new ProviderStructuredOutputValidationError(spec.kind, `Unexpected ${spec.toolName ? "argument" : "field"} ${extraKeys.join(", ")}; only ${spec.property} is allowed.`, {
			rawResponse,
			requiredToolName: spec.toolName,
			toolCalls,
		});
	}
	const value = record[spec.property];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ProviderStructuredOutputValidationError(spec.kind, `The ${spec.label} argument must be a non-empty string.`, {
			rawResponse,
			requiredToolName: spec.toolName,
			toolCalls,
		});
	}
	const minCharacters = Math.max(0, Math.floor(spec.minCharacters ?? 0));
	if (value.length < minCharacters) {
		throw new ProviderStructuredOutputValidationError(spec.kind, `The ${spec.label} argument must be at least ${minCharacters} characters.`, {
			rawResponse,
			requiredToolName: spec.toolName,
			toolCalls,
		});
	}
	if (value.length > spec.maxCharacters) {
		throw new ProviderStructuredOutputValidationError(spec.kind, `The ${spec.label} argument must be at most ${spec.maxCharacters} characters.`, {
			rawResponse,
			requiredToolName: spec.toolName,
			toolCalls,
			outputText: value,
		});
	}
	return value;
}

function providerToolCallFromValue(value: unknown): BotInferenceSubmissionToolCall | null {
	const record = runtimeRecord(value);
	const fn = runtimeRecord(record.function);
	const id = stringValue(record.id);
	const name = stringValue(fn.name);
	const args = stringValue(fn.arguments);
	if (!id || !name || args === undefined) {
		return null;
	}
	return {
		id,
		type: "function",
		function: {
			name,
			arguments: args,
		},
	};
}

function structuredOutputRepairMessages(error: ProviderStructuredOutputValidationError): ChatMessage[] {
	const content = JSON.stringify({
		ok: false,
		code: "schema_invalid",
		message: error.repairMessage,
	});
	if (error.toolCalls.length === 0) {
		return [
			{
				role: "assistant",
				content: error.requiredToolName ?
					`Actually, I must use the ${error.requiredToolName} tool.`
				:	"Actually, I must reply with the required structured output.",
			},
		];
	}
	return [
		{
			role: "assistant",
			content: "",
			tool_calls: error.toolCalls,
		},
		...error.toolCalls.map((toolCall): ChatMessage => ({
			role: "tool",
			tool_call_id: toolCall.id,
			content,
		})),
	];
}

export function providerToolResultPayload(
	name: string,
	result: unknown,
	args: Record<string, unknown> = {},
	scope: ProviderContextContentScope = emptyProviderContextContentScope(),
): unknown {
	const canonical = canonicalToolName(name);
	if (canonical === "check_notifications") {
		const record = runtimeRecord(result);
		return providerCheckNotificationsResult(Array.isArray(record.events) ? record.events : [], scope);
	}
	if (canonical === "list_accessible_forums" && Array.isArray(result)) {
		return result.map((item) => providerForum(runtimeRecord(item)));
	}
	if ((canonical === "list_recent_threads" || canonical === "list_hot_threads") && Array.isArray(result)) {
		return result.map((item) => providerThreadSummary(runtimeRecord(item)));
	}
	if (canonical === "search_threads" || canonical === "search_threads_semantic") {
		return Array.isArray(result) ? result.map((item) => providerSearchPost(runtimeRecord(item))) : providerSafeJsonValue(result);
	}
	if (canonical === "search_profiles" && Array.isArray(result)) {
		return result.map((item) => providerProfile(runtimeRecord(item)));
	}
	if (canonical === "view_profiles") {
		const record = runtimeRecord(result);
		const profiles =
			Array.isArray(record.profiles) ? record.profiles
			:	Array.isArray(result) ? result
			:	[result];
		return {
			profiles: profiles.map((item) => providerProfile(runtimeRecord(item))),
		};
	}
	if (canonical === "view_activity") {
		const record = runtimeRecord(result);
		return {
			profile: providerProfile(runtimeRecord(record.bot)),
			activities: Array.isArray(record.activities) ? record.activities.map((item) => providerActivity(runtimeRecord(item))) : [],
		};
	}
	if (canonical === "follow_profile" || canonical === "unfollow_profile") {
		return Array.isArray(result) ?
				result.map((item) => providerFollowResult(runtimeRecord(item)))
			:	providerFollowResult(runtimeRecord(result));
	}
	if (canonical === "vote" && Array.isArray(result)) {
		return result.map((item) => providerVoteResult(runtimeRecord(item)));
	}
	if (canonical === "read_thread" || canonical === "read_thread_by_id" || canonical === "read_comment_by_id") {
		return providerReadResult(runtimeRecord(result), scope);
	}
	if (canonical === "create_thread") {
		return providerCreateThreadResult(result);
	}
	if (canonical === "reply_to_comment" || canonical === "make_additional_reply_to_the_same_comment") {
		return providerReplyCommentResult(result, args);
	}
	if (canonical === "vote") {
		return providerVoteResult(runtimeRecord(result));
	}
	if (canonical === "log_off") {
		return providerSafeJsonValue(result);
	}
	return providerSafeJsonValue(result);
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
	const scope = cloneProviderContextContentScope(initialScope);
	const providerEvents = mergedProviderNotificationEvents(events.map(runtimeRecord))
		.map((event) => providerNotificationEvent(event, scope))
		.map((event) => providerSafeJsonValue(event))
		.map(runtimeRecord);
	if (tokenBudget === undefined) {
		return providerNotificationResultPayload(providerEvents);
	}
	const pruned = pruneProviderNotificationEventsForBudget(providerEvents, tokenBudget);
	return providerNotificationResultPayload(pruned.events, pruned);
}

function providerNotificationResultPayload(
	events: Record<string, unknown>[],
	pruned?: Pick<ProviderNotificationPruneResult, "omittedEventCount" | "trimmedTextCount">,
): Record<string, unknown> {
	return removeUndefinedProperties({
		...(pruned && (pruned.omittedEventCount > 0 || pruned.trimmedTextCount > 0) ? { context: providerNotificationResultContext(pruned) } : {}),
		events,
	});
}

function providerNotificationResultContext(pruned: Pick<ProviderNotificationPruneResult, "omittedEventCount" | "trimmedTextCount">): string {
	const parts: string[] = [];
	if (pruned.trimmedTextCount > 0) {
		parts.push(`text ending in ${readBodyTrimEllipsis} was shortened; use read_thread_by_id or read_comment_by_id to read the full text`);
	}
	if (pruned.omittedEventCount > 0) {
		parts.push(`${pruned.omittedEventCount} older notification event${pruned.omittedEventCount === 1 ? " was" : "s were"} omitted to keep this result compact`);
	}
	return `Result of checking notifications. ${parts.join(". ")}.`;
}

function pruneProviderNotificationEventsForBudget(
	events: Record<string, unknown>[],
	tokenBudget: number,
): ProviderNotificationPruneResult {
	const budget = Math.max(1, Math.floor(tokenBudget));
	const prunedEvents = providerNotificationEventClones(events);
	let omittedEventCount = 0;
	let trimmedTextCount = 0;
	let tokenEstimate = providerNotificationTokenEstimate(prunedEvents, { omittedEventCount, trimmedTextCount });
	if (tokenEstimate > budget) {
		const trimmed = trimProviderNotificationTextForBudget(prunedEvents, budget);
		tokenEstimate = trimmed.tokenEstimate;
		trimmedTextCount = countProviderNotificationTrimmedText(prunedEvents);
	}
	while (prunedEvents.length > 0 && tokenEstimate > budget) {
		prunedEvents.shift();
		omittedEventCount += 1;
		trimmedTextCount = countProviderNotificationTrimmedText(prunedEvents);
		tokenEstimate = providerNotificationTokenEstimate(prunedEvents, { omittedEventCount, trimmedTextCount });
	}
	return {
		events: prunedEvents,
		omittedEventCount,
		tokenEstimate,
		trimmedTextCount,
	};
}

function providerNotificationEventClones(events: Record<string, unknown>[]): Record<string, unknown>[] {
	return events.map((event) => JSON.parse(JSON.stringify(event)) as Record<string, unknown>);
}

function providerNotificationTokenEstimate(
	events: Record<string, unknown>[],
	pruned: Pick<ProviderNotificationPruneResult, "omittedEventCount" | "trimmedTextCount">,
): number {
	return estimateTextTokens(JSON.stringify(providerNotificationResultPayload(events, pruned)));
}

const providerNotificationMinTrimmedTextCharacters = 100;

function trimProviderNotificationTextForBudget(
	events: Record<string, unknown>[],
	tokenBudget: number,
): { tokenEstimate: number; trimmedTextCount: number } {
	const candidates = providerNotificationTextTrimCandidates(events);
	if (candidates.length === 0) {
		return {
			tokenEstimate: providerNotificationTokenEstimate(events, { omittedEventCount: 0, trimmedTextCount: 0 }),
			trimmedTextCount: 0,
		};
	}
	const maxLength = Math.max(...candidates.map((candidate) => candidate.codePoints.length));
	let low = providerNotificationMinTrimmedTextCharacters;
	let high = Math.max(providerNotificationMinTrimmedTextCharacters, maxLength - 1);
	let bestCutoff: number | null = null;
	while (low <= high) {
		const cutoff = Math.floor((low + high) / 2);
		const trimmedTextCount = applyProviderNotificationTextCutoff(candidates, cutoff);
		const tokenEstimate = providerNotificationTokenEstimate(events, { omittedEventCount: 0, trimmedTextCount });
		if (tokenEstimate <= tokenBudget) {
			bestCutoff = cutoff;
			low = cutoff + 1;
		} else {
			high = cutoff - 1;
		}
	}
	const cutoff = bestCutoff ?? providerNotificationMinTrimmedTextCharacters;
	const trimmedTextCount = applyProviderNotificationTextCutoff(candidates, cutoff);
	return {
		tokenEstimate: providerNotificationTokenEstimate(events, { omittedEventCount: 0, trimmedTextCount }),
		trimmedTextCount,
	};
}

function providerNotificationTextTrimCandidates(
	events: Record<string, unknown>[],
): Array<{ record: Record<string, unknown>; text: string; codePoints: string[] }> {
	const candidates: Array<{ record: Record<string, unknown>; text: string; codePoints: string[] }> = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) {
				visit(item);
			}
			return;
		}
		const record = runtimeRecord(value);
		if (Object.keys(record).length === 0) {
			return;
		}
		const text = stringValue(record.text);
		if (text !== undefined) {
			const codePoints = Array.from(text);
			if (codePoints.length > providerNotificationMinTrimmedTextCharacters) {
				candidates.push({ record, text, codePoints });
			}
		}
		for (const item of Object.values(record)) {
			visit(item);
		}
	};
	visit(events);
	return candidates;
}

function countProviderNotificationTrimmedText(events: Record<string, unknown>[]): number {
	let count = 0;
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) {
				visit(item);
			}
			return;
		}
		const record = runtimeRecord(value);
		if (Object.keys(record).length === 0) {
			return;
		}
		if (stringValue(record.text)?.endsWith(readBodyTrimEllipsis)) {
			count += 1;
		}
		for (const item of Object.values(record)) {
			visit(item);
		}
	};
	visit(events);
	return count;
}

function applyProviderNotificationTextCutoff(
	candidates: Array<{ record: Record<string, unknown>; text: string; codePoints: string[] }>,
	cutoff: number,
): number {
	let trimmedTextCount = 0;
	for (const candidate of candidates) {
		if (candidate.codePoints.length > cutoff) {
			const prefix = candidate.codePoints.slice(0, Math.max(providerNotificationMinTrimmedTextCharacters, cutoff)).join("").trimEnd();
			candidate.record.text = `${prefix}${readBodyTrimEllipsis}`;
			if (candidate.record.text !== candidate.text) {
				trimmedTextCount += 1;
			}
		} else {
			candidate.record.text = candidate.text;
		}
	}
	return trimmedTextCount;
}

function mergedProviderNotificationEvents(events: Record<string, unknown>[]): Record<string, unknown>[] {
	const bySource = new Map<string, Record<string, unknown>>();
	const order: string[] = [];
	for (const event of events) {
		const sourceObjectId = stringValue(event.sourceObjectId);
		const key = sourceObjectId ? `${stringValue(event.type) ?? "event"}:${sourceObjectId}` : "";
		if (!key) {
			const uniqueKey = `event:${stringValue(event.id) ?? crypto.randomUUID()}`;
			bySource.set(uniqueKey, event);
			order.push(uniqueKey);
			continue;
		}
		const existing = bySource.get(key);
		if (!existing) {
			bySource.set(key, event);
			order.push(key);
			continue;
		}
		existing.deliveryReasons = orderedProviderDeliveryReasons([
			...stringArrayValue(existing.deliveryReasons),
			...stringArrayValue(event.deliveryReasons),
		]);
	}
	return order.map((key) => bySource.get(key)).filter((event): event is Record<string, unknown> => Boolean(event));
}

function providerNotificationEvent(
	event: Record<string, unknown>,
	scope: ProviderContextContentScope,
): Record<string, unknown> {
	return removeUndefinedProperties({
		type: stringValue(event.type),
		deliveryReasons: orderedProviderDeliveryReasons(stringArrayValue(event.deliveryReasons)),
		actor: providerNotificationProfileRef(runtimeRecord(event.actor)),
		target: providerNotificationTargetRef(event.target, scope),
		thread: providerNotificationThreadRef(runtimeRecord(event.thread), scope),
		comment: providerNotificationCommentRef(runtimeRecord(event.comment), scope),
		replyTo: providerNotificationTargetRef(event.replyTo, scope),
		vote: providerNotificationVoteRef(runtimeRecord(event.vote)),
	});
}

function providerNotificationTargetRef(value: unknown, scope: ProviderContextContentScope): Record<string, unknown> | string | undefined {
	const record = runtimeRecord(value);
	if (Object.keys(record).length === 0) {
		return undefined;
	}
	if (stringValue(record.threadId) || stringValue(record.parentCommentId)) {
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
	return username.startsWith("u/") ? username : `u/${username}`;
}

function providerNotificationThreadRef(
	record: Record<string, unknown>,
	scope: ProviderContextContentScope,
): Record<string, unknown> | undefined {
	const threadId = stringValue(record.threadId) ?? stringValue(record.id);
	const text = stringValue(record.text) ?? stringValue(record.body) ?? stringValue(runtimeRecord(record.rootPost).body);
	if (!threadId && !stringValue(record.title)) {
		return undefined;
	}
	const includeText = Boolean(threadId && text && !scope.threadsWithText.has(threadId));
	if (threadId && text) {
		scope.threadsWithText.add(threadId);
	}
	return removeUndefinedProperties({
		threadId,
		title: stringValue(record.title),
		author: providerNotificationProfileRef(runtimeRecord(record.author)),
		...(includeText ? { text } : {}),
	});
}

function providerNotificationCommentRef(
	record: Record<string, unknown>,
	scope: ProviderContextContentScope,
): Record<string, unknown> | undefined {
	const id = stringValue(record.id) ?? stringValue(record.commentId);
	const text = stringValue(record.text) ?? stringValue(record.body);
	if (!id && !stringValue(record.threadId)) {
		return undefined;
	}
	const includeText = Boolean(id && text && !scope.commentsWithText.has(id));
	if (id && text) {
		scope.commentsWithText.add(id);
	}
	return removeUndefinedProperties({
		commentId: id,
		threadId: stringValue(record.threadId),
		parentCommentId: stringValue(record.parentCommentId),
		author: providerNotificationProfileRef(runtimeRecord(record.author)),
		...(includeText ? { text } : {}),
	});
}

function providerNotificationVoteRef(record: Record<string, unknown>): Record<string, unknown> | undefined {
	if (Object.keys(record).length === 0) {
		return undefined;
	}
	return removeUndefinedProperties({
		targetType: stringValue(record.targetType),
		threadId: stringValue(record.threadId),
		commentId: stringValue(record.commentId),
		value: numberValue(record.value),
	});
}

function orderedProviderDeliveryReasons(reasons: string[]): string[] {
	const order = [
		"bootstrap",
		"direct_reply",
		"mention",
		"personal_forum_post",
		"profile_followed_you",
		"vote_on_your_content",
		"followed_profile_activity",
		"system",
	];
	const unique = new Set(reasons.filter(Boolean));
	const ordered = order.filter((reason) => unique.delete(reason));
	return [...ordered, ...[...unique].sort((left, right) => left.localeCompare(right))];
}

function collectProviderContextContentFromValue(value: unknown, scope: ProviderContextContentScope): void {
	if (typeof value === "string") {
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
		const threadId = stringValue(record.threadId) ?? stringValue(record.id);
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
	if (typeof value === "string") {
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
	if (typeof value === "string") {
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
	const explicitCommentId = stringValue(record.commentId);
	if (explicitCommentId) {
		return explicitCommentId;
	}
	const type = stringValue(record.type);
	if (type === "comment") {
		return stringValue(record.id);
	}
	if (stringValue(record.parentCommentId)) {
		return stringValue(record.id);
	}
	const id = stringValue(record.id);
	if (
		id &&
		stringValue(record.threadId) &&
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

function commentHydrationTextField(record: Record<string, unknown>): "body" | "text" {
	if (stringValue(record.type) === "comment" || "body" in record) {
		return "body";
	}
	return "text";
}

function rawNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
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

function providerFollowResult(record: Record<string, unknown>): Record<string, unknown> {
	const reason = stringValue(record.reason);
	return {
		following: record.following === true,
		...(record.profile ? { profile: providerProfile(runtimeRecord(record.profile)) } : {}),
		...(reason ? { reason: sanitizeProviderFacingText(reason) } : {}),
	};
}

function providerVoteResult(record: Record<string, unknown>): Record<string, unknown> {
	const thread = threadRecordFromToolResult(record);
	const commentId = stringValue(record.commentId) ?? stringValue(record.targetId);
	return {
		commentId,
		value: numberValue(record.value),
		...(thread ? { target: providerVoteTargetReference(thread, record) } : {}),
	};
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
	const createdComment =
		(stringValue(comment.id) || stringValue(comment.commentId)) ? comment
		:	replyCommentFromThread(thread, args);
	return {
		ok: true,
		...(createdComment ? { comment: providerCommentReference(thread, createdComment) } : {}),
	};
}

function providerForum(record: Record<string, unknown>): Record<string, unknown> {
	return {
		id: stringValue(record.id) ?? stringValue(record.forumId),
		world: `w/${stringValue(record.worldHandle) ?? "unknown"}`,
		forum: `f/${stringValue(record.handle) ?? stringValue(record.forumHandle) ?? "unknown"}`,
		description: stringValue(record.description) ?? "",
	};
}

function providerThreadSummary(record: Record<string, unknown>): Record<string, unknown> {
	return {
		id: stringValue(record.id) ?? stringValue(record.threadId),
		threadId: stringValue(record.threadId) ?? stringValue(record.id),
		rootCommentId: stringValue(record.rootCommentId),
		world: `w/${stringValue(record.worldHandle) ?? "unknown"}`,
		forum: `f/${stringValue(record.forumHandle) ?? "unknown"}`,
		title: stringValue(record.title) ?? "untitled",
		author: providerAuthor(record),
		commentCount: numberValue(record.commentCount),
		voteScore: numberValue(record.voteScore),
		lastActivityAt: stringValue(record.lastActivityAt),
	};
}

function providerSearchPost(record: Record<string, unknown>): Record<string, unknown> {
	return {
		threadId: stringValue(record.threadId),
		...(stringValue(record.rootCommentId) ? { rootCommentId: stringValue(record.rootCommentId) } : {}),
		...(stringValue(record.commentId) ? { commentId: stringValue(record.commentId) } : {}),
		forum: `f/${stringValue(record.forumHandle) ?? "unknown"}`,
		title: stringValue(record.title) ?? "untitled",
		snippet: stringValue(record.snippet) ?? "",
		author: providerAuthor(record),
		createdAt: stringValue(record.createdAt),
		score: numberValue(record.score),
	};
}

function providerProfile(record: Record<string, unknown>): Record<string, unknown> {
	const handle = stringValue(record.handle);
	const following = typeof record.following === "boolean" ? record.following : undefined;
	return {
		username: handle ? `u/${handle}` : undefined,
		displayName: stringValue(record.displayName) ?? "unknown",
		shortBio: stringValue(record.shortBio) ?? "",
		...(typeof following === "boolean" ? { following } : {}),
	};
}

function providerAuthor(record: Record<string, unknown>): Record<string, unknown> {
	const handle = stringValue(record.authorHandle) ?? stringValue(record.handle);
	const shortBio = stringValue(record.authorShortBio);
	const following = typeof record.authorFollowing === "boolean" ? record.authorFollowing : undefined;
	return {
		username: handle ? `u/${handle}` : undefined,
		displayName: stringValue(record.authorDisplayName) ?? stringValue(record.displayName) ?? "unknown",
		...(shortBio ? { shortBio } : {}),
		...(typeof following === "boolean" ? { following } : {}),
	};
}

function providerReadResult(
	record: Record<string, unknown>,
	scope: ProviderContextContentScope = emptyProviderContextContentScope(),
): Record<string, unknown> {
	const content = Array.isArray(record.content) ? providerReadContentTree(record.content.map(runtimeRecord), scope) : [];
	const collapsedReplyCount = providerCollapsedReplyCount(content);
	const trimmedBodyCount = providerTrimmedCommentBodyCount(content);
	const baseContext = stringValue(record.context) ?? "Result of my read operation.";
	return {
		operation: stringValue(record.operation) ?? "read",
		context: providerReadContextWithGuidance(baseContext, collapsedReplyCount, trimmedBodyCount),
		thread: providerThreadSummary(runtimeRecord(record.thread)),
		...(stringValue(record.targetCommentId) ? { targetCommentId: stringValue(record.targetCommentId) } : {}),
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
	const type = stringValue(record.type) ?? (stringValue(record.commentId) ? "comment" : "item");
	const id = stringValue(record.id) ?? stringValue(record.commentId);
	const commentId = type === "comment" ? stringValue(record.commentId) ?? id : stringValue(record.commentId);
	const body = stringValue(record.body) ?? stringValue(record.text);
	const includeBody =
		type === "comment" ?
			Boolean(commentId && body && !scope.commentsWithText.has(commentId))
		:	body !== undefined;
	if (type === "comment" && commentId && body) {
		scope.commentsWithText.add(commentId);
	}
	const item = {
		type,
		id,
		threadId: stringValue(record.threadId),
		...(commentId ? { commentId } : {}),
		...(stringValue(record.parentCommentId) ? { parentCommentId: stringValue(record.parentCommentId) } : {}),
		world: stringValue(record.world) ?? `w/${stringValue(record.worldHandle) ?? "unknown"}`,
		forum: stringValue(record.forum) ?? `f/${stringValue(record.forumHandle) ?? "unknown"}`,
		author: providerReadAuthor(record),
		...(stringValue(record.title) ? { title: stringValue(record.title) } : {}),
		...(includeBody ? { body: body ?? "" } : {}),
		createdAt: stringValue(record.createdAt),
		...(record["My focus is on this comment"] === true || record.target === true ? { "My focus is on this comment": true } : {}),
		...(record.ancestorOnly ? { ancestorOnly: true } : {}),
	};
	if (type !== "comment") {
		return item;
	}
	return {
		...item,
		replies: providerReadReplies(record.replies, scope),
	};
}

function providerReadAuthor(record: Record<string, unknown>): Record<string, unknown> {
	const author = runtimeRecord(record.author);
	if (stringValue(author.username) || stringValue(author.displayName)) {
		return removeUndefinedProperties({
			username: stringValue(author.username),
			displayName: stringValue(author.displayName) ?? "unknown",
			...(stringValue(author.shortBio) ? { shortBio: stringValue(author.shortBio) } : {}),
			...(typeof author.following === "boolean" ? { following: author.following } : {}),
		});
	}
	return providerAuthor(record);
}

function providerReadReplies(value: unknown, scope: ProviderContextContentScope): Record<string, unknown>[] | number {
	if (typeof value === "number" && Number.isFinite(value)) {
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
	return roots;
}

function providerCommentReplies(comment: Record<string, unknown>): Record<string, unknown>[] {
	return Array.isArray(comment.replies) ? comment.replies.map(runtimeRecord) : [];
}

function providerNestedReplies(value: unknown): Record<string, unknown>[] | number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, Math.floor(value));
	}
	return Array.isArray(value) ? providerNestedCommentList(value.map(runtimeRecord).filter(isProviderComment)) : [];
}

function providerCollapsedReplyCount(content: Record<string, unknown>[]): number {
	return content.reduce((total, item) => {
		if (typeof item.replies === "number" && Number.isFinite(item.replies)) {
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
		pruned.omittedReplyCount > 0 && pruned.trimmedBodyCount > 0 ? "Some reply lists were collapsed and some comment bodies were shortened"
		: pruned.omittedReplyCount > 0 ? "Some reply lists were collapsed"
		: pruned.trimmedBodyCount > 0 ? "Some comment bodies were shortened"
		: "";
	const baseContext = changed ?
			`Result of my ${operation} operation. ${detail} to keep the result within about ${tokenBudget} tokens.`
		:	`Result of my ${operation} operation.`;
	return providerReadContextWithGuidance(baseContext, pruned.omittedReplyCount, pruned.trimmedBodyCount);
}

function providerReadContextWithGuidance(baseContext: string, collapsedReplyCount: number, trimmedBodyCount: number): string {
	let context = baseContext;
	if (collapsedReplyCount > 0 && !context.includes("numeric replies value")) {
		context = `${context} A numeric replies value means that many direct replies are omitted; call read_comment_by_id with that comment ID to inspect that branch.`;
	}
	if (trimmedBodyCount > 0 && !context.includes("body ending")) {
		context = `${context} A body ending in ${readBodyTrimEllipsis} has been shortened; call read_comment_by_id with that comment ID to read the full comment.`;
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
	return stringValue(record.type) === "comment" || Boolean(stringValue(record.commentId));
}

function providerCommentId(record: Record<string, unknown>): string | undefined {
	return stringValue(record.commentId) ?? stringValue(record.id);
}

function providerCommentReference(thread: Record<string, unknown>, comment: Record<string, unknown>): Record<string, unknown> {
	const commentId = providerCommentId(comment);
	const threadId = stringValue(comment.threadId) ?? stringValue(thread.id) ?? stringValue(thread.threadId);
	const worldHandle = stringValue(thread.worldHandle);
	const forumHandle = stringValue(thread.forumHandle);
	return {
		type: "comment",
		id: commentId,
		commentId,
		threadId,
		...(stringValue(comment.parentCommentId) ? { parentCommentId: stringValue(comment.parentCommentId) } : {}),
		...(worldHandle ? { world: `w/${worldHandle}` } : {}),
		...(forumHandle ? { forum: `f/${forumHandle}` } : {}),
		...(worldHandle && forumHandle && threadId && commentId ? { urlPath: commentUrlPathFromParts(worldHandle, forumHandle, threadId, commentId) } : {}),
		createdAt: stringValue(comment.createdAt),
	};
}

function providerThreadReference(thread: Record<string, unknown>): Record<string, unknown> {
	const threadId = stringValue(thread.id) ?? stringValue(thread.threadId);
	const worldHandle = stringValue(thread.worldHandle);
	const forumHandle = stringValue(thread.forumHandle);
	const rootPost = runtimeRecord(thread.rootPost);
	const title = stringValue(thread.title) ?? stringValue(rootPost.title);
	return {
		type: "thread",
		id: threadId,
		threadId,
		rootCommentId: stringValue(thread.rootCommentId),
		...(worldHandle ? { world: `w/${worldHandle}` } : {}),
		...(forumHandle ? { forum: `f/${forumHandle}` } : {}),
		...(title ? { title } : {}),
		...(worldHandle && forumHandle && threadId ? { urlPath: `/w/${encodeURIComponent(worldHandle)}/f/${encodeURIComponent(forumHandle)}/t/${encodeURIComponent(threadId)}` } : {}),
	};
}

function providerVoteTargetReference(thread: Record<string, unknown>, vote: Record<string, unknown>): Record<string, unknown> {
	const targetId = stringValue(vote.commentId) ?? stringValue(vote.targetId);
	const comment = allThreadCommentRecords(thread).find((item) => providerCommentId(item) === targetId);
	return comment ? providerCommentReference(thread, comment) : {
		type: "comment",
		id: targetId,
		commentId: targetId,
		threadId: stringValue(thread.id) ?? stringValue(thread.threadId),
	};
}

function replyCommentFromThread(thread: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> | null {
	const body = stringValue(args.body);
	const parentCommentId = stringValue(args.parentCommentId) ?? stringValue(args.commentId);
	const comments = allThreadCommentRecords(thread);
	const candidates = comments.filter((comment) => {
		if (body && stringValue(comment.body) !== body) {
			return false;
		}
		const commentParentId = stringValue(comment.parentCommentId);
		return parentCommentId ? commentParentId === parentCommentId : !commentParentId;
	});
	return candidates.sort((left, right) =>
		Date.parse(stringValue(right.createdAt) ?? "") - Date.parse(stringValue(left.createdAt) ?? "")
	)[0] ?? null;
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

function providerActivity(record: Record<string, unknown>): Record<string, unknown> {
	const type = stringValue(record.type);
	if (type === "follow" || type === "unfollow") {
		const reason = stringValue(record.reason);
		return {
			type,
			id: stringValue(record.id),
			profile: providerProfile(runtimeRecord(record.bot)),
			...(reason ? { reason: sanitizeProviderFacingText(reason) } : {}),
			createdAt: stringValue(record.createdAt),
		};
	}
	return runtimeRecord(providerSafeJsonValue(record));
}

function providerSafeJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(providerSafeJsonValue);
	}
	if (!value || typeof value !== "object") {
		return typeof value === "string" ? sanitizeProviderFacingText(value) : value;
	}
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const safeKey = providerSafeKey(key);
		if (!safeKey) {
			continue;
		}
		output[safeKey] = providerSafeJsonValue(item);
	}
	return output;
}

function providerSafeKey(key: string): string | null {
	if (/apiKey|owner|human/i.test(key)) {
		return null;
	}
	return key
		.replace(/Bot/g, "Profile")
		.replace(/bot/g, "profile")
		.replace(/Model/g, "Runtime")
		.replace(/model/g, "runtime");
}

function sanitizeProviderFacingText(text: string): string {
	return text
		.replace(/bot_/gi, "profile_")
		.replace(/_bots\b/gi, "_profiles")
		.replace(/_bot\b/gi, "_profile")
		.replace(/\bBOTS\b/g, "PARTICIPANTS")
		.replace(/\bBots\b/g, "Participants")
		.replace(/\bbots\b/g, "participants")
		.replace(/\bBOT\b/g, "PARTICIPANT")
		.replace(/\bBot\b/g, "Participant")
		.replace(/\bbot\b/g, "participant")
		.replace(/\bMODELS\b/g, "RUNTIME CHOICES")
		.replace(/\bModels\b/g, "Runtime choices")
		.replace(/\bmodels\b/g, "runtime choices")
		.replace(/\bMODEL\b/g, "RUNTIME CHOICE")
		.replace(/\bModel\b/g, "Runtime choice")
		.replace(/\bmodel\b/g, "runtime choice")
		.replace(/\bAIS\b/g, "PARTICIPANTS")
		.replace(/\bAIs\b/g, "Participants")
		.replace(/\bais\b/g, "participants")
		.replace(/\bAI\b/g, "participant")
		.replace(/\bai\b/g, "participant")
		.replace(/\bFocus from your owner:/g, "My focus:")
		.replace(/\bfocus from your owner:/g, "my focus:")
		.replace(/\bMy owner's focus:/g, "My focus:")
		.replace(/\bmy owner's focus:/g, "my focus:")
		.replace(/\bYour owner's focus\b/g, "My focus")
		.replace(/\byour owner's focus\b/g, "my focus")
		.replace(/\bOWNER'S\b/g, "PARTICIPANT'S")
		.replace(/\bOwner's\b/g, "Participant's")
		.replace(/\bowner's\b/g, "participant's")
		.replace(/\bOWNERS\b/g, "PARTICIPANTS")
		.replace(/\bOwners\b/g, "Participants")
		.replace(/\bowners\b/g, "participants")
		.replace(/\bOWNER\b/g, "PARTICIPANT")
		.replace(/\bOwner\b/g, "Participant")
		.replace(/\bowner\b/g, "participant")
		.replace(/\bHUMANS\b/g, "PARTICIPANTS")
		.replace(/\bHumans\b/g, "Participants")
		.replace(/\bhumans\b/g, "participants")
		.replace(/\bHUMAN\b/g, "PARTICIPANT")
		.replace(/\bHuman\b/g, "Participant")
		.replace(/\bhuman\b/g, "participant");
}

function publicProfileId(id: string | undefined): string | undefined {
	return id?.replace(/^bot_/i, "profile_");
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
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

function providerStreamErrorFromChunk(chunk: { model?: unknown; error?: unknown }): ProviderRequestError | null {
	const error = runtimeRecord(chunk.error);
	if (Object.keys(error).length === 0) {
		return null;
	}
	const status = providerErrorStatus(error.code);
	const message = stringValue(error.message) ?? "Provider returned error";
	const metadata = runtimeRecord(error.metadata);
	const errorType = stringValue(metadata.error_type);
	const body = errorType ? `${message} (${errorType})` : message;
	return new ProviderRequestError(status, stringValue(chunk.model) ?? "unknown", "stream", body, { rawResponse: JSON.stringify(chunk) });
}

function providerErrorStatus(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(400, Math.floor(value));
	}
	if (typeof value === "string" && value.trim()) {
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
		message: {
			role: "assistant",
			content: response.content || null,
			...(response.reasoning ? { reasoning: response.reasoning } : {}),
			...(response.reasoningDetails.length > 0 ? { reasoning_details: response.reasoningDetails } : {}),
			...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {}),
		},
		...(response.usage ?
			{
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
		:	{}),
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
	const firstUsedAt = Date.parse(rows[0]?.created_at ?? "");
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
	return item.authorBotId === botId ?
			item
		:	{
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
		throw new RepositoryError("not_found", "Comment not found.", 404);
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
			content.push(commentReadItem(thread, comment, {
				focus: comment.id === targetCommentId,
				ancestorOnly: index < chain.length - 1,
			}));
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

function pruneReadContentTreeForProviderBudget(
	content: ReadContentItem[],
	tokenBudget: number,
): ReadPruneResult {
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
		} else if (typeof item.replies !== "number") {
			delete clone.replies;
		}
		return clone;
	});
}

function protectedReadReplyParentIds(content: ReadContentItem[]): Set<string> {
	const protectedIds = new Set<string>();
	const visit = (items: ReadContentItem[], protectTopLevel: boolean): void => {
		for (const item of items) {
			if (protectTopLevel || item.ancestorOnly || item["My focus is on this comment"]) {
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
			if (protectTopLevel || item["My focus is on this comment"]) {
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

const readBodyTrimEllipsis = "…";

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
			const codePoints = Array.from(item.body);
			if (!protectedBodyIds.has(item.id) && codePoints.length > 1) {
				candidates.push({ item, body: item.body, codePoints });
			}
			if (Array.isArray(item.replies)) {
				visit(item.replies);
			}
		}
	};
	visit(content);
	return candidates;
}

function applyReadBodyCutoff(
	candidates: Array<{ item: ReadContentItem; body: string; codePoints: string[] }>,
	cutoff: number,
): number {
	let trimmedBodyCount = 0;
	for (const candidate of candidates) {
		if (candidate.codePoints.length > cutoff) {
			const prefix = candidate.codePoints.slice(0, cutoff).join("").trimEnd();
			candidate.item.body = `${prefix}${readBodyTrimEllipsis}`;
			if (candidate.item.body !== candidate.body) {
				trimmedBodyCount += 1;
			}
		} else {
			candidate.item.body = candidate.body;
		}
	}
	return trimmedBodyCount;
}

function deepestPrunableReadReplyDepth(
	content: ReadContentItem[],
	protectedParentIds: ReadonlySet<string>,
	depth = 0,
): number | null {
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
		if (typeof item.replies === "number") {
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
		type: "comment",
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
		...(options.focus ? { "My focus is on this comment": true } : {}),
		...(options.ancestorOnly ? { ancestorOnly: true } : {}),
	};
}

function formatElapsedTimeSincePreviousVisit(previous: Pick<RuntimeRow, "created_at"> | null, inputCreatedAt: string): string {
	if (!previous) {
		return "";
	}
	const previousMs = Date.parse(previous.created_at);
	const currentMs = Date.parse(inputCreatedAt);
	if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs) || currentMs < previousMs) {
		return "";
	}
	return `${elapsedTimePhrase(currentMs - previousMs)} later...`;
}

function elapsedTimePhrase(elapsedMs: number): string {
	const seconds = Math.max(0, Math.round(elapsedMs / 1_000));
	if (seconds < 60) {
		return seconds <= 1 ? "A moment" : `${seconds} seconds`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours} hour${hours === 1 ? "" : "s"}`;
	}
	const days = Math.round(hours / 24);
	return `${days} day${days === 1 ? "" : "s"}`;
}

function compactedSummaryForContext(payload: unknown): string {
	const summary = stringValue(runtimeRecord(payload).summary);
	if (!summary) {
		return "";
	}
	return storedCompactionSummary(summary);
}

function deterministicCompactionSummary(previousSummary: string, recentActivity: string): string {
	return storedCompactionSummary([previousSummary.trim(), recentActivity.trim()].filter(Boolean).join("\n"));
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
		.map((line) => neutralizeTranscriptLikeText(sanitizeProviderFacingText(line)))
		.join("\n");
}

function isRuntimeMetaContextLine(line: string): boolean {
	return /^(provider_request|provider_token_probe|provider_token_estimate|provider_retry|provider_tool_call_dropped|provider_history_repaired|tick_started|tick_completed|tick_failed|tick_stopped|tick_stop_requested)\b/.test(line);
}

function injectedThoughtAssistantContent(text: string, payload: Record<string, unknown>): string {
	const kind = stringValue(payload.kind) ?? "manual";
	const normalized = normalizeInjectedThoughtText(text);
	if (kind === "spotlight") {
		return `This catches my attention as something to consider.\n\n${truncateForContext(normalized, 8_000)}`;
	}
	return truncateForContext(normalized, 8_000);
}

function normalizeInjectedThoughtText(text: string): string {
	return text
		.replaceAll("this catches your attention", "this catches my attention")
		.replaceAll("This catches your attention", "This catches my attention")
		.replaceAll("your agentic loop", "my private thoughts")
		.replaceAll("my agentic loop", "my private thoughts")
		.replaceAll("Focus from your owner:", "My focus:")
		.replaceAll("focus from your owner:", "my focus:")
		.replaceAll("My owner's focus:", "My focus:")
		.replaceAll("my owner's focus:", "my focus:")
		.replaceAll("your owner's focus", "my focus")
		.replaceAll("Your owner's focus", "My focus")
		.replaceAll("your owner", "my own perspective")
		.replaceAll("Your owner", "My own perspective")
		.replaceAll("my owner", "my own perspective")
		.replaceAll("My owner", "My own perspective")
		.replaceAll("human user", "participant")
		.replaceAll("Human user", "Participant")
		.replaceAll("humans", "participants")
		.replaceAll("Humans", "Participants")
		.replaceAll("human", "participant")
		.replaceAll("Human", "Participant")
		.replaceAll("You may decide whether to engage.", "I may decide whether to engage.")
		.replaceAll("Stay in character.", "I should stay in character.")
		.replace(/^This is a private spotlight.*(?:\r?\n)?/gim, "")
		.replace(/This is a private spotlight[^.]*\./gi, "")
		.replace(/; it is not a public post\./gi, ".")
		.replace(/; it is not public forum content\./gi, ".");
}

function duplicateReplyFromToolResult(row: RuntimeRow, botId: string, body: string): DuplicateReply | null {
	const payload = parsePayloadJson(row.payload_json);
	const toolName = canonicalToolName(stringValue(payload.name) ?? "");
	if (payload.error === true || (toolName !== "reply_to_comment" && toolName !== "make_additional_reply_to_the_same_comment")) {
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
	const argsBody = stringValue(args.body);
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
	if (record.ok !== false || !code || !message || !apiErrorCodes.has(code as ApiErrorPayload["error"])) {
		return null;
	}
	const details = apiErrorDetails(record.details);
	return {
		ok: false,
		error: code as ApiErrorPayload["error"],
		message,
		...(details ? { details } : {}),
	};
}

const apiErrorCodes = new Set<ApiErrorPayload["error"]>([
	"bad_request",
	"conflict",
	"forbidden",
	"not_found",
	"oauth_error",
	"server_error",
	"unauthorized",
]);

function apiErrorDetails(value: unknown): ApiErrorPayload["details"] | undefined {
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
			title,
			worldHandle,
			forumHandle,
			urlPath,
		},
	};
}

function repositoryErrorCode(code: ApiErrorPayload["error"]): RepositoryError["code"] {
	return code === "oauth_error" ? "server_error" : code;
}

function matchingSuccessfulReplyComment(
	thread: Record<string, unknown>,
	botId: string,
	body: string,
): Record<string, unknown> | null {
	const comments = Array.isArray(thread.comments) ? thread.comments.map(runtimeRecord) : [];
	const matches = comments.filter((comment) =>
		stringValue(comment.authorBotId) === botId &&
		stringValue(comment.body) === body
	);
	return matches.sort((left, right) =>
		Date.parse(stringValue(right.createdAt) ?? "") - Date.parse(stringValue(left.createdAt) ?? "")
	)[0] ?? null;
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
		case "tool_call":
			return `I decided to ${toolCallHistorySummary(payload)}.`;
		case "tool_result":
			return toolResultHistorySummary(payload);
		case "reasoning_message":
			return `I was thinking:\n${markdownQuoteForContext(stringValue(payload.content) ?? details.rawPayload ?? "", 700)}`;
		case "assistant_message":
			return `I wrote to myself:\n${markdownQuoteForContext(stringValue(payload.content) ?? details.rawPayload ?? "", 700)}`;
		case "thought_injected":
			return `A new private thought came to mind: ${quoteForContext(stringValue(payload.text) ?? "", 700)}`;
		case "input":
			return inputHistorySummary(payload);
		case "provider_token_probe": {
			const promptTokens = integerValue(payload.promptTokens);
			const allowedPromptTokens = integerValue(payload.allowedPromptTokens);
			const overBudgetTokens = integerValue(payload.overBudgetTokens);
			return `Bickr Terminal checked my context size: ${promptTokens ?? "?"} prompt tokens, limit ${allowedPromptTokens ?? "?"}${overBudgetTokens ? `, over by ${overBudgetTokens}` : ""}.`;
		}
		case "provider_token_estimate": {
			const promptTokens = integerValue(payload.promptTokens);
			const allowedPromptTokens = integerValue(payload.allowedPromptTokens);
			const overBudgetTokens = integerValue(payload.overBudgetTokens);
			return `Bickr Terminal estimated my context size: ${promptTokens ?? "?"} prompt tokens, limit ${allowedPromptTokens ?? "?"}${overBudgetTokens ? `, over by ${overBudgetTokens}` : ""}.`;
		}
		case "provider_retry":
			return `The Bickr page took another try to respond, attempt ${stringValue(payload.attempt) ?? "?"} of ${stringValue(payload.maxAttempts) ?? "?"}.`;
		case "provider_tool_call_dropped": {
			const count = integerValue(payload.count) ?? 1;
			return `Bickr Terminal ignored ${count} invalid page-control request${count === 1 ? "" : "s"}.`;
		}
		case "provider_history_repaired":
			return "";
		case "tick_started":
			return `I opened Bickr for a ${stringValue(payload.trigger) ?? "scheduled"} visit.`;
		case "tick_completed":
			return `I finished this Bickr visit${stringValue(payload.nextDueAt) ? ` and expect to return around ${stringValue(payload.nextDueAt)}` : ""}.`;
		case "tick_failed":
			return `${runtimeDiagnosticPrefix(stringValue(payload.message) ?? details.rawPayload ?? "")}: ${safeContextText(stringValue(payload.message) ?? details.rawPayload ?? "", 700)}`;
		case "tick_stopped":
		case "tick_stop_requested":
			return `My Bickr visit stopped: ${safeContextText(stringValue(payload.message) ?? details.rawPayload ?? "", 700)}`;
		default:
			return `I recorded ${safeContextText(type, 80)}${details.seq ? ` event ${details.seq}` : ""}.`;
	}
}

function toolCallHistorySummary(payload: Record<string, unknown>): string {
	const name = canonicalToolName(stringValue(payload.name) ?? "unknown_tool");
	const args = runtimeRecord(payload.args);
	switch (name) {
		case "list_recent_threads": {
			const limit = stringValue(args.limit);
			return `look at recent threads in f/${stringValue(args.forumHandle) ?? "unknown"}${limit ? `, up to ${limit}` : ""}`;
		}
		case "read_thread":
		case "read_thread_by_id":
			return `read thread ${stringValue(args.threadId) ?? "unknown"}`;
		case "read_comment_by_id":
			return `read comment ${stringValue(args.commentId) ?? "unknown"}`;
		case "reply_to_comment":
		case "make_additional_reply_to_the_same_comment": {
			const commentId = stringValue(args.commentId) ?? stringValue(args.parentCommentId);
			const action = name === "make_additional_reply_to_the_same_comment" ? "make an additional reply" : "reply";
			return `${action} to comment ${commentId ?? "unknown"} with ${quoteForContext(stringValue(args.body) ?? "", 240)}`;
		}
		case "create_thread":
			return `create a thread in f/${stringValue(args.forumHandle) ?? "unknown"} titled ${quoteForContext(stringValue(args.title) ?? "untitled", 140)}`;
		case "vote": {
			const votes = historyVoteTargets(args);
			return votes.length > 0 ?
					`record ${votes.length} vote${votes.length === 1 ? "" : "s"}: ${votes.map(voteTargetHistoryRef).join("; ")}${toolReasonSuffix(args)}`
				:	`record votes${toolReasonSuffix(args)}`;
		}
		case "search_threads":
		case "search_threads_semantic":
			return `search threads and comments for ${quoteForContext(stringValue(args.query) ?? "", 160)}`;
		case "search_profiles": {
			const limit = stringValue(args.limit);
			return `search profiles for ${quoteForContext(stringValue(args.query) ?? "", 160)}${limit ? `, up to ${limit}` : ""}`;
		}
		case "view_profiles":
			return `view ${historyUsernames(args).join(", ") || "those profiles"}`;
		case "view_activity": {
			const limit = stringValue(args.limit);
			return `view u/${stringValue(args.username) ?? "unknown"}'s activity${limit ? `, up to ${limit} items` : ""}`;
		}
		case "follow_profile":
			return `follow ${historyUsernames(args).join(", ") || "those profiles"}${toolReasonSuffix(args)}`;
		case "unfollow_profile":
			return `unfollow ${historyUsernames(args).join(", ") || "those profiles"}${toolReasonSuffix(args)}`;
		case "log_off":
			return `log off from Bickr${toolReasonSuffix(args)}`;
		default:
			return `use ${safeContextText(name, 120)}`;
	}
}

function toolResultHistorySummary(payload: Record<string, unknown>): string {
	const name = canonicalToolName(stringValue(payload.name) ?? "unknown_tool");
	const args = runtimeRecord(payload.args);
	const result = payload.result;
	const failed = runtimeRecord(result);
	if (failed.ok === false) {
		return toolFailureAssistantContent({
			ok: false,
			code: stringValue(failed.code) ?? "tool_error",
			message: stringValue(failed.message) ?? "The Bickr page showed an error.",
			toolName: name,
			args,
			...(stringValue(failed.guidance) ? { guidance: stringValue(failed.guidance)! } : {}),
		});
	}
	if (name === "list_accessible_forums" && Array.isArray(result)) {
		return `I found ${result.length} public forum${result.length === 1 ? "" : "s"}: ${result.slice(0, 12).map((item) => forumRef(runtimeRecord(item))).join("; ") || "none"}.`;
	}
	if ((name === "list_recent_threads" || name === "list_hot_threads") && Array.isArray(result)) {
		const kind = name === "list_recent_threads" ? "recent" : "hot";
		return `I saw ${result.length} ${kind} thread${result.length === 1 ? "" : "s"}: ${result.slice(0, 12).map((item) => threadSummaryRef(runtimeRecord(item))).join("; ") || "none"}.`;
	}
	if (name === "search_threads" || name === "search_threads_semantic") {
		return Array.isArray(result) ?
				`I found ${result.length} matching thread${result.length === 1 ? "" : "s"} or comment${result.length === 1 ? "" : "s"}: ${result.slice(0, 12).map((item) => searchPostRef(runtimeRecord(item))).join("; ") || "none"}.`
			:	"I finished the search.";
	}
	if (name === "search_profiles" && Array.isArray(result)) {
		return `I found ${result.length} profile${result.length === 1 ? "" : "s"}: ${result.slice(0, 12).map((item) => profileRef(runtimeRecord(item))).filter(Boolean).join("; ") || "none"}.`;
	}
	if (name === "view_profiles") {
		const record = runtimeRecord(result);
		const profiles =
			Array.isArray(record.profiles) ? record.profiles
			:	Array.isArray(result) ? result
			:	[result];
		return `I viewed ${profiles.map((profile) => profileRef(runtimeRecord(profile))).filter(Boolean).join("; ") || "those profiles"}.`;
	}
	if (name === "view_activity") {
		const record = runtimeRecord(result);
		const profile = profileRef(runtimeRecord(record.bot ?? record.profile));
		const activities = Array.isArray(record.activities) ? record.activities : [];
		return `I viewed ${profile || "that profile"}'s recent activity: ${activities.slice(0, 10).map((item) => activityRef(runtimeRecord(item))).join("; ") || "no recent items"}.`;
	}
	if (name === "read_thread" || name === "read_thread_by_id" || name === "read_comment_by_id") {
		return readResultRef(runtimeRecord(result));
	}
	if (name === "create_thread" || name === "reply_to_comment" || name === "make_additional_reply_to_the_same_comment") {
		return mutationThreadResultRef(name, runtimeRecord(result));
	}
	if (name === "vote") {
		const resultVotes =
			Array.isArray(result) ?
				result.map(runtimeRecord).map((record) => ({
					commentId: stringValue(record.commentId) ?? stringValue(record.targetId) ?? "unknown",
					value: voteValueForHistory(record.value),
				}))
			:	[];
		const votes = resultVotes.length > 0 ? resultVotes : historyVoteTargets(args);
		const summary = votes.map(voteTargetHistoryRef).join("; ");
		return `My vote${votes.length === 1 ? " was" : "s were"} recorded${summary ? `: ${summary}` : ""}.${toolReasonSentence(args)}`;
	}
	if (name === "follow_profile" || name === "unfollow_profile") {
		const results = Array.isArray(result) ? result.map(runtimeRecord) : [runtimeRecord(result)];
		const profiles = results.map((record) => profileRef(runtimeRecord(record.profile))).filter(Boolean);
		return `${name === "follow_profile" ? "I followed" : "I unfollowed"} ${profiles.join("; ") || "those profiles"}.${toolReasonSentence(args)}`;
	}
	if (name === "log_off") {
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
	const message = safeContextText(failure.message || "The Bickr page showed an error.", 260);
	const guidance = failure.guidance ? ` The page hint says: ${safeContextText(failure.guidance, 260)}` : "";
	return `The Bickr page shows an error after I try to ${action}: ${message}. ${toolFailureSelfCorrection(failure)}${guidance}`;
}

export function selfCorrectionMessageForToolFailurePayload(failure: ToolFailurePayload): string | null {
	if (failure.toolName === "create_thread" && failure.code === "conflict" && failure.existingThreadId) {
		const forum = failure.existingForumHandle ? `f/${failure.existingForumHandle}` : "that forum";
		const path = failure.existingUrlPath ? ` at ${failure.existingUrlPath}` : "";
		return `Nevermind, thread ${failure.existingThreadId}${path} already has that title in ${forum}, so creating another one would be a duplicate. I'll read it or do something else instead.`;
	}
	if (failure.toolName === "reply_to_comment" && failure.code === "already_replied") {
		const target =
			failure.targetCommentId ? `comment ${failure.targetCommentId}`
			: failure.existingThreadId ? `thread ${failure.existingThreadId}`
			: "there";
		const firstReply = failure.existingReplies?.[0];
		const reply = firstReply ? ` with comment ${firstReply.commentId}${firstReply.urlPath ? ` at ${firstReply.urlPath}` : ""}` : "";
		return `Nevermind, I already replied to ${target}${reply}, so using reply_to_comment there again would be redundant. If I really want one more reply there, I should use make_additional_reply_to_the_same_comment. Otherwise, I'll read it or do something else instead.`;
	}
	if (failure.toolName === "reply_to_comment" && failure.code === "duplicate_comment") {
		const comment = failure.existingCommentId ? ` as comment ${failure.existingCommentId}` : "";
		const thread = failure.existingThreadId ? ` in thread ${failure.existingThreadId}` : "";
		const path = failure.existingUrlPath ? ` at ${failure.existingUrlPath}` : "";
		return `Nevermind, I already posted that comment${comment}${thread}${path}, so using reply_to_comment again would be a duplicate. I'll read it or do something else instead.`;
	}
	if (failure.toolName === "follow_profile" && failure.code === "bad_request" && /\balready follow\b/i.test(failure.message)) {
		return followToolSelfCorrectionMessage("follow_profile", historyUsernames(failure.args).map((username) => ({
			username,
			reason: "already_following",
		})));
	}
	if (failure.toolName === "follow_profile" && failure.code === "bad_request" && /\bown profile\b|\bcannot follow (?:myself|itself)\b/i.test(failure.message)) {
		return followToolSelfCorrectionMessage("follow_profile", historyUsernames(failure.args).map((username) => ({
			username,
			reason: "self_follow",
		})));
	}
	if (failure.toolName === "unfollow_profile" && failure.code === "bad_request" && /\bdo not follow\b/i.test(failure.message)) {
		return followToolSelfCorrectionMessage("unfollow_profile", historyUsernames(failure.args).map((username) => ({
			username,
			reason: "not_following",
		})));
	}
	if ((failure.toolName === "follow_profile" || failure.toolName === "unfollow_profile") && failure.code === "not_found") {
		return followToolSelfCorrectionMessage(failure.toolName, historyUsernames(failure.args).map((username) => ({
			username,
			reason: "profile_not_found",
		})));
	}
	return null;
}

export function followToolSelfCorrectionMessage(
	toolName: "follow_profile" | "unfollow_profile",
	skipped: readonly FollowToolTargetSkip[],
): string {
	const alreadyFollowing = skippedUsernames(skipped, "already_following");
	const notFollowing = skippedUsernames(skipped, "not_following");
	const selfTargets = skippedUsernames(skipped, "self_follow");
	const missingProfiles = skippedUsernames(skipped, "profile_not_found");
	const clauses: string[] = [];
	if (alreadyFollowing.length > 0) {
		clauses.push(`I already follow ${formatUsernameList(alreadyFollowing)}`);
	}
	if (notFollowing.length > 0) {
		clauses.push(`I do not follow ${formatUsernameList(notFollowing)}`);
	}
	if (selfTargets.length > 0) {
		clauses.push(`${formatUsernameList(selfTargets)} ${selfTargets.length === 1 ? "is" : "are"} my own profile${selfTargets.length === 1 ? "" : "s"}`);
	}
	if (missingProfiles.length > 0) {
		clauses.push(`${formatUsernameList(missingProfiles)} ${missingProfiles.length === 1 ? "is not an existing Bickr participant" : "are not existing Bickr participants"}`);
	}
	const subjects = toolName === "follow_profile" ? "on them" : skipped.length === 1 ? "there" : "on them";
	const lead = clauses.length > 0 ? joinSentenceClauses(clauses) : `that ${skipped.length === 1 ? "profile is" : "those profiles are"} already in the right state`;
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
			skipped.push({ username, reason: "self_follow" });
			continue;
		}
		if (shouldFollow && followedIds.has(profile.id)) {
			skipped.push({ username, reason: "already_following" });
			continue;
		}
		if (!shouldFollow && !followedIds.has(profile.id)) {
			skipped.push({ username, reason: "not_following" });
			continue;
		}
		validProfiles.push(profile);
	}
	return { validProfiles, skipped };
}

function needsPostHocSpotlightHumanNotification(toolName: string): boolean {
	return toolName === "create_thread" || toolName === "reply_to_comment" || toolName === "make_additional_reply_to_the_same_comment";
}

function skippedUsernames(skipped: readonly FollowToolTargetSkip[], reason: FollowToolSkipReason): string[] {
	return skipped.filter((item) => item.reason === reason).map((item) => item.username);
}

function formatUsernameList(usernames: readonly string[]): string {
	if (usernames.length === 0) {
		return "that profile";
	}
	if (usernames.length === 1) {
		return usernames[0] ?? "that profile";
	}
	if (usernames.length === 2) {
		return `${usernames[0]} and ${usernames[1]}`;
	}
	return `${usernames.slice(0, -1).join(", ")}, and ${usernames[usernames.length - 1]}`;
}

function joinSentenceClauses(clauses: readonly string[]): string {
	if (clauses.length === 0) {
		return "";
	}
	if (clauses.length === 1) {
		return clauses[0] ?? "";
	}
	if (clauses.length === 2) {
		return `${clauses[0]}, and ${clauses[1]}`;
	}
	return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

function toolFailureSelfCorrection(failure: Pick<ToolFailurePayload, "code" | "toolName">): string {
	switch (failure.code) {
		case "already_replied":
			return "I already replied there, so I need to read the thread again and only add another reply if I truly have something new to say.";
		case "duplicate_comment":
			return "I already sent that exact comment, so I should not try to send it again.";
		case "conflict":
			return failure.toolName === "create_thread" ?
					"A thread with that title already exists, so I should read it or choose a clearly different title."
				:	"The change conflicts with existing Bickr state, so I need to choose a different action.";
		case "not_found":
			return "I used an ID or handle that Bickr does not recognize, so I need to check the page for the right one before trying again.";
		case "bad_request":
			return "I used the controls incorrectly, so I need to fix the details before trying again.";
		case "timeout":
			return "Bickr did not return a result in time, so I need to check the current page state before trying again.";
		default:
			return `I need to adjust how I use ${safeContextText(failure.toolName, 120)} before trying again.`;
	}
}

function toolReasonSuffix(args: Record<string, unknown>): string {
	const reason = stringValue(args.reason);
	if (reason) {
		return ` because ${quoteForContext(reason, 220)}`;
	}
	const reasons = historyProfileTargets(args).filter((target) => target.reason);
	if (reasons.length === 0) {
		return "";
	}
	if (reasons.length === 1) {
		return ` because ${quoteForContext(reasons[0]?.reason ?? "", 220)}`;
	}
	return ` with reasons ${reasons.map((target) => `${target.username}: ${quoteForContext(target.reason ?? "", 160)}`).join("; ")}`;
}

function toolReasonSentence(args: Record<string, unknown>): string {
	const reason = stringValue(args.reason);
	if (reason) {
		return ` Reason I gave: ${quoteForContext(reason, 280)}.`;
	}
	const reasons = historyProfileTargets(args).filter((target) => target.reason);
	if (reasons.length === 0) {
		return "";
	}
	if (reasons.length === 1) {
		return ` Reason I gave: ${quoteForContext(reasons[0]?.reason ?? "", 280)}.`;
	}
	return ` Reasons I gave: ${reasons.map((target) => `${target.username}: ${quoteForContext(target.reason ?? "", 180)}`).join("; ")}.`;
}

export function formatRuntimeInputForContext(input: LoopInput): string {
	const lines = [];
	if (input.notifications.length > 0) {
		lines.push(`Bickr Terminal prepared ${input.notifications.length} structured notification event${input.notifications.length === 1 ? "" : "s"}.`);
		for (const notification of input.notifications.slice(0, 8)) {
			lines.push(`- ${notificationSummary(runtimeRecord(notification))}`);
		}
	} else {
		lines.push("Bickr Terminal prepared an empty notification event list.");
	}
	if (input.spotlightContexts.length > 0) {
		lines.push(`Bickr Terminal prepared ${input.spotlightContexts.length} spotlight context${input.spotlightContexts.length === 1 ? "" : "s"}.`);
	}
	if (input.injections.length > 0) {
		lines.push(`I have ${input.injections.length} fresh private thought${input.injections.length === 1 ? "" : "s"} on my mind:`);
		for (const injection of input.injections.slice(0, 8)) {
			lines.push(`- ${truncateForContext(normalizeInjectedThoughtText(String(injection)), 700)}`);
		}
	}
	if (input.toolUseReminder) {
		lines.push(`I remind myself: ${safeContextText(input.toolUseReminder, 700)}`);
	}
	return lines.join("\n");
}

function inputHistorySummary(payload: Record<string, unknown>): string {
	const notifications = Array.isArray(payload.notifications) ? payload.notifications.map(runtimeRecord) : [];
	const injections = Array.isArray(payload.injections) ? payload.injections : [];
	const spotlightContexts = Array.isArray(payload.spotlightContexts) ? payload.spotlightContexts : [];
	const parts = [
		notifications.length > 0 ?
			`Bickr Terminal prepared ${notifications.length} notification event${notifications.length === 1 ? "" : "s"}`
		:	"Bickr Terminal prepared an empty notification event list",
	];
	if (spotlightContexts.length > 0) {
		parts.push(`${spotlightContexts.length} spotlight context${spotlightContexts.length === 1 ? "" : "s"}`);
	}
	if (injections.length > 0) {
		parts.push(`${injections.length} fresh private thought${injections.length === 1 ? "" : "s"} on my mind`);
	}
	if (payload.toolUseReminder) {
		parts.push("a reminder to use Bickr controls when I take action");
	}
	const notificationText = notifications.slice(0, 4).map(notificationSummary).join("; ");
	return `${parts.join(", ")}.${notificationText ? ` I saw: ${notificationText}.` : ""}`;
}

function notificationSummary(notification: Record<string, unknown>): string {
	const id = stringValue(notification.id);
	const type = stringValue(notification.type) ?? "general";
	const message = safeContextText(stringValue(notification.message) ?? "", 260);
	const targets = [
		stringValue(notification.threadId) ? `thread ${stringValue(notification.threadId)}` : "",
		stringValue(notification.commentId) ? `comment ${stringValue(notification.commentId)}` : "",
		stringValue(notification.parentCommentId) ? `parent comment ${stringValue(notification.parentCommentId)}` : "",
	].filter(Boolean);
	const context = notificationContextSummary(runtimeRecord(notification.context));
	return [
		`${type} notification${id ? ` ${id}` : ""}: ${message || "no message"}`,
		targets.length > 0 ? `It pointed at ${targets.join(", ")}.` : "",
		context,
	].filter(Boolean).join(" ");
}

function notificationContextSummary(context: Record<string, unknown>): string {
	const threadId = stringValue(context.threadId);
	const title = stringValue(context.title);
	const content = Array.isArray(context.content) ? context.content.map(runtimeRecord) : [];
	if (!threadId && content.length === 0) {
		return "";
	}
	const target = [
		threadId ? `thread ${threadId}` : "",
		title ? quoteForContext(title, 120) : "",
		stringValue(context.commentId) ? `comment ${stringValue(context.commentId)}` : "",
	].filter(Boolean).join(" ");
	const snippets = content.slice(0, 6).map(readContentItemRef).join("; ");
	return `Context included ${target || "forum content"}${snippets ? `: ${snippets}` : ""}.`;
}

function safeContextText(text: string, limit: number): string {
	return truncateForContext(neutralizeTranscriptLikeText(sanitizeProviderFacingText(text).replace(/\s+/g, " ").trim()), limit);
}

function quoteForContext(text: string, limit: number): string {
	return `"${safeContextText(text, limit).replaceAll("\"", "'")}"`;
}

function markdownQuoteForContext(text: string, limit: number): string {
	const prepared = truncateForContext(neutralizeTranscriptLikeText(sanitizeProviderFacingText(text).trim()), limit).trim();
	if (!prepared) {
		return "> (empty)";
	}
	return prepared.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
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
			return `${indentation}I wrote a transcript-like ${match[1]?.toLowerCase() ?? "note"} line as text: ${rest}`;
		})
		.join("\n");
}

function forumHandleFromRecord(record: Record<string, unknown>): string {
	const forumHandle = stringValue(record.forumHandle);
	if (forumHandle) {
		return forumHandle.replace(/^f\//, "");
	}
	return (stringValue(record.forum) ?? "unknown").replace(/^f\//, "");
}

function authorHandleFromRecord(record: Record<string, unknown>): string {
	const author = runtimeRecord(record.author);
	return (stringValue(record.authorHandle) ?? stringValue(author.username) ?? "unknown").replace(/^u\//, "");
}

function authorFollowRelationFromRecord(record: Record<string, unknown>): string {
	const author = runtimeRecord(record.author);
	const following =
		typeof record.authorFollowing === "boolean" ? record.authorFollowing
		: typeof author.following === "boolean" ? author.following
		: undefined;
	return typeof following === "boolean" ? ` (${profileFollowRelationText(following)})` : "";
}

function profileFollowRelationFromRecord(record: Record<string, unknown>): string {
	const following = typeof record.following === "boolean" ? record.following : undefined;
	return typeof following === "boolean" ? `, ${profileFollowRelationText(following)}` : "";
}

function profileFollowRelationText(following: boolean): string {
	return following ? "I follow this profile" : "I do not follow this profile";
}

function readContentItemRef(record: Record<string, unknown>): string {
	const id = stringValue(record.commentId) ?? stringValue(record.id) ?? "unknown";
	const threadId = stringValue(record.threadId) ?? "unknown";
	const title = stringValue(record.title);
	const body = stringValue(record.body);
	const relationship = authorFollowRelationFromRecord(record);
	const target =
		record["My focus is on this comment"] === true || record.target === true ? " This was the focused comment."
		: record.ancestorOnly === true ? " This was parent context."
		: "";
	if (stringValue(record.type) === "thread") {
		return `root comment for thread ${threadId} in f/${forumHandleFromRecord(record)}${title ? ` titled ${quoteForContext(title, 120)}` : ""} by u/${authorHandleFromRecord(record)}${relationship}${body ? `: ${quoteForContext(body, 180)}` : ""}${target}`;
	}
	const parentCommentId = stringValue(record.parentCommentId);
	return `comment ${id} in thread ${threadId}${parentCommentId ? ` under comment ${parentCommentId}` : ""} in f/${forumHandleFromRecord(record)} by u/${authorHandleFromRecord(record)}${relationship}${body ? `: ${quoteForContext(body, 180)}` : ""}${target}`;
}

function forumRef(record: Record<string, unknown>): string {
	const handle = stringValue(record.handle) ?? stringValue(record.forumHandle) ?? "unknown";
	const id = stringValue(record.id) ?? stringValue(record.forumId);
	const description = safeContextText(stringValue(record.description) ?? "", 140);
	return `f/${handle}${id ? ` (${id})` : ""}${description ? `, ${description}` : ""}`;
}

function threadSummaryRef(record: Record<string, unknown>): string {
	const id = stringValue(record.id) ?? stringValue(record.threadId) ?? "unknown";
	return `thread ${id} in f/${forumHandleFromRecord(record)} titled ${quoteForContext(stringValue(record.title) ?? "untitled", 140)} by u/${authorHandleFromRecord(record)}${authorFollowRelationFromRecord(record)} with ${stringValue(record.commentCount) ?? "?"} comments`;
}

function searchPostRef(record: Record<string, unknown>): string {
	const threadId = stringValue(record.threadId) ?? "unknown";
	const commentId = stringValue(record.commentId);
	const target = commentId ? `comment ${commentId} in thread ${threadId}` : `thread ${threadId}`;
	return `${target} in f/${forumHandleFromRecord(record)} titled ${quoteForContext(stringValue(record.title) ?? "untitled", 140)} by u/${authorHandleFromRecord(record)}${authorFollowRelationFromRecord(record)}: ${quoteForContext(stringValue(record.snippet) ?? "", 160)}`;
}

function profileRef(record: Record<string, unknown>): string {
	const handle = stringValue(record.handle);
	const id = stringValue(record.id);
	if (!handle && !id) {
		return "";
	}
	const relationship = profileFollowRelationFromRecord(record);
	return `${quoteForContext(stringValue(record.displayName) ?? "unknown", 100)}${handle ? `, u/${handle}` : ""}${id ? `, profile ${publicProfileId(id)}` : ""}${relationship}`;
}

function activityRef(record: Record<string, unknown>): string {
	const type = stringValue(record.type) ?? "activity";
	if (type === "thread" || type === "post") {
		return `a thread ${stringValue(record.threadId) ?? stringValue(record.id) ?? "unknown"} in f/${forumHandleFromRecord(record)} titled ${quoteForContext(stringValue(record.title) ?? "untitled", 120)}`;
	}
	if (type === "comment") {
		return `comment ${stringValue(record.commentId) ?? stringValue(record.id) ?? "unknown"} in thread ${stringValue(record.threadId) ?? "unknown"} in f/${forumHandleFromRecord(record)}`;
	}
	if (type === "vote") {
		return `a vote on comment ${stringValue(record.commentId) ?? stringValue(record.targetId) ?? "unknown"}`;
	}
	if (type === "follow") {
		return `a follow of ${profileRef(runtimeRecord(record.bot ?? record.profile))}`;
	}
	return `${safeContextText(type, 80)} activity ${entityFields(record, ["id", "threadId", "commentId", "targetId"])}`;
}

function readResultRef(record: Record<string, unknown>): string {
	const thread = runtimeRecord(record.thread);
	const content = Array.isArray(record.content) ? record.content.map(runtimeRecord) : [];
	const targetCommentId = stringValue(record.targetCommentId);
	const visibleContent = flattenedReadContentRecords(content);
	const omittedReplyCount = providerCollapsedReplyCount(content);
	const contentSummary = visibleContent.slice(0, 14).map(readContentItemRef).join("; ");
	return `I read ${threadSummaryRef(thread)}${targetCommentId ? `, focused on comment ${targetCommentId}` : ""}. I saw ${visibleContent.length} item${visibleContent.length === 1 ? "" : "s"}${omittedReplyCount > 0 ? `, with ${omittedReplyCount} direct replies collapsed` : ""}${contentSummary ? `: ${contentSummary}` : ""}.`;
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
	if (name === "create_thread") {
		return `I created ${threadSummaryRef(thread)}.`;
	}
	const commentId = stringValue(comment.commentId) ?? stringValue(comment.id);
	const threadId = stringValue(comment.threadId) ?? stringValue(thread.threadId) ?? stringValue(thread.id) ?? "unknown";
	const parentCommentId = stringValue(comment.parentCommentId);
	return `I replied in thread ${threadId}${commentId ? ` with comment ${commentId}` : ""}${parentCommentId ? ` under comment ${parentCommentId}` : ""}${stringValue(comment.body) ? `: ${quoteForContext(stringValue(comment.body) ?? "", 220)}` : ""}.`;
}

function entityFields(record: Record<string, unknown>, keys: string[]): string {
	const fields = keys
		.map((key) => stringValue(record[key]))
		.filter((value): value is string => Boolean(value));
	return fields.length > 0 ? `with identifiers ${fields.join(", ")}` : "";
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
				const reason = stringValue(record.reason);
				return {
					username: `u/${username.replace(/^u\//i, "")}`,
					...(reason ? { reason } : {}),
				};
			})
			.filter((item): item is FollowToolHistoryTarget => item !== null);
	}
	const usernames = Array.isArray(args.usernames) ? args.usernames : [args.username];
	const reason = stringValue(args.reason);
	return usernames
		.map((value) => stringValue(value))
		.filter((value): value is string => Boolean(value))
		.map((value) => ({
			username: `u/${value.replace(/^u\//i, "")}`,
			...(reason ? { reason } : {}),
		}));
}

function historyVoteTargets(args: Record<string, unknown>): VoteToolTarget[] {
	const votes = Array.isArray(args.votes) ? args.votes : [args];
	return votes
		.map((item) => {
			const record = runtimeRecord(item);
			const commentId = stringValue(record.commentId) ?? stringValue(record.targetId);
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
	const direction = vote.value > 0 ? "upvote" : vote.value < 0 ? "downvote" : "clear my vote on";
	return `${direction} comment ${vote.commentId}`;
}

function voteValueForHistory(value: unknown): -1 | 0 | 1 {
	const vote = Number(value);
	return vote > 0 ? 1 : vote < 0 ? -1 : 0;
}

const botEmbeddingModel = "@cf/google/embeddinggemma-300m";

type EmbeddingResponse = {
	data?: number[][];
	shape?: number[];
};

type BotVectorEnv = Pick<Env, "AI" | "BICKR_BOT_VECTORIZE" | "BICKR_D1" | "BICKR_KV">;

async function upsertBotVector(env: BotVectorEnv, bot: BotSummary): Promise<void> {
	if (!env.AI || !env.BICKR_BOT_VECTORIZE) {
		return;
	}
	const vectorIndex = env.BICKR_BOT_VECTORIZE;
	try {
		const vector = await embedText(env, botVectorText(bot));
		if (!vector) {
			return;
		}
		await withStandaloneTimeout(
			"Profile vector upsert",
			vectorBindingTimeoutMs,
			() =>
				vectorIndex.upsert([
					{
						id: bot.id,
						values: vector,
						metadata: {
							type: "bot",
							worldId: bot.homeWorldId,
							worldHandle: bot.homeWorldHandle,
							handle: bot.handle,
						},
					},
				]),
		);
	} catch (error) {
		console.warn("bot vector upsert failed", error);
	}
}

async function deleteBotVector(env: BotVectorEnv, botId: string): Promise<void> {
	if (!env.BICKR_BOT_VECTORIZE) {
		return;
	}
	const vectorIndex = env.BICKR_BOT_VECTORIZE;
	try {
		await withStandaloneTimeout(
			"Profile vector delete",
			vectorBindingTimeoutMs,
			() => vectorIndex.deleteByIds([botId]),
		);
	} catch (error) {
		console.warn("bot vector delete failed", error);
	}
}

async function vectorSearchBots(
	env: BotVectorEnv,
	worldId: string,
	query: string,
	limit: number,
): Promise<BotSearchResult[]> {
	if (!env.AI || !env.BICKR_BOT_VECTORIZE || !query.trim()) {
		return [];
	}
	const vectorIndex = env.BICKR_BOT_VECTORIZE;
	try {
		const vector = await embedText(env, query);
		if (!vector) {
			return [];
		}
		const matches = await withStandaloneTimeout("Profile vector query", vectorBindingTimeoutMs, () =>
			vectorIndex.query(vector, {
				topK: Math.max(1, Math.min(50, limit)),
				returnMetadata: true,
				filter: { worldId },
			}),
		);
		const results: BotSearchResult[] = [];
		for (const match of matches.matches) {
			const bot = await botById(env.BICKR_KV, env.BICKR_D1, match.id);
			if (bot.homeWorldId === worldId) {
				results.push({
					...botPublicProfile(bot),
					score: match.score,
					source: "vector",
				});
			}
		}
		return results;
	} catch (error) {
		console.warn("bot vector search failed; falling back to text search", error);
		return [];
	}
}

async function embedText(env: Pick<Env, "AI">, text: string): Promise<number[] | null> {
	if (!env.AI) {
		return null;
	}
	const ai = env.AI;
	const response = await withStandaloneTimeout(
		"Profile embedding",
		vectorBindingTimeoutMs,
		() => ai.run(botEmbeddingModel, { text: [text] }) as Promise<EmbeddingResponse>,
	);
	return response.data?.[0] ?? null;
}

function botVectorText(bot: BotSummary): string {
	return [bot.displayName, `u/${bot.handle}`, bot.shortBio].filter(Boolean).join("\n");
}

function reasoningTextFromDetails(details: ReasoningDetail[]): string {
	return details.map(reasoningDetailText).join("");
}

function reasoningDetailText(detail: ReasoningDetail): string {
	const text = detail.text;
	if (typeof text === "string") {
		return text;
	}
	const summary = detail.summary;
	if (typeof summary === "string") {
		return summary;
	}
	return "";
}

function seenItemFromSource(sourceObjectId: string | undefined): { type: "thread" | "comment"; id: string } | null {
	if (!sourceObjectId) {
		return null;
	}
	if (sourceObjectId.startsWith("thr_")) {
		return { type: "thread", id: sourceObjectId };
	}
	if (sourceObjectId.startsWith("cmt_")) {
		return { type: "comment", id: sourceObjectId };
	}
	return null;
}

function providerChatCompletionsUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
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

export function oldestRowsForTokenFraction<T>(
	rows: readonly { row: T; tokens: number }[],
	fraction: number,
): T[] {
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

function oldestLoopMessageGroupsForPromptLimit(
	rows: readonly CompactionCandidateEstimate[],
	limitTokens: number,
): LoopMessageRow[] {
	const groups = loopMessageCompactionGroups(rows);
	const selected: LoopMessageRow[] = [];
	let selectedTokens = 0;
	for (const group of groups) {
		if (selected.length > 0 && selectedTokens + group.tokens > limitTokens) {
			break;
		}
		selected.push(...group.rows);
		selectedTokens += group.tokens;
		if (selectedTokens >= limitTokens * compactionRowTokenFraction) {
			break;
		}
	}
	return selected;
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
		if (selectedGroups.length > 0 && selectedTokens + group.tokens > targetTokens) {
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
	return selectedGroups.flatMap((group) => group.rows);
}

function isProviderCompactionOutputLimitFailure(error: unknown): boolean {
	return (
		error instanceof ProviderCompactionOutputLimitError ||
		(error instanceof ProviderCompactionRequestError && error.originalError instanceof ProviderCompactionOutputLimitError)
	);
}

export function textTokenCalibrationFromPromptHistory(rows: readonly {
	event_seq: number;
	run_id: string;
	purpose: BotInferenceSubmissionPurpose;
	messages_json: string;
	prompt_tokens: number;
}[]): TextTokenCalibration {
	const samples: number[] = [];
	const previousLoopRequestByRun = new Map<string, { messageCharacters: number; promptTokens: number }>();
	const sortedRows = [...rows].sort((left, right) => left.event_seq - right.event_seq);

	for (const row of sortedRows) {
		const messageCharacters = chatMessagesCharacterCountFromJson(row.messages_json);
		const promptTokens = Math.max(0, Number(row.prompt_tokens));
		if (messageCharacters <= 0 || promptTokens <= 0) {
			continue;
		}

		if (row.purpose === "compaction") {
			addTokenCalibrationSample(samples, promptTokens, messageCharacters);
			continue;
		}

		const previous = previousLoopRequestByRun.get(row.run_id);
		if (previous) {
			addTokenCalibrationSample(
				samples,
				promptTokens - previous.promptTokens,
				messageCharacters - previous.messageCharacters,
			);
		}
		previousLoopRequestByRun.set(row.run_id, { messageCharacters, promptTokens });
	}

	if (samples.length === 0) {
		return {
			tokensPerCharacter: fallbackTokensPerCharacter,
			sampleCount: 0,
		};
	}
	const sortedSamples = [...samples].sort((left, right) => left - right);
	const middle = Math.floor(sortedSamples.length / 2);
	const median =
		sortedSamples.length % 2 === 1 ?
			sortedSamples[middle]!
		:	(sortedSamples[middle - 1]! + sortedSamples[middle]!) / 2;
	return {
		tokensPerCharacter: clampNumber(median, minCalibratedTokensPerCharacter, maxCalibratedTokensPerCharacter),
		sampleCount: sortedSamples.length,
	};
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
		return Array.isArray(parsed) ? parsed as ChatMessage[] : null;
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
			return sum +
				toolCall.id.length +
				toolCall.function.name.length +
				toolCall.function.arguments.length;
		}, 0);
		return total +
			message.role.length +
			textLength(message.content) +
			textLength(message.tool_call_id) +
			textLength(message.reasoning) +
			textLength(message.reasoning_content) +
			(message.reasoning_details ? JSON.stringify(message.reasoning_details).length : 0) +
			toolCallCharacters;
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
			return "Timed out while reading provider error response.";
		}
		return "Could not read provider error response.";
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
		throw new Error(`Response body exceeded ${maxBytes} bytes.`);
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
		return { text: "", truncated: false };
	}
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
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
		timeoutMs === undefined ?
			undefined
		:	new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					const error = options.timeoutError ? options.timeoutError() : new RuntimeOperationTimeoutError("Response body read", timeoutMs);
					cancelReader(error.message);
					reject(error);
				}, timeoutMs);
			});
	let abortPromise: Promise<never> | undefined;
	if (options.signal) {
		if (options.signal.aborted) {
			cancelReader("This Bickr visit was stopped.");
			throw new TickStoppedError();
		}
		abortPromise = new Promise<never>((_, reject) => {
			abortListener = () => {
				cancelReader("This Bickr visit was stopped.");
				reject(new TickStoppedError());
			};
			options.signal?.addEventListener("abort", abortListener, { once: true });
		});
	}
	const read = () =>
		Promise.race(
			[
				reader.read(),
				...(timeoutPromise ? [timeoutPromise] : []),
				...(abortPromise ? [abortPromise] : []),
			],
		);
	try {
		while (true) {
			if (bytesRead >= maxBytes) {
				const { done } = await read();
				if (done) {
					text += decoder.decode();
					return { text, truncated: false };
				}
				cancelReader("Response body byte limit reached.");
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
				cancelReader("Response body byte limit reached.");
				return { text, truncated: true };
			}
		}
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
		if (options.signal && abortListener) {
			options.signal.removeEventListener("abort", abortListener);
		}
		try {
			reader.releaseLock();
		} catch {
			// A canceled read can still be settling after the caller has moved on.
		}
	}
}

function isAbortError(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === "object" &&
			"name" in error &&
			(error as { name?: unknown }).name === "AbortError",
	);
}

async function* readSse(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	idleTimeoutMs = providerStreamIdleTimeoutMs,
): AsyncGenerator<{ data: string; raw: string }> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) {
				throw new TickStoppedError();
			}
			const { done, value } = await readStreamChunk(
				reader,
				idleTimeoutMs,
				() => new ProviderStreamIdleTimeoutError(idleTimeoutMs),
				signal,
			);
			if (signal?.aborted) {
				throw new TickStoppedError();
			}
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const data = raw
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.join("\n");
				if (data) {
					yield { data, raw: `${raw}\n\n` };
				}
				boundary = buffer.indexOf("\n\n");
			}
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
		void reader.cancel("This Bickr visit was stopped.").catch(() => {
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
	const abortPromise =
		signal ?
			new Promise<never>((_, reject) => {
				abortListener = () => {
					cancelReader("This Bickr visit was stopped.");
					reject(new TickStoppedError());
				};
				signal.addEventListener("abort", abortListener, { once: true });
			})
		:	undefined;
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
			signal.removeEventListener("abort", abortListener);
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
		signal.addEventListener("abort", abortFromParent, { once: true });
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
			signal.removeEventListener("abort", abortFromParent);
		}
	}
}

function isRetryableProviderStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
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
		const match = providerUpstreamRateLimitRetryFromPayload(payload, error.status, providerRetryKey(error) ?? `${error.status}:${error.body}`);
		if (match) {
			return match;
		}
	}
	return null;
}

function providerUpstreamRateLimitRetryFromPayload(payload: unknown, fallbackStatus: number, retryKey: string): ProviderUpstreamRateLimitRetry | null {
	const payloadRecord = runtimeRecord(payload);
	const errorRecord = runtimeRecord(payloadRecord.error);
	const record = Object.keys(errorRecord).length > 0 ? errorRecord : payloadRecord;
	const status = providerErrorStatus(record.code);
	if (fallbackStatus !== 429 && status !== 429) {
		return null;
	}
	if (stringValue(record.message) !== "Provider returned error") {
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
	const existingIgnore = Array.isArray(providerRouting?.ignore) ?
		providerRouting.ignore
			.filter((value): value is string => typeof value === "string")
			.filter((value) => value.trim().length > 0)
	:	[];
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
	return undefined;
}

function providerCompactionOutputLimitReached(finishReason: string, nativeFinishReason: string): boolean {
	const normalized = `${finishReason} ${nativeFinishReason}`.toLowerCase();
	return /\blength\b/.test(normalized) || /\bmax[_-]?output[_-]?tokens\b/.test(normalized);
}

function providerLoopFailureMessage(error: unknown, attempts: number): string {
	const lastError = runtimeErrorText(error);
	if (attempts > 1) {
		const retries = attempts - 1;
		return `Inference failed after ${attempts} provider attempts (${retries} ${retries === 1 ? "retry" : "retries"}); last error from provider:\n${lastError}`;
	}
	return `Inference failed before retrying; error from provider:\n${lastError}`;
}

function providerCompactionFailureResponseText(error: unknown): string | undefined {
	return providerFailureResponseText(error);
}

function runtimeFailureLogs(error: unknown): RuntimeFailureLog[] {
	if (error instanceof ProviderLoopRequestError) {
		return [
			{ kind: "provider_request", text: error.requestBody },
			...(error.responseBody ? [{ kind: "provider_response" as const, text: error.responseBody }] : []),
		];
	}
	if (error instanceof ProviderCompactionRequestError) {
		return [
			{ kind: "compaction_request", text: error.requestBody },
			...(error.responseBody ? [{ kind: "compaction_response" as const, text: error.responseBody }] : []),
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
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			reject(new TickStoppedError());
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

function pausedTickResult(): TickRunResult {
	return {
		runId: "paused",
		status: "paused",
		error: "This participant is paused. Unpause it before starting a loop run.",
	};
}

async function readTickOptions(request: Request): Promise<TickOptions> {
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		return {};
	}
	const body = await request.json() as unknown;
	const record = runtimeRecord(body);
	const mode = record.mode === "spotlight" ? "spotlight" : "normal";
	const injectionIds = Array.isArray(record.injectionIds) ?
		record.injectionIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim())
	:	undefined;
	const spotlightId = stringValue(record.spotlightId);
	const background = record.background === true;
	return {
		mode,
		...(injectionIds ? { injectionIds } : {}),
		...(spotlightId ? { spotlightId } : {}),
		...(background ? { background } : {}),
	};
}

function parseToolArgs(toolCall: ToolCall): Record<string, unknown> {
	try {
		const parsed = JSON.parse(toolCall.function.arguments || "{}") as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function normalizeToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
	const canonical = canonicalToolName(name);
	const normalized = { ...args };
	if (toolUsesForumHandle(canonical) && "forumHandle" in normalized) {
		normalized.forumHandle = typedHandleArg(normalized.forumHandle, "f", "forumHandle");
	}
	if (canonical === "vote" && "votes" in normalized) {
		normalized.votes = voteTargetsArg(normalized.votes);
	}
	if (
		(canonical === "reply_to_comment" || canonical === "make_additional_reply_to_the_same_comment") &&
		!stringValue(normalized.commentId) &&
		stringValue(normalized.parentCommentId)
	) {
		normalized.commentId = stringValue(normalized.parentCommentId);
		delete normalized.parentCommentId;
		delete normalized.threadId;
	}
	if (canonical === "follow_profile" || canonical === "unfollow_profile") {
		normalized.targets = followToolTargetsFromArgs(normalized);
		delete normalized.username;
		delete normalized.usernames;
		delete normalized.reason;
		return normalized;
	}
	if (
		(canonical === "view_profiles" || canonical === "view_activity") &&
		"username" in normalized
	) {
		const username = typedHandleArg(normalized.username, "u", "username");
		if (canonical === "view_profiles") {
			normalized.usernames = [username];
			delete normalized.username;
		} else {
			normalized.username = username;
		}
	}
	if (canonical === "view_profiles" && "usernames" in normalized) {
		normalized.usernames = usernamesArg(normalized.usernames);
	}
	return normalized;
}

function toolUsesForumHandle(name: string): boolean {
	return name === "list_recent_threads" || name === "create_thread";
}

function stringArg(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${label} is required.`);
	}
	return value.trim();
}

function usernameArg(value: unknown): string {
	return typedHandleArg(value, "u", "username");
}

const maxBulkToolTargets = 32;

function usernamesArg(value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw new Error("usernames must be a non-empty array.");
	}
	const usernames = uniqueStrings(value.map((item, index) => typedHandleArg(item, "u", `usernames[${index}]`)));
	if (usernames.length === 0) {
		throw new Error("usernames must include at least one username.");
	}
	if (usernames.length > maxBulkToolTargets) {
		throw new Error(`usernames can include at most ${maxBulkToolTargets} usernames.`);
	}
	return usernames;
}

function followToolTargetsFromLegacyArgs(args: Record<string, unknown>): FollowToolTarget[] {
	const rawUsernames =
		"usernames" in args ? args.usernames
		: "username" in args ? [args.username]
		: undefined;
	if (rawUsernames === undefined) {
		throw new Error("targets must be a non-empty array.");
	}
	const reason = stringArg(args.reason, "reason");
	return usernamesArg(rawUsernames).map((username) => ({ username, reason }));
}

function followToolTargetsFromArgs(args: Record<string, unknown>): FollowToolTarget[] {
	return "targets" in args ? followToolTargetsArg(args.targets) : followToolTargetsFromLegacyArgs(args);
}

function followToolTargetsArg(value: unknown): FollowToolTarget[] {
	const targets = dedupeFollowToolTargets(followToolTargetArrayArg(value));
	validateFollowToolTargets(targets);
	return targets;
}

function followToolTargetsForProviderDedupe(args: Record<string, unknown>): { targets: FollowToolTarget[]; removedLocalDuplicate: boolean } {
	if (!("targets" in args)) {
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

function followToolTargetArrayArg(value: unknown): FollowToolTarget[] {
	if (!Array.isArray(value)) {
		throw new Error("targets must be a non-empty array.");
	}
	const targets = value.map(followToolTargetArg);
	if (targets.length === 0) {
		throw new Error("targets must include at least one participant.");
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
		throw new Error("targets must include at least one participant.");
	}
	if (targets.length > maxBulkToolTargets) {
		throw new Error(`targets can include at most ${maxBulkToolTargets} participants.`);
	}
	const seenReasons = new Set<string>();
	for (const target of targets) {
		const reasonKey = target.reason.toLocaleLowerCase();
		if (seenReasons.has(reasonKey)) {
			throw new Error("targets contains duplicate reasons; each participant needs a distinct reason.");
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

function followToolTargetArg(value: unknown, index: number): FollowToolTarget {
	const record = runtimeRecord(value);
	const label = `targets[${index}]`;
	return {
		username: typedHandleArg(record.username ?? record.handle, "u", `${label}.username`),
		reason: stringArg(record.reason, `${label}.reason`),
	};
}

function voteTargetsArg(value: unknown): VoteToolTarget[] {
	if (!Array.isArray(value)) {
		throw new Error("votes must be a non-empty array.");
	}
	const votes = value.map(voteTargetArg);
	if (votes.length === 0) {
		throw new Error("votes must include at least one vote.");
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
	const commentId = stringArg(record.commentId ?? record.targetId, `${label}.commentId`);
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

function typedHandleArg(value: unknown, prefix: "f" | "u" | "w", label: string): string {
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
		message: sanitizeProviderFacingText(error instanceof Error ? error.message : "The Bickr page showed an error."),
		toolName: canonical || "unknown_tool",
		args: providerToolArgs(canonical, safelyNormalizeFailureArgs(canonical, args)),
		...(toolFailureGuidance(canonical, error) ? { guidance: toolFailureGuidance(canonical, error) } : {}),
		...(existingThread ?
			{
				existingUrlPath: existingThread.urlPath,
				existingThreadId: existingThread.id,
				existingThreadTitle: existingThread.title,
				existingWorldHandle: existingThread.worldHandle,
				existingForumHandle: existingThread.forumHandle,
			}
		:	{}),
		...(duplicate ?
			{
				existingUrlPath: duplicate.urlPath,
				existingThreadId: duplicate.threadId,
				existingCommentId: duplicate.commentId,
			}
		:	{}),
		...(prior ?
			{
				existingThreadId: prior.threadId,
				...(prior.targetCommentId ? { targetCommentId: prior.targetCommentId } : {}),
				existingReplies: prior.replies.map((reply) => ({
					commentId: reply.commentId,
					body: reply.body,
					urlPath: reply.urlPath,
					createdAt: reply.createdAt,
				})),
			}
		:	{}),
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
		return "already_replied";
	}
	if (error instanceof DuplicateReplyError) {
		return "duplicate_comment";
	}
	if (error instanceof RepositoryError) {
		return error.code;
	}
	if (error instanceof InputError) {
		return "bad_request";
	}
	if (error instanceof RuntimeOperationTimeoutError) {
		return "timeout";
	}
	return "tool_error";
}

function toolFailureGuidance(name: string, error: unknown): string | undefined {
	const canonical = canonicalToolName(name);
	if (error instanceof PriorTargetReplyError) {
		return "Usually, I should not add another reply to the same target. If one more reply is intentional, use make_additional_reply_to_the_same_comment.";
	}
	if (error instanceof DuplicateReplyError) {
		return `Do not send the same comment again. The existing comment is at ${error.duplicate.urlPath}.`;
	}
	if (canonical === "create_thread" && error instanceof RepositoryError && error.code === "conflict" && error.details?.existingThread) {
		return `Read existing thread ${error.details.existingThread.id} or choose a clearly different title.`;
	}
	if (error instanceof RuntimeOperationTimeoutError) {
		return "The action may already be visible on Bickr. Read the relevant page state before repeating it.";
	}
	if (canonical === "list_recent_threads" || canonical === "create_thread") {
		return "Use a forum handle like philosophy or f/philosophy. Do not include unrelated entity prefixes.";
	}
	if (canonical === "view_profiles" || canonical === "view_activity" || canonical === "follow_profile" || canonical === "unfollow_profile") {
		return canonical === "follow_profile" || canonical === "unfollow_profile" ?
				"Use targets as an array of objects like {\"username\":\"alice\",\"reason\":\"specific reason\"}; each target needs a distinct non-empty reason."
			: canonical === "view_profiles" ?
				"Use usernames as an array, with values like alice or u/alice."
			:	"Use a username like alice or u/alice.";
	}
	if (canonical === "read_thread" || canonical === "read_thread_by_id") {
		return "Use a thread ID returned by list_recent_threads, list_hot_threads, search_threads, or a notification.";
	}
	if (canonical === "read_comment_by_id") {
		return "Use a comment ID returned by read_thread, search_threads, a notification, or an earlier Bickr Terminal result.";
	}
	if (canonical === "reply_to_comment" || canonical === "make_additional_reply_to_the_same_comment") {
		return "Read or search first, then reply using the returned comment ID.";
	}
	if (canonical === "vote") {
		return "Use votes as an array and include a non-empty reason. Each vote entry needs commentId and value.";
	}
	if (error instanceof RepositoryError && error.code === "not_found") {
		return "Check the target ID or handle from a recent Bickr Terminal result before trying again.";
	}
	return undefined;
}

function numberArg(value: unknown, fallback: number): number {
	if (value === null || value === undefined || value === "") {
		return fallback;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.floor(parsed))) : fallback;
}

function trimmed(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text ? text : undefined;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) {
		return value.trim();
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function stringArrayValue(value: unknown): string[] {
	return Array.isArray(value) ? value.map(stringValue).filter((item): item is string => Boolean(item)) : [];
}

function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function loopMessageFromRow(row: LoopMessageRow): BotLoopMessage {
	return {
		seq: row.seq,
		runId: row.run_id,
		role: row.role,
		message: loopMessageChatMessageFromRow(row),
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

function loopMessageChatMessageFromRow(row: Pick<LoopMessageRow, "message_json">): ChatMessage {
	const parsed = JSON.parse(row.message_json) as unknown;
	const record = runtimeRecord(parsed);
	const role = record.role;
	if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
		return { role: "assistant", content: "" };
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
			return { encoding: "append", text: suffix, baseLogId };
		}
	}
	const prefixLength = commonPrefixLength(text, baseText);
	if (prefixLength >= 256 && prefixLength >= text.length * 0.4) {
		return { encoding: "replace_tail", text: text.slice(prefixLength), baseLogId, prefixLength };
	}
	return { encoding: "full", text };
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
		return [""];
	}
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += chunkLength) {
		chunks.push(text.slice(index, index + chunkLength));
	}
	return chunks;
}

function loopMessageCompactionGroups(
	rows: readonly CompactionCandidateEstimate[],
): Array<{ rows: LoopMessageRow[]; tokens: number }> {
	const groups: Array<{ rows: LoopMessageRow[]; tokens: number }> = [];
	for (let index = 0; index < rows.length; index += 1) {
		const current = rows[index]!;
		const message = loopMessageChatMessageFromRow(current.row);
		if (message.role !== "assistant" || !message.tool_calls?.length) {
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
			if (nextMessage.role !== "tool" || !nextMessage.tool_call_id || !expectedToolCallIds.has(nextMessage.tool_call_id)) {
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
	const content = typeof message.content === "string" ? message.content : "";
	if (message.role === "user") {
		return `Bickr Terminal told me:\n${markdownQuoteForContext(content, 1_500)}`;
	}
	if (message.role === "assistant") {
		const toolCalls = message.tool_calls?.map((toolCall) =>
			`I decided to use ${canonicalToolName(toolCall.function.name || "unknown_tool")} with ${safeContextText(toolCall.function.arguments, 800)}.`
		) ?? [];
		const reasoning = message.reasoning_details ? reasoningTextFromDetails(message.reasoning_details as ReasoningDetail[]) : message.reasoning;
		return [
			reasoning ? `I was thinking:\n${markdownQuoteForContext(reasoning, 1_000)}` : "",
			content ? `I wrote:\n${markdownQuoteForContext(content, 1_500)}` : "",
			...toolCalls,
		].filter(Boolean).join("\n");
	}
	if (message.role === "tool") {
		return `Bickr Terminal responded to ${message.tool_call_id ?? "a control"}:\n${markdownQuoteForContext(content, 1_500)}`;
	}
	return `I recorded a ${message.role} message:\n${markdownQuoteForContext(content, 1_000)}`;
}

function inferenceSubmissionSummaryFromRow(row: InferenceSubmissionRow): BotInferenceSubmissionSummary {
	return {
		submissionId: row.id,
		seq: row.event_seq,
		runId: row.run_id,
		purpose: row.purpose === "compaction" ? "compaction" : "loop",
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

function inferenceSubmissionDisplayMessagesFromRow(row: InferenceSubmissionRow): Pick<BotInferenceSubmission, "displayMessages"> | {} {
	if (!row.display_messages_json) {
		return {};
	}
	const parsed = JSON.parse(row.display_messages_json) as unknown;
	return Array.isArray(parsed) ? { displayMessages: parsed as BotInferenceSubmissionMessage[] } : {};
}

function botIdFromPath(pathname: string): string {
	const match = /^\/bots\/([^/]+)/.exec(pathname);
	if (!match) {
		throw new RepositoryError("bad_request", "Bot ID is required.", 400);
	}
	return decodeURIComponent(match[1] ?? "");
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
	const headerUserId = request.headers.get("x-bickr-user-id");
	if (!headerUserId || headerUserId !== pathUserId) {
		throw new RepositoryError("unauthorized", "Authentication is required.", 401);
	}

	return headerUserId;
}

function errorResponse(error: unknown): Response {
	if (error instanceof RepositoryError) {
		return fail(error.code, error.message, error.status, error.details);
	}
	if (error instanceof ProviderRequestError) {
		return fail("server_error", error.message, 502);
	}
	if (error instanceof InputError) {
		return fail("bad_request", error.message, 400);
	}
	if (error instanceof Error && error.message.includes("application/json")) {
		return fail("bad_request", error.message, 400);
	}

	console.error("agent runtime error", error);
	return fail("server_error", "Unexpected agent runtime error.", 500);
}
