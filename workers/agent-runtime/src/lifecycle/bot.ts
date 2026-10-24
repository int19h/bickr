import { migrateOwnedContextBudget } from '../context-budget-migration';
import { parseBotCreateLifecycleRequest, type BotCreateLifecycleRequest } from './bot-create-request';
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
	resolveBlockedCreation,
	type BlockedCreationAction,
	type LifecycleFailure,
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
	configurationCredentialValueStatement,
} from "@bickr/shared/inference-configuration-repository";
import { humanSubscriptionScopeDeleteStatements } from "@bickr/shared/human-subscriptions";
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
import { clearBotRuntimeStorage } from "../runtime/runtime-storage-retention";
import { scheduleUserLifecycleAlarm } from "./common";
import type { AgentRuntimeRouteEnv, LifecycleReservationContext, LifecycleRuntimeContext } from "./types";

const { materializeBotCreation, deleteBot, materializePendingBotAvatar } = userCoordinatorRepositoryMutations;

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
	if (operation.phase === "terminal_failed") throw new RepositoryError("conflict", operation.kvRetryState === 'blocked' ? 'Participant creation needs an operator to resume or cancel it.' : 'Participant creation previously failed terminally.', 409);
	if (!operation.requestJson) throw new RepositoryError("server_error", "Participant lifecycle request is missing.", 500);
	let request = parseBotCreateLifecycleRequest(operation.requestJson);
	if (operation.phase === "compensating") {
		// Cleanup never materializes or validates the saved creation budget.
		await compensateBotCreate(context, operation, request);
		return;
	}
	if (operation.kvRetryState === 'retrying' && operation.kvRetryDeadlineAt && Date.now() >= Date.parse(operation.kvRetryDeadlineAt)) {
		await recordRetryableLifecycleFailure(context.env.BICKR_D1, operation, {
			category: 'external_retryable', code: operation.failureCode ?? 'creation_kv_deadline', retryable: true, retryPolicy: 'preserve_creation',
		}, new Date().toISOString());
		throw new RepositoryError('conflict', 'Participant creation needs an operator to resume or cancel it.', 409);
	}
	let stage: 'migration' | 'materialization' = 'migration';
	try {
		// context-budget-minimum-v1: migrate executable state in this owner queue
		// step before replay. Remove this call with the sweep after schemaVersion > 2.
		const migration = await migrateOwnedContextBudget(context.env.BICKR_KV, context.env.BICKR_D1, request.botId, request.userId);
		if (migration.kind === 'missing') throw new RepositoryError('server_error', 'Participant creation migration could not find its lifecycle state.', 500);
		operation = await lifecycleOperationById(context.env.BICKR_D1, operation.operationId) ?? operation;
		if (!operation.requestJson) throw new RepositoryError("server_error", "Participant lifecycle request is missing.", 500);
		request = parseBotCreateLifecycleRequest(operation.requestJson);
		stage = 'materialization';
		operation = await markLifecycleMaterializing(context.env.BICKR_D1, operation, new Date().toISOString());
		const materializationInput = await botCreateInputWithLifecycleSecret(context, operation, request.input);
		const cloneSource = materializationInput.cloneSourceBotId
			? await rawBotById(context.env.BICKR_KV, context.env.BICKR_D1, materializationInput.cloneSourceBotId, true)
			: undefined;
		if (cloneSource && cloneSource.ownerUserId !== request.userId) {
			throw new RepositoryError("forbidden", "You can only clone your own participants.", 403);
		}
		const materialized = await materializeBotCreation(
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
				materialization: { kind: 'lifecycle_snapshot', document: migration.document },
				checkpoint: (point) => lifecycleCheckpoint(context.coordinator.failureInjector, point),
			},
		);
		let bot = materialized.summary;
		const lifecyclePrefix = request.kind === "clone_create" ? "clone" : "bot";
		if (request.input.importSource?.sourceAvatarUrl) {
			bot = await materializeLifecycleImportAvatar(context, operation, request, bot, materialized.document);
			await lifecycleCheckpoint(context.coordinator.failureInjector, "bot.materialize.import_avatar");
		}
		await upsertBotVector(context.env, bot);
		await lifecycleCheckpoint(context.coordinator.failureInjector, `${lifecyclePrefix}.materialize.vector` as LifecycleFailurePoint);
		await lifecycleCheckpoint(context.coordinator.failureInjector, `${lifecyclePrefix}.activate.d1` as LifecycleFailurePoint);
		const activatedAt = new Date().toISOString();
		if (await lifecycleUsesInferenceGraph(context.env.BICKR_D1)) {
			const configurationId = await botConfigurationId(request.botId);
			const credential = await lifecycleSecretValue(context.env.BICKR_D1, operation.operationId, "bot_openrouter_api_key");
			const parentId = request.input.cloneSourceBotId
				? await botConfigurationId(request.input.cloneSourceBotId)
				: await accountDefaultConfigurationId(request.userId);
			await activateLifecycleEntity(context.env.BICKR_D1, operation, {
				kind: "inference_graph",
				entityKind: "bot",
				fixedConfigurationStatement: insertFixedConfigurationStatement(context.env.BICKR_D1, {
					kind: "bot",
					configurationId,
					ownerUserId: request.userId,
					parentId,
					botId: request.botId,
					now: activatedAt,
					overrides: inferenceOverridesFromLegacySettings(request.input.inferenceSettings),
				}),
				...(credential ? { fixedCredentialStatement: configurationCredentialValueStatement(context.env.BICKR_D1, {
					configurationId, ownerUserId: request.userId, secret: credential, now: activatedAt,
				}) } : {}),
			}, activatedAt);
		} else {
			await activateLifecycleEntity(context.env.BICKR_D1, operation, { kind: "legacy_compatible" }, activatedAt);
		}
	} catch (error) {
		// Migration can change the request revision before a later write fails.
		operation = await lifecycleOperationById(context.env.BICKR_D1, operation.operationId) ?? operation;
		const classified = classifyLifecycleFailure(error);
		const failure: LifecycleFailure = stage === 'migration'
			? { category: 'external_retryable', code: classified.code, retryable: true, retryPolicy: 'preserve_creation' }
			: classified;
		const failedAt = new Date().toISOString();
		if (failure.retryable) {
			operation = await recordRetryableLifecycleFailure(context.env.BICKR_D1, operation, failure, failedAt);
			if (operation.kvRetryState === 'blocked') throw new RepositoryError('conflict', 'Participant creation needs an operator to resume or cancel it.', 409);
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

export async function resolveBlockedBotCreation(
	context: LifecycleRuntimeContext, operationId: string, revision: number, action: BlockedCreationAction,
): Promise<{ kind: 'resumed' | 'cancelled' | 'not_blocked'; operationId: string }> {
	const operation = await lifecycleOperationById(context.env.BICKR_D1, operationId);
	if (!operation) throw new RepositoryError('not_found', 'Lifecycle operation was not found.', 404);
	if (operation.ownerUserId !== context.coordinator.ownerUserId) throw new RepositoryError('forbidden', 'The owner coordinator must resolve this operation.', 403);
	if (operation.entityKind !== 'bot' || operation.action !== 'create') throw new RepositoryError('conflict', 'Only participant creations can use this action.', 409);
	if (operation.kvRetryState !== 'blocked') return { kind: 'not_blocked', operationId };
	if (!operation.requestJson) throw new RepositoryError('conflict', 'The blocked creation has no saved request.', 409);
	const request = parseBotCreateLifecycleRequest(operation.requestJson);
	if (request.botId !== operation.entityId || request.userId !== operation.ownerUserId) throw new RepositoryError('conflict', 'The saved creation identity does not match its operation. Repair it before resolution.', 409);
	const resolved = await resolveBlockedCreation(context.env.BICKR_D1, operation, action, revision, new Date().toISOString());
	if (action.kind === 'resume') {
		await scheduleUserLifecycleAlarm(context.coordinator);
		return { kind: 'resumed', operationId };
	}
	// An explicit operator cancellation uses the existing idempotent cleanup.
	await runBotCreateOperation(context, resolved);
	return { kind: 'cancelled', operationId };
}

async function materializeLifecycleImportAvatar(
	context: LifecycleRuntimeContext,
	operation: LifecycleOperation,
	request: BotCreateLifecycleRequest,
	bot: BotSummary,
	document: BotDocument,
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
			document,
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
		document,
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
	// A stale or misfiled document cannot authorize deletion of another asset.
	const avatarPrefix = `worlds/${encodeURIComponent(request.worldId)}/bots/${encodeURIComponent(request.botId)}/avatars/`;
	if (bot?.id === request.botId && bot.ownerUserId === request.userId && bot.homeWorldId === request.worldId && bot.avatar?.key.startsWith(avatarPrefix) && context.env.BICKR_R2) {
		await context.env.BICKR_R2.delete(bot.avatar.key);
	}
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
		...humanSubscriptionScopeDeleteStatements(db, [{ scopeType: "bot", scopeId: request.botId }]),
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
		// A deleted participant keeps its runtime row and therefore its Durable
		// Object, whose loop history now has no reader at all. Clearing it here is
		// what keeps deleted participants from retaining their inner loop forever;
		// a clear that the object refuses (a visit still running) or that fails
		// leaves the marker unset, so this deletion retries and, failing that, the
		// daily retention sweep finishes the job.
		await clearDeletedBotRuntimeStorage(context.env, request.botId);
		await lifecycleCheckpoint(context.coordinator.failureInjector, `${prefix}.delete.runtime_storage` as LifecycleFailurePoint);
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

/**
 * Erase the participant's runtime storage as part of its deletion.
 *
 * A failure here is logged rather than raised: the object refuses the clear
 * while a visit is still in flight, and the daily retention sweep treats every
 * tombstoned participant as a full-clear target until the marker is set. Losing
 * a day of retention is a far better outcome than a deletion that cannot
 * finalize.
 */
async function clearDeletedBotRuntimeStorage(
	env: Pick<AgentRuntimeRouteEnv, "BICKR_D1" | "BOT_RUNTIME" | "INTERNAL_SERVICE_SECRET">,
	botId: string,
): Promise<void> {
	const botRuntime = env.BOT_RUNTIME;
	if (!botRuntime) {
		// Same rule as the search-vector bindings: a harness without the namespace
		// binding cannot reach the object, and deletion must not depend on it.
		return;
	}
	const attempt = await clearBotRuntimeStorage({ ...env, BOT_RUNTIME: botRuntime }, botId);
	if (attempt.status === "failed") {
		console.warn(JSON.stringify({
			event: "bot_delete_runtime_storage_clear_failed",
			botId,
			failure: attempt.failure,
		}));
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

function credentialFreeCreateBotInput(input: CreateBotInput): BotCreateLifecycleRequest["input"] {
	if (!input.inferenceSettings) return input;
	const { openRouterApiKey: _credential, ...inferenceSettings } = input.inferenceSettings;
	return { ...input, inferenceSettings };
}

async function botCreateInputWithLifecycleSecret(
	context: LifecycleRuntimeContext,
	operation: LifecycleOperation,
	input: BotCreateLifecycleRequest["input"],
): Promise<CreateBotInput> {
	const credential = await lifecycleSecretValue(context.env.BICKR_D1, operation.operationId, "bot_openrouter_api_key");
	return credential === null ? input : {
		...input,
		inferenceSettings: { ...input.inferenceSettings, openRouterApiKey: credential },
	};
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
