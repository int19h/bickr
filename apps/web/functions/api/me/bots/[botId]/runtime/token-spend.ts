import { type AppEnv, requireUser } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";
import { serviceRequest } from "../../../../_proxy";

export const onRequestGet: PagesFunction<AppEnv, "botId"> = async ({ env, request, params }) => {
	try {
		const user = await requireUser(env, request);
		const botId = Array.isArray(params.botId) ? params.botId[0] : params.botId;
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(env, request, `/bots/${encodeURIComponent(botId)}/token-spend`, user.id),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
