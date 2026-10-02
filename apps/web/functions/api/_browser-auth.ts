import { userForSessionToken } from "@bickr/shared/auth-sessions";
import { RepositoryError } from "@bickr/shared/repository";
import { AuthRequiredError, ProfileIncompleteError, cookieValue, sessionCookieName, type AppEnv } from "./_auth";

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
