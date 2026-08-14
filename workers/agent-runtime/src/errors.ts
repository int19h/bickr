import type { BotInferenceSubmissionToolCall } from '@bickr/shared/model';
import type {
	CompactionReasoningDecisionProvenance,
	CompactionReasoningProvenance,
	CompactionReasoningRefusal,
	CompactionReasoningSelection,
} from '@bickr/shared/openrouter-model-capabilities';
import {
	compactionReasoningRefusalMessage,
	isRuntimeErrorCause,
	ownerFacingRuntimeErrorMessage,
	type ProviderErrorCause,
	type RuntimeErrorCause,
} from '@bickr/shared/runtime-errors';
import { ProviderAvatarDescriptionValidationError } from './avatar/provider';
import { providerRailroadNoToolMaxAttempts } from './constants';
import type {
	ProviderResponse,
	ProviderStructuredOutputKind,
	ProviderStructuredOutputValidationIssue,
	ProviderUsage,
	ToolFailurePayload,
} from './types';

export class PersistentToolFailureError extends Error {
	readonly failure: ToolFailurePayload;

	constructor(failure: ToolFailurePayload) {
		super(`Stopped after 5 consecutive failed tool calls. Last error: ${failure.message}`);
		this.name = 'PersistentToolFailureError';
		this.failure = failure;
	}
}

export class PersistentMissingToolCallError extends Error {
	readonly toolNames: string[];

	constructor(toolNames: string[]) {
		super(`Stopped after ${providerRailroadNoToolMaxAttempts} inference responses without a required tool call.`);
		this.name = 'PersistentMissingToolCallError';
		this.toolNames = toolNames;
	}
}

export class SelfCorrectingToolCallError extends Error {
	readonly selfCorrectionMessages: string[];

	constructor(message: string) {
		super(message);
		this.name = 'SelfCorrectingToolCallError';
		this.selfCorrectionMessages = [message];
	}
}

export class RuntimeOperationTimeoutError extends Error {
	readonly kind = 'runtime_operation_timeout';
	readonly operation: string;
	readonly timeoutMs: number;

	constructor(operation: string, timeoutMs: number) {
		super(`${operation} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = 'RuntimeOperationTimeoutError';
		this.operation = operation;
		this.timeoutMs = timeoutMs;
	}
}

export class CompactionReasoningRefusalError extends Error {
	readonly kind = 'compaction_reasoning_refusal';
	readonly refusal: CompactionReasoningRefusal;
	readonly provenance: CompactionReasoningProvenance;

	constructor(refusal: CompactionReasoningRefusal, provenance: CompactionReasoningProvenance) {
		super(compactionReasoningRefusalMessage(refusal));
		this.name = 'CompactionReasoningRefusalError';
		this.refusal = refusal;
		this.provenance = provenance;
	}
}

export class ToolCallArgumentValidationError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'ToolCallArgumentValidationError';
		this.code = code;
	}
}

export class ProviderRequestError extends Error {
	readonly kind = 'provider_request';
	readonly status: number;
	readonly body: string;
	readonly providerError?: ProviderErrorCause;
	readonly rawResponse?: string;
	readonly responseId?: string;
	readonly responseModel?: string;
	readonly usage?: ProviderUsage;

	constructor(
		status: number,
		_model: string,
		_endpoint: string,
		body: string,
		options: { providerError?: ProviderErrorCause; rawResponse?: string; responseId?: string; responseModel?: string; usage?: ProviderUsage } = {},
	) {
		const suffix = body ? ` Response: ${body}` : '';
		super(`Inference request failed with status ${status}.${suffix}`);
		this.name = 'ProviderRequestError';
		this.status = status;
		this.body = body;
		this.providerError = options.providerError;
		this.rawResponse = options.rawResponse;
		this.responseId = options.responseId;
		this.responseModel = options.responseModel;
		this.usage = options.usage;
	}
}

export class ProviderCompactionRequestError extends Error {
	readonly kind = 'provider_compaction_request';
	readonly compactionReasoning: CompactionReasoningDiagnostic;
	readonly originalError: unknown;
	readonly requestBody: string;
	readonly responseBody?: string;

	constructor(
		originalError: unknown,
		requestBody: string,
		compactionReasoning: CompactionReasoningDiagnostic,
		responseBody?: string,
	) {
		super(runtimeErrorText(originalError));
		this.name = 'ProviderCompactionRequestError';
		this.compactionReasoning = compactionReasoning;
		this.originalError = originalError;
		this.requestBody = requestBody;
		this.responseBody = responseBody;
	}
}

export class ProviderLoopRequestError extends Error {
	readonly kind = 'provider_loop_request';
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

export class ProviderStructuredOutputValidationError extends Error {
	readonly kind = 'provider_structured_output_validation';
	readonly structuredOutputKind: ProviderStructuredOutputKind;
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
		this.structuredOutputKind = kind;
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

export class ProviderCompactionOutputLimitError extends Error {
	readonly kind = 'provider_compaction_output_limit';
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

export class ProviderRequestTimeoutError extends Error {
	readonly kind = 'provider_request_timeout';
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Inference request did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = 'ProviderRequestTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}

export class ProviderResponseBodyTimeoutError extends Error {
	readonly kind = 'provider_response_body_timeout';
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Inference response body did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = 'ProviderResponseBodyTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}

export class ResponseBodySizeLimitError extends Error {
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super(`Response body exceeded ${maxBytes} bytes.`);
		this.name = 'ResponseBodySizeLimitError';
		this.maxBytes = maxBytes;
	}
}

export class ProviderEmptyResponseError extends Error {
	readonly kind = 'provider_empty_response';
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

export class ProviderStreamIdleTimeoutError extends Error {
	readonly kind = 'provider_stream_idle_timeout';
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Inference stream stopped responding after ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = 'ProviderStreamIdleTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}

export class PromptContextBudgetExceededError extends Error {
	readonly kind = 'prompt_context_budget_exceeded';
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

export class PromptContextCompactionLimitError extends Error {
	readonly kind = 'prompt_context_compaction_limit';
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
	readonly kind = 'persistent_compaction_reduction_failure';
	readonly attempts: number;
	readonly compactionReasoning: CompactionReasoningDiagnostic;
	readonly requestBody: string;
	readonly responseBody?: string;

	constructor(
		attempts: number,
		requestBody: string,
		compactionReasoning: CompactionReasoningDiagnostic,
		responseBody?: string,
	) {
		super(
			`Context compaction isolated repair failed to produce a shorter summary after ${attempts} attempts. This participant has been paused so it does not keep retrying the same oversized context.`,
		);
		this.name = 'PersistentCompactionReductionFailureError';
		this.attempts = attempts;
		this.compactionReasoning = compactionReasoning;
		this.requestBody = requestBody;
		this.responseBody = responseBody;
	}
}

export type CompactionReasoningDiagnostic = {
	decision: CompactionReasoningDecisionProvenance;
	selection: CompactionReasoningSelection;
	provenance: CompactionReasoningProvenance;
};

export class TickStoppedError extends Error {
	constructor() {
		super('This Bickr visit was stopped.');
		this.name = 'TickStoppedError';
	}
}

export class ProviderResponseInterruptedError extends Error {
	readonly response: ProviderResponse;
	readonly originalError: unknown;

	constructor(response: ProviderResponse, originalError: unknown) {
		super(originalError instanceof Error ? originalError.message : 'Provider response was interrupted.');
		this.name = 'ProviderResponseInterruptedError';
		this.response = response;
		this.originalError = originalError;
	}
}

export function runtimeErrorCause(error: unknown): RuntimeErrorCause | string {
	if (error instanceof CompactionReasoningRefusalError) {
		return {
			kind: error.kind,
			refusal: error.refusal,
			provenance: error.provenance,
		};
	}
	if (error instanceof ProviderRequestError) {
		return {
			kind: error.kind,
			status: error.status,
			...(error.body ? { body: error.body } : {}),
			...(error.providerError ? { providerError: error.providerError } : {}),
		};
	}
	if (error instanceof ProviderLoopRequestError) {
		return {
			kind: error.kind,
			attempts: error.attempts,
			cause: runtimeErrorCause(error.originalError),
		};
	}
	if (error instanceof ProviderCompactionRequestError) {
		return {
			kind: error.kind,
			cause: runtimeErrorCause(error.originalError),
		};
	}
	if (error instanceof ProviderStructuredOutputValidationError) {
		return {
			kind: error.kind,
			outputKind: error.structuredOutputKind,
			repairMessage: error.repairMessage,
			...(error.requiredToolName ? { requiredToolName: error.requiredToolName } : {}),
			...(error.rawResponse ? { rawResponse: error.rawResponse } : {}),
		};
	}
	if (error instanceof ProviderAvatarDescriptionValidationError) {
		return {
			kind: error.kind,
			repairMessage: error.repairMessage,
			...(error.rawResponse ? { rawResponse: error.rawResponse } : {}),
		};
	}
	if (error instanceof ProviderCompactionOutputLimitError) {
		return {
			kind: error.kind,
			finishReason: error.finishReason,
			nativeFinishReason: error.nativeFinishReason,
			rawResponse: error.rawResponse,
		};
	}
	if (error instanceof ProviderEmptyResponseError) {
		return {
			kind: error.kind,
			...(error.rawResponse ? { rawResponse: error.rawResponse } : {}),
		};
	}
	if (
		error instanceof ProviderRequestTimeoutError ||
		error instanceof ProviderResponseBodyTimeoutError ||
		error instanceof ProviderStreamIdleTimeoutError
	) {
		return { kind: error.kind, timeoutMs: error.timeoutMs };
	}
	if (error instanceof RuntimeOperationTimeoutError) {
		return { kind: error.kind, timeoutMs: error.timeoutMs, operation: error.operation };
	}
	if (error instanceof PromptContextBudgetExceededError) {
		return {
			kind: error.kind,
			promptTokens: error.promptTokens,
			allowedPromptTokens: error.allowedPromptTokens,
		};
	}
	if (error instanceof PromptContextCompactionLimitError) {
		return {
			kind: error.kind,
			promptTokens: error.promptTokens,
			allowedPromptTokens: error.allowedPromptTokens,
			attempts: error.attempts,
		};
	}
	if (error instanceof PersistentCompactionReductionFailureError) {
		return { kind: error.kind, attempts: error.attempts };
	}
	if (isRuntimeErrorCause(error)) {
		return error;
	}
	return runtimeErrorText(error);
}

export function providerLoopFailureMessage(error: unknown, attempts: number): string {
	const lastError = ownerFacingRuntimeErrorMessage(runtimeErrorCause(error)) ?? runtimeErrorText(error);
	if (attempts > 1) {
		const retries = attempts - 1;
		return `Inference failed after ${attempts} provider attempts (${retries} ${retries === 1 ? 'retry' : 'retries'}); last error from provider:\n${lastError}`;
	}
	return `Inference failed before retrying; error from provider:\n${lastError}`;
}

export function runtimeErrorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
