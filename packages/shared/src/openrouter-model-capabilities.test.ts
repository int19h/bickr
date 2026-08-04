import { describe, expect, it } from "vitest";
import {
	compactionReasoningPolicyForModel,
	openRouterFreeModel,
	openRouterModelPolicy,
} from "./openrouter-model-capabilities";

describe("compaction reasoning policy", () => {
	it("raises only the exact DeepSeek model to low without shadowing generated capabilities", () => {
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
			selection: { kind: "explicit_effort", effort: "low" },
			source: "openrouter_semantic_override",
		});
		expect(compactionReasoningPolicyForModel("deepseek/deepseek-v4-flash-0731:free", true)).toMatchObject({
			floor: { kind: "model_default" },
			selection: { kind: "model_default" },
			source: "openrouter_unknown",
		});
	});

	it("keeps the Xiaomi minimum route-sensitive", () => {
		expect(compactionReasoningPolicyForModel("xiaomi/mimo-v2.5", true, { only: ["xiaomi/fp8"] })).toMatchObject({
			floor: { kind: "model_default" },
			knownFailure: "server_tool_crash",
			selection: { kind: "model_default", effort: "minimal" },
		});
		expect(compactionReasoningPolicyForModel("xiaomi/mimo-v2.5", true)).toMatchObject({
			floor: { kind: "reasoning_disabled" },
			selection: { kind: "reasoning_disabled" },
		});
	});

	it("preserves conservative OpenRouter omission and typed custom-provider fallback", () => {
		for (const model of [openRouterFreeModel, "unknown/provider-model"]) {
			expect(compactionReasoningPolicyForModel(model, true)).toMatchObject({
				floor: { kind: "model_default" },
				modelDefaultSelection: { kind: "model_default" },
				runtimeFallback: { kind: "none" },
				selection: { kind: "model_default" },
			});
		}
		expect(compactionReasoningPolicyForModel("local/model", false)).toMatchObject({
			floor: { kind: "reasoning_disabled" },
			runtimeFallback: {
				kind: "unknown_model",
				selection: { kind: "model_default", effort: "minimal" },
			},
			selection: { kind: "reasoning_disabled" },
		});
	});
});
