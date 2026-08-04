import { ok } from "@bickr/shared/api";
import { listBotGroups } from "@bickr/shared/repository";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { serviceRequest } from "../../_proxy";

export const onRequestGet: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		return ok({ groups: await listBotGroups(env.BICKR_KV, env.BICKR_D1, worldHandle, user.id) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestPost: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		return env.AGENT_RUNTIME.fetch(serviceRequest(env, request, `/users/${encodeURIComponent(user.id)}/worlds/${encodeURIComponent(worldHandle)}/groups`, user.id, await request.text()));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
