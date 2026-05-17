import * as oauth from "oauth4webapi";
import { type AppEnv } from "../../_auth";
import { oauthFetch } from "../_oauth";

const googleIssuer = new URL("https://accounts.google.com");

export async function googleAuthorizationServer(env: AppEnv): Promise<oauth.AuthorizationServer> {
	const response = await oauth.discoveryRequest(googleIssuer, {
		[oauth.customFetch]: oauthFetch(env),
	});
	return oauth.processDiscoveryResponse(googleIssuer, response);
}

export function googleClient(env: AppEnv): oauth.Client {
	if (!env.GOOGLE_CLIENT_ID) {
		throw new Error("Google OAuth client ID is not configured.");
	}

	return {
		client_id: env.GOOGLE_CLIENT_ID,
	};
}

export function googleClientAuth(env: AppEnv): oauth.ClientAuth {
	if (!env.GOOGLE_CLIENT_SECRET) {
		throw new Error("Google OAuth client secret is not configured.");
	}

	return oauth.ClientSecretPost(env.GOOGLE_CLIENT_SECRET);
}

export function googleRedirectUri(env: AppEnv, request: Request): string {
	if (env.GOOGLE_REDIRECT_URI) {
		return env.GOOGLE_REDIRECT_URI;
	}

	return new URL("/api/auth/google/callback", new URL(request.url).origin).toString();
}
