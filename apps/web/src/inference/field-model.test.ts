import { describe, expect, it } from "vitest";
import type {
	InferenceConfigurationField,
	InferenceOverrideUpdate,
} from "@bickr/shared/inference-configuration";
import type {
	InferenceConfigurationPathEntry,
	RedactedInferenceFieldDtoMap,
} from "@bickr/shared/inference-configuration-owner";
import {
	applyCheckboxDomState,
	booleanCheckboxDomState,
	booleanCycleFromDraft,
	draftFromBooleanCycleState,
	draftFromOverride,
	effectiveValueText,
	explicitStatesForField,
	fieldValueText,
	inferenceEditorFields,
	inferenceFieldLabels,
	modeCheckboxDomState,
	nextBooleanCycleState,
	nextBooleanDraft,
	overrideFromDraft,
	overridePatchFromDrafts,
	sourceLabel,
	type BooleanCycleState,
	type InferenceFieldDraft,
} from "./field-model";

const path: InferenceConfigurationPathEntry[] = [
	{ id: "cfg_self", displayName: "Shared sampling", revision: 3, kind: "custom", identity: { kind: "custom", name: "Shared sampling" } },
	{ id: "cfg_mid", displayName: "u/scout", revision: 2, kind: "bot", identity: { kind: "bot", botId: "bot_1", botHandle: "scout", homeWorldId: "wld_1", homeWorldHandle: "patch-notes" } },
	{ id: "cfg_root", displayName: "Account default", revision: 9, kind: "account_default", identity: { kind: "account_default" } },
];

function fields(overrides: Partial<Record<InferenceConfigurationField, InferenceOverrideUpdate<InferenceConfigurationField>>> = {}): RedactedInferenceFieldDtoMap {
	return Object.fromEntries(
		inferenceEditorFields.map((field) => [field, {
			override: overrides[field] ?? { kind: "inherit" },
			effective: null,
			source: { kind: "bickr_default" },
			adjustment: null,
		}]),
	) as RedactedInferenceFieldDtoMap;
}

describe("boolean inheritance cycle", () => {
	// The spec's cycle: inherit -> an explicit copy of the inherited value ->
	// its opposite -> inherit. Click and Space both reach this through the
	// native checkbox change event, so this is the whole interaction contract.
	it("cycles inherit, inherited copy, opposite, inherit when the inherited value is true", () => {
		const seen: BooleanCycleState[] = [];
		let state: BooleanCycleState = { mode: "inherit" };
		for (let step = 0; step < 4; step += 1) {
			state = nextBooleanCycleState(state, true);
			seen.push(state);
		}
		expect(seen).toEqual([
			{ mode: "explicit", value: true },
			{ mode: "explicit", value: false },
			{ mode: "inherit" },
			{ mode: "explicit", value: true },
		]);
	});

	// The whole cycle position lives in the draft, so replaying it from a
	// re-derived state — which is what every render does — cannot strand the
	// control between the two explicit values.
	it("cycles the same way when each step is re-derived from its draft", () => {
		const seen: InferenceFieldDraft[] = [];
		let draft: InferenceFieldDraft = { mode: "inherit" };
		for (let step = 0; step < 4; step += 1) {
			draft = nextBooleanDraft(draft, true);
			seen.push(draft);
		}
		expect(seen).toEqual([
			{ mode: "explicit", state: "value", text: "true" },
			{ mode: "explicit", state: "value", text: "false" },
			{ mode: "inherit" },
			{ mode: "explicit", state: "value", text: "true" },
		]);
	});

	it("seeds the explicit copy from a false inherited value", () => {
		const first = nextBooleanCycleState({ mode: "inherit" }, false);
		expect(first).toEqual({ mode: "explicit", value: false });
		expect(nextBooleanCycleState(first, false)).toEqual({ mode: "explicit", value: true });
	});

	it("returns to inherit within the cycle from a loaded explicit value", () => {
		const loaded = booleanCycleFromDraft({ mode: "explicit", state: "value", text: "false" });
		expect(loaded).toEqual({ mode: "explicit", value: false });
		// A stored value that already differs from the inherited one is the last
		// step of the cycle, so the next click resumes inheritance.
		expect(nextBooleanCycleState(loaded, true)).toEqual({ mode: "inherit" });
		expect(nextBooleanCycleState(loaded, false)).toEqual({ mode: "explicit", value: true });
	});

	it("maps inherit to the DOM mixed state and explicit values to ordinary ones", () => {
		expect(booleanCheckboxDomState({ mode: "inherit" })).toEqual({ checked: false, indeterminate: true });
		expect(booleanCheckboxDomState({ mode: "explicit", value: false })).toEqual({
			checked: false,
			indeterminate: false,
		});
		expect(booleanCheckboxDomState({ mode: "explicit", value: true })).toEqual({
			checked: true,
			indeterminate: false,
		});
	});

	it("writes both DOM properties from component state, never reading them back", () => {
		const element = { checked: true, indeterminate: false };
		applyCheckboxDomState(element, booleanCheckboxDomState({ mode: "inherit" }));
		expect(element).toEqual({ checked: false, indeterminate: true });
		applyCheckboxDomState(element, booleanCheckboxDomState({ mode: "explicit", value: false }));
		expect(element).toEqual({ checked: false, indeterminate: false });
		expect(() => applyCheckboxDomState(null, { checked: true, indeterminate: false })).not.toThrow();
	});

	it("never exposes an unchecked meaning on a mode checkbox", () => {
		expect(modeCheckboxDomState({ mode: "inherit" })).toEqual({ checked: false, indeterminate: true });
		expect(modeCheckboxDomState({ mode: "explicit", state: "value", text: "0" })).toEqual({
			checked: true,
			indeterminate: false,
		});
		expect(modeCheckboxDomState({ mode: "explicit", state: "explicit_none" })).toEqual({
			checked: true,
			indeterminate: false,
		});
	});

	it("round-trips explicit false through the draft protocol", () => {
		const draft = draftFromBooleanCycleState({ mode: "explicit", value: false });
		expect(draft).toEqual({ mode: "explicit", state: "value", text: "false" });
		expect(overrideFromDraft("supportsPrefill", draft, "Supports prefill")).toEqual({
			ok: true,
			update: { kind: "value", value: false },
		});
	});
});

describe("override protocol drafts", () => {
	it("preserves explicit zero, empty routing, provider default, absence, and target default", () => {
		const cases: [InferenceConfigurationField, InferenceOverrideUpdate<InferenceConfigurationField>][] = [
			["temperature", { kind: "value", value: 0 }],
			["providerRouting", { kind: "value", value: {} }],
			["reasoning", { kind: "value", value: { kind: "provider_default" } }],
			["toolCalls", { kind: "value", value: { kind: "provider_default" } }],
			["compactionReasoning", { kind: "value", value: { kind: "model_default" } }],
			["topK", { kind: "explicit_none" }],
			["imageAspectRatio", { kind: "target_default" }],
			["baseUrl", { kind: "account_default" }],
		];
		for (const [field, override] of cases) {
			const draft = draftFromOverride(field, override);
			expect(overrideFromDraft(field, draft, inferenceFieldLabels[field])).toEqual({ ok: true, update: override });
		}
	});

	it("maps every reasoning option back to its typed request", () => {
		expect(overrideFromDraft("reasoning", { mode: "explicit", state: "value", text: "none" }, "Reasoning")).toEqual({
			ok: true,
			update: { kind: "value", value: { kind: "reasoning_disabled" } },
		});
		expect(overrideFromDraft("reasoning", { mode: "explicit", state: "value", text: "high" }, "Reasoning")).toEqual({
			ok: true,
			update: { kind: "value", value: { kind: "explicit_effort", effort: "high" } },
		});
		expect(fieldValueText("reasoning", { kind: "reasoning_disabled" })).toBe("none");
		expect(fieldValueText("compactionReasoning", { kind: "reasoning_disabled" })).toBe("reasoning_disabled");
	});

	it("rejects out-of-domain numbers and invalid routing JSON with typed messages", () => {
		expect(overrideFromDraft("temperature", { mode: "explicit", state: "value", text: "9" }, "Temperature")).toEqual({
			ok: false,
			message: "Temperature must be between 0 and 2.",
		});
		expect(overrideFromDraft("providerRouting", { mode: "explicit", state: "value", text: "[]" }, "Provider routing")).toEqual({
			ok: false,
			message: "Provider routing must be a JSON object.",
		});
		expect(overrideFromDraft("model", { mode: "explicit", state: "value", text: "  " }, "Model")).toEqual({
			ok: false,
			message: "Model needs a value or an inherited state.",
		});
	});

	it("offers only the states each field can actually store", () => {
		expect(explicitStatesForField("model", false)).toEqual(["value"]);
		expect(explicitStatesForField("temperature", false)).toEqual(["value", "explicit_none"]);
		expect(explicitStatesForField("imageSize", false)).toEqual(["value", "explicit_none", "target_default"]);
		expect(explicitStatesForField("baseUrl", false)).toEqual(["value", "account_default"]);
		// Account default has no ancestor to resume at.
		expect(explicitStatesForField("baseUrl", true)).toEqual(["value"]);
	});

	it("patches only fields whose draft moved away from the loaded override", () => {
		const loaded = fields({ baseUrl: { kind: "account_default" }, temperature: { kind: "value", value: 0 } });
		const drafts = Object.fromEntries(
			inferenceEditorFields.map((field) => [field, draftFromOverride(field, loaded[field].override)]),
		) as Record<InferenceConfigurationField, InferenceFieldDraft>;
		expect(overridePatchFromDrafts(drafts, loaded, inferenceFieldLabels)).toEqual({ ok: true, patch: {} });

		drafts.model = { mode: "explicit", state: "value", text: "anthropic/claude-opus-4" };
		const patched = overridePatchFromDrafts(drafts, loaded, inferenceFieldLabels);
		expect(patched).toEqual({
			ok: true,
			patch: { model: { kind: "value", value: "anthropic/claude-opus-4" } },
		});
	});

	it("reports the first invalid field instead of sending a partial patch", () => {
		const loaded = fields();
		const drafts = Object.fromEntries(
			inferenceEditorFields.map((field) => [field, draftFromOverride(field, loaded[field].override)]),
		) as Record<InferenceConfigurationField, InferenceFieldDraft>;
		drafts.topP = { mode: "explicit", state: "value", text: "5" };
		expect(overridePatchFromDrafts(drafts, loaded, inferenceFieldLabels)).toEqual({
			ok: false,
			message: "Top P must be between 0 and 1.",
		});
	});
});

describe("provenance and effective text", () => {
	it("names the ancestor a field came from", () => {
		expect(sourceLabel({ kind: "bickr_default" }, path)).toBe("Bickr defaults");
		expect(sourceLabel({ kind: "account_default", configurationId: "cfg_root", depth: 2 }, path)).toBe("Account default");
		expect(sourceLabel({ kind: "configuration", configurationId: "cfg_mid", configurationKind: "bot", depth: 1 }, path)).toBe("u/scout");
		expect(sourceLabel({ kind: "configuration", configurationId: "cfg_self", configurationKind: "custom", depth: 0 }, path)).toBe(
			"Shared sampling (set here)",
		);
	});

	it("renders effective values without inventing a value for absence", () => {
		expect(effectiveValueText("temperature", 0)).toBe("0");
		expect(effectiveValueText("topK", null)).toBe("no value");
		expect(effectiveValueText("supportsPrefill", false)).toBe("off");
		expect(effectiveValueText("toolCalls", "railroad")).toBe("Railroad");
		expect(effectiveValueText("providerRouting", { order: ["anthropic"] })).toBe('{"order":["anthropic"]}');
	});

	it("summarizes a compaction refusal instead of a value", () => {
		expect(
			effectiveValueText("compactionReasoning", {
				kind: "refused",
				refusal: { kind: "support_unknown_for_required_effort", requiredEffort: "high" },
				provenance: {
					configuration: { kind: "explicit_effort", effort: "high" },
					modelDefault: { kind: "absent" },
					safetyFloor: { kind: "model_default" },
					learnedFloor: null,
					baselineSelection: { kind: "model_default" },
					support: "unknown",
					policySource: "openrouter_unknown",
				},
			}),
		).toBe("refused by provider policy");
	});
});
