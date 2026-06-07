import { type AppEnv } from "../../_auth";
import { googleAuthorizationServer, googleRedirectUri } from "./_google";
import { oauthStartResponse } from "../_oauth";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	if (!env.GOOGLE_CLIENT_ID) {
		return oauthStartResponse(env, request, {
			authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
			clientId: env.GOOGLE_CLIENT_ID,
			provider: "google",
			redirectUri: googleRedirectUri(env, request),
			scope: "openid email profile",
			nonce: true,
		});
	}

	const authorizationServer = await googleAuthorizationServer(env);
	return oauthStartResponse(env, request, {
		authorizationEndpoint: authorizationServer.authorization_endpoint!,
		clientId: env.GOOGLE_CLIENT_ID,
		provider: "google",
		redirectUri: googleRedirectUri(env, request),
		scope: "openid email profile",
		nonce: true,
	});
};
