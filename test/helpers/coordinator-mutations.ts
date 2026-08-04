import { ExclusiveOperationQueue } from "@bickr/shared/exclusive-operation-queue";
import { addInternalServiceAuthHeader, internalServiceUrl } from "@bickr/shared/internal-service";
import type {
	BotSummary,
	CreateBotInput,
	CreateWorldInput,
	UpdateBotInput,
	UpdateUserProfileInput,
	UpdateWorldInput,
	UserDocument,
	UserProfile,
	WorldSummary,
} from "@bickr/shared/model";
import { RepositoryError, type ProviderUserProfile } from "@bickr/shared/repository";
import type { D1DatabaseLike, KVNamespaceLike } from "@bickr/shared/storage";
import agentRuntimeWorker, { handleAgentRuntimeRequest } from "../../workers/agent-runtime/src/routes";
import { handleForumCoordinatorRequest } from "../../workers/forum-coordinator/src/index";

type MutationEnv = {
	BICKR_D1: D1DatabaseLike;
	BICKR_KV: KVNamespaceLike;
};

export async function upsertProviderUser(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	profile: ProviderUserProfile,
	_legacyNow?: string,
): Promise<UserDocument> {
	const data = await accountBootstrapMutation({ BICKR_D1: db, BICKR_KV: kv }, profile);
	return requiredObject<UserDocument>(data.user, "user");
}

async function accountBootstrapMutation(
	env: MutationEnv,
	profile: ProviderUserProfile,
): Promise<Record<string, unknown>> {
	const internalSecret = "test-coordinator-internal-secret";
	const queues = new Map<string, ExclusiveOperationQueue>();
	let workerEnv: Record<string, unknown>;
	const forumService = {
		fetch: (request: Request) => handleForumCoordinatorRequest(request, env as never, {
			objectId: "test-world-coordinator",
			queue: new ExclusiveOperationQueue(),
		}),
	};
	const userBots = {
		idFromName: (name: string) => name,
		get: (userId: string) => ({
			fetch: (request: Request) => handleAgentRuntimeRequest(request, workerEnv as never, {
				objectId: userId,
				ownerUserId: userId,
				queue: queues.get(userId) ?? (() => {
					const queue = new ExclusiveOperationQueue();
					queues.set(userId, queue);
					return queue;
				})(),
			}),
		}),
	};
	workerEnv = {
		...env,
		FORUM_COORDINATOR_SERVICE: forumService,
		INTERNAL_SERVICE_SECRET: internalSecret,
		USER_BOTS: userBots,
		BOT_RUNTIME: {
			idFromName: (name: string) => name,
			get: () => ({ fetch: () => Promise.resolve(new Response(null, { status: 404 })) }),
		},
	};
	const headers = new Headers({
		"content-type": "application/json",
		"idempotency-key": `test-account:${crypto.randomUUID()}`,
	});
	addInternalServiceAuthHeader(headers, internalSecret);
	const response = await agentRuntimeWorker.fetch(new Request(internalServiceUrl("/accounts/bootstrap"), {
		method: "POST",
		headers,
		body: JSON.stringify(profile),
	}) as never, workerEnv as never);
	return coordinatorPayload(response);
}

export async function updateUserProfile(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
	input: UpdateUserProfileInput,
): Promise<UserProfile> {
	const wireInput = input.displayName === undefined ? input : {
		...input,
		language: input.displayName.lang ?? input.language ?? "en",
		displayName: input.displayName.text,
	};
	const data = await userCoordinatorMutation({ BICKR_D1: db, BICKR_KV: kv }, userId, "/profile", "PATCH", wireInput);
	return requiredObject<UserProfile>(data.profile, "profile");
}

export async function createWorld(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	input: CreateWorldInput,
	userId: string,
	_legacyNow?: string,
): Promise<WorldSummary> {
	const data = await userCoordinatorMutation({ BICKR_D1: db, BICKR_KV: kv }, userId, "/worlds", "POST", input, {
		"idempotency-key": `test-world:${crypto.randomUUID()}`,
	});
	return requiredObject<WorldSummary>(data.world, "world");
}

export async function updateWorld(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	userId: string,
	input: UpdateWorldInput,
): Promise<WorldSummary> {
	const data = await userCoordinatorMutation(
		{ BICKR_D1: db, BICKR_KV: kv },
		userId,
		`/worlds/${encodeURIComponent(worldHandle)}`,
		"PATCH",
		input,
	);
	return requiredObject<WorldSummary>(data.world, "world");
}

export async function deleteWorld(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	userId: string,
	_legacyNow?: string,
): Promise<WorldSummary> {
	const data = await userCoordinatorMutation(
		{ BICKR_D1: db, BICKR_KV: kv },
		userId,
		`/worlds/${encodeURIComponent(worldHandle)}`,
		"DELETE",
		undefined,
		{ "idempotency-key": `test-world-delete:${userId}:${worldHandle}` },
	);
	return requiredObject<WorldSummary>(data.world, "world");
}

export async function createBot(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	input: CreateBotInput,
	userId: string,
	_legacyOptions?: unknown,
): Promise<BotSummary> {
	const data = await userCoordinatorMutation(
		{ BICKR_D1: db, BICKR_KV: kv },
		userId,
		`/worlds/${encodeURIComponent(worldHandle)}/bots`,
		"POST",
		input,
		{ "idempotency-key": `test-bot:${crypto.randomUUID()}` },
	);
	return requiredObject<BotSummary>(data.bot, "bot");
}

export async function updateBot(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	userId: string,
	input: UpdateBotInput,
	_legacyNow?: string,
): Promise<BotSummary> {
	const data = await userCoordinatorMutation({ BICKR_D1: db, BICKR_KV: kv }, userId, `/bots/${encodeURIComponent(botId)}`, "PATCH", input);
	return requiredObject<BotSummary>(data.bot, "bot");
}

export async function deleteBot(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	userId: string,
	_legacyOptions?: unknown,
): Promise<BotSummary> {
	const data = await userCoordinatorMutation(
		{ BICKR_D1: db, BICKR_KV: kv },
		userId,
		`/bots/${encodeURIComponent(botId)}`,
		"DELETE",
		undefined,
		{ "idempotency-key": `test-bot-delete:${userId}:${botId}` },
	);
	return requiredObject<BotSummary>(data.bot, "bot");
}

export async function userCoordinatorMutation(
	env: MutationEnv,
	userId: string,
	path: string,
	method: string,
	body?: unknown,
	extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
	const forumQueue = new ExclusiveOperationQueue();
	const forumService = {
		fetch: (request: Request) => handleForumCoordinatorRequest(request, env as never, {
			objectId: "test-world-coordinator",
			queue: forumQueue,
		}),
	};
	const headers = new Headers({ "x-bickr-user-id": userId, ...extraHeaders });
	if (body !== undefined) {
		headers.set("content-type", "application/json");
	}
	const response = await handleAgentRuntimeRequest(new Request(
		`https://agent.internal/users/${encodeURIComponent(userId)}${path}`,
		{ method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
	), {
		...env,
		FORUM_COORDINATOR_SERVICE: forumService,
	} as never, {
		objectId: "test-user-coordinator",
		ownerUserId: userId,
		queue: new ExclusiveOperationQueue(),
	});
	return coordinatorPayload(response);
}

async function coordinatorPayload(response: Response): Promise<Record<string, unknown>> {
	const payload: unknown = await response.json();
	const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
	if (!response.ok || record.ok !== true) {
		const code = typeof record.error === "string" && ["bad_request", "conflict", "forbidden", "not_found", "server_error", "unauthorized"].includes(record.error)
			? record.error as RepositoryError["code"]
			: "server_error";
		throw new RepositoryError(code, typeof record.message === "string" ? record.message : "Coordinator mutation failed.", response.status || 500);
	}
	return record.data && typeof record.data === "object" && !Array.isArray(record.data)
		? record.data as Record<string, unknown>
		: {};
}

function requiredObject<T>(value: unknown, label: string): T {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RepositoryError("server_error", `Coordinator returned an invalid ${label}.`, 500);
	}
	return value as T;
}
