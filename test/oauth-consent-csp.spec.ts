import { describe, expect, it } from "vitest";
import { onRequest as middleware, contentSecurityPolicy } from "../apps/web/functions/_middleware";
import { onRequestGet, onRequestPost } from "../apps/web/functions/oauth/authorize";
import { onRequestGet as cliConsent, onRequestPost as cliApprove } from "../apps/web/functions/api/cli/auth/approve";
import { exchangeMcpAuthorizationCode, mcpRedirectOrigin, registerMcpClient } from "../packages/shared/src/mcp-auth";
import { createCliAuthRequest, approveCliAuthRequest, pollCliAuthRequest } from "../packages/shared/src/auth-sessions";
import { authCookie, contextFor, testEnv, type AppEnv } from "./helpers/index-harness";
import { currentBrowserUser } from "../apps/web/functions/api/_browser-auth";

const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const challenge = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
async function form(callback = "https://client.example/callback") {
	const client = await registerMcpClient(testEnv.BICKR_D1, { redirectUris: [callback] });
	return new URLSearchParams({ response_type: "code", client_id: client.id, redirect_uri: callback,
		resource: "https://bickr.social/mcp", code_challenge: challenge, code_challenge_method: "S256", scope: "bickr.read" });
}
function request(params: URLSearchParams, cookie?: string, headers: Record<string,string> = {}) {
	return new Request("https://bickr.social/oauth/authorize", { method: "POST", body: params,
		headers: { origin: "https://bickr.social", "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}), ...headers } });
}
async function run(route: PagesFunction<AppEnv>, request: Request) {
	const context = contextFor(request) as Parameters<typeof middleware>[0];
	return middleware({ ...context, next: () => route(context) } as Parameters<typeof middleware>[0]);
}
function decodeAttribute(value: string): string { return value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"); }

describe("browser consent and callback navigation", () => {
	it.each(["https://client.example/callback", "http://localhost:49152/callback", "http://127.0.0.1:49152/callback", "http://[::1]:49152/callback"])("accepts the exact callback %s", async (callback) => {
		expect(mcpRedirectOrigin(callback)).toBe(new URL(callback).origin);
		const params = await form(callback);
		const response = await run(onRequestPost, request(params, await authCookie()));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy);
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		const html = await response.text();
		expect(html).toContain('<script src="/assets/oauth-callback.js" defer></script>');
		expect(html).toContain('id="bickr-oauth-callback"');
		expect(response.headers.get("location")).toBeNull();
	});
	it.each(["javascript:alert(1)", "https://client.example/cb#fragment", "http://client.example/cb", "https://user:password@client.example/cb"])("rejects unsupported callback %s", async (callback) => {
		expect(mcpRedirectOrigin(callback)).toBeNull();
		await expect(form(callback)).rejects.toMatchObject({ code: "invalid_client_metadata" });
	});
	it("keeps ordinary CSP on GET and never issues a code from GET", async () => {
		const params = await form();
		const response = await run(onRequestGet, new Request(`https://bickr.social/oauth/authorize?${params}`, { headers: { cookie: await authCookie() } }));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy);
		// Native form POSTs under no-referrer send Origin: null. The form must
		// preserve its origin while the completed callback document hides it.
		expect(response.headers.get("referrer-policy")).toBe("same-origin");
		expect(await testEnv.BICKR_D1.prepare("SELECT 1 FROM auth_records WHERE kind = 'mcp_code'").first()).toBeNull();
	});
	it("preserves the CLI form origin and hides the completed document referrer", async () => {
		const cookie = await authCookie();
		const device = await createCliAuthRequest(testEnv.BICKR_D1);
		const url = `https://bickr.social/api/cli/auth/approve?code=${encodeURIComponent(device.deviceCode)}`;
		const formResponse = await run(cliConsent, new Request(url, { headers: { cookie } }));
		expect(formResponse.status).toBe(200);
		expect(formResponse.headers.get("referrer-policy")).toBe("same-origin");
		expect(formResponse.headers.get("content-security-policy")).toBe(contentSecurityPolicy);
		expect(await formResponse.text()).toContain("Approve CLI Login");
		const approved = await run(cliApprove, new Request(url, {
			method: "POST", body: new URLSearchParams({ code: device.deviceCode }),
			headers: { cookie, origin: "https://bickr.social", "sec-fetch-site": "same-origin" },
		}));
		expect(approved.status).toBe(200);
		expect(approved.headers.get("referrer-policy")).toBe("no-referrer");
		expect((await pollCliAuthRequest(testEnv.BICKR_D1, device.deviceCode)).status).toBe("complete");
	});
	it("preserves query/state and redeems the issued code with PKCE", async () => {
		const params = await form("https://client.example/callback?existing=kept");
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
		params.set("code_challenge", btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""));
		params.set("state", '<script> & " opaque');
		const response = await run(onRequestPost, request(params, await authCookie()));
		const html = await response.text();
		const callback = new URL(decodeAttribute(/id="bickr-oauth-callback" href="([^"]+)"/.exec(html)![1]!));
		expect(callback.searchParams.get("existing")).toBe("kept");
		expect(callback.searchParams.get("state")).toBe(params.get("state"));
		expect(html).not.toContain('<script> & " opaque');
		const input = { code: callback.searchParams.get("code")!, clientId: params.get("client_id")!, redirectUri: params.get("redirect_uri")!, codeVerifier: verifier, resource: params.get("resource")! };
		expect((await exchangeMcpAuthorizationCode(testEnv.BICKR_D1, input)).accessToken).toMatch(/^bckr_mcp_at_/);
	});
	it.each([
		{ origin: "https://evil.example", "sec-fetch-site": "cross-site" },
		{ origin: "https://sibling.bickr.social", "sec-fetch-site": "same-site" },
		{ origin: "null", "sec-fetch-site": "same-origin" },
		{ origin: "https://bickr.social", "sec-fetch-site": "cross-site" },
	])("rejects cross-origin or conflicting browser provenance", async (headers) => {
		const cookie = await authCookie();
		const response = await run(onRequestPost, request(await form(), cookie, headers));
		expect(response.status).toBe(403);
		expect(await testEnv.BICKR_D1.prepare("SELECT 1 FROM auth_records WHERE kind = 'mcp_code'").first()).toBeNull();
		const device = await createCliAuthRequest(testEnv.BICKR_D1);
		const cliResponse = await run(cliApprove, new Request("https://bickr.social/api/cli/auth/approve", {
			method: "POST", body: new URLSearchParams({ code: device.deviceCode }), headers: { cookie, ...headers },
		}));
		expect(cliResponse.status).toBe(403);
		expect((await pollCliAuthRequest(testEnv.BICKR_D1, device.deviceCode)).status).toBe("pending");
	});
	it("requires origin evidence and cookie authentication", async () => {
		const req = request(await form(), await authCookie()); req.headers.delete("origin"); req.headers.delete("sec-fetch-site");
		expect((await run(onRequestPost, req)).status).toBe(403);
		expect((await run(onRequestPost, request(await form()))).status).toBe(401);
	});
	it("rejects bearer-only CLI authentication for both consent forms", async () => {
		const cookie = await authCookie();
		const user = await currentBrowserUser(testEnv, new Request("https://bickr.social", { headers: { cookie } }));
		const device = await createCliAuthRequest(testEnv.BICKR_D1);
		await approveCliAuthRequest(testEnv.BICKR_D1, device.deviceCode, user!.id);
		const result = await pollCliAuthRequest(testEnv.BICKR_D1, device.deviceCode);
		if (result.status !== "complete") throw new Error("CLI login failed.");
		const headers = { authorization: `Bearer ${result.token}` };
		expect((await run(onRequestPost, request(await form(), undefined, headers))).status).toBe(401);
		const next = await createCliAuthRequest(testEnv.BICKR_D1);
		const cliRequest = request(new URLSearchParams({ code: next.deviceCode }), undefined, headers);
		expect((await cliApprove(contextFor(cliRequest))).status).toBe(401);
	});
	it("returns typed malformed/oversized request errors and rejects an unregistered callback", async () => {
		const cookie = await authCookie();
		const malformed = new Request("https://bickr.social/oauth/authorize", { method: "POST", body: "{", headers: { cookie, origin: "https://bickr.social", "content-type": "application/json" } });
		expect((await run(onRequestPost, malformed)).status).toBe(400);
		const params = await form(); params.set("state", "x".repeat(17000));
		expect((await run(onRequestPost, request(params, cookie))).status).toBe(413);
		const bad = await form(); bad.set("redirect_uri", "https://other.example/callback");
		expect((await run(onRequestPost, request(bad, cookie))).status).toBe(400);
	});
});
