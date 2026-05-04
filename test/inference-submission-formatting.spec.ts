import { describe, expect, it } from "vitest";
import type { BotInferenceSubmission, BotRuntimeEvent, BotRuntimeEventType } from "../packages/shared/src/model";
import {
	inferenceSubmissionChatMessages,
	inferenceSubmissionSeqsByRuntimeEventSeq,
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

	it("uses display messages for compaction chat display and search when present", () => {
		const submission: BotInferenceSubmission = {
			submissionId: "sub_compaction",
			seq: 88,
			runId: "run_1",
			purpose: "compaction",
			model: "test/model",
			providerBaseUrl: "https://openrouter.ai/api/v1",
			messageCount: 2,
			createdAt: "2026-05-01T00:00:00.000Z",
			messages: [
				{ role: "system", content: "Preserve continuity." },
				{ role: "user", content: "Recent activity only." },
			],
			displayMessages: [
				{ role: "system", content: "Preserve continuity." },
				{ role: "user", content: "Recent activity only." },
				{ role: "assistant", content: "I need to follow up with Müller about release notes." },
			],
		};

		expect(inferenceSubmissionChatMessages(submission)).toHaveLength(3);
		expect(submissionMatchesSearch(submission, "muller")).toBe(true);
		expect(inferenceSubmissionChatMessages({ ...submission, displayMessages: [] })).toHaveLength(2);
	});

	it("associates response events with the request that produced them", () => {
		const events = [
			runtimeEvent(10, "run_1", "provider_request"),
			runtimeEvent(10.5, "run_1", "provider_delta"),
			runtimeEvent(11, "run_1", "reasoning_message"),
			runtimeEvent(12, "run_1", "assistant_message"),
			runtimeEvent(13, "run_1", "tool_call"),
			runtimeEvent(14, "run_1", "tool_result"),
			runtimeEvent(15, "run_1", "provider_request"),
			runtimeEvent(16, "run_1", "assistant_message"),
			runtimeEvent(20, "run_2", "provider_request"),
			runtimeEvent(21, "run_2", "assistant_message"),
		];

		const seqs = inferenceSubmissionSeqsByRuntimeEventSeq(events, new Set([10, 15, 20]));

		expect(seqs.get(10)).toBe(10);
		expect(seqs.get(10.5)).toBe(10);
		expect(seqs.get(11)).toBe(10);
		expect(seqs.get(12)).toBe(10);
		expect(seqs.get(13)).toBe(10);
		expect(seqs.get(14)).toBe(15);
		expect(seqs.get(15)).toBe(15);
		expect(seqs.get(16)).toBe(15);
		expect(seqs.get(21)).toBe(20);
	});

	it("does not associate tool results without a later retained request", () => {
		const seqs = inferenceSubmissionSeqsByRuntimeEventSeq(
			[
				runtimeEvent(10, "run_1", "provider_request"),
				runtimeEvent(11, "run_1", "tool_result"),
			],
			new Set([10]),
		);

		expect(seqs.get(11)).toBeUndefined();
	});
});

function runtimeEvent(seq: number, runId: string, type: BotRuntimeEventType): BotRuntimeEvent {
	return {
		seq,
		runId,
		type,
		payload: {},
		tokenEstimate: 0,
		createdAt: "2026-05-01T00:00:00.000Z",
	};
}
