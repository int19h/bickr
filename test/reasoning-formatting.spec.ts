import { describe, expect, it } from "vitest";
import { reasoningDetailsTextForDisplay, textValueForDisplay } from "../apps/web/src/reasoning-formatting";

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

	it("preserves public text whitespace for loop display", () => {
		expect(textValueForDisplay("  body with intentional spacing\n")).toBe("  body with intentional spacing\n");
		expect(textValueForDisplay(" ")).toBe(" ");
		expect(textValueForDisplay("")).toBeUndefined();
	});
});
