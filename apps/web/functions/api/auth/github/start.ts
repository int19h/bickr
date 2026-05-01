import { type AppEnv } from "../../_auth";
import { githubAuthorizationServer, githubRedirectUri } from "./_github";
import { oauthStartResponse } from "../_oauth";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	return oauthStartResponse(request, {
		authorizationEndpoint: githubAuthorizationServer.authorization_endpoint!,
		clientId: env.GITHUB_CLIENT_ID,
		provider: "github",
		redirectUri: githubRedirectUri(env, request),
		scope: "read:user user:email",
	});
};
