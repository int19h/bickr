import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../_auth";
import { pageErrorResponse } from "../../../_errors";
import { streamingServiceRequest } from "../../../_proxy";

export const onRequestPatch: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		return env.AGENT_RUNTIME.fetch(streamingServiceRequest(
			env,
			request,
			`/users/${encodeURIComponent(user.id)}/worlds/${encodeURIComponent(worldHandle)}/avatar/crop`,
			user.id,
		));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
