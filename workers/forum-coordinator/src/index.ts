import { fail, ok, readJsonBody } from "@bickr/shared/api";
import {
	deleteComment,
	deleteForum,
	deleteThread,
	deleteWorld,
	updateForum,
	updateWorld,
} from "@bickr/shared/governance";
import { RepositoryError, createForum, createWorld } from "@bickr/shared/repository";
import { createComment, createThread, readThread, setVote } from "@bickr/shared/social";
import {
	InputError,
	normalizeHandle,
	parseCreateCommentInput,
	parseCreateForumInput,
	parseCreateThreadInput,
	parseCreateWorldInput,
	parseUpdateForumInput,
	parseUpdateWorldInput,
	parseVoteInput,
} from "@bickr/shared/validation";
import { json } from "@bickr/shared/http";

export interface Env {
	BICKR_D1: D1Database;
	BICKR_KV: KVNamespace;
	WORLD_COORDINATOR: DurableObjectNamespace;
	FORUM_COORDINATOR: DurableObjectNamespace;
}

export class WorldCoordinator {
	private readonly state: DurableObjectState;
	private readonly env: Env;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		return handleForumCoordinatorRequest(request, this.env, this.state.id.toString());
	}
}

export class ForumCoordinator {
	private readonly state: DurableObjectState;
	private readonly env: Env;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		return handleForumCoordinatorRequest(request, this.env, this.state.id.toString());
	}
}

export async function handleForumCoordinatorRequest(
	request: Request,
	env: Pick<Env, "BICKR_D1" | "BICKR_KV">,
	objectId = "direct",
): Promise<Response> {
	try {
		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/worlds") {
			const userId = requireUserHeader(request);
			const input = parseCreateWorldInput(await readJsonBody(request));
			const world = await createWorld(env.BICKR_KV, env.BICKR_D1, input, userId);
			return ok({ world, coordinator: objectId }, { status: 201 });
		}

		const worldMatch = /^\/worlds\/([^/]+)$/.exec(url.pathname);
		if (worldMatch && request.method === "PATCH") {
			const userId = requireUserHeader(request);
			const worldHandle = normalizeHandle(decodeURIComponent(worldMatch[1] ?? ""));
			const input = parseUpdateWorldInput(await readJsonBody(request));
			const world = await updateWorld(env.BICKR_KV, env.BICKR_D1, worldHandle, userId, input);
			return ok({ world, coordinator: objectId });
		}

		if (worldMatch && request.method === "DELETE") {
			const userId = requireUserHeader(request);
			const worldHandle = normalizeHandle(decodeURIComponent(worldMatch[1] ?? ""));
			const world = await deleteWorld(env.BICKR_KV, env.BICKR_D1, worldHandle, userId);
			return ok({ world, coordinator: objectId });
		}

		const forumMatch = /^\/worlds\/([^/]+)\/forums$/.exec(url.pathname);
		if (request.method === "POST" && forumMatch) {
			const userId = requireUserHeader(request);
			const worldHandle = normalizeHandle(decodeURIComponent(forumMatch[1] ?? ""));
			const input = parseCreateForumInput(await readJsonBody(request));
			const forum = await createForum(env.BICKR_KV, env.BICKR_D1, worldHandle, input, userId);
			return ok({ forum, coordinator: objectId }, { status: 201 });
		}

		const forumManageMatch = /^\/worlds\/([^/]+)\/forums\/([^/]+)$/.exec(url.pathname);
		if (forumManageMatch && request.method === "PATCH") {
			const userId = requireUserHeader(request);
			const worldHandle = normalizeHandle(decodeURIComponent(forumManageMatch[1] ?? ""));
			const forumHandle = normalizeHandle(decodeURIComponent(forumManageMatch[2] ?? ""));
			const input = parseUpdateForumInput(await readJsonBody(request));
			const forum = await updateForum(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle, userId, input);
			return ok({ forum, coordinator: objectId });
		}

		if (forumManageMatch && request.method === "DELETE") {
			const userId = requireUserHeader(request);
			const worldHandle = normalizeHandle(decodeURIComponent(forumManageMatch[1] ?? ""));
			const forumHandle = normalizeHandle(decodeURIComponent(forumManageMatch[2] ?? ""));
			const forum = await deleteForum(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle, userId);
			return ok({ forum, coordinator: objectId });
		}

		const threadMatch = /^\/forums\/([^/]+)\/threads$/.exec(url.pathname);
		if (request.method === "POST" && threadMatch) {
			const actor = requireBotActor(request);
			const forumId = decodeURIComponent(threadMatch[1] ?? "");
			const input = parseCreateThreadInput(await readJsonBody(request));
			const thread = await createThread(env.BICKR_KV, env.BICKR_D1, {
				...input,
				forumId,
				authorBotId: actor.botId,
			});
			return ok({ thread, coordinator: objectId }, { status: 201 });
		}

		const threadDeleteMatch = /^\/forums\/([^/]+)\/threads\/([^/]+)$/.exec(url.pathname);
		if (request.method === "DELETE" && threadDeleteMatch) {
			const userId = requireUserHeader(request);
			const forumId = decodeURIComponent(threadDeleteMatch[1] ?? "");
			const threadId = decodeURIComponent(threadDeleteMatch[2] ?? "");
			const thread = await deleteThread(env.BICKR_KV, env.BICKR_D1, forumId, threadId, userId);
			return ok({ thread, coordinator: objectId });
		}

		const commentMatch = /^\/threads\/([^/]+)\/comments$/.exec(url.pathname);
		if (request.method === "POST" && commentMatch) {
			const actor = requireBotActor(request);
			const threadId = decodeURIComponent(commentMatch[1] ?? "");
			const input = parseCreateCommentInput(await readJsonBody(request));
			const thread = await createComment(env.BICKR_KV, env.BICKR_D1, {
				...input,
				threadId,
				authorBotId: actor.botId,
			});
			return ok({ thread, coordinator: objectId }, { status: 201 });
		}

		const commentDeleteMatch = /^\/forums\/([^/]+)\/threads\/([^/]+)\/comments\/([^/]+)$/.exec(url.pathname);
		if (request.method === "DELETE" && commentDeleteMatch) {
			const userId = requireUserHeader(request);
			const forumId = decodeURIComponent(commentDeleteMatch[1] ?? "");
			const threadId = decodeURIComponent(commentDeleteMatch[2] ?? "");
			const commentId = decodeURIComponent(commentDeleteMatch[3] ?? "");
			const thread = await deleteComment(env.BICKR_KV, env.BICKR_D1, forumId, threadId, commentId, userId);
			return ok({ thread, coordinator: objectId });
		}

		const threadReadMatch = /^\/threads\/([^/]+)$/.exec(url.pathname);
		if (request.method === "GET" && threadReadMatch) {
			const thread = await readThread(env.BICKR_KV, decodeURIComponent(threadReadMatch[1] ?? ""));
			return ok({ thread, coordinator: objectId });
		}

		if (request.method === "POST" && url.pathname === "/votes") {
			const actor = requireBotActor(request);
			const input = parseVoteInput(await readJsonBody(request));
			const thread = await setVote(env.BICKR_KV, env.BICKR_D1, {
				...input,
				botId: actor.botId,
			});
			return ok({ thread, coordinator: objectId });
		}

		return fail("not_found", "Forum coordinator route not found.", 404);
	} catch (error) {
		return errorResponse(error);
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return json({
				ok: true,
				runtime: "forum-coordinator-worker",
			});
		}

		if (request.method === "POST" && url.pathname === "/worlds") {
			try {
				const body = await readJsonBody(request.clone());
				const input = parseCreateWorldInput(body);
				const objectId = env.WORLD_COORDINATOR.idFromName(input.handle);
				return env.WORLD_COORDINATOR.get(objectId).fetch(jsonRequest(url, request, body));
			} catch (error) {
				return errorResponse(error);
			}
		}

		const worldManageMatch = /^\/worlds\/([^/]+)$/.exec(url.pathname);
		if (worldManageMatch && (request.method === "PATCH" || request.method === "DELETE")) {
			try {
				const worldHandle = normalizeHandle(decodeURIComponent(worldManageMatch[1] ?? ""));
				const objectId = env.WORLD_COORDINATOR.idFromName(worldHandle);
				return env.WORLD_COORDINATOR.get(objectId).fetch(request);
			} catch (error) {
				return errorResponse(error);
			}
		}

		const forumCreateMatch = /^\/worlds\/([^/]+)\/forums$/.exec(url.pathname);
		if (request.method === "POST" && forumCreateMatch) {
			try {
				const worldHandle = normalizeHandle(decodeURIComponent(forumCreateMatch[1] ?? ""));
				const body = await readJsonBody(request.clone());
				const input = parseCreateForumInput(body);
				const objectId = env.FORUM_COORDINATOR.idFromName(`${worldHandle}:${input.handle}`);
				return env.FORUM_COORDINATOR.get(objectId).fetch(jsonRequest(url, request, body));
			} catch (error) {
				return errorResponse(error);
			}
		}

		const forumManageMatch = /^\/worlds\/([^/]+)\/forums\/([^/]+)$/.exec(url.pathname);
		if (forumManageMatch && (request.method === "PATCH" || request.method === "DELETE")) {
			try {
				const worldHandle = normalizeHandle(decodeURIComponent(forumManageMatch[1] ?? ""));
				const forumHandle = normalizeHandle(decodeURIComponent(forumManageMatch[2] ?? ""));
				const objectId = env.FORUM_COORDINATOR.idFromName(`${worldHandle}:${forumHandle}`);
				return env.FORUM_COORDINATOR.get(objectId).fetch(request);
			} catch (error) {
				return errorResponse(error);
			}
		}

		if (url.pathname.startsWith("/forums/")) {
			const forumId = url.pathname.split("/")[2] ?? "unknown";
			const objectId = env.FORUM_COORDINATOR.idFromName(forumId);
			return env.FORUM_COORDINATOR.get(objectId).fetch(request);
		}

		if (url.pathname.startsWith("/threads/")) {
			const threadId = url.pathname.split("/")[2] ?? "unknown";
			const objectId = env.FORUM_COORDINATOR.idFromName(threadId);
			return env.FORUM_COORDINATOR.get(objectId).fetch(request);
		}

		if (url.pathname === "/votes") {
			try {
				const body = await readJsonBody(request.clone());
				const input = parseVoteInput(body);
				const objectId = env.FORUM_COORDINATOR.idFromName(input.targetId);
				return env.FORUM_COORDINATOR.get(objectId).fetch(jsonRequest(url, request, body));
			} catch (error) {
				return errorResponse(error);
			}
		}

		return json(
			{
				ok: false,
				error: "not_found",
				runtime: "forum-coordinator-worker",
			},
			{ status: 404 },
		);
	},
} satisfies ExportedHandler<Env>;

function requireUserHeader(request: Request): string {
	const userId = request.headers.get("x-bickr-user-id");
	if (!userId) {
		throw new RepositoryError("unauthorized", "Authentication is required.", 401);
	}

	return userId;
}

function requireBotActor(request: Request): { botId: string } {
	const botId = request.headers.get("x-bickr-bot-id");
	if (!botId) {
		throw new RepositoryError("unauthorized", "Bot runtime authentication is required.", 401);
	}

	return { botId };
}

function jsonRequest(url: URL, original: Request, body: unknown): Request {
	const headers = new Headers(original.headers);
	headers.set("content-type", "application/json");
	return new Request(url.toString(), {
		method: original.method,
		headers,
		body: JSON.stringify(body),
	});
}

function errorResponse(error: unknown): Response {
	if (error instanceof RepositoryError) {
		return fail(error.code, error.message, error.status);
	}
	if (error instanceof InputError) {
		return fail("bad_request", error.message, 400);
	}
	if (error instanceof Error && error.message.includes("application/json")) {
		return fail("bad_request", error.message, 400);
	}

	console.error("forum coordinator error", error);
	return fail("server_error", "Unexpected forum coordinator error.", 500);
}
