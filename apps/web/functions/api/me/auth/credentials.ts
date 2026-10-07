import { ok } from "@bickr/shared/api";
import { listAccountCredentials, renameAccountCredential, revokeAccountCredential, revokeAllAccountCredentials } from "@bickr/shared/auth-credentials";
import { authKey } from "@bickr/shared/auth-store";
import { sha256Hex } from "@bickr/shared/ids";
import { InputError } from "@bickr/shared/validation";
import { appendSetCookie, AuthRequiredError, clearCookieHeader, cookieValue, currentAuth, sessionCookieName, type AppEnv } from "../../_auth";
import { requireBrowserConsentUser } from "../../_browser-auth";
import { pageErrorResponse } from "../../_errors";
import { readBoundedRequest } from "@bickr/shared/bounded-body";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const auth = await currentAuth(env, request);
		if (!auth) throw new AuthRequiredError();
		const cursor = new URL(request.url).searchParams.get("after") ?? "";
		if (cursor.length > 200) throw new InputError("The cursor is too long.");
		const currentSessionId = auth.kind === "cookie" ? authKey("session", await sha256Hex(auth.token)) : null;
		return ok(await listAccountCredentials(env.BICKR_D1, auth.user.id, cursor, new Date(), currentSessionId));
	} catch (error) { return pageErrorResponse(error); }
};

export const onRequestPatch: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireBrowserConsentUser(env, request);
		const input = await credentialInput(request);
		if (!validCredentialId(input.id) || typeof input.name !== "string") throw new InputError("Choose access and enter a name.");
		await renameAccountCredential(env.BICKR_D1, user.id, input.id, input.name);
		return ok({ renamed: true });
	} catch (error) { return mutationError(error); }
};

export const onRequestDelete: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireBrowserConsentUser(env, request);
		const selection = await credentialInput(request);
		let sessionRevoked = selection.kind === "all";
		if (selection.kind === "all") await revokeAllAccountCredentials(env.BICKR_D1, user.id);
		else if (selection.kind === "credential" && validCredentialId(selection.id)) {
			await revokeAccountCredential(env.BICKR_D1, user.id, selection.id);
			const cookie = cookieValue(request, sessionCookieName);
			sessionRevoked = cookie !== null && selection.id === authKey("session", await sha256Hex(cookie));
		} else throw new InputError("Choose a credential or all credentials.");
		const response = ok({ revoked: true, sessionRevoked });
		return sessionRevoked ? appendSetCookie(response, clearCookieHeader(request, sessionCookieName)) : response;
	} catch (error) { return mutationError(error); }
};

async function credentialInput(request: Request): Promise<Record<string, unknown>> {
	const input: unknown = JSON.parse(new TextDecoder().decode(await readBoundedRequest(request, { maxBytes: 1024, timeoutMs: 10_000 })));
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("Choose a credential or all credentials.");
	return input as Record<string, unknown>;
}

function validCredentialId(id: unknown): id is string {
	return typeof id === "string" && id.length > 0 && id.length <= 200;
}

function mutationError(error: unknown): Response {
	return pageErrorResponse(error instanceof SyntaxError ? new InputError("The request body is malformed.") : error);
}
