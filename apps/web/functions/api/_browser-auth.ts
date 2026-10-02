import { userForSessionToken } from "@bickr/shared/auth-sessions";
import { RepositoryError } from "@bickr/shared/repository";
import { AuthRequiredError, ProfileIncompleteError, cookieValue, sessionCookieName, type AppEnv } from "./_auth";

export type BrowserConsentPageKind = "form" | "complete";

export function browserConsentHeaders(kind: BrowserConsentPageKind): HeadersInit {
	return {
		"cache-control": "no-store",
		"content-type": "text/html; charset=utf-8",
		// A no-referrer form sends Origin: null and fails the origin check below.
		// Preserve its same-origin POST. The completed page sends no referrer to the client.
		// https://fetch.spec.whatwg.org/#append-a-request-origin-header
		"referrer-policy": kind === "form" ? "same-origin" : "no-referrer",
	};
}

export async function currentBrowserUser(env: AppEnv, request: Request) {
	return userForSessionToken(env.BICKR_KV, cookieValue(request, sessionCookieName), env.BICKR_D1);
}

/** Browser consent requires a cookie and same-origin evidence. Origin is
 * authoritative when present. Older browsers without Origin must explicitly
 * provide Sec-Fetch-Site: same-origin. Missing evidence fails closed. */
export function requireSameOriginBrowserRequest(request: Request): void {
	const origin = request.headers.get("origin");
	const site = request.headers.get("sec-fetch-site");
	if ((origin !== null && origin !== new URL(request.url).origin) ||
		(site !== null && site !== "same-origin") || (origin === null && site !== "same-origin")) {
		throw new RepositoryError("forbidden", "Submit this form from the Bickr page that opened it.", 403);
	}
}

export async function requireBrowserConsentUser(env: AppEnv, request: Request) {
	requireSameOriginBrowserRequest(request);
	const user = await currentBrowserUser(env, request);
	if (!user) throw new AuthRequiredError();
	if (!user.profileCompletedAt) throw new ProfileIncompleteError();
	return user;
}
