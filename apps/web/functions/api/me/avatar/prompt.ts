import { type AppEnv, requireUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { serviceRequest } from "../../_proxy";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(
				env,
				request,
				`/users/${encodeURIComponent(user.id)}/avatar/prompt`,
				user.id,
				await request.text(),
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
