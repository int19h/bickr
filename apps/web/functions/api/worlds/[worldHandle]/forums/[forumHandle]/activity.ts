import { ok } from "@bickr/shared/api";
import { forumActivitySince, forumByHandle } from "@bickr/shared/social";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";

export const onRequestGet: PagesFunction<AppEnv, "worldHandle" | "forumHandle"> = async ({
	env,
	params,
	request,
}) => {
	try {
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const forumHandle = normalizeHandleParam(params.forumHandle, "Forum handle");
		const url = new URL(request.url);
		const since = parseSince(url.searchParams.get("since"));
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		return ok({ activity: await forumActivitySince(env.BICKR_D1, forum.id, since), checkedAt: new Date().toISOString() });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function parseSince(value: string | null): string {
	if (!value || Number.isNaN(Date.parse(value))) {
		return new Date(0).toISOString();
	}
	return new Date(Date.parse(value)).toISOString();
}
