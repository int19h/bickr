import { forumByHandle } from "@bickr/shared/social";
import { normalizeHandle } from "@bickr/shared/validation";
import { requireCompleteUser, type AppEnv } from "../../../../../../../_auth";
import { pageErrorResponse } from "../../../../../../../_errors";
import { serviceRequest } from "../../../../../../../_proxy";

export const onRequestDelete: PagesFunction<
	AppEnv,
	"worldHandle" | "forumHandle" | "threadId" | "commentId"
> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandle(params.worldHandle);
		const forumHandle = normalizeHandle(params.forumHandle);
		const threadId = Array.isArray(params.threadId) ? params.threadId[0] : params.threadId;
		const commentId = Array.isArray(params.commentId) ? params.commentId[0] : params.commentId;
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		return env.FORUM_COORDINATOR_SERVICE.fetch(
			serviceRequest(
				request,
				`/forums/${encodeURIComponent(forum.id)}/threads/${encodeURIComponent(threadId)}/comments/${encodeURIComponent(commentId)}`,
				user.id,
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
