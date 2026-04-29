import { type AppEnv, requireCompleteUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { serviceRequest } from "../../_proxy";

export const onRequestPatch: PagesFunction<AppEnv, "botId"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const body = await request.text();
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(
				request,
				`/users/${encodeURIComponent(user.id)}/bots/${encodeURIComponent(singleParam(params.botId))}`,
				user.id,
				body,
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestDelete: PagesFunction<AppEnv, "botId"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(
				request,
				`/users/${encodeURIComponent(user.id)}/bots/${encodeURIComponent(singleParam(params.botId))}`,
				user.id,
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function singleParam(value: string | string[]): string {
	return Array.isArray(value) ? (value[0] ?? "") : value;
}
