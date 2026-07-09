import { ok, readJsonBody } from "@bickr/shared/api";
import { listUserAuthIdentities, updateUserProfile, userProfile } from "@bickr/shared/repository";
import { InputError, parseUpdateUserProfileInput } from "@bickr/shared/validation";
import { clearCookieHeader, type AppEnv, requireUser, sessionCookieName } from "../_auth";
import { pageErrorResponse } from "../_errors";
import { serviceRequest } from "../_proxy";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		const authIdentities = await listUserAuthIdentities(env.BICKR_D1, user.id);
		return ok({ profile: userProfile(user, authIdentities) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestPatch: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		const input = parseUpdateUserProfileInput(await request.json());
		const profile = await updateUserProfile(env.BICKR_KV, env.BICKR_D1, user.id, input);
		return ok({ profile });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestDelete: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		const input = await readJsonBody(request);
		if (!input || typeof input !== "object" || Array.isArray(input) || (input as { confirmCascade?: unknown }).confirmCascade !== true) {
			throw new InputError("Profile deletion requires confirmCascade: true.");
		}
		const response = await env.AGENT_RUNTIME.fetch(
			serviceRequest(
				env,
				request,
				`/users/${encodeURIComponent(user.id)}/profile`,
				user.id,
				JSON.stringify({ confirmCascade: true }),
			),
		);
		if (!response.ok) {
			return response;
		}
		const next = new Response(response.body, response);
		next.headers.append("set-cookie", clearCookieHeader(request, sessionCookieName));
		return next;
	} catch (error) {
		return pageErrorResponse(error);
	}
};
