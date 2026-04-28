import * as oauth from "oauth4webapi";
import { createSession, upsertGithubUser } from "@bickr/shared/repository";
import {
	appendSetCookie,
	clearCookieHeader,
	cookieHeader,
	cookieValue,
	oauthReturnToCookieName,
	oauthStateCookieName,
	sessionCookieName,
	type AppEnv,
} from "../../_auth";
import {
	githubAuthorizationServer,
	githubClient,
	githubClientAuth,
	githubRedirectUri,
	oauthFetch,
} from "./_github";

type GithubUserResponse = {
	id?: number | string;
	login?: string;
	name?: string | null;
	email?: string | null;
	avatar_url?: string | null;
};

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const expectedState = cookieValue(request, oauthStateCookieName);
		if (!expectedState) {
			return redirectWithError(request, "missing_state");
		}
		const returnTo = sanitizeReturnTo(cookieValue(request, oauthReturnToCookieName));

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
			oauth.nopkce,
			{ [oauth.customFetch]: fetchImpl },
		);
		const token = await oauth.processAuthorizationCodeResponse(
			githubAuthorizationServer,
			client,
			tokenResponse,
		);
		if (typeof token.access_token !== "string") {
			return redirectWithError(request, "missing_token");
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
			return redirectWithError(request, "profile_fetch_failed");
		}

		const profile = parseGithubProfile((await profileResponse.json()) as GithubUserResponse);
		const user = await upsertGithubUser(env.BICKR_KV, env.BICKR_D1, profile);
		const session = await createSession(env.BICKR_KV, user.id);
		const response = new Response(null, {
			status: 302,
			headers: {
				location: returnTo,
				"cache-control": "no-store",
			},
		});

		return appendSetCookie(
			appendSetCookie(
				appendSetCookie(
					response,
					cookieHeader(request, sessionCookieName, session.cookieValue, { maxAge: 60 * 60 * 24 * 30 }),
				),
				clearCookieHeader(request, oauthStateCookieName),
			),
			clearCookieHeader(request, oauthReturnToCookieName),
		);
	} catch (error) {
		console.error("github oauth callback failed", error);
		return redirectWithError(request, "oauth_failed");
	}
};

function parseGithubProfile(profile: GithubUserResponse) {
	if (profile.id === undefined || profile.login === undefined) {
		throw new Error("GitHub profile is missing required fields.");
	}

	return {
		subject: String(profile.id),
		login: profile.login,
		displayName: profile.name ?? undefined,
		email: profile.email ?? undefined,
		avatarUrl: profile.avatar_url ?? undefined,
	};
}

function redirectWithError(request: Request, code: string): Response {
	const response = new Response(null, {
		status: 302,
		headers: {
			location: `/?authError=${encodeURIComponent(code)}`,
			"cache-control": "no-store",
		},
	});

	return appendSetCookie(
		appendSetCookie(response, clearCookieHeader(request, oauthStateCookieName)),
		clearCookieHeader(request, oauthReturnToCookieName),
	);
}

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
