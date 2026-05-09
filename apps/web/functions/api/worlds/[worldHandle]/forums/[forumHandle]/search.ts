import { ok } from "@bickr/shared/api";
import { forumByHandle, searchForumThreads } from "@bickr/shared/social";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";

export const onRequestGet: PagesFunction<AppEnv, "worldHandle" | "forumHandle"> = async ({
	env,
	request,
	params,
}) => {
	try {
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const forumHandle = normalizeHandleParam(params.forumHandle, "Forum handle");
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		const url = new URL(request.url);
		const query = (url.searchParams.get("q") ?? "").trim();
		return ok({ forum, threads: query ? await searchForumThreads(env.BICKR_D1, forum.id, query) : [] });
	} catch (error) {
		return pageErrorResponse(error);
	}
};
