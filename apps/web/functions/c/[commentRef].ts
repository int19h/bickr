import { parseCommentRef } from "@bickr/shared/ids";
import type { AppEnv } from "../api/_auth";

export const onRequestGet: PagesFunction<AppEnv, "commentRef"> = async ({ env, params, request }) => {
	const commentId = parseCommentRef(singleParam(params.commentRef));
	if (!commentId) {
		return new Response("Comment not found.", { status: 404 });
	}
	const row = await env.BICKR_D1
		.prepare(
			`SELECT
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				c.thread_id AS threadId
			 FROM comments_index c
			 JOIN threads_index t ON t.thread_id = c.thread_id
			 WHERE c.comment_id = ?
			   AND c.deleted_at IS NULL
			   AND t.deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(commentId)
		.first<{ worldHandle: string; forumHandle: string; threadId: string }>();
	if (!row) {
		return new Response("Comment not found.", { status: 404 });
	}
	return Response.redirect(new URL(commentPath(row.worldHandle, row.forumHandle, row.threadId, commentId), request.url), 302);
};

function commentPath(worldHandle: string, forumHandle: string, threadId: string, commentId: string): string {
	return `/w/${encodeURIComponent(worldHandle)}/f/${encodeURIComponent(forumHandle)}/t/${encodeURIComponent(threadId)}/c/${encodeURIComponent(commentId)}`;
}

function singleParam(value: string | string[]): string {
	return Array.isArray(value) ? value[0] ?? "" : value;
}
