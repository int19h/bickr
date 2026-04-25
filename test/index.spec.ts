import { describe, expect, it } from "vitest";
import { onRequestGet as bootstrap } from "../functions/api/bootstrap";
import { onRequestGet as health } from "../functions/api/health";

function contextFor<F extends PagesFunction<Env>>(
	request: Request,
): Parameters<F>[0] {
	return {
		data: {},
		env: {
			ASSETS: {
				fetch,
			},
		},
		functionPath: new URL(request.url).pathname,
		next: () => new Response("Not Found", { status: 404 }),
		params: {},
		passThroughOnException: () => {},
		request,
		waitUntil: () => {},
	} as Parameters<F>[0];
}

describe("Bickr Pages Functions", () => {
	it("returns an API health payload", async () => {
		const request = new Request("http://example.com/api/health");
		const ctx = contextFor<typeof health>(request);
		const response = await health(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			app: "Bickr",
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
});
