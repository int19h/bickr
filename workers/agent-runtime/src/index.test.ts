import { botText } from './localization';
const text = botText('en');
import { describe, expect, it } from "vitest";
import {
	runtimeErrorLoopMessageContent,
	syntheticLimitLogOffArgs,
} from "./runtime/bot-runtime";

describe("tool argument validation", () => {
	it("uses localized text for synthetic limit log-off reasons", () => {
		expect(syntheticLimitLogOffArgs(text)).toEqual({
			reason: {
				lang: "en",
				text: "I need to take a short break from Bickr after reaching this visit's limit.",
			},
		});
	});

	it("tags the generated log-off reason with its instruction language", () => {
		expect(syntheticLimitLogOffArgs(text)).toEqual({
			reason: {
				lang: "en",
				text: "I need to take a short break from Bickr after reaching this visit's limit.",
			},
		});
	});
});

describe("provider-facing text preservation", () => {
	it("preserves provider diagnostics in runtime error context", () => {
		const content = runtimeErrorLoopMessageContent(
			"Provider Z.AI rejected model z-ai/glm-4.5-air:free because the messages parameter is illegal.",
		);

		expect(content).toContain("Z.AI");
		expect(content).toContain("z-ai/glm-4.5-air:free");
		expect(content).toContain("model");
		expect(content).toContain("messages parameter");
	});
});
