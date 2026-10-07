import { completeProviderSession } from "../../apps/web/functions/api/auth/_oauth";
import { onRequestPost as testLogin } from "../../apps/web/functions/api/__test__/login";
import type { AccountCredentialPage } from "../../packages/shared/src/auth-credentials";
import { createCliAuthRequest, approveCliAuthRequest, pollCliAuthRequest, createSession } from "../../packages/shared/src/auth-sessions";
import { describe, expect, it } from "vitest";
import { onRequestGet, onRequestDelete, onRequestPatch } from "../../apps/web/functions/api/me/auth/credentials";
import { onRequestPost as logout } from "../../apps/web/functions/api/auth/logout";
import { authCookie, authCookieFor, contextFor, testEnv, userIdForHandle } from "../helpers/index-harness";

function revoke(body: string, cookie: string, origin = "https://bickr.social") {
	return new Request("https://bickr.social/api/me/auth/credentials", { method: "DELETE", body,
		headers: { cookie, origin, "content-type": "application/json" } });
}

describe("credential inventory routes", () => {
	it("clears the browser cookie after account-wide revocation", async () => {
		const cookie = await authCookie();
		const response = await onRequestDelete(contextFor(revoke('{"kind":"all"}', cookie)));
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
	});
	it("lists and revokes the current browser session", async () => {
		const cookie = await authCookie();
		const request = new Request("https://bickr.social/api/me/auth/credentials", { headers: { cookie } });
		const listed = await onRequestGet(contextFor(request));
		expect(listed.status).toBe(200);
		const payload = await listed.json<{ data: { credentials: Array<{ id: string; isCurrent: boolean }>; legacyMigrationComplete: boolean } }>();
		expect(payload.data.credentials).toHaveLength(1);
		expect(payload.data.credentials[0]!.isCurrent).toBe(true);
		expect(payload.data.legacyMigrationComplete).toBe(false);
		const response = await onRequestDelete(contextFor(revoke(JSON.stringify({ kind: "credential", id: payload.data.credentials[0]!.id }), cookie)));
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
		expect(await response.json()).toMatchObject({ data: { sessionRevoked: true } });
		expect((await onRequestGet(contextFor(request))).status).toBe(401);
	});
	it("rejects cross-origin revocation and malformed or oversized bodies", async () => {
		const cookie = await authCookie();
		expect((await onRequestDelete(contextFor(revoke('{"kind":"all"}', cookie, "https://other.example")))).status).toBe(403);
		expect((await onRequestDelete(contextFor(revoke("{", cookie)))).status).toBe(400);
		expect((await onRequestDelete(contextFor(revoke("x".repeat(1025), cookie)))).status).toBe(413);
	});
	it("does not persist public logout requests with forged cookies", async () => {
		for (const token of ["random", "bckr_session_v2_unknown"]) {
			const response = await logout(contextFor(new Request("https://bickr.social/api/auth/logout", {
				method: "POST", headers: { cookie: `bickr_session=${token}` },
			})));
			expect(response.status).toBe(200);
		}
		expect(await testEnv.BICKR_D1.prepare("SELECT 1 FROM auth_records").first()).toBeNull();
	});

});


describe("access identity and naming routes", () => {
	it("marks no current session for bearer-only or invalid-cookie plus bearer requests", async () => {
		await authCookie();
		const userId = await userIdForHandle("octocat");
		const request = await createCliAuthRequest(testEnv.BICKR_D1);
		await approveCliAuthRequest(testEnv.BICKR_D1, request.deviceCode, userId);
		const poll = await pollCliAuthRequest(testEnv.BICKR_D1, request.deviceCode);
		if (poll.status !== "complete") throw new Error("CLI approval failed");
		for (const cookie of ["", "bickr_session=forged"]) {
			const response = await onRequestGet(contextFor(new Request("https://bickr.social/api/me/auth/credentials", {
				headers: { cookie, authorization: `Bearer ${poll.token}` },
			})));
			expect(response.status).toBe(200);
			const payload = await response.json<{ data: AccountCredentialPage }>();
			expect(payload.data.credentials.filter((entry) => entry.kind === "session")).toHaveLength(1);
			expect(payload.data.credentials.some((entry) => entry.kind === "session" && entry.isCurrent)).toBe(false);
			const renamed = await onRequestPatch(contextFor(new Request("https://bickr.social/api/me/auth/credentials", {
				method: "PATCH", headers: { cookie, authorization: `Bearer ${poll.token}`, origin: "https://bickr.social" },
				body: JSON.stringify({ id: payload.data.credentials[0]!.id, name: "Name" }),
			})));
			expect(renamed.status).toBe(401);
		}
	});

	it("preserves the current cookie when signing out a different browser", async () => {
		const cookie = await authCookie();
		await createSession(testEnv.BICKR_D1, await userIdForHandle("octocat"));
		const request = new Request("https://bickr.social/api/me/auth/credentials", { headers: { cookie } });
		const listed = await onRequestGet(contextFor(request));
		const payload = await listed.json<{ data: AccountCredentialPage }>();
		const other = payload.data.credentials.find((entry) => entry.kind === "session" && !entry.isCurrent)!;
		const response = await onRequestDelete(contextFor(revoke(JSON.stringify({ kind: "credential", id: other.id }), cookie)));
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(await response.json()).toMatchObject({ data: { sessionRevoked: false } });
		const next = await onRequestGet(contextFor(request));
		expect((await next.json<{ data: AccountCredentialPage }>()).data.credentials).toHaveLength(1);
	});

	it("renames owned access and rejects foreign, malformed, oversized or cross-origin writes", async () => {
		const cookie = await authCookie();
		const foreignCookie = await authCookieFor({ subject: "foreign", login: "foreign", displayName: "Foreign" });
		const listed = await onRequestGet(contextFor(new Request("https://bickr.social/api/me/auth/credentials", { headers: { cookie } })));
		const id = (await listed.json<{ data: AccountCredentialPage }>()).data.credentials[0]!.id;
		const patch = (body: string, auth = cookie, origin = "https://bickr.social") => onRequestPatch(contextFor(new Request("https://bickr.social/api/me/auth/credentials", {
			method: "PATCH", headers: { cookie: auth, origin, "content-type": "application/json" }, body,
		})));
		expect((await patch(JSON.stringify({ id, name: "Work laptop" }))).status).toBe(200);
		expect((await patch(JSON.stringify({ id, name: "Other" }), foreignCookie)).status).toBe(404);
		expect((await onRequestDelete(contextFor(revoke(JSON.stringify({ kind: "credential", id }), foreignCookie)))).status).toBe(404);
		expect((await patch(JSON.stringify({ id, name: "Other" }), cookie, "https://other.example")).status).toBe(403);
		for (const body of ["{", "[]", JSON.stringify({ id, name: 42 }), JSON.stringify({ id, name: "x".repeat(121) })]) {
			expect((await patch(body)).status).toBe(400);
		}
		expect((await patch("x".repeat(1025))).status).toBe(413);
	});
});


describe("browser details at sign-in", () => {
	it("captures provider callback details without storing the raw browser header", async () => {
		await completeProviderSession(contextFor(new Request("https://bickr.social")).env, new Request("https://bickr.social/api/auth/github/callback", {
			headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0" },
		}), { provider: "github", subject: "browser-hints", login: "browser-hints", displayName: "Browser Hints" });
		const row = await testEnv.BICKR_D1.prepare("SELECT document FROM auth_records WHERE kind = 'session' LIMIT 1").first<{ document: string }>();
		expect(JSON.parse(row!.document)).toMatchObject({ browserDetails: { browser: "Firefox", operatingSystem: "Linux" } });
		expect(row!.document).not.toContain("Mozilla");
	});
	it("captures the same descriptive metadata through the protected test login", async () => {
		const response = await testLogin(contextFor(new Request("http://localhost/api/__test__/login", {
			method: "POST", headers: { "x-test-auth-secret": "secret", "content-type": "application/json",
				"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15" },
			body: JSON.stringify({ login: "browser-hints", handle: "browser-hints" }),
		}), {}, { TEST_AUTH_SECRET: "secret" }));
		expect(response.status).toBe(201);
		const row = await testEnv.BICKR_D1.prepare("SELECT document FROM auth_records WHERE kind = 'session' LIMIT 1").first<{ document: string }>();
		expect(JSON.parse(row!.document)).toMatchObject({ browserDetails: { browser: "Safari", operatingSystem: "macOS" } });
	});
});
