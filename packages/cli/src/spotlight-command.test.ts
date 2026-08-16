import { afterEach, describe, expect, it } from "vitest";
import type { SpotlightDeliveryResult } from "@bickr/shared/model";
import { runCli, startStubApi, type StubApi } from "./test-harness.ts";

/**
 * The spotlight command as a program: what it writes where, and what it exits
 * with. Those are the parts a script depends on and the parts no in-process
 * test of the batching loop can see — `--json` promising one document on stdout
 * is only true if the progress really went to stderr.
 */

type SendCall = {
	botIds: string[];
	spotlightId: string;
	targetType: string;
	threadIds?: string[];
	threadId?: string;
	commentIds?: string[];
	autoStartTick: boolean;
	focusText?: string;
};

type StubBot = { id: string; handle: string; enabled: boolean };

type Stub = StubApi & {
	sends: SendCall[];
	resolves: { targets: string[]; all: boolean }[];
};

let stub: StubApi | null = null;

afterEach(async () => {
	const running = stub;
	stub = null;
	await running?.close();
});

async function startStub(input: {
	bots: StubBot[];
	refType?: "thread" | "comment" | "bot";
	refPath?: (ref: string) => string;
	deliver?: (call: SendCall) => SpotlightDeliveryResult[] | { status: number; body: unknown };
}): Promise<Stub> {
	const sends: SendCall[] = [];
	const resolves: { targets: string[]; all: boolean }[] = [];
	const api = await startStubApi((request) => {
		if (request.pathname === "/api/cli/refs") {
			const ref = request.searchParams.get("ref") ?? "";
			return {
				body: {
					ok: true,
					data: {
						ref: {
							id: "thr_1",
							path: input.refPath ? input.refPath(ref) : "/w/main/f/lounge/t/thr_1",
							type: input.refType ?? "thread",
						},
					},
				},
			};
		}
		if (request.pathname === "/api/cli/resolve/bots") {
			resolves.push({ targets: request.body.targets as string[], all: request.body.all === true });
			return {
				body: {
					ok: true,
					data: {
						bots: input.bots.map((bot) => ({
							id: bot.id,
							handle: bot.handle,
							homeWorldHandle: "main",
							tickSettings: { enabled: bot.enabled },
						})),
					},
				},
			};
		}
		if (request.pathname === "/api/worlds/main/forums/lounge/spotlight/send") {
			const call = request.body as unknown as SendCall;
			sends.push(call);
			const answer = input.deliver ?
				input.deliver(call)
			:	call.botIds.map((botId): SpotlightDeliveryResult => ({ status: "tick_started", botId, injectionId: `inj_${botId}` }));
			return Array.isArray(answer) ?
				{ body: { ok: true, data: { spotlightId: call.spotlightId, deliveries: answer } } }
			:	{ status: answer.status, body: answer.body };
		}
		return undefined;
	});
	stub = api;
	return { ...api, sends, resolves };
}

describe("bickr spotlight send", () => {
	it("writes one JSON document to stdout and every progress line to stderr", async () => {
		const running = await startStub({
			bots: [
				{ id: "bot_1", handle: "alpha", enabled: true },
				{ id: "bot_2", handle: "beta", enabled: true },
				{ id: "bot_3", handle: "gamma", enabled: true },
			],
		});
		const result = await runCli(running.port, [
			"spotlight",
			"send",
			"w/main/f/lounge/t/thr_1",
			"--all",
			"--batch-size",
			"2",
			"--json",
		]);

		expect(result.code).toBe(0);
		const document = JSON.parse(result.stdout) as { spotlightId: string; deliveries: SpotlightDeliveryResult[] };
		expect(document.deliveries.map((delivery) => delivery.botId)).toEqual(["bot_1", "bot_2", "bot_3"]);
		expect(document.spotlightId).toMatch(/^spt_[0-9a-f-]{36}$/);
		expect(running.sends.map((call) => call.botIds)).toEqual([["bot_1", "bot_2"], ["bot_3"]]);
		expect(new Set(running.sends.map((call) => call.spotlightId))).toEqual(new Set([document.spotlightId]));
		expect(running.resolves).toEqual([{ targets: ["w/main"], all: false }]);
		expect(result.stderr).toContain("Batch 1/2");
		expect(result.stderr).toContain("Batch 2/2");
	}, 30_000);

	it("skips paused participants with a notice and still exits clean", async () => {
		const running = await startStub({
			bots: [
				{ id: "bot_1", handle: "alpha", enabled: true },
				{ id: "bot_2", handle: "resting", enabled: false },
			],
		});
		const result = await runCli(running.port, ["spotlight", "send", "t/abc", "--to", "w/main/g/crew", "--json"]);

		expect(result.code).toBe(0);
		expect(running.sends[0]?.botIds).toEqual(["bot_1"]);
		expect(running.resolves).toEqual([{ targets: ["w/main/g/crew"], all: false }]);
		expect(result.stderr).toContain("Skipping w/main/u/resting");
		const document = JSON.parse(result.stdout) as { skipped: { ref: string; reason: string }[] };
		expect(document.skipped).toEqual([{ botId: "bot_2", ref: "w/main/u/resting", reason: "paused" }]);
	}, 30_000);

	it("exits 1 when a participant is still owed the spotlight, without losing the document", async () => {
		const running = await startStub({
			bots: [
				{ id: "bot_1", handle: "alpha", enabled: true },
				{ id: "bot_2", handle: "beta", enabled: true },
			],
			deliver: (call) => call.botIds.map((botId) =>
				botId === "bot_2" ?
					{ status: "not_injected", botId, cause: "inject_error", message: "The runtime refused it." }
				:	{ status: "tick_started", botId, injectionId: "inj_1" }),
		});
		const result = await runCli(running.port, ["spotlight", "send", "t/abc", "--all", "--json"]);

		expect(result.code).toBe(1);
		const document = JSON.parse(result.stdout) as { deliveries: SpotlightDeliveryResult[] };
		expect(document.deliveries).toHaveLength(2);
		expect(result.stderr).toContain("The runtime refused it.");
	}, 30_000);

	it("still writes the document when every matched participant is paused", async () => {
		const running = await startStub({
			bots: [
				{ id: "bot_1", handle: "resting", enabled: false },
				{ id: "bot_2", handle: "dozing", enabled: false },
			],
		});
		const result = await runCli(running.port, ["spotlight", "send", "t/abc", "--all", "--json"]);

		expect(result.code).toBe(1);
		expect(running.sends).toEqual([]);
		const document = JSON.parse(result.stdout) as {
			spotlightId: string;
			deliveries: unknown[];
			skipped: { ref: string }[];
			failure: { code: string };
		};
		expect(document.spotlightId).toMatch(/^spt_[0-9a-f-]{36}$/);
		expect(document.deliveries).toEqual([]);
		expect(document.skipped.map((participant) => participant.ref)).toEqual(["w/main/u/resting", "w/main/u/dozing"]);
		expect(document.failure.code).toBe("all_participants_paused");
	}, 30_000);

	it("reports an all-paused selection to a human on stdout, with the participants it skipped", async () => {
		const running = await startStub({ bots: [{ id: "bot_1", handle: "resting", enabled: false }] });
		const result = await runCli(running.port, ["spotlight", "send", "t/abc", "--all", "--format", "human"]);

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("nothing sent");
		expect(result.stdout).toContain("Every participant matched by the spotlight targets is paused.");
		expect(result.stdout).toContain("w/main/u/resting");
	}, 30_000);

	it("still writes the document when the targets match no participant at all", async () => {
		const running = await startStub({ bots: [] });
		const jsonResult = await runCli(running.port, ["spotlight", "send", "t/abc", "--to", "w/main/g/empty", "--json"]);

		expect(jsonResult.code).toBe(1);
		expect(running.sends).toEqual([]);
		const document = JSON.parse(jsonResult.stdout) as { deliveries: unknown[]; skipped: unknown[]; failure: { code: string } };
		expect(document).toMatchObject({ deliveries: [], skipped: [] });
		expect(document.failure.code).toBe("no_participants_matched");

		const humanResult = await runCli(running.port, ["spotlight", "send", "t/abc", "--to", "w/main/g/empty", "--format", "human"]);
		expect(humanResult.code).toBe(1);
		expect(humanResult.stdout).toContain("No participants matched the spotlight targets.");
	}, 30_000);

	it("stops on a refused batch and names the run id to retry it with", async () => {
		const running = await startStub({
			bots: [
				{ id: "bot_1", handle: "alpha", enabled: true },
				{ id: "bot_2", handle: "beta", enabled: true },
			],
			deliver: () => ({ status: 409, body: { ok: false, error: "conflict", message: "Continuation targets differ." } }),
		});
		const result = await runCli(running.port, ["spotlight", "send", "t/abc", "--all", "--batch-size", "1", "--json"]);

		expect(result.code).toBe(1);
		expect(running.sends).toHaveLength(1);
		const document = JSON.parse(result.stdout) as { failure: { code: string; botIds: string[] } };
		expect(document.failure).toMatchObject({ code: "conflict", botIds: ["bot_1"] });
		expect(result.stderr).toContain("--spotlight-id spt_");
	}, 30_000);

	it("continues an earlier run under the id it is given", async () => {
		const running = await startStub({ bots: [{ id: "bot_1", handle: "alpha", enabled: true }] });
		const spotlightId = "spt_11111111-2222-4333-8444-555555555555";
		const result = await runCli(running.port, [
			"spotlight",
			"send",
			"t/abc",
			"--all",
			"--spotlight-id",
			spotlightId,
			"--no-tick",
			"--focus",
			"the ending",
			"--json",
		]);

		expect(result.code).toBe(0);
		expect(running.sends[0]).toMatchObject({ spotlightId, autoStartTick: false, focusText: "the ending" });
	}, 30_000);

	it("refuses a spotlight id that no run could have minted", async () => {
		const running = await startStub({ bots: [{ id: "bot_1", handle: "alpha", enabled: true }] });
		const result = await runCli(running.port, ["spotlight", "send", "t/abc", "--all", "--spotlight-id", "spt_mine"]);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--spotlight-id");
		expect(running.sends).toEqual([]);
	}, 30_000);

	it("refuses comment references from different threads before sending anything", async () => {
		const running = await startStub({
			bots: [{ id: "bot_1", handle: "alpha", enabled: true }],
			refType: "comment",
			refPath: (ref) => `/w/main/f/lounge/t/thr_${ref.slice(-1)}/c/cmt_${ref.slice(-1)}`,
		});
		const result = await runCli(running.port, ["spotlight", "send", "c/aa1", "c/bb2", "--all", "--json"]);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("one thread");
		expect(running.sends).toEqual([]);
	}, 30_000);

	it("refuses a batch size or timeout outside the range it documents", async () => {
		const running = await startStub({ bots: [{ id: "bot_1", handle: "alpha", enabled: true }] });

		const tooLarge = await runCli(running.port, ["spotlight", "send", "t/abc", "--all", "--batch-size", "9"]);
		expect(tooLarge.code).toBe(1);
		expect(tooLarge.stderr).toContain("--batch-size must be an integer between 1 and 8.");

		const tooShort = await runCli(running.port, ["spotlight", "send", "t/abc", "--all", "--timeout", "4"]);
		expect(tooShort.code).toBe(1);
		expect(tooShort.stderr).toContain("--timeout must be an integer between 5 and 300.");

		const fractional = await runCli(running.port, ["spotlight", "send", "t/abc", "--all", "--batch-size", "2.5"]);
		expect(fractional.code).toBe(1);
		expect(running.sends).toEqual([]);
	}, 30_000);

	it("fails a malformed command as usage even when its selection would have been empty", async () => {
		// The empty-selection document is an outcome of a valid run. A command that
		// never was valid must not borrow it: stdout stays empty and the range
		// explanation goes to stderr, whatever the selection would have held.
		const running = await startStub({ bots: [{ id: "bot_1", handle: "resting", enabled: false }] });
		const result = await runCli(running.port, ["spotlight", "send", "t/abc", "--all", "--batch-size", "9", "--json"]);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--batch-size must be an integer between 1 and 8.");
		expect(running.resolves).toEqual([]);
		expect(running.sends).toEqual([]);
	}, 30_000);

	it("requires participants to be named", async () => {
		const running = await startStub({ bots: [] });
		const result = await runCli(running.port, ["spotlight", "send", "t/abc"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--to");
		expect(running.resolves).toEqual([]);
	}, 30_000);
});
