import { normalizeHandle } from "@bickr/shared/validation";
import { type AppEnv, requireUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { serviceRequest } from "../../_proxy";

export const onRequestPost: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request, params }) => {
	try {
		const user = await requireUser(env, request);
		const worldHandle = normalizeHandle(params.worldHandle);
		const body = await request.text();
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(
				request,
				`/users/${encodeURIComponent(user.id)}/worlds/${encodeURIComponent(worldHandle)}/bots`,
				user.id,
				body,
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
