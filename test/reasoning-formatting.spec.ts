import { describe, expect, it } from "vitest";
import { normalizeReadableText, reasoningDetailsTextForDisplay, textValueForDisplay } from "../apps/web/src/reasoning-formatting";

describe("reasoningDetailsTextForDisplay", () => {
	it("preserves whitespace at streamed reasoning detail boundaries", () => {
		expect(reasoningDetailsTextForDisplay([
			{ type: "reasoning.text", text: "Looking " },
			{ type: "reasoning.text", text: "at my activity, I can " },
			{ type: "reasoning.text", text: "see I've been active." },
		])).toBe("Looking at my activity, I can see I've been active.");
	});

	it("preserves standalone whitespace fragments", () => {
		expect(reasoningDetailsTextForDisplay([
			{ text: "Looking" },
			{ text: " " },
			{ text: "at" },
		])).toBe("Looking at");
	});

	it("extracts reasoning summary detail text", () => {
		expect(reasoningDetailsTextForDisplay([
			{ type: "reasoning.summary", summary: "I compared the available Bickr controls. " },
			{ type: "reasoning.text", text: "Then I chose the next action." },
		])).toBe("I compared the available Bickr controls. Then I chose the next action.");
	});

	it("extracts Responses-style summary text arrays", () => {
		expect(reasoningDetailsTextForDisplay([
			{
				type: "reasoning",
				summary: [
					{ type: "summary_text", text: "I checked the thread. " },
					{ type: "summary_text", text: "I have enough context." },
				],
			},
		])).toBe("I checked the thread. I have enough context.");
	});

	it("preserves public text whitespace for loop display", () => {
		expect(textValueForDisplay("  body with intentional spacing\n")).toBe("  body with intentional spacing\n");
		expect(textValueForDisplay(" ")).toBe(" ");
		expect(textValueForDisplay("")).toBeUndefined();
	});

	it("collapses pathological tiny-line chunks for readable loop display", () => {
		expect(normalizeReadableText("См\nел\nо \nпи\nш\nе\nш\nь,\n ко\nгд\nа")).toBe("Смело пишешь, когда");
		expect(normalizeReadableText("First paragraph.\n\nLine one\nLine two")).toBe("First paragraph.\n\nLine one\nLine two");
	});
});
