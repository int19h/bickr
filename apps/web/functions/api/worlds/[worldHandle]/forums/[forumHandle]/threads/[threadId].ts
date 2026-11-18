import { ok } from "@bickr/shared/api";
import { forumByHandle, readThreadWithReadState, recordThreadRead, threadWithReadState } from "@bickr/shared/social";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { currentUser, requireCompleteUser, type AppEnv } from "../../../../../_auth";
import { pageErrorResponse } from "../../../../../_errors";
import { readCoordinatorThread } from "../../../../../_coordinator-thread";
import { serviceRequest } from "../../../../../_proxy";

export const onRequestGet: PagesFunction<
	AppEnv,
	"worldHandle" | "forumHandle" | "threadId"
> = async ({ env, params, request }) => {
	try {
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const forumHandle = normalizeHandleParam(params.forumHandle, "Forum handle");
		const threadId = Array.isArray(params.threadId) ? params.threadId[0] : params.threadId;
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		const user = await currentUser(env, request);
		const loadedAt = new Date().toISOString();
		const fresh = new URL(request.url).searchParams.get("fresh") === "1";
		const thread =
			fresh ?
				// The coordinator hydrates every thread document it returns (§2.7),
				// so this path only adds the read state the KV path gets from
				// readThreadWithReadState.
				await threadWithReadState(
					env.BICKR_D1,
					await readCoordinatorThread(env, threadId, request.headers.get("accept")),
					user?.id ?? null,
				)
			:	await readThreadWithReadState(env.BICKR_KV, env.BICKR_D1, threadId, user?.id ?? null);
		if (thread.forumId !== forum.id) {
			return Response.json(
				{ ok: false, error: "not_found", message: "Thread not found." },
				{ status: 404 },
			);
		}
		if (user) {
			await recordThreadRead(env.BICKR_D1, user.id, thread.id, loadedAt);
		}
		return ok({ thread, loadedAt });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestDelete: PagesFunction<
	AppEnv,
	"worldHandle" | "forumHandle" | "threadId"
> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const forumHandle = normalizeHandleParam(params.forumHandle, "Forum handle");
		const threadId = Array.isArray(params.threadId) ? params.threadId[0] : params.threadId;
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		return env.FORUM_COORDINATOR_SERVICE.fetch(
			serviceRequest(
				env,
				request,
				`/forums/${encodeURIComponent(forum.id)}/threads/${encodeURIComponent(threadId)}`,
				user.id,
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
