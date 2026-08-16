import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpotlightDeliveryResult } from "@bickr/shared/model";
import { BickrClient } from "./client.ts";
import type { ResolvedRef } from "./ref.ts";
import {
	SpotlightTargetError,
	sendSpotlightInBatches,
	spotlightBatches,
	spotlightTargetFromRefs,
	type SpotlightTarget,
} from "./spotlight.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

function threadRef(ref: string, path: string): { ref: string; resolved: ResolvedRef } {
	return { ref, resolved: { id: "thr_1", path, type: "thread" } };
}

function commentRef(ref: string, path: string, id: string): { ref: string; resolved: ResolvedRef } {
	return { ref, resolved: { id, path, type: "comment" } };
}

function started(botId: string): SpotlightDeliveryResult {
	return { status: "tick_started", botId, injectionId: `inj_${botId}` };
}

function notInjected(botId: string): SpotlightDeliveryResult {
	return { status: "not_injected", botId, cause: "inject_error", message: "The runtime refused it." };
}

type SendCall = {
	botIds: string[];
	spotlightId: string;
	targetType: string;
	threadIds?: string[];
	threadId?: string;
	commentIds?: string[];
	focusText?: string;
	autoStartTick: boolean;
};

function stubSend(reply: (call: SendCall, index: number) => SpotlightDeliveryResult[] | "error"): SendCall[] {
	const calls: SendCall[] = [];
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		const call = JSON.parse(String(init.body)) as SendCall;
		calls.push(call);
		const answer = reply(call, calls.length - 1);
		if (answer === "error") {
			return Response.json({ ok: false, error: "conflict", message: "Continuation targets differ." }, { status: 409 });
		}
		return Response.json({ ok: true, data: { spotlightId: call.spotlightId, deliveries: answer } });
	}) as unknown as typeof fetch;
	return calls;
}

const forumTarget: SpotlightTarget = {
	worldHandle: "main",
	forumHandle: "lounge",
	targetType: "threads",
	threadIds: ["thr_1"],
	commentIds: [],
};

function run(botIds: string[], overrides: Partial<Parameters<typeof sendSpotlightInBatches>[0]> = {}) {
	return sendSpotlightInBatches({
		autoStartTick: true,
		batchSize: 2,
		botIds,
		client: new BickrClient({ host: "https://example.test", token: "tok" }),
		focusText: "",
		spotlightId: "spt_00000000-0000-4000-8000-000000000000",
		target: forumTarget,
		timeoutMs: 5_000,
		...overrides,
	});
}

describe("spotlight batching", () => {
	it("splits a selection into batches no larger than the server cap", () => {
		expect(spotlightBatches(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
		expect(spotlightBatches(Array.from({ length: 9 }, (_, index) => `bot_${index}`), 50)).toHaveLength(2);
		expect(spotlightBatches(["a", "b"], 0)).toEqual([["a"], ["b"]]);
		expect(spotlightBatches([], 4)).toEqual([]);
	});

	it("sends consecutive batches under one run id and collects every delivery", async () => {
		const calls = stubSend((call) => call.botIds.map(started));
		const result = await run(["bot_1", "bot_2", "bot_3"]);
		expect(calls.map((call) => call.botIds)).toEqual([["bot_1", "bot_2"], ["bot_3"]]);
		expect(new Set(calls.map((call) => call.spotlightId)).size).toBe(1);
		expect(calls[0]?.spotlightId).toBe("spt_00000000-0000-4000-8000-000000000000");
		expect(result.deliveries).toHaveLength(3);
		expect(result.failure).toBeNull();
	});

	it("reports progress per batch as it arrives", async () => {
		stubSend((call) => call.botIds.map(started));
		const progress: number[] = [];
		await run(["bot_1", "bot_2", "bot_3"], {
			onBatch: (update) => progress.push(update.batch, update.batchCount, update.deliveries.length),
		});
		expect(progress).toEqual([1, 2, 2, 2, 2, 1]);
	});

	it("keeps per-participant failures without stopping the run", async () => {
		stubSend((call, index) => index === 0 ? [started("bot_1"), notInjected("bot_2")] : call.botIds.map(started));
		const result = await run(["bot_1", "bot_2", "bot_3"]);
		expect(result.deliveries.map((delivery) => delivery.status)).toEqual(["tick_started", "not_injected", "tick_started"]);
		expect(result.failure).toBeNull();
	});

	it("stops at a refused batch and reports its typed cause and participants", async () => {
		const calls = stubSend((call, index) => index === 0 ? call.botIds.map(started) : "error");
		const result = await run(["bot_1", "bot_2", "bot_3", "bot_4"]);
		expect(calls).toHaveLength(2);
		expect(result.deliveries).toHaveLength(2);
		expect(result.failure).toMatchObject({ code: "conflict", botIds: ["bot_3", "bot_4"] });
	});

	it("reports a batch that ran out of time as a timeout rather than a network failure", async () => {
		globalThis.fetch = ((_url: string, init: RequestInit) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
			})) as unknown as typeof fetch;
		const result = await run(["bot_1"], { timeoutMs: 10 });
		expect(result.failure?.code).toBe("timeout");
		expect(result.deliveries).toEqual([]);
	});

	it("sends comment targets as one thread with its comment ids", async () => {
		const calls = stubSend((call) => call.botIds.map(started));
		await run(["bot_1"], {
			target: {
				worldHandle: "main",
				forumHandle: "lounge",
				targetType: "comments",
				threadIds: [],
				threadId: "thr_1",
				commentIds: ["cmt_1", "cmt_2"],
			},
			focusText: "  the second reply  ",
		});
		expect(calls[0]).toMatchObject({
			targetType: "comments",
			threadId: "thr_1",
			commentIds: ["cmt_1", "cmt_2"],
			focusText: "the second reply",
		});
		expect(calls[0]).not.toHaveProperty("threadIds");
	});
});

describe("spotlight target references", () => {
	it("takes one forum's threads as a threads spotlight", () => {
		const target = spotlightTargetFromRefs([
			threadRef("t/abc", "/w/main/f/lounge/t/thr_1"),
			threadRef("t/def", "/w/main/f/lounge/t/thr_2"),
		]);
		expect(target).toEqual({
			worldHandle: "main",
			forumHandle: "lounge",
			targetType: "threads",
			threadIds: ["thr_1", "thr_2"],
			commentIds: [],
		});
	});

	it("takes comments of one thread as a comments spotlight", () => {
		const target = spotlightTargetFromRefs([
			commentRef("c/aa", "/w/main/f/lounge/t/thr_1/c/cmt_1", "cmt_1"),
			commentRef("c/bb", "/w/main/f/lounge/t/thr_1/c/cmt_2", "cmt_2"),
		]);
		expect(target).toMatchObject({ targetType: "comments", threadId: "thr_1", commentIds: ["cmt_1", "cmt_2"] });
	});

	it("rejects comments from different threads", () => {
		expect(() => spotlightTargetFromRefs([
			commentRef("c/aa", "/w/main/f/lounge/t/thr_1/c/cmt_1", "cmt_1"),
			commentRef("c/bb", "/w/main/f/lounge/t/thr_2/c/cmt_2", "cmt_2"),
		])).toThrow(expect.objectContaining({ problem: "mixed_threads" }));
	});

	it("rejects threads from different forums", () => {
		expect(() => spotlightTargetFromRefs([
			threadRef("t/abc", "/w/main/f/lounge/t/thr_1"),
			threadRef("t/def", "/w/main/f/atrium/t/thr_2"),
		])).toThrow(expect.objectContaining({ problem: "mixed_forums" }));
	});

	it("rejects a mix of threads and comments", () => {
		expect(() => spotlightTargetFromRefs([
			threadRef("t/abc", "/w/main/f/lounge/t/thr_1"),
			commentRef("c/bb", "/w/main/f/lounge/t/thr_1/c/cmt_2", "cmt_2"),
		])).toThrow(expect.objectContaining({ problem: "mixed_types" }));
	});

	it("rejects references that are not content", () => {
		expect(() => spotlightTargetFromRefs([{ ref: "u/alice", resolved: { id: "bot_1", path: "/w/main/u/alice", type: "bot" } }]))
			.toThrow(expect.objectContaining({ problem: "unsupported_ref" }));
		expect(() => spotlightTargetFromRefs([])).toThrow(SpotlightTargetError);
	});
});
