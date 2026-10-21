import { afterEach, expect, it } from "vitest";
import { runCli, startStubApi, type StubApi } from "./test-harness.ts";
let stub: StubApi | undefined;
afterEach(async () => { await stub?.close(); });
const tickSettings = { enabled: false, intervalSeconds: 31_536_000, compactionThreshold: 0.75, maxToolCallsPerTick: 4 };
const bot = { id: "bot_tick", homeWorldHandle: "example", handle: "tick", inferenceSettings: {}, tickSettings, effectiveTickSettings: { ...tickSettings, allowEarlyLogOff: true } };
it("updates tick fields, clears optional overrides, and displays stored and effective values", async () => {
	stub = await startStubApi(request => {
		if (request.pathname === "/api/me/bots" && request.method === "GET") return { body: { ok: true, data: { bots: [bot] } } };
		if (request.method === "PATCH") return { body: { ok: true, data: { bot } } };
		return undefined;
	});
	const result = await runCli(stub.port, ["bots", "update", "bot_tick", "--tick-interval-seconds", "31536000", "--tick-enabled", "false", "--tick-max-tool-calls-per-tick", "null", "--tick-compaction-threshold", "0.8", "--tick-allow-early-log-off", "true"]);
	expect(result.code, result.stderr).toBe(0);
	expect(stub.requests.at(-1)?.body).toEqual({ tickSettings: { intervalSeconds: 31_536_000, enabled: false, maxToolCallsPerTick: null, compactionThreshold: 0.8, allowEarlyLogOff: true } });
	const read = await runCli(stub.port, ["--format", "human", "bots", "get", "bot_tick"]);
	expect(read.code, read.stderr).toBe(0);
	expect(read.stdout).toContain("31536000");
	expect(read.stdout).toContain("Allow early log off (effective)");
	expect(read.stdout).toContain("true");
	const list = await runCli(stub.port, ["--format", "human", "bots", "list"]);
	expect(list.stdout).toContain("Interval (s)");
	expect(list.stdout).toContain("31536000");
	const json = await runCli(stub.port, ["--json", "bots", "get", "bot_tick"]);
	expect(JSON.parse(json.stdout)).toMatchObject({ bot: { tickSettings, effectiveTickSettings: { allowEarlyLogOff: true } } });
}, 30_000);
it("rejects invalid tick flags and mixed JSON before requests", async () => {
	stub = await startStubApi(() => undefined);
	for (const args of [
		["--tick-interval-seconds", "31536001"], ["--tick-interval-seconds", "29"],
		["--tick-interval-seconds", "60.5"], ["--tick-interval-seconds", "null"],
		["--tick-enabled", "yes"], ["--tick-enabled"], ["--tick-compaction-threshold", "NaN"],
		["--body", "{}", "--tick-enabled", "true"],
	]) {
		const result = await runCli(stub.port, ["bots", "update", "bot_tick", ...args]);
		expect(result.code, args.join(" ")).toBe(1);
	}
	expect(stub.requests).toEqual([]);
}, 30_000);
it("accepts tick settings at creation", async () => {
	stub = await startStubApi(request => {
		if (request.pathname === "/api/cli/refs") return { body: { ok: true, data: { ref: { id: "wld_example", path: "/w/example", type: "world" } } } };
		if (request.method === "POST") return { body: { ok: true, data: { bot } } };
		return undefined;
	});
	const result = await runCli(stub.port, ["bots", "create", "w/example", "--handle", "tick", "--language", "en", "--display-name", "Tick", "--short-bio", "Bio", "--prompt", "Prompt", "--tick-interval-seconds", "31536000"]);
	expect(result.code, result.stderr).toBe(0);
	expect(stub.requests.at(-1)?.body).toMatchObject({ tickSettings: { intervalSeconds: 31_536_000 } });
}, 30_000);
