import { describe, expect, it } from "vitest";
import {
	compactionReasoningCapabilitiesForModel,
	compactionReasoningPolicyForModel,
	compactAppliedPrefillPolicy,
	compactAppliedToolCallPolicy,
	isCompactionReasoningResolution,
	openRouterFreeModel,
	openRouterModelCapabilities,
	openRouterModelPolicy,
	requiredToolCallResolution,
	resolveCompactionReasoningSelection,
	resolvePrefillPolicy,
	resolvePrefillPolicyForModel,
	resolveToolCallPolicyForModel,
	type CompactionReasoningCapabilities,
	type CompactionReasoningEffort,
	type CompactionReasoningPolicy,
} from "./openrouter-model-capabilities";

const allEfforts = ["minimal", "low", "medium", "high", "xhigh"] as const;

describe("required tool-call request-shape evidence", () => {
	const capabilities = {
		kind: "provider_matrix",
		version: 2,
		providers: [
			{
				provider: "decart/fp4",
				providerDefault: { status: "supported", source: "probe" },
				reasoningOff: { status: "supported", source: "probe" },
				reasoningOn: { status: "supported", source: "probe", effort: "low" },
			},
			{
				provider: "deepseek/fp8",
				providerDefault: { status: "supported", source: "probe" },
				reasoningOff: { status: "supported", source: "probe" },
				reasoningOn: { status: "unsupported", source: "probe", effort: "low" },
			},
		],
		fallback: { supported: true, source: "legacy_boolean" },
	} as const;

	it("selects the provider matrix only after the actual reasoning shape", () => {
		expect(requiredToolCallResolution(capabilities, "require", "provider_default"))
			.toMatchObject({ applied: "require", adjustment: null });
		expect(requiredToolCallResolution(capabilities, "require", "reasoning_on"))
			.toMatchObject({ applied: "railroad", adjustment: "required_tool_calls_unsupported" });
		expect(requiredToolCallResolution(capabilities, "require", "reasoning_off"))
			.toMatchObject({ applied: "require", adjustment: null });
	});

	it("requires compatibility from every possible unpinned or explicitly allowed provider", () => {
		expect(requiredToolCallResolution(capabilities, "require", "reasoning_on"))
			.toMatchObject({ applied: "railroad", adjustment: "required_tool_calls_unsupported", observation: { status: "unsupported" } });
		expect(requiredToolCallResolution(capabilities, "require", "reasoning_on", { only: ["decart/fp4"] }))
			.toMatchObject({ applied: "require", adjustment: null, observation: { status: "supported" } });
		expect(requiredToolCallResolution(capabilities, "require", "reasoning_on", { only: ["deepseek/fp8"] }))
			.toMatchObject({ applied: "railroad", adjustment: "required_tool_calls_unsupported" });
		expect(requiredToolCallResolution(capabilities, "require", "reasoning_on", { only: ["decart/fp4", "deepseek/fp8"] }))
			.toMatchObject({ applied: "railroad", adjustment: "required_tool_calls_unsupported" });
		expect(requiredToolCallResolution(capabilities, "require", "reasoning_on", { ignore: ["deepseek"] }))
			.toMatchObject({ applied: "require", adjustment: null });
		expect(requiredToolCallResolution(capabilities, "require", "reasoning_on", { only: ["unobserved/provider"] }))
			.toMatchObject({
				applied: "require",
				adjustment: null,
				observation: {
					kind: "fallback_observation",
					status: "supported",
					observedStatus: "unknown",
					source: "legacy_boolean",
				},
			});
	});

	it("keeps the exact Decart-supported/DeepSeek-reasoning-on-unsupported split conservative", () => {
		const resolution = requiredToolCallResolution(capabilities, "require", "reasoning_on");
		expect(resolution).toMatchObject({
			applied: "railroad",
			adjustment: "required_tool_calls_unsupported",
			observation: {
				status: "unsupported",
				providers: [
					{ provider: "decart/fp4", observation: { status: "supported", effort: "low" } },
					{ provider: "deepseek/fp8", observation: { status: "unsupported", effort: "low" } },
				],
			},
		});
	});

	it("uses fallback evidence when a generated matrix has no provider rows", () => {
		const empty = { ...capabilities, providers: [] } as const;
		expect(requiredToolCallResolution(empty, "require", "provider_default")).toMatchObject({
			applied: "require",
			adjustment: null,
			observation: { kind: "fallback", status: "supported", source: "legacy_boolean" },
		});
		expect(requiredToolCallResolution(empty, "require", "provider_default", { only: ["unknown/provider"] }))
			.toMatchObject({
				applied: "require",
				adjustment: null,
				observation: { kind: "fallback_observation", status: "supported", observedStatus: "unknown" },
			});
	});
});

describe("prefill-plus-tools request-shape evidence", () => {
	const capabilities = {
		kind: "provider_matrix",
		version: 2,
		providers: [
			{
				provider: "decart/fp4",
				providerDefault: { status: "supported", source: "probe" },
				reasoningOff: { status: "supported", source: "probe" },
				reasoningOn: { status: "supported", source: "probe", effort: "low" },
			},
			{
				provider: "deepseek/fp8",
				providerDefault: { status: "supported", source: "probe" },
				reasoningOff: { status: "unsupported", source: "probe" },
				reasoningOn: { status: "unsupported", source: "probe", effort: "low" },
			},
		],
		fallback: { supported: false, source: "conservative_policy" },
	} as const;

	it("keeps unset opt-in off and preserves an explicit off without consulting capability evidence", () => {
		expect(resolvePrefillPolicy(capabilities, undefined, undefined, "reasoning_off")).toEqual({
			request: null,
			reasoningShape: "reasoning_off",
			applied: false,
			adjustment: null,
			capability: null,
		});
		expect(resolvePrefillPolicy(capabilities, false, undefined, "reasoning_on")).toEqual({
			request: false,
			reasoningShape: "reasoning_on",
			applied: false,
			adjustment: null,
			capability: null,
		});
	});

	it("compacts provider-request observability without persisting provider rows", () => {
		const capability = requiredToolCallResolution(
			capabilities,
			"require",
			"reasoning_on",
			{ only: ["decart/fp4", "deepseek/fp8"] },
		);
		const toolPolicy = compactAppliedToolCallPolicy({
			intent: { kind: "bickr_automatic" },
			reasoningShape: "reasoning_on",
			requestedStrategy: "require",
			appliedStrategy: capability.applied,
			emission: "emit_tool_choice",
			capability,
		});
		expect(toolPolicy.capability?.observation).toEqual({
			kind: "provider_aggregate",
			status: "unsupported",
			candidateProviderCount: 2,
			observedProviderCount: 2,
		});
		expect(JSON.stringify(toolPolicy)).not.toContain("deepseek/fp8");

		const prefill = compactAppliedPrefillPolicy(resolvePrefillPolicy(
			{ ...capabilities, fallback: { supported: true, source: "legacy_boolean" } },
			true,
			{ only: ["unobserved/provider"] },
			"reasoning_on",
		));
		expect(prefill.capability).toEqual({
			kind: "fallback_observation",
			status: "supported",
			observedStatus: "unknown",
			source: "legacy_boolean",
			candidateProviderCount: 1,
			observedProviderCount: 0,
		});
		expect(JSON.stringify(prefill)).not.toContain("unobserved/provider");
	});

	it("keeps the exact Decart-supported/DeepSeek-unsupported Off and Low evidence provider-scoped", () => {
		for (const reasoningShape of ["reasoning_off", "reasoning_on"] as const) {
			expect(resolvePrefillPolicy(capabilities, true, { only: ["deepseek/fp8"] }, reasoningShape)).toMatchObject({
				request: true,
				reasoningShape,
				applied: false,
				adjustment: "prefill_unsupported",
				capability: { status: "unsupported" },
			});
			expect(resolvePrefillPolicy(capabilities, true, { only: ["decart/fp4"] }, reasoningShape)).toMatchObject({
				request: true,
				reasoningShape,
				applied: true,
				adjustment: null,
				capability: { status: "supported" },
			});
			expect(resolvePrefillPolicy(capabilities, true, undefined, reasoningShape)).toMatchObject({
				applied: false,
				adjustment: "prefill_unsupported",
			});
		}
		expect(capabilities.providers[1].reasoningOn).toEqual({ status: "unsupported", source: "probe", effort: "low" });
	});

	it("uses only the active shape and never lets a sibling shape bless or clamp it", () => {
		const split = {
			...capabilities,
			providers: [{
				provider: "split/provider",
				providerDefault: { status: "unknown", source: "probe" },
				reasoningOff: { status: "supported", source: "probe" },
				reasoningOn: { status: "unsupported", source: "probe", effort: "low" },
			}],
		} as const;
		expect(resolvePrefillPolicy(split, true, undefined, "reasoning_off")).toMatchObject({ applied: true, adjustment: null });
		expect(resolvePrefillPolicy(split, true, undefined, "reasoning_on")).toMatchObject({
			applied: false,
			adjustment: "prefill_unsupported",
		});
		expect(resolvePrefillPolicy(split, true, undefined, "provider_default")).toMatchObject({
			applied: false,
			adjustment: "prefill_unsupported",
			capability: {
				kind: "fallback_observation",
				status: "unsupported",
				observedStatus: "unknown",
			},
		});
	});

	it("uses fallback evidence when a generated matrix has no provider rows", () => {
		const empty = { ...capabilities, providers: [], fallback: { supported: true, source: "legacy_boolean" } } as const;
		expect(resolvePrefillPolicy(empty, true, undefined, "provider_default")).toMatchObject({
			applied: true,
			adjustment: null,
			capability: { kind: "fallback", status: "supported", source: "legacy_boolean" },
		});
		expect(resolvePrefillPolicy(empty, true, { only: ["unknown/provider"] }, "provider_default"))
			.toMatchObject({
				applied: true,
				adjustment: null,
				capability: { kind: "fallback_observation", status: "supported", observedStatus: "unknown" },
			});
	});
});

function disabledBaselinePolicy(): CompactionReasoningPolicy {
	return {
		floor: { kind: "reasoning_disabled" },
		modelDefaultSelection: { kind: "model_default", effort: "minimal" },
		runtimeFallback: {
			kind: "unknown_model",
			selection: { kind: "model_default", effort: "minimal" },
		},
		selection: { kind: "reasoning_disabled" },
		source: "custom_provider",
	};
}

function knownCapabilities(
	efforts: readonly CompactionReasoningEffort[] = allEfforts,
): CompactionReasoningCapabilities {
	return {
		support: { kind: "known", efforts },
		modelDefault: { kind: "explicit_effort", effort: "minimal" },
	};
}

describe("compaction reasoning capability metadata", () => {
	it("loads explicit effort/default metadata for exact models, aliases, and groups", () => {
		expect(openRouterModelCapabilities("openai/gpt-5-mini").compactionReasoning).toEqual({
			support: { kind: "known", efforts: ["high", "low", "medium", "minimal"] },
			modelDefault: { kind: "explicit_effort", effort: "medium" },
		});
		expect(openRouterModelCapabilities("  ~OPENAI/GPT-LATEST ").compactionReasoning).toEqual({
			support: { kind: "partially_known", efforts: ["high", "low", "medium", "xhigh"] },
			modelDefault: { kind: "explicit_effort", effort: "medium" },
		});
	});

	it("distinguishes custom-provider and unlisted-model metadata", () => {
		expect(compactionReasoningCapabilitiesForModel("local/model", false)).toEqual({
			support: { kind: "unknown" },
			modelDefault: { kind: "explicit_effort", effort: "minimal" },
		});
		expect(compactionReasoningCapabilitiesForModel("unknown/provider-model", true)).toEqual({
			support: { kind: "unknown" },
			modelDefault: { kind: "provider_default", relativeOrder: "unknown" },
		});
	});

	it("keeps ordinary-loop reasoning defaults unchanged", () => {
		expect(openRouterModelPolicy("openai/gpt-5-mini").defaultReasoningEffort).toBe("minimal");
	});

	it.each(["openai/gpt-4o-mini", "amazon/nova-lite-v1"])(
		"keeps non-reasoning model defaults in the provider-default capability shape for %s",
		(model) => {
			expect(openRouterModelPolicy(model).defaultReasoningEffort).toBeUndefined();
			expect(resolveToolCallPolicyForModel(model, true, { kind: "bickr_automatic" })).toMatchObject({
				reasoningShape: "provider_default",
				appliedStrategy: "require",
				capability: { observation: { status: "supported" } },
			});
			expect(resolvePrefillPolicyForModel(model, true, true)).toMatchObject({
				reasoningShape: "provider_default",
				applied: true,
				adjustment: null,
			});
		},
	);
});

describe("compaction reasoning policy", () => {
	it("joins the exact DeepSeek safety floor with its metadata default without shadowing generated capabilities", () => {
		const policy = openRouterModelPolicy("deepseek/deepseek-v4-flash-0731");

		expect(policy).toMatchObject({
			cacheControl: false,
			compactionReasoningFloor: { kind: "explicit_effort", effort: "low" },
			contextLength: 1_048_576,
			disabledReasoning: true,
			prefill: { kind: "provider_matrix", version: 2 },
			requiredToolCalls: { fallback: { supported: true } },
			structuredOutputs: true,
		});
		expect(compactionReasoningPolicyForModel("deepseek/deepseek-v4-flash-0731", true)).toMatchObject({
			floor: { kind: "explicit_effort", effort: "low" },
			selection: { kind: "model_default", effort: "high" },
			source: "openrouter_semantic_override",
		});
		expect(compactionReasoningPolicyForModel("deepseek/deepseek-v4-flash-0731:free", true)).toMatchObject({
			floor: { kind: "model_default" },
			selection: { kind: "model_default" },
			source: "openrouter_unknown",
		});
	});

	it("folds serviced reasoning-on probe observations into unknown compaction support", () => {
		// xiaomi/mimo-v2.5 publishes no effort metadata, but every provider route
		// serviced the reasoning-on probes at minimal; monotonic effort support
		// then serves any explicit compaction effort instead of refusing.
		expect(compactionReasoningCapabilitiesForModel("xiaomi/mimo-v2.5", true)).toEqual({
			support: { kind: "partially_known", efforts: ["minimal"] },
			modelDefault: { kind: "provider_default", relativeOrder: "unknown" },
		});
		expect(openRouterModelCapabilities("xiaomi/mimo-v2.5").compactionReasoning.support).toEqual({ kind: "unknown" });
		expect(resolveCompactionReasoningSelection({
			policy: compactionReasoningPolicyForModel("xiaomi/mimo-v2.5", true, { only: ["xiaomi/fp8"] }),
			request: { kind: "explicit_effort", effort: "high" },
			capabilities: compactionReasoningCapabilitiesForModel("xiaomi/mimo-v2.5", true, { only: ["xiaomi/fp8"] }),
		})).toMatchObject({
			kind: "selected",
			decision: { kind: "configuration", request: { kind: "explicit_effort", effort: "high" } },
			selection: { kind: "explicit_effort", effort: "high" },
			provenance: { support: "partially_known" },
		});
	});

	it("keeps the Xiaomi minimum route-sensitive and metadata-driven", () => {
		expect(compactionReasoningPolicyForModel("xiaomi/mimo-v2.5", true, { only: ["xiaomi/fp8"] })).toMatchObject({
			floor: { kind: "model_default" },
			knownFailure: "server_tool_crash",
			selection: { kind: "model_default" },
		});
		expect(compactionReasoningPolicyForModel("xiaomi/mimo-v2.5", true)).toMatchObject({
			floor: { kind: "reasoning_disabled" },
			selection: { kind: "reasoning_disabled" },
		});
	});
});

describe("canonical compaction reasoning resolution", () => {
	it.each(allEfforts)("uses the canonical ordering for an explicit %s request", (effort) => {
		const resolution = resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort },
			capabilities: knownCapabilities(),
		});

		expect(resolution).toMatchObject({
			kind: "selected",
			decision: { kind: "configuration", request: { kind: "explicit_effort", effort } },
			selection: { kind: "explicit_effort", effort },
			provenance: {
				configuration: { kind: "explicit_effort", effort },
				modelDefault: { kind: "explicit_effort", effort: "minimal" },
				safetyFloor: { kind: "reasoning_disabled" },
				learnedFloor: null,
			},
		});
	});

	it("accepts any effort at or above the weakest known-supported effort", () => {
		// Effort support is monotonic: reasoning observed at low validates every
		// stronger effort, so a gap in the observed set never rejects or rewrites
		// a request above the weakest observation.
		const resolution = resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "medium" },
			capabilities: knownCapabilities(["xhigh", "low", "high"]),
		});

		expect(resolution).toMatchObject({
			kind: "selected",
			decision: { kind: "configuration", request: { kind: "explicit_effort", effort: "medium" } },
			selection: { kind: "explicit_effort", effort: "medium" },
		});
	});

	it("normalizes a request below the weakest known-supported effort upward", () => {
		const resolution = resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "minimal" },
			capabilities: knownCapabilities(["xhigh", "low", "high"]),
		});

		expect(resolution).toMatchObject({
			kind: "selected",
			decision: {
				kind: "supported_effort_normalization",
				requiredEffort: "minimal",
				appliedEffort: "low",
			},
			selection: { kind: "explicit_effort", effort: "low" },
		});
	});

	it("preserves no-request baselines for known, custom-provider, and unlisted models", () => {
		for (const input of [
			{ model: "openai/gpt-5-mini", openRouter: true },
			{ model: "local/model", openRouter: false },
			{ model: "unknown/provider-model", openRouter: true },
		]) {
			const policy = compactionReasoningPolicyForModel(input.model, input.openRouter);
			const resolution = resolveCompactionReasoningSelection({
				policy,
				capabilities: compactionReasoningCapabilitiesForModel(input.model, input.openRouter),
			});

			expect(resolution).toMatchObject({
				kind: "selected",
				selection: policy.selection,
				runtimeFallback: policy.runtimeFallback,
			});
		}
	});

	it("attributes an unchanged permissive policy outcome to its baseline", () => {
		const resolution = resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			capabilities: knownCapabilities(),
		});
		expect(resolution).toMatchObject({
			kind: "selected",
			decision: { kind: "baseline", selection: { kind: "reasoning_disabled" } },
			selection: { kind: "reasoning_disabled" },
		});
		expect(isCompactionReasoningResolution(resolution)).toBe(true);
		expect(isCompactionReasoningResolution({ ...resolution, decision: undefined })).toBe(false);
	});

	it("returns support_unknown_for_required_effort for a stronger unknown explicit requirement", () => {
		const resolution = resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "high" },
			capabilities: {
				support: { kind: "unknown" },
				modelDefault: { kind: "provider_default", relativeOrder: "below_minimal" },
			},
		});

		expect(resolution).toMatchObject({
			kind: "refused",
			refusal: { kind: "support_unknown_for_required_effort", requiredEffort: "high" },
		});
	});

	it("uses a max provider default only as the no-request baseline", () => {
		const model = "~moonshotai/kimi-latest";
		expect(compactionReasoningCapabilitiesForModel(model, true)).toMatchObject({
			modelDefault: { kind: "provider_default", relativeOrder: "above_xhigh" },
		});

		const configuredResolution = resolveCompactionReasoningSelection({
			policy: compactionReasoningPolicyForModel(model, true),
			request: { kind: "explicit_effort", effort: "high" },
			capabilities: compactionReasoningCapabilitiesForModel(model, true),
		});

		expect(configuredResolution).toMatchObject({
			kind: "selected",
			decision: { kind: "configuration" },
			selection: { kind: "explicit_effort", effort: "high" },
			provenance: {
				configuration: { kind: "explicit_effort", effort: "high" },
				modelDefault: { kind: "provider_default", relativeOrder: "above_xhigh" },
			},
		});
		expect(resolveCompactionReasoningSelection({
			policy: compactionReasoningPolicyForModel(model, true),
			capabilities: compactionReasoningCapabilitiesForModel(model, true),
			learnedFloor: { kind: "explicit_effort", effort: "minimal" },
		})).toMatchObject({
			kind: "selected",
			decision: {
				kind: "supported_effort_normalization",
				requiredEffort: "minimal",
				appliedEffort: "low",
			},
			selection: { kind: "explicit_effort", effort: "low" },
			provenance: {
				learnedFloor: { kind: "explicit_effort", effort: "minimal" },
			},
		});
		expect(resolveCompactionReasoningSelection({
			policy: compactionReasoningPolicyForModel(model, true),
			request: { kind: "explicit_effort", effort: "low" },
			capabilities: compactionReasoningCapabilitiesForModel(model, true),
		})).toMatchObject({
			kind: "selected",
			decision: { kind: "configuration" },
			selection: { kind: "explicit_effort", effort: "low" },
		});
	});

	it("selects an explicit effort above a provider default known to be below minimal", () => {
		expect(resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "medium" },
			capabilities: {
				support: { kind: "known", efforts: allEfforts },
				modelDefault: { kind: "provider_default", relativeOrder: "below_minimal" },
			},
		})).toMatchObject({
			kind: "selected",
			selection: { kind: "explicit_effort", effort: "medium" },
		});
	});

	it("ignores the semantic disabled-reasoning floor but normalizes an unsupported explicit effort", () => {
		const model = "openai/gpt-5.4-mini";
		const capabilities = compactionReasoningCapabilitiesForModel(model, true);
		expect(capabilities).toMatchObject({
			modelDefault: { kind: "provider_default", relativeOrder: "below_minimal" },
		});

		expect(resolveCompactionReasoningSelection({
			policy: compactionReasoningPolicyForModel(model, true),
			request: { kind: "explicit_effort", effort: "minimal" },
			capabilities,
		})).toMatchObject({
			kind: "selected",
			decision: {
				kind: "supported_effort_normalization",
				requiredEffort: "minimal",
				appliedEffort: "low",
			},
			selection: { kind: "explicit_effort", effort: "low" },
			provenance: {
				configuration: { kind: "explicit_effort", effort: "minimal" },
				modelDefault: { kind: "provider_default", relativeOrder: "below_minimal" },
			},
		});
	});

	it("serves an explicit provider-default request when registry default metadata is absent", () => {
		for (const support of [{ kind: "unsupported" }, { kind: "unknown" }] as const) {
			expect(resolveCompactionReasoningSelection({
				policy: disabledBaselinePolicy(),
				request: { kind: "model_default" },
				capabilities: {
					support,
					modelDefault: { kind: "absent" },
				},
			})).toEqual({
				kind: "selected",
				decision: { kind: "configuration", request: { kind: "model_default" } },
				selection: { kind: "model_default" },
				runtimeFallback: { kind: "none" },
				provenance: {
					configuration: { kind: "model_default" },
					modelDefault: { kind: "absent" },
					safetyFloor: { kind: "reasoning_disabled" },
					learnedFloor: null,
					baselineSelection: { kind: "reasoning_disabled" },
					support: support.kind,
					policySource: "custom_provider",
				},
			});
		}
	});

	it("preserves a shipped unsupported/absent model-default baseline without a request", () => {
		const model = "arcee-ai/virtuoso-large";
		const policy = compactionReasoningPolicyForModel(model, true);
		expect(resolveCompactionReasoningSelection({
			policy,
			capabilities: compactionReasoningCapabilitiesForModel(model, true),
		})).toEqual({
			kind: "selected",
			decision: { kind: "model_default", modelDefault: { kind: "absent" } },
			selection: { kind: "model_default" },
			runtimeFallback: { kind: "none" },
			provenance: {
				configuration: null,
				modelDefault: { kind: "absent" },
				safetyFloor: { kind: "model_default" },
				learnedFloor: null,
				baselineSelection: { kind: "model_default" },
				support: "unsupported",
				policySource: "openrouter_generated",
			},
		});
	});

	it("does not compare an explicit effort with a provider default of unknown relative order", () => {
		const resolution = resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "high" },
			capabilities: {
				support: { kind: "known", efforts: allEfforts },
				modelDefault: { kind: "provider_default", relativeOrder: "unknown" },
			},
		});

		expect(resolution).toMatchObject({
			kind: "selected",
			decision: { kind: "configuration" },
			selection: { kind: "explicit_effort", effort: "high" },
		});
	});

	it("bounds requests below the weakest partial observation and accepts stronger efforts", () => {
		const capabilities = {
			support: { kind: "partially_known", efforts: ["high"] },
			modelDefault: { kind: "provider_default", relativeOrder: "below_minimal" },
		} as const;
		expect(resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "medium" },
			capabilities,
		})).toMatchObject({
			kind: "selected",
			selection: { kind: "explicit_effort", effort: "high" },
			provenance: { support: "partially_known" },
		});
		expect(resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "xhigh" },
			capabilities,
		})).toMatchObject({
			kind: "selected",
			selection: { kind: "explicit_effort", effort: "xhigh" },
		});
		expect(resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "minimal" },
			capabilities: {
				support: { kind: "partially_known", efforts: [] },
				modelDefault: { kind: "provider_default", relativeOrder: "below_minimal" },
			},
		})).toMatchObject({
			kind: "refused",
			refusal: { kind: "support_unknown_for_required_effort", requiredEffort: "minimal" },
		});
	});

	it("returns no_supported_effort only when the model does not support reasoning", () => {
		expect(resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "xhigh" },
			capabilities: { support: { kind: "unsupported" }, modelDefault: { kind: "absent" } },
		})).toMatchObject({
			kind: "refused",
			refusal: {
				kind: "no_supported_effort",
				required: { kind: "explicit_effort", effort: "xhigh" },
				supportedEfforts: [],
			},
		});
		// A known set that stops below the request is not a refusal: reasoning
		// support is monotonic, so support at minimal implies support at xhigh.
		expect(resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "xhigh" },
			capabilities: knownCapabilities(["minimal", "low", "high"]),
		})).toMatchObject({
			kind: "selected",
			selection: { kind: "explicit_effort", effort: "xhigh" },
		});
	});

	it("normalizes unsupported explicit effort and raises disabled reasoning to the exact-model quality floor", () => {
		const model = "deepseek/deepseek-v4-flash-0731";
		expect(resolveCompactionReasoningSelection({
			policy: compactionReasoningPolicyForModel(model, true),
			request: { kind: "explicit_effort", effort: "low" },
			capabilities: compactionReasoningCapabilitiesForModel(model, true),
		})).toMatchObject({
			kind: "selected",
			decision: { kind: "configuration" },
			selection: { kind: "explicit_effort", effort: "low" },
		});
		const resolution = resolveCompactionReasoningSelection({
			policy: compactionReasoningPolicyForModel(model, true),
			request: { kind: "explicit_effort", effort: "minimal" },
			capabilities: compactionReasoningCapabilitiesForModel(model, true),
		});

		expect(resolution).toMatchObject({
			kind: "selected",
			decision: {
				kind: "supported_effort_normalization",
				requiredEffort: "minimal",
				appliedEffort: "low",
			},
			selection: { kind: "explicit_effort", effort: "low" },
			provenance: {
				configuration: { kind: "explicit_effort", effort: "minimal" },
				safetyFloor: { kind: "explicit_effort", effort: "low" },
			},
		});
		expect(resolveCompactionReasoningSelection({
			policy: compactionReasoningPolicyForModel(model, true),
			request: { kind: "reasoning_disabled" },
			capabilities: compactionReasoningCapabilitiesForModel(model, true),
		})).toMatchObject({
			kind: "selected",
			decision: { kind: "safety_floor", floor: { kind: "explicit_effort", effort: "low" } },
			selection: { kind: "explicit_effort", effort: "low" },
		});
	});

	it("attributes a disabled-reasoning quality correction to the safety floor at the resolver", () => {
		const policy: CompactionReasoningPolicy = {
			...disabledBaselinePolicy(),
			floor: { kind: "explicit_effort", effort: "xhigh" },
			selection: { kind: "explicit_effort", effort: "xhigh" },
		};
		expect(resolveCompactionReasoningSelection({
			policy,
			request: { kind: "reasoning_disabled" },
			capabilities: {
				support: { kind: "known", efforts: allEfforts },
				modelDefault: { kind: "absent" },
			},
		})).toMatchObject({
			kind: "selected",
			decision: { kind: "safety_floor", floor: { kind: "explicit_effort", effort: "xhigh" } },
			selection: { kind: "explicit_effort", effort: "xhigh" },
		});
	});

	it("joins the frozen learned minimal floor without replacing a stronger configuration", () => {
		const learnedFloor = { kind: "explicit_effort", effort: "minimal" } as const;
		expect(resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			capabilities: { support: { kind: "unknown" }, modelDefault: { kind: "explicit_effort", effort: "minimal" } },
			learnedFloor,
		})).toMatchObject({
			kind: "selected",
			decision: { kind: "learned_floor", floor: learnedFloor },
			selection: { kind: "explicit_effort", effort: "minimal" },
			provenance: { learnedFloor },
		});
		// The learned minimal floor proves the model reasons, and effort support
		// is monotonic, so the stronger configured request is served as-is.
		expect(resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "high" },
			capabilities: { support: { kind: "unknown" }, modelDefault: { kind: "explicit_effort", effort: "minimal" } },
			learnedFloor,
		})).toMatchObject({
			kind: "selected",
			decision: { kind: "configuration", request: { kind: "explicit_effort", effort: "high" } },
			selection: { kind: "explicit_effort", effort: "high" },
			provenance: { learnedFloor },
		});
	});

	it("preserves generic model-default requests for unknown support", () => {
		const policy = compactionReasoningPolicyForModel(openRouterFreeModel, true);
		expect(resolveCompactionReasoningSelection({
			policy,
			capabilities: compactionReasoningCapabilitiesForModel(openRouterFreeModel, true),
		})).toMatchObject({
			kind: "selected",
			selection: { kind: "model_default" },
		});
	});
});
