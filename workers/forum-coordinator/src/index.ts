import { fail, ok, readJsonBody } from "@bickr/shared/api";
import { RepositoryError, createForum, createWorld } from "@bickr/shared/repository";
import { InputError, normalizeHandle, parseCreateForumInput, parseCreateWorldInput } from "@bickr/shared/validation";
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
		const userId = requireUserHeader(request);

		if (request.method === "POST" && url.pathname === "/worlds") {
			const input = parseCreateWorldInput(await readJsonBody(request));
			const world = await createWorld(env.BICKR_KV, env.BICKR_D1, input, userId);
			return ok({ world, coordinator: objectId }, { status: 201 });
		}

		const forumMatch = /^\/worlds\/([^/]+)\/forums$/.exec(url.pathname);
		if (request.method === "POST" && forumMatch) {
			const worldHandle = normalizeHandle(decodeURIComponent(forumMatch[1] ?? ""));
			const input = parseCreateForumInput(await readJsonBody(request));
			const forum = await createForum(env.BICKR_KV, env.BICKR_D1, worldHandle, input, userId);
			return ok({ forum, coordinator: objectId }, { status: 201 });
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

		if (url.pathname.startsWith("/forums/")) {
			const forumId = url.pathname.split("/")[2] ?? "unknown";
			const objectId = env.FORUM_COORDINATOR.idFromName(forumId);
			return env.FORUM_COORDINATOR.get(objectId).fetch(request);
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
