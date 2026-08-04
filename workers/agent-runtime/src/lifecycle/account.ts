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
	markLifecycleMaterializing,
	recordRetryableLifecycleFailure,
	serializedLifecycleRequest,
	type LifecycleOperation,
} from "@bickr/shared/entity-lifecycle";
import { authProviders, type AuthProvider, type UserDocument } from "@bickr/shared/model";
import {
	listOwnedForumsOutsideOwnedWorlds,
	listOwnedWorlds,
	listUserBots,
	publicUser,
	RepositoryError,
	userCoordinatorRepositoryMutations,
	type ProviderUserProfile,
} from "@bickr/shared/repository";
import { deleteKey, kvKeys, readJson, writeJson } from "@bickr/shared/storage";
import { sortBotsForCascadeDelete } from "../runtime/bot-runtime";
import { requestCoordinatorGovernanceDeletion, scheduleUserLifecycleAlarm } from "./common";
import { reserveBotDelete, runBotDeleteOperation } from "./bot";
import type { AgentRuntimeRouteContext, AgentRuntimeRouteEnv, LifecycleRuntimeContext } from "./types";
import { reserveWorldDelete, runWorldDeleteOperation } from "./world";
import {
	parseAccountBootstrapLifecycleRequest,
} from "./account-bootstrap-reservation";

const {
	providerUserBootstrapActivationStatements,
	softDeleteUserProfile,
} = userCoordinatorRepositoryMutations;

type AccountDeleteLifecycleRequest = {
	kind: "account_delete";
	userId: string;
};

export type AccountDeleteResult = {
	profile: ReturnType<typeof publicUser>;
	deleted: { worlds: number; forums: number; bots: number };
};

export async function resumeReservedAccountBootstrapOperation(
	context: LifecycleRuntimeContext,
	initialOperation: LifecycleOperation,
): Promise<void> {
	const operation = await lifecycleOperationById(context.env.BICKR_D1, initialOperation.operationId) ?? initialOperation;
	if (operation.phase !== "pending") {
		await runAccountBootstrapOperation(context, operation);
		return;
	}
	try {
		await lifecycleCheckpoint(context.coordinator.failureInjector, "account.reserve.d1");
	} catch (error) {
		const failure = classifyLifecycleFailure(error);
		if (failure.retryable) {
			await scheduleUserLifecycleAlarm(context.coordinator);
		} else {
			const compensating = await beginLifecycleCompensation(context.env.BICKR_D1, operation, failure, new Date().toISOString());
			try {
				await compensateAccountBootstrap(context, compensating);
			} catch (compensationError) {
				await scheduleUserLifecycleAlarm(context.coordinator);
				throw compensationError;
			}
		}
		throw error;
	}
	await runAccountBootstrapOperation(context, operation);
}

export async function runAccountBootstrapOperation(
	context: LifecycleRuntimeContext,
	initialOperation: LifecycleOperation,
): Promise<void> {
	let operation = await lifecycleOperationById(context.env.BICKR_D1, initialOperation.operationId) ?? initialOperation;
	if (operation.phase === "terminal") return;
	if (operation.phase === "terminal_failed") {
		throw new RepositoryError("conflict", "Account bootstrap previously failed terminally.", 409);
	}
	if (!operation.requestJson) {
		throw new RepositoryError("server_error", "Account lifecycle request is missing.", 500);
	}
	const request = parseAccountBootstrapLifecycleRequest(operation.requestJson);
	if (operation.phase === "compensating") {
		await compensateAccountBootstrap(context, operation);
		return;
	}
	try {
		operation = await markLifecycleMaterializing(context.env.BICKR_D1, operation, new Date().toISOString());
		await writeJson(context.env.BICKR_KV, kvKeys.user(operation.entityId), request.bootstrap.user);
		await lifecycleCheckpoint(context.coordinator.failureInjector, "account.materialize.kv");
		await lifecycleCheckpoint(context.coordinator.failureInjector, "account.activate.d1");
		await activateLifecycleEntity(context.env.BICKR_D1, operation, {
			kind: "legacy_compatible",
			projectionStatements: providerUserBootstrapActivationStatements(context.env.BICKR_D1, request.bootstrap),
		}, new Date().toISOString());
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
		await compensateAccountBootstrap(context, operation);
		throw error;
	}
}

async function compensateAccountBootstrap(context: LifecycleRuntimeContext, operation: LifecycleOperation): Promise<void> {
	await deleteKey(context.env.BICKR_KV, kvKeys.user(operation.entityId));
	const db = context.env.BICKR_D1;
	await finalizeLifecycleCompensation(db, operation, [
		db.prepare("DELETE FROM provider_identities WHERE user_id = ?").bind(operation.entityId),
		db.prepare("DELETE FROM objects_index WHERE object_id = ? AND object_type = 'user'").bind(operation.entityId),
		db.prepare("DELETE FROM users_index WHERE user_id = ? AND lifecycle_state != 'active'").bind(operation.entityId),
	], new Date().toISOString());
}

export async function reserveAccountDelete(
	context: AgentRuntimeRouteContext,
	userId: string,
): Promise<LifecycleOperation> {
	const request: AccountDeleteLifecycleRequest = { kind: "account_delete", userId };
	const started = await beginDeleteLifecycle(context.env.BICKR_D1, {
		ownerUserId: userId,
		idempotencyKey: lifecycleIdempotencyKey(context.request),
		requestHash: await hashLifecycleRequest(request),
		requestJson: serializedLifecycleRequest(request),
		entityKind: "account",
		entityId: userId,
		now: new Date().toISOString(),
	});
	try {
		await lifecycleCheckpoint(context.coordinator.failureInjector, "account.delete.hide.d1");
	} catch (error) {
		const failure = classifyLifecycleFailure(error);
		if (failure.retryable) await scheduleUserLifecycleAlarm(context.coordinator);
		else await abortLifecycleDeletion(context.env.BICKR_D1, started.operation, failure, new Date().toISOString());
		throw error;
	}
	return started.operation;
}

export async function runAccountDeleteOperation(
	context: LifecycleRuntimeContext,
	initialOperation: LifecycleOperation,
): Promise<AccountDeleteResult> {
	let operation = await lifecycleOperationById(context.env.BICKR_D1, initialOperation.operationId) ?? initialOperation;
	const current = await readJson<UserDocument>(context.env.BICKR_KV, kvKeys.user(operation.entityId));
	if (operation.phase === "terminal") {
		if (!current?.deletedAt) throw new RepositoryError("server_error", "Deleted account document is missing.", 500);
		return { profile: publicUser(current), deleted: { worlds: 0, forums: 0, bots: 0 } };
	}
	if (operation.phase === "terminal_failed") {
		throw new RepositoryError("conflict", "Account deletion previously failed terminally.", 409);
	}
	if (!operation.requestJson) throw new RepositoryError("server_error", "Account deletion request is missing.", 500);
	const request = parseAccountDeleteLifecycleRequest(operation.requestJson);
	try {
		const [ownedBots, ownedForumsOutsideOwnedWorlds, ownedWorlds] = await Promise.all([
			listUserBots(context.env.BICKR_KV, context.env.BICKR_D1, request.userId),
			listOwnedForumsOutsideOwnedWorlds(context.env.BICKR_D1, request.userId),
			listOwnedWorlds(context.env.BICKR_D1, request.userId),
		]);
		for (const bot of sortBotsForCascadeDelete(ownedBots)) {
			const childContext = lifecycleChildContext(context, `account-delete:${operation.operationId}:bot:${bot.id}`);
			const child = await reserveBotDelete(childContext, request.userId, bot.id);
			await runBotDeleteOperation(childContext, child);
		}
		for (const forum of ownedForumsOutsideOwnedWorlds) {
			await requestCoordinatorGovernanceDeletion(
				context.env,
				`/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}`,
				request.userId,
			);
		}
		for (const world of ownedWorlds) {
			const childContext = lifecycleChildContext(context, `account-delete:${operation.operationId}:world:${world.id}`);
			const child = await reserveWorldDelete(childContext, request.userId, world.handle);
			await runWorldDeleteOperation(childContext, child);
		}
		await softDeleteUserProfile(context.env.BICKR_KV, context.env.BICKR_D1, request.userId, {
			now: new Date().toISOString(),
			checkpoint: (point) => lifecycleCheckpoint(context.coordinator.failureInjector, point),
		});
		const deleted = await readJson<UserDocument>(context.env.BICKR_KV, kvKeys.user(request.userId));
		if (!deleted?.deletedAt) throw new RepositoryError("server_error", "Account deletion did not persist its document.", 500);
		await finalizeLifecycleDeletion(context.env.BICKR_D1, operation, { kind: "legacy_compatible" }, new Date().toISOString());
		await lifecycleCheckpoint(context.coordinator.failureInjector, "account.delete.finish.d1");
		return {
			profile: publicUser(deleted),
			deleted: { worlds: ownedWorlds.length, forums: ownedForumsOutsideOwnedWorlds.length, bots: ownedBots.length },
		};
	} catch (error) {
		operation = await recordRetryableLifecycleFailure(context.env.BICKR_D1, operation, {
			category: "external_retryable",
			code: classifyLifecycleFailure(error).code,
			retryable: true,
		}, new Date().toISOString());
		if (operation.phase === "compensating" && !await accountDeletionHasStarted(context.env, request.userId)) {
			await abortLifecycleDeletion(context.env.BICKR_D1, operation, {
				category: "retry_exhausted",
				code: operation.failureCode ?? "account_deletion_retry_exhausted",
				retryable: false,
			}, new Date().toISOString());
			throw error;
		}
		await scheduleUserLifecycleAlarm(context.coordinator);
		throw error;
	}
}

async function accountDeletionHasStarted(
	env: Pick<AgentRuntimeRouteEnv, "BICKR_D1" | "BICKR_KV">,
	userId: string,
): Promise<boolean> {
	const document = await readJson<UserDocument>(env.BICKR_KV, kvKeys.user(userId));
	if (document?.deletedAt) return true;
	const row = await env.BICKR_D1.prepare("SELECT deleted_at AS deletedAt FROM users_index WHERE user_id = ? LIMIT 1")
		.bind(userId).first<{ deletedAt: string | null }>();
	return Boolean(row?.deletedAt);
}

function lifecycleChildContext(context: LifecycleRuntimeContext, idempotencyKey: string): AgentRuntimeRouteContext {
	const userId = context.coordinator.ownerUserId;
	if (!userId) throw new RepositoryError("server_error", "Lifecycle child operation is missing its owner.", 500);
	const url = new URL("https://agent.internal/lifecycle-child");
	return {
		request: new Request(url, { method: "DELETE", headers: { "x-bickr-user-id": userId, "idempotency-key": idempotencyKey } }),
		env: context.env,
		url,
		coordinator: context.coordinator,
		objectId: context.coordinator.objectId,
		match: [] as unknown as RegExpExecArray,
	};
}

function parseAccountDeleteLifecycleRequest(serialized: string): AccountDeleteLifecycleRequest {
	const value: unknown = JSON.parse(serialized);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RepositoryError("server_error", "Account deletion request is invalid.", 500);
	}
	const request = value as Partial<AccountDeleteLifecycleRequest>;
	if (request.kind !== "account_delete" || typeof request.userId !== "string") {
		throw new RepositoryError("server_error", "Account deletion request is invalid.", 500);
	}
	return request as AccountDeleteLifecycleRequest;
}

export function providerProfileFromUnknown(value: unknown): ProviderUserProfile {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RepositoryError("bad_request", "Provider profile is required.", 400);
	}
	const record = value as Record<string, unknown>;
	if (
		typeof record.provider !== "string" || !(authProviders as readonly string[]).includes(record.provider) ||
		typeof record.subject !== "string" || typeof record.login !== "string"
	) {
		throw new RepositoryError("bad_request", "Provider profile is invalid.", 400);
	}
	return {
		provider: record.provider as AuthProvider,
		subject: record.subject,
		login: record.login,
		...(typeof record.displayName === "string" ? { displayName: record.displayName } : {}),
		...(typeof record.email === "string" ? { email: record.email } : {}),
		...(typeof record.avatarUrl === "string" ? { avatarUrl: record.avatarUrl } : {}),
	};
}
