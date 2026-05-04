import { ok } from "@bickr/shared/api";
import { forumByHandle, listVotesForTarget, readThread } from "@bickr/shared/social";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv } from "../../../../../../../../_auth";
import { pageErrorResponse } from "../../../../../../../../_errors";

export const onRequestGet: PagesFunction<
	AppEnv,
	"worldHandle" | "forumHandle" | "threadId" | "commentId"
> = async ({ env, params }) => {
	try {
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const forumHandle = normalizeHandleParam(params.forumHandle, "Forum handle");
		const threadId = Array.isArray(params.threadId) ? params.threadId[0] : params.threadId;
		const commentId = Array.isArray(params.commentId) ? params.commentId[0] : params.commentId;
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		const thread = await readThread(env.BICKR_KV, threadId);
		if (thread.forumId !== forum.id || !thread.comments.some((comment) => comment.id === commentId)) {
			return Response.json(
				{ ok: false, error: "not_found", message: "Comment not found." },
				{ status: 404 },
			);
		}
		const votes = await listVotesForTarget(env.BICKR_D1, thread.worldId, "comment", commentId);
		return ok({ votes });
	} catch (error) {
		return pageErrorResponse(error);
	}
};
