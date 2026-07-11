import { defaultProviderModel } from '@bickr/shared/model';

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

export const scheduledDispatchSelectLimit = 20;

export const scheduledDispatchBudget = 2_000;

export const vectorBindingTimeoutMs = 10_000;

export const cloudflareBindingRetryMaxAttempts = 3;

export const cloudflareBindingRetryInitialDelayMs = 1_000;

export const cloudflareBindingRetryMaxDelayMs = 4_000;

export const providerMaxAttempts = 5;

export const providerRetryBaseDelayMs = 3_000;

export const providerNoToolChoice = 'none' as const;

export const providerTokenProbeToolChoice = 'auto' as const;

export const providerParallelToolCalls = true;

export const providerRailroadNoToolMaxAttempts = 5;

export const providerPromptCompactionMaxAttempts = 3;

export const providerTranslationMaxCompletionTokens = 8_192;

export const providerTranslationToolName = 'save_translation';

export const providerStructuredOutputRepairAttempts = 4;

export const inferenceSubmissionRetentionCount = 50;

export const providerTokenCalibrationRetentionCount = 100;

export const loopMessageLogRetentionCount = 50;

export const loopMessageLogChunkLength = 250_000;

export const loopMessagePageIndexLimit = 100;

export const runtimeMonitorInitialBackfillLimit = 100;

export const dayMs = 24 * 60 * 60 * 1000;

export const fallbackProviderModel = defaultProviderModel;

export const fallbackProviderBaseUrl = 'https://openrouter.ai/api/v1';

export const legacyProviderToolCallHistoryNormalizedStateKey = 'loop_messages_provider_tool_call_history_normalized_v1';

export const providerToolCallHistoryInvariantViolationStateKey = 'provider_tool_call_history_invariant_violation';
