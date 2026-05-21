import { ok, readJsonBody } from "@bickr/shared/api";
import { createBotGroup, listBotGroups } from "@bickr/shared/repository";
import { normalizeHandleParam, parseCreateBotGroupInput } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";

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
		const input = parseCreateBotGroupInput(await readJsonBody(request));
		return ok(
			{ group: await createBotGroup(env.BICKR_KV, env.BICKR_D1, worldHandle, user.id, input) },
			{ status: 201 },
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
