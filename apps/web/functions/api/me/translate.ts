import { requireUser, type AppEnv } from "../_auth";
import { pageErrorResponse } from "../_errors";
import { serviceRequest } from "../_proxy";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		const body = await request.text();
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(request, `/users/${encodeURIComponent(user.id)}/translate`, user.id, body),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
