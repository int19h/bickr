import type { BotInferenceSettings, LanguageTag } from "@bickr/shared/model";
import { mergeInferenceSettings } from "@bickr/shared/repository";
import { describe, expect, it } from "vitest";
import { inferenceDraftFromSettings } from "./inference-draft";
import {
	translationDraftChanged,
	translationDraftFromSettings,
	translationFieldDescriptors,
	translationInputFromDraft,
} from "./translation-draft";

const en = "en" as LanguageTag;

describe("translation settings draft", () => {
	it.each([
		["empty", {}],
		["partial", { translation: { enabled: true, model: "openai/gpt-4.1-mini" } }],
		["default-heavy", {
			baseUrl: "https://openrouter.ai/api/v1",
			model: "anthropic/claude-haiku-4.5",
			translation: {
				enabled: true,
				model: "openai/gpt-4.1-mini",
				prompt: { text: "Translate faithfully.", lang: en },
				reasoningEffort: "high",
				toolCalls: "require",
				providerRouting: { allow_fallbacks: false },
				temperature: 0,
				topK: 1,
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
			const draft = inferenceDraftFromSettings(settings);
			const input = translationInputFromDraft(draft);
			const merged = mergeInferenceSettings(settings, { translation: input });

			expect(translationDraftFromSettings(merged)).toEqual(translationDraftFromSettings(settings));
		},
	);

	it("treats a fresh draft as unchanged", () => {
		const settings = mergeInferenceSettings(undefined, {
			baseUrl: "https://openrouter.ai/api/v1",
			model: "anthropic/claude-haiku-4.5",
			translation: { enabled: true },
		});
		expect(translationDraftChanged(inferenceDraftFromSettings(settings), settings)).toBe(false);
	});

	it.each(translationFieldDescriptors.map(({ key }) => key))("marks an edit to %s as changed", (key) => {
		const settings = mergeInferenceSettings(undefined, {
			baseUrl: "https://openrouter.ai/api/v1",
			model: "anthropic/claude-haiku-4.5",
		});
		const draft = inferenceDraftFromSettings(settings);
		const current = draft[key];
		(draft as Record<string, unknown>)[key] = typeof current === "boolean" ? !current : `${current} edited`;

		expect(translationDraftChanged(draft, settings)).toBe(true);
	});
});
