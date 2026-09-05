import {
	type BotCompactionMode,
	type BotCompactionReasoningEffort,
	type BotCompactionReasoningRequest,
	type BotInferenceReasoningEffort,
	type BotInferenceToolCallIntent,
	type BotInferenceToolCalls,
	type BotStructuredToolCalls,
	type JsonObject,
} from "./model";
import { generatedOpenRouterModelCapabilityEntries } from "./openrouter-model-capabilities.generated";
import type { ProviderErrorCause } from "./runtime-errors";

export type OpenRouterModelCapabilities = {
	prefill: PrefillCapabilities;
	structuredOutputs: boolean;
	requiredToolCalls: RequiredToolCallCapabilities;
	disabledReasoning: boolean;
	cacheControl: boolean;
	compactionReasoning: CompactionReasoningCapabilities;
	contextLength?: number;
};

export type PrefillObservationSource =
	| "probe"
	| "legacy_boolean"
	| "custom_provider_policy"
	| "conservative_policy";

export type PrefillProviderCapabilities = {
	provider: string;
	providerDefault: RequiredToolCallObservation;
	reasoningOff: RequiredToolCallObservation;
	reasoningOn: RequiredToolCallReasoningOnObservation;
};

export type OpenRouterPrefillCapabilities = {
	kind: "provider_matrix";
	version: 2;
	providers: readonly PrefillProviderCapabilities[];
	fallback: { supported: boolean; source: Exclude<PrefillObservationSource, "probe"> };
};

export type FixedPrefillPolicy = {
	kind: "fixed_policy";
	supported: boolean;
	source: "custom_provider_policy" | "conservative_policy";
};

export type PrefillCapabilities = OpenRouterPrefillCapabilities | FixedPrefillPolicy;

export type PrefillProviderEvidence =
	| { kind: "observed"; provider: string; observation: RequiredToolCallObservation | RequiredToolCallReasoningOnObservation }
	| { kind: "unobserved"; provider: string };

export type PrefillCapabilityResolution =
	| {
			kind: "provider_aggregate";
			status: RequiredToolCallObservationStatus;
			providers: readonly PrefillProviderEvidence[];
	  }
	| {
			kind: "fallback_observation";
			status: "supported" | "unsupported";
			observedStatus: "unknown";
			source: OpenRouterPrefillCapabilities["fallback"]["source"];
			providers: readonly PrefillProviderEvidence[];
	  }
	| {
			kind: "fallback";
			status: "supported" | "unsupported";
			source: OpenRouterPrefillCapabilities["fallback"]["source"];
	  }
	| {
			kind: "fixed_policy";
			status: "supported" | "unsupported";
			source: FixedPrefillPolicy["source"];
	  };

export type AppliedPrefillPolicy =
	| { request: null; reasoningShape: RequiredToolCallReasoningShape; applied: false; adjustment: null; capability: null }
	| { request: false; reasoningShape: RequiredToolCallReasoningShape; applied: false; adjustment: null; capability: null }
	| {
			request: true;
			reasoningShape: RequiredToolCallReasoningShape;
			applied: boolean;
			adjustment: "prefill_unsupported" | "reasoning_shape_not_applicable" | "provider_compatibility_incomplete" | null;
			capability: PrefillCapabilityResolution;
	  };

export type RequiredToolCallReasoningShape = "provider_default" | "reasoning_off" | "reasoning_on";
export type RequiredToolCallObservationStatus = "supported" | "unsupported" | "unknown" | "not_applicable";
export type RequiredToolCallObservationSource =
	| "probe"
	| "legacy_boolean"
	| "custom_provider_policy"
	| "conservative_policy";

export type RequiredToolCallObservation = {
	status: RequiredToolCallObservationStatus;
	source: "probe";
};

export type RequiredToolCallReasoningOnObservation =
	| (RequiredToolCallObservation & { status: Exclude<RequiredToolCallObservationStatus, "not_applicable">; effort: CompactionReasoningEffort })
	| (RequiredToolCallObservation & { status: "not_applicable"; effort: null });

export type RequiredToolCallProviderCapabilities = {
	provider: string;
	providerDefault: RequiredToolCallObservation;
	reasoningOff: RequiredToolCallObservation;
	reasoningOn: RequiredToolCallReasoningOnObservation;
};

export type OpenRouterRequiredToolCallCapabilities = {
	kind: "provider_matrix";
	version: 2;
	providers: readonly RequiredToolCallProviderCapabilities[];
	fallback: { supported: boolean; source: Exclude<RequiredToolCallObservationSource, "probe"> };
};

export type FixedRequiredToolCallPolicy = {
	kind: "fixed_policy";
	supported: boolean;
	source: "custom_provider_policy" | "conservative_policy";
};

export type RequiredToolCallCapabilities = OpenRouterRequiredToolCallCapabilities | FixedRequiredToolCallPolicy;

export type RequiredToolCallProviderEvidence =
	| { kind: "observed"; provider: string; observation: RequiredToolCallObservation | RequiredToolCallReasoningOnObservation }
	| { kind: "unobserved"; provider: string };

export type RequiredToolCallResolutionObservation =
	| {
			kind: "provider_aggregate";
			status: RequiredToolCallObservationStatus;
			providers: readonly RequiredToolCallProviderEvidence[];
	  }
	| {
			kind: "fallback_observation";
			status: "supported" | "unsupported";
			observedStatus: "unknown";
			source: OpenRouterRequiredToolCallCapabilities["fallback"]["source"];
			providers: readonly RequiredToolCallProviderEvidence[];
	  }
	| {
			kind: "fallback";
			status: "supported" | "unsupported";
			source: OpenRouterRequiredToolCallCapabilities["fallback"]["source"];
	  }
	| {
			kind: "fixed_policy";
			status: "supported" | "unsupported";
			source: FixedRequiredToolCallPolicy["source"];
	  };

export type RequiredToolCallResolution = {
	shape: RequiredToolCallReasoningShape;
	observation: RequiredToolCallResolutionObservation;
	applied: BotInferenceToolCalls;
	adjustment:
		| "required_tool_calls_unsupported"
		| "reasoning_shape_not_applicable"
		| "provider_compatibility_incomplete"
		| null;
};

export type AppliedToolCallPolicy = {
	intent: BotInferenceToolCallIntent;
	reasoningShape: RequiredToolCallReasoningShape;
	requestedStrategy: BotInferenceToolCalls | null;
	appliedStrategy: BotInferenceToolCalls;
	emission: "omit_tool_choice" | "emit_tool_choice";
	capability: RequiredToolCallResolution | null;
};

export type CompactCapabilityOutcome =
	| {
			kind: "provider_aggregate";
			status: RequiredToolCallObservationStatus;
			candidateProviderCount: number;
			observedProviderCount: number;
	  }
	| {
			kind: "fallback_observation";
			status: "supported" | "unsupported";
			observedStatus: "unknown";
			source: Exclude<RequiredToolCallObservationSource, "probe">;
			candidateProviderCount: number;
			observedProviderCount: number;
	  }
	| {
			kind: "fallback";
			status: "supported" | "unsupported";
			source: Exclude<RequiredToolCallObservationSource, "probe">;
	  }
	| {
			kind: "fixed_policy";
			status: "supported" | "unsupported";
			source: "custom_provider_policy" | "conservative_policy";
	  };

export type CompactRequiredToolCallResolution = Omit<RequiredToolCallResolution, "observation"> & {
	observation: CompactCapabilityOutcome;
};

export type CompactAppliedToolCallPolicy = Omit<AppliedToolCallPolicy, "capability"> & {
	capability: CompactRequiredToolCallResolution | null;
};

export type CompactAppliedPrefillPolicy =
	| Extract<AppliedPrefillPolicy, { capability: null }>
	| (Omit<Extract<AppliedPrefillPolicy, { request: true }>, "capability"> & {
			capability: CompactCapabilityOutcome;
	  });

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

/**
 * The input that determined the applied compaction-policy outcome. Keeping
 * this decision beside the resolver result prevents presentation layers from
 * trying to reconstruct causality by comparing values that may happen to be
 * equal.
 */
export type CompactionReasoningDecisionProvenance =
	| { kind: "configuration"; request: CompactionReasoningFloor }
	| { kind: "model_default"; modelDefault: CompactionReasoningModelDefault }
	| { kind: "safety_floor"; floor: CompactionReasoningFloor }
	| { kind: "learned_floor"; floor: CompactionReasoningFloor }
	| {
			kind: "supported_effort_normalization";
			requiredEffort: CompactionReasoningEffort;
			appliedEffort: CompactionReasoningEffort;
	  }
	| { kind: "baseline"; selection: CompactionReasoningSelection };

export type CompactionReasoningRefusal =
	| {
			kind: "no_supported_effort";
			required: Extract<CompactionReasoningSelection, { kind: "explicit_effort" }>;
			supportedEfforts: readonly CompactionReasoningEffort[];
	  };

export type CompactionReasoningResolution =
	| {
			kind: "selected";
			decision: CompactionReasoningDecisionProvenance;
			selection: CompactionReasoningSelection;
			runtimeFallback: CompactionReasoningRuntimeFallback;
			provenance: CompactionReasoningProvenance;
	  }
	| {
			kind: "refused";
			decision: CompactionReasoningDecisionProvenance;
			refusal: CompactionReasoningRefusal;
			provenance: CompactionReasoningProvenance;
	  };

export type UnknownModelCompactionReasoningFailure =
	| { kind: "reasoning_rejected"; reason: "unknown_model_reasoning_none_rejected" }
	| { kind: "server_tool_crash"; reason: "unknown_model_openrouter_server_tool_crash" };

export const openRouterFreeModel = "openrouter/free";

const conservativeOpenRouterModelCapabilities = {
	prefill: conservativeOpenRouterPrefillCapabilities("conservative_policy", false),
	structuredOutputs: false,
	requiredToolCalls: conservativeOpenRouterRequiredToolCapabilities("conservative_policy", false),
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
	prefill: {
		kind: "fixed_policy",
		supported: true,
		source: "custom_provider_policy",
	},
	structuredOutputs: true,
	structuredOutputCompaction: true,
	compactionReasoningFloor: { kind: "reasoning_disabled" },
	requiredToolCalls: {
		kind: "fixed_policy",
		supported: true,
		source: "custom_provider_policy",
	},
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
		compactionReasoning: compactionReasoningCapabilitiesWithProbeEvidence(capabilities),
		compactionReasoningFloor,
		structuredOutputCompaction,
		defaultCompactionMode: structuredOutputCompaction ? "structured_output" : "tool_call_cache_friendly",
		// Models that do not support reasoning must keep Bickr automatic as a
		// provider-default request. Synthesizing `minimal` would misclassify the
		// request as reasoning-on and select the wrong capability matrix column.
		...(capabilities.compactionReasoning.support.kind === "unsupported"
			? {}
			: { defaultReasoningEffort: "minimal" as const }),
		defaultToolCalls: requiredToolCallDefault(capabilities.requiredToolCalls),
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
	// The shipped quality floor corrects the unsafe disabled-reasoning request;
	// it is not permission to rewrite an explicitly selected nonzero effort.
	// Learned runtime evidence remains a real floor for every request.
	const applicablePolicyFloor = input.request?.kind === "reasoning_disabled"
		? input.policy.floor
		: reasoningDisabledCompactionReasoningFloor;
	const joinedFloor = [input.request, input.learnedFloor]
		.filter((floor): floor is CompactionReasoningFloor => floor !== undefined)
		.reduce(strongerCompactionReasoningFloor, applicablePolicyFloor);
	const provenance: CompactionReasoningProvenance = {
		configuration: input.request ?? null,
		modelDefault: input.capabilities.modelDefault,
		safetyFloor: input.policy.floor,
		learnedFloor: input.learnedFloor ?? null,
		baselineSelection: input.policy.selection,
		support: input.capabilities.support.kind,
		policySource: input.policy.source,
	};
	const floorDecision = compactionReasoningFloorDecision(input, joinedFloor);
	const selected = (
		selection: CompactionReasoningSelection,
		runtimeFallback: CompactionReasoningRuntimeFallback,
		decision = compactionReasoningDecisionForSelection(input, selection, floorDecision),
	): Extract<CompactionReasoningResolution, { kind: "selected" }> => selectedCompactionReasoningResolution(
		selection,
		runtimeFallback,
		decision,
		provenance,
	);
	if (!input.request && !input.learnedFloor) {
		return selected(input.policy.selection, input.policy.runtimeFallback);
	}
	if (sameCompactionReasoningFloor(joinedFloor, input.policy.floor) && joinedFloor.kind !== "explicit_effort") {
		return selected(input.policy.selection, input.policy.runtimeFallback);
	}
	const selectionResolution = compactionReasoningSelectionForJoinedFloor(joinedFloor, input.capabilities.modelDefault);
	const requiredSelection = selectionResolution.selection;

	if (requiredSelection.kind === "reasoning_disabled") {
		return selected(requiredSelection, input.policy.runtimeFallback);
	}
	if (requiredSelection.kind === "model_default") {
		return selected(requiredSelection, { kind: "none" });
	}

	const requiredEffort = requiredSelection.effort;
	switch (input.capabilities.support.kind) {
		case "known":
		case "partially_known": {
			// Reasoning-effort support is monotonic: a model that reasons at any
			// effort accepts every stronger effort, so observed levels only bound
			// a request from below. A gap or missing level above the weakest
			// observation is a metadata artifact, never a per-level capability.
			const observed = orderedCompactionReasoningEfforts(input.capabilities.support.efforts);
			const minimumObserved = observed[0];
			if (minimumObserved === undefined) {
				// The internal type permits incomplete partial evidence even though
				// generated capability rows currently omit this empty shape. With no
				// affirmative support boundary, preserve the explicit provider request.
				return selected(requiredSelection, { kind: "none" });
			}
			if (compactionReasoningEffortRank(requiredEffort) >= compactionReasoningEffortRank(minimumObserved)) {
				return selected(requiredSelection, { kind: "none" });
			}
			return selected(
				{ kind: "explicit_effort", effort: minimumObserved },
				{ kind: "none" },
				{
					kind: "supported_effort_normalization",
					requiredEffort,
					appliedEffort: minimumObserved,
				},
			);
		}
		case "unsupported":
			return {
				kind: "refused",
				decision: floorDecision,
				refusal: { kind: "no_supported_effort", required: requiredSelection, supportedEfforts: [] },
				provenance,
			};
		case "unknown":
			// Unknown means the table has no support boundary. Preserve the
			// explicit effort and let the provider return a typed response.
			return selected(requiredSelection, { kind: "none" });
		default:
			return unreachableCompactionReasoningValue(input.capabilities.support);
	}
}

/** Validates the policy result at JSON-facing boundaries without a cast. */
export function isCompactionReasoningResolution(value: unknown): value is CompactionReasoningResolution {
	if (!isUnknownRecord(value) || !isCompactionReasoningDecisionProvenance(value.decision) ||
		!isCompactionReasoningProvenance(value.provenance)) {
		return false;
	}
	if (value.kind === "selected") {
		return isCompactionReasoningSelection(value.selection) && isCompactionReasoningRuntimeFallback(value.runtimeFallback);
	}
	return value.kind === "refused" && isCompactionReasoningRefusal(value.refusal);
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
	reasoningShape?: RequiredToolCallReasoningShape,
): BotInferenceToolCalls {
	return resolveToolCallPolicyForModel(
		model,
		openRouter,
		value === undefined ? { kind: "bickr_automatic" } : { kind: "strategy", strategy: value },
		providerRouting,
		reasoningShape,
	).appliedStrategy;
}

export function resolveToolCallPolicyForModel(
	model: string | undefined,
	openRouter: boolean,
	intent: BotInferenceToolCallIntent,
	providerRouting?: JsonObject,
	reasoningShape?: RequiredToolCallReasoningShape,
): AppliedToolCallPolicy {
	const policy = providerModelPolicy(model, openRouter, providerRouting);
	const effectiveReasoningShape = reasoningShape ?? defaultReasoningShape(policy);
	if (intent.kind === "provider_default") {
		return {
			intent,
			reasoningShape: effectiveReasoningShape,
			requestedStrategy: null,
			appliedStrategy: "at_will",
			emission: "omit_tool_choice",
			capability: null,
		};
	}
	let requestedStrategy: BotInferenceToolCalls;
	switch (intent.kind) {
		case "inherit":
		case "bickr_automatic": requestedStrategy = policy.defaultToolCalls; break;
		case "strategy": requestedStrategy = intent.strategy; break;
	}
	const capability = requiredToolCallResolution(
		policy.requiredToolCalls,
		requestedStrategy,
		effectiveReasoningShape,
		providerRouting,
	);
	return {
		intent,
		reasoningShape: effectiveReasoningShape,
		requestedStrategy,
		appliedStrategy: capability.applied,
		emission: "emit_tool_choice",
		capability,
	};
}

export function requiredToolCallResolution(
	capabilities: RequiredToolCallCapabilities,
	requested: BotInferenceToolCalls,
	shape: RequiredToolCallReasoningShape,
	providerRouting?: JsonObject,
): RequiredToolCallResolution {
	const observation = requiredToolCallResolutionObservation(capabilities, shape, providerRouting);
	if (requested !== "require") return { shape, observation, applied: requested, adjustment: null };
	switch (observation.status) {
		case "supported": return { shape, observation, applied: requested, adjustment: null };
		case "unsupported": return { shape, observation, applied: "railroad", adjustment: "required_tool_calls_unsupported" };
		case "not_applicable": return { shape, observation, applied: "railroad", adjustment: "reasoning_shape_not_applicable" };
		case "unknown": return { shape, observation, applied: "railroad", adjustment: "provider_compatibility_incomplete" };
	}
}

export function effectiveStructuredToolCallsForModel(
	model: string | undefined,
	openRouter: boolean,
	value: BotInferenceToolCalls | BotStructuredToolCalls | undefined,
	providerRouting?: JsonObject,
	reasoningShape?: RequiredToolCallReasoningShape,
): BotStructuredToolCalls {
	const toolCalls = effectiveToolCallsForModel(model, openRouter, value, providerRouting, reasoningShape);
	return toolCalls === "require" ? "require" : "railroad";
}

export function effectiveSupportsPrefillForModel(
	model: string | undefined,
	openRouter: boolean,
	value: boolean | undefined,
	providerRouting?: JsonObject,
	reasoningShape?: RequiredToolCallReasoningShape,
): boolean {
	return resolvePrefillPolicyForModel(model, openRouter, value, providerRouting, reasoningShape).applied;
}

export function resolvePrefillPolicyForModel(
	model: string | undefined,
	openRouter: boolean,
	request: boolean | undefined,
	providerRouting?: JsonObject,
	reasoningShape?: RequiredToolCallReasoningShape,
): AppliedPrefillPolicy {
	const policy = providerModelPolicy(model, openRouter, providerRouting);
	return resolvePrefillPolicy(
		policy.prefill,
		request,
		providerRouting,
		reasoningShape ?? defaultReasoningShape(policy),
	);
}

export function resolvePrefillPolicy(
	capabilities: PrefillCapabilities,
	request: boolean | undefined,
	providerRouting?: JsonObject,
	reasoningShape: RequiredToolCallReasoningShape = "reasoning_on",
): AppliedPrefillPolicy {
	if (request === undefined) return { request: null, reasoningShape, applied: false, adjustment: null, capability: null };
	if (!request) return { request: false, reasoningShape, applied: false, adjustment: null, capability: null };
	const capability = prefillCapabilityResolution(capabilities, reasoningShape, providerRouting);
	switch (capability.status) {
		case "supported": return { request: true, reasoningShape, applied: true, adjustment: null, capability };
		case "unsupported": return { request: true, reasoningShape, applied: false, adjustment: "prefill_unsupported", capability };
		case "not_applicable": return { request: true, reasoningShape, applied: false, adjustment: "reasoning_shape_not_applicable", capability };
		case "unknown": return { request: true, reasoningShape, applied: false, adjustment: "provider_compatibility_incomplete", capability };
	}
}

export function compactAppliedToolCallPolicy(policy: AppliedToolCallPolicy): CompactAppliedToolCallPolicy {
	return {
		...policy,
		capability: policy.capability ? {
			...policy.capability,
			observation: compactCapabilityOutcome(policy.capability.observation),
		} : null,
	};
}

export function compactAppliedPrefillPolicy(policy: AppliedPrefillPolicy): CompactAppliedPrefillPolicy {
	if (policy.capability === null) return policy;
	return {
		...policy,
		capability: compactCapabilityOutcome(policy.capability),
	};
}

function compactCapabilityOutcome(
	capability: RequiredToolCallResolutionObservation | PrefillCapabilityResolution,
): CompactCapabilityOutcome {
	switch (capability.kind) {
		case "provider_aggregate":
			return {
				kind: capability.kind,
				status: capability.status,
				candidateProviderCount: capability.providers.length,
				observedProviderCount: capability.providers.filter((provider) => provider.kind === "observed").length,
			};
		case "fallback_observation":
			return {
				kind: capability.kind,
				status: capability.status,
				observedStatus: capability.observedStatus,
				source: capability.source,
				candidateProviderCount: capability.providers.length,
				observedProviderCount: capability.providers.filter((provider) => provider.kind === "observed").length,
			};
		case "fallback":
		case "fixed_policy": return capability;
	}
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
	const policy = providerModelPolicy(model, openRouter, providerRouting);
	return requiredToolCallResolution(
		policy.requiredToolCalls,
		"require",
		defaultReasoningShape(policy),
		providerRouting,
	).applied === "require";
}

export function modelSupportsStructuredOutputs(model: string | undefined, openRouter: boolean, providerRouting?: JsonObject): boolean {
	return providerModelPolicy(model, openRouter, providerRouting).structuredOutputs;
}

export function modelSupportsStructuredCompaction(model: string | undefined, openRouter: boolean, providerRouting?: JsonObject): boolean {
	return providerModelPolicy(model, openRouter, providerRouting).structuredOutputCompaction;
}

export function modelSupportsPrefill(model: string | undefined, openRouter: boolean, providerRouting?: JsonObject): boolean {
	return resolvePrefillPolicyForModel(model, openRouter, true, providerRouting).applied;
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

function conservativeOpenRouterRequiredToolCapabilities(
	source: OpenRouterRequiredToolCallCapabilities["fallback"]["source"],
	supported: boolean,
): OpenRouterRequiredToolCallCapabilities {
	return {
		kind: "provider_matrix",
		version: 2,
		providers: [],
		fallback: { supported, source },
	};
}

function conservativeOpenRouterPrefillCapabilities(
	source: OpenRouterPrefillCapabilities["fallback"]["source"],
	supported: boolean,
): OpenRouterPrefillCapabilities {
	return {
		kind: "provider_matrix",
		version: 2,
		providers: [],
		fallback: { supported, source },
	};
}

function requiredToolCallDefault(capabilities: RequiredToolCallCapabilities): BotInferenceToolCalls {
	return capabilities.kind === "fixed_policy"
		? capabilities.supported ? "require" : "railroad"
		: capabilities.providers.length > 0 || capabilities.fallback.supported ? "require" : "railroad";
}

function defaultReasoningShape(policy: OpenRouterModelPolicy): RequiredToolCallReasoningShape {
	if (policy.defaultReasoningEffort === undefined) return "provider_default";
	return policy.defaultReasoningEffort === "none" ? "reasoning_off" : "reasoning_on";
}

function requiredToolCallObservation(
	capabilities: RequiredToolCallProviderCapabilities,
	shape: RequiredToolCallReasoningShape,
): RequiredToolCallObservation | RequiredToolCallReasoningOnObservation {
	switch (shape) {
		case "provider_default": return capabilities.providerDefault;
		case "reasoning_off": return capabilities.reasoningOff;
		case "reasoning_on": return capabilities.reasoningOn;
	}
}

function requiredToolCallResolutionObservation(
	capabilities: RequiredToolCallCapabilities,
	shape: RequiredToolCallReasoningShape,
	routing: JsonObject | undefined,
): RequiredToolCallResolutionObservation {
	if (capabilities.kind === "fixed_policy") {
		return {
			kind: "fixed_policy",
			status: capabilities.supported ? "supported" : "unsupported",
			source: capabilities.source,
		};
	}
	const providerCapabilities = new Map(capabilities.providers.map((provider) => [provider.provider, provider]));
	const candidates = providerCapabilityCandidateNames(capabilities.providers, routing);
	if (candidates.length === 0) {
		return {
			kind: "fallback",
			status: capabilities.fallback.supported ? "supported" : "unsupported",
			source: capabilities.fallback.source,
		};
	}
	const providers: RequiredToolCallProviderEvidence[] = candidates.map((provider) => {
		const observed = providerCapabilities.get(provider);
		return observed
			? { kind: "observed", provider, observation: requiredToolCallObservation(observed, shape) }
			: { kind: "unobserved", provider };
	});
	const statuses = providers.map((provider) => provider.kind === "observed" ? provider.observation.status : "unknown");
	const status = aggregateProviderObservationStatus(statuses);
	if (status === "unknown") {
		return {
			kind: "fallback_observation",
			status: capabilities.fallback.supported ? "supported" : "unsupported",
			observedStatus: status,
			source: capabilities.fallback.source,
			providers,
		};
	}
	return { kind: "provider_aggregate", status, providers };
}

function prefillCapabilityResolution(
	capabilities: PrefillCapabilities,
	shape: RequiredToolCallReasoningShape,
	routing: JsonObject | undefined,
): PrefillCapabilityResolution {
	if (capabilities.kind === "fixed_policy") {
		return {
			kind: "fixed_policy",
			status: capabilities.supported ? "supported" : "unsupported",
			source: capabilities.source,
		};
	}
	const providerCapabilities = new Map(capabilities.providers.map((provider) => [provider.provider, provider]));
	const candidates = providerCapabilityCandidateNames(capabilities.providers, routing);
	if (candidates.length === 0) {
		return {
			kind: "fallback",
			status: capabilities.fallback.supported ? "supported" : "unsupported",
			source: capabilities.fallback.source,
		};
	}
	const providers: PrefillProviderEvidence[] = candidates.map((provider) => {
		const observed = providerCapabilities.get(provider);
		return observed
			? { kind: "observed", provider, observation: requiredToolCallObservation(observed, shape) }
			: { kind: "unobserved", provider };
	});
	const statuses = providers.map((provider) => provider.kind === "observed" ? provider.observation.status : "unknown");
	const status = aggregateProviderObservationStatus(statuses);
	if (status === "unknown") {
		return {
			kind: "fallback_observation",
			status: capabilities.fallback.supported ? "supported" : "unsupported",
			observedStatus: status,
			source: capabilities.fallback.source,
			providers,
		};
	}
	return { kind: "provider_aggregate", status, providers };
}

function aggregateProviderObservationStatus(
	statuses: readonly RequiredToolCallObservationStatus[],
): RequiredToolCallObservationStatus {
	if (statuses.includes("unsupported")) return "unsupported";
	if (statuses.includes("not_applicable")) return "not_applicable";
	if (statuses.length === 0 || statuses.includes("unknown")) return "unknown";
	return "supported";
}

function providerCapabilityCandidateNames(
	providers: readonly { provider: string }[],
	routing: JsonObject | undefined,
): string[] {
	const known = providers.map(({ provider }) => provider);
	const only = explicitProviderList(routing?.only) ?? (
		routing?.allow_fallbacks === false ? explicitProviderList(routing.order) : undefined
	);
	const selected = only
		? only.flatMap((selection) => {
			const matches = known.filter((provider) => providerRouteSelectionMatches(selection, provider));
			return matches.length > 0 ? matches : [selection];
		})
		: known;
	const ignored = explicitProviderList(routing?.ignore) ?? [];
	return [...new Set(selected)]
		.filter((provider) => !ignored.some((selection) => providerRouteSelectionMatches(selection, provider)))
		.sort(codeUnitCompare);
}

function explicitProviderList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) return undefined;
	return [...new Set(value.map((item) => item.trim().toLowerCase()))].sort(codeUnitCompare);
}

function providerRouteSelectionMatches(selection: string, provider: string): boolean {
	return provider === selection || provider.startsWith(`${selection}/`);
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

function compactionReasoningCapabilitiesWithProbeEvidence(
	capabilities: OpenRouterModelCapabilities,
): CompactionReasoningCapabilities {
	const declared = capabilities.compactionReasoning;
	const supportIsEmpty = declared.support.kind === "unknown" ||
		(declared.support.kind === "partially_known" && declared.support.efforts.length === 0);
	if (!supportIsEmpty) {
		return declared;
	}
	// Models like Xiaomi's publish no effort metadata, leaving declared support
	// unknown even though the capability probes serviced reasoning-on requests
	// on every route. Fold those observations in as partial support so an
	// explicit compaction effort is not refused on a model already observed
	// reasoning.
	const observed = observedReasoningOnEfforts(capabilities);
	if (observed.length === 0) {
		return declared;
	}
	return { ...declared, support: { kind: "partially_known", efforts: observed } };
}

function observedReasoningOnEfforts(capabilities: OpenRouterModelCapabilities): readonly CompactionReasoningEffort[] {
	const efforts = new Set<CompactionReasoningEffort>();
	for (const matrix of [capabilities.prefill, capabilities.requiredToolCalls]) {
		if (matrix.kind !== "provider_matrix") {
			continue;
		}
		for (const { reasoningOn } of matrix.providers) {
			// Both supported and unsupported follow a successfully serviced
			// control request with reasoning at this effort — the status grades
			// the probed feature, not reasoning itself. Only unknown and
			// not_applicable carry no reasoning evidence.
			if (reasoningOn.status === "supported" || reasoningOn.status === "unsupported") {
				efforts.add(reasoningOn.effort);
			}
		}
	}
	return orderedCompactionReasoningEfforts([...efforts]);
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
		case "explicit_effort":
			// A model default is a baseline only. Once configuration or a quality
			// floor selects an explicit effort, a stronger provider default must not
			// silently rewrite that explicit request.
			return { kind: "explicit_effort", effort: floor.effort };
		default:
			return unreachableCompactionReasoningValue(floor);
	}
}

function compactionReasoningSelectionForJoinedFloor(
	floor: CompactionReasoningFloor,
	modelDefault: CompactionReasoningModelDefault,
):
	{ kind: "selected"; selection: CompactionReasoningSelection } {
	switch (floor.kind) {
		case "reasoning_disabled":
			return { kind: "selected", selection: { kind: "reasoning_disabled" } };
		case "model_default":
			return { kind: "selected", selection: modelDefaultCompactionReasoningSelection(modelDefault) };
		case "explicit_effort":
			// Advertised model defaults are baseline data only. Once a request,
			// safety floor, or learned floor selects an effort, support metadata may
			// normalize that effort but the provider default cannot raise it.
			return { kind: "selected", selection: { kind: "explicit_effort", effort: floor.effort } };
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
	// A semantic effort floor applies only when a caller explicitly requests
	// disabled reasoning. With no request, the advertised model default remains
	// the typed baseline regardless of how it orders relative to that quality
	// floor. Keep its model-default identity even when metadata supplies the
	// concrete effort that must be emitted.
	return modelDefaultCompactionReasoningSelection(modelDefault);
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
	decision: CompactionReasoningDecisionProvenance,
	provenance: CompactionReasoningProvenance,
): Extract<CompactionReasoningResolution, { kind: "selected" }> {
	return {
		kind: "selected",
		decision,
		selection,
		runtimeFallback: selection.kind === "reasoning_disabled" ? runtimeFallback : { kind: "none" },
		provenance,
	};
}

function compactionReasoningFloorDecision(
	input: {
		policy: CompactionReasoningPolicy;
		request?: CompactionReasoningFloor;
		capabilities: CompactionReasoningCapabilities;
		learnedFloor?: CompactionReasoningFloor;
	},
	joinedFloor: CompactionReasoningFloor,
): CompactionReasoningDecisionProvenance {
	// An explicit request keeps authorship when it ties the applied minimum.
	// A learned floor that merely repeats a shipped safety floor did not change
	// the outcome, so the safety floor wins that tie instead.
	if (input.request && sameCompactionReasoningFloor(input.request, joinedFloor)) {
		return { kind: "configuration", request: input.request };
	}
	if (sameCompactionReasoningFloor(input.policy.floor, joinedFloor)) {
		if (joinedFloor.kind === "model_default") {
			return { kind: "model_default", modelDefault: input.capabilities.modelDefault };
		}
		if (joinedFloor.kind === "reasoning_disabled") {
			return { kind: "baseline", selection: input.policy.selection };
		}
		return { kind: "safety_floor", floor: input.policy.floor };
	}
	if (input.learnedFloor && sameCompactionReasoningFloor(input.learnedFloor, joinedFloor)) {
		return { kind: "learned_floor", floor: input.learnedFloor };
	}
	return { kind: "baseline", selection: input.policy.selection };
}

function compactionReasoningDecisionForSelection(
	input: {
		policy: CompactionReasoningPolicy;
		request?: CompactionReasoningFloor;
		capabilities: CompactionReasoningCapabilities;
		learnedFloor?: CompactionReasoningFloor;
	},
	selection: CompactionReasoningSelection,
	floorDecision: CompactionReasoningDecisionProvenance,
): CompactionReasoningDecisionProvenance {
	if (selection.kind === "model_default") {
		if (floorDecision.kind === "configuration" && input.request?.kind === "model_default") {
			return floorDecision;
		}
		if (floorDecision.kind === "learned_floor" && input.learnedFloor?.kind === "model_default") {
			return floorDecision;
		}
		return { kind: "model_default", modelDefault: input.capabilities.modelDefault };
	}
	if (!input.request && !input.learnedFloor && selection.kind === "explicit_effort" &&
		input.capabilities.modelDefault.kind === "explicit_effort" &&
		selection.effort === input.capabilities.modelDefault.effort) {
		return { kind: "model_default", modelDefault: input.capabilities.modelDefault };
	}
	return floorDecision;
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
	const requiredToolCalls = capabilities.requiredToolCalls;
	if (requiredToolCalls.kind !== "provider_matrix" || requiredToolCalls.version !== 2) {
		throw new Error(`Generated OpenRouter capability ${model} has an unsupported required-tool schema.`);
	}
	const providerNames = requiredToolCalls.providers.map(({ provider }) => provider);
	if (providerNames.some((provider) => !provider || normalizedProviderSlug(provider) !== provider) ||
		new Set(providerNames).size !== providerNames.length ||
		providerNames.some((provider, index) => index > 0 && codeUnitCompare(providerNames[index - 1]!, provider) >= 0)) {
		throw new Error(`Generated OpenRouter capability ${model} has malformed or unordered provider evidence.`);
	}
	const prefill = capabilities.prefill;
	if (prefill.kind !== "provider_matrix" || prefill.version !== 2) {
		throw new Error(`Generated OpenRouter capability ${model} has an unsupported prefill schema.`);
	}
	const prefillProviderNames = prefill.providers.map(({ provider }) => provider);
	if (prefillProviderNames.some((provider) => !provider || normalizedProviderSlug(provider) !== provider) ||
		new Set(prefillProviderNames).size !== prefillProviderNames.length ||
		prefillProviderNames.some((provider, index) => index > 0 && codeUnitCompare(prefillProviderNames[index - 1]!, provider) >= 0)) {
		throw new Error(`Generated OpenRouter capability ${model} has malformed or unordered prefill provider evidence.`);
	}
	return capabilities;
}

function validatedGeneratedCapabilitiesMap(): ReadonlyMap<string, OpenRouterModelCapabilities> {
	const capabilitiesByModel = new Map<string, OpenRouterModelCapabilities>();
	for (const [model, generated] of generatedOpenRouterModelCapabilityEntries) {
		if (capabilitiesByModel.has(model)) {
			throw new Error(`Generated OpenRouter capability model id is duplicated: ${JSON.stringify(model)}`);
		}
		capabilitiesByModel.set(model, validatedGeneratedCapabilities(model, generated));
	}
	return capabilitiesByModel;
}

function normalizedProviderSlug(provider: string): string {
	return provider.trim().toLowerCase();
}

function codeUnitCompare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function unreachableCompactionReasoningValue(value: never): never {
	throw new Error(`Unhandled compaction reasoning value: ${String(value)}`);
}

function isCompactionReasoningDecisionProvenance(value: unknown): value is CompactionReasoningDecisionProvenance {
	if (!isUnknownRecord(value)) return false;
	switch (value.kind) {
		case "configuration": return isCompactionReasoningFloor(value.request);
		case "model_default": return isCompactionReasoningModelDefault(value.modelDefault);
		case "safety_floor":
		case "learned_floor": return isCompactionReasoningFloor(value.floor);
		case "supported_effort_normalization":
			return isCompactionReasoningEffort(value.requiredEffort) &&
				isCompactionReasoningEffort(value.appliedEffort);
		case "baseline": return isCompactionReasoningSelection(value.selection);
		default: return false;
	}
}

function isCompactionReasoningProvenance(value: unknown): value is CompactionReasoningProvenance {
	return isUnknownRecord(value) &&
		(value.configuration === null || isCompactionReasoningFloor(value.configuration)) &&
		isCompactionReasoningModelDefault(value.modelDefault) &&
		isCompactionReasoningFloor(value.safetyFloor) &&
		(value.learnedFloor === null || isCompactionReasoningFloor(value.learnedFloor)) &&
		isCompactionReasoningSelection(value.baselineSelection) &&
		(value.support === "known" || value.support === "partially_known" || value.support === "unknown" || value.support === "unsupported") &&
		(value.policySource === "custom_provider" || value.policySource === "openrouter_generated" ||
			value.policySource === "openrouter_manual" || value.policySource === "openrouter_semantic_override" ||
			value.policySource === "openrouter_unknown");
}

function isCompactionReasoningRefusal(value: unknown): value is CompactionReasoningRefusal {
	if (!isUnknownRecord(value)) return false;
	switch (value.kind) {
		case "no_supported_effort":
			return isUnknownRecord(value.required) && value.required.kind === "explicit_effort" &&
				isCompactionReasoningEffort(value.required.effort) && Array.isArray(value.supportedEfforts) &&
				value.supportedEfforts.every(isCompactionReasoningEffort);
		default:
			return false;
	}
}

function isCompactionReasoningRuntimeFallback(value: unknown): value is CompactionReasoningRuntimeFallback {
	return isUnknownRecord(value) && (value.kind === "none" || value.kind === "unknown_model" &&
		isUnknownRecord(value.selection) && value.selection.kind === "model_default" &&
		(value.selection.effort === undefined || isCompactionReasoningEffort(value.selection.effort)));
}

function isCompactionReasoningSelection(value: unknown): value is CompactionReasoningSelection {
	if (!isUnknownRecord(value)) return false;
	switch (value.kind) {
		case "reasoning_disabled": return true;
		case "model_default": return value.effort === undefined || isCompactionReasoningEffort(value.effort);
		case "explicit_effort": return isCompactionReasoningEffort(value.effort);
		default: return false;
	}
}

function isCompactionReasoningFloor(value: unknown): value is CompactionReasoningFloor {
	return isUnknownRecord(value) && (value.kind === "reasoning_disabled" || value.kind === "model_default" ||
		value.kind === "explicit_effort" && isCompactionReasoningEffort(value.effort));
}

function isCompactionReasoningModelDefault(value: unknown): value is CompactionReasoningModelDefault {
	if (!isUnknownRecord(value)) return false;
	switch (value.kind) {
		case "absent": return true;
		case "explicit_effort": return isCompactionReasoningEffort(value.effort);
		case "provider_default":
			return value.relativeOrder === "below_minimal" || value.relativeOrder === "above_xhigh" ||
				value.relativeOrder === "unknown";
		default: return false;
	}
}

function isCompactionReasoningEffort(value: unknown): value is CompactionReasoningEffort {
	return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
