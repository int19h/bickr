import { type AppEnv, requireCompleteUser } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";
import { streamingServiceRequest } from "../../../../_proxy";

export const onRequestPatch: PagesFunction<AppEnv, "botId"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const botId = Array.isArray(params.botId) ? params.botId[0] ?? "" : params.botId;
		return env.AGENT_RUNTIME.fetch(streamingServiceRequest(
			env,
			request,
			`/users/${encodeURIComponent(user.id)}/bots/${encodeURIComponent(botId)}/avatar/crop`,
			user.id,
		));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
