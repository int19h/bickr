import { onRequest as pageHandler } from "../apps/web/functions/[[path]]";
import { onRequest as pagesMiddleware } from "../apps/web/functions/_middleware";
import { testEnvironmentCookieName } from "../apps/web/functions/_test-entry";
import type { AppEnv } from "../apps/web/functions/api/_auth";
import {
	contextFor,
	describe,
	expect,
	it,
	testSpaShell,
	vi,
} from "./helpers/index-harness";

const activeTestEntryEnv = {
	BICKR_ENVIRONMENT: "test",
	BICKR_PRODUCTION_ORIGIN: "https://bickr.social",
	TEST_ENTRY_MODE: "migration",
} as const satisfies Partial<AppEnv>;

describe("test environment entry gateway", () => {
	it("is dormant unless the migration mode is explicitly configured", async () => {
		const next = vi.fn(async () => new Response("next"));
		const response = await invokeMiddleware(
			new Request("https://test.bickr.social/w/example"),
			{ BICKR_ENVIRONMENT: "test", BICKR_PRODUCTION_ORIGIN: "https://bickr.social" },
			next,
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("next");
		expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		expect(next).toHaveBeenCalledOnce();
	});

	it("shows a no-store migration notice and preserves the destination path and query", async () => {
		const next = vi.fn(async () => new Response("next"));
		const response = await invokeMiddleware(
			new Request("https://test.bickr.social/w/example?sort=new&tag=a%20b"),
			activeTestEntryEnv,
			next,
		);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("vary")?.toLowerCase()).toBe("cookie");
		expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
		expect(html).toContain("Bickr has moved");
		expect(html).toContain("sign in there once");
		expect(html).toContain("https://bickr.social/w/example?sort=new&amp;tag=a+b");
		expect(html).toContain("test=1");
		expect(next).not.toHaveBeenCalled();
	});

	it("sets a host-only opt-in cookie and redirects to the clean test URL", async () => {
		const next = vi.fn(async () => new Response("next"));
		const response = await invokeMiddleware(
			new Request("https://test.bickr.social/w/example?sort=new&test=1"),
			activeTestEntryEnv,
			next,
		);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("https://test.bickr.social/w/example?sort=new");
		const setCookie = response.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain(`${testEnvironmentCookieName}=1`);
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Lax");
		expect(setCookie).toContain("Secure");
		expect(setCookie).not.toContain("Domain=");
		expect(next).not.toHaveBeenCalled();
	});

	it("allows opted-in requests and clears the cookie on request", async () => {
		const cookie = `${testEnvironmentCookieName}=1`;
		const next = vi.fn(async () => Response.json({ ok: true }));
		const allowed = await invokeMiddleware(
			new Request("https://test.bickr.social/api/worlds", { headers: { cookie } }),
			activeTestEntryEnv,
			next,
		);
		expect(allowed.status).toBe(200);
		expect(next).toHaveBeenCalledOnce();

		const cleared = await invokeMiddleware(
			new Request("https://test.bickr.social/w/example?sort=new&test=0", { headers: { cookie } }),
			activeTestEntryEnv,
			vi.fn(async () => new Response("next")),
		);
		expect(cleared.status).toBe(303);
		expect(cleared.headers.get("location")).toBe("https://test.bickr.social/w/example?sort=new");
		expect(cleared.headers.get("set-cookie")).toContain(`${testEnvironmentCookieName}=`);
		expect(cleared.headers.get("set-cookie")).toContain("Max-Age=0");
	});

	it("fails closed for APIs, MCP, mutations, and API query-string opt-ins", async () => {
		for (const request of [
			new Request("https://test.bickr.social/api/worlds"),
			new Request("https://test.bickr.social/api/worlds?test=1"),
			new Request("https://test.bickr.social/mcp", { method: "POST" }),
			new Request("https://test.bickr.social/w/example", { method: "POST" }),
		]) {
			const next = vi.fn(async () => new Response("next"));
			const response = await invokeMiddleware(request, activeTestEntryEnv, next);
			expect(response.status).toBe(403);
			expect(response.headers.get("location")).toBeNull();
			expect(response.headers.get("set-cookie")).toBeNull();
			const payload = await response.json();
			expect(payload).toMatchObject({
				error: "test_environment_opt_in_required",
				ok: false,
				optInUrl: "https://test.bickr.social/?test=1",
				productionUrl: expect.stringContaining("https://bickr.social"),
			});
			expect(next).not.toHaveBeenCalled();
		}
	});

	it("keeps double-slash paths on the configured production host", async () => {
		const response = await invokeMiddleware(
			new Request("https://test.bickr.social//example.net/path?test=unexpected", {
				headers: { accept: "text/html" },
			}),
			activeTestEntryEnv,
			vi.fn(async () => new Response("next")),
		);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain("https://bickr.social//example.net/path");
		expect(html).not.toContain("https://example.net");
	});

	it("treats a malformed opt-in cookie as absent", async () => {
		const next = vi.fn(async () => new Response("next"));
		const response = await invokeMiddleware(
			new Request("https://test.bickr.social/", {
				headers: { cookie: `${testEnvironmentCookieName}=%zz` },
			}),
			activeTestEntryEnv,
			next,
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Bickr has moved");
		expect(next).not.toHaveBeenCalled();
	});

	it("keeps operational endpoints available without an opt-in cookie", async () => {
		for (const [pathname, method] of [
			["/api/health", "GET"],
			["/api/maintenance", "GET"],
			["/api/runtime/health", "GET"],
			["/api/__test__/service-proxy", "POST"],
		] as const) {
			const next = vi.fn(async () => new Response("next"));
			const response = await invokeMiddleware(
				new Request(`https://test.bickr.social${pathname}`, { method }),
				activeTestEntryEnv,
				next,
			);
			expect(response.status).toBe(200);
			expect(next).toHaveBeenCalledOnce();
		}
	});

	it("fails closed when the enabled gateway has an invalid production origin", async () => {
		const next = vi.fn(async () => new Response("next"));
		const response = await invokeMiddleware(
			new Request("https://test.bickr.social/"),
			{ ...activeTestEntryEnv, BICKR_PRODUCTION_ORIGIN: "http://bickr.social/path" },
			next,
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: "test_entry_configuration_error", ok: false });
		expect(next).not.toHaveBeenCalled();
	});

	it("renders the persistent banner and page-level noindex metadata for opted-in HTML", async () => {
		const request = new Request("https://test.bickr.social/?sort=new&test=1");
		const response = await pageHandler({
			...contextFor<typeof pageHandler>(request, {}, activeTestEntryEnv),
			next: async () => new Response(testSpaShell, {
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
		} as Parameters<typeof pageHandler>[0]);
		const html = await response.text();

		expect(html).toContain('class="bickr-test-environment"');
		expect(html).toContain("TEST ENVIRONMENT");
		expect(html).toContain("Changes here do not affect bickr.social.");
		expect(html).toContain("sort=new&amp;test=0");
		expect(html).toContain('name="robots" content="noindex,nofollow"');
		expect(response.headers.get("cache-control")).toBe("no-store");
	});
});

async function invokeMiddleware(
	request: Request,
	env: Partial<AppEnv>,
	next: () => Promise<Response>,
): Promise<Response> {
	return pagesMiddleware({
		...contextFor<typeof pagesMiddleware>(request, {}, env),
		next,
	} as Parameters<typeof pagesMiddleware>[0]);
}
