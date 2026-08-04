import { type AppEnv, requireUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { streamingServiceRequest } from "../../_proxy";

export const onRequestPatch: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		return env.AGENT_RUNTIME.fetch(streamingServiceRequest(
			env,
			request,
			`/users/${encodeURIComponent(user.id)}/avatar/crop`,
			user.id,
		));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
