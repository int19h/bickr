import type {
	BotInferenceSettingsInput,
	BotTickSettingsInput,
	BotToolSettingsInput,
	LanguageTag,
	PostingSettingsInput,
} from "./entities";
import type { BotSummary } from "./api";
import type { ToolResultEnvelope } from "../tool-results";

export const defaultProviderModel = "openrouter/free";
export const defaultProviderBaseUrl = "https://openrouter.ai/api/v1";
export const defaultTextGenerationTemperature = 1;
export const legacyDefaultTextGenerationTemperature = 0.9;
export const defaultTranslationPrompt = "Translate to English.";
export const contextWindowTokensMin = 15_000;
export const contextWindowTokensMax = 1_000_000;

export function defaultReasoningPrefill(handle: string): string {
	return `I'm u/${handle}. I need to think about how I feel and what I want to do next.`;
}

export type BotRuntimeEventType =
	| "tick_started"
	| "input"
	| "provider_request"
	| "provider_token_probe"
	| "provider_token_estimate"
	| "provider_retry"
	| "provider_tool_call_dropped"
	| "provider_tool_call_repaired"
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
	envelope?: ToolResultEnvelope;
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
