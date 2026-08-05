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
			return `Context compaction isolated repair failed to produce a shorter summary after ${error.attempts} attempts. This participant has been paused so it does not keep retrying the same oversized context.`;
		case "runtime_error":
			return error.message;
	}
}

export function botFacingRuntimeErrorMessage(error: RuntimeErrorCause | string | undefined): string | undefined {
	if (!error) {
		return undefined;
	}
	if (typeof error === "string") {
		return `Bickr Terminal reported an error during this visit: ${error}`;
	}
	switch (error.kind) {
		case "compaction_reasoning_refusal":
			return `Bickr Terminal could not select a supported context-compaction reasoning level: ${compactionReasoningRefusalMessage(error.refusal)}`;
		case "provider_request":
			return `Bickr Terminal request failed with status ${error.status} at the configured service${error.body ? `. Response: ${error.body}` : "."}`;
		case "provider_loop_request": {
			const cause = botFacingRuntimeErrorMessage(error.cause);
			if (error.attempts <= 1) {
				return cause;
			}
			return `Bickr Terminal tried ${error.attempts} times to reach the configured service${cause ? `. Last error: ${cause}` : "."}`;
		}
		case "provider_compaction_request":
			return botFacingRuntimeErrorMessage(error.cause);
		case "provider_structured_output_validation":
			return `Bickr Terminal could not use the configured service response: schema-invalid ${error.outputKind} ${error.requiredToolName ? "tool arguments" : "structured output"}: ${error.repairMessage}`;
		case "provider_avatar_description_validation":
			return `Bickr Terminal could not use the profile image description response: ${error.repairMessage}`;
		case "provider_compaction_output_limit": {
			const details = [error.finishReason, error.nativeFinishReason].filter(Boolean).join("/");
			return `Bickr Terminal ran out of compaction output budget${details ? ` (${details})` : ""}.`;
		}
		case "provider_empty_response":
			return "Bickr Terminal received an empty response from the configured service.";
		case "provider_request_timeout":
			return `Bickr Terminal did not respond within ${seconds(error.timeoutMs)} seconds.`;
		case "provider_response_body_timeout":
			return `Bickr Terminal response did not finish within ${seconds(error.timeoutMs)} seconds.`;
		case "provider_stream_idle_timeout":
			return `Bickr Terminal stopped responding after ${seconds(error.timeoutMs)} seconds.`;
		case "runtime_operation_timeout":
			return `${error.operation ?? "Bickr Terminal"} did not finish within ${seconds(error.timeoutMs)} seconds.`;
		case "prompt_context_budget_exceeded":
			return `Bickr Terminal could not fit my context into the configured budget: ${error.promptTokens} prompt tokens exceeds the ${error.allowedPromptTokens} token prompt limit.`;
		case "prompt_context_compaction_limit":
			return `Bickr Terminal could not shrink my context enough after ${error.attempts ?? 0} attempts: ${error.promptTokens} prompt tokens still exceeds the ${error.allowedPromptTokens} token prompt limit.`;
		case "persistent_compaction_reduction_failure":
			return `Bickr Terminal paused this participant because context compaction did not produce a shorter summary after ${error.attempts} attempts.`;
		case "runtime_error":
			return `Bickr Terminal reported an error during this visit: ${error.message}`;
	}
}

export function compactionReasoningRefusalMessage(refusal: CompactionReasoningRefusal): string {
	switch (refusal.kind) {
		case "support_unknown_for_required_effort":
			return `Compaction requires reasoning effort ${refusal.requiredEffort}, but provider support for that effort is unknown.`;
		case "no_supported_effort": {
			const requirement = refusal.required.kind === "explicit_effort"
				? `reasoning effort ${refusal.required.effort}`
				: "model-default reasoning";
			const supported = refusal.supportedEfforts.length > 0
				? ` Known supported efforts: ${refusal.supportedEfforts.join(", ")}.`
				: " No supported compaction reasoning effort is known.";
			return `Compaction requires ${requirement}, but the provider has no supported selection at or above that requirement.${supported}`;
		}
	}
}

function seconds(timeoutMs: number): number {
	return Math.round(timeoutMs / 1000);
}
