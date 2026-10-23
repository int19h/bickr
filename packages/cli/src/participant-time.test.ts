import { afterEach, expect, it } from "vitest";
import { runCli, startStubApi, type StubApi } from "./test-harness.ts";
import { timeSettingsFromFlags } from "./participant-time.ts";
let stub: StubApi | undefined;
afterEach(async () => { await stub?.close(); });
it("validates modes and timezones before requests", () => {
	for (const [key, value] of [["time-mode", "wrong"], ["time-timezone", "Mars/Olympus"], ["time-timezone", "+01:00"]]) {
		expect(() => timeSettingsFromFlags(new Map([[key!, value!]]))).toThrow();
	}
	expect(timeSettingsFromFlags(new Map())).toBeUndefined();
	expect(timeSettingsFromFlags(new Map([["time-mode", "relative"]]))).toEqual({ mode: "relative" });
});
it("sends time settings and shows them in human and JSON output", async () => {
	const timeSettings = { mode: "absolute", timezone: "Asia/Kolkata" };
	const bot = { id: "bot_time", homeWorldHandle: "example", handle: "time", inferenceSettings: {}, timeSettings };
	stub = await startStubApi(request => {
		if (request.method === "PATCH" || request.pathname === "/api/me/bots/bot_time") return { body: { ok: true, data: { bot } } };
		if (request.pathname === "/api/me/bots") return { body: { ok: true, data: { bots: [bot] } } };
		return undefined;
	});
	const result = await runCli(stub.port, ["bots", "update", "bot_time", "--time-mode", "absolute", "--time-timezone", "Asia/Kolkata"]);
	expect(result.code, result.stderr).toBe(0);
	expect(stub.requests.at(-1)?.body).toEqual({ timeSettings });
	const human = await runCli(stub.port, ["--format", "human", "bots", "get", "bot_time"]);
	expect(human.stdout).toContain("Time mode");
	expect(human.stdout).toContain("Asia/Kolkata");
	const json = await runCli(stub.port, ["--json", "bots", "get", "bot_time"]);
	expect(JSON.parse(json.stdout)).toMatchObject({ bot: { timeSettings } });
}, 30_000);
