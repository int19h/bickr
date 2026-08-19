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

/**
 * Terminal tombstone written into the storage a full clear rebuilds.
 *
 * The clear erases the object's whole database and re-creates the schema empty,
 * which leaves nothing to distinguish a cleared participant from a brand new
 * one. Anything still holding a reference to the object — an in-flight
 * injection, an open monitor socket, a queued spotlight visit — would otherwise
 * repopulate it, and `bot_runtime_index.runtime_storage_cleared_at` has already
 * excluded the row from every later sweep, so the recreated storage would never
 * be reclaimed. This row is the object's own record that the clear happened.
 */
export const runtimeStorageClearedStateKey = 'runtime_storage_cleared_at';

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

/**
 * Backstop for one fleet-maintenance dispatch, not the bound that ends a heavy
 * visit: a retention pass self-bounds at `sweepRetentionTimeBudgetMs` and
 * answers with what it deleted, so this only has to cover a cold object's
 * start-up plus that budget. A timeout here therefore means a hung object
 * rather than a deep backlog, which is what the retry backlog is for. The
 * sweep's wall clock stays bounded by its fan-out instead: 25 visits run
 * concurrently per chunk, so a 500-participant run is about
 * (500 / 25) × ~9 s ≈ 3 minutes.
 */
export const runtimeMaintenanceDispatchTimeoutMs = 30_000;

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
 * allowance is what burns down the pre-retention backlog (§2.8 O6). The sweep's
 * retention pass spends it in `loopMessageRetentionBatchSize` batches, each its
 * own short transaction, so a deeper visit holds the input gate no longer per
 * batch — it just runs more of them. A participant with more expired history
 * than this keeps the rest for the next cycle. Raised from 2,000 to speed the
 * O6 drain (owner decision, 2026-08-19).
 */
export const sweepLoopMessageRetentionLimit = 10_000;

/**
 * Wall-clock budget for one sweep retention pass's loop-message batches.
 *
 * The row allowance alone cannot bound a visit's duration: the object may be
 * cold, and the rows it has to materialize before deleting vary in size. The
 * pass therefore stops at the first batch boundary past this budget and returns
 * what it deleted, so a truncated visit is a 200 the sweep counts as done
 * rather than a dispatch timeout that lands in the retry backlog. Stays
 * comfortably under `runtimeMaintenanceDispatchTimeoutMs`, which has to cover
 * this budget plus the object's start-up.
 */
export const sweepRetentionTimeBudgetMs = 8_000;

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
