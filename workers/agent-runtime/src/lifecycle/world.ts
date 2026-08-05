import {
	abortLifecycleDeletion,
	activateLifecycleEntity,
	beginWorldDeleteLifecycle,
	beginLifecycleCompensation,
	classifyLifecycleFailure,
	finalizeLifecycleCompensation,
	finalizeLifecycleDeletion,
	hashLifecycleRequest,
	injectedLifecycleFailureFromSerialized,
	lifecycleCheckpoint,
	lifecycleIdempotencyKey,
	lifecycleOperationById,
	lifecycleOperationByKey,
	markLifecycleMaterializing,
	recordRetryableLifecycleFailure,
	reserveOwnedCreateLifecycle,
	serializedLifecycleRequest,
	type LifecycleOperation,
} from "@bickr/shared/entity-lifecycle";
import { inferenceOverridesFromLegacyImageSettings } from "@bickr/shared/inference-configuration-legacy";
import {
	accountDefaultConfigurationId,
	fixedConfigurationDeletionStatements,
	insertFixedConfigurationStatement,
	lifecycleUsesInferenceGraph,
	worldConfigurationId,
} from "@bickr/shared/inference-configuration-repository";
import { deterministicId, makeId } from "@bickr/shared/ids";
import { addInternalServiceAuthHeader, internalServiceUrl } from "@bickr/shared/internal-service";
import type { BotGroupSummary, CreateWorldInput, WorldDocument, WorldSummary } from "@bickr/shared/model";
import {
	parseOwnerWorldMutationResult,
	type OwnerWorldMutation,
	type OwnerWorldMutationResult,
} from "@bickr/shared/owner-world-mutation";
import { RepositoryError } from "@bickr/shared/repository";
import {
	parseWorldLifecycleMutationResult,
	type WorldLifecycleMutation,
} from "@bickr/shared/world-lifecycle-protocol";
import { kvKeys, readJson } from "@bickr/shared/storage";
import { apiErrorPayload, repositoryErrorCode } from "../runtime/bot-runtime";
import { scheduleUserLifecycleAlarm } from "./common";
import type { AgentRuntimeRouteEnv, LifecycleReservationContext, LifecycleRuntimeContext } from "./types";

type WorldCreateLifecycleRequest = {
	kind: "world_create";
	userId: string;
	worldId: string;
	introForumId: string;
	createdAt: string;
	input: CreateWorldInput;
};

type WorldDeleteLifecycleRequest = {
	kind: "world_delete";
	userId: string;
	worldId: string;
	worldHandle: string;
};

export async function reserveWorldCreate(
	context: LifecycleReservationContext,
	userId: string,
	input: CreateWorldInput,
): Promise<LifecycleOperation> {
	const now = new Date().toISOString();
	const requestHash = await hashLifecycleRequest({ kind: "world_create", userId, input });
	const worldId = makeId("wld");
	const request: WorldCreateLifecycleRequest = {
		kind: "world_create",
		userId,
		worldId,
		introForumId: await deterministicId("frm", `world:${worldId}:intro`),
		createdAt: now,
		input,
	};
	const reserved = await reserveOwnedCreateLifecycle(context.env.BICKR_D1, {
		ownerUserId: userId,
		idempotencyKey: lifecycleIdempotencyKey(context.request),
		requestHash,
		requestJson: serializedLifecycleRequest(request),
		entityKind: "world",
		entityId: request.worldId,
		reservations: [{ kind: "world_handle", scope: "global", value: input.handle }],
		now,
	});
	try {
		await lifecycleCheckpoint(context.coordinator.failureInjector, "world.reserve.d1");
	} catch (error) {
		const failure = classifyLifecycleFailure(error);
		if (failure.retryable) {
			await scheduleUserLifecycleAlarm(context.coordinator);
		} else {
			const compensating = await beginLifecycleCompensation(context.env.BICKR_D1, reserved.operation, failure, new Date().toISOString());
			try {
				await compensateWorldCreate(context, compensating, request);
			} catch (compensationError) {
				await scheduleUserLifecycleAlarm(context.coordinator);
				throw compensationError;
			}
		}
		throw error;
	}
	return reserved.operation;
}

export async function runWorldCreateOperation(
	context: LifecycleRuntimeContext,
	initialOperation: LifecycleOperation,
): Promise<void> {
	let operation = await lifecycleOperationById(context.env.BICKR_D1, initialOperation.operationId) ?? initialOperation;
	if (operation.phase === "terminal") return;
	if (operation.phase === "terminal_failed") throw new RepositoryError("conflict", "World creation previously failed terminally.", 409);
	if (!operation.requestJson) throw new RepositoryError("server_error", "World lifecycle request is missing.", 500);
	const request = parseWorldCreateLifecycleRequest(operation.requestJson);
	if (operation.phase === "compensating") {
		await compensateWorldCreate(context, operation, request);
		return;
	}
	try {
		operation = await markLifecycleMaterializing(context.env.BICKR_D1, operation, new Date().toISOString());
		await requestWorldMaterialization(context, request);
		await lifecycleCheckpoint(context.coordinator.failureInjector, "world.activate.d1");
		const activatedAt = new Date().toISOString();
		if (await lifecycleUsesInferenceGraph(context.env.BICKR_D1)) {
			await activateLifecycleEntity(context.env.BICKR_D1, operation, {
				kind: "inference_graph",
				entityKind: "world",
				fixedConfigurationStatement: insertFixedConfigurationStatement(context.env.BICKR_D1, {
					kind: "world",
					configurationId: await worldConfigurationId(request.worldId),
					ownerUserId: request.userId,
					parentId: await accountDefaultConfigurationId(request.userId),
					worldId: request.worldId,
					now: activatedAt,
					overrides: inferenceOverridesFromLegacyImageSettings(request.input.imageGeneration),
				}),
			}, activatedAt);
		} else {
			await activateLifecycleEntity(context.env.BICKR_D1, operation, { kind: "legacy_compatible" }, activatedAt);
		}
	} catch (error) {
		const failure = classifyLifecycleFailure(error);
		const failedAt = new Date().toISOString();
		if (failure.retryable) {
			operation = await recordRetryableLifecycleFailure(context.env.BICKR_D1, operation, failure, failedAt);
			if (operation.phase !== "compensating") {
				await scheduleUserLifecycleAlarm(context.coordinator);
				throw error;
			}
		} else {
			operation = await beginLifecycleCompensation(context.env.BICKR_D1, operation, failure, failedAt);
		}
		try {
			await compensateWorldCreate(context, operation, request);
		} catch (compensationError) {
			await scheduleUserLifecycleAlarm(context.coordinator);
			throw compensationError;
		}
		throw error;
	}
}

async function requestWorldMaterialization(
	context: LifecycleRuntimeContext,
	request: WorldCreateLifecycleRequest,
): Promise<WorldSummary> {
	const response = await requestWorldCoordinator(context, request.worldId, "materialize", request.userId, {
		kind: "world_materialize",
		userId: request.userId,
		introForumId: request.introForumId,
		createdAt: request.createdAt,
		input: request.input,
	} satisfies WorldLifecycleMutation);
	const result = parseWorldLifecycleMutationResult(await serviceResponseData(response, "World materialization coordinator request failed."));
	switch (result.kind) {
		case "world_materialized": return result.world;
		case "world_compensated":
		case "world_deleted": throw new RepositoryError("server_error", "World materialization coordinator returned the wrong result kind.", 500);
	}
}

async function compensateWorldCreate(
	context: LifecycleRuntimeContext,
	operation: LifecycleOperation,
	request: WorldCreateLifecycleRequest,
): Promise<void> {
	const response = await requestWorldCoordinator(context, request.worldId, "compensate", request.userId, {
		kind: "world_compensate",
		introForumId: request.introForumId,
	} satisfies WorldLifecycleMutation);
	const result = parseWorldLifecycleMutationResult(await serviceResponseData(response, "World compensation coordinator request failed."));
	if (result.kind !== "world_compensated") {
		throw new RepositoryError("server_error", "World compensation coordinator returned the wrong result kind.", 500);
	}
	await finalizeLifecycleCompensation(context.env.BICKR_D1, operation, [], new Date().toISOString());
}

async function requestWorldCoordinator(
	context: LifecycleRuntimeContext,
	worldId: string,
	action: "materialize" | "compensate" | "delete",
	userId: string,
	body: unknown,
): Promise<Response> {
	if (!context.env.FORUM_COORDINATOR_SERVICE) {
		throw new RepositoryError("server_error", "World coordinator service is unavailable.", 500);
	}
	const headers = new Headers({ "content-type": "application/json", "x-bickr-user-id": userId });
	headers.set("x-bickr-user-coordinator", "1");
	addInternalServiceAuthHeader(headers, context.env.INTERNAL_SERVICE_SECRET);
	return context.env.FORUM_COORDINATOR_SERVICE.fetch(new Request(
		internalServiceUrl(`/lifecycle/worlds/${encodeURIComponent(worldId)}/${action}`),
		{ method: "POST", headers, body: JSON.stringify(body) },
	));
}

export async function requestOwnerWorldMutation(
	context: LifecycleRuntimeContext,
	worldId: string,
	userId: string,
	mutation: OwnerWorldMutation,
): Promise<OwnerWorldMutationResult> {
	if (!context.env.FORUM_COORDINATOR_SERVICE) {
		throw new RepositoryError("server_error", "World coordinator service is unavailable.", 500);
	}
	const headers = new Headers({ "content-type": "application/json", "x-bickr-user-id": userId });
	headers.set("x-bickr-user-coordinator", "1");
	addInternalServiceAuthHeader(headers, context.env.INTERNAL_SERVICE_SECRET);
	const response = await context.env.FORUM_COORDINATOR_SERVICE.fetch(new Request(
		internalServiceUrl(`/owner/worlds/${encodeURIComponent(worldId)}/mutate`),
		{ method: "POST", headers, body: JSON.stringify(mutation) },
	));
	const data = await serviceResponseData(response, "Owner world mutation coordinator request failed.");
	return parseOwnerWorldMutationResult(data.result);
}

export function requiredWorldMutationResult(result: OwnerWorldMutationResult): WorldSummary {
	switch (result.kind) {
		case "world_updated": return result.world;
		case "bot_group_created":
		case "bot_group_updated":
		case "bot_group_deleted": throw new RepositoryError("server_error", "World coordinator returned a bot-group result for a world mutation.", 500);
	}
}

export function requiredBotGroupMutationResult(
	result: OwnerWorldMutationResult,
	expectedKind: "bot_group_created" | "bot_group_updated" | "bot_group_deleted",
): BotGroupSummary {
	switch (result.kind) {
		case "world_updated": throw new RepositoryError("server_error", "World coordinator returned a world result for a bot-group mutation.", 500);
		case "bot_group_created":
		case "bot_group_updated":
		case "bot_group_deleted":
			if (result.kind !== expectedKind) throw new RepositoryError("server_error", "World coordinator returned the wrong bot-group mutation result.", 500);
			return result.group;
	}
}

export async function reserveWorldDelete(
	context: LifecycleReservationContext,
	userId: string,
	worldHandle: string,
): Promise<LifecycleOperation> {
	const idempotencyKey = lifecycleIdempotencyKey(context.request);
	const existing = await lifecycleOperationByKey(context.env.BICKR_D1, userId, idempotencyKey);
	if (existing) {
		const request: WorldDeleteLifecycleRequest = { kind: "world_delete", userId, worldId: existing.entityId, worldHandle };
		return (await beginWorldDeleteLifecycle(context.env.BICKR_D1, {
			ownerUserId: userId,
			idempotencyKey,
			requestHash: await hashLifecycleRequest(request),
			requestJson: serializedLifecycleRequest(request),
			entityId: existing.entityId,
			now: new Date().toISOString(),
		})).operation;
	}
	const row = await context.env.BICKR_D1.prepare(
		`SELECT world_id AS worldId, created_by_user_id AS ownerUserId
		 FROM worlds_index
		 WHERE handle = ? AND deleted_at IS NULL AND lifecycle_state = 'active'
		 LIMIT 1`,
	).bind(worldHandle).first<{ worldId: string; ownerUserId: string }>();
	if (!row) throw new RepositoryError("not_found", "World not found.", 404);
	if (row.ownerUserId !== userId) throw new RepositoryError("forbidden", "Only the world owner can delete this world.", 403);
	const bots = await context.env.BICKR_D1.prepare(
		"SELECT COUNT(*) AS count FROM bots_index WHERE home_world_id = ? AND deleted_at IS NULL",
	).bind(row.worldId).first<{ count: number }>();
	if ((bots?.count ?? 0) > 0) throw new RepositoryError("forbidden", "Worlds can only be deleted after all bots in them are deleted.", 403);
	const request: WorldDeleteLifecycleRequest = { kind: "world_delete", userId, worldId: row.worldId, worldHandle };
	const started = await beginWorldDeleteLifecycle(context.env.BICKR_D1, {
		ownerUserId: userId,
		idempotencyKey,
		requestHash: await hashLifecycleRequest(request),
		requestJson: serializedLifecycleRequest(request),
		entityId: row.worldId,
		now: new Date().toISOString(),
	});
	try {
		await lifecycleCheckpoint(context.coordinator.failureInjector, "world.delete.hide.d1");
	} catch (error) {
		const failure = classifyLifecycleFailure(error);
		if (failure.retryable) await scheduleUserLifecycleAlarm(context.coordinator);
		else await abortLifecycleDeletion(context.env.BICKR_D1, started.operation, failure, new Date().toISOString());
		throw error;
	}
	return started.operation;
}

export async function runWorldDeleteOperation(
	context: LifecycleRuntimeContext,
	initialOperation: LifecycleOperation,
): Promise<void> {
	let operation = await lifecycleOperationById(context.env.BICKR_D1, initialOperation.operationId) ?? initialOperation;
	if (operation.phase === "terminal") return;
	if (operation.phase === "terminal_failed") throw new RepositoryError("conflict", "World deletion previously failed terminally.", 409);
	if (!operation.requestJson) throw new RepositoryError("server_error", "World deletion request is missing.", 500);
	const request = parseWorldDeleteLifecycleRequest(operation.requestJson);
	try {
		const response = await requestWorldCoordinator(context, request.worldId, "delete", request.userId, {
			kind: "world_delete", worldHandle: request.worldHandle,
		} satisfies WorldLifecycleMutation);
		const result = parseWorldLifecycleMutationResult(await serviceResponseData(response, "World deletion coordinator request failed."));
		if (result.kind !== "world_deleted") throw new RepositoryError("server_error", "World deletion coordinator returned the wrong result kind.", 500);
		const finalizedAt = new Date().toISOString();
		const graphDeletion = await lifecycleUsesInferenceGraph(context.env.BICKR_D1);
		await finalizeLifecycleDeletion(context.env.BICKR_D1, operation, graphDeletion ? {
			kind: "inference_graph",
			entityKind: "world",
			configurationStatements: await fixedConfigurationDeletionStatements(context.env.BICKR_D1, {
				ownerUserId: request.userId,
				configurationId: await worldConfigurationId(request.worldId),
				entityKind: "world",
				now: finalizedAt,
			}),
		} : { kind: "legacy_compatible" }, finalizedAt);
		await lifecycleCheckpoint(context.coordinator.failureInjector, "world.delete.finish.d1");
	} catch (error) {
		const deleted = await worldDeletionHasStarted(context.env, request.worldId);
		const failure = classifyLifecycleFailure(error);
		if (!failure.retryable && !deleted) {
			await abortLifecycleDeletion(context.env.BICKR_D1, operation, failure, new Date().toISOString());
			throw error;
		}
		operation = await recordRetryableLifecycleFailure(context.env.BICKR_D1, operation, {
			category: "external_retryable",
			code: deleted ? "deletion_finalize_retry" : failure.code,
			retryable: true,
		}, new Date().toISOString());
		if (operation.phase === "compensating" && !deleted) {
			await abortLifecycleDeletion(context.env.BICKR_D1, operation, {
				category: "retry_exhausted",
				code: operation.failureCode ?? "world_deletion_retry_exhausted",
				retryable: false,
			}, new Date().toISOString());
			throw error;
		}
		await scheduleUserLifecycleAlarm(context.coordinator);
		throw error;
	}
}

async function worldDeletionHasStarted(
	env: Pick<AgentRuntimeRouteEnv, "BICKR_D1" | "BICKR_KV">,
	worldId: string,
): Promise<boolean> {
	const document = await readJson<WorldDocument>(env.BICKR_KV, kvKeys.world(worldId));
	if (document?.deletedAt) return true;
	const row = await env.BICKR_D1.prepare("SELECT deleted_at AS deletedAt FROM worlds_index WHERE world_id = ? LIMIT 1")
		.bind(worldId).first<{ deletedAt: string | null }>();
	return Boolean(row?.deletedAt);
}

async function serviceResponseData(response: Response, fallback: string): Promise<Record<string, unknown>> {
	const payload: unknown = await response.json();
	const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
	if (!response.ok || record.ok === false) {
		const lifecycleFailure = injectedLifecycleFailureFromSerialized(record.lifecycleFailure);
		if (lifecycleFailure) throw lifecycleFailure;
		const apiError = apiErrorPayload(record);
		if (apiError) throw new RepositoryError(repositoryErrorCode(apiError.error), apiError.message, response.status || 500, apiError.details);
		throw new RepositoryError("server_error", fallback, response.status || 500);
	}
	return record.data && typeof record.data === "object" && !Array.isArray(record.data)
		? record.data as Record<string, unknown>
		: {};
}

function parseWorldCreateLifecycleRequest(serialized: string): WorldCreateLifecycleRequest {
	const value: unknown = JSON.parse(serialized);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new RepositoryError("server_error", "World lifecycle request is invalid.", 500);
	const request = value as Partial<WorldCreateLifecycleRequest>;
	if (request.kind !== "world_create" || typeof request.userId !== "string" || typeof request.worldId !== "string" || typeof request.introForumId !== "string" || typeof request.createdAt !== "string" || !request.input) {
		throw new RepositoryError("server_error", "World lifecycle request is invalid.", 500);
	}
	return request as WorldCreateLifecycleRequest;
}

function parseWorldDeleteLifecycleRequest(serialized: string): WorldDeleteLifecycleRequest {
	const value: unknown = JSON.parse(serialized);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new RepositoryError("server_error", "World deletion request is invalid.", 500);
	const request = value as Partial<WorldDeleteLifecycleRequest>;
	if (request.kind !== "world_delete" || typeof request.userId !== "string" || typeof request.worldId !== "string" || typeof request.worldHandle !== "string") {
		throw new RepositoryError("server_error", "World deletion request is invalid.", 500);
	}
	return request as WorldDeleteLifecycleRequest;
}
