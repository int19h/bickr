import { afterEach, describe, expect, it } from "vitest";
import { runCli, startStubApi, type StubApi } from "./test-harness.ts";

/**
 * `bickr bots notifications`: which route each subcommand reaches and with
 * what. Listing must be a plain GET, since the server contract that it marks
 * nothing rests on the CLI never sending anything else, and read must send
 * exactly the IDs the owner named.
 */

let stub: StubApi | null = null;

afterEach(async () => {
	const running = stub;
	stub = null;
	await running?.close();
});

async function startStub(): Promise<StubApi> {
	const api = await startStubApi((request) => {
		if (request.pathname === "/api/cli/refs") {
			return { body: { ok: true, data: { ref: { id: "bot_resolved", path: "/w/main/u/alpha", type: "bot" } } } };
		}
		if (request.pathname === "/api/me/bots/bot_1/notifications") {
			return { body: { ok: true, data: { botId: "bot_1", notifications: [{ id: "ntf_new" }], unavailableCount: 0, hasMore: false } } };
		}
		if (request.pathname === "/api/me/bots/bot_resolved/notifications") {
			return { body: { ok: true, data: { botId: "bot_resolved", notifications: [], unavailableCount: 0, hasMore: false } } };
		}
		if (request.pathname === "/api/me/bots/bot_1/notifications/read") {
			const ids = request.body.notificationIds as string[];
			if (ids.includes("ntf_foreign")) {
				return { status: 400, body: { ok: false, error: "bad_request", message: "Every notification ID must belong to the named bot." } };
			}
			return { body: { ok: true, data: { botId: "bot_1", markedReadCount: ids.length, notPendingCount: 0 } } };
		}
		return undefined;
	});
	stub = api;
	return api;
}

describe("bickr bots notifications", () => {
	it("lists with a plain GET, passing --limit through and resolving bot references", async () => {
		const running = await startStub();
		const listed = await runCli(running.port, ["--json", "bots", "notifications", "list", "bot_1", "--limit", "5"]);
		expect(listed.code).toBe(0);
		expect(JSON.parse(listed.stdout)).toMatchObject({ botId: "bot_1", notifications: [{ id: "ntf_new" }] });
		const request = running.requests.find((candidate) => candidate.pathname === "/api/me/bots/bot_1/notifications");
		expect(request).toMatchObject({ method: "GET" });
		expect(request?.searchParams.get("limit")).toBe("5");

		expect((await runCli(running.port, ["bots", "notifications", "list", "w/main/u/alpha"])).code).toBe(0);
		const resolved = running.requests.find((candidate) => candidate.pathname === "/api/me/bots/bot_resolved/notifications");
		expect(resolved?.searchParams.has("limit")).toBe(false);
		expect(running.requests.every((candidate) => !candidate.pathname.endsWith("/read"))).toBe(true);
	}, 30_000);

	it("marks exactly the named IDs and surfaces a refusal as a failing exit", async () => {
		const running = await startStub();
		const marked = await runCli(running.port, ["--json", "bots", "notifications", "read", "bot_1", "ntf_a", "ntf_b"]);
		expect(marked.code).toBe(0);
		expect(JSON.parse(marked.stdout)).toMatchObject({ botId: "bot_1", markedReadCount: 2 });
		expect(running.requests.find((candidate) => candidate.pathname === "/api/me/bots/bot_1/notifications/read"))
			.toMatchObject({ method: "POST", body: { notificationIds: ["ntf_a", "ntf_b"] } });

		const refused = await runCli(running.port, ["bots", "notifications", "read", "bot_1", "ntf_foreign"]);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("Every notification ID must belong to the named bot.");
	}, 30_000);

	it("refuses a read with no IDs and an unknown subcommand before calling the API", async () => {
		const running = await startStub();
		const empty = await runCli(running.port, ["bots", "notifications", "read", "bot_1"]);
		expect(empty.code).toBe(1);
		expect(empty.stderr).toContain("bickr bots notifications read <bot> <notification-id...>");
		expect((await runCli(running.port, ["bots", "notifications", "sweep", "bot_1"])).code).toBe(1);
		expect(running.requests).toEqual([]);
	}, 30_000);
});
