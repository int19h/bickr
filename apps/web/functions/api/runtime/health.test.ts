import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "./health";

function context(agent: () => Promise<Response>, forum: () => Promise<Response>) {
	return { env: {
		AGENT_RUNTIME: { fetch: vi.fn(agent) },
		FORUM_COORDINATOR_SERVICE: { fetch: vi.fn(forum) },
		INTERNAL_SERVICE_SECRET: "health-test-secret",
	} } as unknown as Parameters<typeof onRequestGet>[0];
}

const healthy = async () => Response.json({ ok: true });

describe("runtime health", () => {
	it("reports success only when both services respond successfully", async () => {
		const response = await onRequestGet(context(healthy, healthy));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true });
	});

	it.each(["agent", "forum"])("returns 503 when the %s service returns an error", async (service) => {
		const failed = async () => Response.json({ ok: false }, { status: 500 });
		const response = await onRequestGet(context(service === "agent" ? failed : healthy, service === "forum" ? failed : healthy));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ ok: false });
	});

	it("reports an unavailable binding without disclosing the thrown error", async () => {
		const response = await onRequestGet(context(async () => { throw new Error("private detail"); }, healthy));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			ok: false,
			services: { agentRuntime: { kind: "unavailable", ok: false }, forumCoordinator: { ok: true } },
		});
	});

	it("treats malformed service JSON as unavailable", async () => {
		const response = await onRequestGet(context(async () => new Response("not json"), healthy));
		expect(response.status).toBe(503);
	});
});
