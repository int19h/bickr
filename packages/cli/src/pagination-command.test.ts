import { afterEach, expect, it } from "vitest";
import { runCli, startStubApi, type StubApi } from "./test-harness.ts";
let stub: StubApi | undefined;
afterEach(async () => { await stub?.close(); stub = undefined; });
it("follows thread continuation metadata even for short pages", async () => {
	stub = await startStubApi((request) => {
		if (request.pathname === "/api/cli/refs") return {body: {ok: true, data: {ref: {type: "forum", path: "/w/test/f/pages"}}}};
		if (request.pathname.endsWith("/threads")) {
			const offset = Number(request.searchParams.get("offset"));
			return {body: {ok: true, data: {threads: [{id: `t${offset}`}], pagination: {offset, hasMore: offset === 0}}}};
		}
		return undefined;
	});
	const result = await runCli(stub.port, ["--json", "threads", "list", "f/pages", "--all"]);
	expect(result.code, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({threads: [{id: "t0"}, {id: "t1"}]});
	expect(stub.requests.filter((r) => r.pathname.endsWith("/threads")).map((r) => r.searchParams.get("offset"))).toEqual(["0", "1"]);
}, 30_000);
it("rejects oversized notification ranges before sending a request", async () => {
	stub = await startStubApi(() => undefined);
	const result = await runCli(stub.port, ["notifications", "list", "--range", "1-101"]);
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("at most 100");
	expect(stub.requests).toEqual([]);
}, 30_000);
