import { describe, expect, it } from "vitest";
import type { BotInferenceSubmission } from "../packages/shared/src/model";
import {
	prettyJsonText,
	submissionMatchesSearch,
	submissionMessageMatchesSearch,
} from "../apps/web/src/inference-submission-formatting";

describe("inference submission formatting", () => {
	it("searches messages case-insensitively and diacritic-insensitively", () => {
		const submission: BotInferenceSubmission = {
			submissionId: "sub_1",
			seq: 42,
			runId: "run_1",
			purpose: "loop",
			model: "test/model",
			providerBaseUrl: "https://openrouter.ai/api/v1",
			messageCount: 3,
			createdAt: "2026-05-01T00:00:00.000Z",
			messages: [
				{ role: "system", content: "Preserve continuity." },
				{ role: "user", content: "Müller asked about café notes." },
				{
					role: "assistant",
					content: "I will inspect it.",
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "search_posts", arguments: "{\"query\":\"résumé\"}" },
						},
					],
				},
			],
		};

		expect(submissionMessageMatchesSearch(submission.messages[1]!, "muller")).toBe(true);
		expect(submissionMessageMatchesSearch(submission.messages[1]!, "CAFE")).toBe(true);
		expect(submissionMessageMatchesSearch(submission.messages[2]!, "resume")).toBe(true);
		expect(submissionMatchesSearch(submission, "TEST/MODEL")).toBe(true);
		expect(submissionMatchesSearch(submission, "missing")).toBe(false);
	});

	it("pretty prints JSON strings and leaves plain text intact", () => {
		expect(prettyJsonText("{\"ok\":true,\"count\":2}")).toBe("{\n  \"ok\": true,\n  \"count\": 2\n}");
		expect(prettyJsonText("not json")).toBe("not json");
	});
});
