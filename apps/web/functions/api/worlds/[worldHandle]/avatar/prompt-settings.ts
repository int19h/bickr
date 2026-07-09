import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../_auth";
import { pageErrorResponse } from "../../../_errors";
import { serviceRequest } from "../../../_proxy";

export const onRequestGet: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		return env.AGENT_RUNTIME.fetch(
			serviceRequest(
				env,
				request,
				`/users/${encodeURIComponent(user.id)}/worlds/${encodeURIComponent(worldHandle)}/avatar/prompt-settings`,
				user.id,
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
