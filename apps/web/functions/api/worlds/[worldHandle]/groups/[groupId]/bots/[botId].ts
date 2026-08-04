import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../../../_auth";
import { pageErrorResponse } from "../../../../../_errors";
import { serviceRequest } from "../../../../../_proxy";

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
		return env.AGENT_RUNTIME.fetch(serviceRequest(env, request, `/users/${encodeURIComponent(user.id)}/worlds/${encodeURIComponent(worldHandle)}/groups/${encodeURIComponent(groupId)}/bots/${encodeURIComponent(botId)}`, user.id));
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function singleParam(value: string | string[]): string {
	return Array.isArray(value) ? (value[0] ?? "") : value;
}
