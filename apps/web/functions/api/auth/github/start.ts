import * as oauth from "oauth4webapi";
import { fail } from "@bickr/shared/api";
import {
	cookieHeader,
	oauthReturnToCookieName,
	oauthStateCookieName,
	type AppEnv,
} from "../../_auth";
import { githubAuthorizationServer, githubRedirectUri } from "./_github";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	const clientId = env.GITHUB_CLIENT_ID;
	if (!clientId) {
		return fail("server_error", "GitHub OAuth is not configured.", 500);
	}

	const state = oauth.generateRandomState();
	const returnTo = sanitizeReturnTo(new URL(request.url).searchParams.get("returnTo"));
	const redirectUri = githubRedirectUri(env, request);
	const url = new URL(githubAuthorizationServer.authorization_endpoint!);
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", "read:user user:email");
	url.searchParams.set("state", state);

	const response = new Response(null, {
		status: 302,
		headers: {
			location: url.toString(),
			"cache-control": "no-store",
		},
	});
	response.headers.append("set-cookie", cookieHeader(request, oauthStateCookieName, state, { maxAge: 600 }));
	response.headers.append("set-cookie", cookieHeader(request, oauthReturnToCookieName, returnTo, { maxAge: 600 }));
	return response;
};

function sanitizeReturnTo(value: string | null): string {
	const fallback = "/";
	const raw = value?.trim();
	if (!raw || raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
		return fallback;
	}
	try {
		const parsed = new URL(raw, "https://bickr.local");
		if (parsed.origin !== "https://bickr.local" || parsed.pathname.startsWith("/api/")) {
			return fallback;
		}
		return `${parsed.pathname}${parsed.search}${parsed.hash}` || fallback;
	} catch {
		return fallback;
	}
}
