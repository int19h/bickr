import { afterEach, describe, expect, it } from "vitest";
import { runCli, startStubApi, type StubApi } from "./test-harness.ts";

let stub: StubApi | null = null;

afterEach(async () => {
	const running = stub;
	stub = null;
	await running?.close();
});

async function startStub(): Promise<StubApi> {
	const api = await startStubApi((request) => {
		if (request.pathname === "/api/me/bots/bot_1/notes/list") {
			return { body: { ok: true, data: { ids: ["met u/alice"], nextCursor: null, total: 1, unknownFilters: [] } } };
		}
		if (request.pathname === "/api/me/bots/bot_1/notes/read") {
			return { body: { ok: true, data: { note: { id: request.body.id, content: "hello" } } } };
		}
		if (request.pathname === "/api/me/bots/bot_1/notes/write") {
			return { body: { ok: true, data: { outcome: "created", note: { id: request.body.id, content: request.body.content } } } };
		}
		if (request.pathname === "/api/me/bots/bot_1/notes/delete") {
			return { body: { ok: true, data: { outcome: "not_found", id: request.body.id } } };
		}
		return undefined;
	});
	stub = api;
	return api;
}

describe("bickr bots notes", () => {
	it("sends filters and a title cursor in a POST body", async () => {
		const api = await startStub();
		const result = await runCli(api.port, ["--json", "bots", "notes", "list", "bot_1", "--entity", "u/alice", "--entity", "f/news", "--cursor", "met u/alice", "--limit", "10"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ ids: ["met u/alice"], total: 1 });
		expect(api.requests[0]).toMatchObject({ method: "POST", pathname: "/api/me/bots/bot_1/notes/list", body: { entities: ["u/alice", "f/news"], cursor: "met u/alice", limit: 10 } });
		expect(api.requests[0]?.searchParams.size).toBe(0);
	}, 30_000);

	it("reads and writes titles in bodies, and requires --yes to delete", async () => {
		const api = await startStub();
		expect((await runCli(api.port, ["bots", "notes", "read", "bot_1", "met u/alice"])).code).toBe(0);
		expect((await runCli(api.port, ["bots", "notes", "write", "bot_1", "met u/alice", "--content", "in f/news"])).code).toBe(0);
		expect((await runCli(api.port, ["bots", "notes", "delete", "bot_1", "met u/alice"])).code).toBe(1);
		expect((await runCli(api.port, ["bots", "notes", "delete", "bot_1", "met u/alice", "--yes"])).code).toBe(0);
		expect(api.requests.map((request) => request.pathname)).toEqual([
			"/api/me/bots/bot_1/notes/read", "/api/me/bots/bot_1/notes/write", "/api/me/bots/bot_1/notes/delete",
		]);
		expect(api.requests[1]?.body).toEqual({ id: "met u/alice", content: "in f/news" });
		expect((await runCli(api.port, ["bots", "notes", "write", "bot_1", "--content", "yes", "--", "--special"])).code).toBe(0);
		expect(api.requests.at(-1)?.body).toEqual({ id: "--special", content: "yes" });
	}, 30_000);
});
