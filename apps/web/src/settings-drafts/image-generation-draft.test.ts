import type { BotInferenceSettings, LanguageTag } from "@bickr/shared/model";
import { mergeInferenceSettings } from "@bickr/shared/repository";
import { describe, expect, it } from "vitest";
import {
	imageGenerationDraftChanged,
	imageGenerationDraftFromSettings,
	imageGenerationFieldDescriptors,
	imageGenerationInputFromDraft,
} from "./image-generation-draft";

const en = "en" as LanguageTag;

describe("image generation settings draft", () => {
	it.each([
		["empty", {}],
		["partial", { imageGeneration: { model: "google/gemini-3.1-flash-image", topP: 0.8 } }],
		["default-heavy", {
			imageGeneration: {
				model: "google/gemini-3.1-flash-image",
				prompt: { text: "Draw a quiet harbor", lang: en },
				providerRouting: { order: ["Google"] },
				aspectRatio: "16:9",
				imageSize: "2K",
				temperature: 0,
				topK: 40,
				topP: 1,
				minP: 0,
				frequencyPenalty: 0,
				presencePenalty: 0,
				repetitionPenalty: 1,
			},
		}],
	] satisfies readonly (readonly [string, BotInferenceSettings])[])(
		"keeps %s settings stable through draft, input, and merge",
		(_name, rawSettings) => {
			const settings = mergeInferenceSettings(undefined, rawSettings);
			const draft = imageGenerationDraftFromSettings(settings);
			const input = imageGenerationInputFromDraft(draft);
			const merged = mergeInferenceSettings(settings, { imageGeneration: input });

			expect(imageGenerationDraftFromSettings(merged)).toEqual(draft);
		},
	);

	it("treats a fresh draft as unchanged", () => {
		const settings = mergeInferenceSettings(undefined, {
			imageGeneration: { model: "google/gemini-3.1-flash-image", aspectRatio: "1:1" },
		});
		expect(imageGenerationDraftChanged(imageGenerationDraftFromSettings(settings), settings)).toBe(false);
	});

	it.each(imageGenerationFieldDescriptors.map(({ key }) => key))("marks an edit to %s as changed", (key) => {
		const settings = mergeInferenceSettings(undefined, {});
		const draft = imageGenerationDraftFromSettings(settings);
		(draft as Record<string, unknown>)[key] = `${String(draft[key])} edited`;

		expect(imageGenerationDraftChanged(draft, settings)).toBe(true);
	});
});
