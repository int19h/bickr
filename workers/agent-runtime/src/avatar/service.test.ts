import { describe, expect, it } from "vitest";
import type { LanguageTag } from "@bickr/shared/model";
import { parseImageGenerationSettingsOverride } from "./service";

const enLang = "en" as LanguageTag;

describe("avatar image generation settings validation", () => {
	it("parses localized image generation prompts with the target entity language", () => {
		const uk = "uk" as LanguageTag;

		expect(parseImageGenerationSettingsOverride({
			model: "google/gemini-3.1-flash-image-preview",
			prompt: { lang: "uk", text: "Намалюй аватар." },
		}, uk)).toMatchObject({
			model: "google/gemini-3.1-flash-image-preview",
			prompt: { lang: "uk", text: "Намалюй аватар." },
		});
		expect(() => parseImageGenerationSettingsOverride({
			prompt: { lang: "uk", text: "Намалюй аватар." },
		}, enLang)).toThrow("Image generation prompt.lang must match the selected language for this entity.");
	});
});
