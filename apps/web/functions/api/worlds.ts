import { ok } from "@bickr/shared/api";
import { listWorlds } from "@bickr/shared/repository";
import { type AppEnv, requireCompleteUser } from "./_auth";
import { pageErrorResponse } from "./_errors";
import { serviceRequest } from "./_proxy";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env }) => {
	return ok({ worlds: await listWorlds(env.BICKR_D1) });
};

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const body = await request.text();
		return env.AGENT_RUNTIME.fetch(serviceRequest(
			env,
			request,
			`/users/${encodeURIComponent(user.id)}/worlds`,
			user.id,
			body,
		));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
