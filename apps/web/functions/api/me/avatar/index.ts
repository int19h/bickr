import { type AppEnv, requireUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { streamingServiceRequest } from "../../_proxy";

async function avatarMutation(env: AppEnv, request: Request): Promise<Response> {
	try {
		const user = await requireUser(env, request);
		return env.AGENT_RUNTIME.fetch(streamingServiceRequest(
			env,
			request,
			`/users/${encodeURIComponent(user.id)}/avatar`,
			user.id,
		));
	} catch (error) {
		return pageErrorResponse(error);
	}
}

export const onRequestPut: PagesFunction<AppEnv> = ({ env, request }) => avatarMutation(env, request);
export const onRequestDelete: PagesFunction<AppEnv> = ({ env, request }) => avatarMutation(env, request);
