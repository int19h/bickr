import * as oauth from "oauth4webapi";
import { RepositoryError, type ProviderUserProfile } from "@bickr/shared/repository";
import { type AppEnv } from "../../_auth";
import {
	githubAuthorizationServer,
	githubClient,
	githubClientAuth,
	githubRedirectUri,
} from "./_github";
import {
	completeProviderSession,
	expectedOAuthState,
	oauthCodeVerifier,
	oauthErrorRedirect,
	oauthFetch,
	oauthReturnTo,
	oauthSuccessRedirect,
} from "../_oauth";

type GithubUserResponse = {
	id?: number | string;
	login?: string;
	name?: string | null;
	email?: string | null;
	avatar_url?: string | null;
};

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	const provider = "github";
	const returnTo = oauthReturnTo(request, provider);
	try {
		const expectedState = expectedOAuthState(request, provider);
		if (!expectedState) {
			return oauthErrorRedirect(request, provider, "missing_state", returnTo);
		}
		const codeVerifier = oauthCodeVerifier(request, provider);
		if (!codeVerifier) {
			return oauthErrorRedirect(request, provider, "missing_verifier", returnTo);
		}

		const url = new URL(request.url);
		const client = githubClient(env);
		const callbackParameters = oauth.validateAuthResponse(
			githubAuthorizationServer,
			client,
			url,
			expectedState,
		);
		const redirectUri = githubRedirectUri(env, request);
		const fetchImpl = oauthFetch(env);
		const tokenResponse = await oauth.authorizationCodeGrantRequest(
			githubAuthorizationServer,
			client,
			githubClientAuth(env),
			callbackParameters,
			redirectUri,
			codeVerifier,
			{ [oauth.customFetch]: fetchImpl },
		);
		const token = await oauth.processAuthorizationCodeResponse(
			githubAuthorizationServer,
			client,
			tokenResponse,
		);
		if (typeof token.access_token !== "string") {
			return oauthErrorRedirect(request, provider, "missing_token", returnTo);
		}

		const profileResponse = await oauth.protectedResourceRequest(
			token.access_token,
			"GET",
			new URL("https://api.github.com/user"),
			new Headers({
				accept: "application/vnd.github+json",
				"user-agent": "bickr-local-dev",
				"x-github-api-version": "2022-11-28",
			}),
			undefined,
			{ [oauth.customFetch]: fetchImpl },
		);
		if (!profileResponse.ok) {
			return oauthErrorRedirect(request, provider, "profile_fetch_failed", returnTo);
		}

		const profile = parseGithubProfile((await profileResponse.json()) as GithubUserResponse);
		const result = await completeProviderSession(env, request, profile);
		return oauthSuccessRedirect(request, provider, returnTo, result.sessionCookieValue);
	} catch (error) {
		console.error("github oauth callback failed", error);
		return oauthErrorRedirect(request, provider, oauthErrorCode(error), returnTo);
	}
};

function parseGithubProfile(profile: GithubUserResponse): ProviderUserProfile {
	if (profile.id === undefined || profile.login === undefined) {
		throw new Error("GitHub profile is missing required fields.");
	}

	return {
		provider: "github",
		subject: String(profile.id),
		login: profile.login,
		displayName: profile.name ?? undefined,
		email: profile.email ?? undefined,
		avatarUrl: profile.avatar_url ?? undefined,
	};
}

function oauthErrorCode(error: unknown): string {
	return error instanceof RepositoryError && error.code === "conflict" ? "identity_conflict" : "oauth_failed";
}
