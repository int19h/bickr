import { fail, ok, readJsonBody } from '@bickr/shared/api';
import {
	type R2BucketLike,
} from '@bickr/shared/avatar-storage';
import { isCloudflareRateLimitError, retryCloudflareOperation } from '@bickr/shared/cloudflare';
import { isD1UniqueConstraintError } from '@bickr/shared/d1-errors';
import {
	canonicalBotInference,
	canonicalConfigurationInference,
	canonicalTranslationInference,
	translationToolCallStrategy,
} from '@bickr/shared/inference-configuration-consumers';
import { inferenceGraphReadVersion } from '@bickr/shared/inference-configuration-repository';
import { ExclusiveOperationQueue } from '@bickr/shared/exclusive-operation-queue';
import { json } from '@bickr/shared/http';
import { formatCommentRef, formatThreadRef, parseCommentRef, parseObjectRef, parseThreadRef } from '@bickr/shared/ids';
import {
	isOpenRouterProviderBaseUrl,
	providerEnvironmentSettingsFromBindings,
	providerReasoningRequestFromLegacyEffort,
	resolveBotProviderSettings,
	resolveLegacyTranslationProviderSettings,
} from '@bickr/shared/inference-settings';
import {
	addInternalServiceAuthHeader,
	internalServiceUrl,
	isTrustedInternalServiceRequest,
} from '@bickr/shared/internal-service';
import { mutationMaintenanceResponse } from '@bickr/shared/maintenance';
import {
	botById,
	botPublicProfile,
	effectiveTickSettings,
	enforceInferenceModelAccess,
	listForums,
	mergeInferenceSettings,
	mergeTickSettings,
	mergeToolSettings,
	RepositoryError,
	userById,
} from '@bickr/shared/repository';
import { effectivePostingSettings, mergePostingSettings } from '@bickr/shared/posting';
import {
	deleteSearchVector,
	upsertBotSearchVector,
} from '@bickr/shared/search';
import {
	botProfileRelationshipSummaries,
	botPublicProfilesByHandles,
	buildNotificationForumContext,
	deleteDeliveredNotifications,
	listHotThreads,
	listPendingNotifications,
	markBotSeenContent,
	recordBotRuntimeFailureHumanNotification,
	recordSpotlightFailureHumanNotification,
	recordSpotlightNoReactionHumanNotification,
	ensureBootstrapNotification,
	type ForumContextProfileState,
	type ForumContextResult,
	type SeenContentItem,
} from '@bickr/shared/social';
import { type D1DatabaseLike, type KVNamespaceLike, kvKeys, readJson } from '@bickr/shared/storage';
import {
	botInferenceUsageRetentionDays,
	botTokenSpendSummaryFromUsageRows,
	recordBotInferenceUsageBatch,
	type BotInferenceUsageRecord,
} from '@bickr/shared/token-spend';
import {
	InputError,
	normalizeHandle,
	normalizeHandleText,
	parseBotContextBudgetInput,
	requiredText,
} from '@bickr/shared/validation';
import {
	classifyUnknownModelCompactionReasoningFailure,
	compactAppliedPrefillPolicy,
	compactAppliedToolCallPolicy,
	compactionReasoningCapabilitiesForModel,
	compactionReasoningPolicyForModel,
	effectiveCompactionModeForModel,
	effectiveReasoningEffortForModel,
	effectiveContextWindowForModel,
	effectiveToolCallsForModel,
	modelSupportsPromptCacheControl,
	resolveCompactionReasoningSelection,
	resolvePrefillPolicyForModel,
	resolveToolCallPolicyForModel,
	type CompactionReasoningResolution,
	type RequiredToolCallReasoningShape,
} from '@bickr/shared/openrouter-model-capabilities';
import {
	botFacingRuntimeErrorMessage,
	ownerFacingRuntimeErrorMessage,
	type ProviderErrorCause,
	type RuntimeErrorCause,
} from '@bickr/shared/runtime-errors';
import {
	type ApiErrorPayload,
	type BotContextBudget,
	type BotContextBudgetInput,
	type BotContextWindowBreakdown,
	defaultReasoningPrefill,
	defaultTranslationPrompt,
	defaultTextGenerationTemperature,
	type BotInferenceSubmission,
	type BotInferenceSubmissionMessage,
	type BotInferenceSubmissionPurpose,
	type BotInferenceSubmissionSummary,
	type BotLoopMessage,
	type BotLoopMessagesResponse,
	type BotLoopMessageLog,
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
	type BotInferencePrefillIntent,
	type BotInferenceToolCalls,
	type BotProfileRelationshipSummary,
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
	type BotTokenSpendSummary,
	type ForumWriteErrorCause,
	type JsonObject,
	type LanguageTag,
	type LegacyNotificationEvent,
	type LocalizedText,
	type NotificationDocument,
	type NotificationProfileRef,
	type StoredNotificationEvent,
		type SpotlightIncludedContent,
		type SpotlightSyntheticContext,
	type UserDocument,
	type WorldDocument,
	localizedTextLang,
	localizedTextString,
	storedNotificationEvent,
} from '@bickr/shared/model';
import {
	bickrFunctionToolArgumentExample,
	mutableToolNames,
	openRouterServerToolSelection,
	providerTranslationToolDefinitions,
	standardPrompt,
	toolDefinitionsForProviderRound,
	type ProviderToolDefinition,
} from '../prompt-and-tools';
import { type ProviderSettings } from '../provider-requests';
import {
	consumeProviderResponse as consumeProviderSseResponse,
	isAbortError,
	providerFetchWithHeaderTimeout,
	providerResponseIsEmpty,
	readJsonResponse,
	readJsonResponseText,
	readLimitedText,
	readProviderErrorBody,
	readSse,
	withAbortableTimeout,
	withStandaloneTimeout,
} from '../provider/sse';
import {
	providerIgnoreRetryReason,
	providerRetryDelayMsForAttempt,
	providerRetryKey,
	providerRetryKeyForAttempt,
	providerRoutingWithIgnoredProvider,
	providerUpstreamRateLimitRetry,
} from '../provider/retry';
import {
	createProviderSanitize,
	loopMessageContributesToProviderHistory,
	repairInvalidUnicodeText,
	repairInvalidUnicodeValue,
	sanitizeProviderMessagesForRequest,
	stringifyProviderRequest,
	unicodeSafeSlice,
} from '../provider/sanitize';
import { createProviderStructuredOutput } from '../provider/structured-output';
import { RuntimeEventsStore } from './events';
import { RuntimeMessageStore } from './message-store';
import { RuntimeSpotlightTickQueue } from './spotlight-tick-queue';
import {
	canonicalToolName,
	followToolArgsWithTargets,
	followToolTargetsForProviderDedupe,
	localizedArgumentText,
	localizedToolTextArg,
	malformedToolCallFailureArgs,
	normalizeToolArgs,
	parseToolArgs,
	parseToolArgsWithDiagnostics,
	providerToolArgs,
	usernameArg,
} from './tool-args';
import {
	cloneProviderContextContentScope,
	collectProviderContextContentFromValue,
	commentReferencesWithoutTextFromValue,
	commentTextRecordsFromChatMessages,
	emptyProviderContextContentScope,
	hydrateNewestCommentReferences,
	providerCheckNotificationsResultWithInclusions,
	providerCollapsedReplyCount,
	providerCommentRef,
	providerCommentReplies,
	providerReadCommentTreeTokenBudget,
	providerReadResult,
	providerSafeJsonValue,
	providerSerializationContext,
	providerThreadRef,
	providerToolResultPayload,
	pruneReadContentTreeForProviderBudget,
	readContentItemTree,
	readResultContext,
	type ProviderContextContentScope,
	type ProviderSerializationContext,
} from './tool-results';
import {
	DuplicateReplyError,
	followToolSelfCorrectionMessage,
	planFollowToolTargets,
	PriorTargetReplyError,
	RuntimeTools,
	successfulToolResultPayload,
} from './tools';
import {
	appendToolRequirementInstruction,
	defaultProviderCompactionSummaryLimits,
	isNonReducingCompactionValidationError,
	isTranscriptLikeCompactionValidationError,
	providerAvatarDescriptionReasoningForSettings,
	providerCompactionMessages,
	providerCompactionMessagesForAttempt,
	providerCompactionMode,
	providerCompactionReasoningForSelection,
	providerCompactionResponseFormat,
	providerCompactionTemperature,
	providerCompactionToolName,
	providerCompactionToolsForAttempt,
	providerCompactionToolsForMode,
	providerMessagesWithPrefillCompatibility,
	providerRequiredToolChoice,
	providerToolChoiceForMode,
	providerToolNames,
	settingsUseOpenRouter,
	structuredOutputRepairMessages,
	toolRequirementSelfCorrection,
	type ProviderCompactionMode,
	type ProviderJsonSchemaResponseFormat,
	type ProviderReasoningConfig,
} from '../compaction/engine';
import {
	chatMessagesCharacterCount,
	estimateChatMessageTokens,
	estimateChatMessagesTokens,
	estimateTextTokensWithCalibration,
	fallbackTokensPerCharacter,
	maxCalibratedTokensPerCharacter,
	minCalibratedTokensPerCharacter,
	providerCompactionMaxCompletionTokensForRequest,
	providerCompactionMaxPromptEstimateTokens,
	providerCompactionRequiredCompletionTokens,
	providerCompactionSummaryLimitsForChat,
	providerPromptEstimateSafetyTokens,
	type TextTokenCalibration,
} from '../compaction/limits';
import {
	compactionRowsForEstimatedBudget,
	compactionRowSelectionForEstimatedBudget,
	loopMessageChatMessageFromRow,
	reducedCompactionRowsAfterOutputLimit,
	type CompactionCandidateEstimate,
	type CompactionRowSelection,
	type CompactionSelectionOptions,
} from '../compaction/selection';
import {
	CompactionAttemptPlan,
	type CompactionAttemptReasoningState,
	type CompactionAttemptRequestState,
	type CompactionAttemptRetryReason,
	type CompactionAttemptTransitionInput,
} from '../compaction/plan';
import { compactionReasoningLearnedFloorFromFrozenState } from '../compaction/reasoning';
import {
	parseImageGenerationSettingsOverride as parseAvatarImageGenerationSettingsOverride,
	type AvatarPromptSettingsRuntime,
	type ProviderAvatarImageStreamChunk,
} from '../avatar/service';
import {
	createAvatarProvider,
	type AvatarProviderRuntime,
} from '../avatar/provider';

import {
	PersistentToolFailureError,
	PersistentMissingToolCallError,
	SelfCorrectingToolCallError,
	RuntimeOperationTimeoutError,
	CompactionReasoningRefusalError,
	ToolCallArgumentValidationError,
	ProviderRequestError,
	ProviderCompactionRequestError,
	ProviderLoopRequestError,
	ProviderStructuredOutputValidationError,
	ProviderCompactionOutputLimitError,
	ProviderRequestTimeoutError,
	ProviderResponseBodyTimeoutError,
	ResponseBodySizeLimitError,
	ProviderEmptyResponseError,
	PromptContextBudgetExceededError,
	PromptContextCompactionLimitError,
	PersistentCompactionReductionFailureError,
	TickStoppedError,
	ProviderResponseInterruptedError,
	runtimeErrorCause,
	runtimeErrorText,
	type CompactionReasoningDiagnostic,
} from '../errors';
import {
	providerContextCompletionReserveTokens,
	stopRequestStateKey,
	toolUseRecoveryStateKey,
	compactionReasoningFallbackStateKey,
	centralProviderUsageExportCursorStateKey,
	lastLogOffSeqStateKey,
	runtimeStorageClearedStateKey,
	logOffBackfillPageSize,
	contextBudgetCacheStateKey,
	runtimeRunLeaseTimeoutMs,
	providerRequestTimeoutMs,
	providerBodyReadTimeoutMs,
	providerStreamIdleTimeoutMs,
	providerResponseBodyMaxBytes,
	openRouterGenerationMetadataMaxBytes,
	openRouterGenerationMetadataTimeoutMs,
	openRouterExperimentalMetadataHeader,
	openRouterGenerationIdHeader,
	serviceBindingTimeoutMs,
	serviceBindingResponseBodyMaxBytes,
	providerUsageExportBatchSize,
	runtimeEventRetentionDays,
	compactedLoopMessageRetentionDays,
	compactionSummaryLoopMessageRetentionDays,
	deletedLoopMessageRetentionDays,
	postTickLoopMessageRetentionLimit,
	sweepLoopMessageRetentionLimit,
	sweepRetentionTimeBudgetMs,
	vectorBindingTimeoutMs,
	cloudflareBindingRetryMaxAttempts,
	cloudflareBindingRetryInitialDelayMs,
	cloudflareBindingRetryMaxDelayMs,
	providerMaxAttempts,
	providerNoToolChoice,
	providerParallelToolCalls,
	providerRailroadNoToolMaxAttempts,
	providerPromptCompactionMaxAttempts,
	providerTranslationMaxCompletionTokens,
	providerTranslationToolName,
	providerSelfAuthor,
	providerStructuredOutputRepairAttempts,
	inferenceSubmissionRetentionCount,
	providerTokenCalibrationRetentionCount,
	runtimeMonitorInitialBackfillLimit,
	dayMs,
	fallbackProviderModel,
	fallbackProviderBaseUrl,
	legacyProviderToolCallHistoryNormalizedStateKey,
	providerToolCallHistoryInvariantViolationStateKey,
} from '../constants';
import type {
	Env,
	RuntimeBotDocument,
	RuntimeRow,
	CompactionMetrics,
	InferenceSubmissionRow,
	LoopMessageRow,
	RuntimeFailureLog,
	LoopMessageAppendLog,
	LoopMessageGroupEntry,
	ProviderCompactionResponsePayload,
	ChatMessage,
	ReasoningDetail,
	ToolCall,
	ToolResult,
	VoteToolTarget,
	FollowToolHistoryTarget,
	ProviderUsage,
	ProviderResponse,
	ProviderStreamFetchResponse,
	ProviderPromptBudgetCheck,
	ProviderPromptTokenEstimate,
	ProviderUsageRow,
	ProviderUsageExportRow,
	ProviderTokenCalibrationSampleRow,
	ProviderUsageLogRow,
	ProviderLoopUsageRow,
	ProviderTokenCalibrationLegacyBackfillRow,
	PromptTokenBaselineRow,
	ToolFailurePayload,
	TickRunResult,
	TickMode,
	LoopSetupMode,
	RuntimeReleaseStatus,
	RuntimeRunTrigger,
	ActiveMaintenanceOperation,
	TickOptions,
	AdmittedTick,
	TickAdmission,
	LoopNotification,
	LoopInput,
	RuntimeLoopInputBuild,
	RuntimeLoopMessages,
	InjectionMetadata,
	InjectionRow,
	RuntimeStorageClearResult,
	RuntimeStorageRetentionResult,
	RunContext,
	ProviderMessageStatus,
	ProviderStreamActivity,
	ReadContentItem,
	ContextBudgetPromptParts,
	ProviderPromptCacheControl,
	PromptContextBudgetCounts,
	PromptContextBudgetFingerprintParts,
	TranslationProviderSettings,
	ProviderLoopOutcome,
	SpotlightActionScope,
	ProviderToolCallDropReason,
	DroppedProviderToolCall,
	RepairedProviderToolCall,
	ToolUseRecoveryState,
	ProviderCompactionReasoningFallbackState,
	ProviderCompactionSummaryLimits,
	ProviderCompactionValidationLimits,
} from '../types';

export { defaultReasoningPrefill };
export { parseAvatarImageGenerationSettingsOverride as parseImageGenerationSettingsOverride };
export { PersistentCompactionReductionFailureError, runtimeMonitorInitialBackfillLimit };
export { localizedToolTextArg, parseToolArgs };
export { providerSafeJsonValue, providerSelfAuthor, providerSerializationContext, providerToolResultPayload };
export { followToolSelfCorrectionMessage, planFollowToolTargets };
export type { ToolFailurePayload };
export type { ProviderSettings } from '../provider-requests';

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
	tool_choice?: typeof providerRequiredToolChoice;
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

const {
	droppedProviderToolCall,
	normalizeLegacyProviderToolCallHistoryRows,
	normalizeReasoningDetailsForProviderHistory,
	providerResponseMessageForHistory,
	providerResponseToolCallMessageForHistory,
	providerToolCallHistoryInvariantViolation,
	sanitizeProviderResponseToolCalls,
	toolCallWithArguments,
} = createProviderSanitize({
	canonicalToolName,
	followToolArgsWithTargets,
	followToolTargetsForProviderDedupe,
	parseToolArgs,
	parseToolArgsWithDiagnostics,
	providerToolArgs,
	runtimeRecord,
	safeContextText,
	stringValue,
});

const {
	providerCompactionSummaryFromResponseMessage,
	providerSingleStringResponseFromMessage,
	providerTranslationFromToolMessage,
} = createProviderStructuredOutput({
	clampNumber,
	runtimeRecord,
	storedCompactionSummary,
	stringValue,
});

type RuntimeStatusIndexRow = {
	enabled: number;
	status: 'idle' | 'running' | 'failed';
	activeRunId: string | null;
	activeRunTrigger: string | null;
	leaseExpiresAt: string | null;
	nextDueAt: string | null;
	lastError: string | null;
	tickIntervalSeconds: number;
};

/**
 * Reads the trigger a live run was claimed with off its index row.
 *
 * A run claimed by a deployment older than the `active_run_trigger` column
 * carries NULL, which is read as `cron`: the ordinary tick behaviour, so at most
 * one in-flight spotlight visit per participant gets a final schedule reset at
 * deploy time instead of the column needing a two-phase rollout. The column's
 * CHECK constraint keeps the stored domain to the trigger values themselves.
 */
function recordedRunTrigger(stored: string | null): RuntimeRunTrigger {
	return stored === 'spotlight' || stored === 'manual' ? stored : 'cron';
}

/**
 * Whether a run must leave `next_due_at` exactly as it found it.
 *
 * A spotlight visit interrupts the participant on a *human's* schedule, not its
 * own, so neither claiming nor releasing it may move the standing schedule —
 * otherwise every spotlight drags the next organic visit out by a lease timeout
 * on claim and by a full interval on release. Nothing is lost by leaving the
 * column alone while the run is live: `dispatchDueBots` skips any row holding an
 * unexpired lease, so the lease alone guards against double dispatch, and a run
 * that dies without releasing is picked up by the stale-run reaper.
 */
function runKeepsStandingSchedule(trigger: RuntimeRunTrigger): boolean {
	return trigger === 'spotlight';
}

export async function claimRuntimeRun(
	db: D1DatabaseLike,
	botId: string,
	runId: string,
	leaseExpiresAt: string,
	now: string,
	trigger: RuntimeRunTrigger,
): Promise<boolean> {
	// A run that keeps the standing schedule proposes nothing, so COALESCE leaves
	// whatever the owner's own rhythm had already scheduled in place.
	const proposedNextDueAt = runKeepsStandingSchedule(trigger) ? null : leaseExpiresAt;
	const result = await db
		.prepare(
			// `enabled = 1` is a guard condition, not a filter the caller can hoist:
			// admission reads `enabled`, then awaits the participant, its owner, and
			// the effective provider settings before reaching this statement, and an
			// owner's pause committing during those awaits must still turn the claim
			// away. Making it part of the same compare-and-set that guards the lease
			// is what lets pause reliably block new admissions; a row that survives
			// this WHERE is enabled, so next_due_at needs no further condition.
			`UPDATE bot_runtime_index
			 SET status = 'running',
			     active_run_id = ?,
			     active_run_trigger = ?,
			     lease_expires_at = ?,
			     last_error = NULL,
			     next_due_at = COALESCE(?, next_due_at),
			     updated_at = ?
			 WHERE bot_id = ?
			   AND enabled = 1
			   AND (status != 'running' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
		)
		.bind(runId, trigger, leaseExpiresAt, proposedNextDueAt, now, botId, now)
		.run();
	return result.meta?.changes === 1;
}

export async function releaseRuntimeRun(
	db: D1DatabaseLike,
	input: {
		botId: string;
		runId: string | null;
		status: RuntimeReleaseStatus;
		nextDueAt: string | null;
		lastError: string | null;
		now: string;
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			// The caller computes next_due_at from an `enabled` value it read before
			// the run finished, so the proposal has to be reconciled against the row
			// the owner has since left behind — in both directions.
			//
			// Pause during the run: the pause already cleared next_due_at, so writing
			// the proposal unguarded would resurrect a schedule for a disabled row —
			// and, because unpausing keeps an existing next_due_at, would leave the
			// participant waiting out a stale interval instead of becoming due
			// immediately.
			//
			// Unpause during the run: a caller that read the paused row proposes
			// null, while the unpause has already made the row due now. Writing that
			// null would strand an enabled participant with nothing scheduled, and
			// nothing later would re-schedule it. COALESCE keeps what the unpause
			// wrote; a caller that read an enabled row always proposes a real
			// schedule, so it is never the one that falls through to the column.
			//
			// Deciding both in SQL keeps the check and the write in one atomic
			// statement, the same way claimRuntimeRun decides admission inside its
			// WHERE. The status columns stay unconditional: neither transition may
			// strand a finished run as running.
			//
			// A spotlight release proposes null for the same reason: the standing
			// schedule is the participant's own and the visit was never part of it.
			// An enabled row always carries a schedule — enabling writes one when the
			// column is empty, and only a pause clears it — so falling through to the
			// column cannot leave an enabled participant with nothing due.
			`UPDATE bot_runtime_index
			 SET status = ?,
			     active_run_id = NULL,
			     active_run_trigger = NULL,
			     lease_expires_at = NULL,
			     last_error = ?,
			     next_due_at = CASE WHEN enabled = 1 THEN COALESCE(?, next_due_at) ELSE NULL END,
			     updated_at = ?
			 WHERE bot_id = ?
			   AND status = 'running'
			   AND active_run_id IS ?`,
		)
		.bind(input.status, input.lastError, input.nextDueAt, input.now, input.botId, input.runId)
		.run();
	return result.meta?.changes === 1;
}

const metaCompactionToolMisuseSelfCorrection = `${providerCompactionToolName} cannot be used at this time, so I need to use another Bickr control or continue normally.`;

type MalformedArgumentsDroppedProviderToolCall = DroppedProviderToolCall & {
	reason: 'invalid_arguments_json' | 'arguments_not_json_object';
};

type NonEmptyMalformedArgumentsDroppedProviderToolCalls = readonly [
	MalformedArgumentsDroppedProviderToolCall,
	...MalformedArgumentsDroppedProviderToolCall[],
];

function isMalformedArgumentsDroppedProviderToolCall(
	call: DroppedProviderToolCall,
): call is MalformedArgumentsDroppedProviderToolCall {
	return call.reason === 'invalid_arguments_json' || call.reason === 'arguments_not_json_object';
}

function allToolCallsHaveMalformedArguments(
	dropped: readonly DroppedProviderToolCall[],
	originalToolCallCount: number,
): NonEmptyMalformedArgumentsDroppedProviderToolCalls | null {
	if (dropped.length === 0 || dropped.length !== originalToolCallCount) {
		return null;
	}
	const malformed: MalformedArgumentsDroppedProviderToolCall[] = [];
	for (const call of dropped) {
		if (!isMalformedArgumentsDroppedProviderToolCall(call)) {
			return null;
		}
		malformed.push(call);
	}
	const first = malformed[0];
	return first ? [first, ...malformed.slice(1)] : null;
}

export function malformedToolCallSelfCorrection(
	dropped: NonEmptyMalformedArgumentsDroppedProviderToolCalls,
): string {
	const canonicalNames: string[] = [];
	for (const call of dropped) {
		const name = canonicalToolName(call.name);
		if (name && !canonicalNames.includes(name)) {
			canonicalNames.push(name);
		}
	}
	const displayedNames = canonicalNames.slice(0, 2).map((name) => safeContextText(name, 80));
	const omittedNameCount = Math.max(0, canonicalNames.length - displayedNames.length);
	const nameList = [
		...displayedNames,
		...(omittedNameCount > 0 ? [`${omittedNameCount} more`] : []),
	].join(', ');
	const subject = dropped.length === 1
		? `${displayedNames[0] ? `the ${displayedNames[0]}` : 'that'} Bickr control`
		: `${dropped.length} Bickr controls${nameList ? ` (${nameList})` : ''}`;
	const exampleName = canonicalNames.find((name) => bickrFunctionToolArgumentExample(name) !== undefined);
	const example = exampleName ? bickrFunctionToolArgumentExample(exampleName) : undefined;
	return `I formatted ${subject} incorrectly. I need to retry with valid JSON object arguments, with every string literal and any authored prose properly quoted and escaped.${
		exampleName && example ? ` For ${safeContextText(exampleName, 80)}, I should use arguments shaped like ${example}.` : ''
	}`;
}

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

export function effectiveAvatarSettingsLanguageForBot(bot: Pick<BotDocument, 'language' | 'displayName'>): LanguageTag | null {
	return bot.language ?? localizedTextLang(bot.displayName) ?? fallbackToolTextLanguage;
}

export function effectiveAvatarSettingsLanguageForUser(user: Pick<UserDocument, 'language' | 'displayName'>): LanguageTag | null {
	return user.language ?? localizedTextLang(user.displayName) ?? fallbackToolTextLanguage;
}

export function effectiveAvatarSettingsLanguageForWorld(world: Pick<WorldDocument, 'language' | 'name'>): LanguageTag | null {
	return world.language ?? localizedTextLang(world.name) ?? fallbackToolTextLanguage;
}

function providerReasoningForSettings(
	settings: Pick<ProviderSettings, 'model' | 'reasoningEffort' | 'reasoningRequest'> & { baseUrl?: string },
): ProviderReasoningConfig | undefined {
	const requested = settings.reasoningRequest;
	if (requested?.kind === 'provider_default') return undefined;
	const rawEffort = requested?.kind === 'reasoning_disabled' ? 'none'
		: requested?.kind === 'explicit_effort' ? requested.effort
		: settings.reasoningEffort;
	const effort = effectiveReasoningEffortForModel(settings.model, settingsUseOpenRouter(settings), rawEffort);
	return effort ? { effort, exclude: false } : undefined;
}

function effectiveContextWindowTokensForModel(settings: Pick<ProviderSettings, 'baseUrl' | 'model'>, contextWindowTokens: number): number {
	return effectiveContextWindowForModel(contextWindowTokens, settings.model, settingsUseOpenRouter(settings));
}

function compactionAttemptReasoningStateFromResolution(
	resolution: Extract<CompactionReasoningResolution, { kind: 'selected' }>,
): CompactionAttemptReasoningState {
	return {
		decision: resolution.decision,
		runtimeFallback: resolution.runtimeFallback,
		selection: resolution.selection,
		provenance: resolution.provenance,
	};
}

function compactionReasoningDiagnostic(
	reasoning: CompactionAttemptReasoningState,
): CompactionReasoningDiagnostic {
	return {
		decision: reasoning.decision,
		selection: reasoning.selection,
		provenance: reasoning.provenance,
	};
}

function failedCompactionReasoningDiagnostic(error: unknown): CompactionReasoningDiagnostic | null {
	return error instanceof ProviderCompactionRequestError || error instanceof PersistentCompactionReductionFailureError
		? error.compactionReasoning
		: null;
}

function compactionAttemptRetryReasonEvent(reason: CompactionAttemptRetryReason | null): {
	reasoningFallback?: Pick<Extract<CompactionAttemptRetryReason, { kind: 'reasoning_fallback' }>, 'from' | 'to'>;
	text: string | null;
} {
	if (!reason) {
		return { text: null };
	}
	switch (reason.kind) {
		case 'provider':
			return { text: reason.detail };
		case 'reasoning_fallback':
			return {
				reasoningFallback: { from: reason.from, to: reason.to },
				text: `provider rejected compaction reasoning=none; retrying with ${compactionReasoningSelectionLabel(reason.to)}`,
			};
	}
}

function compactionReasoningSelectionLabel(
	selection: Exclude<CompactionAttemptReasoningState['selection'], { kind: 'reasoning_disabled' }>,
): string {
	return selection.kind === 'explicit_effort' ? selection.effort : selection.effort ?? 'model default';
}

function providerPromptCacheControl(
	settings: Pick<ProviderSettings, 'baseUrl' | 'model' | 'promptCacheMode' | 'promptCacheRequest'>,
): ProviderPromptCacheControl | undefined {
	if (settings.promptCacheRequest?.kind === 'provider_default') {
		return undefined;
	}
	const mode = settings.promptCacheRequest?.kind === 'mode'
		? settings.promptCacheRequest.mode
		: settings.promptCacheMode;
	if (mode === undefined || mode === 'off') return undefined;
	if (!modelSupportsPromptCacheControl(settings.model, settingsUseOpenRouter(settings))) {
		return undefined;
	}
	return mode === 'openrouter_anthropic_1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

function providerPromptCacheSessionId(botId: string): string {
	return `bot:${botId}`;
}

function providerToolCallsForSettings(
	settings: Pick<ProviderSettings,
		'baseUrl' | 'model' | 'ordinaryLoopToolCalls' | 'providerRouting' | 'reasoningEffort' | 'reasoningRequest' | 'toolCalls' | 'toolCallRequest'>,
	value?: BotInferenceToolCalls,
): BotInferenceToolCalls {
	if (value === undefined && settings.ordinaryLoopToolCalls) return settings.ordinaryLoopToolCalls.appliedStrategy;
	const requested = value ?? (settings.toolCallRequest?.kind === 'strategy'
		? settings.toolCallRequest.strategy
		: settings.toolCallRequest?.kind === 'provider_default' ? 'at_will' : settings.toolCalls);
	return effectiveToolCallsForModel(
		settings.model,
		settingsUseOpenRouter(settings),
		requested,
		settings.providerRouting,
		providerReasoningShapeForSettings(settings),
	);
}

/**
 * The single ordinary-loop decision about tool-call selection: which strategy is
 * actually applied, and whether `tool_choice` reaches the wire at all. The
 * request builder and the diagnostic event both read it from here so an event
 * can never report a `tool_choice` the provider request omits, or a mode the
 * request did not use.
 */
function providerToolChoiceEmissionForSettings(
	settings: ProviderSettings,
	value?: BotInferenceToolCalls,
): { toolCalls: BotInferenceToolCalls; toolChoice: ReturnType<typeof providerToolChoiceForMode> } {
	const toolCalls = providerToolCallsForSettings(settings, value);
	const omitted = settings.ordinaryLoopToolCalls?.emission === 'omit_tool_choice'
		|| settings.toolCallRequest?.kind === 'provider_default';
	return { toolCalls, toolChoice: omitted ? undefined : providerToolChoiceForMode(toolCalls) };
}

function providerReasoningShapeForSettings(
	settings: Pick<ProviderSettings, 'model' | 'reasoningEffort' | 'reasoningRequest'> & { baseUrl?: string },
): RequiredToolCallReasoningShape {
	const reasoning = providerReasoningForSettings(settings);
	if (!reasoning) return 'provider_default';
	return 'effort' in reasoning && reasoning.effort === 'none' ? 'reasoning_off' : 'reasoning_on';
}

function providerPrefillRequestValue(request: BotInferencePrefillIntent | undefined): boolean | undefined {
	switch (request?.kind) {
		case undefined:
		case 'inherit': return undefined;
		case 'explicit': return request.enabled;
	}
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
	const { toolCalls, toolChoice } = providerToolChoiceEmissionForSettings(input.settings, input.toolCallsMode);
	const reasoning = providerReasoningForSettings(input.settings);
	const reasoningShape = providerReasoningShapeForSettings(input.settings);
	return {
		model: input.settings.model,
		messageCount: input.requestMessages.length,
		toolCount: input.providerTools.length,
		toolCalls,
		...(input.settings.ordinaryLoopToolCalls
			? { toolCallPolicy: compactAppliedToolCallPolicy(input.settings.ordinaryLoopToolCalls) }
			: {}),
		...(input.settings.prefillPolicy
			? { prefillPolicy: compactAppliedPrefillPolicy(input.settings.prefillPolicy) }
			: {}),
		...(toolChoice ? { toolChoice } : {}),
		parallelToolCalls: providerParallelToolCalls,
		contextWindowTokens: input.requestContextWindowTokens,
		promptTokens: input.budgetCheck.promptTokens,
		allowedPromptTokens: input.budgetCheck.allowedPromptTokens,
		maxCompletionTokens: input.budgetCheck.maxCompletionTokens,
		...(reasoning ? { reasoning } : {}),
		reasoningPolicy: {
			intent: input.settings.reasoningRequest ?? { kind: 'bickr_automatic' },
			shape: reasoningShape,
			...(reasoning ? { emitted: reasoning } : {}),
		},
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

function prepareInferenceSubmissionMessages(
	settings: Pick<ProviderSettings, 'model' | 'supportsPrefill'> & { baseUrl?: string },
	messages: ChatMessage[],
): { requestMessages: ChatMessage[]; storedMessages: ChatMessage[] } {
	const requestMessages = providerMessagesWithPrefillCompatibility(settings, messages);
	return {
		requestMessages,
		storedMessages: sanitizeProviderMessagesForRequest(requestMessages),
	};
}

export function providerChatCompletionRequest(
	settings: ProviderSettings,
	messages: ChatMessage[],
	tools: ProviderToolDefinition[],
	reasoningPrefill?: string,
	toolCalls: BotInferenceToolCalls = providerToolCallsForSettings(settings),
	promptCacheSessionId?: string,
	maxCompletionTokens = providerContextCompletionReserveTokens,
): ProviderChatCompletionRequest {
	const requestMessages = providerMessagesWithPrefillCompatibility(
		settings,
		providerMessagesWithReasoningPrefill(messages, reasoningPrefill),
	);
	const { toolChoice } = providerToolChoiceEmissionForSettings(settings, toolCalls);
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

function providerLoopMaxCompletionTokens(contextWindowTokens: number, estimatedPromptTokens: number): number {
	const contextWindow = Math.max(1, Math.floor(contextWindowTokens));
	const promptTokens = Math.max(0, Math.floor(estimatedPromptTokens));
	return Math.max(1, Math.min(providerContextCompletionReserveTokens, contextWindow - promptTokens));
}

export function providerCompactionRequest(
	settings: Pick<ProviderSettings,
		'model' | 'prefillRequest' | 'providerRouting' | 'reasoningEffort' | 'reasoningRequest' |
		'toolCallRequest'> & { baseUrl?: string },
	messages: ChatMessage[],
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength' | 'maxCompletionTokens'> = defaultProviderCompactionSummaryLimits,
	providerTools?: ProviderToolDefinition[],
	mode: ProviderCompactionMode = 'structured_output',
	reasoning?: ProviderReasoningConfig,
): ProviderCompactionRequest {
	const effectiveMode = effectiveCompactionModeForModel(settings.model, settingsUseOpenRouter(settings), mode, settings.providerRouting);
	const reasoningShape: RequiredToolCallReasoningShape = !reasoning ? 'provider_default'
		: 'effort' in reasoning && reasoning.effort === 'none' ? 'reasoning_off' : 'reasoning_on';
	const toolCallPolicy = resolveToolCallPolicyForModel(
		settings.model,
		settingsUseOpenRouter(settings),
		settings.toolCallRequest ?? { kind: 'inherit' },
		settings.providerRouting,
		reasoningShape,
	);
	const toolCalls = toolCallPolicy.appliedStrategy === 'require' ? 'require' : 'railroad';
	const prefillPolicy = resolvePrefillPolicyForModel(
		settings.model,
		settingsUseOpenRouter(settings),
		providerPrefillRequestValue(settings.prefillRequest),
		settings.providerRouting,
		reasoningShape,
	);
	const effectiveProviderTools = providerTools ?? providerCompactionToolsForMode(limits, undefined, effectiveMode);
	const toolChoice = effectiveMode === 'structured_output'
		? providerNoToolChoice
		: toolCallPolicy.emission === 'omit_tool_choice' ? undefined : providerToolChoiceForMode(toolCalls);
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
		messages: sanitizeProviderMessagesForRequest(providerMessagesWithPrefillCompatibility(
			{ baseUrl: settings.baseUrl, model: settings.model, supportsPrefill: prefillPolicy.applied },
			messages,
		)),
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
	:	undefined;
	return custom && custom.trim() ? custom : defaultReasoningPrefill(bot.handle);
}

export function effectiveLoopRecurringPrompt(
	bot: Pick<RuntimeBotDocument, 'handle' | 'inferenceSettings' | 'worldRecurringPrompt'>,
): string | undefined {
	const worldContribution =
		bot.worldRecurringPrompt && bot.worldRecurringPrompt.trim() ? bot.worldRecurringPrompt.trimEnd() : undefined;
	const participantContribution = effectiveReasoningPrefill(bot);
	if (!worldContribution) {
		return participantContribution;
	}
	if (!participantContribution) {
		return worldContribution;
	}
	// The world contribution intentionally shares the participant's assistant
	// message. Providers that continue a final assistant prefill require the
	// participant-specific contribution to remain last, including its
	// load-bearing trailing whitespace.
	return `${worldContribution}\n\n${participantContribution}`;
}

export function providerMessagesWithReasoningPrefill(messages: ChatMessage[], reasoningPrefill: string | undefined): ChatMessage[] {
	return reasoningPrefill ? [...messages, { role: 'assistant', content: reasoningPrefill }] : messages;
}

function contextBudgetPromptParts(bot: RuntimeBotDocument, settings: ProviderSettings): ContextBudgetPromptParts {
	const { tools: providerTools } = providerToolsForBotRound(bot, settings);
	const fixedSystemToolInstructionTools = providerTools;
	const worldPrompt = stringValue(bot.worldPrompt) ?? '';
	const botWithoutPrompt = { ...bot, prompt: { lang: bot.language, text: '' } };
	const ordinaryToolCalls = providerToolCallsForSettings(settings);
	const fixedSystemMessage =
		ordinaryToolCalls === 'at_will'
			? standardPrompt(botWithoutPrompt, '')
			: appendToolRequirementInstruction(standardPrompt(botWithoutPrompt, ''), fixedSystemToolInstructionTools);
	const personaSystemMessage =
		ordinaryToolCalls === 'at_will'
			? standardPrompt(bot, '')
			: appendToolRequirementInstruction(standardPrompt(bot, ''), fixedSystemToolInstructionTools);
	const fullSystemMessage =
		ordinaryToolCalls === 'at_will'
			? standardPrompt(bot, worldPrompt)
			: appendToolRequirementInstruction(standardPrompt(bot, worldPrompt), fixedSystemToolInstructionTools);
	return {
		baseUrl: settings.baseUrl,
		fixedSystemMessage,
		fullSystemMessage,
		model: settings.model,
		personaSystemMessage,
		reasoningPrefill: effectiveLoopRecurringPrompt(bot),
		providerTools,
		supportsPrefill: settings.supportsPrefill === true,
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

function loopMessageContributesToCompactionProviderInput(row: LoopMessageRow): boolean {
	const message = loopMessageChatMessageFromRow(row);
	return loopMessageContributesToProviderHistory(row.origin, message);
}

export function runtimeErrorLoopMessageContent(message: unknown): string {
	return safeContextText(
		botFacingRuntimeErrorMessage(runtimeErrorCause(message)) ?? 'Bickr Terminal reported an error during this visit.',
		1_200,
	);
}

export function providerTokenProbeRequest(
	settings: ProviderSettings,
	messages: ChatMessage[],
	tools: ProviderToolDefinition[],
): ProviderTokenProbeRequest {
	const reasoning = providerReasoningForSettings(settings);
	// The probe exists to count the prompt tokens of the ordinary loop's own
	// request, so it must carry that request's tool-call decision rather than a
	// tool_choice of its own: the tools stay on the wire because they are part of
	// the prompt being measured, but `tool_choice` is emitted only when the loop
	// would emit it. Reading the decision from the shared ordinary-loop helper
	// resolves it against the exact reasoning shape emitted below, so Provider
	// default and capability-driven omission drop the field here too. Providers
	// that validate tool_choice against thinking mode otherwise reject the
	// owner-facing context-budget probe while the loop request itself succeeds.
	const { toolChoice } = providerToolChoiceEmissionForSettings(settings);
	return {
		model: settings.model,
		messages: sanitizeProviderMessagesForRequest(providerMessagesWithPrefillCompatibility(settings, messages)),
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		tools,
		...(toolChoice ? { tool_choice: toolChoice } : {}),
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

/**
 * The requested intent is `settings.toolCallRequest`, which the canonical graph
 * and version-0 compatibility resolvers both state, and which the type requires.
 * Nothing here reads `settings.toolCalls`: that is the applied structured-role
 * value a translation-aware resolver already chose, and re-reading it as a
 * request would put an applied strategy back through resolution as though the
 * owner had asked for it.
 */
export function providerTranslationRequest(settings: TranslationProviderSettings, text: string): ProviderTranslationRequest {
	const reasoning = providerReasoningForSettings(settings);
	const reasoningShape = providerReasoningShapeForSettings(settings);
	const toolCallPolicy = resolveToolCallPolicyForModel(
		settings.model,
		settingsUseOpenRouter(settings),
		settings.toolCallRequest,
		settings.providerRouting,
		reasoningShape,
	);
	const toolCalls = toolCallPolicy.appliedStrategy === 'require' ? 'require' : 'railroad';
	const toolChoice = toolCallPolicy.emission === 'omit_tool_choice' ? undefined : providerToolChoiceForMode(toolCalls);
	const tools = providerTranslationToolDefinitions();
	return {
		model: settings.model,
		messages: [
			{ role: 'system', content: appendToolRequirementInstruction(settings.prompt, tools) },
			{
				role: 'user',
				content: `Translate the following text. You must respond by calling the ${providerTranslationToolName} tool with the translated text in the translation argument. Do not reply as plain text.\n\nText:\n${text}`,
			},
		],
		...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		stream: false,
		tools,
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
	return resolveBotProviderSettings(bot, owner, providerEnvironmentSettingsFromBindings(env)).settings;
}

export async function effectiveProviderSettingsForBotCanonical(
	db: D1DatabaseLike,
	bot: Pick<BotDocument, 'id' | 'ownerUserId' | 'inferenceSettings'>,
	owner: Pick<UserDocument, 'inferenceSettings'>,
	env: Pick<Env, 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
): Promise<ProviderSettings> {
	const canonical = await canonicalBotInference(db, bot.ownerUserId, bot.id, env);
	return canonical?.providerSettings ?? effectiveProviderSettingsForBot(bot, owner, env);
}

export function effectiveProviderSettingsForTranslation(
	user: Pick<UserDocument, 'inferenceSettings'>,
	env: Pick<Env, 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
): TranslationProviderSettings | null {
	const translation = user.inferenceSettings?.translation;
	const settings = resolveLegacyTranslationProviderSettings(
		user,
		providerEnvironmentSettingsFromBindings(env),
	);
	if (!settings || !translation) return null;
	return {
		...settings,
		prompt: trimmed(translation?.prompt ? localizedTextString(translation.prompt) : undefined) ?? defaultTranslationPrompt,
	};
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
	const reasoningRequest = providerReasoningRequestFromLegacyEffort(requestSettings.reasoningEffort);
	const reasoningEffort = effectiveReasoningEffortForModel(model, openRouterBaseUrl, requestSettings.reasoningEffort, providerRouting);
	const reasoningShape: RequiredToolCallReasoningShape = reasoningEffort === undefined ? 'provider_default'
		: reasoningEffort === 'none' ? 'reasoning_off' : 'reasoning_on';
	const toolCallRequest = requestSettings.toolCalls === undefined
		? { kind: 'bickr_automatic' as const }
		: { kind: 'strategy' as const, strategy: requestSettings.toolCalls };
	const ordinaryLoopToolCalls = resolveToolCallPolicyForModel(
		model, openRouterBaseUrl, toolCallRequest, providerRouting, reasoningShape,
	);
	const toolCalls = ordinaryLoopToolCalls.appliedStrategy;
	const compactionMode = effectiveCompactionModeForModel(model, openRouterBaseUrl, requestSettings.compactionMode, providerRouting);
	const prefillPolicy = resolvePrefillPolicyForModel(
		model,
		openRouterBaseUrl,
		requestSettings.supportsPrefill,
		providerRouting,
		reasoningShape,
	);
	const supportsPrefill = prefillPolicy.applied;
	const prefillRequest: BotInferencePrefillIntent = requestSettings.supportsPrefill === undefined
		? { kind: 'inherit' }
		: { kind: 'explicit', enabled: requestSettings.supportsPrefill };
	return {
		apiKey: requestApiKey ?? (requestBaseUrl ? undefined : envApiKey),
		baseUrl,
		model,
		compactionMode,
		...(providerRouting ? { providerRouting } : {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
		reasoningRequest,
		supportsPrefill,
		prefillRequest,
		prefillPolicy,
		toolCalls,
		toolCallRequest,
		ordinaryLoopToolCalls,
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
-- Retention: events are pruned after ${runtimeEventRetentionDays} days except active-run rows and seq >= ${lastLogOffSeqStateKey}.
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
-- Retention: local provider_usage rows are kept for at least ${botInferenceUsageRetentionDays} days and until id <= ${centralProviderUsageExportCursorStateKey}.
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
-- Retention: rows a compaction has absorbed are deleted after
-- ${compactedLoopMessageRetentionDays} days (${compactionSummaryLoopMessageRetentionDays} days for the summaries themselves) and
-- owner-deleted rows after ${deletedLoopMessageRetentionDays} days. The active context — compacted_by IS NULL AND
-- deleted_at IS NULL — is never pruned by age.
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
	-- Set on a compaction summary when retention physically deleted rows it had
	-- absorbed. The data model records no absorbed-child count, so this is the
	-- only durable evidence that un-compacting the summary can no longer restore
	-- what it stands for.
	ledger_pruned_at TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS loop_messages_active ON loop_messages (compacted_by, position, seq);
CREATE INDEX IF NOT EXISTS loop_messages_run ON loop_messages (run_id, seq);
-- Owner-visible non-history diagnostics are physically capped by RuntimeMessageStore at append time.
CREATE INDEX IF NOT EXISTS loop_messages_diagnostic_retention ON loop_messages (origin, seq DESC);
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

/**
 * Every table in `runtimeSchema`, read out of the schema itself so a table added
 * later cannot be silently left behind by a full storage clear.
 */
const runtimeStorageTables: readonly string[] = [...runtimeSchema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)]
	.map((match) => match[1])
	.filter((name): name is string => Boolean(name));

export class BotRuntime {
	private readonly state: DurableObjectState;
	private readonly env: Env;
	private activeAbortController: AbortController | null = null;
	private activeRunId: string | null = null;
	private activeMaintenanceOperation: ActiveMaintenanceOperation | null = null;
	private readonly activeStreamActivity = new Map<string, string>();
	private ephemeralStreamSeq = 0;
	private transitionQueue = new ExclusiveOperationQueue();
	/**
	 * When this object's storage was fully cleared, or null while it is live.
	 *
	 * Cached in memory as well as persisted so that the window inside
	 * `clearRuntimeStorage` — after `deleteAll` has dropped the tables and before
	 * the rebuilt schema can hold the tombstone again — is still closed to
	 * mutations rather than answering them with a raw SQL failure.
	 */
	private runtimeStorageClearedAt: string | null = null;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.state.blockConcurrencyWhile(async () => {
			this.initializeRuntimeStorage();
			this.runtimeStorageClearedAt = stringValue(this.runtimeStateValue(runtimeStorageClearedStateKey)) ?? null;
			// A cleared object that is evicted and rebuilt runs this block again. Each
			// migration stamps a "done" marker into `runtime_state` even when it finds
			// nothing to migrate, so on erased storage they would write rows back for
			// no gain: there is nothing legacy left in it, and never will be.
			if (!this.runtimeStorageClearedAt) {
				this.migrateLegacyLoopMessages();
				this.migrateLegacyProviderToolCallHistory();
				this.observeProviderToolCallHistoryInvariantAfterStartupMigration();
				this.backfillProviderTokenCalibrationSamples();
			}
		});
	}

	/**
	 * Bring this object's storage up to the current schema. Idempotent, and used
	 * both at construction and after a full clear drops the database outright.
	 * Excludes the one-time legacy data migrations: they are startup work, and
	 * storage that was just emptied has nothing legacy left in it.
	 */
	private initializeRuntimeStorage(): void {
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
		// The index has to be created here rather than in the schema block: on a
		// participant that predates the column, the block runs before the ALTER
		// above. It backs the per-spotlight lookup that makes injection
		// idempotent, so a replayed batch never gives one participant the same
		// spotlight twice.
		this.state.storage.sql.exec(`CREATE INDEX IF NOT EXISTS injections_spotlight ON injections (spotlight_id)`);
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
		if (!columns.has('ledger_pruned_at')) {
			this.state.storage.sql.exec(`ALTER TABLE loop_messages ADD COLUMN ledger_pruned_at TEXT`);
		}
		this.state.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS loop_messages_visible ON loop_messages (deleted_at, compacted_by, position, seq)`,
		);
		// Retention scans a created_at range and stops at its batch limit. Without
		// this index every prune — including the no-op prune after every visit —
		// would scan the whole table, which is the largest table in the object.
		this.state.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS loop_messages_retention ON loop_messages (created_at, seq)`,
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

	private migrateLegacyProviderToolCallHistory(): void {
		if (this.runtimeStateBoolean(legacyProviderToolCallHistoryNormalizedStateKey)) {
			return;
		}
		this.runStorageTransactionSync(() => {
			const normalization = normalizeLegacyProviderToolCallHistoryRows(this.activeLoopMessageRows());
			const deletedAt = new Date().toISOString();
			const insertedSeqs = new Map<string, number>();
			for (const operation of normalization.operations) {
				if (operation.kind === 'delete') {
					this.state.storage.sql.exec(
						`UPDATE loop_messages
						 SET deleted_at = ?
						 WHERE seq = ?
						   AND deleted_at IS NULL`,
						deletedAt,
						operation.seq,
					);
					continue;
				}
				if (operation.kind === 'update') {
					const messageJson = JSON.stringify(operation.message);
					this.state.storage.sql.exec(
						`UPDATE loop_messages
						 SET message_json = ?, token_estimate = ?
						 WHERE seq = ?
						   AND deleted_at IS NULL`,
						messageJson,
						estimateTextTokens(messageJson),
						operation.seq,
					);
					continue;
				}
				const inserted = this.insertLoopMessage({
					runId: operation.sourceRow.run_id,
					message: operation.message,
					origin: operation.sourceRow.origin,
					status: operation.sourceRow.status ?? undefined,
					streamSeq: operation.sourceRow.stream_seq ?? undefined,
					createdAt: operation.sourceRow.created_at,
					broadcast: false,
				});
				insertedSeqs.set(operation.id, inserted.seq);
			}
			this.updateActiveLoopMessagePositions(normalization.order.map((item) => (item.kind === 'existing' ? item.seq : insertedSeqs.get(item.id))).filter(
				(seq): seq is number => typeof seq === 'number',
			));
			this.setRuntimeState(legacyProviderToolCallHistoryNormalizedStateKey, true);
		});
	}

	private observeProviderToolCallHistoryInvariantAfterStartupMigration(): void {
		const violation = providerToolCallHistoryInvariantViolation(this.activeLoopMessageRows());
		if (!violation) {
			this.deleteRuntimeState(providerToolCallHistoryInvariantViolationStateKey);
			return;
		}
		const botId = this.botIdForStartupDiagnostics();
		const objectId = this.state.id.toString();
		const payload = {
			botId: botId ?? 'unknown',
			objectId,
			violation,
			detectedAt: new Date().toISOString(),
		};
		console.error('BotRuntime provider tool-call history invariant violation after startup migration', payload);
		this.setRuntimeState(providerToolCallHistoryInvariantViolationStateKey, payload);
		this.deleteRuntimeState(legacyProviderToolCallHistoryNormalizedStateKey);
	}

	assertProviderToolCallHistoryInvariantOrThrow(): void {
		const violation = providerToolCallHistoryInvariantViolation(this.activeLoopMessageRows());
		if (violation) {
			throw new Error(`Loop message provider tool-call history invariant failed: ${violation}.`);
		}
	}

	private botIdForStartupDiagnostics(): string | null {
		const row = this.state.storage.sql
			.exec<{ payload_json: string }>(
				`SELECT payload_json
				 FROM events
				 WHERE type = 'tick_started'
				 ORDER BY seq DESC
				 LIMIT 1`,
			)
			.toArray()[0];
		if (!row) {
			return null;
		}
		try {
			return stringValue(runtimeRecord(JSON.parse(row.payload_json) as unknown).botId) ?? null;
		} catch {
			return null;
		}
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

	private runStorageTransactionSync<T>(closure: () => T): T {
		// Some unit-test harnesses stub only the SQL surface; production SQLite
		// Durable Object storage provides transactionSync.
		const storage = (this as unknown as { state?: { storage?: { transactionSync?: <Result>(callback: () => Result) => Result } } }).state?.storage;
		return typeof storage?.transactionSync === 'function' ? storage.transactionSync(closure) : closure();
	}

	private compactionReasoningForSettings(
		settings: Pick<ProviderSettings, 'baseUrl' | 'compactionReasoning' | 'model' | 'providerRouting'>,
	): CompactionAttemptReasoningState {
		const openRouter = settingsUseOpenRouter(settings);
		const policy = compactionReasoningPolicyForModel(
			settings.model,
			openRouter,
			settings.providerRouting,
		);
		const frozenFallback = compactionReasoningLearnedFloorFromFrozenState(
			this.runtimeStateRecord(compactionReasoningFallbackStateKey),
			settings.model,
			openRouter ? 'openrouter' : 'custom',
		);
		if (frozenFallback.kind === 'stale') {
			this.deleteRuntimeState(compactionReasoningFallbackStateKey);
		}
		const resolution = resolveCompactionReasoningSelection({
			policy,
			capabilities: compactionReasoningCapabilitiesForModel(
				settings.model,
				openRouter,
				settings.providerRouting,
			),
			...(settings.compactionReasoning ? { request: settings.compactionReasoning } : {}),
			...(frozenFallback.kind === 'matched' ? { learnedFloor: frozenFallback.learnedFloor } : {}),
		});
		if (resolution.kind === 'refused') {
			throw new CompactionReasoningRefusalError(resolution.refusal, resolution.provenance);
		}
		return compactionAttemptReasoningStateFromResolution(resolution);
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
			if (!isTrustedInternalServiceRequest(request, this.env.INTERNAL_SERVICE_SECRET)) {
				return agentRuntimeNotFoundResponse();
			}
			const maintenanceResponse = await mutationMaintenanceResponse(request, this.env.BICKR_D1, { allowRuntimeStop: true });
			if (maintenanceResponse) {
				return maintenanceResponse;
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
			return ok({ status: await this.readStatus(botId) });
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
			if (options.deferred && options.mode === 'spotlight') {
				return ok({ run: this.deferSpotlightTick(options) });
			}
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

		// Retention and the full clear are fleet maintenance, not owner actions: the
		// owner-facing equivalents are erase-history and participant deletion, both
		// of which have their own routes and their own confirmations.
		if (request.method === 'POST' && url.pathname.endsWith('/retention')) {
			this.requireInternalMaintenance(request);
			return ok({ retention: this.runRetentionPass(this.activeRunId) });
		}

		if (request.method === 'DELETE' && url.pathname.endsWith('/storage')) {
			this.requireInternalMaintenance(request);
			return ok({ cleared: await this.clearRuntimeStorage(botId) });
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
		const injected = this.injectThought(text, {
			kind: stringValue(bodyRecord.kind) ?? 'manual',
			sourceId: stringValue(bodyRecord.sourceId),
			spotlightId: stringValue(bodyRecord.spotlightId),
		});
		// `event` is absent when an idempotent spotlight retry matched an existing
		// injection: nothing new happened, so there is nothing new to report.
		return ok({
			...(injected.event ? { event: injected.event } : {}),
			injectionId: injected.injectionId,
		});
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
		const messageBackfill = runtimeMonitorBackfillCursor(url, 'afterMessage');
		const eventBackfill = runtimeMonitorBackfillCursor(url, 'afterEvent');
		for (const message of this.loopMessagesAfter(messageBackfill.afterSeq, messageBackfill.initialLimit)) {
			server.send(JSON.stringify({ type: 'loop_message', loopMessage: message }));
		}
		for (const event of this.eventsAfter(eventBackfill.afterSeq, eventBackfill.initialLimit)) {
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
				const injected = this.injectThought(payload.text.trim());
				ws.send(JSON.stringify({ type: 'event', event: injected.event }));
			}
		} catch (error) {
			// A socket accepted before a full clear stays connected until the close
			// frame lands, so its rejection carries the same typed cause the HTTP
			// routes answer with rather than only prose the client cannot branch on.
			const details = error instanceof RepositoryError ? error.details : undefined;
			ws.send(JSON.stringify({
				type: 'error',
				message: error instanceof Error ? error.message : 'Bad message.',
				...(error instanceof RepositoryError ? { code: error.code } : {}),
				...(details?.runtimeStorageCause ? { runtimeStorageCause: details.runtimeStorageCause } : {}),
			}));
		}
	}

	async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
		console.error('bot runtime monitor WebSocket error', error);
	}

	private async startBackgroundTick(botId: string, trigger: RuntimeRunTrigger, options: TickOptions): Promise<TickRunResult> {
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

	private async runTick(botId: string, trigger: RuntimeRunTrigger, options: TickOptions = {}): Promise<TickRunResult> {
		const admission = await this.admitTick(botId, trigger, options);
		if (!admission.admitted) {
			return admission.result;
		}
		return this.runAdmittedTick(botId, trigger, options, admission.tick);
	}

	private async admitTick(botId: string, trigger: RuntimeRunTrigger, options: TickOptions): Promise<TickAdmission> {
		return this.runtimeTransitionQueue().run(async () => {
			// Inside the transition queue, which a clear also holds, so a tick can
			// neither slip between the clear's guards and its writes nor start against
			// storage the clear has already erased. Everything a run does — events,
			// loop messages, injection consumption — is a write.
			this.requireWritableRuntimeStorage();
			await this.reapStaleRun(botId);
			const current = await this.readStatus(botId);
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
			const providerSettings = await this.effectiveProviderSettings(bot, owner);
			const runId = crypto.randomUUID();
			const now = new Date().toISOString();
			const leaseExpiresAt = new Date(Date.parse(now) + runtimeRunLeaseTimeoutMs).toISOString();
			const claimed = await claimRuntimeRun(this.env.BICKR_D1, bot.id, runId, leaseExpiresAt, now, trigger);
			if (!claimed) {
				// The claim refuses both a live run and a paused participant, so the
				// caller-facing answer comes from re-running the guards above against
				// the row as it stands now. A live run still wins: a spotlight request
				// has to be queued onto it rather than told the participant is paused.
				const refused = await this.readStatus(botId);
				if (refused.status !== 'running' && !refused.enabled) {
					return { admitted: false, result: pausedTickResult() };
				}
				return { admitted: false, result: this.busyTickResult(refused, trigger, options) };
			}

			const abortController = new AbortController();
			this.activeAbortController = abortController;
			this.activeRunId = runId;
			this.clearStopRequest();
			// The trigger the claim recorded is the single source of truth for whether
			// this is a spotlight visit. Deriving the mode from it rather than reading
			// `options.mode` a second time keeps the run that skips rescheduling and
			// the run that reads spotlight injections from ever being different runs.
			const mode: TickMode = trigger === 'spotlight' ? 'spotlight' : 'normal';
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
		trigger: RuntimeRunTrigger,
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
			this.appendEvent(runId, 'tick_started', { trigger, botId, handle: bot.handle });
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
				const nextDueAt = await this.setRuntimeIndex(bot, 'idle', undefined, new Date().toISOString(), runId, trigger);
				this.appendEvent(runId, 'tick_completed', {
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
			const inputEvent = this.appendEvent(runId, 'input', input);
			const builtMessages = await this.buildMessages(bot, input, runId, inputEvent.createdAt, { setupMode });
			if (setupMode === 'new_iteration') {
				const deliveredNotificationIds = builtMessages.deliveredNotificationIds;
				const deliveredSeenItems = uniqueSeenContentItems(
					[...deliveredNotificationIds].flatMap((id) => builtInput.notificationSeenItemsById[id] ?? []),
				);
				await markBotSeenContent(this.env.BICKR_D1, bot.id, deliveredSeenItems, 'notification', runId);
				// Delivery is destructive: what the visit was handed is deleted from
				// both stores, so the next visit sees only what is new.
				await deleteDeliveredNotifications(
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
			const nextDueAt = await this.setRuntimeIndex(bot, 'idle', undefined, new Date().toISOString(), runId, trigger);
			this.appendEvent(runId, 'tick_completed', { ...(nextDueAt ? { nextDueAt } : {}) });
			startQueuedSpotlightAfterRun = true;
			return { runId, status: 'completed' };
		} catch (error) {
			if (error instanceof TickStoppedError || isAbortError(error)) {
				this.markPendingCompactionEventsFailed(runId, 'This Bickr visit was stopped.');
				if (!this.hasTerminalEvent(runId)) {
					this.appendEvent(runId, 'tick_stopped', { message: 'This Bickr visit was stopped.' });
				}
				await this.setRuntimeIndex(bot, 'idle', undefined, new Date().toISOString(), runId, trigger);
				return { runId, status: 'stopped' };
			}
				if (error instanceof PersistentToolFailureError) {
					const cause = runtimeErrorCause(error);
					const message = ownerFacingRuntimeErrorMessage(cause) ?? error.message;
					if (!this.hasTerminalEvent(runId)) {
						this.recordTickFailure(runId, {
							message,
							toolName: error.failure.toolName,
							failure: error.failure,
						}, [], { cause });
					}
					await this.setRuntimeIndex(bot, 'failed', message, new Date().toISOString(), runId, trigger);
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
								message,
							});
						}
					} catch (notificationError) {
						console.warn('bot runtime failure notification failed', notificationError);
					}
					return { runId, status: 'failed', error: message };
				}
				if (error instanceof PersistentMissingToolCallError) {
					const cause = runtimeErrorCause(error);
					const message = ownerFacingRuntimeErrorMessage(cause) ?? error.message;
					if (!this.hasTerminalEvent(runId)) {
						this.recordTickFailure(runId, {
							message,
							toolNames: error.toolNames,
						}, [], { cause });
					}
					await this.setRuntimeIndex(bot, 'failed', message, new Date().toISOString(), runId, trigger);
					try {
						await recordBotRuntimeFailureHumanNotification(this.env.BICKR_D1, {
							bot,
							runId,
							message: cause,
						});
						if (runContext.mode === 'spotlight' && runContext.spotlightId) {
							await recordSpotlightFailureHumanNotification(this.env.BICKR_D1, {
								bot,
								runId,
								spotlightId: runContext.spotlightId,
								message,
							});
						}
					} catch (notificationError) {
						console.warn('bot runtime failure notification failed', notificationError);
					}
					return { runId, status: 'failed', error: message };
				}
				if (error instanceof PersistentCompactionReductionFailureError) {
					const cause = runtimeErrorCause(error);
					const message = ownerFacingRuntimeErrorMessage(cause) ?? error.message;
					if (!this.hasTerminalEvent(runId)) {
						this.recordTickFailure(runId, {
							message,
							paused: true,
							reason: 'persistent_non_reducing_compaction',
							attempts: error.attempts,
						}, runtimeFailureLogs(error), { cause });
					}
					const failedAt = new Date().toISOString();
					await this.pauseBotAfterPersistentCompactionFailure(bot, message, failedAt);
					await this.setRuntimeIndex(bot, 'failed', message, failedAt, runId, trigger);
					try {
						await recordBotRuntimeFailureHumanNotification(this.env.BICKR_D1, {
							bot,
							runId,
							message: cause,
						});
					} catch (notificationError) {
						console.warn('bot runtime failure notification failed', notificationError);
				}
					return { runId, status: 'paused', error: message };
				}
				const cause = runtimeErrorCause(error);
				const message = ownerFacingRuntimeErrorMessage(cause) ?? 'Unexpected Bickr visit error.';
				if (!this.hasTerminalEvent(runId)) {
					this.recordTickFailure(runId, { message }, runtimeFailureLogs(error), { cause });
				}
				await this.setRuntimeIndex(bot, 'failed', message, new Date().toISOString(), runId, trigger);
				try {
					await recordBotRuntimeFailureHumanNotification(this.env.BICKR_D1, {
						bot,
						runId,
						message: cause,
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
			try {
				const pruned = this.pruneRuntimeStorageAfterTick(runId);
				// Logged only when the pass changed something: the rollout needs
				// per-participant evidence that loop retention is making progress, and a
				// line after every visit of every participant would bury it.
				if (retentionPruneChangeCount(pruned) > 0) {
					console.log(JSON.stringify({ event: 'bot_runtime_retention_prune', botId, runId, pruned }));
				}
			} catch (error) {
				console.warn('bot runtime local retention prune failed', botId, error);
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
			// The full clear is the one operation erased storage still accepts. The
			// sweep retries a clear whose confirmation it lost, and re-clearing an
			// already empty object is the no-op that finally lets it stamp its marker;
			// compaction and erase-history, by contrast, would both write.
			if (operation !== 'clear_storage') {
				this.requireWritableRuntimeStorage();
			}
			await this.reapStaleRun(botId);
			const current = await this.readStatus(botId);
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

	private busyTickResult(current: BotRuntimeStatus, trigger: RuntimeRunTrigger, options: TickOptions): TickRunResult {
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
		if (!this.enqueuePendingSpotlightTick(options)) {
			return null;
		}
		return { runId: activeRunId, status: 'queued' };
	}

	/**
	 * Queue a spotlight visit without attempting admission at all.
	 *
	 * This is the "not now" path: the owner asked for the spotlight to wait for
	 * the participant's own rhythm. It shares the collision path's durable queue,
	 * which the after-run drain already consumes, so the injection is read at the
	 * next completed visit instead of sitting unread forever.
	 */
	private deferSpotlightTick(options: TickOptions): TickRunResult {
		if (!this.enqueuePendingSpotlightTick(options)) {
			return { runId: 'deferred', status: 'failed', error: 'A deferred spotlight visit needs a spotlight id and injection.' };
		}
		return { runId: 'deferred', status: 'queued' };
	}

	private enqueuePendingSpotlightTick(options: TickOptions): boolean {
		if (options.mode !== 'spotlight' || !options.spotlightId || !options.injectionIds?.length) {
			return false;
		}
		// The queue lives in `runtime_state`, so queueing is itself a write.
		this.requireWritableRuntimeStorage();
		this.spotlightTickQueue().append(options.spotlightId, uniqueStrings(options.injectionIds), new Date().toISOString());
		return true;
	}

	private startQueuedSpotlightTick(botId: string): void {
		// The drain both reads and rewrites the queue, and prepends its entries back
		// when the visit does not start. On erased storage there is nothing left to
		// drain and nothing that may be written back, so it stops before touching
		// either — rather than letting `admitTick` refuse and the catch re-queue.
		if (this.runtimeStorageClearedAt) {
			return;
		}
		const queue = this.spotlightTickQueue();
		const pending = queue.takeNext();
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
					queue.prepend(pending.entries);
				}
			})
			.catch((error) => {
				queue.prepend(pending.entries);
				console.error('queued spotlight tick failed to start', error);
			});
		this.state.waitUntil(tick);
	}

	private spotlightTickQueue(): RuntimeSpotlightTickQueue {
		return new RuntimeSpotlightTickQueue(this.state.storage);
	}

	private async stopTick(botId: string): Promise<{ stopped: boolean; runId?: string; status: BotRuntimeStatus['status'] }> {
		await this.reapStaleRun(botId);
		// The index row rather than readStatus, because releasing a run this instance
		// does not own needs the trigger it was claimed with, and only the row knows.
		const current = await this.runtimeStatusIndexRow(botId);
		const status = current?.status ?? 'idle';
		const runId = current?.activeRunId ?? this.activeRunId ?? undefined;
		if (status !== 'running' || !runId) {
			return { stopped: false, status };
		}

		this.setStopRequest(runId);
		this.appendEvent(runId, 'tick_stop_requested', { message: 'This Bickr visit was asked to stop.' });
		if (this.activeRunId === runId && this.activeAbortController && !this.activeAbortController.signal.aborted) {
			this.activeAbortController.abort();
			return { stopped: true, runId, status };
		}
		const bot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
		await this.markRunStopped(bot, runId, recordedRunTrigger(current?.activeRunTrigger ?? null));
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
		const worldRecurringPrompt =
			world?.recurringPromptEnabled === true && localizedTextString(world.recurringPrompt).trim() ?
				localizedTextString(world.recurringPrompt).trimEnd()
			:	undefined;
		return {
			...bot,
			effectivePostingSettings: effectivePostingSettings(world?.postingSettings, bot.postingSettings),
			worldPrompt: stringValue(world?.prompt) ?? '',
			worldRecurringPrompt,
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

	private async markRunStopped(bot: BotDocument, runId: string, trigger: RuntimeRunTrigger): Promise<string | null> {
		this.markPendingCompactionEventsFailed(runId, 'This Bickr visit was stopped.');
		if (!this.hasTerminalEvent(runId)) {
			this.appendEvent(runId, 'tick_stopped', { message: 'This Bickr visit was stopped.' });
		}
		const nextDueAt = await this.setRuntimeIndex(bot, 'idle', undefined, new Date().toISOString(), runId, trigger);
		this.clearStopRequest(runId);
		return nextDueAt;
	}

	private async runProviderLoop(
		bot: RuntimeBotDocument,
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
			let { tools: providerTools, serverTools } = providerToolsForBotRound(bot, settings);
			if (providerTools.length === 0) {
				return finishProviderLoop();
			}
			let response: ProviderResponse;
			let responseStatus: ProviderMessageStatus = 'complete';
			let interruptedError: ProviderResponseInterruptedError | null = null;
			let requestEvent: BotRuntimeEvent;
			let allToolCallsDroppedRetried = false;
			for (;;) {
				const budgetCheck = await this.ensureProviderPromptWithinBudget(bot, settings, runId, runContext.signal, providerTools);
				providerTools = budgetCheck.providerTools;
				const requestMessages = budgetCheck.requestMessages;
				const requestContextWindowTokens = budgetCheck.contextWindowTokens ?? tickSettings.contextWindowTokens;
				const requestMaxCompletionTokens = providerLoopMaxCompletionTokens(requestContextWindowTokens, budgetCheck.promptTokens);
				requestEvent = this.appendEvent(runId, 'provider_request', providerLoopRequestEventPayload({
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
				const failedResponse = response;
				const sanitized = sanitizeProviderResponseToolCalls(response);
				response = sanitized.response;
				const allToolCallsDroppedResponse =
					responseStatus === 'complete' &&
					sanitized.originalToolCallCount > 0 &&
					response.toolCalls.length === 0;
				const malformedArgumentsOnlyResponse = allToolCallsDroppedResponse
					? allToolCallsHaveMalformedArguments(sanitized.dropped, sanitized.originalToolCallCount)
					: null;
				await this.recordDroppedProviderToolCalls(
					runId,
					requestEvent.seq,
					sanitized.dropped,
					'generated_response',
					allToolCallsDroppedResponse && !allToolCallsDroppedRetried,
				);
				this.recordRepairedProviderToolCalls(runId, requestEvent.seq, sanitized.repaired);
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
				if (!allToolCallsDroppedResponse) {
					break;
				}
				this.appendDroppedProviderResponseAttempt(
					runId,
					failedResponse,
					requestEvent.seq,
					sanitized.dropped,
				);
				if (allToolCallsDroppedRetried) {
					throw new Error(
						malformedArgumentsOnlyResponse
							? 'Inference provider returned only malformed page-control requests after retry.'
							: 'Inference provider returned only invalid page-control requests after retry.',
					);
				}
				if (malformedArgumentsOnlyResponse) {
					const correction = malformedToolCallSelfCorrection(malformedArgumentsOnlyResponse);
					this.appendEvent(runId, 'assistant_message', {
						content: correction,
						status: 'complete',
					});
					this.appendLoopMessage(runId, { role: 'assistant', content: correction }, 'self_correction');
				}
				allToolCallsDroppedRetried = true;
			}
			await this.appendProviderMessages(runId, response, responseStatus, requestEvent.seq);
			const responseGeneratedTokens = Math.max(0, Math.floor(response.usage?.completionTokens ?? 0));
			generatedTokensThisTick += responseGeneratedTokens;
			generatedTokensThisIteration += responseGeneratedTokens;
			const tickGeneratedLimitReached = generatedTokensThisTick >= tickSettings.maxGeneratedTokensPerTick;
			let forceSyntheticLogOff = !spotlightStreakActive && generatedTokensThisIteration >= tickSettings.maxGeneratedTokensPerIteration;
			const assistantMessage = providerResponseMessageForHistory(response);
			let providerResponseLogsRecorded = false;
			let appendedToolCallPairCount = 0;
			const consumeProviderResponseLogs = (): LoopMessageAppendLog[] => {
				if (providerResponseLogsRecorded) {
					return [];
				}
				const logs: LoopMessageAppendLog[] = [];
				if (response.requestBody) {
					logs.push({ kind: 'provider_request', text: response.requestBody });
				}
				logs.push({ kind: 'provider_response', text: JSON.stringify(providerResponseLogPayload(response, responseStatus)) });
				providerResponseLogsRecorded = true;
				return logs;
			};
			const appendAssistantToolResultPair = (
				toolCall: ToolCall,
				toolMessage: ChatMessage,
				toolOrigin: BotLoopMessageOrigin,
					toolStatus: BotLoopMessageStatus = 'complete',
					toolOptions: { displayEventSeq?: number } = {},
					recordedToolCall: ToolCall = toolCall,
				): void => {
					if (!assistantMessage) {
						return;
					}
					const assistantLoopMessage = providerResponseToolCallMessageForHistory(
						assistantMessage,
						recordedToolCall,
						appendedToolCallPairCount === 0,
					);
					this.appendLoopMessageGroup([
						{
							runId,
							message: assistantLoopMessage,
						origin: 'provider_response',
						status: responseStatus,
						options: { streamSeq: requestEvent.seq },
						extraLogs: consumeProviderResponseLogs(),
					},
					{
						runId,
						message: toolMessage,
						origin: toolOrigin,
						status: toolStatus,
						options: toolOptions,
						extraLogs: [
							{ kind: 'tool_call', text: JSON.stringify(recordedToolCall) },
							{ kind: 'tool_result', text: toolMessage.content ?? '' },
						],
						},
					]);
					appendedToolCallPairCount += 1;
				};
			const appendAssistantMessageWithoutToolCalls = (): void => {
				if (!assistantMessage) {
					return;
				}
				this.appendLoopMessageGroup([
					{
						runId,
						message: assistantMessage,
						origin: 'provider_response',
						status: responseStatus,
						options: { streamSeq: requestEvent.seq },
						extraLogs: consumeProviderResponseLogs(),
					},
				]);
			};
			if (responseStatus === 'interrupted') {
				if (response.toolCalls.length > 0) {
					this.appendInterruptedToolMessages(
						runId,
						response.toolCalls,
						new Set(response.toolCalls.map((toolCall) => toolCall.id)),
						(toolCall, toolMessage, content) => {
							appendAssistantToolResultPair(toolCall, toolMessage, 'tool_failure', 'interrupted', {}, toolCall);
							return content;
						},
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
					this.appendEvent(runId, 'assistant_message', {
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
				this.appendEvent(runId, 'tool_result', {
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
				appendAssistantToolResultPair(toolCall, toolMessage, 'tool_failure');
				const acknowledgement = toolFailureAssistantContent(failure);
				if (consecutiveToolFailures >= 5) {
					persistentFailure = failure;
				}
				toolFailureAcknowledgements.push(acknowledgement);
			};

			for (const toolCall of response.toolCalls) {
				this.throwIfStopped(runId, runContext.signal);
				const canonicalName = canonicalToolName(toolCall.function.name);
				if (canonicalName === providerCompactionToolName) {
					pendingToolCallIds.delete(toolCall.id);
						await this.dropGeneratedProviderToolCall(
							runId,
							requestEvent.seq,
							toolCall,
							'disallowed_meta_compaction_tool',
						);
					selfCorrectionAcknowledgements.push(metaCompactionToolMisuseSelfCorrection);
					continue;
				}
					if (canonicalName === 'log_off' && !tickSettings.allowEarlyLogOff) {
						pendingToolCallIds.delete(toolCall.id);
						await this.dropGeneratedProviderToolCall(runId, requestEvent.seq, toolCall, 'disallowed_log_off');
						selfCorrectionAcknowledgements.push(disallowedLogOffSelfCorrectionContent);
						continue;
					}
					if (canonicalName === 'log_off' && !mutatingToolUsedThisIteration && !prematureLogOffCorrectedThisIteration) {
						pendingToolCallIds.delete(toolCall.id);
						await this.dropGeneratedProviderToolCall(runId, requestEvent.seq, toolCall, 'premature_log_off');
						prematureLogOffCorrectedThisIteration = true;
						selfCorrectionAcknowledgements.push(prematureLogOffSelfCorrectionContent);
						continue;
					}
					if (logOffCalled && canonicalName !== 'log_off') {
						pendingToolCallIds.delete(toolCall.id);
						await this.dropGeneratedProviderToolCall(runId, requestEvent.seq, toolCall, 'iteration_limit');
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
						this.appendInterruptedToolMessages(runId, response.toolCalls, pendingToolCallIds, (interruptedToolCall, toolMessage, content) => {
							appendAssistantToolResultPair(interruptedToolCall, toolMessage, 'tool_failure', 'interrupted', {}, interruptedToolCall);
							return content;
						});
						throw error;
					}
					if (error instanceof SelfCorrectingToolCallError) {
						pendingToolCallIds.delete(toolCall.id);
						consecutiveToolFailures = 0;
						selfCorrectionAcknowledgements.push(...error.selfCorrectionMessages);
						continue;
					}
					const failure = toolFailurePayload(toolCall.function.name, args, error);
					const selfCorrection = selfCorrectionMessageForToolFailurePayload(failure);
					if (selfCorrection) {
						pendingToolCallIds.delete(toolCall.id);
						consecutiveToolFailures = 0;
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
				const recordedToolCall = result.effectiveArgs
					? toolCallWithArguments(toolCall, JSON.stringify(providerToolArgs(result.name, result.effectiveArgs)))
					: toolCall;
				appendAssistantToolResultPair(toolCall, toolMessage, 'tool_result', 'complete', { displayEventSeq: result.displayEventSeq }, recordedToolCall);
				if (result.selfCorrectionMessages) {
					selfCorrectionAcknowledgements.push(...result.selfCorrectionMessages);
				}
				if (result.spotlightTickTerminator) {
					spotlightTickTerminated = true;
						await this.dropPendingGeneratedProviderToolCalls(
							runId,
							requestEvent.seq,
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
							response.toolCalls,
							pendingToolCallIds,
							'iteration_limit',
					);
					break;
				}
			}
			if (toolFailureAcknowledgements.length > 0) {
				const acknowledgementContent = toolFailureAcknowledgements.join('\n\n');
				this.appendEvent(runId, 'assistant_message', {
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
				this.appendEvent(runId, 'assistant_message', {
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
		appendToolResultForToolCall?: (toolCall: ToolCall, toolMessage: ChatMessage, content: string) => void,
	): void {
		for (const toolCall of toolCalls) {
			if (!pendingToolCallIds.has(toolCall.id)) {
				continue;
			}
			pendingToolCallIds.delete(toolCall.id);
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
			if (appendToolResultForToolCall) {
				appendToolResultForToolCall(toolCall, toolMessage, content);
				continue;
			}
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
		maxCompletionTokens = providerContextCompletionReserveTokens,
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
				this.appendEvent(runId, 'provider_retry', {
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
				const retryKey = providerRetryKeyForAttempt(error, previousRetryKey);
				if (retryKey && attempt < providerMaxAttempts) {
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

	private compactionAttemptInputForError(input: {
		attemptState: CompactionAttemptRequestState;
		bot?: BotDocument;
		error: unknown;
		request: ProviderCompactionRequest;
		requestMessages: ChatMessage[];
		requestSettings: ProviderSettings;
	}): CompactionAttemptTransitionInput {
		const cause = runtimeErrorCause(input.error);
		if (input.error instanceof ProviderCompactionOutputLimitError) {
			return { kind: 'output_limit', cause };
		}
		const reasoningFailure = input.attemptState.reasoning.selection.kind === 'reasoning_disabled' &&
			input.attemptState.reasoning.runtimeFallback.kind === 'unknown_model'
			? this.unknownModelCompactionReasoningFailure(input.error, input.request)
			: null;
		if (reasoningFailure) {
			const reason = runtimeErrorText(input.error);
			this.rememberCompactionNoReasoningRejection(input.requestSettings, reason);
			return {
				kind: reasoningFailure.kind,
				cause,
				reason,
				reasoning: this.compactionReasoningForSettings(input.requestSettings),
			};
		}
		if (input.error instanceof ProviderStructuredOutputValidationError) {
			if (input.error.outputText && isNonReducingCompactionValidationError(input.error)) {
				return {
					kind: 'success_but_not_shorter',
					cause,
					canIsolate: Boolean(input.bot),
					outputText: input.error.outputText,
				};
			}
			if (input.error.outputText && isTranscriptLikeCompactionValidationError(input.error)) {
				return {
					kind: 'schema_invalid',
					cause,
					previousMessages: input.requestMessages,
					repairMessages:
						input.error.toolCalls.length > 0
							? structuredOutputRepairMessages(input.error)
							: [
									{ role: 'assistant', content: input.error.outputText },
									{ role: 'user', content: input.error.repairMessage },
								],
				};
			}
			return {
				kind: 'schema_invalid',
				cause,
				...(input.error.outputText ? { outputText: input.error.outputText } : {}),
				previousMessages: input.requestMessages,
				repairMessages: structuredOutputRepairMessages(input.error),
			};
		}
		const upstreamLimit = providerUpstreamRateLimitRetry(input.error);
		if (upstreamLimit) {
			const routing = providerRoutingWithIgnoredProvider(input.requestSettings.providerRouting, upstreamLimit.providerName);
			return {
				kind: 'transport_error',
				cause,
				...(routing.changed
					? {
							retry: {
								kind: 'upstream_provider_ignored' as const,
								providerRouting: routing.providerRouting,
								reason: providerIgnoreRetryReason(upstreamLimit),
							},
						}
					: {}),
			};
		}
		const retryKey = providerRetryKey(input.error);
		return {
			kind: 'transport_error',
			cause,
			...(retryKey
				? {
						retry: {
							kind: 'retry_key' as const,
							retryKey,
							delayMs: providerRetryDelayMsForAttempt(input.attemptState.providerAttempt + 1),
							reason: retryKey,
						},
					}
				: {}),
		};
	}

	private unknownModelCompactionReasoningFailure(
		error: unknown,
		request: ProviderCompactionRequest,
	): ReturnType<typeof classifyUnknownModelCompactionReasoningFailure> {
		if (!(error instanceof ProviderRequestError)) {
			return null;
		}
		return classifyUnknownModelCompactionReasoningFailure({
			body: error.body,
			providerError: error.providerError,
			requestIncludesOpenRouterServerTools: requestIncludesOpenRouterServerTools(request),
			status: error.status,
		});
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
		initialReasoning?: CompactionAttemptReasoningState,
	): Promise<
		Pick<ProviderResponse, 'usage' | 'responseId' | 'responseModel' | 'responseProviderName' | 'requestBody' | 'rawResponse'> & {
			compactionReasoning: CompactionAttemptReasoningState;
			content: string;
		}
	> {
		const endpoint = providerChatCompletionsUrl(settings.baseUrl);
		const effectiveProviderTools = providerTools ?? providerCompactionToolsForMode(limits, undefined, mode);
		let requestSettings = settings;
		let plan = CompactionAttemptPlan.start({
			initialReasoning: initialReasoning ?? this.compactionReasoningForSettings(settings),
			maxProviderAttempts: providerMaxAttempts,
			maxSchemaRepairAttempts: providerStructuredOutputRepairAttempts,
		});
		for (;;) {
			const attemptState = plan.request();
			this.throwIfStopped(runId, signal);
			if (attemptState.settingsPatch) {
				requestSettings = { ...requestSettings, ...attemptState.settingsPatch };
			}
			if (attemptState.retry) {
				const retryReason = compactionAttemptRetryReasonEvent(attemptState.retry.reason);
				this.appendEvent(runId, 'provider_retry', {
					attempt: attemptState.retry.attempt,
					maxAttempts: attemptState.retry.maxAttempts,
					delayMs: attemptState.retry.delayMs,
					reason: retryReason.text,
					compactionReasoning: compactionReasoningDiagnostic(attemptState.reasoning),
					...(retryReason.reasoningFallback ? { compactionReasoningFallback: retryReason.reasoningFallback } : {}),
				});
				if (attemptState.retry.delayMs > 0) {
					await sleep(attemptState.retry.delayMs, signal);
				}
			}
			const requestProviderTools = providerCompactionToolsForAttempt(limits, effectiveProviderTools, mode, attemptState.toolSet);
			const requestMessages = providerCompactionMessagesForAttempt(
				bot,
				messages,
				limits,
				mode,
				attemptState.messageSet,
				attemptState.reasoning.selection,
			);
			const request = providerCompactionRequest(
				requestSettings,
				requestMessages,
				limits,
				requestProviderTools,
				mode,
				providerCompactionReasoningForSelection(attemptState.reasoning.selection),
			);
			const body = stringifyProviderRequest(request);
			try {
				const response = await this.fetchProviderCompactionResponse(requestSettings, endpoint, body, signal, limits, mode);
				if (response.usage) {
					this.recordProviderTokenCalibrationSample({
						attempt: attemptState.calibrationAttempt,
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
				plan = plan.transition({ kind: 'success' });
				return {
					...response,
					compactionReasoning: attemptState.reasoning,
					requestBody: body,
				};
			} catch (error) {
				this.recordProviderTokenCalibrationSampleFromError({
					attempt: attemptState.calibrationAttempt,
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
				const input = this.compactionAttemptInputForError({
					attemptState,
					bot,
					error,
					request,
					requestMessages,
					requestSettings,
				});
				plan = plan.transition(input);
				if (plan.state.kind === 'terminal') {
					if (plan.state.terminal === 'paused_persistent_reduction_failure') {
						throw new PersistentCompactionReductionFailureError(
							plan.state.attempts,
							body,
							compactionReasoningDiagnostic(attemptState.reasoning),
							providerCompactionFailureResponseText(error),
						);
					}
					if (plan.state.terminal === 'failed') {
						throw new ProviderCompactionRequestError(
							error,
							body,
							compactionReasoningDiagnostic(attemptState.reasoning),
							providerCompactionFailureResponseText(error),
						);
					}
				}
			}
		}
	}

	private async consumeProviderResponse(
		runId: string,
		streamSeq: number,
		stream: ReadableStream<Uint8Array>,
		signal: AbortSignal,
		generationResponseId?: string,
	): Promise<ProviderResponse> {
		return consumeProviderSseResponse(
			runId,
			streamSeq,
			stream,
			signal,
			{
				stringValue,
				usageFromValue: providerUsageFromValue,
				metadataProviderName: openRouterMetadataProviderName,
				streamErrorFromChunk: providerStreamErrorFromChunk,
				normalizeReasoningDetails: normalizeReasoningDetailsForProviderHistory,
				reasoningTextFromDetails,
				repairInvalidUnicodeText,
				repairInvalidUnicodeValue,
				isAbortError,
				markProviderStreamActive: (activeRunId) => this.markProviderStreamActive(activeRunId),
				clearProviderStreamActive: (activeRunId) => this.clearProviderStreamActive(activeRunId),
				throwIfStopped: (activeRunId, activeSignal) => this.throwIfStopped(activeRunId, activeSignal),
				broadcastProviderDelta: (activeRunId, activeStreamSeq, payload) =>
					this.broadcastProviderDelta(activeRunId, activeStreamSeq, payload),
			},
			generationResponseId,
		);
	}

	private async appendProviderMessages(
		runId: string,
		response: ProviderResponse,
		status: ProviderMessageStatus,
		streamSeq: number,
	): Promise<void> {
		if (response.reasoning) {
			this.appendEvent(runId, 'reasoning_message', {
				content: response.reasoning,
				status,
				streamSeq,
			});
		}
		if (response.content) {
			this.appendEvent(runId, 'assistant_message', {
				content: response.content,
				status,
				streamSeq,
			});
		}
	}

	private appendDroppedProviderResponseAttempt(
		runId: string,
		response: ProviderResponse,
		streamSeq: number,
		dropped: readonly DroppedProviderToolCall[],
	): void {
		const message = providerResponseMessageForHistory(response);
		if (!message) {
			throw new Error('Malformed provider response did not contain a displayable assistant message.');
		}
		this.appendLoopMessageGroup([
			{
				runId,
				message,
				origin: 'dropped_provider_response',
				status: 'invalid',
				options: { streamSeq },
				extraLogs: [
					...(response.requestBody ? [{ kind: 'provider_request' as const, text: response.requestBody }] : []),
					{
						kind: 'provider_response',
						text: JSON.stringify(providerResponseLogPayload(response, 'invalid', dropped)),
					},
				],
			},
		]);
	}

	private async recordDroppedProviderToolCalls(
		runId: string,
		streamSeq: number | null,
		dropped: readonly DroppedProviderToolCall[],
		phase: 'generated_response',
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
		this.appendEvent(runId, 'provider_tool_call_dropped', {
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

	private recordRepairedProviderToolCalls(
		runId: string,
		streamSeq: number,
		repaired: readonly RepairedProviderToolCall[],
	): void {
		if (repaired.length === 0) {
			return;
		}
		this.appendEvent(runId, 'provider_tool_call_repaired', {
			runId,
			streamSeq,
			count: repaired.length,
			callIds: [...new Set(repaired.map((repair) => repair.id).filter(Boolean))],
			functionNames: [...new Set(repaired.map((repair) => repair.name).filter(Boolean))],
			reason: 'leaked_argument_fragment',
			phase: 'generated_response',
			repairs: repaired,
		});
	}

	private async dropGeneratedProviderToolCall(
		runId: string,
		streamSeq: number,
		toolCall: ToolCall,
		reason: ProviderToolCallDropReason,
	): Promise<void> {
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
		}
		if (dropped.length > 0) {
			await this.recordDroppedProviderToolCalls(runId, streamSeq, dropped, 'generated_response', false);
		}
	}

	private async appendSyntheticLimitLogOff(bot: BotDocument, runId: string, runContext: RunContext): Promise<void> {
		const args = syntheticLimitLogOffArgs(bot.language);
		const toolCall = syntheticToolCall(runId, 'log_off', this.hasRuntimeStorage() ? this.latestEventSeq() + 1 : 0, args);
		this.appendEvent(runId, 'assistant_message', {
			content: syntheticLimitLogOffContent,
			status: 'complete',
		});
		const result = await this.executeTool(bot, runId, 'log_off', args, runContext);
		const toolMessage: ChatMessage = {
			role: 'tool',
			tool_call_id: toolCall.id,
			content: JSON.stringify(result.providerResult),
		};
		this.appendLoopMessageGroup([
			{
				runId,
				message: {
					role: 'assistant',
					content: syntheticLimitLogOffContent,
					tool_calls: [toolCall],
				},
				origin: 'self_correction',
				status: 'complete',
			},
			{
				runId,
				message: toolMessage,
				origin: 'tool_result',
				status: 'complete',
				options: { displayEventSeq: result.displayEventSeq },
				extraLogs: [
					{ kind: 'tool_call', text: JSON.stringify(toolCall) },
					{ kind: 'tool_result', text: toolMessage.content ?? '' },
				],
			},
		]);
	}

	private runtimeMessageStore(): RuntimeMessageStore {
		return new RuntimeMessageStore(
			this.state.storage,
			(message) => this.broadcastLoopMessage(message),
			() => this.broadcastControl({ type: 'loop_messages_reset' }),
		);
	}

	private appendLoopMessage(
		runId: string,
		message: ChatMessage,
		origin: BotLoopMessageOrigin,
		status: BotLoopMessageStatus = 'complete',
		options: { streamSeq?: number; displayEventSeq?: number } = {},
	): BotLoopMessage {
		return this.runtimeMessageStore().appendLoopMessage(runId, message, origin, status, options);
	}

	private appendLoopMessageGroup(
		entries: LoopMessageGroupEntry[],
	): BotLoopMessage[] {
		const hasHarnessOverrides =
			Object.hasOwn(this, 'appendLoopMessage') || Object.hasOwn(this, 'insertLoopMessage') || Object.hasOwn(this, 'recordLoopMessageLog');
		if (hasHarnessOverrides || typeof (this as unknown as { state?: DurableObjectState }).state?.storage?.sql?.exec !== 'function') {
			const storage = (this as unknown as { state?: { storage?: { transactionSync?: <T>(closure: () => T) => T } } }).state?.storage;
			if (typeof storage?.transactionSync !== 'function') {
				return entries.map((entry) => {
					const inserted = this.appendLoopMessage(entry.runId, entry.message, entry.origin, entry.status, entry.options);
					for (const log of entry.extraLogs ?? []) {
						this.recordLoopMessageLog(inserted.seq, log.kind, log.text);
					}
					return inserted;
				});
			}
			const inserted: BotLoopMessage[] = [];
			this.runStorageTransactionSync(() => {
				for (const entry of entries) {
					const message = this.insertLoopMessage({
						runId: entry.runId,
						message: entry.message,
						origin: entry.origin,
						status: entry.status,
						streamSeq: entry.options?.streamSeq,
						displayEventSeq: entry.options?.displayEventSeq,
						broadcast: false,
					});
					this.recordLoopMessageLog(message.seq, 'message', JSON.stringify(entry.message));
					for (const log of entry.extraLogs ?? []) {
						this.recordLoopMessageLog(message.seq, log.kind, log.text);
					}
					inserted.push(message);
				}
			});
			for (const message of inserted) {
				this.broadcastLoopMessage(message);
			}
			return inserted;
		}
		return this.runtimeMessageStore().appendLoopMessageGroup(entries);
	}

	private recordTickFailure(
		runId: string,
		payload: Record<string, unknown>,
		logs: RuntimeFailureLog[] = [],
		options: { cause?: RuntimeErrorCause | string } = {},
	): BotRuntimeEvent {
		const cause = options.cause ?? stringValue(payload.message) ?? 'Unexpected Bickr visit error.';
		const message = ownerFacingRuntimeErrorMessage(cause) ?? 'Unexpected Bickr visit error.';
		this.markPendingCompactionEventsFailed(runId, message);
		const loopMessage = this.appendLoopMessage(
			runId,
			{
				role: 'user',
				content: runtimeErrorLoopMessageContent(cause),
			},
			'runtime_error',
		);
		for (const log of logs) {
			this.recordLoopMessageLog(loopMessage.seq, log.kind, log.text);
		}
		return this.appendEvent(runId, 'tick_failed', { ...payload, message });
	}

	private markPendingCompactionEventsFailed(runId: string, error: string): void {
		for (const event of this.runtimeEventsStore().pendingCompactionEvents(runId)) {
			this.replaceEventPayload(event, { ...runtimeRecord(event.payload), status: 'failed', error });
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
		return this.runtimeMessageStore().insertLoopMessage(input);
	}

	private broadcastLoopMessage(message: BotLoopMessage): void {
		this.broadcastControl({ type: 'loop_message', loopMessage: { ...message, hasLogs: true } });
	}

	private activeLoopMessageRows(): LoopMessageRow[] {
		return this.runtimeMessageStore().activeLoopMessageRows();
	}

	private nextLoopMessagePosition(): number {
		return this.runtimeMessageStore().nextLoopMessagePosition();
	}

	private activeLoopMessagesForProvider(): ChatMessage[] {
		return this.activeProviderHistoryLoopMessageRows().map(loopMessageChatMessageFromRow);
	}

	private activeProviderHistoryLoopMessageRows(): LoopMessageRow[] {
		return this.activeLoopMessageRows().filter((row) =>
			loopMessageContributesToProviderHistory(row.origin, loopMessageChatMessageFromRow(row)),
		);
	}

	private updateActiveLoopMessagePositions(seqOrder: readonly number[]): void {
		this.runtimeMessageStore().updateActiveLoopMessagePositions(seqOrder);
	}

	private loopMessagesAfter(afterSeq: number, initialLimit?: number): BotLoopMessage[] {
		return this.runtimeMessageStore().loopMessagesAfter(afterSeq, initialLimit);
	}

	private loopMessagesPage(input: { page: number; after?: number }): BotLoopMessagesResponse {
		return this.runtimeMessageStore().loopMessagesPage(input);
	}

	private latestActiveLoopCompactionBoundary(): { messageSeq: number; requestSeq: number; created_at: string } | null {
		return this.runtimeMessageStore().latestActiveLoopCompactionBoundary();
	}

	private loopMessageLogsForSeq(seq: number): BotLoopMessageLogsResponse {
		const response = this.runtimeMessageStore().loopMessageLogsForSeq(seq);
		const row = this.runtimeMessageStore().loopMessageRow(seq);
		if (!row) {
			throw new RepositoryError('not_found', 'Loop message was not found.', 404);
		}
		const requestUsage = row.stream_seq ? this.loopMessageRequestUsage(row.run_id, row.stream_seq) : undefined;
		const requestMessages = this.loopMessageRequestMessages(response.logs, requestUsage);
		return {
			...response,
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
		this.runtimeMessageStore().recordLoopMessageLog(messageSeq, kind, text);
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
		const messages = prepareInferenceSubmissionMessages(input.settings, input.messages).storedMessages;
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
		const currentModel = (await this.effectiveProviderSettings(bot, owner)).model;
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
			responseReserveTokens: providerContextCompletionReserveTokens,
		};
	}

	private async cachedPromptContextBudget(botId: string): Promise<BotContextBudget | null> {
		return this.promptContextBudgetForInput(botId, undefined, false);
	}

	private async promptContextBudget(botId: string, input: BotContextBudgetInput): Promise<BotContextBudget> {
		// Refused up front as well as at the write below: computing the budget bills
		// the owner for three provider probes, and a participant whose storage was
		// erased is one that no longer exists. The check at the write is what closes
		// the race; this one only keeps a request that already lost it from paying.
		this.requireWritableRuntimeStorage();
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
		const inferenceSettings = enforceInferenceModelAccess(currentBot.inferenceSettings, owner.inferenceSettings);
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
		const selectedConfiguration = input?.configurationId
			? await canonicalConfigurationInference(
				this.env.BICKR_D1, currentBot.ownerUserId, input.configurationId, this.env,
			)
			: null;
		if (input?.configurationId && !selectedConfiguration) {
			throw new InputError('Reusable inference configurations are not available for this account.');
		}
		const settings = selectedConfiguration?.providerSettings ?? await this.effectiveProviderSettings(bot, owner);
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
			supportsPrefill: settings.supportsPrefill === true,
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
			responseReserveTokens: providerContextCompletionReserveTokens,
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
				supportsPrefill: settings.supportsPrefill === true,
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

	private async readCommentTreeTokenBudget(bot: RuntimeBotDocument): Promise<number> {
		const owner = await userById(this.env.BICKR_KV, bot.ownerUserId);
		const settings = await this.effectiveProviderSettings(bot, owner);
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
		const worldPromptFingerprint = await sha256Hex(stringValue(bot.worldPrompt) ?? '');
		const cachedCounts = this.contextBudgetCachedCounts(
			await promptContextBudgetCacheFingerprint({
				botId: bot.id,
				compactionMode: settings.compactionMode ?? 'structured_output',
				effectiveModel: settings.model,
				fixedSystemFingerprint,
				personaPromptFingerprint,
				providerBaseUrl: settings.baseUrl,
				...(settings.providerRouting ? { providerRouting: settings.providerRouting } : {}),
				supportsPrefill: settings.supportsPrefill === true,
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
				responseReserveTokens: providerContextCompletionReserveTokens,
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
		// The counts come from provider probes, so the request parks on the network
		// between its own guards and this insert — long enough for a clear to land in
		// between. This cache lives in `runtime_state`, which makes writing it a
		// repopulation of erased storage like any other.
		this.requireWritableRuntimeStorage();
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
		throw providerRequestErrorFromBody(response.status, settings.model, endpoint, bodyText);
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
			throw providerRequestErrorFromBody(response.status, settings.model, endpoint, bodyText);
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
			throw providerRequestErrorFromBody(response.status, settings.model, endpoint, bodyText);
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

	private async effectiveProviderSettings(bot: BotDocument, owner: UserDocument): Promise<ProviderSettings> {
		return effectiveProviderSettingsForBotCanonical(this.env.BICKR_D1, bot, owner, this.env);
	}

	private async runLocalSimulation(
		bot: BotDocument,
		runId: string,
		input: { notifications: LoopNotification[]; ping: boolean },
		runContext: RunContext,
	): Promise<ProviderLoopOutcome> {
		this.throwIfStopped(runId, runContext.signal);
		const hot = await listHotThreads(this.env.BICKR_D1, bot.homeWorldId, 10);
		const replyTarget = hot.find((thread) => thread.authorBotId !== bot.id);
		// A welcoming notification means this is the participant's first iteration,
		// and only the payloads that carry a message can be one.
		const introducing = input.notifications.some((notification) =>
			(notification.kind === 'bootstrap' || notification.kind === 'legacy') &&
			stringValue(notification.message)?.includes('first time'),
		);
		if (replyTarget && !introducing) {
			this.throwIfStopped(runId, runContext.signal);
			this.appendLoopMessage(
				runId,
				{
					role: 'assistant',
					content: `I decide to reply to "${replyTarget.title}".`,
				},
				'local_simulation',
			);
			this.appendEvent(runId, 'assistant_message', {
				content: `I decide to reply to "${replyTarget.title}".`,
			});
			const result = await this.executeTool(
				bot,
				runId,
				'reply_to_comment',
				{
					commentId: replyTarget.rootCommentId,
					body: {
						lang: bot.language ?? ('en' as LanguageTag),
						text: `${localizedTextString(bot.displayName)} weighs in: ${localizedTextString(bot.shortBio)}`,
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
			this.appendEvent(runId, 'assistant_message', {
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
		this.appendEvent(runId, 'assistant_message', {
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
		bot: RuntimeBotDocument,
		runId: string,
		name: string,
		args: Record<string, unknown>,
		runContext: RunContext,
	): Promise<ToolResult> {
		const tools = new RuntimeTools({
			env: this.env,
			appendEvent: this.appendEvent.bind(this),
			replaceEventPayload: this.replaceEventPayload.bind(this),
			throwIfStopped: this.throwIfStopped.bind(this),
			forumService: this.forumService.bind(this),
			vectorSearchBots: (worldId, query, limit) => vectorSearchBots(this.env, worldId, query, limit),
			readCommentTreeTokenBudget: this.readCommentTreeTokenBudget.bind(this),
			providerContentInActiveContext: this.providerContentInActiveContext.bind(this),
			recentToolResultRows: () =>
				this.state.storage.sql
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
					.toArray(),
			setLastSuccessfulLogOffSeq: (seq) => this.setLastSuccessfulLogOffSeq(seq, 'tool_result'),
		});
		return tools.executeTool(bot, runId, name, args, runContext);
	}

	private async forumService<T>(path: string, botId: string, body: unknown, signal: AbortSignal): Promise<T> {
		return withAbortableTimeout(
			signal,
			serviceBindingTimeoutMs,
			() => new RuntimeOperationTimeoutError('The Bickr page request', serviceBindingTimeoutMs),
			async (timeoutSignal) => {
				const headers = new Headers({
					'content-type': 'application/json',
					'x-bickr-bot-id': botId,
				});
				addInternalServiceAuthHeader(headers, this.env.INTERNAL_SERVICE_SECRET);
				const response = await this.env.FORUM_COORDINATOR_SERVICE.fetch(
					new Request(internalServiceUrl(path), {
						method: 'POST',
						signal: timeoutSignal,
						headers,
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
				return payload.data as T;
			},
		);
	}

	private async buildMessages(
		bot: RuntimeBotDocument,
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
		const recurringPrompt = effectiveLoopRecurringPrompt(bot);
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
		bot: RuntimeBotDocument,
		runId: string,
		notifications: LoopNotification[],
		existingProfileUsernames: ReadonlySet<string>,
		existingProviderContent: ProviderContextContentScope,
	): Promise<string[]> {
		const toolCalls: ToolCall[] = [syntheticToolCall(runId, 'check_notifications', 0, {})];
		const providerContext = providerSerializationContext({ botId: bot.id }, cloneProviderContextContentScope(existingProviderContent));
		const notificationTokenBudget = notifications.length > 0 ? await this.readCommentTreeTokenBudget(bot) : undefined;
		const notificationResult = providerCheckNotificationsResultWithInclusions(notifications, providerContext, notificationTokenBudget);
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
					providerToolResultPayload('view_profiles', { profiles }, {}, providerSerializationContext({ botId: bot.id }), {
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
		bot: RuntimeBotDocument,
		runId: string,
		contexts: SpotlightSyntheticContext[],
		existingProfileUsernames: ReadonlySet<string>,
		existingProviderContent: ProviderContextContentScope,
	): Promise<void> {
		const chains = contexts.flatMap(spotlightSyntheticToolChains);
		const toolCalls: ToolCall[] = chains.map((chain, index) => syntheticToolCall(runId, chain.toolName, index, chain.args));
		const providerContext = providerSerializationContext({ botId: bot.id }, cloneProviderContextContentScope(existingProviderContent));
		const tokenBudget = await this.readCommentTreeTokenBudget(bot);
		const results: ChatMessage[] = chains.map((chain, index) => ({
			role: 'tool',
			tool_call_id: toolCalls[index]?.id ?? syntheticToolCallId(runId, index),
			content: JSON.stringify(
				spotlightReadResult(chain.context, chain.toolName, providerContext, tokenBudget, chain.targetCommentId, chain.targetThreadId),
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
				content: JSON.stringify(
					providerToolResultPayload('view_profiles', { profiles }, {}, providerSerializationContext({ botId: bot.id })),
				),
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
		const entries: LoopMessageGroupEntry[] = [];
		for (let index = 0; index < toolCalls.length; index += 1) {
			const toolCall = toolCalls[index]!;
			entries.push({
				runId,
				message: {
					role: 'assistant',
					content: index === 0 ? firstAssistantContent : null,
					tool_calls: [toolCall],
				},
				origin,
				status,
			});
			const result = results[index];
			if (result) {
				entries.push({
					runId,
					message: result,
					origin,
					status,
				});
			}
		}
		this.appendLoopMessageGroup(entries);
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
		return botProfileRelationshipSummaries(this.env.BICKR_D1, bot.id, profiles);
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
		const rows = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE seq > ?
				   AND type = 'provider_tool_call_dropped'
				 ORDER BY seq DESC
				 LIMIT 50`,
				lastLogOffSeq,
			)
			.toArray();
		return rows.some((row) => {
			try {
				return providerToolCallDropPayloadHasReason(runtimeRecord(JSON.parse(row.payload_json)), 'premature_log_off');
			} catch {
				return false;
			}
		});
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
		const stored = this.lastLogOffSeqFromState();
		if (stored !== undefined) {
			return stored;
		}
		const seq = this.backfillLatestSuccessfulLogOffToolResultSeq();
		this.setLastSuccessfulLogOffSeq(seq, 'lazy_backfill');
		return seq;
	}

	private lastLogOffSeqFromState(): number | undefined {
		const value = this.runtimeStateValue(lastLogOffSeqStateKey);
		if (value === undefined) {
			return undefined;
		}
		const seq = typeof value === 'number' ? value : integerValue(runtimeRecord(value).seq);
		return seq === undefined ? undefined : Math.max(0, Math.floor(seq));
	}

	private setLastSuccessfulLogOffSeq(seq: number, source: 'tool_result' | 'lazy_backfill'): void {
		this.setRuntimeState(lastLogOffSeqStateKey, {
			seq: Math.max(0, Math.floor(seq)),
			source,
			updatedAt: new Date().toISOString(),
		});
	}

	private backfillLatestSuccessfulLogOffToolResultSeq(): number {
		// The unpaged form of this scan materialized every tool_result payload
		// via one toArray() and OOM-reset large DOs on every tick (2026-07-11
		// incident, ~35k-event bots). The LIKE clause is a performance
		// prefilter only — each candidate is still verified by parsing — and
		// paging bounds peak memory regardless of history size.
		let beforeSeq = Number.MAX_SAFE_INTEGER;
		for (;;) {
			const rows = this.state.storage.sql
				.exec<{ seq: number; payload_json: string }>(
					`SELECT seq, payload_json
					 FROM events
					 WHERE type = 'tool_result'
					   AND seq < ?
					   AND payload_json LIKE '%"name":"log_off"%'
					 ORDER BY seq DESC
					 LIMIT ${logOffBackfillPageSize}`,
					beforeSeq,
				)
				.toArray();
			for (const row of rows) {
				const payload = runtimeRecord(JSON.parse(row.payload_json));
				if (canonicalToolName(stringValue(payload.name) ?? '') === 'log_off' && successfulToolResultPayload(payload)) {
					return row.seq;
				}
			}
			if (rows.length < logOffBackfillPageSize) {
				return 0;
			}
			beforeSeq = rows[rows.length - 1]?.seq ?? 0;
		}
	}

	private pruneRuntimeStorageAfterTick(activeRunId: string, now = new Date()): RuntimeStorageRetentionResult {
		const { events, providerUsage } = this.pruneExpiredEventsAndProviderUsage(activeRunId, now);

		// Loop history is the object's largest store, so its retention rides the
		// same post-visit pass as events and usage — one batch per run, with the
		// daily fleet sweep behind it for participants that stopped ticking.
		const loopMessages = this.runtimeMessageStore().pruneExpiredLoopMessages({
			now,
			limit: postTickLoopMessageRetentionLimit,
		});
		const injections = this.spotlightTickQueue().pruneExpiredInjections({ now });

		return { events, providerUsage, loopMessages, injections };
	}

	private pruneExpiredEventsAndProviderUsage(activeRunId: string, now: Date): { events: number; providerUsage: number } {
		const lastLogOffSeq = this.latestSuccessfulLogOffToolResultSeq();
		const events = this.runtimeEventsStore().pruneEventsAfterTick(activeRunId, lastLogOffSeq, now);

		const usageCutoff = new Date(now.getTime() - botInferenceUsageRetentionDays * dayMs).toISOString();
		const exportCursor = this.centralProviderUsageExportCursor();
		let providerUsage = 0;
		if (exportCursor > 0) {
			this.state.storage.sql.exec(
				`DELETE FROM provider_usage
				 WHERE created_at < ?
				   AND id <= ?
				   AND run_id != ?`,
				usageCutoff,
				exportCursor,
				activeRunId,
			);
			providerUsage = this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
		}
		return { events, providerUsage };
	}

	/**
	 * Retention for one participant, driven by the daily fleet sweep. The visit
	 * path prunes the same way, but a paused, disabled, or rarely scheduled
	 * participant never reaches it.
	 *
	 * Unlike the visit path, this one spends a whole sweep allowance, so the
	 * loop-message prune runs as repeated short batches under a wall-clock budget
	 * of its own (§2.4). A pass that hits either bound is a partial success: it
	 * answers with what it deleted rather than letting its caller time out and
	 * count committed work as a failure.
	 */
	private runRetentionPass(activeRunId: string | null, now = new Date()): RuntimeStorageRetentionResult {
		// Erased storage has nothing left to prune, and the pass is not read-only: it
		// memoizes the last log-off sequence into `runtime_state` on its first run,
		// which on a cleared object would be a repopulating write. The sweep can
		// still reach this route for a participant cleared after its chunk was
		// picked, so the answer is an empty pass rather than a conflict — nothing
		// failed, there was simply nothing there.
		if (this.runtimeStorageClearedAt) {
			return {
				events: 0,
				providerUsage: 0,
				loopMessages: { deletedMessages: 0, deletedLogs: 0, stampedSummaries: 0, pendingMore: false },
				injections: { deletedInjections: 0, droppedQueueEntries: 0 },
			};
		}
		// Events, usage, and injections are bounded single passes rather than backlog
		// drains, so they run once ahead of the loop instead of competing with it for
		// the budget.
		//
		// A run in flight keeps its own rows exempt exactly as the post-visit pass
		// does. With no run there is nothing to exempt, and the empty string cannot
		// collide: every run id is a generated non-empty value.
		const { events, providerUsage } = this.pruneExpiredEventsAndProviderUsage(activeRunId ?? '', now);
		const injections = this.spotlightTickQueue().pruneExpiredInjections({ now });
		const { loopMessages, timeBudgetExhausted } = this.runtimeMessageStore().pruneExpiredLoopMessagesWithinBudget({
			now,
			rowAllowance: sweepLoopMessageRetentionLimit,
			timeBudgetMs: sweepRetentionTimeBudgetMs,
		});
		return {
			events,
			providerUsage,
			loopMessages,
			injections,
			...(timeBudgetExhausted ? { timeBudgetExhausted } : {}),
		};
	}

	/**
	 * Erase this object's whole storage.
	 *
	 * Deleting a participant leaves its runtime object behind, holding the whole
	 * inner loop forever (design §2.4). The bot-delete lifecycle and the sweep's
	 * backlog pass both come through here; the caller stamps
	 * `bot_runtime_index.runtime_storage_cleared_at` only after this returns, so a
	 * failed clear is retried instead of being marked done.
	 *
	 * `deleteAll` rather than a table-by-table delete: it drops the object's
	 * private SQLite database outright, which is what actually returns the pages to
	 * Cloudflare instead of leaving them as free space inside a file that is still
	 * billed at its high-water mark. The schema is then rebuilt empty, so this live
	 * instance and anything that reaches it later still find their tables.
	 */
	private async clearRuntimeStorage(botId: string): Promise<RuntimeStorageClearResult> {
		await this.beginMaintenanceOperation(botId, 'clear_storage', 'Cannot clear runtime storage while the bot is running.');
		try {
			const deletedRowsByTable = this.state.storage.transactionSync(() => {
				const counted: Record<string, number> = {};
				// Table names come from this module's own schema text, never from input.
				for (const table of runtimeStorageTables) {
					counted[table] = this.state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count;
				}
				return counted;
			});
			// Set before the first await, and never unset. From here on every mutation
			// path refuses, which covers both the window where the tables do not exist
			// and the far longer window afterwards: `deleteAll` leaves storage
			// indistinguishable from a new object's, while the caller is about to stamp
			// `runtime_storage_cleared_at` and permanently exclude this participant from
			// the sweep. A clear that failed halfway stays refused for the same reason —
			// the object belongs to a participant that is already gone, so there is
			// nothing legitimate left to write and the retry re-runs this whole method.
			this.runtimeStorageClearedAt = new Date().toISOString();
			await this.state.storage.deleteAll();
			this.initializeRuntimeStorage();
			this.setRuntimeState(runtimeStorageClearedStateKey, this.runtimeStorageClearedAt);
			this.broadcastControl({ type: 'history_cleared', botId });
			// An accepted monitor socket can inject, so leaving one open would leave a
			// writer holding a reference to storage that must never be written again.
			// The refusal above already covers it; closing is what tells the client.
			this.closeMonitorSockets();
			return {
				deletedRowsByTable,
				deletedRows: Object.values(deletedRowsByTable).reduce((total, count) => total + count, 0),
				clearedAt: this.runtimeStorageClearedAt,
			};
		} finally {
			this.finishMaintenanceOperation('clear_storage');
		}
	}

	/**
	 * Refuse a write to storage a full clear has already erased.
	 *
	 * Every mutation path calls this immediately before its own write, with no
	 * await in between, so the answer cannot go stale between the check and the
	 * insert. The rejection is a typed conflict rather than a not-found: the
	 * caller's request was well formed and reached the right object, and the
	 * typed cause tells it the state is terminal rather than transient.
	 */
	private requireWritableRuntimeStorage(): void {
		// Truthiness, not a null check: the tombstone is always a non-empty
		// timestamp, and the same tolerance the other storage helpers show for a
		// prototype-built instance without initialized fields applies here.
		if (!this.runtimeStorageClearedAt) {
			return;
		}
		throw new RepositoryError(
			'conflict',
			'This participant’s runtime storage has been erased and cannot accept new activity.',
			409,
			{ runtimeStorageCause: 'storage_cleared' },
		);
	}

	private closeMonitorSockets(): void {
		const sockets = typeof this.state.getWebSockets === 'function' ? this.state.getWebSockets() : [];
		for (const socket of sockets) {
			try {
				socket.close(1001, 'Runtime storage was erased.');
			} catch (error) {
				console.warn('bot runtime monitor socket close failed', error);
			}
		}
	}

	private latestCompactionSummary(): string {
		return this.runtimeEventsStore().latestCompactionSummary(compactedSummaryForContext);
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

	/**
	 * Record a private thought for the next visit.
	 *
	 * A spotlight injection is idempotent in its `spotlightId`: the sender may
	 * retry a batch whose response was lost, and this object is single-threaded,
	 * so the existing row decides. Whether an injection already exists is
	 * knowable only here — the sender's own delivery row can be behind — which
	 * makes this the authority for "was this participant already told".
	 */
	private injectThought(text: string, metadata: InjectionMetadata = {}): { event: BotRuntimeEvent | null; injectionId: string } {
		// The single choke point for both writers that can reach an erased object:
		// the HTTP `/inject` route, whose guards it may have passed before the clear,
		// and a monitor socket accepted before it. This method is synchronous from
		// here to its insert, so the check and the write cannot be separated.
		this.requireWritableRuntimeStorage();
		if (metadata.spotlightId) {
			const existing = this.state.storage.sql
				.exec<{ id: string }>(`SELECT id FROM injections WHERE spotlight_id = ? LIMIT 1`, metadata.spotlightId)
				.toArray()[0];
			if (existing) {
				return { event: null, injectionId: existing.id };
			}
		}
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
		const event = this.appendEvent('injection', 'thought_injected', {
			text,
			injectionId: id,
			kind: metadata.kind ?? 'manual',
			...(metadata.sourceId ? { sourceId: metadata.sourceId } : {}),
			...(metadata.spotlightId ? { spotlightId: metadata.spotlightId } : {}),
		});
		return { event, injectionId: id };
	}

	private async compactIfNeeded(bot: BotDocument, settings: ProviderSettings, runId: string, signal: AbortSignal): Promise<void> {
		await this.maybeCompact(bot, settings, runId, signal, { reason: 'threshold' });
	}

	private async ensureProviderPromptWithinBudget(
		bot: BotDocument,
		settings: ProviderSettings,
		runId: string,
		signal: AbortSignal,
		providerTools: ProviderToolDefinition[],
	): Promise<ProviderPromptBudgetCheck> {
		const result = await this.maybeCompact(bot, settings, runId, signal, { reason: 'prompt_budget', providerTools });
		if (!result) {
			throw new Error('Prompt-budget compaction finished without a budget check.');
		}
		return result;
	}

	private async maybeCompact(
		bot: BotDocument,
		settings: ProviderSettings,
		runId: string,
		signal: AbortSignal,
		options: { reason: 'threshold' } | { reason: 'prompt_budget'; providerTools: ProviderToolDefinition[] },
	): Promise<ProviderPromptBudgetCheck | null> {
		let providerTools = options.reason === 'prompt_budget' ? options.providerTools : undefined;
		let compactionAttempts = 0;
		for (;;) {
			if (options.reason === 'prompt_budget') {
				this.throwIfStopped(runId, signal);
			}
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
			const thresholdContextEstimate = options.reason === 'threshold' ? this.currentCompactionContextEstimate(settings.model) : null;
			const limits = thresholdContextEstimate
				? this.compactionSummaryLimitsForRows(
						budgetBot,
						thresholdContextEstimate.rows.map((item) => item.row),
						thresholdContextEstimate.calibration,
						providerTools,
						compactionMode,
						requestContextWindowTokens,
					)
				: providerCompactionSummaryLimitsForChat(
						budgetBot,
						requestMessages.slice(1),
						calibration,
						providerTools,
						compactionMode,
						requestContextWindowTokens,
					);
			const allowedPromptTokens = limits.nextCompactionTokens;
			const estimate = this.estimateProviderPromptTokens(settings, requestMessages, providerTools);
			const overBudgetTokens = Math.max(0, estimate.promptTokens - allowedPromptTokens);
			const maxCompletionTokens = providerLoopMaxCompletionTokens(requestContextWindowTokens, estimate.promptTokens);
			if (options.reason === 'prompt_budget') {
				this.appendEvent(runId, 'provider_token_estimate', {
					model: settings.model,
					messageCount: requestMessages.length,
					toolCount: providerTools.length,
					contextWindowTokens: requestContextWindowTokens,
					maxCompletionTokens,
					compactionMaxCompletionTokens: limits.maxCompletionTokens,
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
			}
			if (overBudgetTokens === 0) {
				return options.reason === 'prompt_budget'
					? {
							allowedPromptTokens,
							contextWindowTokens: requestContextWindowTokens,
							maxCompletionTokens,
							promptTokens: estimate.promptTokens,
							providerTools,
							requestMessages,
						}
					: null;
			}
			if (options.reason === 'prompt_budget' && compactionAttempts >= providerPromptCompactionMaxAttempts) {
				throw new PromptContextCompactionLimitError(estimate.promptTokens, allowedPromptTokens, providerPromptCompactionMaxAttempts);
			}
			const compactionSelection =
				options.reason === 'threshold'
					? {
							rows: this.compactionRowsForEstimatedBudget(
								budgetBot,
								providerTools,
								compactionMode,
								requestContextWindowTokens,
								settings.model,
							),
							overBudgetFallback: false,
						}
					: this.compactionRowSelectionForEstimatedBudget(
							budgetBot,
							providerTools,
							compactionMode,
							requestContextWindowTokens,
							settings.model,
							{ requireMinimumSelectedTokens: false },
						);
			const rowsToCompact = compactionSelection.rows;
			if (rowsToCompact.length === 0) {
				if (options.reason === 'threshold') {
					return null;
				}
				throw new PromptContextBudgetExceededError(estimate.promptTokens, allowedPromptTokens);
			}
			compactionAttempts += 1;
			await this.compactLoopMessageRows(budgetBot, settings, runId, signal, rowsToCompact, 'auto', {
				compactionMaxCharacters: limits.maxLength,
				compactionMaxCompletionTokens: limits.maxCompletionTokens,
				estimatedPromptTokens: estimate.promptTokens,
				threshold: allowedPromptTokens,
				...(options.reason === 'threshold' && thresholdContextEstimate ? { estimatedContextTokens: thresholdContextEstimate.totalTokens } : {}),
				...(options.reason === 'prompt_budget' ? { allowedPromptTokens, overBudgetTokens } : {}),
				...(options.reason === 'prompt_budget' && compactionSelection.overBudgetFallback ? { compactionOverBudgetFallback: true } : {}),
			});
			if (options.reason === 'threshold') {
				return null;
			}
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
		const preparedMessages = prepareInferenceSubmissionMessages(settings, requestMessages);
		requestMessages = preparedMessages.requestMessages;
		const baseline = this.latestCompatiblePromptTokenBaseline(settings, preparedMessages.storedMessages);
		if (baseline) {
			const deltaMessages = preparedMessages.storedMessages.slice(baseline.messages.length);
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
		options: CompactionSelectionOptions<LoopMessageRow> = {},
	): LoopMessageRow[] {
		const input = this.compactionSelectionInputForEstimatedBudget(
			bot,
			providerTools,
			mode,
			contextWindowTokens,
			requestedModel,
			options,
		);
		return compactionRowsForEstimatedBudget(input.rows, input.limitTokens, input.options);
	}

	private compactionRowSelectionForEstimatedBudget(
		bot: BotDocument,
		providerTools?: ProviderToolDefinition[],
		mode: ProviderCompactionMode = 'structured_output',
		contextWindowTokens?: number,
		requestedModel?: string,
		options: CompactionSelectionOptions<LoopMessageRow> = {},
	): CompactionRowSelection<LoopMessageRow> {
		const input = this.compactionSelectionInputForEstimatedBudget(
			bot,
			providerTools,
			mode,
			contextWindowTokens,
			requestedModel,
			options,
		);
		return compactionRowSelectionForEstimatedBudget(input.rows, input.limitTokens, input.options);
	}

	private compactionSelectionInputForEstimatedBudget(
		bot: BotDocument,
		providerTools?: ProviderToolDefinition[],
		mode: ProviderCompactionMode = 'structured_output',
		contextWindowTokens?: number,
		requestedModel?: string,
		options: CompactionSelectionOptions<LoopMessageRow> = {},
	) {
		const calibration = this.textTokenCalibration(requestedModel);
		const rows = this.compactionCandidateEstimates(calibration);
		return {
			rows,
			limitTokens: this.compactionPromptTokenLimit(
				bot,
				rows.map((item) => item.row),
				calibration,
				providerTools,
				mode,
				contextWindowTokens,
			),
			options: {
				canIncludeRows: (selectedRows: readonly LoopMessageRow[]) =>
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
		};
	}

	private async manualCompactLoopMessages(botId: string): Promise<{ fromSeq?: number; toSeq?: number; messageCount: number }> {
		await this.beginMaintenanceOperation(botId, 'manual_compaction', 'Cannot compact loop history while the bot is running.');
		try {
			const bot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
			const owner = await userById(this.env.BICKR_KV, bot.ownerUserId);
			const settings = await this.effectiveProviderSettings(bot, owner);
			const runId = crypto.randomUUID();
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
			const selection = compactionRowSelectionForEstimatedBudget<LoopMessageRow>(
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
					compactionReasoning: CompactionAttemptReasoningState;
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
			const compactionReasoning = this.compactionReasoningForSettings(settings);
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
			const compactionMessages = providerCompactionMessages(
				bot,
				compactedMessages,
				baseLimits,
				compactionTools,
				compactionMode,
				compactionReasoning.selection,
			);
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
				compactionReasoning: compactionReasoningDiagnostic(compactionReasoning),
				...(outputLimitShrinkAttempts > 0 ? { outputLimitShrinkAttempts } : {}),
				...(overBudgetFallback ? { overBudgetFallback: true } : {}),
			};
			if (!summaryEvent) {
				summaryEvent = this.appendEvent(runId, 'compaction', {
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
							compactionReasoning,
						)
					: {
							compactionReasoning,
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
				const failedReasoning = failedCompactionReasoningDiagnostic(error);
				this.replaceEventPayload(summaryEvent, {
					...compactionEventPayload,
					...(failedReasoning ? { compactionReasoning: failedReasoning } : {}),
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
			compactionReasoning: compactionReasoningDiagnostic(response.compactionReasoning),
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
		rows: CompactionCandidateEstimate<LoopMessageRow>[];
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

	private compactionCandidateEstimates(calibration = this.textTokenCalibration()): CompactionCandidateEstimate<LoopMessageRow>[] {
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

	private runtimeEventsStore(): RuntimeEventsStore {
		return new RuntimeEventsStore(this.state.storage, (event) => this.broadcast(event));
	}

	private appendEvent(runId: string, type: BotRuntimeEventType, payload: unknown): BotRuntimeEvent {
		return this.runtimeEventsStore().appendEvent(runId, type, payload);
	}

	private replaceEventPayload(event: BotRuntimeEvent, payload: unknown): BotRuntimeEvent {
		return this.runtimeEventsStore().replaceEventPayload(event, payload);
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
		const messageStore = this.runtimeMessageStore();
		const row = messageStore.loopMessageRow(seq);
		if (!row) {
			throw new RepositoryError('not_found', 'Loop message was not found.', 404);
		}
		const current = await this.readStatus(botId);
		if (current.status === 'running' && current.activeRunId === row.run_id) {
			throw new RepositoryError('conflict', 'Cannot delete a message from the currently running tick.', 409);
		}
		const deleted = messageStore.softDeleteLoopMessage(seq);
		if (!deleted) {
			throw new RepositoryError('not_found', 'Loop message was not found.', 404);
		}
		const { deletedAt } = deleted;
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
		const current = await this.readStatus(botId);
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

	private eventsAfter(afterSeq: number, initialLimit?: number): BotRuntimeEvent[] {
		return this.runtimeEventsStore().eventsAfter(afterSeq, initialLimit);
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

	private async runtimeStatusIndexRow(botId: string): Promise<RuntimeStatusIndexRow | null> {
		return this.env.BICKR_D1.prepare(
			`SELECT
				enabled,
				status,
				active_run_id AS activeRunId,
				active_run_trigger AS activeRunTrigger,
				lease_expires_at AS leaseExpiresAt,
				next_due_at AS nextDueAt,
				last_error AS lastError,
				tick_interval_seconds AS tickIntervalSeconds
			 FROM bot_runtime_index
			 WHERE bot_id = ?`,
		)
			.bind(botId)
			.first<RuntimeStatusIndexRow>();
	}

	private async readStatus(botId: string): Promise<BotRuntimeStatus> {
		const row = await this.runtimeStatusIndexRow(botId);
		const enabled = row?.enabled === 1;
		return {
			botId,
			enabled,
			status: row?.status ?? 'idle',
			...(row?.activeRunId ? { activeRunId: row.activeRunId } : {}),
			...(enabled && row?.nextDueAt ? { nextDueAt: row.nextDueAt } : {}),
			...(row?.lastError ? { lastError: row.lastError } : {}),
		};
	}

	private async reapStaleRun(botId: string): Promise<boolean> {
		const row = await this.runtimeStatusIndexRow(botId);
		if (row?.status !== 'running') {
			return false;
		}
		// Every branch must win the D1 ownership transition before changing the
		// local event stream. The active_run_id CAS makes concurrent reapers
		// idempotent and leaves exactly one winner to append a terminal event.
		const enabled = row.enabled === 1;
		const runId = row.activeRunId;
		// Reaping is a release like any other, so the run's recorded trigger decides
		// the schedule here too: a spotlight visit that was stopped or ran past its
		// lease must leave the participant's own rhythm where it found it. Proposing
		// nothing is what preserves it (see releaseRuntimeRun).
		const keepsStandingSchedule = runKeepsStandingSchedule(recordedRunTrigger(row.activeRunTrigger));
		const rescheduleAfterReap = (now: string): string | null =>
			enabled && !keepsStandingSchedule ? new Date(Date.parse(now) + row.tickIntervalSeconds * 1000).toISOString() : null;
		if (runId && this.hasStopRequest(runId) && this.activeRunId !== runId) {
			const now = new Date().toISOString();
			const nextDueAt = rescheduleAfterReap(now);
			const reaped = await releaseRuntimeRun(this.env.BICKR_D1, {
				botId,
				runId,
				status: 'idle',
				nextDueAt,
				lastError: null,
				now,
			});
			if (!reaped) {
				return false;
			}
			this.markPendingCompactionEventsFailed(runId, 'This Bickr visit was stopped.');
			if (!this.hasTerminalEvent(runId)) {
				this.appendEvent(runId, 'tick_stopped', { message: 'This Bickr visit was stopped.' });
			}
			this.clearStopRequest(runId);
			return true;
		}

		if (runId) {
			const stale = this.staleProviderStream(runId);
			if (stale) {
				const message = `The Bickr page stopped responding after ${Math.round(providerStreamIdleTimeoutMs / 1000)} seconds.`;
				const reaped = await releaseRuntimeRun(this.env.BICKR_D1, {
					botId,
					runId,
					status: 'failed',
					// Proposing nothing is not the same as proposing what the row said
					// when this reaper read it: the snapshot is already stale by the time
					// the release lands, so re-writing it would clobber whatever an owner
					// scheduled in between with a value that visit had no business owning.
					// A spotlight never owned the standing schedule at all, so it always
					// falls through to the column.
					nextDueAt: keepsStandingSchedule ? null : row.nextDueAt,
					lastError: message,
					now: new Date().toISOString(),
				});
				if (!reaped) {
					return false;
				}
				if (!this.hasTerminalEvent(runId)) {
					this.recordTickFailure(runId, {
						message,
						lastEventType: stale.type,
						lastEventAt: stale.created_at,
					});
				}
				if (this.activeRunId === runId) {
					this.setStopRequest(runId);
					if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
						this.activeAbortController.abort();
					}
					this.activeRunId = null;
					this.activeAbortController = null;
				}
				return true;
			}
		}

		if (!row.leaseExpiresAt || Date.parse(row.leaseExpiresAt) > Date.now()) {
			return false;
		}
		const message = 'This Bickr visit took too long and closed before completion.';
		const now = new Date().toISOString();
		const nextDueAt = rescheduleAfterReap(now);
		const reaped = await releaseRuntimeRun(this.env.BICKR_D1, {
			botId,
			runId,
			status: 'idle',
			nextDueAt,
			lastError: message,
			now,
		});
		if (!reaped) {
			return false;
		}
		if (runId && !this.hasTerminalEvent(runId)) {
			this.recordTickFailure(runId, {
				message,
				leaseExpiresAt: row.leaseExpiresAt,
			});
		}
		if (
			runId &&
			this.activeRunId === runId &&
			this.activeAbortController &&
			!this.activeAbortController.signal.aborted
		) {
			this.setStopRequest(runId);
			this.activeAbortController.abort();
		}
		return true;
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

	// Releasing a run this instance owns is the only index transition left here:
	// admission is claimRuntimeRun's compare-and-set, so a `running` transition is
	// deliberately unrepresentable in this signature, and the run id is required so
	// every write goes through releaseRuntimeRun's ownership CAS. Keeping one
	// writer is what keeps the concurrent-pause guard in a single statement instead
	// of two copies that can drift apart.
	private async setRuntimeIndex(
		bot: BotDocument,
		status: RuntimeReleaseStatus,
		lastError: string | undefined,
		now: string,
		ownedByRunId: string,
		trigger: RuntimeRunTrigger,
	): Promise<string | null> {
		const enabled = await this.runtimeIndexEnabled(bot.id, bot.tickSettings.enabled);
		// A participant read as paused proposes nothing; releaseRuntimeRun decides
		// what that means for a row whose `enabled` moved since this read. A run that
		// keeps the standing schedule proposes nothing either, however it ended: a
		// spotlight failure is a failure of the interruption, not of the
		// participant's own rhythm, so it must not move the next organic visit. A
		// failed ordinary run waits out a lease timeout rather than the
		// participant's own interval.
		let nextDueAt: string | null;
		if (!enabled || runKeepsStandingSchedule(trigger)) {
			nextDueAt = null;
		} else if (status === 'idle') {
			nextDueAt = this.nextDue(bot, now);
		} else {
			nextDueAt = new Date(Date.parse(now) + runtimeRunLeaseTimeoutMs).toISOString();
		}
		await releaseRuntimeRun(this.env.BICKR_D1, {
			botId: bot.id,
			runId: ownedByRunId,
			status,
			nextDueAt,
			lastError: lastError ?? null,
			now,
		});
		// The returned value stays the proposed schedule, which only annotates a
		// runtime event; the row the write reconciled remains the authority
		// readStatus reports from.
		return nextDueAt;
	}

	private async pauseBotAfterPersistentCompactionFailure(bot: BotDocument, message: string, now: string): Promise<void> {
		const headers = new Headers({
			'content-type': 'application/json',
			'idempotency-key': `runtime-pause:${bot.id}:${now}`,
			'x-bickr-user-id': bot.ownerUserId,
			'x-bickr-scheduler': '1',
		});
		addInternalServiceAuthHeader(headers, this.env.INTERNAL_SERVICE_SECRET);
		const coordinatorId = this.env.USER_BOTS.idFromName(bot.ownerUserId);
		const response = await this.env.USER_BOTS.get(coordinatorId).fetch(new Request(
			internalServiceUrl(`/users/${encodeURIComponent(bot.ownerUserId)}/bots/${encodeURIComponent(bot.id)}`),
			{
				method: 'PATCH',
				headers,
				body: JSON.stringify({ tickSettings: { enabled: false } }),
			},
		));
		if (!response.ok) {
			console.warn('failed to persist participant pause after compaction reduction failure', bot.id, message, response.status);
			throw new RepositoryError('server_error', 'Participant pause coordinator request failed.', response.status || 500);
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

	/**
	 * Maintenance routes are reachable only by this deployment's own schedulers
	 * and lifecycle operations. `fetch` has already established that the request
	 * carries the internal service secret; this additionally refuses a request
	 * forwarded on an owner's behalf, which no owner route ever sets.
	 */
	private requireInternalMaintenance(request: Request): void {
		if (request.headers.get('x-bickr-scheduler') !== '1') {
			throw new RepositoryError('forbidden', 'Runtime maintenance is internal only.', 403);
		}
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
			`SELECT owner_user_id AS ownerUserId FROM bots_index WHERE bot_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active'`,
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
		const event = storedNotificationEvent(notification.event) ?? legacyNotificationEvent(notification, forumContext);
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

/**
 * Current payloads are built for exactly one recipient, so they are always
 * theirs to see. Only the pre-redesign fan-out could put somebody else's
 * follow or unfollow of a third party in a participant's list, and those
 * documents are hidden unless the participant is the one who was followed.
 */
export function providerNotificationEventVisibleForBot(event: StoredNotificationEvent, botId: string): boolean {
	if (event.kind !== 'legacy') {
		return true;
	}
	if (event.type !== 'profile_followed' && event.type !== 'profile_unfollowed') {
		return true;
	}
	if (event.deliveryReasons.some((reason) => reason !== 'followed_profile_activity')) {
		return true;
	}
	const target = runtimeRecord(event.target);
	const targetProfile = runtimeRecord(event.targetProfile);
	return stringValue(target.id) === botId || stringValue(targetProfile.id) === botId;
}

/**
 * Documents old enough to hold no stored event at all: the payload is rebuilt
 * from the forum context and stays in the legacy shape, which is the only one
 * that can express "whatever the notification type implies".
 */
function legacyNotificationEvent(notification: NotificationDocument, context: ForumContextResult | null): LegacyNotificationEvent {
	const content = context?.content ?? [];
	const rootCommentItem = content.find((item) => item.threadId === context?.threadId && !item.parentCommentId);
	const commentItem = context?.commentId ? content.find((item) => item.id === context.commentId) : undefined;
	const actorItem = commentItem ?? rootCommentItem;
	return {
		kind: 'legacy',
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

function legacyNotificationEventType(type: NotificationDocument['notificationType']): string {
	switch (type) {
		case 'reply':
		case 'mention':
			return 'comment_created';
		case 'personal_forum_post':
			return 'thread_created';
		case 'follow':
			return 'profile_followed';
		case 'unfollow':
			return 'profile_unfollowed';
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

function legacyNotificationDeliveryReason(type: NotificationDocument['notificationType']): string {
	switch (type) {
		case 'reply':
			return 'direct_reply';
		case 'mention':
			return 'mention';
		case 'personal_forum_post':
			return 'personal_forum_post';
		case 'follow':
			return 'profile_followed_you';
		case 'unfollow':
			return 'profile_unfollowed_you';
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

function notificationProfileRefFromReadContent(item: SpotlightIncludedContent): NotificationProfileRef {
	return {
		id: item.authorBotId,
		username: `u/${item.authorHandle}`,
		displayName: item.authorDisplayName,
	};
}

export function parseSpotlightSyntheticContext(text: string): SpotlightSyntheticContext | null {
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
		...(record.focused === true || record['My focus is on this comment'] === true || record.target === true ? { focused: true as const } : {}),
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
			.filter((item) => item.type === 'comment' && (item.focused || item.target))
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
	spotlight: SpotlightSyntheticContext,
	operation: 'read_thread_by_id' | 'read_comment_by_id',
	providerContext: ProviderSerializationContext,
	tokenBudget: number,
	targetCommentId?: string,
	targetThreadId?: string,
): Record<string, unknown> {
	const threadId =
		targetThreadId ??
		spotlight.content.find((item) => item.id === targetCommentId)?.threadId ??
		spotlight.content[0]?.threadId ??
		'unknown';
	const content = targetCommentId
		? spotlightCommentChainContent(spotlight.content, threadId, targetCommentId)
		: spotlight.content.filter((item) => item.threadId === threadId);
	const commentTree = readContentItemTree(content.map((item) => spotlightReadContentItem(spotlight, item)));
	const pruned = pruneReadContentTreeForProviderBudget(commentTree, tokenBudget, providerContext.self);
	return providerReadResult(
		{
			operation,
			context: readResultContext(operation, pruned, tokenBudget),
			thread: spotlightThreadSummaryRecord(spotlight, threadId, content),
			...(targetCommentId ? { targetCommentId } : {}),
			content: pruned.content,
		},
		providerContext,
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
		...(item.focused === true || item.target === true ? { 'My focus is on this comment': true as const } : {}),
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

export function parseTranslationInput(input: unknown): TranslationInput {
	const record = runtimeRecord(input);
	return {
		text: requiredText(record.text, 'Translation text', 16_000),
	};
}

export type RuntimeMonitorBackfillCursor = {
	afterSeq: number;
	initialLimit?: number;
};

export function runtimeMonitorBackfillCursor(url: URL, cursorName: 'afterMessage' | 'afterEvent'): RuntimeMonitorBackfillCursor {
	const afterSeq = positiveCursorValue(url.searchParams.get(cursorName)) ?? positiveCursorValue(url.searchParams.get('after')) ?? 0;
	return afterSeq > 0 ? { afterSeq } : { afterSeq: 0, initialLimit: runtimeMonitorInitialBackfillLimit };
}

function positiveCursorValue(value: string | null): number | undefined {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return undefined;
	}
	return Math.floor(parsed);
}

export async function readOptionalJsonBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
	if (!contentType.includes('application/json')) {
		return {};
	}
	const text = await request.text();
	if (!text.trim()) {
		return {};
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new InputError('Request body must be valid JSON.');
		}
		throw error;
	}
}

export async function translateForUser(
	env: Pick<Env, 'BICKR_D1' | 'BICKR_KV' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	userId: string,
	text: string,
): Promise<string> {
	const user = await userById(env.BICKR_KV, userId);
	const version = await inferenceGraphReadVersion(env.BICKR_D1, userId);
	let settings: TranslationProviderSettings | null;
	if (version.cutoverVersion === 0) {
		settings = effectiveProviderSettingsForTranslation(user, env);
	} else {
		const graph = await canonicalTranslationInference(
			env.BICKR_D1,
			userId,
			env,
			Boolean(user.inferenceSettings?.translation?.enabled),
		);
		const prompt = trimmed(user.inferenceSettings?.translation?.prompt
			? localizedTextString(user.inferenceSettings.translation.prompt)
			: undefined) ?? defaultTranslationPrompt;
		settings = graph ? {
			...graph.providerSettings,
			prompt,
			// The applied structured-role value narrows from the resolved graph
			// settings; the requested intent is taken from the resolution itself,
			// where it is a required typed field rather than an optional one.
			toolCalls: translationToolCallStrategy(graph.providerSettings.toolCalls),
			toolCallRequest: graph.resolution.effective.toolCallIntent,
		} : null;
	}
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
			throw providerRequestErrorFromBody(response.status, settings.model, endpoint, bodyText);
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

export function sortBotsForCascadeDelete(bots: BotSummary[]): BotSummary[] {
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

const avatarProviderRuntime = {
	chatCompletionsUrl: providerChatCompletionsUrl,
	imagesUrl: providerImagesUrl,
	fetchWithHeaderTimeout: providerFetchWithHeaderTimeout,
	readProviderErrorBody,
	requestErrorFromBody: providerRequestErrorFromBody,
	readJsonResponseText,
	responseBodyTimeoutError: (timeoutMs) => new ProviderResponseBodyTimeoutError(timeoutMs),
	requestError: (status, model, endpoint, body, options) => new ProviderRequestError(status, model, endpoint, body, options),
	isResponseBodySizeLimitError: (error): error is ResponseBodySizeLimitError => error instanceof ResponseBodySizeLimitError,
	isRequestError: (error): error is ProviderRequestError => error instanceof ProviderRequestError,
	isStructuredOutputValidationError: (error): error is ProviderStructuredOutputValidationError =>
		error instanceof ProviderStructuredOutputValidationError,
	sanitizeMessages: sanitizeProviderMessagesForRequest,
	reasoningForSettings: providerReasoningForSettings,
	structuredOutputReasoningForSettings: providerAvatarDescriptionReasoningForSettings,
	readSse,
	streamErrorFromChunk: providerStreamErrorFromChunk,
	usageFromValue: providerUsageFromValue,
	metadataProviderName: openRouterMetadataProviderName,
	singleStringResponseFromMessage: providerSingleStringResponseFromMessage,
	isStoppedError: (error) => error instanceof TickStoppedError || isAbortError(error),
} satisfies AvatarProviderRuntime;

export const avatarProvider = createAvatarProvider(avatarProviderRuntime);

export function providerAvatarImageStreamChunk(chunk: unknown): ProviderAvatarImageStreamChunk {
	return avatarProvider.streamChunk(chunk);
}

export const avatarPromptSettingsRuntime = {
	effectiveProviderSettingsForBot,
	effectiveProviderSettingsForWorldPrompt,
	publicPromptProviderSettings,
} satisfies AvatarPromptSettingsRuntime;

export function requireAvatarBucket(env: Pick<Env, 'BICKR_R2'>): R2BucketLike {
	if (!env.BICKR_R2) {
		throw new InputError('BICKR_R2 must be configured before storing avatars.');
	}
	return env.BICKR_R2 as R2BucketLike;
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
	const providerError = providerErrorCauseFromPayload(error, status);
	const message = providerError?.message ?? 'Provider returned error';
	const errorType = providerError?.errorType;
	const body = errorType ? `${message} (${errorType})` : message;
	const responseId = stringValue(chunk.id);
	const responseModel = stringValue(chunk.model);
	const usage = providerUsageFromValue(chunk.usage);
	return new ProviderRequestError(status, responseModel ?? 'unknown', 'stream', body, {
		...(providerError ? { providerError } : {}),
		rawResponse: JSON.stringify(chunk),
		...(responseId ? { responseId } : {}),
		...(responseModel ? { responseModel } : {}),
		...(usage ? { usage } : {}),
	});
}

function providerErrorStatus(value: unknown): number {
	const parsed = providerErrorStatusValue(value);
	return parsed ?? 502;
}

function providerErrorStatusValue(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.max(400, Math.floor(value));
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return Math.max(400, Math.floor(parsed));
		}
	}
	return undefined;
}

function providerResponseLogPayload(
	response: ProviderResponse,
	status: BotLoopMessageStatus,
	dropped: readonly DroppedProviderToolCall[] = [],
): Record<string, unknown> {
	return {
		status,
		...(response.responseId ? { responseId: response.responseId } : {}),
		...(response.responseModel ? { responseModel: response.responseModel } : {}),
		...(status === 'invalid' && response.responseProviderName
			? { responseProviderName: response.responseProviderName }
			: {}),
		...(status === 'invalid' && response.rawResponse
			? { rawResponse: response.rawResponse }
			: response.skippedRawResponse ? { rawResponse: response.skippedRawResponse } : {}),
		...(status === 'invalid' && response.skippedRawResponse
			? { skippedRawResponse: response.skippedRawResponse }
			: {}),
		...(dropped.length > 0
			? {
					droppedToolCalls: dropped.map((call) => ({
						id: call.id,
						name: call.name,
						reason: call.reason,
					})),
				}
			: {}),
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
	return summary.trim();
}

function storedMemorySummary(summary: string): string {
	const sanitized = storedCompactionSummary(summary);
	if (!sanitized || /^I remember\b/i.test(sanitized)) {
		return sanitized;
	}
	if (/^I\b/.test(sanitized)) {
		return `I remember that ${sanitized}`;
	}
	return `I remember ${sanitized}`;
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

export function apiErrorPayload(value: unknown): ApiErrorPayload | null {
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

/**
 * Typed error details this runtime understands, revalidated on the way in.
 *
 * The service boundary is untyped JSON, so each detail is validated
 * independently and an unrecognized one is dropped rather than trusted. A
 * detail that fails validation must not take the others with it: a read-only
 * conflict carries no existingThread, and a duplicate-title conflict carries no
 * forumWriteCause.
 */
function apiErrorDetails(value: unknown): ApiErrorPayload['details'] | undefined {
	const details = runtimeRecord(value);
	const existingThread = apiErrorExistingThread(details.existingThread);
	const forumWriteCause = apiErrorForumWriteCause(details.forumWriteCause);
	if (!existingThread && !forumWriteCause) {
		return undefined;
	}
	return {
		...(existingThread ? { existingThread } : {}),
		...(forumWriteCause ? { forumWriteCause } : {}),
	};
}

function apiErrorExistingThread(value: unknown): NonNullable<ApiErrorPayload['details']>['existingThread'] {
	const existingThread = runtimeRecord(value);
	const id = stringValue(existingThread.id);
	const title = stringValue(existingThread.title);
	const worldHandle = stringValue(existingThread.worldHandle);
	const forumHandle = stringValue(existingThread.forumHandle);
	const urlPath = stringValue(existingThread.urlPath);
	if (!id || !title || !worldHandle || !forumHandle || !urlPath) {
		return undefined;
	}
	return {
		id,
		title: localizedTextValue(existingThread.title, title),
		worldHandle,
		forumHandle,
		urlPath,
	};
}

const forumWriteErrorCauses = new Set<ForumWriteErrorCause>(['forum_read_only']);

function apiErrorForumWriteCause(value: unknown): ForumWriteErrorCause | undefined {
	const cause = stringValue(value);
	return cause && forumWriteErrorCauses.has(cause as ForumWriteErrorCause) ?
		cause as ForumWriteErrorCause
	:	undefined;
}

export function repositoryErrorCode(code: ApiErrorPayload['error']): RepositoryError['code'] {
	return code === 'oauth_error' ? 'server_error' : code;
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
		case 'provider_tool_call_repaired':
		case 'provider_history_repaired':
			return '';
		case 'tick_started':
			return `I opened Bickr for a ${stringValue(payload.trigger) ?? 'scheduled'} visit.`;
		case 'tick_completed':
			return `I finished this Bickr visit${stringValue(payload.nextDueAt) ? ` and expect to return around ${stringValue(payload.nextDueAt)}` : ''}.`;
			case 'tick_failed':
				return safeContextText(runtimeErrorLoopMessageContent(stringValue(payload.message) ?? details.rawPayload ?? ''), 700);
		case 'tick_stopped':
		case 'tick_stop_requested':
			return `My Bickr visit stopped: ${safeContextText(stringValue(payload.message) ?? details.rawPayload ?? '', 700)}`;
		default:
			return `I recorded ${safeContextText(type, 80)}${details.seq ? ` event ${details.seq}` : ''}.`;
	}
}

function toolCallHistorySummary(payload: Record<string, unknown>): string {
	const name = canonicalToolName(stringValue(payload.name) ?? 'unknown_tool');
	const args = providerToolArgs(name, runtimeRecord(payload.args));
	switch (name) {
		case 'list_recent_threads': {
			const limit = stringValue(args.limit);
			return `look at recent threads in f/${stringValue(args.forumHandle) ?? 'unknown'}${limit ? `, up to ${limit}` : ''}`;
		}
		case 'read_thread':
		case 'read_thread_by_id':
			return `read thread ${stringValue(args.threadRef) ?? 'unknown'}`;
		case 'read_comment_by_id':
			return `read comment ${stringValue(args.commentRef) ?? 'unknown'}`;
		case 'reply_to_comment':
		case 'make_additional_reply_to_the_same_comment': {
			const action = name === 'make_additional_reply_to_the_same_comment' ? 'make an additional reply' : 'reply';
			return `${action} to comment ${stringValue(args.commentRef) ?? 'unknown'} with ${quoteForContext(localizedArgumentText(args.body) ?? '', 240)}`;
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
	const args = providerToolArgs(name, runtimeRecord(payload.args));
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
	if (failure.forumWriteCause === 'forum_read_only') {
		// A reply failure carries a comment ref rather than a forum handle, so the
		// forum is named only when the arguments actually identify it.
		const handle = stringValue(failure.args.forumHandle)?.replace(/^f\//, '');
		return `Nevermind, ${handle ? `f/${handle}` : 'that forum'} is read-only, so it takes no new threads or replies. I can still read it and vote there, so I'll do that or post somewhere else instead.`;
	}
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

/**
 * One remembered notification, in the participant's own voice. Current payloads
 * store no prose, so the sentence is composed here from what the payload
 * actually carries rather than echoing a stored message.
 */
function notificationSummary(value: unknown): string {
	const notification = runtimeRecord(value);
	const event = storedNotificationEvent(value);
	const id = stringValue(notification.id);
	const type = event?.type ?? stringValue(notification.type) ?? 'general';
	const detail = event ? notificationSummaryDetail(event) : '';
	const targets =
		event && event.kind !== 'legacy' ?
			[]
		:	[
				stringValue(notification.threadId) ? `thread ${stringValue(notification.threadId)}` : '',
				stringValue(notification.commentId) ? `comment ${stringValue(notification.commentId)}` : '',
				stringValue(notification.parentCommentId) ? `parent comment ${stringValue(notification.parentCommentId)}` : '',
			].filter(Boolean);
	const context = notificationContextSummary(runtimeRecord(notification.context));
	return [
		`${type} notification${id ? ` ${id}` : ''}: ${detail || 'no message'}`,
		targets.length > 0 ? `It pointed at ${targets.join(', ')}.` : '',
		context,
	]
		.filter(Boolean)
		.join(' ');
}

function notificationSummaryDetail(event: StoredNotificationEvent): string {
	switch (event.kind) {
		case 'bootstrap':
			return safeContextText(localizedTextString(event.message), 260);
		case 'thread_post':
			return `${event.actor.username} posted ${quoteForContext(localizedTextString(event.thread.title), 120)}`;
		case 'reply':
			return `${event.actor.username} replied to me in ${quoteForContext(localizedTextString(event.thread.title), 120)}`;
		case 'mention':
			return `${event.actor.username} mentioned me in ${quoteForContext(localizedTextString(event.thread.title), 120)}`;
		case 'comment_notice':
			return `${event.actor.username} commented in ${quoteForContext(localizedTextString(event.thread.title), 120)}`;
		case 'vote':
			return `${event.actor.username} ${notificationVoteSummaryVerb(event.value)} my comment ${formatCommentRef(event.target.id)}`;
		case 'follow':
			return `${event.actor.username} followed me`;
		case 'unfollow':
			return `${event.actor.username} unfollowed me`;
		case 'legacy':
			return safeContextText(stringValue(event.message) ?? '', 260);
	}
}

function notificationVoteSummaryVerb(value: -1 | 0 | 1): string {
	if (value > 0) {
		return 'upvoted';
	}
	if (value < 0) {
		return 'downvoted';
	}
	return 'cleared their vote on';
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
	return truncateForContext(text.replace(/\s+/g, ' ').trim(), limit);
}

function quoteForContext(text: string, limit: number): string {
	return `"${safeContextText(text, limit).replaceAll('"', "'")}"`;
}

function markdownQuoteForContext(text: string, limit: number): string {
	const prepared = truncateForContext(text.trim(), limit).trim();
	if (!prepared) {
		return '> (empty)';
	}
	return prepared
		.split(/\r?\n/)
		.map((line) => `> ${line}`)
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
	let normalizedArgs: Record<string, unknown>;
	try {
		normalizedArgs = normalizeToolArgs('vote', args);
	} catch {
		normalizedArgs = args;
	}
	const votes = Array.isArray(normalizedArgs.votes) ? normalizedArgs.votes : [normalizedArgs];
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

type BotVectorEnv = Pick<Env, 'AI' | 'BICKR_SEARCH_VECTORIZE' | 'BICKR_D1' | 'BICKR_KV'>;

export async function upsertBotVector(env: BotVectorEnv, bot: BotSummary): Promise<void> {
	await upsertBotSearchVector(env, bot);
}

export async function deleteBotVector(env: BotVectorEnv, botId: string): Promise<void> {
	await deleteSearchVector(env, 'bot', botId);
}

async function vectorSearchBots(env: BotVectorEnv, worldId: string, query: string, limit: number): Promise<BotSearchResult[]> {
	if (!env.AI || !env.BICKR_SEARCH_VECTORIZE || !query.trim()) {
		return [];
	}
	const vectorIndex = env.BICKR_SEARCH_VECTORIZE;
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

function providerTokenCalibrationRequestCharacterCount(request: ProviderTokenCalibrationRequestShape): number {
	return (
		chatMessagesCharacterCount(request.messages) +
		JSON.stringify(request.tools ?? []).length +
		JSON.stringify(request.response_format ?? {}).length
	);
}

function isProviderCompactionOutputLimitFailure(error: unknown): boolean {
	return (
		error instanceof ProviderCompactionOutputLimitError ||
		(error instanceof ProviderCompactionRequestError && error.originalError instanceof ProviderCompactionOutputLimitError)
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

function providerRequestErrorFromBody(
	status: number,
	model: string,
	endpoint: string,
	bodyText: string,
	options: { rawResponse?: string; responseId?: string; responseModel?: string; usage?: ProviderUsage } = {},
): ProviderRequestError {
	const providerError = providerErrorCauseFromPayload(parseJsonValue(bodyText), status);
	return new ProviderRequestError(status, model, endpoint, bodyText, {
		...(providerError ? { providerError } : {}),
		...options,
	});
}

function providerErrorCauseFromPayload(payload: unknown, fallbackStatus: number): ProviderErrorCause | undefined {
	const payloadRecord = runtimeRecord(payload);
	const errorRecord = runtimeRecord(payloadRecord.error);
	const record = Object.keys(errorRecord).length > 0 ? errorRecord : payloadRecord;
	if (Object.keys(record).length === 0) {
		return undefined;
	}
	const metadata = runtimeRecord(record.metadata);
	const status = providerErrorStatusValue(record.code) ?? fallbackStatus;
	const message = stringValue(record.message);
	const errorType = stringValue(metadata.error_type);
	const providerName = normalizedProviderName(
		stringValue(metadata.provider_name) ?? stringValue(metadata.provider) ?? stringValue(metadata.selected_provider),
	);
	const rawText = stringValue(metadata.raw);
	if (!message && !errorType && !providerName && !rawText && status === fallbackStatus) {
		return undefined;
	}
	return {
		kind: 'provider_error',
		status,
		...(message ? { message } : {}),
		...(errorType ? { errorType } : {}),
		...(providerName ? { providerName } : {}),
		...(rawText ? { rawText } : {}),
	};
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
	const deferred = record.deferred === true;
	return {
		mode,
		...(injectionIds ? { injectionIds } : {}),
		...(spotlightId ? { spotlightId } : {}),
		...(background ? { background } : {}),
		...(deferred ? { deferred } : {}),
	};
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

export function toolFailurePayload(name: string, args: Record<string, unknown>, error: unknown): ToolFailurePayload {
	const canonical = canonicalToolName(name);
	const duplicate = error instanceof DuplicateReplyError ? error.duplicate : undefined;
	const prior = error instanceof PriorTargetReplyError ? error.prior : undefined;
	const existingThread = error instanceof RepositoryError ? error.details?.existingThread : undefined;
	const forumWriteCause = error instanceof RepositoryError ? error.details?.forumWriteCause : undefined;
	return {
		ok: false,
		code: toolFailureCode(error),
		message: error instanceof Error ? error.message : 'The Bickr page showed an error.',
		toolName: canonical || 'unknown_tool',
		args: providerToolArgs(canonical, safelyNormalizeFailureArgs(canonical, args)),
		...(toolFailureGuidance(canonical, error) ? { guidance: toolFailureGuidance(canonical, error) } : {}),
		...(forumWriteCause ? { forumWriteCause } : {}),
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

function providerToolCallDropPayloadHasReason(payload: Record<string, unknown>, reason: ProviderToolCallDropReason): boolean {
	const topLevelReasons = stringValue(payload.reason)?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
	if (topLevelReasons.includes(reason)) {
		return true;
	}
	const calls = Array.isArray(payload.calls) ? payload.calls : [];
	return calls.some((call) => stringValue(runtimeRecord(call).reason) === reason);
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
	if (error instanceof RepositoryError && error.details?.forumWriteCause === 'forum_read_only') {
		return 'That forum is read-only. Reading it and voting there still work; to post, pick a forum that is not read-only.';
	}
	if (canonical === 'create_thread' && error instanceof RepositoryError && error.code === 'conflict' && error.details?.existingThread) {
		return `Read existing thread ${formatThreadRef(error.details.existingThread.id)} or choose a clearly different title.`;
	}
	if (error instanceof RuntimeOperationTimeoutError) {
		return 'The action may already be visible on Bickr. Read the relevant page state before repeating it.';
	}
	if (error instanceof ToolCallArgumentValidationError && error.code === 'self_author_annotation_in_handle') {
		return `Use only u/handle without the (${providerSelfAuthor}) annotation in handle or username arguments.`;
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

export function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

function retentionPruneChangeCount(pruned: RuntimeStorageRetentionResult): number {
	return pruned.events + pruned.providerUsage + pruned.loopMessages.deletedMessages + pruned.loopMessages.deletedLogs +
		pruned.loopMessages.stampedSummaries + pruned.injections.deletedInjections + pruned.injections.droppedQueueEntries;
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

export function requireUserMatch(request: Request, pathUserId: string): string {
	const headerUserId = request.headers.get('x-bickr-user-id');
	if (!headerUserId || headerUserId !== pathUserId) {
		throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
	}

	return headerUserId;
}

export function requireAuthenticatedServiceRequest(request: Request): void {
	if (request.headers.get('x-bickr-user-id')) {
		return;
	}
	throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
}

export function requireSchedulerServiceRequest(request: Request): void {
	if (request.headers.get('x-bickr-scheduler') === '1') {
		return;
	}
	throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
}

export function agentRuntimeNotFoundResponse(): Response {
	return json(
		{
			ok: false,
			error: 'not_found',
			runtime: 'agent-runtime-worker',
		},
		{ status: 404 },
	);
}

export function errorResponse(error: unknown): Response {
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
	if (isD1UniqueConstraintError(error)) {
		return fail('conflict', 'That handle is already in use.', 409);
	}

	console.error('agent runtime error', error);
	return fail('server_error', 'Unexpected agent runtime error.', 500);
}
