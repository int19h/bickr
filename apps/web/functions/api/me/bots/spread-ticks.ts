import { type AppEnv, requireCompleteUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { serviceRequest } from "../../_proxy";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(env, request, `/users/${encodeURIComponent(user.id)}/bots/spread-ticks`, user.id),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
