import { describe, expect, it } from "vitest";
import type { BotLoopMessage, BotRuntimeEvent } from "../packages/shared/src/model";
import {
	isLiveProviderLoopMessage,
	removeLiveProviderLoopMessagesForFinalizedMessage,
	removeLiveProviderLoopMessagesForFinalizedMessages,
	removeLiveProviderLoopMessagesForRun,
	upsertLiveProviderLoopMessage,
} from "../apps/web/src/loop-message-streams";
import { loopMessageSort } from "../apps/web/src/loop-message-order";

describe("loop message live provider streams", () => {
	it("accumulates content and reasoning deltas without trimming whitespace", () => {
		const messages = [
			event(20.000001, "provider_delta", { kind: "reasoning", streamSeq: 20, text: "Looking " }),
			event(20.000002, "provider_delta", { kind: "reasoning", streamSeq: 20, text: "at the thread. " }),
			event(20.000003, "provider_delta", { kind: "content", streamSeq: 20, text: " Replying " }),
			event(20.000004, "provider_delta", { kind: "content", streamSeq: 20, text: "now." }),
		].reduce(upsertLiveProviderLoopMessage, [] as BotLoopMessage[]);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.message).toMatchObject({
			role: "assistant",
			content: " Replying now.",
			reasoning: "Looking at the thread. ",
		});
		expect(messages[0] && isLiveProviderLoopMessage(messages[0])).toBe(true);
		expect(messages[0]?.streamSeq).toBe(20);
	});

	it("keeps current live rows when an older provider response from the same run arrives", () => {
		const streamed = upsertLiveProviderLoopMessage(
			[],
			event(30.000001, "provider_delta", { kind: "reasoning", streamSeq: 30, text: "Current thought." }),
		);
		expect(removeLiveProviderLoopMessagesForFinalizedMessage(streamed, finalizedProviderMessage(12))).toEqual(streamed);
	});

	it("removes only the live row for the matching finalized provider response", () => {
		const streamed = [
			event(30.000001, "provider_delta", { kind: "reasoning", streamSeq: 30, text: "Current thought." }),
			event(40.000001, "provider_delta", { kind: "reasoning", streamSeq: 40, text: "Next thought." }),
		].reduce(upsertLiveProviderLoopMessage, [] as BotLoopMessage[]);

		const retained = removeLiveProviderLoopMessagesForFinalizedMessage(streamed, finalizedProviderMessage(30));
		expect(retained).toHaveLength(1);
		expect(retained[0]?.streamSeq).toBe(40);
	});

	it("removes matching live rows when reconciling multiple finalized messages", () => {
		const streamed = [
			event(30.000001, "provider_delta", { kind: "content", streamSeq: 30, text: "First" }),
			event(40.000001, "provider_delta", { kind: "content", streamSeq: 40, text: "Second" }),
			event(50.000001, "provider_delta", { kind: "content", streamSeq: 50, text: "Third" }),
		].reduce(upsertLiveProviderLoopMessage, [] as BotLoopMessage[]);

		const retained = removeLiveProviderLoopMessagesForFinalizedMessages(streamed, [
			finalizedProviderMessage(30),
			finalizedProviderMessage(50),
		]);
		expect(retained.map((message) => message.streamSeq)).toEqual([40]);
	});

	it("removes transient stream rows for a run when the run terminates", () => {
		const streamed = upsertLiveProviderLoopMessage([], event(20.000001, "provider_delta", { kind: "content", streamSeq: 20, text: "Draft" }));
		expect(removeLiveProviderLoopMessagesForRun(streamed, "run-live")).toEqual([]);
	});

	it("orders persisted loop rows by context position before sequence", () => {
		const messages = [
			finalizedProviderMessage(30, 12),
			{ ...finalizedProviderMessage(100, 5), origin: "compaction" as const },
			upsertLiveProviderLoopMessage([], event(40.000001, "provider_delta", { kind: "content", streamSeq: 40, text: "Live" }))[0]!,
		].sort(loopMessageSort);

		expect(messages.map((message) => message.seq)).toEqual([101, 31, 1_000_000_040]);
	});

	it("keeps live stream rows after positioned persisted rows", () => {
		const positioned = [finalizedProviderMessage(12, 12)];
		const messages = upsertLiveProviderLoopMessage(positioned, event(20.000001, "provider_delta", { kind: "content", streamSeq: 20, text: "Draft" }));

		expect(messages.map((message) => message.seq)).toEqual([13, 1_000_000_020]);
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

function finalizedProviderMessage(streamSeq: number, position = streamSeq + 1): BotLoopMessage {
	return {
		seq: streamSeq + 1,
		position,
		runId: "run-live",
		role: "assistant",
		message: { role: "assistant", content: "Final." },
		origin: "provider_response",
		tokenEstimate: 1,
		streamSeq,
		createdAt: "2026-05-05T00:00:01.000Z",
	};
}
