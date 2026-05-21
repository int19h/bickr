import { ok, readJsonBody } from "@bickr/shared/api";
import { addBotGroupMembers } from "@bickr/shared/repository";
import { normalizeHandleParam, parseAddBotGroupMembersInput } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";

export const onRequestPost: PagesFunction<AppEnv, "worldHandle" | "groupId"> = async ({
	env,
	request,
	params,
}) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const groupId = singleParam(params.groupId);
		const input = parseAddBotGroupMembersInput(await readJsonBody(request));
		return ok({ group: await addBotGroupMembers(env.BICKR_KV, env.BICKR_D1, worldHandle, user.id, groupId, input) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function singleParam(value: string | string[]): string {
	return Array.isArray(value) ? (value[0] ?? "") : value;
}
