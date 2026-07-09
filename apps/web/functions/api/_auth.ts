import { publicUser, userForCliToken, userForSessionToken } from "@bickr/shared/repository";
import { type SessionPayload, type UserDocument } from "@bickr/shared/model";

export const sessionCookieName = "bickr_session";

export type AppEnv = Env & {
	AGENT_RUNTIME: Fetcher;
	ASSETS?: Fetcher;
	BICKR_D1: D1Database;
	BICKR_KV: KVNamespace;
	BICKR_R2?: R2Bucket;
	BICKR_R2_PUBLIC_BASE_URL?: string;
	FORUM_COORDINATOR_SERVICE: Fetcher;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	GITHUB_REDIRECT_URI?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GOOGLE_REDIRECT_URI?: string;
	INTERNAL_SERVICE_SECRET?: string;
	OAUTH_FETCH?: typeof fetch;
	CHIRPER_FETCH?: typeof fetch;
	TEST_AUTH_ALLOWED_HOSTS?: string;
	TEST_AUTH_SECRET?: string;
};

export type AuthContext =
	| { kind: "cookie"; token: string; user: UserDocument }
	| { kind: "bearer"; token: string; user: UserDocument };

export async function currentUser(env: AppEnv, request: Request): Promise<UserDocument | null> {
	return (await currentAuth(env, request))?.user ?? null;
}

export async function currentAuth(env: AppEnv, request: Request): Promise<AuthContext | null> {
	const sessionToken = cookieValue(request, sessionCookieName);
	const sessionUser = await userForSessionToken(env.BICKR_KV, sessionToken);
	if (sessionUser && sessionToken) {
		return { kind: "cookie", token: sessionToken, user: sessionUser };
	}
	const token = bearerToken(request);
	if (!token) {
		return null;
	}
	const user = await userForCliToken(env.BICKR_KV, token);
	return user ? { kind: "bearer", token, user } : null;
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

export function bearerToken(request: Request): string | null {
	const authorization = request.headers.get("authorization")?.trim();
	if (!authorization) {
		return null;
	}
	const match = /^Bearer\s+(.+)$/i.exec(authorization);
	const token = match?.[1]?.trim();
	return token || null;
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
