import { type AppEnv, requireCompleteUser } from "../../../../../_auth";
import { pageErrorResponse } from "../../../../../_errors";
import { serviceRequest } from "../../../../../_proxy";

export const onRequestGet: PagesFunction<AppEnv, "botId" | "id"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const botId = Array.isArray(params.botId) ? params.botId[0] : params.botId;
		const id = Array.isArray(params.id) ? params.id[0] : params.id;
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(
				env,
				request,
				`/bots/${encodeURIComponent(botId)}/requests/${encodeURIComponent(id)}`,
				user.id,
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
