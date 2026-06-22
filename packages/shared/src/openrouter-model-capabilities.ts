import {
	type BotCompactionMode,
	type BotInferenceReasoningEffort,
	type BotInferenceToolCalls,
	type BotStructuredToolCalls,
} from "./model";
import { generatedOpenRouterModelCapabilityEntries } from "./openrouter-model-capabilities.generated";

export type OpenRouterModelCapabilities = {
	prefill: boolean;
	structuredOutputs: boolean;
	requiredToolCalls: boolean;
	disabledReasoning: boolean;
	cacheControl: boolean;
};

export type OpenRouterModelPolicy = OpenRouterModelCapabilities & {
	defaultCompactionMode: BotCompactionMode;
	defaultReasoningEffort?: Exclude<BotInferenceReasoningEffort, "default">;
	defaultToolCalls: BotInferenceToolCalls;
};

export const openRouterFreeModel = "openrouter/free";

const conservativeOpenRouterModelCapabilities = {
	prefill: false,
	structuredOutputs: false,
	requiredToolCalls: false,
	disabledReasoning: false,
	cacheControl: false,
} as const satisfies OpenRouterModelCapabilities;

const openRouterFreeModelPolicy = {
	...conservativeOpenRouterModelCapabilities,
	defaultCompactionMode: "tool_call_cache_friendly",
	defaultToolCalls: "railroad",
} as const satisfies OpenRouterModelPolicy;

const permissiveCustomProviderPolicy = {
	prefill: true,
	structuredOutputs: true,
	requiredToolCalls: true,
	disabledReasoning: true,
	cacheControl: false,
	defaultCompactionMode: "structured_output",
	defaultReasoningEffort: "minimal",
	defaultToolCalls: "require",
} as const satisfies OpenRouterModelPolicy;

const manualOpenRouterModelPolicies: Readonly<Record<string, OpenRouterModelPolicy>> = {
	// openrouter/free dispatches to many underlying models. Keep this entry
	// conservative so the shared fallback never emits request features that a
	// selected downstream provider might reject.
	[openRouterFreeModel]: openRouterFreeModelPolicy,
};

const generatedOpenRouterModelCapabilities = new Map<string, OpenRouterModelCapabilities>(
	generatedOpenRouterModelCapabilityEntries.map(([model, capabilities]) => [model, capabilities]),
);

export function openRouterModelCapabilities(model: string | undefined): OpenRouterModelCapabilities {
	const normalized = normalizedOpenRouterModelId(model);
	if (!normalized) {
		return conservativeOpenRouterModelCapabilities;
	}
	return manualOpenRouterModelPolicies[normalized] ?? generatedOpenRouterModelCapabilities.get(normalized) ?? conservativeOpenRouterModelCapabilities;
}

export function openRouterModelPolicy(model: string | undefined): OpenRouterModelPolicy {
	const normalized = normalizedOpenRouterModelId(model);
	if (!normalized) {
		return openRouterFreeModelPolicy;
	}
	const manual = manualOpenRouterModelPolicies[normalized];
	if (manual) {
		return manual;
	}
	const capabilities = generatedOpenRouterModelCapabilities.get(normalized);
	if (!capabilities) {
		return openRouterFreeModelPolicy;
	}
	return {
		...capabilities,
		defaultCompactionMode: capabilities.structuredOutputs ? "structured_output" : "tool_call_cache_friendly",
		defaultReasoningEffort: "minimal",
		defaultToolCalls: capabilities.requiredToolCalls ? "require" : "railroad",
	};
}

export function providerModelPolicy(model: string | undefined, openRouter: boolean): OpenRouterModelPolicy {
	return openRouter ? openRouterModelPolicy(model) : permissiveCustomProviderPolicy;
}

export function effectiveReasoningEffortForModel(
	model: string | undefined,
	openRouter: boolean,
	value: BotInferenceReasoningEffort | undefined,
): Exclude<BotInferenceReasoningEffort, "default"> | undefined {
	const policy = providerModelPolicy(model, openRouter);
	if (!value || value === "default") {
		return policy.defaultReasoningEffort;
	}
	if (value === "none" && !policy.disabledReasoning) {
		return "minimal";
	}
	return value;
}

export function effectiveToolCallsForModel(
	model: string | undefined,
	openRouter: boolean,
	value: BotInferenceToolCalls | undefined,
): BotInferenceToolCalls {
	const policy = providerModelPolicy(model, openRouter);
	const requested = value ?? policy.defaultToolCalls;
	return requested === "require" && !policy.requiredToolCalls ? "railroad" : requested;
}

export function effectiveStructuredToolCallsForModel(
	model: string | undefined,
	openRouter: boolean,
	value: BotInferenceToolCalls | BotStructuredToolCalls | undefined,
): BotStructuredToolCalls {
	const toolCalls = effectiveToolCallsForModel(model, openRouter, value);
	return toolCalls === "require" ? "require" : "railroad";
}

export function effectiveSupportsPrefillForModel(
	model: string | undefined,
	openRouter: boolean,
	value: boolean | undefined,
): boolean {
	const policy = providerModelPolicy(model, openRouter);
	return policy.prefill ? value ?? true : false;
}

export function effectiveCompactionModeForModel(
	model: string | undefined,
	openRouter: boolean,
	value: BotCompactionMode | undefined,
): BotCompactionMode {
	const policy = providerModelPolicy(model, openRouter);
	const requested = value ?? policy.defaultCompactionMode;
	return requested === "structured_output" && !policy.structuredOutputs ? "tool_call_cache_friendly" : requested;
}

export function modelSupportsReasoningNone(model: string | undefined, openRouter: boolean): boolean {
	return providerModelPolicy(model, openRouter).disabledReasoning;
}

export function modelSupportsRequiredToolCalls(model: string | undefined, openRouter: boolean): boolean {
	return providerModelPolicy(model, openRouter).requiredToolCalls;
}

export function modelSupportsStructuredOutputs(model: string | undefined, openRouter: boolean): boolean {
	return providerModelPolicy(model, openRouter).structuredOutputs;
}

export function modelSupportsPrefill(model: string | undefined, openRouter: boolean): boolean {
	return providerModelPolicy(model, openRouter).prefill;
}

export function modelSupportsPromptCacheControl(model: string | undefined, openRouter: boolean): boolean {
	if (!openRouter) {
		return false;
	}
	return openRouterModelCapabilities(model).cacheControl;
}

function normalizedOpenRouterModelId(model: string | undefined): string {
	return model?.trim().toLowerCase() ?? "";
}
