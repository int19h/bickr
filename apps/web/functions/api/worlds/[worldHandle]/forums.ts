import { ok } from "@bickr/shared/api";
import { listForums } from "@bickr/shared/repository";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { serviceRequest } from "../../_proxy";

export const onRequestGet: PagesFunction<AppEnv, "worldHandle"> = async ({ env, params }) => {
	try {
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		return ok({ forums: await listForums(env.BICKR_D1, worldHandle) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestPost: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const body = await request.text();
		return env.FORUM_COORDINATOR_SERVICE.fetch(
			serviceRequest(request, `/worlds/${encodeURIComponent(worldHandle)}/forums`, user.id, body),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
