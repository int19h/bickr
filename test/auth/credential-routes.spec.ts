import { describe, expect, it } from "vitest";
import { onRequestGet, onRequestDelete } from "../../apps/web/functions/api/me/auth/credentials";
import { authCookie, contextFor } from "../helpers/index-harness";

function revoke(body: string, cookie: string, origin = "https://bickr.social") {
	return new Request("https://bickr.social/api/me/auth/credentials", { method: "DELETE", body,
		headers: { cookie, origin, "content-type": "application/json" } });
}

describe("credential inventory routes", () => {
	it("lists and revokes the current browser session", async () => {
		const cookie = await authCookie();
		const request = new Request("https://bickr.social/api/me/auth/credentials", { headers: { cookie } });
		const listed = await onRequestGet(contextFor(request));
		expect(listed.status).toBe(200);
		const payload = await listed.json<{ data: { credentials: Array<{ id: string }>; legacyMigrationComplete: boolean } }>();
		expect(payload.data.credentials).toHaveLength(1);
		expect(payload.data.legacyMigrationComplete).toBe(false);
		const response = await onRequestDelete(contextFor(revoke(JSON.stringify({ kind: "credential", id: payload.data.credentials[0]!.id }), cookie)));
		expect(response.status).toBe(200);
		expect((await onRequestGet(contextFor(request))).status).toBe(401);
	});
	it("rejects cross-origin revocation and malformed or oversized bodies", async () => {
		const cookie = await authCookie();
		expect((await onRequestDelete(contextFor(revoke('{"kind":"all"}', cookie, "https://other.example")))).status).toBe(403);
		expect((await onRequestDelete(contextFor(revoke("{", cookie)))).status).toBe(400);
		expect((await onRequestDelete(contextFor(revoke("x".repeat(1025), cookie)))).status).toBe(413);
	});
});
