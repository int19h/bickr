import { ok } from "@bickr/shared/api";
import { forumByHandle, countThreads, listThreadsWithReadState } from "@bickr/shared/social";
import { InputError, normalizeHandleParam } from "@bickr/shared/validation";
import { currentUser, type AppEnv } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";
import { boundedLimit, boundedOffset } from "../../../../_query";

export const onRequestGet: PagesFunction<AppEnv, "worldHandle" | "forumHandle"> = async ({
	env,
	params,
	request,
}) => {
	try {
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const forumHandle = normalizeHandleParam(params.forumHandle, "Forum handle");
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		const url = new URL(request.url);
		const sort = url.searchParams.get("sort") === "hot" ? "hot" : "recent";
		const limit = boundedLimit(url.searchParams.get("limit"), 40, 500);
		const pageInput = url.searchParams.get("page");
		if (pageInput !== null && (url.searchParams.has("offset") || !/^\d+$/.test(pageInput) || !Number.isSafeInteger(Number(pageInput)) || Number(pageInput) < 1)) {
			throw new InputError("Page must be a positive safe integer and cannot be combined with offset.");
		}
		const loadedAt = new Date().toISOString();
		const total = await countThreads(env.BICKR_D1, forum.id, sort, loadedAt);
		const pageCount = Math.max(1, Math.ceil(total / limit));
		const currentPage = pageInput !== null ? Math.min(Number(pageInput), pageCount) : Math.floor(boundedOffset(url.searchParams.get("offset")) / limit) + 1;
		const offset = pageInput !== null ? (currentPage - 1) * limit : boundedOffset(url.searchParams.get("offset"));
		const user = await currentUser(env, request);
		const threads = await listThreadsWithReadState(env.BICKR_D1, forum.id, user?.id ?? null, sort, limit, offset, loadedAt);
		return ok({ forum, threads, loadedAt, pagination: {
			currentPage, pageCount, pageSize: limit, total, offset, hasMore: offset + threads.length < total,
		} });
	} catch (error) {
		return pageErrorResponse(error);
	}
};
