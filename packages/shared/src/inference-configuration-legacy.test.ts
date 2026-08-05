import { describe, expect, it } from "vitest";
import { localizedText, type LanguageTag } from "./model";
import {
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
});
