import { describe, expect, it } from "vitest";
import { localizedText, type LanguageTag } from "./model";
import { assertWorldRecurringPromptConfiguration } from "./repository";
import {
	maxWorldRecurringPromptLength,
	parseCreateWorldInput,
	parseUpdateWorldInput,
} from "./validation";

const en = "en" as LanguageTag;

describe("world recurring prompt validation", () => {
	it("parses enabled localized text using the established world-text normalization", () => {
		expect(parseCreateWorldInput({
			handle: "recurring-world",
			language: en,
			name: "Recurring World",
			description: "Shared loop narration.",
			recurringPromptEnabled: true,
			recurringPrompt: "I remember the shared focus.  ",
		})).toMatchObject({
			recurringPromptEnabled: true,
			recurringPrompt: localizedText("I remember the shared focus.", en),
		});
	});

	it("requires a boolean enable flag and a language for localized update text", () => {
		expect(() => parseCreateWorldInput({
			handle: "recurring-world",
			language: en,
			name: "Recurring World",
			description: "Shared loop narration.",
			recurringPromptEnabled: "yes",
		})).toThrow("World recurring prompt enabled must be a boolean.");
		expect(() => parseUpdateWorldInput({
			recurringPrompt: "I remember the shared focus.",
		})).toThrow("World language must be a BCP 47 language tag");
	});

	it("enforces the shared recurring-prompt length limit", () => {
		expect(() => parseUpdateWorldInput({
			language: en,
			recurringPrompt: "x".repeat(maxWorldRecurringPromptLength + 1),
		})).toThrow(`World recurring prompt must be ${maxWorldRecurringPromptLength} characters or fewer.`);
	});

	it("rejects enabled blank text at the write invariant boundary", () => {
		expect(() => assertWorldRecurringPromptConfiguration({
			recurringPromptEnabled: true,
			recurringPrompt: localizedText("   ", en),
		})).toThrow("World recurring prompt text is required when the recurring prompt is enabled.");
		expect(() => assertWorldRecurringPromptConfiguration({
			recurringPromptEnabled: false,
			recurringPrompt: localizedText("   ", en),
		})).not.toThrow();
	});
});
