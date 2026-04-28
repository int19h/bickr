import { type AppEnv, requireUser } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";
import { serviceRequest } from "../../../../_proxy";

export const onRequestGet: PagesFunction<AppEnv, "botId"> = async ({ env, request, params }) => {
	try {
		const user = await requireUser(env, request);
		const botId = Array.isArray(params.botId) ? params.botId[0] : params.botId;
		const url = new URL(request.url);
		const after = url.searchParams.get("after");
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(
				request,
				`/bots/${encodeURIComponent(botId)}/events${after ? `?after=${encodeURIComponent(after)}` : ""}`,
				user.id,
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestDelete: PagesFunction<AppEnv, "botId"> = async ({ env, request, params }) => {
	try {
		const user = await requireUser(env, request);
		const botId = Array.isArray(params.botId) ? params.botId[0] : params.botId;
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(request, `/bots/${encodeURIComponent(botId)}/events`, user.id),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
