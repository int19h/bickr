import { describe, expect, it } from "vitest";
import { effectivePostingSettings, postingHardLimit } from "./posting";
import {
	maxCommentBodyHardLength,
	maxThreadBodyHardLength,
	parseCreateCommentInput,
	parseCreateThreadInput,
	parseCreateWorldInput,
	parseUpdateBotInput,
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

	it("reports hard limit as twice the effective soft limit", () => {
		expect(postingHardLimit(123)).toBe(246);
	});
});
