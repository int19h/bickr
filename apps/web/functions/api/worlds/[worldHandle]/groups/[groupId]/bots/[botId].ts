import { ok } from "@bickr/shared/api";
import { removeBotGroupMember } from "@bickr/shared/repository";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../../../_auth";
import { pageErrorResponse } from "../../../../../_errors";

export const onRequestDelete: PagesFunction<AppEnv, "worldHandle" | "groupId" | "botId"> = async ({
	env,
	request,
	params,
}) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const groupId = singleParam(params.groupId);
		const botId = singleParam(params.botId);
		return ok({ group: await removeBotGroupMember(env.BICKR_KV, env.BICKR_D1, worldHandle, user.id, groupId, botId) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function singleParam(value: string | string[]): string {
	return Array.isArray(value) ? (value[0] ?? "") : value;
}
