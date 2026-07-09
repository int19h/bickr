import { describe, expect, it } from "vitest";
import {
	contentSecurityPolicy,
	onRequest,
	strictTransportSecurity,
} from "../apps/web/functions/_middleware";

type TestPagesContext = Parameters<typeof onRequest>[0];

describe("Pages security headers middleware", () => {
	it("adds HSTS and CSP to HTML responses and removes wildcard CORS", async () => {
		const response = await onRequest(pagesContext(
			new Response("<!doctype html>", {
				headers: {
					"access-control-allow-origin": "*",
					"content-type": "text/html; charset=utf-8",
				},
			}),
		));

		expect(response.headers.get("strict-transport-security")).toBe(strictTransportSecurity);
		expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy);
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(await response.text()).toBe("<!doctype html>");
	});

	it("adds HSTS only to JSON responses", async () => {
		const response = await onRequest(pagesContext(Response.json({ ok: true })));

		expect(response.headers.get("strict-transport-security")).toBe(strictTransportSecurity);
		expect(response.headers.get("content-security-policy")).toBeNull();
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(await response.json()).toEqual({ ok: true });
	});

	it("preserves MCP CORS headers on non-HTML responses", async () => {
		const response = await onRequest(pagesContext(
			Response.json({ jsonrpc: "2.0", result: {} }, {
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "GET,POST,OPTIONS",
					"access-control-allow-headers": "authorization,content-type,mcp-protocol-version",
					"access-control-expose-headers": "WWW-Authenticate",
				},
			}),
			"https://bickr.social/mcp",
		));

		expect(response.headers.get("strict-transport-security")).toBe(strictTransportSecurity);
		expect(response.headers.get("content-security-policy")).toBeNull();
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(response.headers.get("access-control-allow-methods")).toBe("GET,POST,OPTIONS");
		expect(response.headers.get("access-control-allow-headers")).toBe("authorization,content-type,mcp-protocol-version");
		expect(response.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate");
	});
});

function pagesContext(nextResponse: Response, requestUrl = "https://bickr.social/"): TestPagesContext {
	const request = new Request(requestUrl);
	return {
		env: {},
		request,
		params: {},
		data: {},
		waitUntil: () => undefined,
		passThroughOnException: () => undefined,
		next: () => Promise.resolve(nextResponse),
		functionPath: new URL(request.url).pathname,
	} as unknown as TestPagesContext;
}
