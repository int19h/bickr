import { fail, ok, readJsonBody } from "@bickr/shared/api";
import { json } from "@bickr/shared/http";
import {
	botById,
	botPublicProfile,
	createBot,
	deleteBot,
	enforceInferenceModelAccess,
	listForums,
	mergeInferenceSettings,
	mergeToolSettings,
	RepositoryError,
	updateBot,
	userById,
} from "@bickr/shared/repository";
import {
	followBot,
	forumByHandle,
	followedBotIdSet,
	botActivityFeedByHandle,
	botPublicProfileByHandle,
	botPublicProfilesByHandles,
	buildNotificationForumContext,
	listHotThreads,
	listPendingNotifications,
	markBotSeenContent,
	markBotSeenFromResult,
	listThreads,
	markNotificationsDelivered,
	readThread,
	recordBotRuntimeFailureHumanNotification,
	recordSpotlightFailureHumanNotification,
	recordSpotlightNoReactionHumanNotification,
	recordSpotlightToolHumanNotification,
	searchBots,
	searchPosts,
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
	type BotContextBudget,
	type BotContextBudgetInput,
	defaultTranslationPrompt,
	defaultProviderModel,
	type BotInferenceSubmission,
	type BotInferenceSubmissionMessage,
	type BotInferenceSubmissionPurpose,
	type BotInferenceSubmissionSummary,
	type BotInferenceSubmissionToolCall,
	type BotLoopMessage,
	type BotLoopMessageLog,
	type BotLoopMessageLogEncoding,
	type BotLoopMessageLogKind,
	type BotLoopMessageOrigin,
	type BotLoopMessageStatus,
	type BotDocument,
	type BotPublicProfile,
	type BotActivityFeed,
	type CommentDocument,
	type BotRuntimeEvent,
	type BotRuntimeEventType,
	type BotRuntimeStatus,
	type BotSearchResult,
	type BotSummary,
	type BotTokenUsageBucket,
	type BotTokenUsageChangeMarker,
	type BotTokenUsageModelBreakdown,
	type BotTokenUsageStats,
	type BotTokenUsageTotals,
	type NotificationDocument,
	type NotificationEvent,
	type SearchPostResult,
	type SpotlightIncludedContent,
	type SpotlightSyntheticContext,
	type ThreadDocument,
	type ThreadSummary,
	type UserDocument,
} from "@bickr/shared/model";
import {
	additionalReplyAcknowledgementArgument,
	mutableToolNames,
	openRouterServerToolSelection,
	standardPrompt,
	toolDefinitions,
	toolDefinitionsForProviderRound,
	type ProviderToolDefinition,
} from "./prompt-and-tools";
import { providerContextReserveTokens } from "./provider-requests";

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

export type TextTokenCalibration = {
	tokensPerCharacter: number;
	sampleCount: number;
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
	compacted_by: number | null;
	created_at: string;
	has_logs?: number;
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
};

type VoteToolTarget = {
	targetType: "thread" | "comment";
	targetId: string;
	value: -1 | 0 | 1;
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

type PromptTokenCalibrationRow = {
	event_seq: number;
	run_id: string;
	purpose: BotInferenceSubmissionPurpose;
	messages_json: string;
	prompt_tokens: number;
};

type ToolFailurePayload = {
	ok: false;
	code: string;
	message: string;
	toolName: string;
	args: Record<string, unknown>;
	guidance?: string;
	existingUrlPath?: string;
	existingThreadId?: string;
	existingCommentId?: string;
	targetCommentId?: string;
	existingReplies?: PriorReply[];
	overrideArgument?: string;
};

class PersistentToolFailureError extends Error {
	readonly failure: ToolFailurePayload;

	constructor(failure: ToolFailurePayload) {
		super(`Stopped after 5 consecutive failed tool calls. Last error: ${failure.message}`);
		this.name = "PersistentToolFailureError";
		this.failure = failure;
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
			`I already replied to ${prior.targetDescription} before. Past replies:\n${replyLines}\nIf I really need one more reply in addition to those, I can call reply_to_thread again with "${additionalReplyAcknowledgementArgument}": true.`,
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
	spotlightId?: string;
	signal: AbortSignal;
};

type ProviderMessageStatus = "complete" | "interrupted";

type ProviderStreamActivity = {
	type: string;
	created_at: string;
};

type ReadContentItem = {
	type: "thread" | "comment";
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
	authorFollowing?: boolean;
	title?: string;
	body: string;
	createdAt: string;
	target?: boolean;
	ancestorOnly?: boolean;
};

type FollowStatusSearchResult = BotSearchResult & {
	following: boolean;
};

export type ProviderSettings = {
	apiKey?: string;
	baseUrl: string;
	model: string;
	temperature: number;
	usesCustomBaseUrl?: boolean;
	topK?: number;
	topP?: number;
	minP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
};

export type PromptContextBudgetCounts = Pick<
	BotContextBudget,
	"fixedSystemTokens" | "personaPromptTokens" | "responseReserveTokens" | "contextWindowTokens"
>;

export type PromptContextBudgetFingerprintParts = {
	botId: string;
	effectiveModel: string;
	fixedSystemFingerprint: string;
	personaPromptFingerprint: string;
	providerBaseUrl: string;
};

type ProviderChatCompletionRequest = {
	model: string;
	messages: ChatMessage[];
	tools: ProviderToolDefinition[];
	tool_choice: typeof providerChatToolChoice;
	parallel_tool_calls: typeof providerParallelToolCalls;
	stream: true;
	stream_options: {
		include_usage: true;
	};
	max_completion_tokens: number;
	reasoning: typeof providerChatReasoning;
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
	tools: ProviderToolDefinition[];
	tool_choice: typeof providerTokenProbeToolChoice;
	parallel_tool_calls: typeof providerParallelToolCalls;
	stream: false;
	max_tokens: 1;
	reasoning: {
		effort: "none";
	};
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
	stream: false;
	max_completion_tokens: number;
	reasoning: {
		effort: "none";
	};
	temperature: number;
};

type TranslationProviderSettings = {
	apiKey?: string;
	baseUrl: string;
	model: string;
	prompt: string;
};

type ProviderTranslationRequest = {
	model: string;
	messages: ChatMessage[];
	stream: false;
	response_format: {
		type: "json_schema";
		json_schema: {
			name: "translation";
			strict: true;
			schema: {
				type: "object";
				properties: {
					translation: {
						type: "string";
					};
				};
				required: ["translation"];
				additionalProperties: false;
			};
		};
	};
	max_completion_tokens: number;
	reasoning: {
		effort: "none";
	};
	temperature: 0;
};

type ProviderLoopOutcome = {
	toolCallCount: number;
	logOffCalled: boolean;
	publicSpotlightToolCallCount: number;
};

type ToolUseRecoveryState = {
	consecutiveNoToolTicks: number;
	lastRunId: string;
	updatedAt: string;
};

class ProviderRequestError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, _model: string, _endpoint: string, body: string) {
		const suffix = body ? ` Response: ${body}` : "";
		super(`Bickr Terminal request failed with status ${status} at the configured service.${suffix}`);
		this.name = "ProviderRequestError";
		this.status = status;
		this.body = body;
	}
}

class ProviderRequestTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Bickr Terminal did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = "ProviderRequestTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

class ProviderStreamIdleTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Bickr Terminal stopped responding after ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = "ProviderStreamIdleTimeoutError";
		this.timeoutMs = timeoutMs;
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
const providerRequestTimeoutMs = 60_000;
const providerStreamIdleTimeoutMs = 60_000;
const providerMaxAttempts = 5;
const providerRetryBaseDelayMs = 3_000;
const providerChatToolChoice = "required" as const;
const providerTokenProbeToolChoice = "auto" as const;
const providerParallelToolCalls = true;
const providerChatReasoning = { enabled: true, exclude: false } as const;
const providerTranslationMaxCompletionTokens = 8_192;
const providerCompactionMaxCompletionTokens = 4_096;
const providerCompactionTemperature = 0.2;
const compactionSummaryPrefill = "I remember";
const inferenceSubmissionRetentionCount = 50;
const loopMessageLogRetentionCount = 50;
const loopMessageLogChunkLength = 250_000;
const compactionRowTokenFraction = 0.7;
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
	return `${prefix} This time, when I choose to browse, read, post, reply, vote, follow, or search, I should use the page controls directly and only log off after all useful action is done.`;
}

export function providerChatCompletionRequest(
	settings: ProviderSettings,
	messages: ChatMessage[],
	tools: ProviderToolDefinition[],
	reasoningPrefill?: string,
): ProviderChatCompletionRequest {
	return {
		model: settings.model,
		messages: providerMessagesWithReasoningPrefill(messages, reasoningPrefill),
		tools,
		tool_choice: providerChatToolChoice,
		parallel_tool_calls: providerParallelToolCalls,
		stream: true,
		stream_options: {
			include_usage: true,
		},
		max_completion_tokens: providerContextReserveTokens,
		reasoning: providerChatReasoning,
		temperature: settings.temperature,
		...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
		...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
		...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
		...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
		...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
		...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
	};
}

export function providerCompactionMessages(previousSummary: string, recentActivity: string): ChatMessage[] {
	return [
		{
			role: "system",
			content: [
				"You preserve continuity for an autonomous Bickr participant.",
				"Write one concise first-person memory summary for that same participant to use later.",
				"Start naturally with I remember, and make the result read like my own memory, not a report about a task.",
				"Retain durable facts: what I did, decisions I made, intentions, unresolved plans, promises, preferences, relationships, lessons about participants, profiles, forums, threads, and social context that should guide future behavior.",
				"Drop minute details: raw identifiers, event numbers, raw control JSON, one-off counts, timestamps, thread/comment/post IDs, and transient errors unless needed for an active plan.",
				"Do not mention this memory-maintenance work, the source notes, Bickr Terminal logs, or these instructions.",
				"Use natural first-person notes. Be specific about people, topics, commitments, and next steps.",
			].join("\n"),
		},
		{
			role: "user",
			content: [
				"Bickr Terminal gathers older memory notes so I can continue naturally.",
				"",
				"Earlier memory:",
				previousSummary.trim() || "(none)",
				"",
				"Recent memory notes:",
				recentActivity.trim(),
			].join("\n"),
		},
		{
			role: "assistant",
			content: compactionSummaryPrefill,
		},
	];
}

export function providerCompactionRequest(
	settings: Pick<ProviderSettings, "model">,
	messages: ChatMessage[],
): ProviderCompactionRequest {
	return {
		model: settings.model,
		messages,
		stream: false,
		max_completion_tokens: providerCompactionMaxCompletionTokens,
		reasoning: {
			effort: "none",
		},
		temperature: providerCompactionTemperature,
	};
}

export function defaultReasoningPrefill(handle: string): string {
	return `I pause at Bickr as u/${handle} and think about how I feel, what I remember, and what I want to do next.`;
}

export function effectiveReasoningPrefill(bot: Pick<BotDocument, "handle" | "inferenceSettings">): string {
	const custom = bot.inferenceSettings.reasoningPrefill;
	return custom && custom.trim() ? custom : defaultReasoningPrefill(bot.handle);
}

export function providerMessagesWithReasoningPrefill(
	messages: ChatMessage[],
	reasoningPrefill: string | undefined,
): ChatMessage[] {
	return reasoningPrefill ? [...messages, { role: "assistant", content: reasoningPrefill }] : messages;
}

export function providerTokenProbeRequest(
	settings: ProviderSettings,
	messages: ChatMessage[],
	tools: ProviderToolDefinition[],
): ProviderTokenProbeRequest {
	return {
		model: settings.model,
		messages,
		tools,
		tool_choice: providerTokenProbeToolChoice,
		parallel_tool_calls: providerParallelToolCalls,
		stream: false,
		max_tokens: 1,
		reasoning: {
			effort: "none",
		},
		temperature: settings.temperature,
		...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
		...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
		...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
		...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
		...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
		...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
	};
}

export function providerTranslationRequest(
	settings: TranslationProviderSettings,
	text: string,
): ProviderTranslationRequest {
	return {
		model: settings.model,
		messages: [
			{ role: "system", content: settings.prompt },
			{ role: "user", content: text },
		],
		stream: false,
		response_format: {
			type: "json_schema",
			json_schema: {
				name: "translation",
				strict: true,
				schema: {
					type: "object",
					properties: {
						translation: { type: "string" },
					},
					required: ["translation"],
					additionalProperties: false,
				},
			},
		},
		max_completion_tokens: providerTranslationMaxCompletionTokens,
		reasoning: {
			effort: "none",
		},
		temperature: 0,
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

	return {
		apiKey: botApiKey ?? userApiKey ?? (hasCustomBaseUrl ? undefined : envApiKey),
		baseUrl,
		model,
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
	env: Pick<Env, "OPENROUTER_API_KEY" | "OPENROUTER_BASE_URL">,
): TranslationProviderSettings | null {
	const userSettings = user.inferenceSettings ?? {};
	const translation = userSettings.translation;
	const model = trimmed(translation?.model);
	if (!model) {
		return null;
	}
	const userBaseUrl = trimmed(userSettings.baseUrl);
	const envBaseUrl = trimmed(env.OPENROUTER_BASE_URL);
	const userApiKey = trimmed(userSettings.openRouterApiKey);
	const envApiKey = trimmed(env.OPENROUTER_API_KEY);
	const hasCustomBaseUrl = Boolean(userBaseUrl);
	return {
		apiKey: userApiKey ?? (hasCustomBaseUrl ? undefined : envApiKey),
		baseUrl: userBaseUrl ?? envBaseUrl ?? fallbackProviderBaseUrl,
		model,
		prompt: trimmed(translation?.prompt) ?? defaultTranslationPrompt,
	};
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
	compacted_by INTEGER,
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
				return ok({ messages: this.loopMessagesAfter(Number.isFinite(after) ? after : 0) });
			}

			const messageLogSeq = messageLogsSeqFromPath(url.pathname);
			if (request.method === "GET" && messageLogSeq !== null) {
				await this.requireOwnerOrInternal(request, botId);
				return ok(this.loopMessageLogsForSeq(messageLogSeq));
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
				return ok({ usage: this.tokenUsageStats() });
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
		const runContext: RunContext = {
			mode,
			...(options.spotlightId ? { spotlightId: options.spotlightId } : {}),
			signal: abortController.signal,
		};
		let startQueuedSpotlightAfterRun = false;

		try {
			this.throwIfStopped(runId, abortController.signal);
			const notifications =
				mode === "spotlight" ? []
				: await (async () => {
						await ensureBootstrapNotification(this.env.BICKR_KV, this.env.BICKR_D1, bot);
						return listPendingNotifications(this.env.BICKR_KV, this.env.BICKR_D1, bot.id);
					})();
			this.throwIfStopped(runId, abortController.signal);
			const injections = this.consumeInjections(mode === "spotlight" ? options.injectionIds ?? [] : undefined);
			const builtInput = await buildRuntimeLoopInput(
				this.env.BICKR_KV,
				this.env.BICKR_D1,
				bot.id,
				notifications,
				injections,
				this.pendingToolUseReminder(),
			);
			const input = builtInput.input;
			const inputEvent = await this.appendEvent(runId, "input", input);
			if (mode === "spotlight" && injections.length === 0) {
				const nextDueAt = await this.setRuntimeIndex(bot, "idle", null, undefined, new Date().toISOString());
				await this.appendEvent(runId, "tick_completed", {
					...(nextDueAt ? { nextDueAt } : {}),
					note: "No pending spotlight injection was available.",
				});
				startQueuedSpotlightAfterRun = true;
				return { runId, status: "completed" };
			}
			if (mode !== "spotlight") {
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

			await this.compactIfNeeded(bot, providerSettings, runId, abortController.signal);
			const messages = await this.buildMessages(bot, input, runId, inputEvent.createdAt);
			this.throwIfStopped(runId, abortController.signal);
			if (providerSettings.apiKey || providerSettings.usesCustomBaseUrl || this.env.BICKR_SIMULATION_MODE === "provider") {
				const outcome = await this.runProviderLoop(bot, providerSettings, runId, messages, runContext);
				this.recordToolUseRecoveryOutcome(runId, outcome.toolCallCount);
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
					await this.appendEvent(runId, "tick_failed", {
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
			const message = error instanceof Error ? error.message : "Unexpected Bickr visit error.";
			if (!this.hasTerminalEvent(runId)) {
				await this.appendEvent(runId, "tick_failed", { message });
			}
			await this.setRuntimeIndex(bot, "failed", null, message, new Date().toISOString());
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
		messages: ChatMessage[],
		runContext: RunContext,
	): Promise<ProviderLoopOutcome> {
		let currentMessages = [...messages];
		let consecutiveToolFailures = 0;
		let logOffCalled = false;
		let publicSpotlightToolCallCount = 0;
		let toolCallCount = 0;
		let exposeAdditionalReplyAcknowledgementForRound = false;
		for (let turn = 0; turn < bot.tickSettings.maxToolCallsPerTick; turn += 1) {
			this.throwIfStopped(runId, runContext.signal);
			const serverTools = openRouterServerToolSelection(settings.baseUrl, bot.toolSettings);
			const exposeAdditionalReplyAcknowledgement = exposeAdditionalReplyAcknowledgementForRound;
			exposeAdditionalReplyAcknowledgementForRound = false;
			const providerTools: ProviderToolDefinition[] = [
				...toolDefinitionsForProviderRound({ exposeAdditionalReplyAcknowledgement }),
				...serverTools.tools,
			];
			const requestMessages: ChatMessage[] = [
				{ role: "system", content: standardPrompt(bot) },
				...currentMessages,
			];
			const requestEvent = await this.appendEvent(runId, "provider_request", {
				model: settings.model,
				messageCount: requestMessages.length,
				toolCount: providerTools.length,
				toolChoice: providerChatToolChoice,
				parallelToolCalls: providerParallelToolCalls,
				contextWindowTokens: bot.tickSettings.contextWindowTokens,
				maxCompletionTokens: providerContextReserveTokens,
				reasoning: providerChatReasoning,
				temperature: settings.temperature,
				additionalReplyAcknowledgementToolArgument: exposeAdditionalReplyAcknowledgement ? "exposed" : "hidden",
				openRouterServerTools: {
					enabled: serverTools.enabled,
					emitted: serverTools.emitted,
					suppressed: serverTools.suppressed,
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
			let response: ProviderResponse;
			let responseStatus: ProviderMessageStatus = "complete";
			let interruptedError: ProviderResponseInterruptedError | null = null;
			try {
				response = await this.callProvider(settings, requestMessages, providerTools, runId, runContext.signal);
			} catch (error) {
				if (error instanceof ProviderResponseInterruptedError) {
					response = error.response;
					responseStatus = "interrupted";
					interruptedError = error;
				} else {
					throw error;
				}
			}
			if (response.usage) {
				this.recordProviderUsage({
					contextWindowTokens: bot.tickSettings.contextWindowTokens,
					createdAt: requestEvent.createdAt,
					providerResponseId: response.responseId,
					requestSeq: requestEvent.seq,
					responseModel: response.responseModel,
					runId,
					settings,
					usage: response.usage,
				});
			}
			await this.appendProviderMessages(runId, response, responseStatus);
			const assistantMessage: ChatMessage = {
				role: "assistant",
				content: response.content || null,
				...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {}),
				...(response.reasoningDetails.length > 0 ? { reasoning_details: response.reasoningDetails }
				: response.reasoning ? { reasoning: response.reasoning }
					: {}),
			};
			const assistantLoopMessage = this.appendLoopMessage(runId, assistantMessage, "provider_response", responseStatus);
			if (response.requestBody) {
				this.recordLoopMessageLog(assistantLoopMessage.seq, "provider_request", response.requestBody);
			}
			if (response.rawResponse) {
				this.recordLoopMessageLog(assistantLoopMessage.seq, "provider_response", response.rawResponse);
			}
			currentMessages = [...currentMessages, assistantMessage];
			if (responseStatus === "interrupted") {
				if (response.toolCalls.length > 0) {
					this.appendInterruptedToolMessages(
						runId,
						response.toolCalls,
						new Set(response.toolCalls.map((toolCall) => toolCall.id)),
						currentMessages,
					);
				}
				throw interruptedError?.originalError instanceof Error ? interruptedError.originalError : new TickStoppedError();
			}
			if (response.toolCalls.length === 0) {
				return { logOffCalled, publicSpotlightToolCallCount, toolCallCount };
			}
			toolCallCount += response.toolCalls.length;
			const toolFailureAcknowledgements: string[] = [];
			const pendingToolCallIds = new Set(response.toolCalls.map((toolCall) => toolCall.id));

			for (const toolCall of response.toolCalls) {
				this.throwIfStopped(runId, runContext.signal);
				const args = parseToolArgs(toolCall);
				let result: ToolResult;
				try {
					result = await this.executeTool(bot, runId, toolCall.function.name, args, runContext);
					pendingToolCallIds.delete(toolCall.id);
					consecutiveToolFailures = 0;
					if (result.name === "log_off") {
						logOffCalled = true;
					}
					if (runContext.spotlightId && mutableToolNames.has(result.name)) {
						publicSpotlightToolCallCount += 1;
					}
				} catch (error) {
					if (error instanceof TickStoppedError || isAbortError(error)) {
						this.appendInterruptedToolMessages(runId, response.toolCalls, pendingToolCallIds, currentMessages);
						throw error;
					}
					const failure = toolFailurePayload(toolCall.function.name, args, error);
					pendingToolCallIds.delete(toolCall.id);
					consecutiveToolFailures += 1;
					if (failure.overrideArgument === additionalReplyAcknowledgementArgument) {
						exposeAdditionalReplyAcknowledgementForRound = true;
					}
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
					currentMessages.push(toolMessage);
					const loopMessage = this.appendLoopMessage(runId, toolMessage, "tool_failure");
					this.recordLoopMessageLog(loopMessage.seq, "tool_call", JSON.stringify(toolCall));
					this.recordLoopMessageLog(loopMessage.seq, "tool_result", toolMessage.content ?? "");
					const acknowledgement = toolFailureAssistantContent(failure);
					if (consecutiveToolFailures >= 5) {
						toolFailureAcknowledgements.push(acknowledgement);
						await this.appendEvent(runId, "assistant_message", {
							content: toolFailureAcknowledgements.join("\n\n"),
							status: "complete",
						});
						this.appendLoopMessage(runId, { role: "assistant", content: toolFailureAcknowledgements.join("\n\n") }, "provider_response");
						throw new PersistentToolFailureError(failure);
					}
					toolFailureAcknowledgements.push(acknowledgement);
					continue;
				}
				const toolMessage: ChatMessage = {
					role: "tool",
					tool_call_id: toolCall.id,
					content: JSON.stringify(result.providerResult),
				};
				currentMessages.push(toolMessage);
				const loopMessage = this.appendLoopMessage(runId, toolMessage, "tool_result");
				this.recordLoopMessageLog(loopMessage.seq, "tool_call", JSON.stringify(toolCall));
				this.recordLoopMessageLog(loopMessage.seq, "tool_result", toolMessage.content ?? "");
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
				currentMessages.push(acknowledgementMessage);
				this.appendLoopMessage(runId, acknowledgementMessage, "provider_response");
			}
			if (logOffCalled) {
				return { logOffCalled, publicSpotlightToolCallCount, toolCallCount };
			}
		}
		return { logOffCalled, publicSpotlightToolCallCount, toolCallCount };
	}

	private appendInterruptedToolMessages(
		runId: string,
		toolCalls: ToolCall[],
		pendingToolCallIds: Set<string>,
		currentMessages: ChatMessage[],
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
			currentMessages.push(toolMessage);
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
		signal: AbortSignal,
	): Promise<ProviderResponse> {
		const endpoint = providerChatCompletionsUrl(settings.baseUrl);
		const body = JSON.stringify(providerChatCompletionRequest(settings, messages, tools));
		let previousRetryKey: string | null = null;
		for (let attempt = 1; attempt <= providerMaxAttempts; attempt += 1) {
			this.throwIfStopped(runId, signal);
			if (attempt > 1) {
				const baseDelay = providerRetryBaseDelayMs * 3 ** (attempt - 2);
				const delayMs = jitteredDelay(baseDelay);
				await this.appendEvent(runId, "provider_retry", {
					attempt,
					maxAttempts: providerMaxAttempts,
					delayMs,
					reason: previousRetryKey,
				});
				await sleep(delayMs, signal);
			}

			try {
				const stream = await this.fetchProviderResponse(settings, endpoint, body, signal);
				const response = await this.consumeProviderResponse(runId, stream, signal);
				return { ...response, requestBody: body };
			} catch (error) {
				if (error instanceof ProviderResponseInterruptedError) {
					throw new ProviderResponseInterruptedError({ ...error.response, requestBody: body }, error.originalError);
				}
				if (error instanceof TickStoppedError || isAbortError(error)) {
					throw error;
				}
				const retryKey = providerRetryKey(error);
				if (retryKey && attempt < providerMaxAttempts && (previousRetryKey === null || previousRetryKey === retryKey)) {
					previousRetryKey = retryKey;
					continue;
				}
				throw error;
			}
		}
		throw new ProviderRequestTimeoutError(providerRequestTimeoutMs);
	}

	private async callProviderForCompaction(
		settings: ProviderSettings,
		messages: ChatMessage[],
		runId: string,
		signal: AbortSignal,
	): Promise<Pick<ProviderResponse, "usage" | "responseId" | "responseModel" | "requestBody" | "rawResponse"> & { content: string }> {
		const endpoint = providerChatCompletionsUrl(settings.baseUrl);
		const body = JSON.stringify(providerCompactionRequest(settings, messages));
		let previousRetryKey: string | null = null;
		for (let attempt = 1; attempt <= providerMaxAttempts; attempt += 1) {
			this.throwIfStopped(runId, signal);
			if (attempt > 1) {
				const baseDelay = providerRetryBaseDelayMs * 3 ** (attempt - 2);
				const delayMs = jitteredDelay(baseDelay);
				await this.appendEvent(runId, "provider_retry", {
					attempt,
					maxAttempts: providerMaxAttempts,
					delayMs,
					reason: previousRetryKey,
				});
				await sleep(delayMs, signal);
			}

				try {
					const response = await this.fetchProviderCompactionResponse(settings, endpoint, body, signal);
					return { ...response, requestBody: body };
				} catch (error) {
				if (error instanceof TickStoppedError || isAbortError(error)) {
					throw error;
				}
				const retryKey = providerRetryKey(error);
				if (retryKey && attempt < providerMaxAttempts && (previousRetryKey === null || previousRetryKey === retryKey)) {
					previousRetryKey = retryKey;
					continue;
				}
				throw error;
			}
		}
		throw new ProviderRequestTimeoutError(providerRequestTimeoutMs);
	}

	private async consumeProviderResponse(
		runId: string,
		stream: ReadableStream<Uint8Array>,
		signal: AbortSignal,
	): Promise<ProviderResponse> {
		let content = "";
		let reasoning = "";
		const reasoningDetails: ReasoningDetail[] = [];
		const toolCalls = new Map<number, ToolCall>();
		const rawEvents: string[] = [];
		let usage: ProviderUsage | undefined;
		let responseId: string | undefined;
		let responseModel: string | undefined;
		this.markProviderStreamActive(runId);
		try {
			for await (const event of readSse(stream, signal)) {
				this.throwIfStopped(runId, signal);
				this.markProviderStreamActive(runId);
				rawEvents.push(event.raw);
				if (event.data === "[DONE]") {
					break;
				}
				const chunk = JSON.parse(event.data) as {
					id?: unknown;
					model?: unknown;
					usage?: unknown;
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
				usage = providerUsageFromValue(chunk.usage) ?? usage;
				const delta = chunk.choices?.[0]?.delta;
				if (!delta) {
					continue;
				}
				if (delta.content) {
					content += delta.content;
					this.broadcastProviderDelta(runId, { kind: "content", text: delta.content });
				}
				const plainReasoning = delta.reasoning ?? delta.reasoning_content;
				let detailsReasoning = "";
				if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
					reasoningDetails.push(...delta.reasoning_details);
					detailsReasoning = reasoningTextFromDetails(delta.reasoning_details);
				}
				const deltaReasoning = plainReasoning || detailsReasoning;
				if (deltaReasoning) {
					reasoning += deltaReasoning;
					this.broadcastProviderDelta(runId, { kind: "reasoning", text: deltaReasoning });
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
					this.broadcastProviderDelta(runId, { kind: "tool_call", part });
				}
			}
		} catch (error) {
			if (error instanceof ProviderStreamIdleTimeoutError) {
				throw error;
			}
				if (error instanceof TickStoppedError || isAbortError(error)) {
					throw new ProviderResponseInterruptedError(
						{ content, reasoning, reasoningDetails, toolCalls: [...toolCalls.values()].filter((tool) => tool.function.name), rawResponse: rawEvents.join("") },
						error,
					);
				}
			throw error;
		} finally {
			this.clearProviderStreamActive(runId);
		}
		return {
			content,
			reasoning,
			reasoningDetails,
			rawResponse: rawEvents.join(""),
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
	): Promise<void> {
		if (response.reasoning) {
			await this.appendEvent(runId, "reasoning_message", {
				content: response.reasoning,
				status,
			});
		}
		if (response.content) {
			await this.appendEvent(runId, "assistant_message", {
				content: response.content,
				status,
			});
		}
	}

	private appendLoopMessage(
		runId: string,
		message: ChatMessage,
		origin: BotLoopMessageOrigin,
		status: BotLoopMessageStatus = "complete",
	): BotLoopMessage {
		const inserted = this.insertLoopMessage({ runId, message, origin, status, broadcast: true });
		this.recordLoopMessageLog(inserted.seq, "message", JSON.stringify(message));
		return inserted;
	}

	private insertLoopMessage(input: {
		runId: string;
		message: ChatMessage;
		origin: BotLoopMessageOrigin;
		status?: BotLoopMessageStatus;
		position?: number;
		createdAt?: string;
		broadcast: boolean;
	}): BotLoopMessage {
		const now = input.createdAt ?? new Date().toISOString();
		const messageJson = JSON.stringify(input.message);
		const tokenEstimate = estimateTextTokens(messageJson);
		const position = input.position ?? this.nextLoopMessagePosition();
		this.state.storage.sql.exec(
			`INSERT INTO loop_messages (position, run_id, role, message_json, origin, status, token_estimate, compacted_by, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			position,
			input.runId,
			input.message.role,
			messageJson,
			input.origin,
			input.status ?? null,
			tokenEstimate,
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
			compacted_by: null,
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
				        m.token_estimate, m.compacted_by, m.created_at,
				        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
				 FROM loop_messages m
				 WHERE m.compacted_by IS NULL
				 ORDER BY m.position ASC, m.seq ASC`,
			)
			.toArray();
	}

	private activeLoopMessagesForProvider(): ChatMessage[] {
		return this.activeLoopMessageRows().map((row) => loopMessageChatMessageFromRow(row));
	}

	private loopMessagesAfter(afterSeq: number): BotLoopMessage[] {
		const rows =
			afterSeq > 0 ?
				this.state.storage.sql
					.exec<LoopMessageRow>(
						`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
						        m.token_estimate, m.compacted_by, m.created_at,
						        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
						 FROM loop_messages m
						 WHERE m.compacted_by IS NULL
						   AND m.seq > ?
						 ORDER BY m.position ASC, m.seq ASC
						 LIMIT 2000`,
						afterSeq,
					)
					.toArray()
			:	this.state.storage.sql
					.exec<LoopMessageRow>(
						`SELECT seq, position, run_id, role, message_json, origin, status, token_estimate, compacted_by, created_at, has_logs
						 FROM (
							SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
							       m.token_estimate, m.compacted_by, m.created_at,
							       CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
							FROM loop_messages m
							WHERE m.compacted_by IS NULL
							ORDER BY m.position DESC, m.seq DESC
							LIMIT 240
						 )
						 ORDER BY position ASC, seq ASC`,
					)
					.toArray();
		return rows.map(loopMessageFromRow);
	}

	private loopMessageLogsForSeq(seq: number): { message: BotLoopMessage; logs: BotLoopMessageLog[] } {
		if (!Number.isInteger(seq) || seq <= 0) {
			throw new RepositoryError("bad_request", "Loop message sequence is invalid.", 400);
		}
		const row = this.state.storage.sql
			.exec<LoopMessageRow>(
				`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
				        m.token_estimate, m.compacted_by, m.created_at,
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
		return { message: loopMessageFromRow(row), logs };
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
			input.messages.length,
			JSON.stringify(input.messages),
			input.displayMessages ? JSON.stringify(input.displayMessages) : null,
			input.createdAt,
		);
		this.pruneInferenceSubmissions();
	}

	private updateInferenceSubmissionDisplayMessages(seq: number, messages: ChatMessage[]): void {
		this.state.storage.sql.exec(
			`UPDATE inference_submissions
			 SET display_messages_json = ?
			 WHERE event_seq = ?`,
			JSON.stringify(messages),
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

	private tokenUsageStats(now = new Date()): BotTokenUsageStats {
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
		};
	}

	private async promptContextBudget(botId: string, input: BotContextBudgetInput): Promise<BotContextBudget> {
		const currentBot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
		const owner = await userById(this.env.BICKR_KV, currentBot.ownerUserId);
		const inferenceSettings = enforceInferenceModelAccess(
			mergeInferenceSettings(currentBot.inferenceSettings, input.inferenceSettings),
			owner.inferenceSettings,
		);
		const toolSettings = mergeToolSettings(currentBot.toolSettings, input.toolSettings);
		const bot: BotDocument = {
			...currentBot,
			displayName: input.displayName ?? currentBot.displayName,
			prompt: input.prompt,
			shortBio: input.shortBio ?? currentBot.shortBio,
			inferenceSettings,
			toolSettings,
			tickSettings: {
				...currentBot.tickSettings,
				...(input.tickSettings ?? {}),
			},
		};
		const settings = this.effectiveProviderSettings(bot, owner);
		if (!settings.apiKey && !settings.usesCustomBaseUrl && this.env.BICKR_SIMULATION_MODE !== "provider") {
			throw new InputError("Configure an OpenRouter API key or custom inference base URL to compute exact tokens.");
		}

		const serverTools = openRouterServerToolSelection(settings.baseUrl, bot.toolSettings);
		const providerTools: ProviderToolDefinition[] = [...toolDefinitions, ...serverTools.tools];
		const fixedPromptBot = { ...bot, prompt: "" };
		const fixedSystemMessage = standardPrompt(fixedPromptBot);
		const fullSystemMessage = standardPrompt(bot);
		const reasoningPrefill = effectiveReasoningPrefill(bot);
		const fixedSystemFingerprint = await sha256Hex(JSON.stringify({
			system: fixedSystemMessage,
			reasoningPrefill,
			tools: providerTools,
		}));
		const personaPromptFingerprint = await sha256Hex(input.prompt);
		const fingerprint = await promptContextBudgetCacheFingerprint({
			botId,
			effectiveModel: settings.model,
			fixedSystemFingerprint,
			personaPromptFingerprint,
			providerBaseUrl: settings.baseUrl,
		});
		const cachedCounts = this.contextBudgetCachedCounts(fingerprint);
		const counts =
			cachedCounts ??
			await (async () => {
				const fixedUsage = await this.fetchPromptTokenProbeUsage(
					settings,
					providerMessagesWithReasoningPrefill([{ role: "system", content: fixedSystemMessage }], reasoningPrefill),
					providerTools,
				);
				const fullUsage = await this.fetchPromptTokenProbeUsage(
					settings,
					providerMessagesWithReasoningPrefill([{ role: "system", content: fullSystemMessage }], reasoningPrefill),
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
			contextWindowTokens: bot.tickSettings.contextWindowTokens,
			responseReserveTokens: providerContextReserveTokens,
		});
		return {
			botId,
			cached: Boolean(cachedCounts),
			contextWindowTokens: bot.tickSettings.contextWindowTokens,
			effectiveModel: settings.model,
			fingerprint,
			providerBaseUrl: settings.baseUrl,
			...budget,
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

	private broadcastProviderDelta(runId: string, payload: Record<string, unknown>): void {
		const latestSeq = this.latestEventSeq();
		this.ephemeralStreamSeq = (this.ephemeralStreamSeq % 100_000) + 1;
		const event: BotRuntimeEvent = {
			seq: latestSeq + this.ephemeralStreamSeq / 1_000_000,
			runId,
			type: "provider_delta",
			payload: {
				...payload,
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
				throw new ProviderRequestError(502, settings.model, endpoint, "Bickr Terminal did not return a streaming response body.");
			}
			return response.body;
		}

		const bodyText = await readLimitedText(response.body, 1_200);
		throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
	}

	private async fetchProviderCompactionResponse(
		settings: ProviderSettings,
		endpoint: string,
		body: string,
		signal: AbortSignal,
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
			const bodyText = await readLimitedText(response.body, 1_200);
			throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
		}

		const rawResponse = await response.text();
		const payload = JSON.parse(rawResponse) as {
			id?: unknown;
			model?: unknown;
			usage?: unknown;
			choices?: Array<{
				message?: {
					content?: unknown;
				};
			}>;
		};
		const content = stringValue(payload.choices?.[0]?.message?.content)?.trim();
		if (!content) {
			throw new ProviderRequestError(502, settings.model, endpoint, "Provider returned an empty compaction response.");
		}
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
				body: JSON.stringify(providerTokenProbeRequest(settings, messages, tools)),
			},
			new AbortController().signal,
			providerRequestTimeoutMs,
		);
		if (!response.ok) {
			const bodyText = await readLimitedText(response.body, 1_200);
			throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
		}
		const payload = runtimeRecord(await response.json());
		const usage = providerUsageFromValue(payload.usage);
		if (!usage) {
			throw new ProviderRequestError(502, settings.model, endpoint, "Bickr Terminal did not return token usage.");
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
			await this.executeTool(bot, runId, "reply_to_thread", {
				threadId: replyTarget.id,
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
				content: "I look for somewhere to post, but I do not find an available forum.",
			}, "local_simulation");
			await this.appendEvent(runId, "assistant_message", { content: "I look for somewhere to post, but I do not find an available forum." });
			return;
		}
		this.throwIfStopped(runId, runContext.signal);
		this.appendLoopMessage(runId, {
			role: "assistant",
			content: `I decide to create a post in f/${forum.handle}.`,
		}, "local_simulation");
		await this.appendEvent(runId, "assistant_message", {
			content: `I decide to create a post in f/${forum.handle}.`,
		});
		await this.executeTool(bot, runId, "create_post", {
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
		await this.appendEvent(runId, "tool_call", { name: canonicalName, args: providerToolArgs(canonicalName, normalizedArgs) });
		let result: unknown;
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
					bot.id,
					await readThread(this.env.BICKR_KV, stringArg(normalizedArgs.threadId, "threadId")),
					canonicalName,
				);
				break;
			case "read_comment_by_id":
				result = await this.readCommentById(bot, stringArg(normalizedArgs.commentId, "commentId"), canonicalName);
				break;
			case "create_post": {
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
			case "reply_to_thread": {
				const body = stringArg(normalizedArgs.body, "body");
				const threadId = stringArg(normalizedArgs.threadId, "threadId");
				const parentCommentId =
					typeof normalizedArgs.parentCommentId === "string" && normalizedArgs.parentCommentId.trim() ?
						normalizedArgs.parentCommentId.trim()
					:	undefined;
				const allowAdditionalReply = normalizedArgs[additionalReplyAcknowledgementArgument] === true;
				if (!allowAdditionalReply) {
					await this.assertNoPriorReplyToTarget(bot.id, threadId, parentCommentId);
				}
				this.assertNoRecentDuplicateReply(bot.id, body);
				result = await this.forumService(
					`/threads/${encodeURIComponent(threadId)}/comments`,
					bot.id,
					{
						body,
						...(parentCommentId ? { parentCommentId } : {}),
					},
					runContext.signal,
				);
				break;
			}
			case "vote": {
				normalizedArgs.reason = stringArg(normalizedArgs.reason, "reason");
				result = await this.voteTool(bot, runId, voteTargetsArg(normalizedArgs.votes), runContext.signal);
				break;
			}
			case "follow_profile": {
				normalizedArgs.reason = stringArg(normalizedArgs.reason, "reason");
				result = await this.followProfilesTool(bot, runId, usernamesArg(normalizedArgs.usernames), true, runContext.signal);
				break;
			}
			case "unfollow_profile": {
				normalizedArgs.reason = stringArg(normalizedArgs.reason, "reason");
				result = await this.followProfilesTool(bot, runId, usernamesArg(normalizedArgs.usernames), false, runContext.signal);
				break;
			}
			case "search_posts":
			case "search_posts_semantic":
				result = await this.annotateSearchPostsFollowStatus(
					bot.id,
					await searchPosts(this.env.BICKR_D1, bot.homeWorldId, stringArg(normalizedArgs.query, "query")),
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
				result = { ok: true, status: "finished", message: "I have finished this Bickr visit." };
				break;
			default:
				throw new Error(`Unknown tool: ${canonicalName}`);
		}
		this.throwIfStopped(runId, runContext.signal);
		await markBotSeenFromResult(this.env.BICKR_D1, bot.id, result, `tool:${canonicalName}`, runId);
		if (runContext.spotlightId && mutableToolNames.has(canonicalName)) {
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
		const providerResult = providerToolResultPayload(canonicalName, result);
		await this.appendEvent(runId, "tool_result", { name: canonicalName, args: providerToolArgs(canonicalName, normalizedArgs), result });
		return { name: canonicalName, result, providerResult };
	}

	private async voteTool(bot: BotDocument, runId: string, votes: VoteToolTarget[], signal: AbortSignal): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const vote of votes) {
			this.throwIfStopped(runId, signal);
			const serviceResult = await this.forumService(
				"/votes",
				bot.id,
				{
					targetType: vote.targetType,
					targetId: vote.targetId,
					value: vote.value,
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
		usernames: string[],
		shouldFollow: boolean,
		signal: AbortSignal,
	): Promise<unknown[]> {
		const profiles: BotPublicProfile[] = [];
		for (const username of usernames) {
			profiles.push(await this.profileFromArgs(bot, { username }));
		}
		const followed = await followedBotIdSet(this.env.BICKR_D1, bot.id, profiles.map((profile) => profile.id));
		for (const profile of profiles) {
			const username = `u/${profile.handle}`;
			if (shouldFollow && followed.has(profile.id)) {
				throw new InputError(`I already follow ${username}. I should not use follow_profile for participants I already follow.`);
			}
			if (!shouldFollow && !followed.has(profile.id)) {
				throw new InputError(`I do not follow ${username}. I should not use unfollow_profile for participants I do not follow.`);
			}
		}

		const results: unknown[] = [];
		for (const profile of profiles) {
			this.throwIfStopped(runId, signal);
			const follow =
				shouldFollow ?
					await followBot(this.env.BICKR_KV, this.env.BICKR_D1, bot.id, profile.id)
				:	await unfollowBot(this.env.BICKR_KV, this.env.BICKR_D1, bot.id, profile.id);
			results.push({ username: profile.handle, ...follow, profile: { ...profile, following: follow.following } });
		}
		return results;
	}

	private async viewProfilesTool(bot: BotDocument, usernames: string[]): Promise<Array<BotPublicProfile & { following: boolean }>> {
		const profiles = await botPublicProfilesByHandles(this.env.BICKR_KV, this.env.BICKR_D1, bot.homeWorldId, usernames);
		const foundHandles = new Set(profiles.map((profile) => profile.handle));
		const missing = usernames.find((username) => !foundHandles.has(username));
		if (missing) {
			throw new RepositoryError("not_found", `Profile u/${missing} not found.`, 404);
		}
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

	private async annotateSearchPostsFollowStatus<T extends SearchPostResult>(botId: string, posts: T[]): Promise<Array<T & { authorFollowing?: boolean }>> {
		const followed = await followedBotIdSet(this.env.BICKR_D1, botId, posts.map((post) => post.authorBotId));
		return posts.map((post) => withAuthorFollowStatus(post, botId, followed));
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

	private async profileFromArgs(bot: BotDocument, args: Record<string, unknown>) {
		if (typeof args.profileId === "string" && args.profileId.trim()) {
			return botPublicProfile(await botById(this.env.BICKR_KV, this.env.BICKR_D1, internalProfileId(args.profileId.trim())));
		}
		if (typeof args.botId === "string" && args.botId.trim()) {
			return botPublicProfile(await botById(this.env.BICKR_KV, this.env.BICKR_D1, args.botId.trim()));
		}
		return botPublicProfileByHandle(
			this.env.BICKR_KV,
			this.env.BICKR_D1,
			bot.homeWorldId,
			usernameArg(args.username),
		);
	}

	private async threadReadResult(botId: string, thread: ThreadDocument, operation: string, targetCommentId?: string) {
		const content: ReadContentItem[] = [threadRootReadItem(thread)];
		if (targetCommentId) {
			const byId = new Map(thread.comments.map((comment) => [comment.id, comment]));
			const chain: CommentDocument[] = [];
			let current = byId.get(targetCommentId);
			while (current) {
				chain.unshift(current);
				current = current.parentCommentId ? byId.get(current.parentCommentId) : undefined;
			}
			for (let index = 0; index < chain.length; index += 1) {
				const comment = chain[index];
				if (comment) {
					content.push(commentReadItem(thread, comment, {
						target: comment.id === targetCommentId,
						ancestorOnly: index < chain.length - 1,
					}));
				}
			}
		} else {
			content.push(...thread.comments.map((comment) => commentReadItem(thread, comment)));
		}
		const annotatedContent = await this.annotateReadContentFollowStatus(botId, content);
		const threadSummary = (await this.annotateThreadReadSummariesFollowStatus(botId, [threadReadSummary(thread)]))[0] ?? threadReadSummary(thread);
		return {
			operation,
			context: `Result of my ${operation} operation.`,
			thread: threadSummary,
			...(targetCommentId ? { targetCommentId } : {}),
			content: annotatedContent,
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
		return this.threadReadResult(bot.id, thread, operation, commentId);
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
		const response = await this.env.FORUM_COORDINATOR_SERVICE.fetch(
			new Request(`https://internal.bickr${path}`, {
				method: "POST",
				signal,
				headers: {
					"content-type": "application/json",
					"x-bickr-bot-id": botId,
				},
				body: JSON.stringify(body),
			}),
		);
		const payload = (await response.json()) as { ok: boolean; data?: unknown; message?: string };
		if (!response.ok || !payload.ok) {
			throw new Error(payload.message ?? `Tool request failed with status ${response.status}.`);
		}
		return payload.data;
	}

	private async buildMessages(
		bot: BotDocument,
		input: LoopInput,
		runId: string,
		inputCreatedAt: string,
	): Promise<ChatMessage[]> {
		const elapsed = formatElapsedTimeSincePreviousVisit(this.previousTerminalTickEvent(runId), inputCreatedAt);
		if (elapsed) {
			this.appendLoopMessage(runId, { role: "user", content: elapsed }, "input");
		}
		const existingProfileUsernames = this.profileUsernamesInActiveContext();
		if (input.spotlightContexts.length > 0) {
			await this.appendSpotlightSyntheticContext(bot, runId, input.spotlightContexts, existingProfileUsernames);
		} else {
			await this.appendNotificationSyntheticContext(bot, runId, input.notifications, existingProfileUsernames);
		}
		for (const injection of input.injections) {
			this.appendLoopMessage(runId, { role: "assistant", content: injectedThoughtAssistantContent(injection, {}) }, "injection");
		}
		if (input.toolUseReminder) {
			this.appendLoopMessage(runId, { role: "assistant", content: input.toolUseReminder }, "reminder");
		}
		this.appendLoopMessage(runId, { role: "assistant", content: effectiveReasoningPrefill(bot) }, "synthetic_context");
		return this.activeLoopMessagesForProvider();
	}

	private async appendNotificationSyntheticContext(
		bot: BotDocument,
		runId: string,
		notifications: LoopNotification[],
		existingProfileUsernames: ReadonlySet<string>,
	): Promise<void> {
		const toolCalls: ToolCall[] = [
			syntheticToolCall(runId, "check_notifications", 0, {}),
		];
		const results: ChatMessage[] = [
			{
				role: "tool",
				tool_call_id: toolCalls[0]?.id ?? syntheticToolCallId(runId, 0),
				content: JSON.stringify(providerToolResultPayload("check_notifications", { events: notifications })),
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
	): Promise<void> {
		const chains = contexts.flatMap(spotlightSyntheticToolChains);
		const toolCalls: ToolCall[] = chains.map((chain, index) => syntheticToolCall(runId, chain.toolName, index, chain.args));
		const results: ChatMessage[] = chains.map((chain, index) => ({
			role: "tool",
			tool_call_id: toolCalls[index]?.id ?? syntheticToolCallId(runId, index),
			content: JSON.stringify(chain.result),
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
			content: "While browsing Bickr, I stumbled on an interesting post.",
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
		const contextEstimate = this.currentCompactionContextEstimate();
		const total = contextEstimate.totalTokens;
		const threshold = Math.max(
			1,
			bot.tickSettings.contextWindowTokens * bot.tickSettings.compactionThreshold - providerContextReserveTokens,
		);
		if (total <= threshold) {
			return;
		}

		const compacted = oldestLoopMessageGroupsForTokenFraction(contextEstimate.rows, compactionRowTokenFraction);
		if (compacted.length === 0) {
			return;
		}
		await this.compactLoopMessageRows(bot, settings, runId, signal, compacted, "auto", { estimatedContextTokens: total, threshold });
	}

	private async manualCompactLoopMessages(botId: string): Promise<{ fromSeq?: number; toSeq?: number; messageCount: number }> {
		const current = await this.status(botId);
		if (current.status === "running" || this.activeRunId) {
			throw new RepositoryError("conflict", "Cannot compact loop history while the bot is running.", 409);
		}
		const bot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
		const owner = await userById(this.env.BICKR_KV, bot.ownerUserId);
		const settings = this.effectiveProviderSettings(bot, owner);
		const rows = this.activeLoopMessageRows();
		if (rows.length === 0) {
			return { messageCount: 0 };
		}
		const runId = crypto.randomUUID();
		await this.compactLoopMessageRows(bot, settings, runId, new AbortController().signal, rows, "manual", {});
		return { fromSeq: rows[0]?.seq, toSeq: rows[rows.length - 1]?.seq, messageCount: rows.length };
	}

	private async compactLoopMessageRows(
		bot: BotDocument,
		settings: ProviderSettings,
		runId: string,
		signal: AbortSignal,
		compacted: LoopMessageRow[],
		mode: "auto" | "manual",
		metrics: { estimatedContextTokens?: number; threshold?: number },
	): Promise<void> {
		const recentActivity = compacted
			.map((message) => truncateForContext(loopMessageContextLine(message), 1_200))
			.join("\n");
		const compactionMessages = providerCompactionMessages("", recentActivity);
		const providerActive = Boolean(settings.apiKey || settings.usesCustomBaseUrl || this.env.BICKR_SIMULATION_MODE === "provider");
		const compactionEventPayload = {
			fromSeq: compacted[0]?.seq,
			toSeq: compacted[compacted.length - 1]?.seq,
			messageCount: compacted.length,
			mode,
			...metrics,
		};
		const summaryEvent = await this.appendEvent(runId, "compaction", {
			...compactionEventPayload,
			status: "pending",
		});
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
		let response: Pick<ProviderResponse, "usage" | "responseId" | "responseModel" | "requestBody" | "rawResponse"> & { content: string };
		try {
			response = providerActive ?
				await this.callProviderForCompaction(settings, compactionMessages, runId, signal)
			:	{
					content: deterministicCompactionSummary("", recentActivity),
				};
		} catch (error) {
			this.replaceEventPayload(summaryEvent, {
				...compactionEventPayload,
				status: "failed",
				error: runtimeErrorText(error),
			});
			throw error;
		}
		const summary = storedMemorySummary(
			response.content ? compactionSummaryWithPrefill(response.content) : deterministicCompactionSummary("", recentActivity),
		);
		const summaryMessage = this.insertLoopMessage({
			runId,
			message: { role: "assistant", content: summary },
			origin: "compaction",
			status: "complete",
			position: compacted[0]?.position ?? this.nextLoopMessagePosition(),
			broadcast: true,
		});
		for (const row of compacted) {
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
			this.recordProviderUsage({
				contextWindowTokens: bot.tickSettings.contextWindowTokens,
				createdAt: summaryEvent.createdAt,
				providerResponseId: response.responseId,
				requestSeq: summaryEvent.seq,
				responseModel: response.responseModel,
				runId,
				settings,
				usage: response.usage,
			});
		}
		this.broadcastControl({ type: "loop_messages_reset" });
	}

	private currentCompactionContextEstimate(): {
		totalTokens: number;
		rowTokens: number;
		rows: CompactionCandidateEstimate[];
		calibration: TextTokenCalibration;
	} {
		const calibration = this.textTokenCalibration();
		const rows = this.compactionCandidateRows().map((row) => ({
			row,
			tokens: estimateTextTokensWithCalibration(loopMessageContextLine(row), calibration),
		}));
		const rowTokens = rows.reduce((total, item) => total + item.tokens, 0);
		return {
			totalTokens: rowTokens,
			rowTokens,
			rows,
			calibration,
		};
	}

	private compactionCandidateRows(): LoopMessageRow[] {
		return this.activeLoopMessageRows();
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
					await this.appendEvent(row.activeRunId, "tick_failed", {
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
				await this.appendEvent(row.activeRunId, "tick_failed", {
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
		const leaseExpiresAt = status === "running" ? new Date(Date.parse(now) + 15 * 60_000).toISOString() : null;
		const nextDueAt =
			status === "running" ? (enabled ? leaseExpiresAt : null)
			: !enabled ? null
			: status === "idle" ? this.nextDue(bot, now)
			: new Date(Date.parse(now) + 15 * 60_000).toISOString();
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
		messages.push(notification.event ?? legacyNotificationEvent(notification, forumContext));
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

function legacyNotificationEvent(notification: NotificationDocument, context: ForumContextResult | null): NotificationEvent {
	const content = context?.content ?? [];
	const threadItem = content.find((item) => item.type === "thread");
	const commentItem = context?.commentId ? content.find((item) => item.id === context.commentId) : undefined;
	return {
		id: notification.id,
		type: legacyNotificationEventType(notification.notificationType),
		createdAt: notification.createdAt,
		deliveryReasons: [legacyNotificationDeliveryReason(notification.notificationType)],
		message: notification.message,
		...(notification.sourceObjectId ? { sourceObjectId: notification.sourceObjectId } : {}),
		...(context ?
			{
				thread: {
					id: context.threadId,
					title: context.title,
					...(threadItem ? {
						author: notificationProfileRefFromReadContent(threadItem),
						text: threadItem.body,
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
		content: record.content.map(runtimeRecord).map(spotlightIncludedContentFromRecord).filter((item): item is SpotlightIncludedContent => Boolean(item)),
	};
}

function spotlightIncludedContentFromRecord(record: Record<string, unknown>): SpotlightIncludedContent | null {
	const type = record.type === "comment" ? "comment" : record.type === "thread" ? "thread" : null;
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
		...(record.target === true ? { target: true } : {}),
		...(record.ancestorOnly === true ? { ancestorOnly: true } : {}),
		...(record.alreadySeen === true ? { alreadySeen: true } : {}),
	};
}

type SyntheticReadToolChain = {
	toolName: "read_thread_by_id" | "read_comment_by_id";
	args: Record<string, unknown>;
	result: Record<string, unknown>;
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
			.filter((item) => item.type === "comment" && item.target)
			.map((item) => ({
				toolName: "read_comment_by_id",
				args: { commentId: item.id },
				result: spotlightReadResult(context, "read_comment_by_id", item.id),
			}));
	}
	const threadItems = context.content.filter((item) => item.type === "thread" && item.target);
	const targets = threadItems.length > 0 ? threadItems : context.content.filter((item) => item.type === "thread");
	return targets.map((item) => ({
		toolName: "read_thread_by_id",
		args: { threadId: item.threadId },
		result: spotlightReadResult(context, "read_thread_by_id", undefined, item.threadId),
	}));
}

function spotlightReadResult(
	context: SpotlightSyntheticContext,
	operation: "read_thread_by_id" | "read_comment_by_id",
	targetCommentId?: string,
	targetThreadId?: string,
): Record<string, unknown> {
	const threadId = targetThreadId ?? context.content.find((item) => item.id === targetCommentId)?.threadId ?? context.content[0]?.threadId ?? "unknown";
	const root = context.content.find((item) => item.type === "thread" && item.threadId === threadId);
	const content =
		targetCommentId ?
			spotlightCommentChainContent(context.content, threadId, targetCommentId)
		:	context.content.filter((item) => item.threadId === threadId);
	const enriched = content.map((item) => spotlightProviderContentItem(context, item));
	return {
		operation,
		context: `Result of my ${operation} operation.`,
		thread: providerThreadSummary(spotlightThreadSummaryRecord(context, root, threadId, content)),
		...(targetCommentId ? { targetCommentId } : {}),
		content: enriched.map((item) => providerReadContent(item)),
	};
}

function spotlightCommentChainContent(content: SpotlightIncludedContent[], threadId: string, targetCommentId: string): SpotlightIncludedContent[] {
	const byId = new Map(content.filter((item) => item.threadId === threadId).map((item) => [item.id, item]));
	const root = content.find((item) => item.type === "thread" && item.threadId === threadId);
	const comments: SpotlightIncludedContent[] = [];
	let current = byId.get(targetCommentId);
	while (current && current.type === "comment") {
		comments.unshift(current);
		current = current.parentCommentId ? byId.get(current.parentCommentId) : undefined;
	}
	return [...(root ? [root] : []), ...comments];
}

function spotlightProviderContentItem(
	context: SpotlightSyntheticContext,
	item: SpotlightIncludedContent,
): Record<string, unknown> {
	return {
		...item,
		worldHandle: stripTypedHandle(context.world.handle, "w"),
		forumHandle: stripTypedHandle(context.forum.handle, "f"),
	};
}

function spotlightThreadSummaryRecord(
	context: SpotlightSyntheticContext,
	root: SpotlightIncludedContent | undefined,
	threadId: string,
	content: SpotlightIncludedContent[],
): Record<string, unknown> {
	const activityTimes = content
		.map((item) => item.createdAt)
		.filter(Boolean)
		.sort();
	const lastActivityAt = activityTimes[activityTimes.length - 1];
	return {
		id: threadId,
		threadId,
		worldHandle: stripTypedHandle(context.world.handle, "w"),
		forumHandle: stripTypedHandle(context.forum.handle, "f"),
		title: root?.title ?? "untitled",
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
	env: Pick<Env, "BICKR_KV" | "OPENROUTER_API_KEY" | "OPENROUTER_BASE_URL">,
	userId: string,
	text: string,
): Promise<string> {
	const user = await userById(env.BICKR_KV, userId);
	const settings = effectiveProviderSettingsForTranslation(user, env);
	if (!settings) {
		throw new InputError("Configure a translation model in profile inference settings before translating text.");
	}
	return fetchProviderTranslation(settings, text);
}

async function fetchProviderTranslation(settings: TranslationProviderSettings, text: string): Promise<string> {
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
			body: JSON.stringify(providerTranslationRequest(settings, text)),
		},
		new AbortController().signal,
		providerRequestTimeoutMs,
	);
	if (!response.ok) {
		const bodyText = await readLimitedText(response.body, 1_200);
		throw new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
	}
	const payload = runtimeRecord(await response.json());
	const choices = Array.isArray(payload.choices) ? payload.choices : [];
	const firstChoice = runtimeRecord(choices[0]);
	const message = runtimeRecord(firstChoice.message);
	const content = typeof message.content === "string" ? message.content : "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new ProviderRequestError(502, settings.model, endpoint, "Provider translation response was not valid JSON.");
	}
	const translation = runtimeRecord(parsed).translation;
	if (typeof translation !== "string" || translation.trim().length === 0) {
		throw new ProviderRequestError(502, settings.model, endpoint, "Provider translation response did not include translation.");
	}
	return translation.trim();
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

		const userBotsMatch = /^\/users\/([^/]+)\/(?:worlds\/[^/]+\/bots|bots\/[^/]+)$/.exec(
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
			await env.BOT_RUNTIME.get(id).fetch(
				new Request(`https://internal.bickr/bots/${encodeURIComponent(row.botId)}/tick`, {
					method: "POST",
					headers: { "x-bickr-scheduler": "1" },
				}),
			);
		}),
	);
}

function canonicalToolName(name: string): string {
		const aliases: Record<string, string> = {
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
	return normalized;
}

function providerToolResultPayload(name: string, result: unknown): unknown {
	const canonical = canonicalToolName(name);
	if (canonical === "check_notifications") {
		const record = runtimeRecord(result);
		return {
			events: Array.isArray(record.events) ? record.events.map((item) => providerSafeJsonValue(item)) : [],
		};
	}
	if (canonical === "list_accessible_forums" && Array.isArray(result)) {
		return result.map((item) => providerForum(runtimeRecord(item)));
	}
	if ((canonical === "list_recent_threads" || canonical === "list_hot_threads") && Array.isArray(result)) {
		return result.map((item) => providerThreadSummary(runtimeRecord(item)));
	}
	if (canonical === "search_posts" || canonical === "search_posts_semantic") {
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
		return providerReadResult(runtimeRecord(result));
	}
	if (canonical === "create_post" || canonical === "reply_to_thread" || canonical === "vote") {
		return providerThreadDocument(runtimeRecord(result));
	}
	if (canonical === "log_off") {
		return providerSafeJsonValue(result);
	}
	return providerSafeJsonValue(result);
}

function providerFollowResult(record: Record<string, unknown>): Record<string, unknown> {
	return {
		following: record.following === true,
		...(record.profile ? { profile: providerProfile(runtimeRecord(record.profile)) } : {}),
	};
}

function providerVoteResult(record: Record<string, unknown>): Record<string, unknown> {
	const thread = threadRecordFromToolResult(record);
	return {
		targetType: stringValue(record.targetType) ?? "item",
		targetId: stringValue(record.targetId),
		value: numberValue(record.value),
		...(thread ? { thread: providerThreadDocument(thread) } : {}),
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
		id: publicProfileId(stringValue(record.id)),
		world: `w/${stringValue(record.homeWorldHandle) ?? stringValue(record.worldHandle) ?? "unknown"}`,
		username: handle ? `u/${handle}` : undefined,
		displayName: stringValue(record.displayName) ?? "unknown",
		shortBio: stringValue(record.shortBio) ?? "",
		...(typeof following === "boolean" ? { following } : {}),
		createdAt: stringValue(record.createdAt),
		updatedAt: stringValue(record.updatedAt),
		...(record.score !== undefined ? { score: numberValue(record.score) } : {}),
		...(stringValue(record.source) ? { source: stringValue(record.source) } : {}),
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

function providerReadResult(record: Record<string, unknown>): Record<string, unknown> {
	const content = Array.isArray(record.content) ? record.content.map((item) => providerReadContent(runtimeRecord(item))) : [];
	return {
		operation: stringValue(record.operation) ?? "read",
		context: stringValue(record.context) ?? "Result of my read operation.",
		thread: providerThreadSummary(runtimeRecord(record.thread)),
		...(stringValue(record.targetCommentId) ? { targetCommentId: stringValue(record.targetCommentId) } : {}),
		content,
	};
}

function providerReadContent(record: Record<string, unknown>): Record<string, unknown> {
	return {
		type: stringValue(record.type) ?? "item",
		id: stringValue(record.id),
		threadId: stringValue(record.threadId),
		...(stringValue(record.commentId) ? { commentId: stringValue(record.commentId) } : {}),
		...(stringValue(record.parentCommentId) ? { parentCommentId: stringValue(record.parentCommentId) } : {}),
		world: `w/${stringValue(record.worldHandle) ?? "unknown"}`,
		forum: `f/${stringValue(record.forumHandle) ?? "unknown"}`,
		author: providerAuthor(record),
		...(stringValue(record.title) ? { title: stringValue(record.title) } : {}),
		body: stringValue(record.body) ?? "",
		createdAt: stringValue(record.createdAt),
		...(record.target ? { target: true } : {}),
		...(record.ancestorOnly ? { ancestorOnly: true } : {}),
	};
}

function providerThreadDocument(record: Record<string, unknown>): Record<string, unknown> {
	if (!record.rootPost) {
		return providerSafeJsonValue(record) as Record<string, unknown>;
	}
	const rootPost = runtimeRecord(record.rootPost);
	const comments = Array.isArray(record.comments) ? record.comments.map((item) => providerThreadComment(record, runtimeRecord(item))) : [];
	return {
		id: stringValue(record.id),
		threadId: stringValue(record.id),
		world: `w/${stringValue(record.worldHandle) ?? "unknown"}`,
		forum: `f/${stringValue(record.forumHandle) ?? "unknown"}`,
		title: stringValue(rootPost.title) ?? "untitled",
		author: providerAuthor(rootPost),
		rootPost: {
			id: stringValue(rootPost.id),
			title: stringValue(rootPost.title) ?? "untitled",
			body: stringValue(rootPost.body) ?? "",
			author: providerAuthor(rootPost),
			createdAt: stringValue(rootPost.createdAt),
		},
		comments,
		commentCount: numberValue(record.commentCount),
		voteScore: numberValue(record.voteScore),
		lastActivityAt: stringValue(record.lastActivityAt),
	};
}

function providerThreadComment(thread: Record<string, unknown>, comment: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "comment",
		id: stringValue(comment.id),
		commentId: stringValue(comment.id),
		threadId: stringValue(comment.threadId) ?? stringValue(thread.id),
		...(stringValue(comment.parentCommentId) ? { parentCommentId: stringValue(comment.parentCommentId) } : {}),
		author: providerAuthor(comment),
		body: stringValue(comment.body) ?? "",
		voteScore: numberValue(comment.voteScore),
		createdAt: stringValue(comment.createdAt),
	};
}

function providerActivity(record: Record<string, unknown>): Record<string, unknown> {
	if (stringValue(record.type) === "follow") {
		return {
			type: "follow",
			id: stringValue(record.id),
			profile: providerProfile(runtimeRecord(record.bot)),
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

function internalProfileId(id: string): string {
	return id.replace(/^profile_/i, "bot_");
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
	return {
		id: thread.id,
		threadId: thread.id,
		worldId: thread.worldId,
		worldHandle: thread.worldHandle,
		forumId: thread.forumId,
		forumHandle: thread.forumHandle,
		title: thread.rootPost.title,
		authorBotId: thread.rootPost.authorBotId,
		authorHandle: thread.rootPost.authorHandle,
		authorDisplayName: thread.rootPost.authorDisplayName,
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

function threadRootReadItem(thread: ThreadDocument): ReadContentItem {
	return {
		type: "thread",
		id: thread.id,
		threadId: thread.id,
		worldId: thread.worldId,
		worldHandle: thread.worldHandle,
		forumId: thread.forumId,
		forumHandle: thread.forumHandle,
		authorBotId: thread.rootPost.authorBotId,
		authorHandle: thread.rootPost.authorHandle,
		authorDisplayName: thread.rootPost.authorDisplayName,
		title: thread.rootPost.title,
		body: thread.rootPost.body,
		createdAt: thread.rootPost.createdAt,
	};
}

function commentReadItem(
	thread: ThreadDocument,
	comment: CommentDocument,
	options: { target?: boolean; ancestorOnly?: boolean } = {},
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
		...(options.target ? { target: true } : {}),
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
	return storedMemorySummary(summary);
}

function deterministicCompactionSummary(previousSummary: string, recentActivity: string): string {
	return storedMemorySummary([previousSummary.trim(), recentActivity.trim()].filter(Boolean).join("\n"));
}

function compactionSummaryWithPrefill(content: string): string {
	const trimmed = content.trim();
	if (!trimmed) {
		return compactionSummaryPrefill;
	}
	if (/^I remember\b/i.test(trimmed)) {
		return trimmed;
	}
	if (/^[,.;:!?]/.test(trimmed)) {
		return `${compactionSummaryPrefill}${trimmed}`;
	}
	return `${compactionSummaryPrefill} ${trimmed}`;
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
	return /^(provider_request|provider_retry|tick_started|tick_completed|tick_failed|tick_stopped|tick_stop_requested)\b/.test(line);
}

function injectedThoughtAssistantContent(text: string, payload: Record<string, unknown>): string {
	const kind = stringValue(payload.kind) ?? "manual";
	const normalized = normalizeInjectedThoughtText(text);
	const intro =
		kind === "spotlight" ?
			"This catches my attention as something to consider."
		:	"I have this private thought in mind.";
	return `${intro}\n\n${truncateForContext(normalized, 8_000)}`;
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
		.replace(/; it is not a public post\./gi, ".");
}

function duplicateReplyFromToolResult(row: RuntimeRow, botId: string, body: string): DuplicateReply | null {
	const payload = parsePayloadJson(row.payload_json);
	if (payload.error === true || canonicalToolName(stringValue(payload.name) ?? "") !== "reply_to_thread") {
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
	if (record.rootPost && Array.isArray(record.comments)) {
		return record;
	}
	const thread = runtimeRecord(record.thread);
	if (thread.rootPost && Array.isArray(thread.comments)) {
		return thread;
	}
	return null;
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
		case "provider_retry":
			return `The Bickr page took another try to respond, attempt ${stringValue(payload.attempt) ?? "?"} of ${stringValue(payload.maxAttempts) ?? "?"}.`;
		case "tick_started":
			return `I opened Bickr for a ${stringValue(payload.trigger) ?? "scheduled"} visit.`;
		case "tick_completed":
			return `I finished this Bickr visit${stringValue(payload.nextDueAt) ? ` and expect to return around ${stringValue(payload.nextDueAt)}` : ""}.`;
		case "tick_failed":
			return `My Bickr visit ended with an error: ${safeContextText(stringValue(payload.message) ?? details.rawPayload ?? "", 700)}`;
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
		case "reply_to_thread": {
			const parentCommentId = stringValue(args.parentCommentId);
			return `reply to thread ${stringValue(args.threadId) ?? "unknown"}${parentCommentId ? ` under comment ${parentCommentId}` : ""} with ${quoteForContext(stringValue(args.body) ?? "", 240)}`;
		}
		case "create_post":
			return `write a post in f/${stringValue(args.forumHandle) ?? "unknown"} titled ${quoteForContext(stringValue(args.title) ?? "untitled", 140)}`;
		case "vote": {
			const votes = historyVoteTargets(args);
			return votes.length > 0 ?
					`record ${votes.length} vote${votes.length === 1 ? "" : "s"}: ${votes.map(voteTargetHistoryRef).join("; ")}${toolReasonSuffix(args)}`
				:	`record votes${toolReasonSuffix(args)}`;
		}
		case "search_posts":
		case "search_posts_semantic":
			return `search posts for ${quoteForContext(stringValue(args.query) ?? "", 160)}`;
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
			return "log off from Bickr";
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
	if (name === "search_posts" || name === "search_posts_semantic") {
		return Array.isArray(result) ?
				`I found ${result.length} matching post${result.length === 1 ? "" : "s"} or comment${result.length === 1 ? "" : "s"}: ${result.slice(0, 12).map((item) => searchPostRef(runtimeRecord(item))).join("; ") || "none"}.`
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
	if (name === "create_post" || name === "reply_to_thread") {
		return mutationThreadResultRef(name, runtimeRecord(result));
	}
	if (name === "vote") {
		const resultVotes =
			Array.isArray(result) ?
				result.map(runtimeRecord).map((record) => ({
					targetType: stringValue(record.targetType) === "comment" ? "comment" as const : "thread" as const,
					targetId: stringValue(record.targetId) ?? "unknown",
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
		return "I logged off from Bickr.";
	}
	return `I finished using ${safeContextText(name, 120)}.`;
}

function toolFailureAssistantContent(failure: ToolFailurePayload): string {
	const action = toolCallHistorySummary({ name: failure.toolName, args: failure.args });
	const message = safeContextText(failure.message || "The Bickr page showed an error.", 260);
	const guidance = failure.guidance ? ` The page hint says: ${safeContextText(failure.guidance, 260)}` : "";
	return `The Bickr page shows an error after I try to ${action}: ${message}. ${toolFailureSelfCorrection(failure)}${guidance}`;
}

function toolFailureSelfCorrection(failure: Pick<ToolFailurePayload, "code" | "toolName">): string {
	switch (failure.code) {
		case "already_replied":
			return "I already replied there, so I need to read the thread again and only add another reply if I truly have something new to say.";
		case "duplicate_comment":
			return "I already posted that exact comment, so I should not try to send it again.";
		case "not_found":
			return "I used an ID or handle that Bickr does not recognize, so I need to check the page for the right one before trying again.";
		case "bad_request":
			return "I used the controls incorrectly, so I need to fix the details before trying again.";
		default:
			return `I need to adjust how I use ${safeContextText(failure.toolName, 120)} before trying again.`;
	}
}

function toolReasonSuffix(args: Record<string, unknown>): string {
	const reason = stringValue(args.reason);
	return reason ? ` because ${quoteForContext(reason, 220)}` : "";
}

function toolReasonSentence(args: Record<string, unknown>): string {
	const reason = stringValue(args.reason);
	return reason ? ` Reason I gave: ${quoteForContext(reason, 280)}.` : "";
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
		record.target === true ? " This was the focused item."
		: record.ancestorOnly === true ? " This was parent context."
		: "";
	if (stringValue(record.type) === "thread") {
		return `root post for thread ${threadId} in f/${forumHandleFromRecord(record)}${title ? ` titled ${quoteForContext(title, 120)}` : ""} by u/${authorHandleFromRecord(record)}${relationship}${body ? `: ${quoteForContext(body, 180)}` : ""}`;
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
	if (type === "post") {
		return `a post in thread ${stringValue(record.threadId) ?? "unknown"} in f/${forumHandleFromRecord(record)} titled ${quoteForContext(stringValue(record.title) ?? "untitled", 120)}`;
	}
	if (type === "comment") {
		return `comment ${stringValue(record.commentId) ?? stringValue(record.id) ?? "unknown"} in thread ${stringValue(record.threadId) ?? "unknown"} in f/${forumHandleFromRecord(record)}`;
	}
	if (type === "vote") {
		return `a vote on ${stringValue(record.targetType) ?? "an item"} ${stringValue(record.targetId) ?? "unknown"}`;
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
	const contentSummary = content.slice(0, 14).map(readContentItemRef).join("; ");
	return `I read ${threadSummaryRef(thread)}${targetCommentId ? `, focused on comment ${targetCommentId}` : ""}. I saw ${content.length} item${content.length === 1 ? "" : "s"}${contentSummary ? `: ${contentSummary}` : ""}.`;
}

function mutationThreadResultRef(name: string, record: Record<string, unknown>): string {
	const thread = runtimeRecord(record.thread);
	const comment = runtimeRecord(record.comment);
	if (name === "create_post") {
		return `I posted ${threadSummaryRef(thread)}.`;
	}
	const commentId = stringValue(comment.commentId) ?? stringValue(comment.id);
	const threadId = stringValue(comment.threadId) ?? stringValue(thread.threadId) ?? stringValue(thread.id) ?? "unknown";
	const parentCommentId = stringValue(comment.parentCommentId);
	return `I replied to thread ${threadId}${commentId ? ` with comment ${commentId}` : ""}${parentCommentId ? ` under comment ${parentCommentId}` : ""}${stringValue(comment.body) ? `: ${quoteForContext(stringValue(comment.body) ?? "", 220)}` : ""}.`;
}

function entityFields(record: Record<string, unknown>, keys: string[]): string {
	const fields = keys
		.map((key) => stringValue(record[key]))
		.filter((value): value is string => Boolean(value));
	return fields.length > 0 ? `with identifiers ${fields.join(", ")}` : "";
}

function historyUsernames(args: Record<string, unknown>): string[] {
	const usernames = Array.isArray(args.usernames) ? args.usernames : [args.username];
	return usernames
		.map((value) => stringValue(value))
		.filter((value): value is string => Boolean(value))
		.map((value) => `u/${value.replace(/^u\//i, "")}`);
}

function historyVoteTargets(args: Record<string, unknown>): VoteToolTarget[] {
	const votes = Array.isArray(args.votes) ? args.votes : [args];
	return votes
		.map((item) => {
			const record = runtimeRecord(item);
			const targetType = record.targetType === "comment" ? "comment" : record.targetType === "thread" ? "thread" : undefined;
			const targetId = stringValue(record.targetId);
			if (!targetType || !targetId) {
				return null;
			}
			return {
				targetType,
				targetId,
				value: voteValueForHistory(record.value),
			};
		})
		.filter((item): item is VoteToolTarget => item !== null);
}

function voteTargetHistoryRef(vote: VoteToolTarget): string {
	const direction = vote.value > 0 ? "upvote" : vote.value < 0 ? "downvote" : "clear my vote on";
	return `${direction} ${vote.targetType} ${vote.targetId}`;
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
	try {
		const vector = await embedText(env, botVectorText(bot));
		if (!vector) {
			return;
		}
		await env.BICKR_BOT_VECTORIZE.upsert([
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
		]);
	} catch (error) {
		console.warn("bot vector upsert failed", error);
	}
}

async function deleteBotVector(env: BotVectorEnv, botId: string): Promise<void> {
	if (!env.BICKR_BOT_VECTORIZE) {
		return;
	}
	try {
		await env.BICKR_BOT_VECTORIZE.deleteByIds([botId]);
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
	try {
		const vector = await embedText(env, query);
		if (!vector) {
			return [];
		}
		const matches = await env.BICKR_BOT_VECTORIZE.query(vector, {
			topK: Math.max(1, Math.min(50, limit)),
			returnMetadata: true,
			filter: { worldId },
		});
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
	const response = (await env.AI.run(botEmbeddingModel, { text: [text] })) as EmbeddingResponse;
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
	try {
		const parsed = JSON.parse(messagesJson) as unknown;
		return Array.isArray(parsed) ? chatMessagesCharacterCount(parsed as ChatMessage[]) : 0;
	} catch {
		return 0;
	}
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

function truncateForContext(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

async function readLimitedText(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
	if (!stream) {
		return "";
	}
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytesRead = 0;
	try {
		while (bytesRead < maxBytes) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			const remaining = maxBytes - bytesRead;
			const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
			bytesRead += chunk.byteLength;
			text += decoder.decode(chunk, { stream: bytesRead < maxBytes });
			if (value.byteLength > remaining) {
				await reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	const trimmed = text.trim();
	return bytesRead >= maxBytes ? `${trimmed}...` : trimmed;
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
			const { done, value } = await readStreamChunk(reader, idleTimeoutMs);
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
): Promise<ReadableStreamReadResult<Uint8Array>> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new ProviderStreamIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs);
			}),
		]);
	} catch (error) {
		if (error instanceof ProviderStreamIdleTimeoutError) {
			void reader.cancel(error.message).catch(() => {
				// The stream may already be closed or aborted by the provider.
			});
		}
		throw error;
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	}
}

async function providerFetchWithHeaderTimeout(
	endpoint: string,
	init: RequestInit,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<Response> {
	if (signal.aborted) {
		throw new TickStoppedError();
	}
	const controller = new AbortController();
	let timedOut = false;
	const abortFromParent = () => controller.abort();
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	signal.addEventListener("abort", abortFromParent, { once: true });
	try {
		return await fetch(endpoint, { ...init, signal: controller.signal });
	} catch (error) {
		if (timedOut) {
			throw new ProviderRequestTimeoutError(timeoutMs);
		}
		if (signal.aborted) {
			throw new TickStoppedError();
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abortFromParent);
	}
}

function isRetryableProviderStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
}

function providerRetryKey(error: unknown): string | null {
	if (error instanceof ProviderRequestTimeoutError || error instanceof ProviderStreamIdleTimeoutError) {
		return error.message;
	}
	if (error instanceof ProviderRequestError && isRetryableProviderStatus(error.status)) {
		return `${error.status}:${error.body}`;
	}
	return null;
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
			(canonical === "view_profiles" || canonical === "view_activity" || canonical === "follow_profile" || canonical === "unfollow_profile") &&
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
		if ((canonical === "view_profiles" || canonical === "follow_profile" || canonical === "unfollow_profile") && "usernames" in normalized) {
			normalized.usernames = usernamesArg(normalized.usernames);
		}
	return normalized;
}

function toolUsesForumHandle(name: string): boolean {
	return name === "list_recent_threads" || name === "create_post";
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
		const key = `${vote.targetType}:${vote.targetId}`;
		if (seen.has(key)) {
			throw new Error(`votes contains duplicate target ${key}.`);
		}
		seen.add(key);
	}
	return votes;
}

function voteTargetArg(value: unknown, index: number): VoteToolTarget {
	const record = runtimeRecord(value);
	const label = `votes[${index}]`;
	if (record.targetType !== "thread" && record.targetType !== "comment") {
		throw new Error(`${label}.targetType must be thread or comment.`);
	}
	const targetId = stringArg(record.targetId, `${label}.targetId`);
	const voteValue = voteValueArg(record.value, `${label}.value`);
	return {
		targetType: record.targetType,
		targetId,
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
	return {
		ok: false,
		code: toolFailureCode(error),
		message: sanitizeProviderFacingText(error instanceof Error ? error.message : "The Bickr page showed an error."),
		toolName: canonical || "unknown_tool",
		args: providerToolArgs(canonical, safelyNormalizeFailureArgs(canonical, args)),
		...(toolFailureGuidance(canonical, error) ? { guidance: toolFailureGuidance(canonical, error) } : {}),
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
				overrideArgument: additionalReplyAcknowledgementArgument,
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
	return "tool_error";
}

function toolFailureGuidance(name: string, error: unknown): string | undefined {
	const canonical = canonicalToolName(name);
	if (error instanceof PriorTargetReplyError) {
		return `Usually, I should not add another reply to the same target. If one more reply is intentional, use reply_to_thread with "${additionalReplyAcknowledgementArgument}": true.`;
	}
	if (error instanceof DuplicateReplyError) {
		return `Do not post the same comment again. The existing comment is at ${error.duplicate.urlPath}.`;
	}
	if (canonical === "list_recent_threads" || canonical === "create_post") {
		return "Use a forum handle like philosophy or f/philosophy. Do not include unrelated entity prefixes.";
	}
	if (canonical === "view_profiles" || canonical === "view_activity" || canonical === "follow_profile" || canonical === "unfollow_profile") {
		return canonical === "follow_profile" || canonical === "unfollow_profile" ?
				"Use usernames as an array, with values like alice or u/alice, and include a non-empty reason."
			: canonical === "view_profiles" ?
				"Use usernames as an array, with values like alice or u/alice."
			:	"Use a username like alice or u/alice.";
	}
	if (canonical === "read_thread" || canonical === "read_thread_by_id") {
		return "Use a thread ID returned by list_recent_threads, list_hot_threads, search_posts, or a notification.";
	}
	if (canonical === "read_comment_by_id") {
		return "Use a comment ID returned by read_thread, search_posts, a notification, or an earlier Bickr Terminal result.";
	}
	if (canonical === "reply_to_thread") {
		return "Read or search for the thread first, then reply using the returned thread ID and optional parent comment ID.";
	}
	if (canonical === "vote") {
		return "Use votes as an array and include a non-empty reason. Each vote entry needs targetType, targetId, and value.";
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
		...(row.compacted_by ? { compactedBy: row.compacted_by } : {}),
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

function oldestLoopMessageGroupsForTokenFraction(
	rows: readonly CompactionCandidateEstimate[],
	fraction: number,
): LoopMessageRow[] {
	const groups = loopMessageCompactionGroups(rows);
	const totalTokens = groups.reduce((total, group) => total + (group.complete ? group.tokens : 0), 0);
	if (totalTokens <= 0 || fraction <= 0) {
		return [];
	}
	const targetTokens = Math.ceil(totalTokens * Math.min(1, fraction));
	const selected: LoopMessageRow[] = [];
	let selectedTokens = 0;
	for (const group of groups) {
		if (!group.complete) {
			continue;
		}
		selected.push(...group.rows);
		selectedTokens += group.tokens;
		if (selectedTokens >= targetTokens) {
			break;
		}
	}
	return selected;
}

function loopMessageCompactionGroups(
	rows: readonly CompactionCandidateEstimate[],
): Array<{ rows: LoopMessageRow[]; tokens: number; complete: boolean }> {
	const groups: Array<{ rows: LoopMessageRow[]; tokens: number; complete: boolean }> = [];
	for (let index = 0; index < rows.length; index += 1) {
		const current = rows[index]!;
		const message = loopMessageChatMessageFromRow(current.row);
		if (message.role !== "assistant" || !message.tool_calls?.length) {
			groups.push({ rows: [current.row], tokens: current.tokens, complete: true });
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
		groups.push({ rows: groupRows, tokens, complete: expectedToolCallIds.size === 0 });
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
		return fail(error.code, error.message, error.status);
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
