import { type AppEnv, requireCompleteUser } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";
import { streamingServiceRequest } from "../../../../_proxy";

async function avatarMutation(env: AppEnv, request: Request, value: string | string[]): Promise<Response> {
	try {
		const user = await requireCompleteUser(env, request);
		const botId = Array.isArray(value) ? value[0] ?? "" : value;
		return env.AGENT_RUNTIME.fetch(streamingServiceRequest(
			env,
			request,
			`/users/${encodeURIComponent(user.id)}/bots/${encodeURIComponent(botId)}/avatar`,
			user.id,
		));
	} catch (error) {
		return pageErrorResponse(error);
	}
}

export const onRequestPut: PagesFunction<AppEnv, "botId"> = ({ env, request, params }) => avatarMutation(env, request, params.botId);
export const onRequestDelete: PagesFunction<AppEnv, "botId"> = ({ env, request, params }) => avatarMutation(env, request, params.botId);
