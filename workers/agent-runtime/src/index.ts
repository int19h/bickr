import { fail, ok, readJsonBody } from "@bickr/shared/api";
import { json } from "@bickr/shared/http";
import { RepositoryError, createBot, deleteBot, updateBot } from "@bickr/shared/repository";
import { InputError, normalizeHandle, parseCreateBotInput, parseUpdateBotInput } from "@bickr/shared/validation";

export interface Env {
	BICKR_D1: D1Database;
	BICKR_KV: KVNamespace;
	BOT_RUNTIME: DurableObjectNamespace;
	USER_BOTS: DurableObjectNamespace;
	FORUM_COORDINATOR_SERVICE: Fetcher;
}

export class BotRuntime {
	private readonly state: DurableObjectState;

	constructor(state: DurableObjectState) {
		this.state = state;
	}

	async fetch(request: Request): Promise<Response> {
		return json({
			ok: true,
			runtime: "bot-runtime-durable-object",
			objectId: this.state.id.toString(),
			path: new URL(request.url).pathname,
		});
	}
}

export class UserBotsCoordinator {
	private readonly state: DurableObjectState;
	private readonly env: Env;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		return handleAgentRuntimeRequest(request, this.env, this.state.id.toString());
	}
}

export async function handleAgentRuntimeRequest(
	request: Request,
	env: Pick<Env, "BICKR_D1" | "BICKR_KV">,
	objectId = "direct",
): Promise<Response> {
	try {
		const url = new URL(request.url);
		const createMatch = /^\/users\/([^/]+)\/worlds\/([^/]+)\/bots$/.exec(url.pathname);
		if (request.method === "POST" && createMatch) {
			const userId = requireUserMatch(request, decodeURIComponent(createMatch[1] ?? ""));
			const worldHandle = normalizeHandle(decodeURIComponent(createMatch[2] ?? ""));
			const input = parseCreateBotInput(await readJsonBody(request));
			const bot = await createBot(env.BICKR_KV, env.BICKR_D1, worldHandle, input, userId);
			return ok({ bot, coordinator: objectId }, { status: 201 });
		}

		const botMatch = /^\/users\/([^/]+)\/bots\/([^/]+)$/.exec(url.pathname);
		if (botMatch && request.method === "PATCH") {
			const userId = requireUserMatch(request, decodeURIComponent(botMatch[1] ?? ""));
			const botId = decodeURIComponent(botMatch[2] ?? "");
			const input = parseUpdateBotInput(await readJsonBody(request));
			const bot = await updateBot(env.BICKR_KV, env.BICKR_D1, botId, userId, input);
			return ok({ bot, coordinator: objectId });
		}

		if (botMatch && request.method === "DELETE") {
			const userId = requireUserMatch(request, decodeURIComponent(botMatch[1] ?? ""));
			const botId = decodeURIComponent(botMatch[2] ?? "");
			const bot = await deleteBot(env.BICKR_KV, env.BICKR_D1, botId, userId);
			return ok({ bot, coordinator: objectId });
		}

		return fail("not_found", "Agent runtime route not found.", 404);
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
				runtime: "agent-runtime-worker",
			});
		}

		const userBotsMatch = /^\/users\/([^/]+)\/(?:worlds\/[^/]+\/bots|bots\/[^/]+)$/.exec(
			url.pathname,
		);
		if (userBotsMatch && ["POST", "PATCH", "DELETE"].includes(request.method)) {
			const userId = decodeURIComponent(userBotsMatch[1] ?? "");
			const objectId = env.USER_BOTS.idFromName(userId);
			return env.USER_BOTS.get(objectId).fetch(request);
		}

		if (url.pathname.startsWith("/bots/")) {
			const botId = url.pathname.split("/")[2] ?? "unknown";
			const objectId = env.BOT_RUNTIME.idFromName(botId);
			return env.BOT_RUNTIME.get(objectId).fetch(request);
		}

		return json(
			{
				ok: false,
				error: "not_found",
				runtime: "agent-runtime-worker",
			},
			{ status: 404 },
		);
	},

	async scheduled(event) {
		console.log("agent-runtime scheduled tick scan", {
			cron: event.cron,
			scheduledTime: event.scheduledTime,
		});
	},
} satisfies ExportedHandler<Env>;

function requireUserMatch(request: Request, pathUserId: string): string {
	const headerUserId = request.headers.get("x-bickr-user-id");
	if (!headerUserId || headerUserId !== pathUserId) {
		throw new RepositoryError("unauthorized", "Authentication is required.", 401);
	}

	return headerUserId;
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

	console.error("agent runtime error", error);
	return fail("server_error", "Unexpected agent runtime error.", 500);
}
