import { describe, expect, it } from "vitest";
import {
	compactionReasoningCapabilitiesForModel,
	compactionReasoningPolicyForModel,
	openRouterFreeModel,
	openRouterModelCapabilities,
	openRouterModelPolicy,
	resolveCompactionReasoningSelection,
	type CompactionReasoningCapabilities,
	type CompactionReasoningEffort,
	type CompactionReasoningPolicy,
} from "./openrouter-model-capabilities";

const allEfforts = ["minimal", "low", "medium", "high", "xhigh"] as const;

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
			support: { kind: "known", efforts: ["high", "low", "medium", "xhigh"] },
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
			modelDefault: { kind: "provider_default" },
		});
	});

	it("keeps ordinary-loop reasoning defaults unchanged", () => {
		expect(openRouterModelPolicy("openai/gpt-5-mini").defaultReasoningEffort).toBe("minimal");
	});
});

describe("compaction reasoning policy", () => {
	it("joins the exact DeepSeek safety floor with its metadata default without shadowing generated capabilities", () => {
		const policy = openRouterModelPolicy("deepseek/deepseek-v4-flash-0731");

		expect(policy).toMatchObject({
			cacheControl: false,
			compactionReasoningFloor: { kind: "explicit_effort", effort: "low" },
			contextLength: 1_048_576,
			disabledReasoning: true,
			prefill: true,
			requiredToolCalls: true,
			structuredOutputs: true,
		});
		expect(compactionReasoningPolicyForModel("deepseek/deepseek-v4-flash-0731", true)).toMatchObject({
			floor: { kind: "explicit_effort", effort: "low" },
			selection: { kind: "explicit_effort", effort: "high" },
			source: "openrouter_semantic_override",
		});
		expect(compactionReasoningPolicyForModel("deepseek/deepseek-v4-flash-0731:free", true)).toMatchObject({
			floor: { kind: "model_default" },
			selection: { kind: "model_default" },
			source: "openrouter_unknown",
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
			selection: { kind: "explicit_effort", effort },
			provenance: {
				configuration: { kind: "explicit_effort", effort },
				modelDefault: { kind: "explicit_effort", effort: "minimal" },
				safetyFloor: { kind: "reasoning_disabled" },
				learnedFloor: null,
			},
		});
	});

	it("selects the least known-supported effort at or above a joined requirement", () => {
		const resolution = resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "medium" },
			capabilities: knownCapabilities(["xhigh", "low", "high"]),
		});

		expect(resolution).toMatchObject({
			kind: "selected",
			selection: { kind: "explicit_effort", effort: "high" },
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

	it("returns support_unknown_for_required_effort for a stronger unknown explicit requirement", () => {
		const resolution = resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "high" },
			capabilities: { support: { kind: "unknown" }, modelDefault: { kind: "provider_default" } },
		});

		expect(resolution).toMatchObject({
			kind: "refused",
			refusal: { kind: "support_unknown_for_required_effort", requiredEffort: "high" },
		});
	});

	it("returns no_supported_effort for known and unsupported unsatisfiable requirements", () => {
		for (const capabilities of [
			knownCapabilities(["minimal", "low", "high"]),
			{ support: { kind: "unsupported" }, modelDefault: { kind: "absent" } } as const,
		]) {
			const resolution = resolveCompactionReasoningSelection({
				policy: disabledBaselinePolicy(),
				request: { kind: "explicit_effort", effort: "xhigh" },
				capabilities,
			});

			expect(resolution).toMatchObject({
				kind: "refused",
				refusal: {
					kind: "no_supported_effort",
					required: { kind: "explicit_effort", effort: "xhigh" },
				},
			});
		}
	});

	it("never rounds a request below the model default or semantic safety floor", () => {
		const model = "deepseek/deepseek-v4-flash-0731";
		const resolution = resolveCompactionReasoningSelection({
			policy: compactionReasoningPolicyForModel(model, true),
			request: { kind: "explicit_effort", effort: "minimal" },
			capabilities: compactionReasoningCapabilitiesForModel(model, true),
		});

		expect(resolution).toMatchObject({
			kind: "selected",
			selection: { kind: "explicit_effort", effort: "high" },
			provenance: {
				configuration: { kind: "explicit_effort", effort: "minimal" },
				safetyFloor: { kind: "explicit_effort", effort: "low" },
			},
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
			selection: { kind: "explicit_effort", effort: "minimal" },
			provenance: { learnedFloor },
		});
		expect(resolveCompactionReasoningSelection({
			policy: disabledBaselinePolicy(),
			request: { kind: "explicit_effort", effort: "high" },
			capabilities: { support: { kind: "unknown" }, modelDefault: { kind: "explicit_effort", effort: "minimal" } },
			learnedFloor,
		})).toMatchObject({
			kind: "refused",
			refusal: { kind: "support_unknown_for_required_effort", requiredEffort: "high" },
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
