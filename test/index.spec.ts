import { describe, expect, it } from "vitest";
import { onRequestGet as bootstrap } from "../apps/web/functions/api/bootstrap";
import { onRequestGet as health } from "../apps/web/functions/api/health";
import { onRequestGet as runtimeHealth } from "../apps/web/functions/api/runtime/health";

function contextFor<F extends PagesFunction<Env>>(
	request: Request,
): Parameters<F>[0] {
	return {
		data: {},
		env: {
			ASSETS: {
				fetch,
			},
			AGENT_RUNTIME: {
				fetch: async () =>
					Response.json({
						ok: true,
						runtime: "agent-runtime-worker",
					}),
			},
			FORUM_COORDINATOR_SERVICE: {
				fetch: async () =>
					Response.json({
						ok: true,
						runtime: "forum-coordinator-worker",
					}),
			},
		},
		functionPath: new URL(request.url).pathname,
		next: async () => new Response("Not Found", { status: 404 }),
		params: {},
		passThroughOnException: () => {},
		request,
		waitUntil: () => {},
	} as unknown as Parameters<F>[0];
}

describe("Bickr Pages Functions", () => {
	it("returns an API health payload", async () => {
		const request = new Request("http://example.com/api/health");
		const ctx = contextFor<typeof health>(request);
		const response = await health(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			app: "Bickr",
			bindings: {
				agentRuntime: true,
				botRuntime: false,
				forumCoordinator: false,
				forumCoordinatorService: true,
			},
			ok: true,
			runtime: "cloudflare-pages-functions",
		});
	});

	it("returns the bootstrap payload", async () => {
		const request = new Request("http://example.com/api/bootstrap");
		const ctx = contextFor<typeof bootstrap>(request);
		const response = await bootstrap(ctx);
		const payload = (await response.json()) as {
			app: { name: string };
			pillars: Array<unknown>;
			seedForums: Array<{ name: string }>;
		};

		expect(response.status).toBe(200);
		expect(payload.app.name).toBe("Bickr");
		expect(payload.pillars).toHaveLength(3);
		expect(payload.seedForums.map((forum) => forum.name)).toContain("r/shipwars");
	});

	it("returns bound Worker runtime health", async () => {
		const request = new Request("http://example.com/api/runtime/health");
		const ctx = contextFor<typeof runtimeHealth>(request);
		const response = await runtimeHealth(ctx);
		const payload = (await response.json()) as {
			services: {
				agentRuntime: { ok: boolean };
				forumCoordinator: { ok: boolean };
			};
		};

		expect(response.status).toBe(200);
		expect(payload.services.agentRuntime.ok).toBe(true);
		expect(payload.services.forumCoordinator.ok).toBe(true);
	});
});
