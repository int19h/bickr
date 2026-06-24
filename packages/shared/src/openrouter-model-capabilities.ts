import {
	type BotCompactionMode,
	type BotInferenceReasoningEffort,
	type BotInferenceToolCalls,
	type BotStructuredToolCalls,
	type JsonObject,
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
	structuredOutputCompaction: boolean;
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
	structuredOutputCompaction: false,
	defaultCompactionMode: "tool_call_cache_friendly",
	defaultToolCalls: "railroad",
} as const satisfies OpenRouterModelPolicy;

const permissiveCustomProviderPolicy = {
	prefill: true,
	structuredOutputs: true,
	structuredOutputCompaction: true,
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

// xiaomi/fp8 accepts the simple JSON-schema probe, but the larger compaction
// schema path can repeat the input instead of producing a reducing summary.
const xiaomiFp8ProviderRoute = "xiaomi/fp8";
const providerSelectionRoutingKeys = ["only", "order"] as const;

export function openRouterModelCapabilities(model: string | undefined): OpenRouterModelCapabilities {
	const normalized = normalizedOpenRouterModelId(model);
	if (!normalized) {
		return conservativeOpenRouterModelCapabilities;
	}
	return manualOpenRouterModelPolicies[normalized] ?? generatedOpenRouterModelCapabilities.get(normalized) ?? conservativeOpenRouterModelCapabilities;
}

export function openRouterModelPolicy(model: string | undefined, providerRouting?: JsonObject): OpenRouterModelPolicy {
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
	const structuredOutputCompaction = supportsStructuredOutputCompaction(normalized, capabilities, providerRouting);
	return {
		...capabilities,
		structuredOutputCompaction,
		defaultCompactionMode: structuredOutputCompaction ? "structured_output" : "tool_call_cache_friendly",
		defaultReasoningEffort: "minimal",
		defaultToolCalls: capabilities.requiredToolCalls ? "require" : "railroad",
	};
}

export function providerModelPolicy(model: string | undefined, openRouter: boolean, providerRouting?: JsonObject): OpenRouterModelPolicy {
	return openRouter ? openRouterModelPolicy(model, providerRouting) : permissiveCustomProviderPolicy;
}

export function effectiveReasoningEffortForModel(
	model: string | undefined,
	openRouter: boolean,
	value: BotInferenceReasoningEffort | undefined,
	providerRouting?: JsonObject,
): Exclude<BotInferenceReasoningEffort, "default"> | undefined {
	const policy = providerModelPolicy(model, openRouter, providerRouting);
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
	providerRouting?: JsonObject,
): BotInferenceToolCalls {
	const policy = providerModelPolicy(model, openRouter, providerRouting);
	const requested = value ?? policy.defaultToolCalls;
	return requested === "require" && !policy.requiredToolCalls ? "railroad" : requested;
}

export function effectiveStructuredToolCallsForModel(
	model: string | undefined,
	openRouter: boolean,
	value: BotInferenceToolCalls | BotStructuredToolCalls | undefined,
	providerRouting?: JsonObject,
): BotStructuredToolCalls {
	const toolCalls = effectiveToolCallsForModel(model, openRouter, value, providerRouting);
	return toolCalls === "require" ? "require" : "railroad";
}

export function effectiveSupportsPrefillForModel(
	model: string | undefined,
	openRouter: boolean,
	value: boolean | undefined,
	providerRouting?: JsonObject,
): boolean {
	const policy = providerModelPolicy(model, openRouter, providerRouting);
	return policy.prefill ? value ?? true : false;
}

export function effectiveCompactionModeForModel(
	model: string | undefined,
	openRouter: boolean,
	value: BotCompactionMode | undefined,
	providerRouting?: JsonObject,
): BotCompactionMode {
	const policy = providerModelPolicy(model, openRouter, providerRouting);
	const requested = value ?? policy.defaultCompactionMode;
	return requested === "structured_output" && !policy.structuredOutputCompaction ? "tool_call_cache_friendly" : requested;
}

export function modelSupportsReasoningNone(model: string | undefined, openRouter: boolean, providerRouting?: JsonObject): boolean {
	return providerModelPolicy(model, openRouter, providerRouting).disabledReasoning;
}

export function modelSupportsRequiredToolCalls(model: string | undefined, openRouter: boolean, providerRouting?: JsonObject): boolean {
	return providerModelPolicy(model, openRouter, providerRouting).requiredToolCalls;
}

export function modelSupportsStructuredOutputs(model: string | undefined, openRouter: boolean, providerRouting?: JsonObject): boolean {
	return providerModelPolicy(model, openRouter, providerRouting).structuredOutputs;
}

export function modelSupportsStructuredCompaction(model: string | undefined, openRouter: boolean, providerRouting?: JsonObject): boolean {
	return providerModelPolicy(model, openRouter, providerRouting).structuredOutputCompaction;
}

export function modelSupportsPrefill(model: string | undefined, openRouter: boolean, providerRouting?: JsonObject): boolean {
	return providerModelPolicy(model, openRouter, providerRouting).prefill;
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

function supportsStructuredOutputCompaction(
	normalizedModel: string,
	capabilities: OpenRouterModelCapabilities,
	providerRouting: JsonObject | undefined,
): boolean {
	if (!capabilities.structuredOutputs) {
		return false;
	}
	if (normalizedModel.startsWith("xiaomi/") && providerRoutingSelectsProvider(providerRouting, xiaomiFp8ProviderRoute)) {
		return false;
	}
	return true;
}

function providerRoutingSelectsProvider(providerRouting: JsonObject | undefined, providerId: string): boolean {
	if (!providerRouting) {
		return false;
	}
	const normalizedProviderId = providerId.toLowerCase();
	if (providerRoutingStringList(providerRouting.ignore).includes(normalizedProviderId)) {
		return false;
	}
	return providerSelectionRoutingKeys.some((key) => providerRoutingStringList(providerRouting[key]).includes(normalizedProviderId));
}

function providerRoutingStringList(value: unknown): string[] {
	if (typeof value === "string") {
		return [value.trim().toLowerCase()].filter(Boolean);
	}
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((item) => (typeof item === "string" ? [item.trim().toLowerCase()] : [])).filter(Boolean);
}
