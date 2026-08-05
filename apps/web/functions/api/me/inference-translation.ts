import { type AppEnv, requireCompleteUser } from "../_auth";
import { pageErrorResponse } from "../_errors";
import { serviceRequest } from "../_proxy";

export const onRequest: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
		return env.AGENT_RUNTIME.fetch(serviceRequest(
			env,
			request,
			`/users/${encodeURIComponent(user.id)}/inference-translation`,
			user.id,
			body,
		));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
