import { type AppEnv, requireUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { serviceRequest } from "../../_proxy";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(request, `/users/${encodeURIComponent(user.id)}/bots/token-spend`, user.id),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
