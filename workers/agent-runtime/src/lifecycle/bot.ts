import {
	fetchRemoteAvatarBytes,
	normalizeAvatarPublicBaseUrl,
	storeAvatarImage,
	type AvatarContentType,
} from "@bickr/shared/avatar-storage";
import {
	abortLifecycleDeletion,
	activateLifecycleEntity,
	beginDeleteLifecycle,
	beginLifecycleCompensation,
	classifyLifecycleFailure,
	finalizeLifecycleCompensation,
	finalizeLifecycleDeletion,
	hashLifecycleRequest,
	lifecycleCheckpoint,
	lifecycleIdempotencyKey,
	lifecycleOperationById,
	lifecycleOperationByKey,
	lifecycleSecretValue,
	markLifecycleMaterializing,
	recordRetryableLifecycleFailure,
	reserveBotCreateLifecycle,
	serializedLifecycleRequest,
	type LifecycleFailurePoint,
	type LifecycleOperation,
} from "@bickr/shared/entity-lifecycle";
import { inferenceOverridesFromLegacySettings } from "@bickr/shared/inference-configuration-legacy";
import {
	fixedConfigurationDeletionStatements,
	insertFixedConfigurationStatement,
	lifecycleUsesInferenceGraph,
} from "@bickr/shared/inference-configuration-repository";
import {
	accountDefaultConfigurationId,
	botConfigurationId,
} from "@bickr/shared/inference-configuration-repository";
import { deterministicId, makeId } from "@bickr/shared/ids";
import type { BotDocument, BotSummary, CreateBotInput } from "@bickr/shared/model";
import {
	assertBotDeleteAllowed,
	deleteBotGroupMembershipsByBotSql,
	rawBotById,
	RepositoryError,
	userCoordinatorRepositoryMutations,
	worldByHandle,
} from "@bickr/shared/repository";
import { deleteKey, kvKeys, readJson } from "@bickr/shared/storage";
import { deleteBotVector, requireAvatarBucket, upsertBotVector } from "../runtime/bot-runtime";
import { scheduleUserLifecycleAlarm } from "./common";
import type { AgentRuntimeRouteEnv, LifecycleReservationContext, LifecycleRuntimeContext } from "./types";

const { createBot, deleteBot, materializePendingBotAvatar } = userCoordinatorRepositoryMutations;

type CredentialFreeCreateBotInput = Omit<CreateBotInput, "inferenceSettings"> & {
	inferenceSettings?: Omit<NonNullable<CreateBotInput["inferenceSettings"]>, "openRouterApiKey">;
};

type BotCreateLifecycleRequest = {
	kind: "bot_create" | "clone_create";
	userId: string;
	worldId: string;
	worldHandle: string;
	botId: string;
	personalForumId: string;
	createdAt: string;
	input: CredentialFreeCreateBotInput;
};

type BotDeleteLifecycleRequest = {
	kind: "bot_delete" | "clone_delete";
	userId: string;
	botId: string;
	allowLinkedCloneDelete: boolean;
};

export async function reserveBotCreate(
	context: LifecycleReservationContext,
	userId: string,
	worldHandle: string,
	input: CreateBotInput,
): Promise<LifecycleOperation> {
	const world = await worldByHandle(context.env.BICKR_D1, worldHandle);
	const kind = input.cloneSourceBotId ? "clone_create" as const : "bot_create" as const;
	const createdAt = new Date().toISOString();
	const requestHash = await hashLifecycleRequest({ kind, userId, worldHandle, input });
	const credential = input.inferenceSettings?.openRouterApiKey;
	const credentialFreeInput = credentialFreeCreateBotInput(input);
	const botId = makeId("bot");
	const request: BotCreateLifecycleRequest = {
		kind,
		userId,
		worldId: world.id,
		worldHandle,
		botId,
		personalForumId: await deterministicId("frm", `bot:${botId}:personal`),
		createdAt,
		input: credentialFreeInput,
	};
	const reserved = await reserveBotCreateLifecycle(context.env.BICKR_D1, {
		ownerUserId: userId,
		idempotencyKey: lifecycleIdempotencyKey(context.request),
		requestHash,
		requestJson: serializedLifecycleRequest(request),
		entityKind: "bot",
		entityId: request.botId,
		worldId: request.worldId,
		reservations: [{ kind: "bot_handle", scope: world.id, value: input.handle }],
		...(typeof credential === "string" ? {
			secrets: [{ kind: "bot_openrouter_api_key" as const, value: credential }],
		} : {}),
		now: createdAt,
	});
	try {
		await lifecycleCheckpoint(context.coordinator.failureInjector, input.cloneSourceBotId ? "clone.reserve.d1" : "bot.reserve.d1");
	} catch (error) {
		const failure = classifyLifecycleFailure(error);
		if (failure.retryable) {
			await scheduleUserLifecycleAlarm(context.coordinator);
		} else {
			const compensating = await beginLifecycleCompensation(context.env.BICKR_D1, reserved.operation, failure, new Date().toISOString());
			try {
				await compensateBotCreate(context, compensating, request);
			} catch (compensationError) {
				await scheduleUserLifecycleAlarm(context.coordinator);
				throw compensationError;
			}
		}
		throw error;
	}
	return reserved.operation;
}

export async function runBotCreateOperation(
	context: LifecycleRuntimeContext,
	initialOperation: LifecycleOperation,
): Promise<void> {
	let operation = await lifecycleOperationById(context.env.BICKR_D1, initialOperation.operationId) ?? initialOperation;
	if (operation.phase === "terminal") return;
	if (operation.phase === "terminal_failed") throw new RepositoryError("conflict", "Participant creation previously failed terminally.", 409);
	if (!operation.requestJson) throw new RepositoryError("server_error", "Participant lifecycle request is missing.", 500);
	const request = parseBotCreateLifecycleRequest(operation.requestJson);
	if (operation.phase === "compensating") {
		await compensateBotCreate(context, operation, request);
		return;
	}
	try {
		operation = await markLifecycleMaterializing(context.env.BICKR_D1, operation, new Date().toISOString());
		const materializationInput = await botCreateInputWithLifecycleSecret(context, operation, request.input);
		const cloneSource = materializationInput.cloneSourceBotId
			? await rawBotById(context.env.BICKR_KV, context.env.BICKR_D1, materializationInput.cloneSourceBotId)
			: undefined;
		if (cloneSource && cloneSource.ownerUserId !== request.userId) {
			throw new RepositoryError("forbidden", "You can only clone your own participants.", 403);
		}
		let bot = await createBot(
			context.env.BICKR_KV,
			context.env.BICKR_D1,
			request.worldHandle,
			materializationInput,
			request.userId,
			{
				now: request.createdAt,
				botId: request.botId,
				personalForumId: request.personalForumId,
				lifecycleState: "pending",
				cloneSource,
				checkpoint: (point) => lifecycleCheckpoint(context.coordinator.failureInjector, point),
			},
		);
		const lifecyclePrefix = request.kind === "clone_create" ? "clone" : "bot";
		if (request.input.importSource?.sourceAvatarUrl) {
			bot = await materializeLifecycleImportAvatar(context, operation, request, bot);
			await lifecycleCheckpoint(context.coordinator.failureInjector, "bot.materialize.import_avatar");
		}
		await upsertBotVector(context.env, bot);
		await lifecycleCheckpoint(context.coordinator.failureInjector, `${lifecyclePrefix}.materialize.vector` as LifecycleFailurePoint);
		await lifecycleCheckpoint(context.coordinator.failureInjector, `${lifecyclePrefix}.activate.d1` as LifecycleFailurePoint);
		const activatedAt = new Date().toISOString();
		if (await lifecycleUsesInferenceGraph(context.env.BICKR_D1)) {
			const parentId = request.input.cloneSourceBotId
				? await botConfigurationId(request.input.cloneSourceBotId)
				: await accountDefaultConfigurationId(request.userId);
			await activateLifecycleEntity(context.env.BICKR_D1, operation, {
				kind: "inference_graph",
				entityKind: "bot",
				fixedConfigurationStatement: insertFixedConfigurationStatement(context.env.BICKR_D1, {
					kind: "bot",
					configurationId: await botConfigurationId(request.botId),
					ownerUserId: request.userId,
					parentId,
					botId: request.botId,
					now: activatedAt,
					overrides: inferenceOverridesFromLegacySettings(request.input.inferenceSettings),
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
			await compensateBotCreate(context, operation, request);
		} catch (compensationError) {
			await scheduleUserLifecycleAlarm(context.coordinator);
			throw compensationError;
		}
		throw error;
	}
}

async function materializeLifecycleImportAvatar(
	context: LifecycleRuntimeContext,
	operation: LifecycleOperation,
	request: BotCreateLifecycleRequest,
	bot: BotSummary,
): Promise<BotSummary> {
	const source = request.input.importSource;
	if (!source?.sourceAvatarUrl) return bot;
	const bucket = requireAvatarBucket(context.env);
	const publicBaseUrl = normalizeAvatarPublicBaseUrl(context.env.BICKR_R2_PUBLIC_BASE_URL);
	const sourceMetadata = {
		type: "chirper" as const,
		sourceUrl: source.sourceAvatarUrl,
		originalHandle: source.originalHandle,
		importedAt: source.importedAt,
	};
	const candidates: readonly [AvatarContentType, string][] = [
		["image/jpeg", lifecycleBotImportAvatarKey(request.worldId, request.botId, "image/jpeg")],
		["image/png", lifecycleBotImportAvatarKey(request.worldId, request.botId, "image/png")],
		["image/webp", lifecycleBotImportAvatarKey(request.worldId, request.botId, "image/webp")],
	];
	if (candidates.some(([, key]) => bot.avatar?.key === key)) return bot;

	// A Worker can be interrupted after the deterministic R2 put but before its
	// KV projection. Reuse that immutable snapshot before the mutable source URL.
	for (const [contentType, key] of candidates) {
		const stored = await bucket.get(key);
		if (!stored) continue;
		const avatar = await storeAvatarImage(bucket, {
			botId: bot.id,
			worldId: bot.homeWorldId,
			key,
			bytes: new Uint8Array(await stored.arrayBuffer()),
			contentType,
			publicBaseUrl,
			source: sourceMetadata,
			now: request.createdAt,
		});
		return materializePendingBotAvatar(context.env.BICKR_KV, context.env.BICKR_D1, {
			kind: "lifecycle_import_avatar",
			botId: bot.id,
			ownerUserId: request.userId,
			operationId: operation.operationId,
			avatar,
			now: request.createdAt,
		});
	}

	const importedAvatar = await fetchRemoteAvatarBytes(source.sourceAvatarUrl);
	const avatar = await storeAvatarImage(bucket, {
		botId: bot.id,
		worldId: bot.homeWorldId,
		key: lifecycleBotImportAvatarKey(bot.homeWorldId, bot.id, importedAvatar.contentType),
		bytes: importedAvatar.bytes,
		contentType: importedAvatar.contentType,
		publicBaseUrl,
		source: sourceMetadata,
		now: request.createdAt,
	});
	return materializePendingBotAvatar(context.env.BICKR_KV, context.env.BICKR_D1, {
		kind: "lifecycle_import_avatar",
		botId: bot.id,
		ownerUserId: request.userId,
		operationId: operation.operationId,
		avatar,
		now: request.createdAt,
	});
}

async function compensateBotCreate(
	context: LifecycleRuntimeContext,
	operation: LifecycleOperation,
	request: BotCreateLifecycleRequest,
): Promise<void> {
	await deleteBotVector(context.env, request.botId);
	const bot = await readJson<BotDocument>(context.env.BICKR_KV, kvKeys.bot(request.botId));
	if (bot?.avatar?.key && context.env.BICKR_R2) await context.env.BICKR_R2.delete(bot.avatar.key);
	if (request.input.importSource && context.env.BICKR_R2) {
		await context.env.BICKR_R2.delete([
			lifecycleBotImportAvatarKey(request.worldId, request.botId, "image/jpeg"),
			lifecycleBotImportAvatarKey(request.worldId, request.botId, "image/png"),
			lifecycleBotImportAvatarKey(request.worldId, request.botId, "image/webp"),
		]);
	}
	await deleteKey(context.env.BICKR_KV, kvKeys.forum(request.personalForumId));
	await deleteKey(context.env.BICKR_KV, kvKeys.bot(request.botId));
	const db = context.env.BICKR_D1;
	await finalizeLifecycleCompensation(db, operation, [
		db.prepare(deleteBotGroupMembershipsByBotSql).bind(request.botId),
		db.prepare("DELETE FROM human_subscriptions WHERE scope_type = 'bot' AND scope_id = ?").bind(request.botId),
		db.prepare("DELETE FROM bot_clone_sources WHERE bot_id = ?").bind(request.botId),
		db.prepare("DELETE FROM bot_imports WHERE bot_id = ?").bind(request.botId),
		db.prepare("DELETE FROM bot_runtime_index WHERE bot_id = ?").bind(request.botId),
		db.prepare("DELETE FROM search_entities_fts WHERE entity_type = 'forum' AND entity_id = ?").bind(request.personalForumId),
		db.prepare("DELETE FROM objects_index WHERE object_id = ?").bind(request.personalForumId),
		db.prepare("DELETE FROM forums_index WHERE forum_id = ? AND personal_bot_id = ?").bind(request.personalForumId, request.botId),
		db.prepare("DELETE FROM search_entities_fts WHERE entity_type = 'bot' AND entity_id = ?").bind(request.botId),
		db.prepare("DELETE FROM objects_index WHERE object_id = ?").bind(request.botId),
		db.prepare("DELETE FROM bots_index WHERE bot_id = ? AND lifecycle_state != 'active'").bind(request.botId),
	], new Date().toISOString());
}

export async function reserveBotDelete(
	context: LifecycleReservationContext,
	userId: string,
	botId: string,
	options: { allowLinkedCloneDelete?: boolean } = {},
): Promise<LifecycleOperation> {
	const idempotencyKey = lifecycleIdempotencyKey(context.request);
	const existing = await lifecycleOperationByKey(context.env.BICKR_D1, userId, idempotencyKey);
	const allowLinkedCloneDelete = options.allowLinkedCloneDelete === true;
	const requestHash = await hashLifecycleRequest({ kind: "participant_delete", userId, botId, allowLinkedCloneDelete });
	if (existing) {
		return (await beginDeleteLifecycle(context.env.BICKR_D1, {
			ownerUserId: userId,
			idempotencyKey,
			requestHash,
			requestJson: existing.requestJson ?? serializedLifecycleRequest({
				kind: "bot_delete", userId, botId, allowLinkedCloneDelete,
			} satisfies BotDeleteLifecycleRequest),
			entityKind: "bot",
			entityId: botId,
			now: new Date().toISOString(),
		})).operation;
	}
	await assertBotDeleteAllowed(context.env.BICKR_D1, botId, userId, { allowLinkedCloneDelete });
	const clone = Boolean(await context.env.BICKR_D1.prepare(
		"SELECT bot_id AS id FROM bot_clone_sources WHERE bot_id = ? LIMIT 1",
	).bind(botId).first<{ id: string }>());
	const request: BotDeleteLifecycleRequest = {
		kind: clone ? "clone_delete" : "bot_delete",
		userId,
		botId,
		allowLinkedCloneDelete,
	};
	const started = await beginDeleteLifecycle(context.env.BICKR_D1, {
		ownerUserId: userId,
		idempotencyKey,
		requestHash,
		requestJson: serializedLifecycleRequest(request),
		entityKind: "bot",
		entityId: botId,
		now: new Date().toISOString(),
	});
	try {
		await lifecycleCheckpoint(context.coordinator.failureInjector, clone ? "clone.delete.hide.d1" : "bot.delete.hide.d1");
	} catch (error) {
		const failure = classifyLifecycleFailure(error);
		if (failure.retryable) await scheduleUserLifecycleAlarm(context.coordinator);
		else await abortLifecycleDeletion(context.env.BICKR_D1, started.operation, failure, new Date().toISOString());
		throw error;
	}
	return started.operation;
}

export async function runBotDeleteOperation(
	context: LifecycleRuntimeContext,
	initialOperation: LifecycleOperation,
): Promise<void> {
	let operation = await lifecycleOperationById(context.env.BICKR_D1, initialOperation.operationId) ?? initialOperation;
	if (operation.phase === "terminal") return;
	if (operation.phase === "terminal_failed") throw new RepositoryError("conflict", "Participant deletion previously failed terminally.", 409);
	if (!operation.requestJson) throw new RepositoryError("server_error", "Participant deletion request is missing.", 500);
	const request = parseBotDeleteLifecycleRequest(operation.requestJson);
	const prefix = request.kind === "clone_delete" ? "clone" : "bot";
	try {
		await deleteBot(context.env.BICKR_KV, context.env.BICKR_D1, request.botId, request.userId, {
			allowLinkedCloneDelete: request.allowLinkedCloneDelete,
			failurePrefix: prefix,
			checkpoint: (point) => lifecycleCheckpoint(context.coordinator.failureInjector, point),
		});
		await deleteBotVector(context.env, request.botId);
		await lifecycleCheckpoint(context.coordinator.failureInjector, `${prefix}.delete.runtime_vector` as LifecycleFailurePoint);
		const finalizedAt = new Date().toISOString();
		const graphDeletion = await lifecycleUsesInferenceGraph(context.env.BICKR_D1);
		await finalizeLifecycleDeletion(context.env.BICKR_D1, operation, graphDeletion ? {
			kind: "inference_graph",
			entityKind: "bot",
			configurationStatements: await fixedConfigurationDeletionStatements(context.env.BICKR_D1, {
				ownerUserId: request.userId,
				configurationId: await botConfigurationId(request.botId),
				entityKind: "bot",
				now: finalizedAt,
			}),
		} : { kind: "legacy_compatible" }, finalizedAt);
		await lifecycleCheckpoint(context.coordinator.failureInjector, `${prefix}.delete.finish.d1` as LifecycleFailurePoint);
	} catch (error) {
		const deleted = await botDeletionHasStarted(context.env, request.botId);
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
				code: operation.failureCode ?? "participant_deletion_retry_exhausted",
				retryable: false,
			}, new Date().toISOString());
			throw error;
		}
		await scheduleUserLifecycleAlarm(context.coordinator);
		throw error;
	}
}

async function botDeletionHasStarted(
	env: Pick<AgentRuntimeRouteEnv, "BICKR_D1" | "BICKR_KV">,
	botId: string,
): Promise<boolean> {
	const document = await readJson<BotDocument>(env.BICKR_KV, kvKeys.bot(botId));
	if (document?.deletedAt) return true;
	const row = await env.BICKR_D1.prepare("SELECT deleted_at AS deletedAt FROM bots_index WHERE bot_id = ? LIMIT 1")
		.bind(botId).first<{ deletedAt: string | null }>();
	return Boolean(row?.deletedAt);
}

function credentialFreeCreateBotInput(input: CreateBotInput): CredentialFreeCreateBotInput {
	if (!input.inferenceSettings) return input;
	const { openRouterApiKey: _credential, ...inferenceSettings } = input.inferenceSettings;
	return { ...input, inferenceSettings };
}

async function botCreateInputWithLifecycleSecret(
	context: LifecycleRuntimeContext,
	operation: LifecycleOperation,
	input: CredentialFreeCreateBotInput,
): Promise<CreateBotInput> {
	const credential = await lifecycleSecretValue(context.env.BICKR_D1, operation.operationId, "bot_openrouter_api_key");
	return credential === null ? input : {
		...input,
		inferenceSettings: { ...input.inferenceSettings, openRouterApiKey: credential },
	};
}

function parseBotCreateLifecycleRequest(serialized: string): BotCreateLifecycleRequest {
	const value: unknown = JSON.parse(serialized);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new RepositoryError("server_error", "Participant lifecycle request is invalid.", 500);
	const request = value as Partial<BotCreateLifecycleRequest>;
	if ((request.kind !== "bot_create" && request.kind !== "clone_create") || typeof request.userId !== "string" || typeof request.worldId !== "string" || typeof request.worldHandle !== "string" || typeof request.botId !== "string" || typeof request.personalForumId !== "string" || typeof request.createdAt !== "string" || !request.input) {
		throw new RepositoryError("server_error", "Participant lifecycle request is invalid.", 500);
	}
	return request as BotCreateLifecycleRequest;
}

function parseBotDeleteLifecycleRequest(serialized: string): BotDeleteLifecycleRequest {
	const value: unknown = JSON.parse(serialized);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new RepositoryError("server_error", "Participant deletion request is invalid.", 500);
	const request = value as Partial<BotDeleteLifecycleRequest>;
	if (
		(request.kind !== "bot_delete" && request.kind !== "clone_delete") ||
		typeof request.userId !== "string" ||
		typeof request.botId !== "string" ||
		typeof request.allowLinkedCloneDelete !== "boolean"
	) {
		throw new RepositoryError("server_error", "Participant deletion request is invalid.", 500);
	}
	return request as BotDeleteLifecycleRequest;
}

function lifecycleBotImportAvatarKey(worldId: string, botId: string, contentType: AvatarContentType): string {
	const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
	return `worlds/${encodeURIComponent(worldId)}/bots/${encodeURIComponent(botId)}/avatars/lifecycle-import.${extension}`;
}
