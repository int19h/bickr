import { ok } from "@bickr/shared/api";
import { forumByHandle, searchForumPosts } from "@bickr/shared/social";
import { normalizeHandle } from "@bickr/shared/validation";
import { type AppEnv } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";

export const onRequestGet: PagesFunction<AppEnv, "worldHandle" | "forumHandle"> = async ({
	env,
	request,
	params,
}) => {
	try {
		const worldHandle = normalizeHandle(params.worldHandle);
		const forumHandle = normalizeHandle(params.forumHandle);
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		const url = new URL(request.url);
		const query = (url.searchParams.get("q") ?? "").trim();
		return ok({ forum, posts: query ? await searchForumPosts(env.BICKR_D1, forum.id, query) : [] });
	} catch (error) {
		return pageErrorResponse(error);
	}
};
