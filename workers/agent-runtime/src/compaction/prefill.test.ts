import { describe, expect, it } from "vitest";
import { providerMessagesWithPrefillCompatibility } from "./engine";

const assistantPrefill = [
	{ role: "user", content: "Continue." },
	{ role: "assistant", content: "I" },
] as const;

describe("provider prefill compatibility", () => {
	it("treats unset prefill as opt-in Off on the final runtime boundary", () => {
		const messages = providerMessagesWithPrefillCompatibility(
			{ model: "provider/model" },
			[...assistantPrefill],
		);
		expect(messages.at(-2)).toEqual({ role: "assistant", content: "I" });
		expect(messages.at(-1)).toEqual({ role: "user", content: "Bickr Terminal is ready for my next step." });
	});

	it("uses only the already capability-gated applied value", () => {
		expect(providerMessagesWithPrefillCompatibility(
			{ model: "provider/model", supportsPrefill: false },
			[...assistantPrefill],
		).at(-1)).toEqual({ role: "user", content: "Bickr Terminal is ready for my next step." });
		expect(providerMessagesWithPrefillCompatibility(
			{ model: "provider/model", supportsPrefill: true },
			[...assistantPrefill],
		).at(-1)).toEqual({ role: "assistant", content: "I" });
	});
});
