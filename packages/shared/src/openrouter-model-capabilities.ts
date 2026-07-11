import {
	type BotCompactionMode,
	type BotInferenceReasoningEffort,
	type BotInferenceToolCalls,
	type BotStructuredToolCalls,
	type JsonObject,
} from "./model";
import { generatedOpenRouterModelCapabilityEntries } from "./openrouter-model-capabilities.generated";
import type { ProviderErrorCause } from "./runtime-errors";

export type OpenRouterModelCapabilities = {
	prefill: boolean;
	structuredOutputs: boolean;
	requiredToolCalls: boolean;
	disabledReasoning: boolean;
	cacheControl: boolean;
	contextLength?: number;
};

export type OpenRouterModelPolicy = OpenRouterModelCapabilities & {
	compactionReasoningNone: boolean;
	structuredOutputCompaction: boolean;
	defaultCompactionMode: BotCompactionMode;
	defaultReasoningEffort?: Exclude<BotInferenceReasoningEffort, "default">;
	defaultToolCalls: BotInferenceToolCalls;
};

export type CompactionReasoningNonePolicy = {
	knownFailure?: "reasoning_rejected" | "server_tool_crash";
	runtimeFallback: "none" | "unknown_model";
	source: "custom_provider" | "openrouter_generated" | "openrouter_manual" | "openrouter_unknown";
	supported: boolean;
};

export type UnknownModelCompactionReasoningFailure =
	| { kind: "reasoning_rejected"; reason: "unknown_model_reasoning_none_rejected" }
	| { kind: "server_tool_crash"; reason: "unknown_model_openrouter_server_tool_crash" };

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
	compactionReasoningNone: false,
	structuredOutputCompaction: false,
	defaultCompactionMode: "tool_call_cache_friendly",
	defaultToolCalls: "railroad",
} as const satisfies OpenRouterModelPolicy;

const permissiveCustomProviderPolicy = {
	prefill: true,
	structuredOutputs: true,
	structuredOutputCompaction: true,
	compactionReasoningNone: true,
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
// It can also mask compaction reasoning=none rejection as an internal server
// error when OpenRouter server tools are present, so the compaction plan should
// select minimal reasoning before constructing that request shape.
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
	const compactionReasoningNone = supportsCompactionReasoningNone(normalized, capabilities, providerRouting);
	return {
		...capabilities,
		compactionReasoningNone,
		structuredOutputCompaction,
		defaultCompactionMode: structuredOutputCompaction ? "structured_output" : "tool_call_cache_friendly",
		defaultReasoningEffort: "minimal",
		defaultToolCalls: capabilities.requiredToolCalls ? "require" : "railroad",
	};
}

export function providerModelPolicy(model: string | undefined, openRouter: boolean, providerRouting?: JsonObject): OpenRouterModelPolicy {
	return openRouter ? openRouterModelPolicy(model, providerRouting) : permissiveCustomProviderPolicy;
}

export function compactionReasoningNonePolicyForModel(
	model: string | undefined,
	openRouter: boolean,
	providerRouting?: JsonObject,
): CompactionReasoningNonePolicy {
	if (!openRouter) {
		return {
			runtimeFallback: "unknown_model",
			source: "custom_provider",
			supported: permissiveCustomProviderPolicy.compactionReasoningNone,
		};
	}
	const normalized = normalizedOpenRouterModelId(model);
	if (!normalized) {
		return { runtimeFallback: "none", source: "openrouter_manual", supported: openRouterFreeModelPolicy.compactionReasoningNone };
	}
	if (manualOpenRouterModelPolicies[normalized]) {
		return {
			runtimeFallback: "none",
			source: "openrouter_manual",
			supported: manualOpenRouterModelPolicies[normalized].compactionReasoningNone,
		};
	}
	const capabilities = generatedOpenRouterModelCapabilities.get(normalized);
	if (!capabilities) {
		return { runtimeFallback: "none", source: "openrouter_unknown", supported: openRouterFreeModelPolicy.compactionReasoningNone };
	}
	const knownFailure = compactionReasoningNoneKnownFailure(normalized, providerRouting);
	return {
		...(knownFailure ? { knownFailure } : {}),
		runtimeFallback: "none",
		source: "openrouter_generated",
		supported: supportsCompactionReasoningNone(normalized, capabilities, providerRouting),
	};
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

export function modelSupportsCompactionReasoningNone(model: string | undefined, openRouter: boolean, providerRouting?: JsonObject): boolean {
	return compactionReasoningNonePolicyForModel(model, openRouter, providerRouting).supported;
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

export function modelContextWindowTokensForModel(model: string | undefined, openRouter: boolean): number | undefined {
	const capabilities = openRouterModelCapabilities(model);
	if (!openRouter || capabilities.contextLength === undefined) {
		return undefined;
	}
	return Math.max(1, Math.floor(capabilities.contextLength));
}

export function effectiveContextWindowForModel(
	contextWindowTokens: number,
	model: string | undefined,
	openRouter: boolean,
): number {
	const modelContextWindowTokens = modelContextWindowTokensForModel(model, openRouter);
	const normalizedContextWindowTokens = Math.max(1, Math.floor(contextWindowTokens));
	if (modelContextWindowTokens === undefined) {
		return normalizedContextWindowTokens;
	}
	return Math.max(1, Math.min(modelContextWindowTokens, normalizedContextWindowTokens));
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

function supportsCompactionReasoningNone(
	normalizedModel: string,
	capabilities: OpenRouterModelCapabilities,
	providerRouting: JsonObject | undefined,
): boolean {
	if (compactionReasoningNoneKnownFailure(normalizedModel, providerRouting)) {
		return false;
	}
	return capabilities.disabledReasoning;
}

function compactionReasoningNoneKnownFailure(
	normalizedModel: string,
	providerRouting: JsonObject | undefined,
): CompactionReasoningNonePolicy["knownFailure"] | undefined {
	if (normalizedModel.startsWith("xiaomi/") && providerRoutingSelectsProvider(providerRouting, xiaomiFp8ProviderRoute)) {
		return "server_tool_crash";
	}
	return undefined;
}

export function classifyUnknownModelCompactionReasoningFailure(input: {
	body?: string;
	providerError?: ProviderErrorCause;
	requestIncludesOpenRouterServerTools: boolean;
	status: number;
}): UnknownModelCompactionReasoningFailure | null {
	const text = unknownModelProviderFailureText(input).toLowerCase();
	if (input.status >= 500 && input.status < 600 && input.requestIncludesOpenRouterServerTools && /\binternal server error\b/.test(text)) {
		return { kind: "server_tool_crash", reason: "unknown_model_openrouter_server_tool_crash" };
	}
	if (
		input.status >= 400 &&
		input.status < 500 &&
		/(?:\breasoning\b|reasoning[_ -]?effort)/.test(text) &&
		/(?:\bnone\b|disabl|unsupported|not supported|invalid|not allowed|must be one of|unrecognized|unknown)/.test(text)
	) {
		return { kind: "reasoning_rejected", reason: "unknown_model_reasoning_none_rejected" };
	}
	return null;
}

function unknownModelProviderFailureText(input: {
	body?: string;
	providerError?: Pick<ProviderErrorCause, "errorType" | "message" | "rawText">;
}): string {
	// Unknown-model fallback: this is the only place where Bickr matches provider
	// prose for compaction reasoning=none. Any recurring hit should become an
	// explicit generated/manual capability entry instead of expanding this helper.
	return [
		input.providerError?.errorType,
		input.providerError?.message,
		input.providerError?.rawText,
		input.body,
	].filter((part): part is string => Boolean(part)).join("\n");
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
