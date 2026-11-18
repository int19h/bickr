import { forumByHandle } from "@bickr/shared/social";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { requireCompleteUser, type AppEnv } from "../../../../../../../_auth";
import { pageErrorResponse } from "../../../../../../../_errors";
import { serviceRequest } from "../../../../../../../_proxy";

/**
 * DELETE removes the comment. PATCH replaces its body; the coordinator allows
 * that only for the owner of the author bot. Both run on the coordinator of
 * the thread, which serializes them with every other write to it.
 */
const forwardCommentMutation: PagesFunction<
	AppEnv,
	"worldHandle" | "forumHandle" | "threadId" | "commentId"
> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const forumHandle = normalizeHandleParam(params.forumHandle, "Forum handle");
		const threadId = Array.isArray(params.threadId) ? params.threadId[0] : params.threadId;
		const commentId = Array.isArray(params.commentId) ? params.commentId[0] : params.commentId;
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		return env.FORUM_COORDINATOR_SERVICE.fetch(
			serviceRequest(
				env,
				request,
				`/forums/${encodeURIComponent(forum.id)}/threads/${encodeURIComponent(threadId)}/comments/${encodeURIComponent(commentId)}`,
				user.id,
				request.method === "PATCH" ? await request.text() : undefined,
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestDelete = forwardCommentMutation;
export const onRequestPatch = forwardCommentMutation;
