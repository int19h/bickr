import { authProviders, type AuthProvider } from "@bickr/shared/model";
import { RepositoryError } from "@bickr/shared/repository";
import { type AppEnv, requireUser } from "../../../_auth";
import { pageErrorResponse } from "../../../_errors";
import { serviceRequest } from "../../../_proxy";

export const onRequestDelete: PagesFunction<AppEnv, "provider"> = async ({ env, params, request }) => {
	try {
		const provider = authProviderFromParam(Array.isArray(params.provider) ? params.provider[0] : params.provider);
		const user = await requireUser(env, request);
		return env.AGENT_RUNTIME.fetch(serviceRequest(
			env,
			request,
			`/users/${encodeURIComponent(user.id)}/auth/identities/${encodeURIComponent(provider)}`,
			user.id,
		));
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
