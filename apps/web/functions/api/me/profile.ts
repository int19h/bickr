import { ok } from "@bickr/shared/api";
import { updateUserProfile, userProfile } from "@bickr/shared/repository";
import { parseUpdateUserProfileInput } from "@bickr/shared/validation";
import { type AppEnv, requireUser } from "../_auth";
import { pageErrorResponse } from "../_errors";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		return ok({ profile: userProfile(user) });
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
