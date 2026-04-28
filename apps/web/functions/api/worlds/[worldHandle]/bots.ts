import { normalizeHandle } from "@bickr/shared/validation";
import { ok } from "@bickr/shared/api";
import { listWorldBots } from "@bickr/shared/repository";
import { type AppEnv, requireUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { serviceRequest } from "../../_proxy";

export const onRequestGet: PagesFunction<AppEnv, "worldHandle"> = async ({ env, params }) => {
	try {
		const worldHandle = normalizeHandle(params.worldHandle);
		return ok({ bots: await listWorldBots(env.BICKR_KV, env.BICKR_D1, worldHandle) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

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
