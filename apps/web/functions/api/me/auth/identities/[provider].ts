import { authProviders, type AuthProvider } from "@bickr/shared/model";
import { ok } from "@bickr/shared/api";
import { RepositoryError, unlinkProviderIdentity, userProfile } from "@bickr/shared/repository";
import { type AppEnv, requireUser } from "../../../_auth";
import { pageErrorResponse } from "../../../_errors";

export const onRequestDelete: PagesFunction<AppEnv, "provider"> = async ({ env, params, request }) => {
	try {
		const provider = authProviderFromParam(Array.isArray(params.provider) ? params.provider[0] : params.provider);
		const user = await requireUser(env, request);
		const authIdentities = await unlinkProviderIdentity(env.BICKR_D1, user.id, provider);
		return ok({ profile: userProfile(user, authIdentities) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function authProviderFromParam(value: string | undefined): AuthProvider {
	if (value && (authProviders as readonly string[]).includes(value)) {
		return value as AuthProvider;
	}
	throw new RepositoryError("not_found", "Sign-in provider not found.", 404);
}
