import { normalizeHandle } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../_auth";
import { pageErrorResponse } from "../../../_errors";
import { serviceRequest } from "../../../_proxy";

export const onRequestPatch: PagesFunction<AppEnv, "worldHandle" | "forumHandle"> = async ({
	env,
	request,
	params,
}) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandle(params.worldHandle);
		const forumHandle = normalizeHandle(params.forumHandle);
		const body = await request.text();
		return env.FORUM_COORDINATOR_SERVICE.fetch(
			serviceRequest(
				request,
				`/worlds/${encodeURIComponent(worldHandle)}/forums/${encodeURIComponent(forumHandle)}`,
				user.id,
				body,
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestDelete: PagesFunction<AppEnv, "worldHandle" | "forumHandle"> = async ({
	env,
	request,
	params,
}) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandle(params.worldHandle);
		const forumHandle = normalizeHandle(params.forumHandle);
		return env.FORUM_COORDINATOR_SERVICE.fetch(
			serviceRequest(
				request,
				`/worlds/${encodeURIComponent(worldHandle)}/forums/${encodeURIComponent(forumHandle)}`,
				user.id,
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
