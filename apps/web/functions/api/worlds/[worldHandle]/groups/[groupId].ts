import { ok, readJsonBody } from "@bickr/shared/api";
import { deleteBotGroup, updateBotGroup } from "@bickr/shared/repository";
import { normalizeHandleParam, parseUpdateBotGroupInput } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../_auth";
import { pageErrorResponse } from "../../../_errors";

export const onRequestPatch: PagesFunction<AppEnv, "worldHandle" | "groupId"> = async ({
	env,
	request,
	params,
}) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const groupId = singleParam(params.groupId);
		const input = parseUpdateBotGroupInput(await readJsonBody(request));
		return ok({ group: await updateBotGroup(env.BICKR_KV, env.BICKR_D1, worldHandle, user.id, groupId, input) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestDelete: PagesFunction<AppEnv, "worldHandle" | "groupId"> = async ({
	env,
	request,
	params,
}) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const groupId = singleParam(params.groupId);
		return ok({ group: await deleteBotGroup(env.BICKR_KV, env.BICKR_D1, worldHandle, user.id, groupId) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function singleParam(value: string | string[]): string {
	return Array.isArray(value) ? (value[0] ?? "") : value;
}
