import { describe, expect, it } from "vitest";
import { localizedText, type LanguageTag } from "./model";
import {
	inferenceOverridePatchFromLegacyBotSettingsMask,
	legacyImageCompatibilityFieldMask,
	legacyInferenceCompatibilityFieldMask,
	legacyInferenceCompatibilityFieldMaskIsEmpty,
} from "./inference-configuration-legacy";

const en = "en" as LanguageTag;

describe("legacy inference compatibility intent", () => {
	it("excludes account, participant, image, and translation prompt/toggle-only fields", () => {
		const promptOnly = legacyInferenceCompatibilityFieldMask({
			recurringPromptEnabled: true,
			recurringPrompt: localizedText("Keep participating", en),
			imageGeneration: { prompt: localizedText("Portrait prompt", en) },
			translation: {
				enabled: true,
				prompt: localizedText("Translate exactly", en),
			},
		});
		expect(promptOnly).toEqual({ fields: [], translationFields: [], credential: false });
		expect(legacyInferenceCompatibilityFieldMaskIsEmpty(promptOnly)).toBe(true);

		const worldPromptOnly = legacyImageCompatibilityFieldMask({
			prompt: localizedText("Landscape prompt", en),
		});
		expect(worldPromptOnly).toEqual({ fields: [], translationFields: [], credential: false });
		expect(legacyInferenceCompatibilityFieldMaskIsEmpty(worldPromptOnly)).toBe(true);
	});

	it("records only explicitly requested reusable fields without secret values", () => {
		expect(legacyInferenceCompatibilityFieldMask({
			openRouterApiKey: "secret-never-enters-the-mask",
			temperature: 0,
			imageGeneration: { topK: 1.5 },
			translation: { model: "translator/model", enabled: true },
		})).toEqual({
			fields: ["temperature", "imageTopK"],
			translationFields: ["model"],
			credential: true,
		});
	});

	it("treats an explicit nested clear as intent for every reusable nested field", () => {
		const account = legacyInferenceCompatibilityFieldMask({ imageGeneration: null });
		expect(account.fields).toEqual([
			"imageModel", "imageProviderRouting", "imageAspectRatio", "imageSize",
			"imageTemperature", "imageTopK", "imageTopP", "imageMinP",
			"imageFrequencyPenalty", "imagePresencePenalty", "imageRepetitionPenalty",
		]);
		expect(legacyImageCompatibilityFieldMask(null).fields).toEqual(account.fields);
	});

	it("moves the linked-clone base URL barrier with every model transition the request states", () => {
		const mask = legacyInferenceCompatibilityFieldMask({ model: "clone/model", baseUrl: null });
		expect(mask.fields).toEqual(["baseUrl", "model"]);

		expect(inferenceOverridePatchFromLegacyBotSettingsMask({ model: "clone/model" }, mask, { linkedClone: true }))
			.toEqual({ baseUrl: { kind: "account_default" }, model: { kind: "value", value: "clone/model" } });
		// An explicit local base URL stays an ordinary owner value.
		expect(inferenceOverridePatchFromLegacyBotSettingsMask(
			{ model: "clone/model", baseUrl: "https://clone.example/v1" },
			mask,
			{ linkedClone: true },
		)).toEqual({
			baseUrl: { kind: "value", value: "https://clone.example/v1" },
			model: { kind: "value", value: "clone/model" },
		});
		// Without a local model the whole local bundle stayed dormant, and an
		// ordinary participant has no source to bypass in the first place.
		expect(inferenceOverridePatchFromLegacyBotSettingsMask({}, mask, { linkedClone: true }))
			.toEqual({ baseUrl: { kind: "inherit" }, model: { kind: "inherit" } });
		expect(inferenceOverridePatchFromLegacyBotSettingsMask({ model: "bot/model" }, mask, { linkedClone: false }))
			.toEqual({ baseUrl: { kind: "inherit" }, model: { kind: "value", value: "bot/model" } });
		// The model field alone carries the whole bundle's intent, because legacy
		// gated the clone's provider fallbacks on it.
		const modelOnly = legacyInferenceCompatibilityFieldMask({ model: "clone/model" });
		expect(inferenceOverridePatchFromLegacyBotSettingsMask({ model: "clone/model" }, modelOnly, { linkedClone: true }))
			.toEqual({ baseUrl: { kind: "account_default" }, model: { kind: "value", value: "clone/model" } });
		expect(inferenceOverridePatchFromLegacyBotSettingsMask(
			{ model: "clone/model", baseUrl: "https://clone.example/v1" },
			modelOnly,
			{ linkedClone: true },
		)).toEqual({
			baseUrl: { kind: "value", value: "https://clone.example/v1" },
			model: { kind: "value", value: "clone/model" },
		});
		// Clearing the model returns the newly dormant clone to its source path.
		const clearedModel = legacyInferenceCompatibilityFieldMask({ model: null });
		expect(inferenceOverridePatchFromLegacyBotSettingsMask({}, clearedModel, { linkedClone: true }))
			.toEqual({ baseUrl: { kind: "inherit" }, model: { kind: "inherit" } });
		// A write that never mentioned the model says nothing about the bundle, so
		// it restates the merged model without touching either barrier.
		const unrelated = legacyInferenceCompatibilityFieldMask({ temperature: 0.25 });
		expect(inferenceOverridePatchFromLegacyBotSettingsMask(
			{ model: "clone/model", temperature: 0.25 },
			unrelated,
			{ linkedClone: true },
		)).toEqual({
			model: { kind: "value", value: "clone/model" },
			temperature: { kind: "value", value: 0.25 },
		});
	});
});
