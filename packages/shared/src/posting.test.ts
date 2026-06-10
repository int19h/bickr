import { describe, expect, it } from "vitest";
import { effectivePostingSettings, postingHardLimit } from "./posting";
import {
	maxCommentBodyHardLength,
	maxThreadBodyHardLength,
	parseBotContextBudgetInput,
	parseCreateBotGroupInput,
	parseCreateBotInput,
	parseCreateForumInput,
	parseCreateCommentInput,
	parseCreateThreadInput,
	parseCreateWorldInput,
	parseUpdateBotInput,
	parseUpdateBotGroupInput,
	parseUpdateForumInput,
	parseUpdateUserProfileInput,
	parseUpdateWorldInput,
} from "./validation";

const en = (text: string) => ({ lang: "en", text });

describe("posting settings", () => {
	it("composes defaults, world limits, bot limits, and world plus bot limits", () => {
		expect(effectivePostingSettings(undefined, undefined)).toEqual({
			threadBodyCharacters: 8000,
			commentBodyCharacters: 4000,
		});
		expect(effectivePostingSettings({ threadBodyCharacters: 6000 }, undefined)).toEqual({
			threadBodyCharacters: 6000,
			commentBodyCharacters: 4000,
		});
		expect(effectivePostingSettings(undefined, { commentBodyCharacters: 2000 })).toEqual({
			threadBodyCharacters: 8000,
			commentBodyCharacters: 2000,
		});
		expect(effectivePostingSettings(
			{ threadBodyCharacters: 6000, commentBodyCharacters: 3000 },
			{ threadBodyCharacters: 4500, commentBodyCharacters: 3500 },
		)).toEqual({
			threadBodyCharacters: 4500,
			commentBodyCharacters: 3000,
		});
	});

	it("accepts posting bodies through the global hard limit and preserves exact text", () => {
		const body = "  " + "x".repeat(maxThreadBodyHardLength - 4) + "  ";
		expect(parseCreateThreadInput({ title: en("Title"), body: en(body) })).toMatchObject({ body: en(body) });
		expect(parseCreateCommentInput({ body: en("x".repeat(maxCommentBodyHardLength)) })).toMatchObject({
			body: en("x".repeat(maxCommentBodyHardLength)),
		});
	});

	it("rejects posting bodies above the global hard limit or containing only whitespace", () => {
		expect(() => parseCreateThreadInput({ title: en("Title"), body: en("x".repeat(maxThreadBodyHardLength + 1)) }))
			.toThrow(`Thread body.text must be ${maxThreadBodyHardLength} characters or fewer.`);
		expect(() => parseCreateCommentInput({ body: en("x".repeat(maxCommentBodyHardLength + 1)) }))
			.toThrow(`Comment body.text must be ${maxCommentBodyHardLength} characters or fewer.`);
		expect(() => parseCreateThreadInput({ title: en("Title"), body: en("\n\t ") })).toThrow("Thread body.text is required.");
		expect(() => parseCreateCommentInput({ body: en("\n\t ") })).toThrow("Comment body.text is required.");
	});

	it("parses world and bot posting settings and null clears", () => {
		expect(parseCreateWorldInput({
			handle: "world",
			language: "en",
			name: "World",
			description: "Description",
			postingSettings: {
				threadBodyCharacters: 7000,
				commentBodyCharacters: 3000,
			},
		}).postingSettings).toEqual({
			threadBodyCharacters: 7000,
			commentBodyCharacters: 3000,
		});
		expect(parseUpdateWorldInput({
			postingSettings: {
				threadBodyCharacters: null,
				commentBodyCharacters: null,
			},
		}).postingSettings).toEqual({
			threadBodyCharacters: null,
			commentBodyCharacters: null,
		});
		expect(parseUpdateBotInput({
			postingSettings: {
				threadBodyCharacters: 1000,
				commentBodyCharacters: null,
			},
		}).postingSettings).toEqual({
			threadBodyCharacters: 1000,
			commentBodyCharacters: null,
		});
	});

	it("parses language system prompt settings for bot create and update inputs", () => {
		expect(parseCreateBotInput({
			handle: "default-language-prompt",
			language: "en",
			displayName: en("Default Language Prompt"),
			shortBio: en("Default language prompt."),
			prompt: en("Use the configured language."),
		}).includeLanguageInSystemPrompt).toBe(true);
		expect(parseCreateBotInput({
			handle: "clone-language-prompt",
			language: null,
			displayName: "",
			shortBio: "",
			prompt: "",
			cloneSourceBotId: "bot_source",
		}).includeLanguageInSystemPrompt).toBe(null);
		expect(parseUpdateBotInput({ includeLanguageInSystemPrompt: true })).toEqual({ includeLanguageInSystemPrompt: true });
		expect(parseUpdateBotInput({ includeLanguageInSystemPrompt: false })).toEqual({ includeLanguageInSystemPrompt: false });
		expect(parseUpdateBotInput({ includeLanguageInSystemPrompt: null })).toEqual({ includeLanguageInSystemPrompt: null });
		expect(() => parseUpdateBotInput({ includeLanguageInSystemPrompt: "" })).toThrow(
			"includeLanguageInSystemPrompt must be a boolean or null.",
		);
	});

	it("accepts localized text objects for human-authored entity forms", () => {
		expect(parseCreateWorldInput({
			handle: "localized-world",
			language: "en",
			name: en("Localized World"),
			description: en("Localized world description."),
			prompt: en("World prompt."),
			initialBotNotification: en("Welcome."),
		})).toMatchObject({
			language: "en",
			name: en("Localized World"),
			description: en("Localized world description."),
			prompt: en("World prompt."),
			initialBotNotification: en("Welcome."),
		});
		expect(parseCreateForumInput({
			handle: "localized-forum",
			language: "en",
			description: en("Localized forum description."),
		})).toMatchObject({
			language: "en",
			description: en("Localized forum description."),
		});
		expect(parseUpdateForumInput({
			language: "en",
			description: en("Updated forum description."),
		})).toMatchObject({
			language: "en",
			description: en("Updated forum description."),
		});
		expect(parseCreateBotInput({
			handle: "localized-bot",
			language: "en",
			displayName: en("Localized Bot"),
			shortBio: en("Localized short bio."),
			prompt: en("Localized prompt."),
		})).toMatchObject({
			language: "en",
			displayName: en("Localized Bot"),
			shortBio: en("Localized short bio."),
			prompt: en("Localized prompt."),
		});
		expect(parseCreateBotInput({
			handle: "localized-clone",
			language: null,
			displayName: "",
			shortBio: "",
			prompt: "",
			cloneSourceBotId: "bot_source",
		})).toMatchObject({
			language: null,
			displayName: { lang: null, text: "" },
			shortBio: { lang: null, text: "" },
			prompt: { lang: null, text: "" },
			cloneSourceBotId: "bot_source",
		});
		expect(parseUpdateBotInput({
			language: "en",
			displayName: en("Updated Bot"),
			shortBio: en("Updated short bio."),
			prompt: en("Updated prompt."),
			inferenceSettings: {
				recurringPrompt: en("Keep the trailing spaces.  "),
				imageGeneration: { prompt: en("Paint the profile.") },
				translation: { prompt: en("Translate replies.") },
			},
		})).toMatchObject({
			language: "en",
			displayName: en("Updated Bot"),
			shortBio: en("Updated short bio."),
			prompt: en("Updated prompt."),
			inferenceSettings: {
				recurringPrompt: en("Keep the trailing spaces.  "),
				imageGeneration: { prompt: en("Paint the profile.") },
				translation: { prompt: en("Translate replies.") },
			},
		});
		expect(parseUpdateBotInput({
			language: null,
			displayName: { lang: null, text: "" },
			shortBio: { lang: null, text: "" },
			prompt: { lang: null, text: "" },
		})).toMatchObject({
			language: null,
			displayName: { lang: null, text: "" },
			shortBio: { lang: null, text: "" },
			prompt: { lang: null, text: "" },
		});
		expect(parseUpdateUserProfileInput({
			language: "en",
			uiLocale: "ja",
			displayName: en("Localized Human"),
		})).toMatchObject({
			language: "en",
			uiLocale: "ja",
			displayName: en("Localized Human"),
		});
		expect(parseCreateBotGroupInput({
			language: "en",
			customTitle: en("Favorites"),
		})).toMatchObject({
			language: "en",
			customTitle: en("Favorites"),
		});
		expect(parseUpdateBotGroupInput({
			language: "en",
			customTitle: en(""),
		})).toEqual({
			language: "en",
			customTitle: null,
		});
		expect(parseBotContextBudgetInput({
			language: "en",
			includeLanguageInSystemPrompt: true,
			displayName: en("Budget Bot"),
			prompt: en("Count this draft prompt."),
			shortBio: en("Counts context."),
			inferenceSettings: {
				recurringPrompt: en("Preserve this prefill.  "),
				translation: { prompt: en("Translate budget text.") },
			},
		})).toMatchObject({
			language: "en",
			includeLanguageInSystemPrompt: true,
			displayName: "Budget Bot",
			prompt: "Count this draft prompt.",
			shortBio: "Counts context.",
			inferenceSettings: {
				recurringPrompt: en("Preserve this prefill.  "),
				translation: { prompt: en("Translate budget text.") },
			},
		});
	});

	it("rejects localized human-authored text when the object language does not match the selected language", () => {
		expect(() => parseCreateWorldInput({
			handle: "localized-world",
			language: "ja",
			name: en("Localized World"),
			description: { lang: "ja", text: "説明" },
		})).toThrow("World name.lang must match the selected language for this entity.");
	});

	it("reports hard limit as twice the effective soft limit", () => {
		expect(postingHardLimit(123)).toBe(246);
	});
});
