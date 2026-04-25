import * as oauth from "oauth4webapi";
import { fail } from "@bickr/shared/api";
import {
	cookieHeader,
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
	const redirectUri = githubRedirectUri(env, request);
	const url = new URL(githubAuthorizationServer.authorization_endpoint!);
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", "read:user user:email");
	url.searchParams.set("state", state);

	return new Response(null, {
		status: 302,
		headers: {
			location: url.toString(),
			"set-cookie": cookieHeader(request, oauthStateCookieName, state, { maxAge: 600 }),
			"cache-control": "no-store",
		},
	});
};
