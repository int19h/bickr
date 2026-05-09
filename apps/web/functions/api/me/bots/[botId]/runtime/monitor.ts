import { type AppEnv, requireUser } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";
import { serviceRequest } from "../../../../_proxy";

export const onRequest: PagesFunction<AppEnv, "botId"> = async ({ env, request, params }) => {
	try {
		const user = await requireUser(env, request);
		const botId = Array.isArray(params.botId) ? params.botId[0] : params.botId;
		const url = new URL(request.url);
		const query = url.searchParams.toString();
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(
				request,
				`/bots/${encodeURIComponent(botId)}/monitor${query ? `?${query}` : ""}`,
				user.id,
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
