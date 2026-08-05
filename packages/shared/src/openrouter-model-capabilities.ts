import {
	type BotCompactionMode,
	type BotCompactionReasoningEffort,
	type BotCompactionReasoningRequest,
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
	compactionReasoning: CompactionReasoningCapabilities;
	contextLength?: number;
};

export type OpenRouterModelPolicy = OpenRouterModelCapabilities & {
	compactionReasoningFloor: CompactionReasoningFloor;
	structuredOutputCompaction: boolean;
	defaultCompactionMode: BotCompactionMode;
	defaultReasoningEffort?: Exclude<BotInferenceReasoningEffort, "default">;
	defaultToolCalls: BotInferenceToolCalls;
};

export type CompactionReasoningEffort = BotCompactionReasoningEffort;

export type CompactionReasoningFloor = BotCompactionReasoningRequest;

export type CompactionReasoningEffortSupport =
	| { kind: "known"; efforts: readonly CompactionReasoningEffort[] }
	| { kind: "partially_known"; efforts: readonly CompactionReasoningEffort[] }
	| { kind: "unknown" }
	| { kind: "unsupported" };

export type CompactionReasoningModelDefault =
	| { kind: "absent" }
	| {
			kind: "provider_default";
			relativeOrder: "below_minimal" | "above_xhigh" | "unknown";
	  }
	| { kind: "explicit_effort"; effort: CompactionReasoningEffort };

export type CompactionReasoningCapabilities = {
	support: CompactionReasoningEffortSupport;
	modelDefault: CompactionReasoningModelDefault;
};

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

export type CompactionReasoningProvenance = {
	configuration: CompactionReasoningFloor | null;
	modelDefault: CompactionReasoningModelDefault;
	safetyFloor: CompactionReasoningFloor;
	learnedFloor: CompactionReasoningFloor | null;
	baselineSelection: CompactionReasoningSelection;
	support: CompactionReasoningEffortSupport["kind"];
	policySource: CompactionReasoningPolicy["source"];
};

export type CompactionReasoningRefusal =
	| {
			kind: "support_unknown_for_required_effort";
			requiredEffort: CompactionReasoningEffort;
	  }
	| {
			kind: "model_default_order_unknown_for_required_effort";
			requiredEffort: CompactionReasoningEffort;
	  }
	| {
			kind: "no_supported_effort";
			required: Extract<CompactionReasoningSelection, { kind: "model_default" | "explicit_effort" }>;
			supportedEfforts: readonly CompactionReasoningEffort[];
	  };

export type CompactionReasoningResolution =
	| {
			kind: "selected";
			selection: CompactionReasoningSelection;
			runtimeFallback: CompactionReasoningRuntimeFallback;
			provenance: CompactionReasoningProvenance;
	  }
	| {
			kind: "refused";
			refusal: CompactionReasoningRefusal;
			provenance: CompactionReasoningProvenance;
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
	compactionReasoning: {
		support: { kind: "unknown" },
		modelDefault: { kind: "provider_default", relativeOrder: "unknown" },
	},
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
	compactionReasoning: {
		support: { kind: "unknown" },
		modelDefault: { kind: "explicit_effort", effort: "minimal" },
	},
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

const generatedOpenRouterModelCapabilities = validatedGeneratedCapabilitiesMap();

// xiaomi/fp8 accepts the simple JSON-schema probe, but the larger compaction
// schema path can repeat the input instead of producing a reducing summary.
// It can also mask compaction reasoning=none rejection as an internal server
// error when OpenRouter server tools are present, so the compaction plan should
// select the registry-owned model default before constructing that request.
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
		// Ordinary-loop defaults are deliberately unchanged in Phase 2. The
		// separate compaction default above is metadata-driven.
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
			modelDefault: permissiveCustomProviderPolicy.compactionReasoning.modelDefault,
			runtimeFallback: "unknown_model",
			source: "custom_provider",
		});
	}
	const normalized = normalizedOpenRouterModelId(model);
	if (!normalized) {
		return compactionReasoningPolicy({
			floor: openRouterFreeModelPolicy.compactionReasoningFloor,
			modelDefault: openRouterFreeModelPolicy.compactionReasoning.modelDefault,
			runtimeFallback: "none",
			source: "openrouter_manual",
		});
	}
	const manual = manualOpenRouterModelPolicies[normalized];
	if (manual) {
		return compactionReasoningPolicy({
			floor: manual.compactionReasoningFloor,
			modelDefault: manual.compactionReasoning.modelDefault,
			runtimeFallback: "none",
			source: "openrouter_manual",
		});
	}
	const capabilities = generatedOpenRouterModelCapabilities.get(normalized);
	if (!capabilities) {
		return compactionReasoningPolicy({
			floor: openRouterFreeModelPolicy.compactionReasoningFloor,
			modelDefault: conservativeOpenRouterModelCapabilities.compactionReasoning.modelDefault,
			runtimeFallback: "none",
			source: "openrouter_unknown",
		});
	}
	const floorResolution = compactionReasoningFloorResolutionForGeneratedModel(normalized, capabilities, providerRouting);
	return compactionReasoningPolicy({
		floor: floorResolution.floor,
		...(floorResolution.knownFailure ? { knownFailure: floorResolution.knownFailure } : {}),
		modelDefault: capabilities.compactionReasoning.modelDefault,
		runtimeFallback: "none",
		source: floorResolution.source,
	});
}

export function compactionReasoningCapabilitiesForModel(
	model: string | undefined,
	openRouter: boolean,
	providerRouting?: JsonObject,
): CompactionReasoningCapabilities {
	return providerModelPolicy(model, openRouter, providerRouting).compactionReasoning;
}

export function resolveCompactionReasoningSelection(input: {
	policy: CompactionReasoningPolicy;
	request?: CompactionReasoningFloor;
	capabilities: CompactionReasoningCapabilities;
	learnedFloor?: CompactionReasoningFloor;
}): CompactionReasoningResolution {
	const joinedFloor = [input.request, input.learnedFloor]
		.filter((floor): floor is CompactionReasoningFloor => floor !== undefined)
		.reduce(strongerCompactionReasoningFloor, input.policy.floor);
	const provenance: CompactionReasoningProvenance = {
		configuration: input.request ?? null,
		modelDefault: input.capabilities.modelDefault,
		safetyFloor: input.policy.floor,
		learnedFloor: input.learnedFloor ?? null,
		baselineSelection: input.policy.selection,
		support: input.capabilities.support.kind,
		policySource: input.policy.source,
	};
	if (sameCompactionReasoningFloor(joinedFloor, input.policy.floor) && joinedFloor.kind !== "explicit_effort") {
		return selectedCompactionReasoningResolution(input.policy.selection, input.policy.runtimeFallback, provenance);
	}
	const selectionResolution = compactionReasoningSelectionForJoinedFloor(joinedFloor, input.capabilities.modelDefault);
	if (selectionResolution.kind === "refused") {
		return {
			kind: "refused",
			refusal: selectionResolution.refusal,
			provenance,
		};
	}
	const requiredSelection = selectionResolution.selection;

	if (requiredSelection.kind === "reasoning_disabled") {
		return selectedCompactionReasoningResolution(requiredSelection, input.policy.runtimeFallback, provenance);
	}
	if (requiredSelection.kind === "model_default") {
		if (input.capabilities.modelDefault.kind === "absent") {
			return {
				kind: "refused",
				refusal: {
					kind: "no_supported_effort",
					required: requiredSelection,
					supportedEfforts: supportedCompactionReasoningEfforts(input.capabilities.support),
				},
				provenance,
			};
		}
		return selectedCompactionReasoningResolution(requiredSelection, { kind: "none" }, provenance);
	}

	const requiredEffort = requiredSelection.effort;
	switch (input.capabilities.support.kind) {
		case "known":
		case "partially_known": {
			const effort = leastSupportedCompactionReasoningEffortAtOrAbove(
				input.capabilities.support.efforts,
				requiredEffort,
			);
			if (effort) {
				return selectedCompactionReasoningResolution(
					{ kind: "explicit_effort", effort },
					{ kind: "none" },
					provenance,
				);
			}
			if (input.capabilities.support.kind === "partially_known") {
				return unknownCompactionReasoningSupportResolution(requiredSelection, input.learnedFloor, provenance);
			}
			return {
				kind: "refused",
				refusal: {
					kind: "no_supported_effort",
					required: requiredSelection,
					supportedEfforts: orderedCompactionReasoningEfforts(input.capabilities.support.efforts),
				},
				provenance,
			};
		}
		case "unsupported":
			return {
				kind: "refused",
				refusal: { kind: "no_supported_effort", required: requiredSelection, supportedEfforts: [] },
				provenance,
			};
		case "unknown":
			return unknownCompactionReasoningSupportResolution(requiredSelection, input.learnedFloor, provenance);
		default:
			return unreachableCompactionReasoningValue(input.capabilities.support);
	}
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

function sameCompactionReasoningFloor(left: CompactionReasoningFloor, right: CompactionReasoningFloor): boolean {
	return left.kind === right.kind &&
		(left.kind !== "explicit_effort" || (right.kind === "explicit_effort" && left.effort === right.effort));
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
	modelDefaultEffort: CompactionReasoningEffort | undefined,
): CompactionReasoningSelection {
	switch (floor.kind) {
		case "reasoning_disabled":
			return { kind: "reasoning_disabled" };
		case "model_default":
			return { kind: "model_default", ...(modelDefaultEffort ? { effort: modelDefaultEffort } : {}) };
		case "explicit_effort": {
			const effort = modelDefaultEffort &&
				compactionReasoningEffortRank(modelDefaultEffort) > compactionReasoningEffortRank(floor.effort)
				? modelDefaultEffort
				: floor.effort;
			return { kind: "explicit_effort", effort };
		}
		default:
			return unreachableCompactionReasoningValue(floor);
	}
}

function compactionReasoningSelectionForJoinedFloor(
	floor: CompactionReasoningFloor,
	modelDefault: CompactionReasoningModelDefault,
):
	| { kind: "selected"; selection: CompactionReasoningSelection }
	| {
			kind: "refused";
			refusal: Extract<CompactionReasoningRefusal, { kind: "model_default_order_unknown_for_required_effort" }>;
	  } {
	switch (floor.kind) {
		case "reasoning_disabled":
			return { kind: "selected", selection: { kind: "reasoning_disabled" } };
		case "model_default":
			return { kind: "selected", selection: modelDefaultCompactionReasoningSelection(modelDefault) };
		case "explicit_effort":
			switch (modelDefault.kind) {
				case "absent":
					return { kind: "selected", selection: { kind: "explicit_effort", effort: floor.effort } };
				case "explicit_effort":
					return {
						kind: "selected",
						selection: compactionReasoningSelection(floor, modelDefault.effort),
					};
				case "provider_default":
					switch (modelDefault.relativeOrder) {
						case "below_minimal":
							return { kind: "selected", selection: { kind: "explicit_effort", effort: floor.effort } };
						case "above_xhigh":
							return { kind: "selected", selection: modelDefaultCompactionReasoningSelection(modelDefault) };
						case "unknown":
							return {
								kind: "refused",
								refusal: {
									kind: "model_default_order_unknown_for_required_effort",
									requiredEffort: floor.effort,
								},
							};
						default:
							return unreachableCompactionReasoningValue(modelDefault.relativeOrder);
					}
				default:
					return unreachableCompactionReasoningValue(modelDefault);
			}
		default:
			return unreachableCompactionReasoningValue(floor);
	}
}

function compactionReasoningPolicy(input: {
	floor: CompactionReasoningFloor;
	knownFailure?: CompactionReasoningPolicy["knownFailure"];
	modelDefault: CompactionReasoningModelDefault;
	runtimeFallback: CompactionReasoningRuntimeFallback["kind"];
	source: CompactionReasoningPolicy["source"];
}): CompactionReasoningPolicy {
	const modelDefaultSelection = modelDefaultCompactionReasoningSelection(input.modelDefault);
	const selection = baselineCompactionReasoningSelection(input.floor, input.modelDefault);
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

function baselineCompactionReasoningSelection(
	floor: CompactionReasoningFloor,
	modelDefault: CompactionReasoningModelDefault,
): CompactionReasoningSelection {
	if (floor.kind !== "explicit_effort") {
		return compactionReasoningSelection(floor, modelDefaultEffort(modelDefaultCompactionReasoningSelection(modelDefault)));
	}
	if (modelDefault.kind === "explicit_effort") {
		return compactionReasoningSelection(floor, modelDefault.effort);
	}
	if (modelDefault.kind === "provider_default" && modelDefault.relativeOrder === "above_xhigh") {
		return modelDefaultCompactionReasoningSelection(modelDefault);
	}
	// An incomparable default is resolved by the canonical operation. Retain
	// the settled policy selection here as baseline evidence, never as proof
	// that the explicit floor dominates that default.
	return { kind: "explicit_effort", effort: floor.effort };
}

function modelDefaultCompactionReasoningSelection(
	modelDefault: CompactionReasoningModelDefault,
): Extract<CompactionReasoningSelection, { kind: "model_default" }> {
	return {
		kind: "model_default",
		...(modelDefault.kind === "explicit_effort" ? { effort: modelDefault.effort } : {}),
	};
}

function modelDefaultEffort(
	selection: Extract<CompactionReasoningSelection, { kind: "model_default" }>,
): CompactionReasoningEffort | undefined {
	return selection.effort && selection.effort !== "none" ? selection.effort : undefined;
}

function selectedCompactionReasoningResolution(
	selection: CompactionReasoningSelection,
	runtimeFallback: CompactionReasoningRuntimeFallback,
	provenance: CompactionReasoningProvenance,
): Extract<CompactionReasoningResolution, { kind: "selected" }> {
	return {
		kind: "selected",
		selection,
		runtimeFallback: selection.kind === "reasoning_disabled" ? runtimeFallback : { kind: "none" },
		provenance,
	};
}

function supportedCompactionReasoningEfforts(
	support: CompactionReasoningEffortSupport,
): readonly CompactionReasoningEffort[] {
	return support.kind === "known" || support.kind === "partially_known"
		? orderedCompactionReasoningEfforts(support.efforts)
		: [];
}

function unknownCompactionReasoningSupportResolution(
	required: Extract<CompactionReasoningSelection, { kind: "explicit_effort" }>,
	learnedFloor: CompactionReasoningFloor | undefined,
	provenance: CompactionReasoningProvenance,
): CompactionReasoningResolution {
	const learnedEffort = learnedFloor?.kind === "explicit_effort" ? learnedFloor.effort : undefined;
	if (
		learnedEffort &&
		compactionReasoningEffortRank(learnedEffort) >= compactionReasoningEffortRank(required.effort)
	) {
		return selectedCompactionReasoningResolution(required, { kind: "none" }, provenance);
	}
	return {
		kind: "refused",
		refusal: { kind: "support_unknown_for_required_effort", requiredEffort: required.effort },
		provenance,
	};
}

function leastSupportedCompactionReasoningEffortAtOrAbove(
	efforts: readonly CompactionReasoningEffort[],
	minimum: CompactionReasoningEffort,
): CompactionReasoningEffort | undefined {
	return orderedCompactionReasoningEfforts(efforts)
		.find((effort) => compactionReasoningEffortRank(effort) >= compactionReasoningEffortRank(minimum));
}

function orderedCompactionReasoningEfforts(
	efforts: readonly CompactionReasoningEffort[],
): readonly CompactionReasoningEffort[] {
	return [...new Set(efforts)].sort(
		(left, right) => compactionReasoningEffortRank(left) - compactionReasoningEffortRank(right),
	);
}

function validatedGeneratedCapabilities(
	model: string,
	capabilities: OpenRouterModelCapabilities,
): OpenRouterModelCapabilities {
	if (normalizedOpenRouterModelId(model) !== model) {
		throw new Error(`Generated OpenRouter capability model id is not normalized: ${JSON.stringify(model)}`);
	}
	const support = capabilities.compactionReasoning.support;
	if (support.kind === "known" || support.kind === "partially_known") {
		const ordered = orderedCompactionReasoningEfforts(support.efforts);
		if (support.kind === "known" && ordered.length === 0) {
			throw new Error(`Generated OpenRouter capability ${model} has an empty known compaction effort set.`);
		}
		if (ordered.length !== support.efforts.length) {
			throw new Error(`Generated OpenRouter capability ${model} has duplicate compaction efforts.`);
		}
		const modelDefault = capabilities.compactionReasoning.modelDefault;
		if (support.kind === "known" && modelDefault.kind === "explicit_effort" && !support.efforts.includes(modelDefault.effort)) {
			throw new Error(`Generated OpenRouter capability ${model} has a default compaction effort outside its support set.`);
		}
	}
	return capabilities;
}

function validatedGeneratedCapabilitiesMap(): ReadonlyMap<string, OpenRouterModelCapabilities> {
	const capabilitiesByModel = new Map<string, OpenRouterModelCapabilities>();
	for (const [model, capabilities] of generatedOpenRouterModelCapabilityEntries) {
		if (capabilitiesByModel.has(model)) {
			throw new Error(`Generated OpenRouter capability model id is duplicated: ${JSON.stringify(model)}`);
		}
		capabilitiesByModel.set(model, validatedGeneratedCapabilities(model, capabilities));
	}
	return capabilitiesByModel;
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
