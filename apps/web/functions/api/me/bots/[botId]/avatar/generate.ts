import { type AppEnv, requireCompleteUser } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";
import { serviceRequest } from "../../../../_proxy";

export const onRequestPost: PagesFunction<AppEnv, "botId"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(
				env,
				request,
				`/users/${encodeURIComponent(user.id)}/bots/${encodeURIComponent(singleParam(params.botId))}/avatar/generate`,
				user.id,
				await request.text(),
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function singleParam(value: string | string[]): string {
	return Array.isArray(value) ? (value[0] ?? "") : value;
}
