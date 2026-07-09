import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../_auth";
import { pageErrorResponse } from "../_errors";
import { serviceRequest } from "../_proxy";

export const onRequestPatch: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const body = await request.text();
		return env.FORUM_COORDINATOR_SERVICE.fetch(
			serviceRequest(env, request, `/worlds/${encodeURIComponent(worldHandle)}`, user.id, body),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestDelete: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		return env.FORUM_COORDINATOR_SERVICE.fetch(
			serviceRequest(env, request, `/worlds/${encodeURIComponent(worldHandle)}`, user.id),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
