import { fail, ok, readJsonBody } from "@bickr/shared/api";
import { isD1UniqueConstraintError } from "@bickr/shared/d1-errors";
import {
	deleteComment,
	deleteForum,
	deleteThread,
	deleteWorld,
	updateForum,
	updateWorld,
} from "@bickr/shared/governance";
import { RepositoryError, createForum, createWorld, listForums } from "@bickr/shared/repository";
import { deleteSearchVector, upsertForumSearchVector, upsertWorldSearchVector } from "@bickr/shared/search";
import {
	createComment,
	createThread,
	normalizeThreadDefaults,
	pruneExpiredBotSeenContent,
	pruneExpiredNotifications,
	readThread,
	refreshThreadHotScores,
	setVote,
} from "@bickr/shared/social";
import { pruneBotInferenceUsage } from "@bickr/shared/token-spend";
import { type ThreadDocument } from "@bickr/shared/model";
import {
	addInternalServiceAuthHeader,
	type InternalServiceAuthEnv,
	internalServiceUrl,
	isTrustedInternalServiceRequest,
} from "@bickr/shared/internal-service";
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
import { repairObjectIndexes } from "@bickr/shared/index-repair";
import {
	kvNormalizationEntityTypes,
	kvNormalizationSweepMaxRowsPerRun,
	kvNormalizationSweepMaxWritesPerRun,
	isThreadNormalizationOutcome,
	isWithinKvNormalizationQuietPeriod,
	normalizeKvDocuments,
	type KvNormalizationEntityType,
	type ThreadNormalizationOutcome,
	type ThreadNormalizationRequest,
} from "@bickr/shared/kv-normalization-sweep";
import { kvKeys, readJson, writeJson } from "@bickr/shared/storage";

export interface Env {
	BICKR_D1: D1Database;
	BICKR_KV: KVNamespace;
	AI?: Ai;
	BICKR_SEARCH_VECTORIZE?: Vectorize;
	INTERNAL_SERVICE_SECRET?: string;
	WORLD_COORDINATOR: DurableObjectNamespace;
	FORUM_COORDINATOR: DurableObjectNamespace;
}

type ForumCoordinatorEnv = Pick<Env, "AI" | "BICKR_D1" | "BICKR_KV" | "BICKR_SEARCH_VECTORIZE">;

type CoordinatorContext = {
	cache?: ThreadFreshCacheRef;
	objectId: string;
	queue?: ExclusiveOperationQueue;
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

export class ExclusiveOperationQueue {
	private pending: Promise<void> = Promise.resolve();

	async run<T>(operation: () => Promise<T>): Promise<T> {
		const ready = this.pending;
		let release: () => void = () => {};
		this.pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		await ready;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

export class WorldCoordinator {
	private readonly state: DurableObjectState;
	private readonly env: Env;
	private readonly queue = new ExclusiveOperationQueue();

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		if (!isTrustedInternalServiceRequest(request, this.env.INTERNAL_SERVICE_SECRET)) {
			return forumCoordinatorNotFoundResponse();
		}
		return handleForumCoordinatorRequest(request, this.env, {
			objectId: this.state.id.toString(),
			queue: this.queue,
			storage: this.state.storage,
		});
	}
}

export class ForumCoordinator {
	private readonly state: DurableObjectState;
	private readonly env: Env;
	private readonly queue = new ExclusiveOperationQueue();
	private readonly threadFreshCache: ThreadFreshCacheRef = { entry: null };

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		if (!isTrustedInternalServiceRequest(request, this.env.INTERNAL_SERVICE_SECRET)) {
			return forumCoordinatorNotFoundResponse();
		}
		return handleForumCoordinatorRequest(request, this.env, {
			cache: this.threadFreshCache,
			objectId: this.state.id.toString(),
			queue: this.queue,
			storage: this.state.storage,
		});
	}
}

export async function handleForumCoordinatorRequest(
	request: Request,
	env: ForumCoordinatorEnv,
	context: CoordinatorContext | string = "direct",
): Promise<Response> {
	const coordinator: CoordinatorContext = typeof context === "string" ? { objectId: context } : context;
	const operation = () => handleForumCoordinatorRequestExclusive(request, env, coordinator);
	return coordinator.queue ? coordinator.queue.run(operation) : operation();
}

async function handleForumCoordinatorRequestExclusive(
	request: Request,
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
): Promise<Response> {
	try {
		const url = new URL(request.url);
		const response =
			await handleWorldCoordinatorMutation(request, env, coordinator, url) ??
			await handleForumCoordinatorMutation(request, env, coordinator, url) ??
			await handleThreadCoordinatorMutation(request, env, coordinator, url) ??
			await handleCommentCoordinatorMutation(request, env, coordinator, url) ??
			await handleThreadCoordinatorRead(request, env, coordinator, url) ??
			await handleVoteCoordinatorMutation(request, env, coordinator, url);
		if (response) {
			return response;
		}

		return fail("not_found", "Forum coordinator route not found.", 404);
	} catch (error) {
		return errorResponse(error);
	}
}

async function handleWorldCoordinatorMutation(
	request: Request,
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
	url: URL,
): Promise<Response | null> {
	if (request.method === "POST" && url.pathname === "/worlds") {
		const userId = requireUserHeader(request);
		const input = parseCreateWorldInput(await readJsonBody(request));
		const world = await createWorld(env.BICKR_KV, env.BICKR_D1, input, userId);
		await upsertWorldSearchVector(env, world);
		await Promise.all((await listForums(env.BICKR_D1, world.handle)).map((forum) => upsertForumSearchVector(env, forum)));
		return ok({ world, coordinator: coordinator.objectId }, { status: 201 });
	}

	const worldMatch = /^\/worlds\/([^/]+)$/.exec(url.pathname);
	if (!worldMatch || (request.method !== "PATCH" && request.method !== "DELETE")) {
		return null;
	}
	const userId = requireUserHeader(request);
	const worldHandle = normalizeHandle(decodeURIComponent(worldMatch[1] ?? ""));
	if (request.method === "PATCH") {
		const input = parseUpdateWorldInput(await readJsonBody(request));
		const world = await updateWorld(env.BICKR_KV, env.BICKR_D1, worldHandle, userId, input);
		await upsertWorldSearchVector(env, world);
		return ok({ world, coordinator: coordinator.objectId });
	}
	if (request.method === "DELETE") {
		const world = await deleteWorld(env.BICKR_KV, env.BICKR_D1, worldHandle, userId);
		await deleteSearchVector(env, "world", world.id);
		return ok({ world, coordinator: coordinator.objectId });
	}
	return null;
}

async function handleForumCoordinatorMutation(
	request: Request,
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
	url: URL,
): Promise<Response | null> {
	const forumCreateMatch = /^\/worlds\/([^/]+)\/forums$/.exec(url.pathname);
	if (request.method === "POST" && forumCreateMatch) {
		const userId = requireUserHeader(request);
		const worldHandle = normalizeHandle(decodeURIComponent(forumCreateMatch[1] ?? ""));
		const input = parseCreateForumInput(await readJsonBody(request));
		const forum = await createForum(env.BICKR_KV, env.BICKR_D1, worldHandle, input, userId);
		await upsertForumSearchVector(env, forum);
		return ok({ forum, coordinator: coordinator.objectId }, { status: 201 });
	}

	const forumManageMatch = /^\/worlds\/([^/]+)\/forums\/([^/]+)$/.exec(url.pathname);
	if (!forumManageMatch || (request.method !== "PATCH" && request.method !== "DELETE")) {
		return null;
	}
	const userId = requireUserHeader(request);
	const worldHandle = normalizeHandle(decodeURIComponent(forumManageMatch[1] ?? ""));
	const forumHandle = normalizeHandle(decodeURIComponent(forumManageMatch[2] ?? ""));
	if (request.method === "PATCH") {
		const input = parseUpdateForumInput(await readJsonBody(request));
		const forum = await updateForum(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle, userId, input);
		await upsertForumSearchVector(env, forum);
		return ok({ forum, coordinator: coordinator.objectId });
	}
	if (request.method === "DELETE") {
		const forum = await deleteForum(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle, userId);
		await deleteSearchVector(env, "forum", forum.id);
		return ok({ forum, coordinator: coordinator.objectId });
	}
	return null;
}

async function handleThreadCoordinatorMutation(
	request: Request,
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
	url: URL,
): Promise<Response | null> {
	const threadNormalizeMatch = /^\/threads\/([^/]+)\/normalize$/.exec(url.pathname);
	if (request.method === "POST" && threadNormalizeMatch) {
		const threadId = decodeURIComponent(threadNormalizeMatch[1] ?? "");
		const input = parseThreadNormalizationRequest(await readJsonBody(request), threadId);
		const normalization = await normalizeThreadThroughCoordinator(env, coordinator, input);
		return ok({ normalization, coordinator: coordinator.objectId });
	}

	const threadCreateMatch = /^\/forums\/([^/]+)\/threads$/.exec(url.pathname);
	if (request.method === "POST" && threadCreateMatch) {
		const actor = requireBotActor(request);
		const forumId = decodeURIComponent(threadCreateMatch[1] ?? "");
		const input = parseCreateThreadInput(await readJsonBody(request));
		const thread = await createThread(env.BICKR_KV, env.BICKR_D1, {
			...input,
			forumId,
			authorBotId: actor.botId,
		});
		return ok({ thread, coordinator: coordinator.objectId }, { status: 201 });
	}

	const threadDeleteMatch = /^\/forums\/([^/]+)\/threads\/([^/]+)$/.exec(url.pathname);
	if (request.method !== "DELETE" || !threadDeleteMatch) {
		return null;
	}
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

async function handleCommentCoordinatorMutation(
	request: Request,
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
	url: URL,
): Promise<Response | null> {
	const commentCreateMatch = /^\/threads\/([^/]+)\/comments$/.exec(url.pathname);
	if (request.method === "POST" && commentCreateMatch) {
		const actor = requireBotActor(request);
		const threadId = decodeURIComponent(commentCreateMatch[1] ?? "");
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

	const commentReplyMatch = /^\/comments\/([^/]+)\/replies$/.exec(url.pathname);
	if (request.method === "POST" && commentReplyMatch) {
		return createCommentReply(request, env, coordinator, decodeURIComponent(commentReplyMatch[1] ?? ""));
	}

	const commentDeleteMatch = /^\/forums\/([^/]+)\/threads\/([^/]+)\/comments\/([^/]+)$/.exec(url.pathname);
	if (request.method !== "DELETE" || !commentDeleteMatch) {
		return null;
	}
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

async function createCommentReply(
	request: Request,
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
	parentCommentId: string,
): Promise<Response> {
	const actor = requireBotActor(request);
	const input = parseCreateCommentInput(await readJsonBody(request));
	const row = await env.BICKR_D1.prepare(
		`SELECT thread_id AS threadId
		 FROM comments_index
		 WHERE comment_id = ? AND deleted_at IS NULL
		 LIMIT 1`,
	)
		.bind(parentCommentId)
		.first<{ threadId: string }>();
	if (!row) {
		throw new RepositoryError("not_found", "Parent comment not found.", 404);
	}
	const latestThread = await readFreshThread(coordinator, row.threadId);
	const thread = await createComment(env.BICKR_KV, env.BICKR_D1, {
		...input,
		threadId: row.threadId,
		parentCommentId,
		authorBotId: actor.botId,
	}, undefined, {
		...(latestThread ? { thread: latestThread } : {}),
	});
	await writeFreshThread(coordinator, thread);
	return ok({ thread, coordinator: coordinator.objectId }, { status: 201 });
}

async function handleThreadCoordinatorRead(
	request: Request,
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
	url: URL,
): Promise<Response | null> {
	const threadReadMatch = /^\/threads\/([^/]+)$/.exec(url.pathname);
	if (request.method !== "GET" || !threadReadMatch) {
		return null;
	}
	const threadId = decodeURIComponent(threadReadMatch[1] ?? "");
	const thread = await readFreshThread(coordinator, threadId) ?? await readThread(env.BICKR_KV, threadId);
	return ok({ thread, coordinator: coordinator.objectId });
}

async function handleVoteCoordinatorMutation(
	request: Request,
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
	url: URL,
): Promise<Response | null> {
	if (request.method !== "POST" || url.pathname !== "/votes") {
		return null;
	}
	const actor = requireBotActor(request);
	const body = await readJsonBody(request);
	const input = parseVoteInput(body);
	const spotlightId = spotlightIdFromRequestBody(body);
	const threadId = request.headers.get("x-bickr-thread-id");
	const latestThread = threadId ? await readFreshThread(coordinator, threadId) : null;
	const thread = await setVote(env.BICKR_KV, env.BICKR_D1, {
		...input,
		botId: actor.botId,
	}, undefined, {
		...(latestThread ? { thread: latestThread } : {}),
		...(spotlightId ? { spotlightId } : {}),
	});
	await writeFreshThread(coordinator, thread);
	return ok({ thread, coordinator: coordinator.objectId });
}

function spotlightIdFromRequestBody(body: unknown): string | undefined {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return undefined;
	}
	const value = (body as Record<string, unknown>).spotlightId;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export default {
	async fetch(request, env) {
		try {
			return await handleForumWorkerFetch(request, env);
		} catch (error) {
			return errorResponse(error);
		}
	},

	async scheduled(event, env, ctx) {
		const now = new Date(event.scheduledTime).toISOString();
		ctx.waitUntil(runDailyForumCoordinatorMaintenance(env, now));
	},
} satisfies ExportedHandler<Env>;

async function runDailyForumCoordinatorMaintenance(env: Env, now: string): Promise<void> {
	const [hotScores, notificationPrune, botSeenContentPrune, inferenceUsagePrune, indexRepair] = await Promise.allSettled([
		refreshThreadHotScores(env.BICKR_D1, now),
		pruneExpiredNotifications(env.BICKR_KV, env.BICKR_D1, { now }),
		pruneExpiredBotSeenContent(env.BICKR_D1, { now }),
		pruneBotInferenceUsage(env.BICKR_D1, new Date(now)),
		repairObjectIndexes(env),
	]);
	// Log unconditionally and before failures propagate: the 2026-07-11 run
	// deleted ~8k rows but left no log because a sibling Promise.all task
	// rejected ahead of the conditional log line.
	console.log(JSON.stringify({
		event: "retention_prune",
		hotScores: settledMaintenanceResult(hotScores, () => ({ recentCommentCountsRefreshed: true })),
		notificationPrune: settledMaintenanceResult(notificationPrune, (value) => value),
		botSeenContentPrune: settledMaintenanceResult(botSeenContentPrune, (value) => value),
		inferenceUsagePrune: settledMaintenanceResult(inferenceUsagePrune, (value) => value),
		indexRepair: settledMaintenanceResult(indexRepair, (value) => value),
	}));
	const failure = [hotScores, notificationPrune, botSeenContentPrune, inferenceUsagePrune, indexRepair]
		.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failure) {
		throw failure.reason;
	}
}

function settledMaintenanceResult<T, R>(
	result: PromiseSettledResult<T>,
	value: (result: T) => R,
): R | { error: string } {
	return result.status === "fulfilled" ? value(result.value) : { error: String(result.reason) };
}

async function handleForumWorkerFetch(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (!isTrustedInternalServiceRequest(request, env.INTERNAL_SERVICE_SECRET)) {
		return forumCoordinatorNotFoundResponse();
	}

	if (url.pathname === "/health") {
		return json({
			ok: true,
			runtime: "forum-coordinator-worker",
		});
	}

	if (request.method === "POST" && url.pathname === "/maintenance/kv-normalize-sweep") {
		const input = parseKvNormalizationSweepInput(await readJsonBody(request));
		const sweepEnv = {
			...env,
			normalizeThread: (normalizationRequest: ThreadNormalizationRequest) =>
				requestThreadNormalization(env, normalizationRequest),
		};
		return json(await normalizeKvDocuments(sweepEnv, input.entityType, input.options));
	}

	const response =
		await routeWorldCoordinatorRequest(request, env, url) ??
		await routeForumCoordinatorRequest(request, env, url) ??
		await routeThreadCoordinatorRequest(request, env, url) ??
		await routeCommentCoordinatorRequest(request, env, url) ??
		await routeVoteCoordinatorRequest(request, env, url);
	return response ?? forumCoordinatorNotFoundResponse();
}

function parseKvNormalizationSweepInput(body: unknown): {
	entityType: KvNormalizationEntityType;
	options: { maxRowsPerRun?: number; maxWritesPerRun?: number };
} {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new InputError("KV normalization sweep input must be an object.");
	}
	const record = body as Record<string, unknown>;
	const entityType = record.entityType;
	if (typeof entityType !== "string" || !isKvNormalizationEntityType(entityType)) {
		throw new InputError(`entityType must be one of: ${kvNormalizationEntityTypes.join(", ")}.`);
	}
	return {
		entityType,
		options: {
			...optionalSweepBudget(record, "maxRowsPerRun", kvNormalizationSweepMaxRowsPerRun),
			...optionalSweepBudget(record, "maxWritesPerRun", kvNormalizationSweepMaxWritesPerRun),
		},
	};
}

function optionalSweepBudget(
	record: Record<string, unknown>,
	name: "maxRowsPerRun" | "maxWritesPerRun",
	maximum: number,
): { maxRowsPerRun?: number; maxWritesPerRun?: number } {
	const value = record[name];
	if (value === undefined) {
		return {};
	}
	if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
		throw new InputError(`${name} must be a positive integer no greater than ${maximum}.`);
	}
	return { [name]: value as number };
}

function isKvNormalizationEntityType(value: string): value is KvNormalizationEntityType {
	return (kvNormalizationEntityTypes as readonly string[]).includes(value);
}

async function requestThreadNormalization(
	env: Env,
	input: ThreadNormalizationRequest,
): Promise<ThreadNormalizationOutcome> {
	const objectId = env.FORUM_COORDINATOR.idFromName(input.threadId);
	const headers = new Headers({ "content-type": "application/json" });
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	const response = await env.FORUM_COORDINATOR.get(objectId).fetch(new Request(
		internalServiceUrl(`/threads/${encodeURIComponent(input.threadId)}/normalize`),
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				expectedRevision: input.expectedRevision,
				expectedUpdatedAt: input.expectedUpdatedAt,
			}),
		},
	));
	if (!response.ok) {
		throw new RepositoryError("server_error", "Thread normalization coordinator request failed.", 500);
	}
	const payload: unknown = await response.json();
	const data = payload && typeof payload === "object" && !Array.isArray(payload) ?
		(payload as Record<string, unknown>).data
	:	null;
	const normalization = data && typeof data === "object" && !Array.isArray(data) ?
		(data as Record<string, unknown>).normalization
	:	null;
	if (!isThreadNormalizationOutcome(normalization)) {
		throw new RepositoryError("server_error", "Thread normalization coordinator returned an invalid result.", 500);
	}
	return normalization;
}

function parseThreadNormalizationRequest(body: unknown, threadId: string): ThreadNormalizationRequest {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new InputError("Thread normalization input must be an object.");
	}
	const record = body as Record<string, unknown>;
	if (!Number.isInteger(record.expectedRevision)) {
		throw new InputError("expectedRevision must be an integer.");
	}
	if (typeof record.expectedUpdatedAt !== "string" || !record.expectedUpdatedAt) {
		throw new InputError("expectedUpdatedAt must be a timestamp.");
	}
	return {
		threadId,
		expectedRevision: record.expectedRevision as number,
		expectedUpdatedAt: record.expectedUpdatedAt,
	};
}

async function normalizeThreadThroughCoordinator(
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
	input: ThreadNormalizationRequest,
): Promise<ThreadNormalizationOutcome> {
	const cached = await readFreshThreadDocument(coordinator, input.threadId);
	const current = cached ?? await readJson<ThreadDocument>(
		env.BICKR_KV,
		kvKeys.thread(input.threadId),
	);
	if (
		!current ||
		current.id !== input.threadId ||
		current.type !== "thread" ||
		current.revision !== input.expectedRevision ||
		current.updatedAt !== input.expectedUpdatedAt
	) {
		return { kind: "skipped_changed" };
	}
	if (isWithinKvNormalizationQuietPeriod(current.updatedAt)) {
		return { kind: "skipped_recently_updated" };
	}
	const normalized = normalizeThreadDefaults(current);
	if (JSON.stringify(normalized) !== JSON.stringify(current)) {
		await writeJson(env.BICKR_KV, kvKeys.thread(input.threadId), normalized);
		await writeFreshThread(coordinator, normalized);
		return { kind: "rewritten" };
	}
	await writeFreshThread(coordinator, normalized);
	return { kind: "unchanged" };
}

async function routeWorldCoordinatorRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
	if (request.method === "POST" && url.pathname === "/worlds") {
		const body = await readJsonBody(request.clone());
		const input = parseCreateWorldInput(body);
		const objectId = env.WORLD_COORDINATOR.idFromName(input.handle);
		return env.WORLD_COORDINATOR.get(objectId).fetch(jsonRequest(env, url, request, body));
	}

	const worldManageMatch = /^\/worlds\/([^/]+)$/.exec(url.pathname);
	if (!worldManageMatch || (request.method !== "PATCH" && request.method !== "DELETE")) {
		return null;
	}
	const worldHandle = normalizeHandle(decodeURIComponent(worldManageMatch[1] ?? ""));
	const objectId = env.WORLD_COORDINATOR.idFromName(worldHandle);
	return env.WORLD_COORDINATOR.get(objectId).fetch(request);
}

async function routeForumCoordinatorRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
	const forumCreateMatch = /^\/worlds\/([^/]+)\/forums$/.exec(url.pathname);
	if (request.method === "POST" && forumCreateMatch) {
		const worldHandle = normalizeHandle(decodeURIComponent(forumCreateMatch[1] ?? ""));
		const body = await readJsonBody(request.clone());
		const input = parseCreateForumInput(body);
		const objectId = env.FORUM_COORDINATOR.idFromName(`${worldHandle}:${input.handle}`);
		return env.FORUM_COORDINATOR.get(objectId).fetch(jsonRequest(env, url, request, body));
	}

	const forumManageMatch = /^\/worlds\/([^/]+)\/forums\/([^/]+)$/.exec(url.pathname);
	if (forumManageMatch && (request.method === "PATCH" || request.method === "DELETE")) {
		const worldHandle = normalizeHandle(decodeURIComponent(forumManageMatch[1] ?? ""));
		const forumHandle = normalizeHandle(decodeURIComponent(forumManageMatch[2] ?? ""));
		const objectId = env.FORUM_COORDINATOR.idFromName(`${worldHandle}:${forumHandle}`);
		return env.FORUM_COORDINATOR.get(objectId).fetch(request);
	}

	if (!url.pathname.startsWith("/forums/")) {
		return null;
	}
	const threadMutationMatch = /^\/forums\/[^/]+\/threads\/([^/]+)(?:\/comments\/[^/]+)?$/.exec(url.pathname);
	const coordinatorName =
		threadMutationMatch && request.method === "DELETE" ?
			decodeURIComponent(threadMutationMatch[1] ?? "")
		:	url.pathname.split("/")[2] ?? "unknown";
	const objectId = env.FORUM_COORDINATOR.idFromName(coordinatorName);
	return env.FORUM_COORDINATOR.get(objectId).fetch(request);
}

async function routeThreadCoordinatorRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
	if (!url.pathname.startsWith("/threads/")) {
		return null;
	}
	const threadId = url.pathname.split("/")[2] ?? "unknown";
	const objectId = env.FORUM_COORDINATOR.idFromName(threadId);
	return env.FORUM_COORDINATOR.get(objectId).fetch(request);
}

async function routeCommentCoordinatorRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
	if (!url.pathname.startsWith("/comments/")) {
		return null;
	}
	const parentCommentId = url.pathname.split("/")[2] ?? "unknown";
	const row = await env.BICKR_D1.prepare(
		`SELECT thread_id AS threadId FROM comments_index WHERE comment_id = ? AND deleted_at IS NULL`,
	)
		.bind(parentCommentId)
		.first<{ threadId: string }>();
	const objectId = env.FORUM_COORDINATOR.idFromName(row?.threadId ?? parentCommentId);
	return env.FORUM_COORDINATOR.get(objectId).fetch(request);
}

async function routeVoteCoordinatorRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
	if (url.pathname !== "/votes") {
		return null;
	}
	const body = await readJsonBody(request.clone());
	const input = parseVoteInput(body);
	const threadId = await voteCoordinatorName(env.BICKR_D1, input);
	const objectId = env.FORUM_COORDINATOR.idFromName(threadId);
	const forwarded = jsonRequest(env, url, request, body);
	forwarded.headers.set("x-bickr-thread-id", threadId);
	return env.FORUM_COORDINATOR.get(objectId).fetch(forwarded);
}

async function readFreshThread(
	context: CoordinatorContext,
	threadId: string,
): Promise<ThreadDocument | null> {
	const thread = await readFreshThreadDocument(context, threadId);
	if (thread?.deletedAt) {
		throw new RepositoryError("not_found", "Thread not found.", 404);
	}
	return thread;
}

async function readFreshThreadDocument(
	context: CoordinatorContext,
	threadId: string,
): Promise<ThreadDocument | null> {
	const memoryEntry = freshCacheEntryForThread(context.cache?.entry ?? null, threadId, Date.now());
	if (memoryEntry) {
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
		const row = await db
			.prepare(`SELECT thread_id AS threadId FROM threads_index WHERE thread_id = ? AND deleted_at IS NULL`)
			.bind(input.targetId)
			.first<{ threadId: string }>();
		return row?.threadId ?? input.targetId;
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

function jsonRequest(env: InternalServiceAuthEnv, url: URL, original: Request, body: unknown): Request {
	const headers = new Headers();
	for (const name of ["x-bickr-user-id", "x-bickr-bot-id", "x-bickr-thread-id"]) {
		const value = original.headers.get(name);
		if (value !== null) {
			headers.set(name, value);
		}
	}
	headers.set("content-type", "application/json");
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	return new Request(url.toString(), {
		method: original.method,
		headers,
		body: JSON.stringify(body),
	});
}

function forumCoordinatorNotFoundResponse(): Response {
	return json(
		{
			ok: false,
			error: "not_found",
			runtime: "forum-coordinator-worker",
		},
		{ status: 404 },
	);
}

function errorResponse(error: unknown): Response {
	if (error instanceof RepositoryError) {
		return fail(error.code, error.message, error.status, error.details);
	}
	if (error instanceof InputError) {
		return fail("bad_request", error.message, 400);
	}
	if (isD1UniqueConstraintError(error)) {
		return fail("conflict", "That handle is already in use.", 409);
	}

	console.error("forum coordinator error", error);
	return fail("server_error", "Unexpected forum coordinator error.", 500);
}
