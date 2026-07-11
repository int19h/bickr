import type { BotInferenceSettings, LanguageTag } from "@bickr/shared/model";
import { mergeInferenceSettings } from "@bickr/shared/repository";
import { describe, expect, it } from "vitest";
import {
	inferenceDraftChanged,
	inferenceDraftFromSettings,
	inferenceFieldDescriptors,
	inferenceInputFromDraft,
} from "./inference-draft";

const en = "en" as LanguageTag;

const allDomains = {
	includeReasoningPrefill: true,
	includeImageGeneration: true,
	includeTranslation: true,
} as const;

describe("inference settings draft", () => {
	it.each([
		["empty", {}],
		["partial", { baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-haiku-4.5", temperature: 0.4 }],
		["default-heavy", {
			baseUrl: "https://openrouter.ai/api/v1",
			model: "anthropic/claude-haiku-4.5",
			compactionMode: "tool_call",
			promptCacheMode: "openrouter_anthropic_5m",
			recurringPromptEnabled: false,
			recurringPrompt: { text: "Review the latest activity.", lang: en },
			supportsPrefill: true,
			reasoningEffort: "high",
			toolCalls: "require",
			providerRouting: { order: ["Anthropic"] },
			imageGeneration: { model: "google/gemini-3.1-flash-image", aspectRatio: "1:1" },
			translation: { enabled: true, model: "openai/gpt-4.1-mini" },
			temperature: 0,
			topK: 1,
			topP: 1,
			minP: 0,
			frequencyPenalty: 0,
			presencePenalty: 0,
			repetitionPenalty: 1,
		}],
	] satisfies readonly (readonly [string, BotInferenceSettings])[])(
		"keeps %s settings stable through draft, input, and merge",
		(_name, rawSettings) => {
			const settings = mergeInferenceSettings(undefined, rawSettings);
			const draft = inferenceDraftFromSettings(settings);
			const input = inferenceInputFromDraft(draft, undefined, allDomains);
			const merged = mergeInferenceSettings(settings, input);

			expect(inferenceDraftFromSettings(merged)).toEqual(draft);
		},
	);

	it("treats a fresh draft as unchanged", () => {
		const settings = settingsForDirtyChecks();
		expect(inferenceDraftChanged(inferenceDraftFromSettings(settings), settings, allDomains)).toBe(false);
	});

	it.each(inferenceFieldDescriptors.map(({ key }) => key))("marks an edit to %s as changed", (key) => {
		const settings = settingsForDirtyChecks();
		const draft = inferenceDraftFromSettings(settings);
		const edits: Partial<Record<keyof typeof draft, unknown>> = {
			baseUrl: "https://example.com/v1",
			model: "anthropic/claude-opus-4.6",
			compactionMode: "tool_call_cache_friendly",
			promptCacheMode: "openrouter_anthropic_1h",
			recurringPromptEnabled: !draft.recurringPromptEnabled,
			recurringPrompt: `${draft.recurringPrompt} edited`,
			supportsPrefill: !draft.supportsPrefill,
			reasoningEffort: "high",
			toolCalls: "at_will",
			providerRouting: "{\"order\":[\"Google\"]}",
			temperature: "0.1",
			topK: "2",
			topP: "0.9",
			minP: "0.1",
			frequencyPenalty: "0.1",
			presencePenalty: "0.1",
			repetitionPenalty: "1.1",
		};
		(draft as Record<string, unknown>)[key] = edits[key];

		expect(inferenceDraftChanged(draft, settings, allDomains)).toBe(true);
	});

	it("tracks the bespoke credential edit states", () => {
		const settings = settingsForDirtyChecks();
		const keyDraft = inferenceDraftFromSettings(settings);
		keyDraft.openRouterApiKey = "sk-new";
		expect(inferenceDraftChanged(keyDraft, settings, allDomains)).toBe(true);

		const clearDraft = inferenceDraftFromSettings(settings);
		clearDraft.clearOpenRouterApiKey = true;
		expect(inferenceDraftChanged(clearDraft, settings, allDomains)).toBe(true);
	});
});

function settingsForDirtyChecks(): BotInferenceSettings {
	return mergeInferenceSettings(undefined, {
		baseUrl: "https://openrouter.ai/api/v1",
		model: "anthropic/claude-haiku-4.5",
		promptCacheMode: "openrouter_anthropic_5m",
		recurringPrompt: { text: "Check for updates.", lang: en },
		providerRouting: { order: ["Anthropic"] },
		temperature: 0,
		topK: 1,
		topP: 1,
		minP: 0,
		frequencyPenalty: 0,
		presencePenalty: 0,
		repetitionPenalty: 1,
	});
}
