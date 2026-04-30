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
import { type ThreadDocument } from "@bickr/shared/model";
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

type CoordinatorContext = {
	cache?: ThreadFreshCacheRef;
	objectId: string;
	storage?: DurableObjectStorage;
};

type ThreadFreshCacheEntry = {
	expiresAt: string;
	thread: ThreadDocument;
	writtenAt: string;
};

type ThreadFreshCacheRef = {
	entry: ThreadFreshCacheEntry | null;
};

const threadFreshCacheStorageKey = "thread-fresh-cache";
const threadFreshCacheTtlMs = 5 * 60 * 1000;

export class WorldCoordinator {
	private readonly state: DurableObjectState;
	private readonly env: Env;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		return handleForumCoordinatorRequest(request, this.env, {
			objectId: this.state.id.toString(),
			storage: this.state.storage,
		});
	}
}

export class ForumCoordinator {
	private readonly state: DurableObjectState;
	private readonly env: Env;
	private readonly threadFreshCache: ThreadFreshCacheRef = { entry: null };

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		return handleForumCoordinatorRequest(request, this.env, {
			cache: this.threadFreshCache,
			objectId: this.state.id.toString(),
			storage: this.state.storage,
		});
	}
}

export async function handleForumCoordinatorRequest(
	request: Request,
	env: Pick<Env, "BICKR_D1" | "BICKR_KV">,
	context: CoordinatorContext | string = "direct",
): Promise<Response> {
	const coordinator = typeof context === "string" ? { objectId: context } : context;
	try {
		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/worlds") {
			const userId = requireUserHeader(request);
			const input = parseCreateWorldInput(await readJsonBody(request));
			const world = await createWorld(env.BICKR_KV, env.BICKR_D1, input, userId);
			return ok({ world, coordinator: coordinator.objectId }, { status: 201 });
		}

		const worldMatch = /^\/worlds\/([^/]+)$/.exec(url.pathname);
		if (worldMatch && request.method === "PATCH") {
			const userId = requireUserHeader(request);
			const worldHandle = normalizeHandle(decodeURIComponent(worldMatch[1] ?? ""));
			const input = parseUpdateWorldInput(await readJsonBody(request));
			const world = await updateWorld(env.BICKR_KV, env.BICKR_D1, worldHandle, userId, input);
			return ok({ world, coordinator: coordinator.objectId });
		}

		if (worldMatch && request.method === "DELETE") {
			const userId = requireUserHeader(request);
			const worldHandle = normalizeHandle(decodeURIComponent(worldMatch[1] ?? ""));
			const world = await deleteWorld(env.BICKR_KV, env.BICKR_D1, worldHandle, userId);
			return ok({ world, coordinator: coordinator.objectId });
		}

		const forumMatch = /^\/worlds\/([^/]+)\/forums$/.exec(url.pathname);
		if (request.method === "POST" && forumMatch) {
			const userId = requireUserHeader(request);
			const worldHandle = normalizeHandle(decodeURIComponent(forumMatch[1] ?? ""));
			const input = parseCreateForumInput(await readJsonBody(request));
			const forum = await createForum(env.BICKR_KV, env.BICKR_D1, worldHandle, input, userId);
			return ok({ forum, coordinator: coordinator.objectId }, { status: 201 });
		}

		const forumManageMatch = /^\/worlds\/([^/]+)\/forums\/([^/]+)$/.exec(url.pathname);
		if (forumManageMatch && request.method === "PATCH") {
			const userId = requireUserHeader(request);
			const worldHandle = normalizeHandle(decodeURIComponent(forumManageMatch[1] ?? ""));
			const forumHandle = normalizeHandle(decodeURIComponent(forumManageMatch[2] ?? ""));
			const input = parseUpdateForumInput(await readJsonBody(request));
			const forum = await updateForum(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle, userId, input);
			return ok({ forum, coordinator: coordinator.objectId });
		}

		if (forumManageMatch && request.method === "DELETE") {
			const userId = requireUserHeader(request);
			const worldHandle = normalizeHandle(decodeURIComponent(forumManageMatch[1] ?? ""));
			const forumHandle = normalizeHandle(decodeURIComponent(forumManageMatch[2] ?? ""));
			const forum = await deleteForum(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle, userId);
			return ok({ forum, coordinator: coordinator.objectId });
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
			return ok({ thread, coordinator: coordinator.objectId }, { status: 201 });
		}

		const threadDeleteMatch = /^\/forums\/([^/]+)\/threads\/([^/]+)$/.exec(url.pathname);
		if (request.method === "DELETE" && threadDeleteMatch) {
			const userId = requireUserHeader(request);
			const forumId = decodeURIComponent(threadDeleteMatch[1] ?? "");
			const threadId = decodeURIComponent(threadDeleteMatch[2] ?? "");
			const latestThread = await readFreshThread(coordinator, threadId);
			const thread = await deleteThread(env.BICKR_KV, env.BICKR_D1, forumId, threadId, userId, undefined, {
				...(latestThread ? { thread: latestThread } : {}),
			});
			await writeFreshThread(coordinator, thread);
			return ok({ thread, coordinator: coordinator.objectId });
		}

		const commentMatch = /^\/threads\/([^/]+)\/comments$/.exec(url.pathname);
		if (request.method === "POST" && commentMatch) {
			const actor = requireBotActor(request);
			const threadId = decodeURIComponent(commentMatch[1] ?? "");
			const input = parseCreateCommentInput(await readJsonBody(request));
			const latestThread = await readFreshThread(coordinator, threadId);
			const thread = await createComment(env.BICKR_KV, env.BICKR_D1, {
				...input,
				threadId,
				authorBotId: actor.botId,
			}, undefined, {
				...(latestThread ? { thread: latestThread } : {}),
			});
			await writeFreshThread(coordinator, thread);
			return ok({ thread, coordinator: coordinator.objectId }, { status: 201 });
		}

		const commentDeleteMatch = /^\/forums\/([^/]+)\/threads\/([^/]+)\/comments\/([^/]+)$/.exec(url.pathname);
		if (request.method === "DELETE" && commentDeleteMatch) {
			const userId = requireUserHeader(request);
			const forumId = decodeURIComponent(commentDeleteMatch[1] ?? "");
			const threadId = decodeURIComponent(commentDeleteMatch[2] ?? "");
			const commentId = decodeURIComponent(commentDeleteMatch[3] ?? "");
			const latestThread = await readFreshThread(coordinator, threadId);
			const thread = await deleteComment(env.BICKR_KV, env.BICKR_D1, forumId, threadId, commentId, userId, undefined, {
				...(latestThread ? { thread: latestThread } : {}),
			});
			await writeFreshThread(coordinator, thread);
			return ok({ thread, coordinator: coordinator.objectId });
		}

		const threadReadMatch = /^\/threads\/([^/]+)$/.exec(url.pathname);
		if (request.method === "GET" && threadReadMatch) {
			const threadId = decodeURIComponent(threadReadMatch[1] ?? "");
			const thread = await readFreshThread(coordinator, threadId) ?? await readThread(env.BICKR_KV, threadId);
			return ok({ thread, coordinator: coordinator.objectId });
		}

		if (request.method === "POST" && url.pathname === "/votes") {
			const actor = requireBotActor(request);
			const input = parseVoteInput(await readJsonBody(request));
			const threadId = request.headers.get("x-bickr-thread-id");
			const latestThread = threadId ? await readFreshThread(coordinator, threadId) : null;
			const thread = await setVote(env.BICKR_KV, env.BICKR_D1, {
				...input,
				botId: actor.botId,
			}, undefined, {
				...(latestThread ? { thread: latestThread } : {}),
			});
			await writeFreshThread(coordinator, thread);
			return ok({ thread, coordinator: coordinator.objectId });
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
			const threadMutationMatch = /^\/forums\/[^/]+\/threads\/([^/]+)(?:\/comments\/[^/]+)?$/.exec(url.pathname);
			if (threadMutationMatch && request.method === "DELETE") {
				const threadId = decodeURIComponent(threadMutationMatch[1] ?? "");
				const objectId = env.FORUM_COORDINATOR.idFromName(threadId);
				return env.FORUM_COORDINATOR.get(objectId).fetch(request);
			}
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
				const threadId = await voteCoordinatorName(env.BICKR_D1, input);
				const objectId = env.FORUM_COORDINATOR.idFromName(threadId);
				const forwarded = jsonRequest(url, request, body);
				forwarded.headers.set("x-bickr-thread-id", threadId);
				return env.FORUM_COORDINATOR.get(objectId).fetch(forwarded);
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

async function readFreshThread(
	context: CoordinatorContext,
	threadId: string,
): Promise<ThreadDocument | null> {
	const memoryEntry = freshCacheEntryForThread(context.cache?.entry ?? null, threadId, Date.now());
	if (memoryEntry) {
		if (memoryEntry.thread.deletedAt) {
			throw new RepositoryError("not_found", "Thread not found.", 404);
		}
		return memoryEntry.thread;
	}

	if (context.cache?.entry) {
		context.cache.entry = null;
	}

	const storedEntry = await context.storage?.get<ThreadFreshCacheEntry>(threadFreshCacheStorageKey);
	const validStoredEntry = freshCacheEntryForThread(storedEntry ?? null, threadId, Date.now());
	if (!validStoredEntry) {
		if (storedEntry) {
			await context.storage?.delete(threadFreshCacheStorageKey);
		}
		return null;
	}

	if (context.cache) {
		context.cache.entry = validStoredEntry;
	}
	if (validStoredEntry.thread.deletedAt) {
		throw new RepositoryError("not_found", "Thread not found.", 404);
	}
	return validStoredEntry.thread;
}

async function writeFreshThread(
	context: CoordinatorContext,
	thread: ThreadDocument,
): Promise<void> {
	const now = Date.now();
	const entry: ThreadFreshCacheEntry = {
		expiresAt: new Date(now + threadFreshCacheTtlMs).toISOString(),
		thread,
		writtenAt: new Date(now).toISOString(),
	};
	if (context.cache) {
		context.cache.entry = entry;
	}
	await context.storage?.put(threadFreshCacheStorageKey, entry);
}

function freshCacheEntryForThread(
	entry: ThreadFreshCacheEntry | null,
	threadId: string,
	nowMs: number,
): ThreadFreshCacheEntry | null {
	if (!entry || entry.thread.id !== threadId || Date.parse(entry.expiresAt) <= nowMs) {
		return null;
	}
	return entry;
}

async function voteCoordinatorName(
	db: D1Database,
	input: { targetType: "thread" | "comment"; targetId: string },
): Promise<string> {
	if (input.targetType === "thread") {
		return input.targetId;
	}
	const row = await db
		.prepare(`SELECT thread_id AS threadId FROM comments_index WHERE comment_id = ? AND deleted_at IS NULL`)
		.bind(input.targetId)
		.first<{ threadId: string }>();
	return row?.threadId ?? input.targetId;
}

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
