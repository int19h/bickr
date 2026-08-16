import { afterEach, describe, expect, it } from "vitest";
import { runCli, startStubApi, type StubApi, type StubRequest } from "./test-harness.ts";

/**
 * What the multi-participant commands actually send. The grammar is expanded on
 * the server, so the CLI's whole part in it is putting the owner's words into
 * the request unchanged — including `--all`, which means something different
 * from the references beside it.
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
			const ref = request.searchParams.get("ref") ?? "";
			return { body: { ok: true, data: { ref: { id: "wld_1", path: `/${ref}`, type: "world" } } } };
		}
		if (request.pathname === "/api/cli/bulk/bots") {
			return { body: { ok: true, data: { bulk: { operation: "bots.update", dryRun: true, targetCount: 0, bots: [] } } } };
		}
		if (request.pathname === "/api/cli/resolve/bots") {
			return { body: { ok: true, data: { bots: [{ id: "bot_1", handle: "alpha", homeWorldHandle: "main" }] } } };
		}
		if (request.pathname.endsWith("/groups/grp_1/bots")) {
			return { body: { ok: true, data: { group: { id: "grp_1" } } } };
		}
		return undefined;
	});
	stub = api;
	return api;
}

function bodyOf(requests: StubRequest[], pathname: string): Record<string, unknown> {
	const request = requests.find((candidate) => candidate.pathname === pathname);
	expect(request, `no request to ${pathname}`).toBeDefined();
	return request?.body ?? {};
}

describe("bickr bots bulk update", () => {
	it("asks for the whole fleet with --all, and for the listed worlds as its narrowing", async () => {
		const running = await startStub();
		expect((await runCli(running.port, ["bots", "bulk", "update", "--all", "--model", "openai/gpt-5"])).code).toBe(0);
		expect(bodyOf(running.requests, "/api/cli/bulk/bots")).toMatchObject({ all: true, targets: [] });

		const narrowed = await startStub();
		expect((await runCli(narrowed.port, ["bots", "bulk", "update", "--all", "w/main", "--model", "openai/gpt-5"])).code).toBe(0);
		expect(bodyOf(narrowed.requests, "/api/cli/bulk/bots")).toMatchObject({ all: true, targets: ["w/main"] });
	}, 30_000);

	it("leaves the existing target forms alone", async () => {
		const running = await startStub();
		const result = await runCli(running.port, [
			"bots",
			"bulk",
			"update",
			"w/main/g/critics",
			"u/alpha",
			"--model",
			"openai/gpt-5",
			"--yes",
		]);
		expect(result.code).toBe(0);
		expect(bodyOf(running.requests, "/api/cli/bulk/bots")).toMatchObject({
			all: false,
			targets: ["w/main/g/critics", "u/alpha"],
			apply: true,
		});
	}, 30_000);
});

describe("bickr groups add-bots", () => {
	it("expands its bot positions through the shared grammar", async () => {
		const running = await startStub();
		const result = await runCli(running.port, ["groups", "add-bots", "w/main", "grp_1", "w/main/g/critics"]);

		expect(result.code).toBe(0);
		expect(bodyOf(running.requests, "/api/cli/resolve/bots")).toMatchObject({ targets: ["w/main/g/critics"], all: false });
		expect(bodyOf(running.requests, "/api/worlds/main/groups/grp_1/bots")).toEqual({ botIds: ["bot_1"] });
	}, 30_000);

	it("refuses to add nothing", async () => {
		const running = await startStub();
		const result = await runCli(running.port, ["groups", "add-bots", "w/main", "grp_1"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("bot-target");
		expect(running.requests.map((request) => request.pathname)).toEqual(["/api/cli/refs"]);
	}, 30_000);
});
