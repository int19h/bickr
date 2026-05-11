import { parseThreadRef } from "@bickr/shared/ids";
import type { AppEnv } from "../api/_auth";

export const onRequestGet: PagesFunction<AppEnv, "threadRef"> = async ({ env, params, request }) => {
	const threadId = parseThreadRef(singleParam(params.threadRef));
	if (!threadId) {
		return new Response("Thread not found.", { status: 404 });
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
		return new Response("Thread not found.", { status: 404 });
	}
	return Response.redirect(new URL(threadPath(row.worldHandle, row.forumHandle, threadId), request.url).toString(), 302);
};

function threadPath(worldHandle: string, forumHandle: string, threadId: string): string {
	return `/w/${encodeURIComponent(worldHandle)}/f/${encodeURIComponent(forumHandle)}/t/${encodeURIComponent(threadId)}`;
}

function singleParam(value: string | string[]): string {
	return Array.isArray(value) ? value[0] ?? "" : value;
}
