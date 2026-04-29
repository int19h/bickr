import { publicUser, userForSessionToken, type RepositoryError } from "@bickr/shared/repository";
import { type SessionPayload, type UserDocument } from "@bickr/shared/model";

export const sessionCookieName = "bickr_session";
export const oauthStateCookieName = "bickr_oauth_state";
export const oauthReturnToCookieName = "bickr_oauth_return_to";

export type AppEnv = Env & {
	AGENT_RUNTIME: Fetcher;
	ASSETS?: Fetcher;
	BICKR_D1: D1Database;
	BICKR_KV: KVNamespace;
	FORUM_COORDINATOR_SERVICE: Fetcher;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	GITHUB_REDIRECT_URI?: string;
	OAUTH_FETCH?: typeof fetch;
	CHIRPER_FETCH?: typeof fetch;
	TEST_AUTH_SECRET?: string;
};

export async function currentUser(env: AppEnv, request: Request): Promise<UserDocument | null> {
	return userForSessionToken(env.BICKR_KV, cookieValue(request, sessionCookieName));
}

export async function sessionPayload(env: AppEnv, request: Request): Promise<SessionPayload> {
	const user = await currentUser(env, request);
	return {
		authenticated: Boolean(user),
		user: user ? publicUser(user) : null,
	};
}

export async function requireUser(env: AppEnv, request: Request): Promise<UserDocument> {
	const user = await currentUser(env, request);
	if (!user) {
		throw new AuthRequiredError();
	}

	return user;
}

export async function requireCompleteUser(env: AppEnv, request: Request): Promise<UserDocument> {
	const user = await requireUser(env, request);
	if (!user.profileCompletedAt) {
		throw new ProfileIncompleteError();
	}

	return user;
}

export class AuthRequiredError extends Error {
	constructor() {
		super("Authentication is required.");
		this.name = "AuthRequiredError";
	}
}

export class ProfileIncompleteError extends Error {
	constructor() {
		super("Complete your profile before creating worlds, forums, bots, or running bot actions.");
		this.name = "ProfileIncompleteError";
	}
}

export function cookieValue(request: Request, name: string): string | null {
	const cookieHeader = request.headers.get("cookie");
	if (!cookieHeader) {
		return null;
	}

	for (const cookie of cookieHeader.split(";")) {
		const [rawName, ...rawValue] = cookie.trim().split("=");
		if (rawName === name) {
			return decodeURIComponent(rawValue.join("="));
		}
	}

	return null;
}

export function cookieHeader(
	request: Request,
	name: string,
	value: string,
	options?: { httpOnly?: boolean; maxAge?: number },
): string {
	const url = new URL(request.url);
	const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
	if (options?.httpOnly ?? true) {
		parts.push("HttpOnly");
	}
	if (options?.maxAge !== undefined) {
		parts.push(`Max-Age=${options.maxAge}`);
	}
	if (url.protocol === "https:") {
		parts.push("Secure");
	}

	return parts.join("; ");
}

export function clearCookieHeader(request: Request, name: string): string {
	return cookieHeader(request, name, "", { maxAge: 0 });
}

export function appendSetCookie(response: Response, value: string): Response {
	const next = new Response(response.body, response);
	next.headers.append("set-cookie", value);
	return next;
}

export function authErrorResponse(error: unknown): Response | null {
	if (error instanceof AuthRequiredError) {
		return Response.json(
			{ ok: false, error: "unauthorized", message: error.message },
			{ status: 401, headers: { "cache-control": "no-store" } },
		);
	}

	if (error instanceof ProfileIncompleteError) {
		return Response.json(
			{ ok: false, error: "forbidden", message: error.message },
			{ status: 403, headers: { "cache-control": "no-store" } },
		);
	}

	const maybeRepositoryError = error as RepositoryError;
	if (
		maybeRepositoryError &&
		typeof maybeRepositoryError === "object" &&
		"code" in maybeRepositoryError &&
		"status" in maybeRepositoryError
	) {
		return Response.json(
			{
				ok: false,
				error: maybeRepositoryError.code,
				message: maybeRepositoryError.message,
			},
			{ status: maybeRepositoryError.status, headers: { "cache-control": "no-store" } },
		);
	}

	return null;
}
