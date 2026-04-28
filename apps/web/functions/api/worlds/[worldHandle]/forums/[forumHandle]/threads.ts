import { ok } from "@bickr/shared/api";
import { forumByHandle, listThreadsWithReadState, recordForumRead } from "@bickr/shared/social";
import { normalizeHandle } from "@bickr/shared/validation";
import { currentUser, type AppEnv } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";

export const onRequestGet: PagesFunction<AppEnv, "worldHandle" | "forumHandle"> = async ({
	env,
	params,
	request,
}) => {
	try {
		const worldHandle = normalizeHandle(params.worldHandle);
		const forumHandle = normalizeHandle(params.forumHandle);
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		const url = new URL(request.url);
		const sort = url.searchParams.get("sort") === "hot" ? "hot" : "recent";
		const user = await currentUser(env, request);
		const loadedAt = new Date().toISOString();
		const threads = await listThreadsWithReadState(env.BICKR_D1, forum.id, user?.id ?? null, sort);
		if (user) {
			await recordForumRead(env.BICKR_D1, user.id, forum.id, loadedAt);
		}
		return ok({ forum, threads, loadedAt });
	} catch (error) {
		return pageErrorResponse(error);
	}
};
