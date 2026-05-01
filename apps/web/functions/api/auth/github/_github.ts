import * as oauth from "oauth4webapi";
import { type AppEnv } from "../../_auth";

export const githubAuthorizationServer: oauth.AuthorizationServer = {
	issuer: "https://github.com",
	authorization_endpoint: "https://github.com/login/oauth/authorize",
	token_endpoint: "https://github.com/login/oauth/access_token",
};

export function githubClient(env: AppEnv): oauth.Client {
	if (!env.GITHUB_CLIENT_ID) {
		throw new Error("GitHub OAuth client ID is not configured.");
	}

	return {
		client_id: env.GITHUB_CLIENT_ID,
	};
}

export function githubClientAuth(env: AppEnv): oauth.ClientAuth {
	if (!env.GITHUB_CLIENT_SECRET) {
		throw new Error("GitHub OAuth client secret is not configured.");
	}

	return oauth.ClientSecretPost(env.GITHUB_CLIENT_SECRET);
}

export function githubRedirectUri(env: AppEnv, request: Request): string {
	if (env.GITHUB_REDIRECT_URI) {
		return env.GITHUB_REDIRECT_URI;
	}

	return new URL("/api/auth/github/callback", new URL(request.url).origin).toString();
}
