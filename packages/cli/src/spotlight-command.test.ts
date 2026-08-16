import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SpotlightDeliveryResult } from "@bickr/shared/model";

/**
 * The spotlight command as a program: what it writes where, and what it exits
 * with. Those are the parts a script depends on and the parts no in-process
 * test of the batching loop can see — `--json` promising one document on stdout
 * is only true if the progress really went to stderr.
 */

const entry = join(import.meta.dirname, "index.ts");

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

type Stub = {
	server: Server;
	port: number;
	sends: SendCall[];
	resolves: { targets: string[]; all: boolean }[];
};

let stub: Stub | null = null;

afterEach(async () => {
	const running = stub;
	stub = null;
	if (running) {
		await new Promise<void>((resolve) => running.server.close(() => resolve()));
	}
});

function startStub(input: {
	bots: StubBot[];
	refType?: "thread" | "comment" | "bot";
	refPath?: (ref: string) => string;
	deliver?: (call: SendCall) => SpotlightDeliveryResult[] | { status: number; body: unknown };
}): Promise<Stub> {
	const sends: SendCall[] = [];
	const resolves: { targets: string[]; all: boolean }[] = [];
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
			const json = (status: number, payload: unknown) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(payload));
			};
			if (url.pathname === "/api/cli/refs") {
				const ref = url.searchParams.get("ref") ?? "";
				json(200, {
					ok: true,
					data: {
						ref: {
							id: "thr_1",
							path: input.refPath ? input.refPath(ref) : "/w/main/f/lounge/t/thr_1",
							type: input.refType ?? "thread",
						},
					},
				});
				return;
			}
			if (url.pathname === "/api/cli/resolve/bots") {
				resolves.push({ targets: body.targets as string[], all: body.all === true });
				json(200, {
					ok: true,
					data: {
						bots: input.bots.map((bot) => ({
							id: bot.id,
							handle: bot.handle,
							homeWorldHandle: "main",
							tickSettings: { enabled: bot.enabled },
						})),
					},
				});
				return;
			}
			if (url.pathname === "/api/worlds/main/forums/lounge/spotlight/send") {
				const call = body as unknown as SendCall;
				sends.push(call);
				const answer = input.deliver ?
					input.deliver(call)
				:	call.botIds.map((botId): SpotlightDeliveryResult => ({ status: "tick_started", botId, injectionId: `inj_${botId}` }));
				if (Array.isArray(answer)) {
					json(200, { ok: true, data: { spotlightId: call.spotlightId, deliveries: answer } });
					return;
				}
				json(answer.status, answer.body);
				return;
			}
			json(404, { ok: false, error: "not_found", message: `No stub for ${url.pathname}` });
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			stub = { server, port, sends, resolves };
			resolve(stub);
		});
	});
}

function runCli(port: number, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", entry, ...args], {
			env: {
				...process.env,
				BICKR_HOST: `http://127.0.0.1:${port}`,
				BICKR_TOKEN: "test-token",
				// Never read or write the developer's own CLI configuration.
				BICKR_CONFIG: join(import.meta.dirname, "no-such-cli-config.json"),
			},
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
	});
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

	it("requires participants to be named", async () => {
		const running = await startStub({ bots: [] });
		const result = await runCli(running.port, ["spotlight", "send", "t/abc"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--to");
		expect(running.resolves).toEqual([]);
	}, 30_000);
});
