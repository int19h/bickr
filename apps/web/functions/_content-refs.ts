import { parseCommentRef, parseThreadRef } from "@bickr/shared/ids";
import { RepositoryError } from "@bickr/shared/repository";

type ContentRefEnv = {
	BICKR_D1: D1Database;
};

export type ThreadRefResolution = {
	forumHandle: string;
	path: string;
	threadId: string;
	worldHandle: string;
};

export type CommentRefResolution = ThreadRefResolution & {
	commentId: string;
};

export async function resolveThreadRef(env: ContentRefEnv, value: string): Promise<ThreadRefResolution> {
	const threadId = parseThreadRef(value);
	if (!threadId) {
		throw new RepositoryError("not_found", "Thread not found.", 404);
	}
	const row = await env.BICKR_D1
		.prepare(
			`SELECT world_handle AS worldHandle, forum_handle AS forumHandle
			 FROM threads_index
			 WHERE thread_id = ? AND deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(threadId)
		.first<{ worldHandle: string; forumHandle: string }>();
	if (!row) {
		throw new RepositoryError("not_found", "Thread not found.", 404);
	}
	return {
		forumHandle: row.forumHandle,
		path: threadPath(row.worldHandle, row.forumHandle, threadId),
		threadId,
		worldHandle: row.worldHandle,
	};
}

export async function resolveCommentRef(env: ContentRefEnv, value: string): Promise<CommentRefResolution> {
	const commentId = parseCommentRef(value);
	if (!commentId) {
		throw new RepositoryError("not_found", "Comment not found.", 404);
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
		throw new RepositoryError("not_found", "Comment not found.", 404);
	}
	return {
		commentId,
		forumHandle: row.forumHandle,
		path: commentPath(row.worldHandle, row.forumHandle, row.threadId, commentId),
		threadId: row.threadId,
		worldHandle: row.worldHandle,
	};
}

export function redirectToResolvedPath(path: string, request: Request): Response {
	return Response.redirect(new URL(path, request.url).toString(), 302);
}

function threadPath(worldHandle: string, forumHandle: string, threadId: string): string {
	return `/w/${encodeURIComponent(worldHandle)}/f/${encodeURIComponent(forumHandle)}/t/${encodeURIComponent(threadId)}`;
}

function commentPath(worldHandle: string, forumHandle: string, threadId: string, commentId: string): string {
	return `${threadPath(worldHandle, forumHandle, threadId)}/c/${encodeURIComponent(commentId)}`;
}
