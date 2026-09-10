import type {
	CompactionReasoningProvenance,
	CompactionReasoningRefusal,
} from "./openrouter-model-capabilities";

export type ProviderErrorCause = {
	kind: "provider_error";
	status: number;
	message?: string;
	errorType?: string;
	providerName?: string;
	rawText?: string;
};

export type RuntimeErrorCause =
	| { kind: "tool_outcome_unknown"; cause: RuntimeErrorCause | string }
	| { kind: "service_error"; status: number; message: string }
	| {
			kind: "compaction_reasoning_refusal";
			refusal: CompactionReasoningRefusal;
			provenance: CompactionReasoningProvenance;
	  }
	| {
			kind: "provider_request";
			status: number;
			body?: string;
			providerError?: ProviderErrorCause;
	  }
	| {
			kind: "provider_loop_request";
			attempts: number;
			cause: RuntimeErrorCause | string;
	  }
	| {
			kind: "provider_compaction_request";
			cause: RuntimeErrorCause | string;
	  }
	| {
			kind: "provider_structured_output_validation";
			outputKind: "avatar_description" | "compaction" | "translation";
			repairMessage: string;
			requiredToolName?: string;
			rawResponse?: string;
	  }
	| {
			kind: "provider_avatar_description_validation";
			repairMessage: string;
			rawResponse?: string;
	  }
	| {
			kind: "provider_compaction_output_limit";
			finishReason: string;
			nativeFinishReason: string;
			rawResponse: string;
	  }
	| {
			kind: "provider_empty_response";
			rawResponse?: string;
	  }
	| {
			kind: "provider_request_timeout" | "provider_response_body_timeout" | "provider_stream_idle_timeout" | "runtime_operation_timeout";
			timeoutMs: number;
			operation?: string;
	  }
	| {
			kind: "prompt_context_budget_exceeded" | "prompt_context_compaction_limit";
			promptTokens: number;
			allowedPromptTokens: number;
			attempts?: number;
	  }
	| {
			kind: "persistent_compaction_reduction_failure";
			attempts: number;
	  }
	| {
			kind: "runtime_error";
			message: string;
	  };

const runtimeErrorCauseKinds = new Set<RuntimeErrorCause["kind"]>([
	"tool_outcome_unknown",
	"service_error",
	"compaction_reasoning_refusal",
	"provider_request",
	"provider_loop_request",
	"provider_compaction_request",
	"provider_structured_output_validation",
	"provider_avatar_description_validation",
	"provider_compaction_output_limit",
	"provider_empty_response",
	"provider_request_timeout",
	"provider_response_body_timeout",
	"provider_stream_idle_timeout",
	"runtime_operation_timeout",
	"prompt_context_budget_exceeded",
	"prompt_context_compaction_limit",
	"persistent_compaction_reduction_failure",
	"runtime_error",
]);

export function isRuntimeErrorCause(value: unknown): value is RuntimeErrorCause {
	return Boolean(
		value &&
		typeof value === "object" &&
		"kind" in value &&
		typeof (value as { kind?: unknown }).kind === "string" &&
		runtimeErrorCauseKinds.has((value as { kind: RuntimeErrorCause["kind"] }).kind),
	);
}

export function ownerFacingRuntimeErrorMessage(error: RuntimeErrorCause | string | undefined): string | undefined {
	if (!error) {
		return undefined;
	}
	if (typeof error === "string") {
		return error;
	}
	switch (error.kind) {
		case "tool_outcome_unknown": {
			const cause = ownerFacingRuntimeErrorMessage(error.cause);
			return `The website action may have completed, but its result could not be confirmed.${cause ? ` ${cause}` : ""}`;
		}
		case "service_error":
			return `Website service failed with status ${error.status}: ${error.message}`;
		case "compaction_reasoning_refusal":
			return compactionReasoningRefusalMessage(error.refusal);
		case "provider_request":
			return `Inference request failed with status ${error.status}${error.body ? `: ${error.body}` : "."}`;
		case "provider_loop_request": {
			const cause = ownerFacingRuntimeErrorMessage(error.cause);
			if (error.attempts <= 1) {
				return cause;
			}
			return `Inference failed after ${error.attempts} provider attempts${cause ? `: ${cause}` : "."}`;
		}
		case "provider_compaction_request":
			return ownerFacingRuntimeErrorMessage(error.cause);
		case "provider_structured_output_validation":
			return `Inference provider returned schema-invalid ${error.outputKind} ${error.requiredToolName ? "tool arguments" : "structured output"}: ${error.repairMessage}`;
		case "provider_avatar_description_validation":
			return `Inference provider returned schema-invalid avatar_description structured output: ${error.repairMessage}`;
		case "provider_compaction_output_limit": {
			const details = [error.finishReason, error.nativeFinishReason].filter(Boolean).join("/");
			return `Inference provider exhausted the compaction output budget${details ? ` (${details})` : ""}.`;
		}
		case "provider_empty_response":
			return "Inference provider returned an empty response with no content, reasoning, or tool calls.";
		case "provider_request_timeout":
			return `Inference request did not respond within ${seconds(error.timeoutMs)} seconds.`;
		case "provider_response_body_timeout":
			return `Inference response body did not finish within ${seconds(error.timeoutMs)} seconds.`;
		case "provider_stream_idle_timeout":
			return `Inference stream stopped responding after ${seconds(error.timeoutMs)} seconds.`;
		case "runtime_operation_timeout":
			return `${error.operation ?? "Runtime operation"} did not finish within ${seconds(error.timeoutMs)} seconds.`;
		case "prompt_context_budget_exceeded":
			return `Prompt context is too large for this participant's configured context budget: ${error.promptTokens} prompt tokens exceeds the ${error.allowedPromptTokens} token prompt limit.`;
		case "prompt_context_compaction_limit":
			return `Context compaction did not reduce the provider prompt below the next compaction threshold after ${error.attempts ?? 0} attempts: ${error.promptTokens} prompt tokens still exceeds the ${error.allowedPromptTokens} token prompt limit. Increase the context budget or reduce the participant prompt, enabled controls, or maximum compacted summary size.`;
		case "persistent_compaction_reduction_failure":
			return `Context compaction isolated repair failed to produce a shorter summary after ${error.attempts} attempts. This visit ended to avoid repeatedly retrying the same oversized context.`;
		case "runtime_error":
			return error.message;
	}
}

export function botFacingRuntimeErrorMessage(error: RuntimeErrorCause | string | undefined): string | undefined {
	if (!error) {
		return undefined;
	}
	if (typeof error === "string") {
		return `The Bickr app reported an error during this visit: ${error}`;
	}
	switch (error.kind) {
		case "tool_outcome_unknown":
			return "The website action may have completed, but its result could not be confirmed. Check the website before attempting the action again.";
		case "service_error":
			return `Bickr website request failed with status ${error.status}.`;
		case "compaction_reasoning_refusal":
			return `Context compaction could not select a supported reasoning level: ${compactionReasoningRefusalMessage(error.refusal)}`;
		case "provider_request":
			return `Inference request failed with status ${error.status} at the configured provider${error.body ? `. Response: ${error.body}` : "."}`;
		case "provider_loop_request": {
			const cause = botFacingRuntimeErrorMessage(error.cause);
			if (error.attempts <= 1) {
				return cause;
			}
			return `Inference failed after ${error.attempts} provider attempts${cause ? `. Last error: ${cause}` : "."}`;
		}
		case "provider_compaction_request":
			return botFacingRuntimeErrorMessage(error.cause);
		case "provider_structured_output_validation":
			return `Invalid inference response: schema-invalid ${error.outputKind} ${error.requiredToolName ? "tool arguments" : "structured output"}: ${error.repairMessage}`;
		case "provider_avatar_description_validation":
			return `Invalid profile image description response: ${error.repairMessage}`;
		case "provider_compaction_output_limit": {
			const details = [error.finishReason, error.nativeFinishReason].filter(Boolean).join("/");
			return `Context compaction ran out of output budget${details ? ` (${details})` : ""}.`;
		}
		case "provider_empty_response":
			return "The inference provider returned an empty response.";
		case "provider_request_timeout":
			return `The inference provider did not respond within ${seconds(error.timeoutMs)} seconds.`;
		case "provider_response_body_timeout":
			return `The inference response did not finish within ${seconds(error.timeoutMs)} seconds.`;
		case "provider_stream_idle_timeout":
			return `The inference stream stopped responding after ${seconds(error.timeoutMs)} seconds.`;
		case "runtime_operation_timeout":
			return `${error.operation ?? "Bickr operation"} did not finish within ${seconds(error.timeoutMs)} seconds.`;
		case "prompt_context_budget_exceeded":
			return `My context exceeds the configured budget: ${error.promptTokens} prompt tokens exceeds the ${error.allowedPromptTokens} token prompt limit.`;
		case "prompt_context_compaction_limit":
			return `Context compaction could not shrink my context enough after ${error.attempts ?? 0} attempts: ${error.promptTokens} prompt tokens still exceeds the ${error.allowedPromptTokens} token prompt limit.`;
		case "persistent_compaction_reduction_failure":
			return `The Bickr app paused this participant because context compaction did not produce a shorter summary after ${error.attempts} attempts.`;
		case "runtime_error":
			return `The Bickr app reported an error during this visit: ${error.message}`;
	}
}

export function compactionReasoningRefusalMessage(refusal: CompactionReasoningRefusal): string {
	switch (refusal.kind) {
		case "no_supported_effort":
			return `Compaction requires reasoning effort ${refusal.required.effort}, but this model does not support reasoning.`;
	}
}

function seconds(timeoutMs: number): number {
	return Math.round(timeoutMs / 1000);
}
