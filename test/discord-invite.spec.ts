import { onRequestGet, onRequestPost } from "../apps/web/functions/api/me/discord-invite";
import { authCookie, authCookieFor, contextFor, describe, expect, it, testEnv } from "./helpers/index-harness";

function request(method: string, cookie?: string) {
	return new Request("https://bickr.social/api/me/discord-invite", { method, headers: cookie ? { cookie } : {} });
}
async function state(cookie: string) {
	const response = await onRequestGet(contextFor<typeof onRequestGet>(request("GET", cookie)));
	return response.json() as Promise<{ ok: boolean; data: { dismissed: boolean } }>;
}

describe("per-account Discord invitation", () => {
	it("persists an idempotent dismissal across independent login sessions without affecting another user", async () => {
		const first = await authCookie();
		expect((await state(first)).data.dismissed).toBe(false);
		const dismiss = () => onRequestPost(contextFor<typeof onRequestPost>(request("POST", first)));
		expect((await dismiss()).status).toBe(200);
		expect((await dismiss()).status).toBe(200);
		const second = await authCookie();
		expect(second).not.toBe(first);
		expect((await state(second)).data.dismissed).toBe(true);
		const other = await authCookieFor({ subject: "discord-other", login: "other", displayName: "Other" });
		expect((await state(other)).data.dismissed).toBe(false);
		const rows = await testEnv.BICKR_D1.prepare("SELECT user_id FROM discord_invite_dismissals").all();
		expect(rows.results).toHaveLength(1);
	});
	it("rejects unauthenticated reads and writes", async () => {
		expect((await onRequestGet(contextFor<typeof onRequestGet>(request("GET")))).status).toBe(401);
		expect((await onRequestPost(contextFor<typeof onRequestPost>(request("POST")))).status).toBe(401);
	});
});
