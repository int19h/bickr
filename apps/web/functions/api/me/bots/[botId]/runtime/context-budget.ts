import { type AppEnv, requireCompleteUser } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";
import { serviceRequest } from "../../../../_proxy";

export const onRequestGet: PagesFunction<AppEnv, "botId"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const botId = Array.isArray(params.botId) ? params.botId[0] : params.botId;
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(request, `/bots/${encodeURIComponent(botId)}/context-budget`, user.id),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestPost: PagesFunction<AppEnv, "botId"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const botId = Array.isArray(params.botId) ? params.botId[0] : params.botId;
		const body = await request.text();
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(request, `/bots/${encodeURIComponent(botId)}/context-budget`, user.id, body),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
