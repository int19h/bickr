import { fail, ok } from "@bickr/shared/api";
import { parseCommentRef, parseThreadRef } from "@bickr/shared/ids";
import { worldByHandle } from "@bickr/shared/repository";
import { forumByHandle, readThread } from "@bickr/shared/social";
import { normalizeHandle } from "@bickr/shared/validation";
import { parsePathname, routePath } from "../../../src/routes";
import { type AppEnv } from "../_auth";
import { pageErrorResponse } from "../_errors";

type RefCandidate = {
	id?: string;
	path: string;
	type: "world" | "forum" | "bot" | "thread" | "comment";
};

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const value = new URL(request.url).searchParams.get("ref")?.trim() ?? "";
		if (!value) {
			return fail("bad_request", "Reference is required.", 400);
		}
		const candidates = await resolveCandidates(env, value);
		if (candidates.length === 0) {
			return fail("not_found", "Reference not found.", 404);
		}
		if (candidates.length > 1) {
			return fail("conflict", "Reference is ambiguous.", 409, {
				references: candidates.map((candidate) => candidate.path),
			});
		}
		return ok({ ref: candidates[0] });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

async function resolveCandidates(env: AppEnv, value: string): Promise<RefCandidate[]> {
	const pathValue = value.startsWith("/") ? value : `/${value}`;
	const parsed = parsePathname(pathValue);
	if (parsed.route === "world" && parsed.worldHandle) {
		const worldHandle = normalizeHandle(parsed.worldHandle);
		const world = await worldByHandle(env.BICKR_D1, worldHandle);
		return [{ id: world.id, path: routePath({ route: "world", worldHandle }), type: "world" }];
	}
	if (parsed.route === "forum" && parsed.worldHandle && parsed.forumHandle) {
		const worldHandle = normalizeHandle(parsed.worldHandle);
		const forumHandle = normalizeHandle(parsed.forumHandle);
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		return [{ id: forum.id, path: routePath({ route: "forum", worldHandle, forumHandle }), type: "forum" }];
	}
	if (parsed.route === "thread" && parsed.worldHandle && parsed.forumHandle && parsed.threadId) {
		const thread = await readThread(env.BICKR_KV, parsed.threadId);
		return [{
			id: thread.id,
			path: routePath({
				route: "thread",
				worldHandle: thread.worldHandle,
				forumHandle: thread.forumHandle,
				threadId: thread.id,
				...(parsed.commentId ? { commentId: parsed.commentId } : {}),
			}),
			type: parsed.commentId ? "comment" : "thread",
		}];
	}
	if ((parsed.route === "bot-profile" || parsed.route === "bot-avatar" || parsed.route === "bot-loop" || parsed.route === "bot-edit") && parsed.worldHandle && parsed.botHandle) {
		return resolveBotInWorld(env, parsed.worldHandle, parsed.botHandle);
	}
	if (parsed.route === "thread-ref" && parsed.threadId) {
		const threadId = parseThreadRef(parsed.threadId);
		if (!threadId) {
			return [];
		}
		const thread = await readThread(env.BICKR_KV, threadId);
		return [{ id: thread.id, path: routePath({ route: "thread", worldHandle: thread.worldHandle, forumHandle: thread.forumHandle, threadId: thread.id }), type: "thread" }];
	}
	if (parsed.route === "comment-ref" && parsed.commentId) {
		const commentId = parseCommentRef(parsed.commentId);
		if (!commentId) {
			return [];
		}
		return resolveComment(env, commentId);
	}
	const [prefix, handle] = value.split("/", 2);
	if (prefix === "u" && handle) {
		return resolveBotByHandle(env, normalizeHandle(handle));
	}
	if (prefix === "f" && handle) {
		return resolveForumByHandle(env, normalizeHandle(handle));
	}
	if (prefix === "w" && handle) {
		const worldHandle = normalizeHandle(handle);
		const world = await worldByHandle(env.BICKR_D1, worldHandle);
		return [{ id: world.id, path: `/w/${encodeURIComponent(worldHandle)}`, type: "world" }];
	}
	if (prefix === "t" && handle) {
		const threadId = parseThreadRef(value);
		return threadId ? resolveCandidates(env, `t/${threadId}`) : [];
	}
	if (prefix === "c" && handle) {
		const commentId = parseCommentRef(value);
		return commentId ? resolveComment(env, commentId) : [];
	}
	return [];
}

async function resolveBotInWorld(env: AppEnv, worldHandleText: string, botHandleText: string): Promise<RefCandidate[]> {
	const worldHandle = normalizeHandle(worldHandleText);
	const botHandle = normalizeHandle(botHandleText);
	const world = await worldByHandle(env.BICKR_D1, worldHandle);
	const row = await env.BICKR_D1.prepare(
		`SELECT bot_id AS id
		 FROM bots_index
		 WHERE home_world_id = ? AND handle = ? AND deleted_at IS NULL AND lifecycle_state = 'active'
		 LIMIT 1`,
	)
		.bind(world.id, botHandle)
		.first<{ id: string }>();
	return row ? [{ id: row.id, path: `/w/${encodeURIComponent(worldHandle)}/u/${encodeURIComponent(botHandle)}`, type: "bot" }] : [];
}

async function resolveBotByHandle(env: AppEnv, botHandle: string): Promise<RefCandidate[]> {
	const result = await env.BICKR_D1.prepare(
		`SELECT bot_id AS id, home_world_handle AS worldHandle, handle
		 FROM bots_index
		 WHERE handle = ? AND deleted_at IS NULL AND lifecycle_state = 'active'
		 ORDER BY home_world_handle ASC`,
	)
		.bind(botHandle)
		.all<{ id: string; worldHandle: string; handle: string }>();
	return (result.results ?? []).map((row) => ({
		id: row.id,
		path: `/w/${encodeURIComponent(row.worldHandle)}/u/${encodeURIComponent(row.handle)}`,
		type: "bot" as const,
	}));
}

async function resolveForumByHandle(env: AppEnv, forumHandle: string): Promise<RefCandidate[]> {
	const result = await env.BICKR_D1.prepare(
		`SELECT forum_id AS id, world_handle AS worldHandle, handle
		 FROM forums_index
		 WHERE handle = ? AND deleted_at IS NULL
		 ORDER BY world_handle ASC`,
	)
		.bind(forumHandle)
		.all<{ id: string; worldHandle: string; handle: string }>();
	return (result.results ?? []).map((row) => ({
		id: row.id,
		path: `/w/${encodeURIComponent(row.worldHandle)}/f/${encodeURIComponent(row.handle)}`,
		type: "forum" as const,
	}));
}

async function resolveComment(env: AppEnv, commentId: string): Promise<RefCandidate[]> {
	const row = await env.BICKR_D1.prepare(
		`SELECT c.comment_id AS id, c.thread_id AS threadId, t.world_handle AS worldHandle, t.forum_handle AS forumHandle
		 FROM comments_index c
		 JOIN threads_index t ON t.thread_id = c.thread_id
		 WHERE c.comment_id = ? AND c.deleted_at IS NULL AND t.deleted_at IS NULL
		 LIMIT 1`,
	)
		.bind(commentId)
		.first<{ id: string; threadId: string; worldHandle: string; forumHandle: string }>();
	return row ? [{
		id: row.id,
		path: `/w/${encodeURIComponent(row.worldHandle)}/f/${encodeURIComponent(row.forumHandle)}/t/${encodeURIComponent(row.threadId)}/c/${encodeURIComponent(row.id)}`,
		type: "comment",
	}] : [];
}
