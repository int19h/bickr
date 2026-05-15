import { describe, expect, it } from "vitest";
import { quoteSpotlightFocusText } from "./spotlight-focus";

describe("quoteSpotlightFocusText", () => {
	it("quotes a single selected line", () => {
		expect(quoteSpotlightFocusText("Focus this thought")).toBe("> Focus this thought");
	});

	it("quotes every selected line", () => {
		expect(quoteSpotlightFocusText("first line\nsecond line")).toBe("> first line\n> second line");
	});

	it("keeps internal blank selected lines quoted", () => {
		expect(quoteSpotlightFocusText("first line\n\nsecond line")).toBe("> first line\n> \n> second line");
	});

	it("normalizes line endings and trims outer whitespace", () => {
		expect(quoteSpotlightFocusText(" \r\n first line\r\nsecond line \r\n ")).toBe("> first line\n> second line");
	});
});
