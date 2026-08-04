import * as oauth from "oauth4webapi";
import { fail } from "@bickr/shared/api";
import { sha256Hex } from "@bickr/shared/ids";
import { parseAccountMutationResult } from "@bickr/shared/account-mutation-protocol";
import { type AuthProvider } from "@bickr/shared/model";
import {
	createSession,
	RepositoryError,
	type ProviderUserProfile,
} from "@bickr/shared/repository";
import { type UserDocument } from "@bickr/shared/model";
import { deleteKey, kvKeys, readJson, writeJson } from "@bickr/shared/storage";
import {
	appendSetCookie,
	clearCookieHeader,
	cookieHeader,
	cookieValue,
	currentUser,
	sessionCookieName,
	type AppEnv,
} from "../_auth";
import { fetchServiceJson, serviceRequest } from "../_proxy";

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

type OAuthReturnToDocument = {
	type: "oauthReturnTo";
	provider: AuthProvider;
	returnTo: string;
	createdAt: string;
	expiresAt: string;
};

const returnToTtlSeconds = 10 * 60;
const maxReturnToLength = 16_384;
const maxReturnToCookieLength = 1_500;

export function oauthCookieNames(provider: AuthProvider): OAuthCookieNames {
	const prefix = `bickr_oauth_${provider}`;
	return {
		state: `${prefix}_state`,
		returnTo: `${prefix}_return_to`,
		pkce: `${prefix}_pkce`,
		nonce: `${prefix}_nonce`,
	};
}

export async function oauthStartResponse(env: AppEnv, request: Request, config: OAuthStartConfig): Promise<Response> {
	if (!config.clientId) {
		return fail("server_error", `${providerLabel(config.provider)} OAuth is not configured.`, 500);
	}

	const state = oauth.generateRandomState();
	const codeVerifier = oauth.generateRandomCodeVerifier();
	const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
	const nonce = config.nonce ? oauth.generateRandomNonce() : null;
	const returnTo = sanitizeReturnTo(new URL(request.url).searchParams.get("returnTo"));
	await storeOAuthReturnTo(env, config.provider, state, returnTo);
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
	response.headers.append(
		"set-cookie",
		cookieHeader(request, cookies.returnTo, returnTo.length <= maxReturnToCookieLength ? returnTo : "/", { maxAge: 600 }),
	);
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

export async function oauthReturnTo(env: AppEnv, request: Request, provider: AuthProvider): Promise<string> {
	const stored = await consumeOAuthReturnTo(env, provider, expectedOAuthState(request, provider));
	return stored ?? sanitizeReturnTo(cookieValue(request, oauthCookieNames(provider).returnTo));
}

export async function completeProviderSession(
	env: AppEnv,
	request: Request,
	profile: ProviderUserProfile,
): Promise<ProviderSessionResult> {
	const existingUser = await currentUser(env, request);
	if (existingUser) {
		await requestProviderIdentityLink(env, request, existingUser.id, profile);
		return {};
	}

	const user = await requestAccountBootstrap(env, request, profile);
	const session = await createSession(env.BICKR_KV, user.id);
	return { sessionCookieValue: session.cookieValue };
}

async function requestAccountBootstrap(
	env: AppEnv,
	request: Request,
	profile: ProviderUserProfile,
): Promise<UserDocument> {
	const { response, payload } = await fetchServiceJson(
		env.AGENT_RUNTIME,
		serviceRequest(env, new Request(request, { method: "POST" }), "/accounts/bootstrap", "bootstrap", JSON.stringify(profile)),
	);
	return providerMutationUser(response, payload, "account_bootstrapped");
}

async function requestProviderIdentityLink(
	env: AppEnv,
	request: Request,
	userId: string,
	profile: ProviderUserProfile,
): Promise<void> {
	const { response, payload } = await fetchServiceJson(
		env.AGENT_RUNTIME,
		serviceRequest(
			env,
			new Request(request, { method: "POST" }),
			`/users/${encodeURIComponent(userId)}/auth/identities`,
			userId,
			JSON.stringify(profile),
		),
	);
	providerMutationUser(response, payload, "provider_identity_linked");
}

function providerMutationUser(response: Response, payload: unknown, expectedKind: "account_bootstrapped"): UserDocument;
function providerMutationUser(response: Response, payload: unknown, expectedKind: "provider_identity_linked"): undefined;
function providerMutationUser(
	response: Response,
	payload: unknown,
	expectedKind: "account_bootstrapped" | "provider_identity_linked",
): UserDocument | undefined {
	const record = payload && typeof payload === "object" && !Array.isArray(payload)
		? payload as Record<string, unknown>
		: {};
	const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
		? record.data as Record<string, unknown>
		: {};
	if (!response.ok) {
		const code = typeof record.error === "string" && ["bad_request", "conflict", "forbidden", "not_found", "server_error", "unauthorized"].includes(record.error)
			? record.error as RepositoryError["code"]
			: "server_error";
		throw new RepositoryError(code, typeof record.message === "string" ? record.message : "Account coordinator request failed.", response.status || 500);
	}
	const result = parseAccountMutationResult(data);
	switch (result.kind) {
		case "account_bootstrapped":
			if (expectedKind !== result.kind) throw wrongAccountMutationKind();
			return result.user;
		case "provider_identity_linked":
			if (expectedKind !== result.kind) throw wrongAccountMutationKind();
			return undefined;
		case "profile_updated":
		case "provider_identity_unlinked":
			throw wrongAccountMutationKind();
	}
}

function wrongAccountMutationKind(): RepositoryError {
	return new RepositoryError("server_error", "Account coordinator returned the wrong mutation result.", 500);
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

async function storeOAuthReturnTo(
	env: AppEnv,
	provider: AuthProvider,
	state: string,
	returnTo: string,
	now = new Date(),
): Promise<void> {
	const createdAt = now.toISOString();
	await writeJson(env.BICKR_KV, kvKeys.oauthReturnTo(provider, await sha256Hex(state)), {
		type: "oauthReturnTo",
		provider,
		returnTo,
		createdAt,
		expiresAt: new Date(now.getTime() + returnToTtlSeconds * 1000).toISOString(),
	} satisfies OAuthReturnToDocument, { expirationTtl: returnToTtlSeconds });
}

async function consumeOAuthReturnTo(
	env: AppEnv,
	provider: AuthProvider,
	state: string | null,
	now = new Date(),
): Promise<string | null> {
	if (!state) {
		return null;
	}
	const key = kvKeys.oauthReturnTo(provider, await sha256Hex(state));
	const stored = await readJson<OAuthReturnToDocument>(env.BICKR_KV, key);
	await deleteKey(env.BICKR_KV, key);
	if (!stored || stored.provider !== provider || Date.parse(stored.expiresAt) <= now.getTime()) {
		return null;
	}
	return sanitizeReturnTo(stored.returnTo);
}

function sanitizeReturnTo(value: string | null): string {
	const fallback = "/";
	const raw = value?.trim();
	if (!raw || raw.length > maxReturnToLength || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
		return fallback;
	}
	try {
		const parsed = new URL(raw, "https://bickr.local");
		if (
			parsed.origin !== "https://bickr.local" ||
			(parsed.pathname.startsWith("/api/") && parsed.pathname !== "/api/cli/auth/approve")
		) {
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
