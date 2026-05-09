import { ok } from "@bickr/shared/api";
import { humanProfileByHandle } from "@bickr/shared/repository";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv, requireUser } from "../_auth";
import { pageErrorResponse } from "../_errors";

export const onRequestGet: PagesFunction<AppEnv, "humanHandle"> = async ({ env, request, params }) => {
	try {
		const viewer = await requireUser(env, request);
		const humanHandle = normalizeHandleParam(params.humanHandle, "Human handle");
		return ok({ profile: await humanProfileByHandle(env.BICKR_KV, env.BICKR_D1, humanHandle, viewer.id) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};
