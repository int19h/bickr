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
	compactionReasoningFloor: CompactionReasoningFloor;
	structuredOutputCompaction: boolean;
	defaultCompactionMode: BotCompactionMode;
	defaultReasoningEffort?: Exclude<BotInferenceReasoningEffort, "default">;
	defaultToolCalls: BotInferenceToolCalls;
};

export type CompactionReasoningEffort = Exclude<BotInferenceReasoningEffort, "default" | "none">;

export type CompactionReasoningFloor =
	| { kind: "reasoning_disabled" }
	| { kind: "model_default" }
	| { kind: "explicit_effort"; effort: CompactionReasoningEffort };

export type CompactionReasoningSelection =
	| { kind: "reasoning_disabled" }
	| { kind: "model_default"; effort?: Exclude<BotInferenceReasoningEffort, "default"> }
	| { kind: "explicit_effort"; effort: CompactionReasoningEffort };

export type CompactionReasoningRuntimeFallback =
	| { kind: "none" }
	| { kind: "unknown_model"; selection: Extract<CompactionReasoningSelection, { kind: "model_default" }> };

export type CompactionReasoningPolicy = {
	floor: CompactionReasoningFloor;
	knownFailure?: "reasoning_rejected" | "server_tool_crash";
	modelDefaultSelection: Extract<CompactionReasoningSelection, { kind: "model_default" }>;
	runtimeFallback: CompactionReasoningRuntimeFallback;
	selection: CompactionReasoningSelection;
	source: "custom_provider" | "openrouter_generated" | "openrouter_manual" | "openrouter_semantic_override" | "openrouter_unknown";
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
	compactionReasoningFloor: { kind: "model_default" },
	structuredOutputCompaction: false,
	defaultCompactionMode: "tool_call_cache_friendly",
	defaultToolCalls: "railroad",
} as const satisfies OpenRouterModelPolicy;

const permissiveCustomProviderPolicy = {
	prefill: true,
	structuredOutputs: true,
	structuredOutputCompaction: true,
	compactionReasoningFloor: { kind: "reasoning_disabled" },
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

// These exact-model overrides capture semantic compaction requirements that
// request-shape probes cannot establish. DeepSeek V4 Flash intermittently
// copied a retained summary verbatim with reasoning disabled, while the same
// request reduced correctly at low. Remove this entry only after production
// evidence establishes that disabled reasoning reliably reduces summaries.
// Keep this sparse overlay separate from generated capabilities so refreshing
// probes cannot erase it or shadow the generated model row.
const semanticCompactionReasoningOverrides = new Map<string, CompactionReasoningFloor>([
	["deepseek/deepseek-v4-flash-0731", { kind: "explicit_effort", effort: "low" }],
]);

const generatedOpenRouterModelCapabilities = new Map<string, OpenRouterModelCapabilities>(
	generatedOpenRouterModelCapabilityEntries.map(([model, capabilities]) => [model, capabilities]),
);

// xiaomi/fp8 accepts the simple JSON-schema probe, but the larger compaction
// schema path can repeat the input instead of producing a reducing summary.
// It can also mask compaction reasoning=none rejection as an internal server
// error when OpenRouter server tools are present, so the compaction plan should
// select the model default (currently minimal) before constructing that request.
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
	const compactionReasoningFloor = compactionReasoningFloorResolutionForGeneratedModel(
		normalized,
		capabilities,
		providerRouting,
	).floor;
	return {
		...capabilities,
		compactionReasoningFloor,
		structuredOutputCompaction,
		defaultCompactionMode: structuredOutputCompaction ? "structured_output" : "tool_call_cache_friendly",
		defaultReasoningEffort: "minimal",
		defaultToolCalls: capabilities.requiredToolCalls ? "require" : "railroad",
	};
}

export function providerModelPolicy(model: string | undefined, openRouter: boolean, providerRouting?: JsonObject): OpenRouterModelPolicy {
	return openRouter ? openRouterModelPolicy(model, providerRouting) : permissiveCustomProviderPolicy;
}

export function compactionReasoningPolicyForModel(
	model: string | undefined,
	openRouter: boolean,
	providerRouting?: JsonObject,
): CompactionReasoningPolicy {
	if (!openRouter) {
		return compactionReasoningPolicy({
			floor: permissiveCustomProviderPolicy.compactionReasoningFloor,
			modelDefaultEffort: permissiveCustomProviderPolicy.defaultReasoningEffort,
			runtimeFallback: "unknown_model",
			source: "custom_provider",
		});
	}
	const normalized = normalizedOpenRouterModelId(model);
	if (!normalized) {
		return compactionReasoningPolicy({
			floor: openRouterFreeModelPolicy.compactionReasoningFloor,
			modelDefaultEffort: undefined,
			runtimeFallback: "none",
			source: "openrouter_manual",
		});
	}
	const manual = manualOpenRouterModelPolicies[normalized];
	if (manual) {
		return compactionReasoningPolicy({
			floor: manual.compactionReasoningFloor,
			modelDefaultEffort: manual.defaultReasoningEffort,
			runtimeFallback: "none",
			source: "openrouter_manual",
		});
	}
	const capabilities = generatedOpenRouterModelCapabilities.get(normalized);
	if (!capabilities) {
		return compactionReasoningPolicy({
			floor: openRouterFreeModelPolicy.compactionReasoningFloor,
			modelDefaultEffort: undefined,
			runtimeFallback: "none",
			source: "openrouter_unknown",
		});
	}
	const floorResolution = compactionReasoningFloorResolutionForGeneratedModel(normalized, capabilities, providerRouting);
	return compactionReasoningPolicy({
		floor: floorResolution.floor,
		...(floorResolution.knownFailure ? { knownFailure: floorResolution.knownFailure } : {}),
		modelDefaultEffort: "minimal",
		runtimeFallback: "none",
		source: floorResolution.source,
	});
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

function compactionReasoningFloorResolutionForGeneratedModel(
	normalizedModel: string,
	capabilities: OpenRouterModelCapabilities,
	providerRouting: JsonObject | undefined,
): Pick<CompactionReasoningPolicy, "floor" | "knownFailure" | "source"> {
	const generatedFloor = compactionReasoningFloorForCapabilities(capabilities);
	const knownFailure = compactionReasoningKnownFailure(normalizedModel, providerRouting);
	const routeFloor = knownFailure
		? modelDefaultCompactionReasoningFloor
		: generatedFloor;
	const semanticOverride = semanticCompactionReasoningOverrides.get(normalizedModel);
	return {
		floor: semanticOverride ? strongerCompactionReasoningFloor(routeFloor, semanticOverride) : routeFloor,
		...(knownFailure ? { knownFailure } : {}),
		source: semanticOverride ? "openrouter_semantic_override" : "openrouter_generated",
	};
}

function compactionReasoningKnownFailure(
	normalizedModel: string,
	providerRouting: JsonObject | undefined,
): CompactionReasoningPolicy["knownFailure"] | undefined {
	if (normalizedModel.startsWith("xiaomi/") && providerRoutingSelectsProvider(providerRouting, xiaomiFp8ProviderRoute)) {
		return "server_tool_crash";
	}
	return undefined;
}

const reasoningDisabledCompactionReasoningFloor = { kind: "reasoning_disabled" } as const satisfies CompactionReasoningFloor;
const modelDefaultCompactionReasoningFloor = { kind: "model_default" } as const satisfies CompactionReasoningFloor;

function compactionReasoningFloorForCapabilities(capabilities: OpenRouterModelCapabilities): CompactionReasoningFloor {
	return capabilities.disabledReasoning ? reasoningDisabledCompactionReasoningFloor : modelDefaultCompactionReasoningFloor;
}

function strongerCompactionReasoningFloor(
	left: CompactionReasoningFloor,
	right: CompactionReasoningFloor,
): CompactionReasoningFloor {
	if (left.kind === "explicit_effort" && right.kind === "explicit_effort") {
		return compactionReasoningEffortRank(left.effort) >= compactionReasoningEffortRank(right.effort) ? left : right;
	}
	return compactionReasoningFloorRank(left) >= compactionReasoningFloorRank(right) ? left : right;
}

function compactionReasoningFloorRank(floor: CompactionReasoningFloor): number {
	switch (floor.kind) {
		case "reasoning_disabled":
			return 0;
		case "model_default":
			return 1;
		case "explicit_effort":
			return 2;
		default:
			return unreachableCompactionReasoningValue(floor);
	}
}

function compactionReasoningEffortRank(effort: CompactionReasoningEffort): number {
	switch (effort) {
		case "minimal":
			return 0;
		case "low":
			return 1;
		case "medium":
			return 2;
		case "high":
			return 3;
		case "xhigh":
			return 4;
		default:
			return unreachableCompactionReasoningValue(effort);
	}
}

function compactionReasoningSelection(
	floor: CompactionReasoningFloor,
	modelDefaultEffort: Exclude<BotInferenceReasoningEffort, "default"> | undefined,
): CompactionReasoningSelection {
	switch (floor.kind) {
		case "reasoning_disabled":
			return { kind: "reasoning_disabled" };
		case "model_default":
			return modelDefaultCompactionReasoningSelection(modelDefaultEffort);
		case "explicit_effort": {
			const effort = modelDefaultEffort && modelDefaultEffort !== "none" &&
				compactionReasoningEffortRank(modelDefaultEffort) > compactionReasoningEffortRank(floor.effort)
				? modelDefaultEffort
				: floor.effort;
			return { kind: "explicit_effort", effort };
		}
		default:
			return unreachableCompactionReasoningValue(floor);
	}
}

function compactionReasoningPolicy(input: {
	floor: CompactionReasoningFloor;
	knownFailure?: CompactionReasoningPolicy["knownFailure"];
	modelDefaultEffort: Exclude<BotInferenceReasoningEffort, "default"> | undefined;
	runtimeFallback: CompactionReasoningRuntimeFallback["kind"];
	source: CompactionReasoningPolicy["source"];
}): CompactionReasoningPolicy {
	const modelDefaultSelection = modelDefaultCompactionReasoningSelection(input.modelDefaultEffort);
	const selection = compactionReasoningSelection(input.floor, input.modelDefaultEffort);
	return {
		floor: input.floor,
		...(input.knownFailure ? { knownFailure: input.knownFailure } : {}),
		modelDefaultSelection,
		runtimeFallback: input.runtimeFallback === "unknown_model"
			? {
					kind: "unknown_model",
					selection: modelDefaultSelection,
				}
			: { kind: "none" },
		selection,
		source: input.source,
	};
}

function modelDefaultCompactionReasoningSelection(
	effort: Exclude<BotInferenceReasoningEffort, "default"> | undefined,
): Extract<CompactionReasoningSelection, { kind: "model_default" }> {
	return { kind: "model_default", ...(effort ? { effort } : {}) };
}

function unreachableCompactionReasoningValue(value: never): never {
	throw new Error(`Unhandled compaction reasoning value: ${String(value)}`);
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
