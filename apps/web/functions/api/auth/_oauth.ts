import * as oauth from "oauth4webapi";
import { fail } from "@bickr/shared/api";
import { type AuthProvider } from "@bickr/shared/model";
import {
	createSession,
	linkProviderIdentity,
	upsertProviderUser,
	type ProviderUserProfile,
} from "@bickr/shared/repository";
import {
	appendSetCookie,
	clearCookieHeader,
	cookieHeader,
	cookieValue,
	currentUser,
	sessionCookieName,
	type AppEnv,
} from "../_auth";

type OAuthStartConfig = {
	authorizationEndpoint: string;
	clientId: string | undefined;
	provider: AuthProvider;
	redirectUri: string;
	scope: string;
	nonce?: boolean;
};

type ProviderSessionResult = {
	sessionCookieValue?: string;
};

export type OAuthCookieNames = {
	state: string;
	returnTo: string;
	pkce: string;
	nonce: string;
};

export function oauthCookieNames(provider: AuthProvider): OAuthCookieNames {
	const prefix = `bickr_oauth_${provider}`;
	return {
		state: `${prefix}_state`,
		returnTo: `${prefix}_return_to`,
		pkce: `${prefix}_pkce`,
		nonce: `${prefix}_nonce`,
	};
}

export async function oauthStartResponse(request: Request, config: OAuthStartConfig): Promise<Response> {
	if (!config.clientId) {
		return fail("server_error", `${providerLabel(config.provider)} OAuth is not configured.`, 500);
	}

	const state = oauth.generateRandomState();
	const codeVerifier = oauth.generateRandomCodeVerifier();
	const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
	const nonce = config.nonce ? oauth.generateRandomNonce() : null;
	const returnTo = sanitizeReturnTo(new URL(request.url).searchParams.get("returnTo"));
	const url = new URL(config.authorizationEndpoint);
	url.searchParams.set("client_id", config.clientId);
	url.searchParams.set("redirect_uri", config.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", config.scope);
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	if (nonce) {
		url.searchParams.set("nonce", nonce);
	}

	const response = new Response(null, {
		status: 302,
		headers: {
			location: url.toString(),
			"cache-control": "no-store",
		},
	});
	const cookies = oauthCookieNames(config.provider);
	response.headers.append("set-cookie", cookieHeader(request, cookies.state, state, { maxAge: 600 }));
	response.headers.append("set-cookie", cookieHeader(request, cookies.returnTo, returnTo, { maxAge: 600 }));
	response.headers.append("set-cookie", cookieHeader(request, cookies.pkce, codeVerifier, { maxAge: 600 }));
	if (nonce) {
		response.headers.append("set-cookie", cookieHeader(request, cookies.nonce, nonce, { maxAge: 600 }));
	}
	return response;
}

export function expectedOAuthState(request: Request, provider: AuthProvider): string | null {
	return cookieValue(request, oauthCookieNames(provider).state);
}

export function expectedOAuthNonce(request: Request, provider: AuthProvider): string | null {
	return cookieValue(request, oauthCookieNames(provider).nonce);
}

export function oauthCodeVerifier(request: Request, provider: AuthProvider): string | null {
	return cookieValue(request, oauthCookieNames(provider).pkce);
}

export function oauthReturnTo(request: Request, provider: AuthProvider): string {
	return sanitizeReturnTo(cookieValue(request, oauthCookieNames(provider).returnTo));
}

export async function completeProviderSession(
	env: AppEnv,
	request: Request,
	profile: ProviderUserProfile,
): Promise<ProviderSessionResult> {
	const existingUser = await currentUser(env, request);
	if (existingUser) {
		await linkProviderIdentity(env.BICKR_KV, env.BICKR_D1, existingUser.id, profile);
		return {};
	}

	const user = await upsertProviderUser(env.BICKR_KV, env.BICKR_D1, profile);
	const session = await createSession(env.BICKR_KV, user.id);
	return { sessionCookieValue: session.cookieValue };
}

export function oauthSuccessRedirect(
	request: Request,
	provider: AuthProvider,
	returnTo: string,
	sessionCookieValue?: string,
): Response {
	const response = new Response(null, {
		status: 302,
		headers: {
			location: returnTo,
			"cache-control": "no-store",
		},
	});
	const withSession =
		sessionCookieValue ?
			appendSetCookie(
				response,
				cookieHeader(request, sessionCookieName, sessionCookieValue, { maxAge: 60 * 60 * 24 * 30 }),
			)
		:	response;
	return clearOAuthCookies(withSession, request, provider);
}

export function oauthErrorRedirect(
	request: Request,
	provider: AuthProvider,
	code: string,
	returnTo = "/",
): Response {
	const response = new Response(null, {
		status: 302,
		headers: {
			location: returnToWithAuthError(returnTo, code),
			"cache-control": "no-store",
		},
	});
	return clearOAuthCookies(response, request, provider);
}

export function oauthFetch(env: AppEnv): typeof fetch {
	return env.OAUTH_FETCH ?? fetch;
}

function clearOAuthCookies(response: Response, request: Request, provider: AuthProvider): Response {
	const cookies = oauthCookieNames(provider);
	return Object.values(cookies).reduce(
		(current, name) => appendSetCookie(current, clearCookieHeader(request, name)),
		response,
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

function returnToWithAuthError(returnTo: string, code: string): string {
	const parsed = new URL(sanitizeReturnTo(returnTo), "https://bickr.local");
	parsed.searchParams.set("authError", code);
	return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
}

function providerLabel(provider: AuthProvider): string {
	return provider === "github" ? "GitHub" : "Google";
}
