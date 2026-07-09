import {
	contextFor,
	cookieHeaderFromSetCookies,
	describe,
	expect,
	githubCallback,
	githubStart,
	it,
	oauthCookieNames,
	oauthFetchMock,
	setCookieValue,
} from "./helpers/index-harness";

describe("MCP", () => {

	it("preserves long MCP OAuth authorization return paths across Bickr sign-in", async () => {
		const githubCookies = oauthCookieNames("github");
		const longReturnTo = `/oauth/authorize?response_type=code&client_id=${"c".repeat(64)}&redirect_uri=${encodeURIComponent("https://api.claude.ai/api/mcp/auth_callback")}&scope=bickr.read%20bickr.write%20bickr.runtime&state=${"s".repeat(2_300)}&code_challenge=${"x".repeat(43)}&code_challenge_method=S256&resource=${encodeURIComponent("https://test.bickr.social/mcp")}`;
		expect(longReturnTo.length).toBeGreaterThan(2_048);
		const startUrl = new URL("http://example.com/api/auth/github/start");
		startUrl.searchParams.set("returnTo", longReturnTo);
		const startResponse = await githubStart(
			contextFor<typeof githubStart>(
				new Request(startUrl),
				{},
				{ GITHUB_CLIENT_ID: "client-id" },
			),
		);
		expect(startResponse.status).toBe(302);
		const setCookies = startResponse.headers.getSetCookie();
		expect(setCookies.join(";")).toContain(`${githubCookies.returnTo}=%2F`);
		const state = setCookieValue(setCookies, githubCookies.state);
		expect(state).toBeTruthy();
		const callbackResponse = await githubCallback(
			contextFor<typeof githubCallback>(
				new Request(`http://example.com/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
					headers: { cookie: cookieHeaderFromSetCookies(setCookies) },
				}),
				{},
				{
					GITHUB_CLIENT_ID: "client-id",
					GITHUB_CLIENT_SECRET: "client-secret",
					OAUTH_FETCH: oauthFetchMock,
				},
			),
		);
		expect(callbackResponse.status).toBe(302);
		expect(callbackResponse.headers.get("location")).toBe(longReturnTo);
	});
});
