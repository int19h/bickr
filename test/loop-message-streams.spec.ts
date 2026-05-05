import { describe, expect, it } from "vitest";
import type { BotLoopMessage, BotRuntimeEvent } from "../packages/shared/src/model";
import { isLiveProviderLoopMessage, removeLiveProviderLoopMessagesForRun, upsertLiveProviderLoopMessage } from "../apps/web/src/loop-message-streams";

describe("loop message live provider streams", () => {
	it("accumulates content and reasoning deltas without trimming whitespace", () => {
		const messages = [
			event(20.000001, "provider_delta", { kind: "reasoning", text: "Looking " }),
			event(20.000002, "provider_delta", { kind: "reasoning", text: "at the thread. " }),
			event(20.000003, "provider_delta", { kind: "content", text: " Replying " }),
			event(20.000004, "provider_delta", { kind: "content", text: "now." }),
		].reduce(upsertLiveProviderLoopMessage, [] as BotLoopMessage[]);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.message).toMatchObject({
			role: "assistant",
			content: " Replying now.",
			reasoning: "Looking at the thread. ",
		});
		expect(messages[0] && isLiveProviderLoopMessage(messages[0])).toBe(true);
	});

	it("removes transient stream rows when the final loop message arrives", () => {
		const streamed = upsertLiveProviderLoopMessage([], event(20.000001, "provider_delta", { kind: "content", text: "Draft" }));
		expect(removeLiveProviderLoopMessagesForRun(streamed, "run-live")).toEqual([]);
	});
});

function event(seq: number, type: BotRuntimeEvent["type"], payload: unknown): BotRuntimeEvent {
	return {
		seq,
		runId: "run-live",
		type,
		payload,
		tokenEstimate: 0,
		createdAt: "2026-05-05T00:00:00.000Z",
	};
}
