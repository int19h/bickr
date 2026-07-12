import { fail, ok, readJsonBody } from "@bickr/shared/api";
import { isD1UniqueConstraintError } from "@bickr/shared/d1-errors";
import {
	deleteComment,
	deleteForum,
	deleteForumForWorld,
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
	softDeleteThreadForForum,
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
import {
	type ObjectIndexConvergenceTask,
	repairObjectIndexes,
	runObjectIndexConvergenceBatch,
} from "@bickr/shared/index-repair";
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
import {
	personalForumDescriptionSweepMaxRowsPerRun,
	personalForumDescriptionSweepMaxWritesPerRun,
	resyncPersonalForumDescriptions,
} from "@bickr/shared/personal-forum-description-sweep";
import { kvKeys, readJson, writeJson } from "@bickr/shared/storage";
import {
	type ForumThreadDeletionRequest,
	runForumThreadDeletionSweep,
	runWorldForumDeletionSweep,
	type WorldForumDeletionRequest,
} from "@bickr/shared/governance-deletion-sweep";

export interface Env {
	BICKR_D1: D1Database;
	BICKR_KV: KVNamespace;
	AI?: Ai;
	BICKR_SEARCH_VECTORIZE?: Vectorize;
	INTERNAL_SERVICE_SECRET?: string;
	WORLD_COORDINATOR: DurableObjectNamespace;
	FORUM_COORDINATOR: DurableObjectNamespace;
}

type ForumCoordinatorEnv = Pick<Env, "AI" | "BICKR_D1" | "BICKR_KV" | "BICKR_SEARCH_VECTORIZE"> &
	Partial<Pick<Env, "FORUM_COORDINATOR" | "INTERNAL_SERVICE_SECRET">>;

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
// One task record is retained only until the owning coordinator's bounded
// governance fan-out completes. The shared alarm is deleted once neither a
// deletion nor an index-convergence task remains.
const governanceDeletionTaskStorageKey = "governance-deletion-task";
const governanceDeletionAlarmDelayMs = 1_000;
// One task record is retained only until every stale object in the renamed
// scope has been reprojected; a newer rename safely replaces it because the
// scope repair converges every row to the latest canonical parent handles.
const objectIndexConvergenceTaskStorageKey = "object-index-convergence-task";

type GovernanceDeletionTask =
	| { kind: "forum_threads"; deletedAt: string; forumId: string }
	| { kind: "world_forums"; deletedAt: string; worldId: string };

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

	async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
		await runCoordinatorAlarm(this.env, {
			objectId: this.state.id.toString(),
			queue: this.queue,
			storage: this.state.storage,
		}, alarmInfo);
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

	async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
		await runCoordinatorAlarm(this.env, {
			cache: this.threadFreshCache,
			objectId: this.state.id.toString(),
			queue: this.queue,
			storage: this.state.storage,
		}, alarmInfo);
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
		const updatedAt = new Date().toISOString();
		const world = await updateWorld(env.BICKR_KV, env.BICKR_D1, worldHandle, userId, input, updatedAt);
		await upsertWorldSearchVector(env, world);
		if (input.handle && input.handle !== worldHandle) {
			await startObjectIndexConvergenceTask(env, coordinator, {
				kind: "object_index_convergence",
				scope: { kind: "world", worldId: world.id },
				updatedAt,
			});
		}
		return ok({ world, coordinator: coordinator.objectId });
	}
	if (request.method === "DELETE") {
		const deletedAt = new Date().toISOString();
		const world = await deleteWorld(env.BICKR_KV, env.BICKR_D1, worldHandle, userId, deletedAt);
		await deleteSearchVector(env, "world", world.id);
		await startGovernanceDeletionTask(env, coordinator, {
			kind: "world_forums",
			deletedAt,
			worldId: world.id,
		});
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
	const internalForumDeleteMatch = /^\/forums\/([^/]+)\/soft-delete$/.exec(url.pathname);
	if (request.method === "POST" && internalForumDeleteMatch) {
		const forumId = decodeURIComponent(internalForumDeleteMatch[1] ?? "");
		const input = parseWorldForumDeletionRequest(await readJsonBody(request), forumId);
		const forum = await deleteForumForWorld(env.BICKR_KV, env.BICKR_D1, input.worldId, forumId, input.deletedAt);
		await deleteSearchVector(env, "forum", forum.id);
		await startGovernanceDeletionTask(env, coordinator, {
			kind: "forum_threads",
			deletedAt: forum.deletedAt ?? input.deletedAt,
			forumId: forum.id,
		}, { runInitialBatch: false });
		return ok({ forum, coordinator: coordinator.objectId });
	}

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
		const updatedAt = new Date().toISOString();
		const forum = await updateForum(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle, userId, input, updatedAt);
		await upsertForumSearchVector(env, forum);
		if (input.handle && input.handle !== forumHandle) {
			await startObjectIndexConvergenceTask(env, coordinator, {
				kind: "object_index_convergence",
				scope: { kind: "forum", forumId: forum.id },
				updatedAt,
			});
		}
		return ok({ forum, coordinator: coordinator.objectId });
	}
	if (request.method === "DELETE") {
		const deletedAt = new Date().toISOString();
		const forum = await deleteForum(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle, userId, deletedAt);
		await deleteSearchVector(env, "forum", forum.id);
		await startGovernanceDeletionTask(env, coordinator, {
			kind: "forum_threads",
			deletedAt,
			forumId: forum.id,
		});
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
	const threadSoftDeleteMatch = /^\/threads\/([^/]+)\/soft-delete$/.exec(url.pathname);
	if (request.method === "POST" && threadSoftDeleteMatch) {
		const threadId = decodeURIComponent(threadSoftDeleteMatch[1] ?? "");
		const input = parseForumThreadDeletionRequest(await readJsonBody(request), threadId);
		const latestThread = await readFreshThreadDocument(coordinator, threadId);
		const thread = await softDeleteThreadForForum(
			env.BICKR_KV,
			env.BICKR_D1,
			input.forumId,
			threadId,
			input.deletedAt,
			{ ...(latestThread ? { thread: latestThread } : {}) },
		);
		if (thread) {
			await writeFreshThread(coordinator, thread);
		}
		return ok({ deletion: { kind: thread ? "deleted" : "missing" }, coordinator: coordinator.objectId });
	}

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

	if (request.method === "POST" && url.pathname === "/maintenance/personal-forum-descriptions") {
		const options = parsePersonalForumDescriptionSweepInput(await readJsonBody(request));
		return json(await resyncPersonalForumDescriptions(env, options));
	}

	const response =
		await routeWorldCoordinatorRequest(request, env, url) ??
		await routeForumCoordinatorRequest(request, env, url) ??
		await routeThreadCoordinatorRequest(request, env, url) ??
		await routeCommentCoordinatorRequest(request, env, url) ??
		await routeVoteCoordinatorRequest(request, env, url);
	return response ?? forumCoordinatorNotFoundResponse();
}

function parsePersonalForumDescriptionSweepInput(body: unknown): {
	maxRowsPerRun?: number;
	maxWritesPerRun?: number;
} {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new InputError("Personal-forum description sweep input must be an object.");
	}
	const record = body as Record<string, unknown>;
	return {
		...optionalSweepBudget(record, "maxRowsPerRun", personalForumDescriptionSweepMaxRowsPerRun),
		...optionalSweepBudget(record, "maxWritesPerRun", personalForumDescriptionSweepMaxWritesPerRun),
	};
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

async function startGovernanceDeletionTask(
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
	task: GovernanceDeletionTask,
	options: { runInitialBatch?: boolean } = {},
): Promise<void> {
	await coordinator.storage?.put(governanceDeletionTaskStorageKey, task);
	// Arm continuation before doing any fan-out. If this invocation is evicted
	// or fails between a child deletion and its cursor checkpoint, the alarm
	// retries the idempotent child operation instead of stranding the task.
	await coordinator.storage?.setAlarm(Date.now() + governanceDeletionAlarmDelayMs);
	// World deletion only starts each forum's task here. Its forum coordinator
	// alarm owns the thread fan-out, avoiding a world invocation that nests a
	// full thread batch inside every forum in its own bounded batch. Test-only
	// direct contexts have no durable storage, so they still complete inline.
	if (options.runInitialBatch === false && coordinator.storage) {
		return;
	}
	await runGovernanceDeletionTask(env, coordinator, task);
	await scheduleCoordinatorAlarmForPendingTasks(coordinator);
}

export async function runPendingGovernanceDeletionTask(
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
): Promise<boolean> {
	const task = await coordinator.storage?.get<GovernanceDeletionTask>(governanceDeletionTaskStorageKey);
	if (!task) {
		return false;
	}
	assertGovernanceDeletionTask(task);
	await runGovernanceDeletionTask(env, coordinator, task);
	return true;
}

async function runCoordinatorAlarm(
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
	alarmInfo?: AlarmInvocationInfo,
): Promise<void> {
	const operation = async () => {
		await runPendingGovernanceDeletionTask(env, coordinator);
		await runPendingObjectIndexConvergenceTask(env, coordinator);
		await scheduleCoordinatorAlarmForPendingTasks(coordinator);
	};
	try {
		if (coordinator.queue) {
			await coordinator.queue.run(operation);
		} else {
			await operation();
		}
	} catch (error) {
		// Cloudflare retries a failed alarm six times. Before that retry budget is
		// exhausted, replace it with a fresh alarm so the persisted task cannot be
		// stranded by a prolonged downstream failure.
		if ((alarmInfo?.retryCount ?? 0) >= 5 && coordinator.storage) {
			await coordinator.storage.setAlarm(Date.now() + governanceDeletionAlarmDelayMs);
			return;
		}
		throw error;
	}
}

async function runGovernanceDeletionTask(
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
	task: GovernanceDeletionTask,
): Promise<void> {
	const result = task.kind === "forum_threads" ?
		await runForumThreadDeletionSweep({
			BICKR_D1: env.BICKR_D1,
			BICKR_KV: env.BICKR_KV,
			deleteThread: (request) => requestThreadSoftDeletion(env, request),
		}, task)
	:	await runWorldForumDeletionSweep({
			BICKR_D1: env.BICKR_D1,
			BICKR_KV: env.BICKR_KV,
			deleteForum: (request) => requestForumSoftDeletion(env, request),
		}, task);

	if (result.done) {
		await coordinator.storage?.delete(governanceDeletionTaskStorageKey);
		return;
	}
}

async function startObjectIndexConvergenceTask(
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
	task: ObjectIndexConvergenceTask,
): Promise<void> {
	if (coordinator.storage) {
		await coordinator.storage.put(objectIndexConvergenceTaskStorageKey, task);
		// Arm before the first external repair batch. Production requests return
		// after this O(1) checkpoint; only direct test contexts repair inline.
		await coordinator.storage.setAlarm(Date.now() + governanceDeletionAlarmDelayMs);
		return;
	}
	await runObjectIndexConvergenceBatch(env, task);
}

export async function runPendingObjectIndexConvergenceTask(
	env: ForumCoordinatorEnv,
	coordinator: CoordinatorContext,
	options: {
		chunkSize?: number;
		maxRowsPerRun?: number;
		maxRepairsPerRun?: number;
	} = {},
): Promise<boolean> {
	const task = await coordinator.storage?.get<ObjectIndexConvergenceTask>(objectIndexConvergenceTaskStorageKey);
	if (!task) {
		return false;
	}
	const next = await runObjectIndexConvergenceBatch(env, task, options);
	if (next) {
		await coordinator.storage?.put(objectIndexConvergenceTaskStorageKey, next);
	} else {
		await coordinator.storage?.delete(objectIndexConvergenceTaskStorageKey);
	}
	return true;
}

async function scheduleCoordinatorAlarmForPendingTasks(coordinator: CoordinatorContext): Promise<void> {
	if (!coordinator.storage) {
		return;
	}
	const [deletionTask, convergenceTask] = await Promise.all([
		coordinator.storage.get(governanceDeletionTaskStorageKey),
		coordinator.storage.get(objectIndexConvergenceTaskStorageKey),
	]);
	if (deletionTask || convergenceTask) {
		await coordinator.storage.setAlarm(Date.now() + governanceDeletionAlarmDelayMs);
	} else {
		await coordinator.storage.deleteAlarm();
	}
}

async function requestThreadSoftDeletion(
	env: ForumCoordinatorEnv,
	input: ForumThreadDeletionRequest,
): Promise<void> {
	const request = internalJsonRequest(
		env,
		`/threads/${encodeURIComponent(input.threadId)}/soft-delete`,
		input,
	);
	const response = env.FORUM_COORDINATOR ?
		await env.FORUM_COORDINATOR.get(env.FORUM_COORDINATOR.idFromName(input.threadId)).fetch(request)
	:	await handleForumCoordinatorRequest(request, env, {
			cache: { entry: null },
			objectId: input.threadId,
			queue: new ExclusiveOperationQueue(),
		});
	if (!response.ok) {
		throw new RepositoryError("server_error", "Thread deletion coordinator request failed.", 500);
	}
}

async function requestForumSoftDeletion(
	env: ForumCoordinatorEnv,
	input: WorldForumDeletionRequest,
): Promise<void> {
	const request = internalJsonRequest(
		env,
		`/forums/${encodeURIComponent(input.forumId)}/soft-delete`,
		input,
	);
	const response = env.FORUM_COORDINATOR ?
		await env.FORUM_COORDINATOR.get(env.FORUM_COORDINATOR.idFromName(input.forumId)).fetch(request)
	:	await handleForumCoordinatorRequest(request, env, {
			objectId: input.forumId,
			queue: new ExclusiveOperationQueue(),
		});
	if (!response.ok) {
		throw new RepositoryError("server_error", "Forum deletion coordinator request failed.", 500);
	}
}

function internalJsonRequest(
	env: Pick<ForumCoordinatorEnv, "INTERNAL_SERVICE_SECRET">,
	path: string,
	body: unknown,
): Request {
	const headers = new Headers({ "content-type": "application/json" });
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	return new Request(internalServiceUrl(path), {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

function assertGovernanceDeletionTask(value: GovernanceDeletionTask): void {
	if (
		Number.isFinite(Date.parse(value.deletedAt)) && (
			(value.kind === "forum_threads" && value.forumId) ||
			(value.kind === "world_forums" && value.worldId)
		)
	) {
		return;
	}
	throw new Error("Invalid persisted governance deletion task.");
}

function parseForumThreadDeletionRequest(body: unknown, threadId: string): ForumThreadDeletionRequest {
	const record = requiredDeletionRequestRecord(body);
	return {
		deletedAt: requiredDeletionRequestString(record, "deletedAt"),
		forumId: requiredDeletionRequestString(record, "forumId"),
		threadId,
	};
}

function parseWorldForumDeletionRequest(body: unknown, forumId: string): WorldForumDeletionRequest {
	const record = requiredDeletionRequestRecord(body);
	return {
		deletedAt: requiredDeletionRequestString(record, "deletedAt"),
		forumId,
		worldId: requiredDeletionRequestString(record, "worldId"),
	};
}

function requiredDeletionRequestRecord(body: unknown): Record<string, unknown> {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new InputError("Governance deletion input must be an object.");
	}
	return body as Record<string, unknown>;
}

function requiredDeletionRequestString(record: Record<string, unknown>, name: "deletedAt" | "forumId" | "worldId"): string {
	const value = record[name];
	if (typeof value !== "string" || !value) {
		throw new InputError(`${name} must be a non-empty string.`);
	}
	if (name === "deletedAt" && !Number.isFinite(Date.parse(value))) {
		throw new InputError("deletedAt must be a timestamp.");
	}
	return value;
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
	const row = await env.BICKR_D1.prepare(
		`SELECT world_id AS worldId
		 FROM worlds_index
		 WHERE handle = ? AND deleted_at IS NULL`,
	)
		.bind(worldHandle)
		.first<{ worldId: string }>();
	const objectId = env.WORLD_COORDINATOR.idFromName(row?.worldId ?? worldHandle);
	return env.WORLD_COORDINATOR.get(objectId).fetch(request);
}

async function routeForumCoordinatorRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
	const forumCreateMatch = /^\/worlds\/([^/]+)\/forums$/.exec(url.pathname);
	if (request.method === "POST" && forumCreateMatch) {
		const worldHandle = normalizeHandle(decodeURIComponent(forumCreateMatch[1] ?? ""));
		const body = await readJsonBody(request.clone());
		parseCreateForumInput(body);
		const row = await env.BICKR_D1.prepare(
			`SELECT world_id AS worldId
			 FROM worlds_index
			 WHERE handle = ? AND deleted_at IS NULL`,
		)
			.bind(worldHandle)
			.first<{ worldId: string }>();
		// Forum creation shares the world coordinator with world deletion. A
		// creation that wins the queue is included in the world sweep; one that
		// loses observes the deleted world and is rejected.
		const objectId = env.WORLD_COORDINATOR.idFromName(row?.worldId ?? worldHandle);
		return env.WORLD_COORDINATOR.get(objectId).fetch(jsonRequest(env, url, request, body));
	}

	const forumManageMatch = /^\/worlds\/([^/]+)\/forums\/([^/]+)$/.exec(url.pathname);
	if (forumManageMatch && (request.method === "PATCH" || request.method === "DELETE")) {
		const worldHandle = normalizeHandle(decodeURIComponent(forumManageMatch[1] ?? ""));
		const forumHandle = normalizeHandle(decodeURIComponent(forumManageMatch[2] ?? ""));
		const row = await env.BICKR_D1.prepare(
			`SELECT forum_id AS forumId
			 FROM forums_index
			 WHERE world_handle = ? AND handle = ? AND deleted_at IS NULL`,
		)
			.bind(worldHandle, forumHandle)
			.first<{ forumId: string }>();
		// Forum mutations and thread creation share the forum-ID coordinator.
		// The handle fallback preserves the normal not-found response when there
		// is no live forum to resolve.
		const objectId = env.FORUM_COORDINATOR.idFromName(row?.forumId ?? `${worldHandle}:${forumHandle}`);
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
