import {
	defaultProviderBaseUrl,
	defaultProviderModel,
	type BotLoopMessageOrigin,
} from '@bickr/shared/model';

export const providerContextCompletionReserveTokens = 5_000;

export const stopRequestStateKey = 'stop_requested_run_id';

export const toolUseRecoveryStateKey = 'tool_use_recovery';

export const pendingSpotlightTicksStateKey = 'pending_spotlight_ticks';

export const compactionReasoningFallbackStateKey = 'compaction_reasoning_fallback';

export const centralProviderUsageExportCursorStateKey = 'central_provider_usage_export_cursor';

export const lastLogOffSeqStateKey = 'last_log_off_seq';

export const logOffBackfillPageSize = 100;

export const contextBudgetCacheStateKey = (fingerprint: string): string => `context_budget:${fingerprint}`;

export const runtimeRunLeaseTimeoutMs = 15 * 60_000;

export const providerRequestTimeoutMs = 60_000;

export const providerBodyReadTimeoutMs = 60_000;

export const providerStreamIdleTimeoutMs = 60_000;

export const providerResponseBodyMaxBytes = 2_000_000;

export const providerFailureRawResponseMaxCharacters = 64_000;

export const openRouterGenerationMetadataMaxBytes = 64_000;

export const openRouterGenerationMetadataTimeoutMs = 5_000;

export const openRouterExperimentalMetadataHeader = 'X-OpenRouter-Experimental-Metadata';

export const openRouterGenerationIdHeader = 'x-generation-id';

export const serviceBindingTimeoutMs = 30_000;

export const serviceBindingResponseBodyMaxBytes = 1_000_000;

export const scheduledDispatchTimeoutMs = 10_000;

export const providerUsageExportBatchSize = 100;

export const runtimeEventRetentionDays = 30;

/**
 * Loop retention (design §2.4). The active context — `compacted_by IS NULL AND
 * deleted_at IS NULL` — is never touched by any of these: only rows a
 * compaction has already absorbed, or that the owner has already deleted, age
 * out. Owner-visible loop history is therefore bounded to roughly the
 * compaction window plus 14 days, which is an accepted product cost.
 */
export const compactedLoopMessageRetentionDays = 14;

/**
 * Compaction summaries outlive their absorbed children by a wide margin: a
 * summary still stands in for everything under it, so it stays readable long
 * after the raw messages are gone.
 */
export const compactionSummaryLoopMessageRetentionDays = 180;

export const deletedLoopMessageRetentionDays = 14;

/**
 * Injections age out on the same 14-day cutoff as `spotlight_deliveries`
 * (§2.6), so a deferred spotlight visit dies coherently in both stores.
 * Unconsumed `manual` injections are exempt: they are owner input waiting for a
 * paused participant to resume, and their volume is owner-bounded.
 */
export const injectionRetentionDays = 14;

/**
 * One retention batch. Every batch is one synchronous Durable Object
 * transaction, so this bounds how much work a single input-gate hold does.
 */
export const loopMessageRetentionBatchSize = 250;

/** Post-tick retention stays at one batch: it runs on every completed visit. */
export const postTickLoopMessageRetentionLimit = loopMessageRetentionBatchSize;

/**
 * The daily fleet sweep visits each participant at most once, so its per-object
 * allowance is what burns down the pre-retention backlog (§2.8 O6). It is still
 * bounded: a participant with more expired history than this keeps the rest for
 * the next cycle.
 */
export const sweepLoopMessageRetentionLimit = 2_000;

export const scheduledDispatchSelectLimit = 20;

export const scheduledDispatchBudget = 2_000;

export const vectorBindingTimeoutMs = 10_000;

export const cloudflareBindingRetryMaxAttempts = 3;

export const cloudflareBindingRetryInitialDelayMs = 1_000;

export const cloudflareBindingRetryMaxDelayMs = 4_000;

export const providerMaxAttempts = 5;

export const providerRetryBaseDelayMs = 3_000;

export const providerNoToolChoice = 'none' as const;

export const providerParallelToolCalls = true;

export const providerRailroadNoToolMaxAttempts = 5;

export const providerPromptCompactionMaxAttempts = 3;

export const providerTranslationMaxCompletionTokens = 8_192;

export const providerTranslationToolName = 'save_translation';

export const providerSelfAuthor = 'MYSELF';

export const providerStructuredOutputRepairAttempts = 4;

export const inferenceSubmissionRetentionCount = 50;

export const providerTokenCalibrationRetentionCount = 100;

export const loopMessageLogRetentionCount = 50;

export const loopMessageLogChunkLength = 250_000;

/**
 * Owner-visible Loop diagnostics never contribute to provider history, so
 * compaction cannot bound them. Retain the newest rows of each diagnostic
 * origin and physically delete older rows plus their logs at the append path.
 * Keeping runtime_error under the same policy prevents a repeatedly failing
 * visit from retaining one unbounded legacy diagnostic beside the new dropped
 * provider responses.
 */
export const runtimeDiagnosticLoopMessageRetentionCount = 32;

export const runtimeDiagnosticLoopMessageOrigins = [
	'dropped_provider_response',
	'runtime_error',
] as const satisfies readonly BotLoopMessageOrigin[];

export type RuntimeDiagnosticLoopMessageOrigin = (typeof runtimeDiagnosticLoopMessageOrigins)[number];

export const loopMessagePageIndexLimit = 100;

export const runtimeMonitorInitialBackfillLimit = 100;

export const dayMs = 24 * 60 * 60 * 1000;

export const fallbackProviderModel = defaultProviderModel;

export const fallbackProviderBaseUrl = defaultProviderBaseUrl;

export const legacyProviderToolCallHistoryNormalizedStateKey = 'loop_messages_provider_tool_call_history_normalized_v1';

export const providerToolCallHistoryInvariantViolationStateKey = 'provider_tool_call_history_invariant_violation';
