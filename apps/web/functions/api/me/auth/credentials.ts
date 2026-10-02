import { ok } from "@bickr/shared/api";
import { listAccountCredentials, revokeAccountCredential, revokeAllAccountCredentials } from "@bickr/shared/auth-credentials";
import { InputError } from "@bickr/shared/validation";
import { requireUser, type AppEnv } from "../../_auth";
import { requireBrowserConsentUser } from "../../_browser-auth";
import { pageErrorResponse } from "../../_errors";
import { readBoundedRequest } from "@bickr/shared/bounded-body";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		const cursor = new URL(request.url).searchParams.get("after") ?? "";
		if (cursor.length > 200) throw new InputError("The cursor is too long.");
		return ok(await listAccountCredentials(env.BICKR_D1, user.id, cursor));
	} catch (error) { return pageErrorResponse(error); }
};

export const onRequestDelete: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireBrowserConsentUser(env, request);
		const input: unknown = JSON.parse(new TextDecoder().decode(await readBoundedRequest(request, { maxBytes: 1024, timeoutMs: 10_000 })));
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("Choose a credential or all credentials.");
		const selection = input as { kind?: unknown; id?: unknown };
		if (selection.kind === "all") await revokeAllAccountCredentials(env.BICKR_D1, user.id);
		else if (selection.kind === "credential" && typeof selection.id === "string" && selection.id.length <= 200) {
			await revokeAccountCredential(env.BICKR_D1, user.id, selection.id);
		} else throw new InputError("Choose a credential or all credentials.");
		return ok({ revoked: true });
	} catch (error) {
		if (error instanceof SyntaxError) return pageErrorResponse(new InputError("The request body is malformed."));
		return pageErrorResponse(error);
	}
};
