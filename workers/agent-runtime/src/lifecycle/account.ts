import {
	abortLifecycleDeletion,
	activateLifecycleEntity,
	beginAccountDeleteLifecycle,
	beginLifecycleCompensation,
	classifyLifecycleFailure,
	finalizeLifecycleCompensation,
	finalizeLifecycleDeletion,
	hashLifecycleRequest,
	lifecycleCheckpoint,
	lifecycleIdempotencyKey,
	lifecycleOperationById,
	lifecycleOperationByKey,
	markLifecycleMaterializing,
	nonterminalLifecycleDeleteOperationsByPrefix,
	recordAccountDeleteChildrenContinuation,
	recordAccountDeleteConvergenceFailure as persistAccountDeleteConvergenceFailure,
	recordRetryableLifecycleFailure,
	requiredAccountDeleteLifecycleOperation,
	serializedLifecycleRequest,
	type AccountDeleteLifecycleOperation,
	type LifecycleOperation,
} from "@bickr/shared/entity-lifecycle";
import {
	authProviders,
	localizedText,
	type AccountDeletionResult,
	type AuthProvider,
	type UserDocument,
} from "@bickr/shared/model";
import {
	accountDeletionTargetCounts,
	boundedAccountDeletionTargets,
	publicUser,
	RepositoryError,
	userCoordinatorRepositoryMutations,
	type NormalizedProviderUserProfile,
	type ProviderUserBootstrap,
	type ProviderUserProfile,
} from "@bickr/shared/repository";
import { deleteKey, kvKeys, readJson, writeJson } from "@bickr/shared/storage";
import { requestCoordinatorGovernanceDeletion, scheduleUserLifecycleAlarm } from "./common";
import { reserveBotDelete, runBotDeleteOperation } from "./bot";
import type { LifecycleReservationContext, LifecycleRuntimeContext } from "./types";
import { reserveWorldDelete, runWorldDeleteOperation } from "./world";
import {
	parseAccountBootstrapLifecycleRequest,
} from "./account-bootstrap-reservation";

const {
	providerUserBootstrapActivationStatements,
	refreshNormalizedProviderIdentity,
	softDeleteUserProfile,
} = userCoordinatorRepositoryMutations;

export const accountDeleteChildOperationsPerAttempt = 8;

type AccountDeleteChildResumeResult =
	| { kind: "complete"; processed: number }
	| { kind: "continuation_required" };

type AccountDeleteLifecycleRequest = {
	kind: "account_delete";
	userId: string;
	plannedCounts: { worlds: number; forums: number; bots: number };
};

export async function resumeReservedAccountBootstrapOperation(
	context: LifecycleRuntimeContext,
	initialOperation: LifecycleOperation,
	latestProfile?: NormalizedProviderUserProfile,
): Promise<void> {
	const operation = await lifecycleOperationById(context.env.BICKR_D1, initialOperation.operationId) ?? initialOperation;
	if (operation.phase !== "pending") {
		await runAccountBootstrapOperation(context, operation, latestProfile);
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
	await runAccountBootstrapOperation(context, operation, latestProfile);
}

export async function runAccountBootstrapOperation(
	context: LifecycleRuntimeContext,
	initialOperation: LifecycleOperation,
	latestProfile?: NormalizedProviderUserProfile,
): Promise<void> {
	let operation = await lifecycleOperationById(context.env.BICKR_D1, initialOperation.operationId) ?? initialOperation;
	if (operation.phase === "terminal") {
		if (latestProfile) {
			await refreshNormalizedProviderIdentity(context.env.BICKR_KV, context.env.BICKR_D1, latestProfile);
		}
		return;
	}
	if (operation.phase === "terminal_failed") {
		throw new RepositoryError("conflict", "Account bootstrap previously failed terminally.", 409);
	}
	if (!operation.requestJson) {
		throw new RepositoryError("server_error", "Account lifecycle request is missing.", 500);
	}
	const request = parseAccountBootstrapLifecycleRequest(operation.requestJson);
	const bootstrap = latestProfile ? bootstrapWithLatestProfile(request.bootstrap, latestProfile) : request.bootstrap;
	if (operation.phase === "compensating") {
		await compensateAccountBootstrap(context, operation);
		return;
	}
	try {
		operation = await markLifecycleMaterializing(context.env.BICKR_D1, operation, new Date().toISOString());
		await writeJson(context.env.BICKR_KV, kvKeys.user(operation.entityId), bootstrap.user);
		await lifecycleCheckpoint(context.coordinator.failureInjector, "account.materialize.kv");
		await lifecycleCheckpoint(context.coordinator.failureInjector, "account.activate.d1");
		await activateLifecycleEntity(context.env.BICKR_D1, operation, {
			kind: "legacy_compatible",
			projectionStatements: providerUserBootstrapActivationStatements(context.env.BICKR_D1, bootstrap),
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

function bootstrapWithLatestProfile(
	reserved: ProviderUserBootstrap,
	profile: NormalizedProviderUserProfile,
): ProviderUserBootstrap {
	// The reservation owns identity and timestamps; the provider owns these
	// mutable presentation values until the account becomes active.
	return {
		profile,
		user: {
			...reserved.user,
			displayName: localizedText(profile.displayName ?? profile.login, null),
		},
	};
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
	context: LifecycleReservationContext,
	userId: string,
): Promise<LifecycleOperation> {
	const idempotencyKey = lifecycleIdempotencyKey(context.request);
	const requestIdentity = { kind: "account_delete", userId } as const;
	const requestHash = await hashLifecycleRequest(requestIdentity);
	const existing = await lifecycleOperationByKey(context.env.BICKR_D1, userId, idempotencyKey);
	const counts = existing ? null : await accountDeletionTargetCounts(context.env.BICKR_D1, userId);
	const request: AccountDeleteLifecycleRequest = existing?.requestJson
		? parseAccountDeleteLifecycleRequest(existing.requestJson)
		: {
			kind: "account_delete",
			userId,
			plannedCounts: counts ?? { worlds: 0, forums: 0, bots: 0 },
		};
	const started = await beginAccountDeleteLifecycle(context.env.BICKR_D1, {
		ownerUserId: userId,
		idempotencyKey,
		requestHash,
		requestJson: serializedLifecycleRequest(request),
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
): Promise<AccountDeletionResult> {
	let operation = requiredAccountDeleteLifecycleOperation(
		await lifecycleOperationById(context.env.BICKR_D1, initialOperation.operationId) ?? initialOperation,
	);
	const current = await readJson<UserDocument>(context.env.BICKR_KV, kvKeys.user(operation.entityId));
	if (operation.phase === "terminal") {
		if (!current?.deletedAt) throw new RepositoryError("server_error", "Deleted account document is missing.", 500);
		return {
			kind: "account_delete_complete",
			profile: publicUser(current),
			deleted: { worlds: 0, forums: 0, bots: 0 },
		};
	}
	if (operation.phase === "terminal_failed") {
		throw new RepositoryError("conflict", "Account deletion previously failed terminally.", 409);
	}
	if (!operation.requestJson) throw new RepositoryError("server_error", "Account deletion request is missing.", 500);
	const request = parseAccountDeleteLifecycleRequest(operation.requestJson);
	let childResume: AccountDeleteChildResumeResult;
	try {
		childResume = await resumeAccountDeleteChildOperations(context, operation);
	} catch (error) {
		return recordAccountDeleteFailure(context, operation, request.plannedCounts, error);
	}
	if (childResume.kind === "continuation_required") {
		return continueAccountDeletion(context, operation, request.plannedCounts);
	}
	try {
		const remainingBudget = accountDeleteChildOperationsPerAttempt - childResume.processed;
		const targets = await boundedAccountDeletionTargets(
			context.env.BICKR_D1,
			request.userId,
			Math.max(1, remainingBudget),
		);
		for (const target of targets.slice(0, remainingBudget)) {
			switch (target.kind) {
				case "bot": {
					const childContext = lifecycleChildContext(
						context,
						accountDeleteChildIdempotencyKey(operation, "bot", target.entityId),
					);
					const child = await reserveBotDelete(childContext, request.userId, target.entityId, {
						allowLinkedCloneDelete: true,
					});
					await runBotDeleteOperation(childContext, child);
					break;
				}
				case "forum":
					await requestCoordinatorGovernanceDeletion(
						context.env,
						`/worlds/${encodeURIComponent(target.worldHandle)}/forums/${encodeURIComponent(target.handle)}`,
						request.userId,
					);
					break;
				case "world": {
					const childContext = lifecycleChildContext(
						context,
						accountDeleteChildIdempotencyKey(operation, "world", target.entityId),
					);
					const child = await reserveWorldDelete(childContext, request.userId, target.handle);
					await runWorldDeleteOperation(childContext, child);
					break;
				}
			}
		}
		if ((await boundedAccountDeletionTargets(context.env.BICKR_D1, request.userId, 1)).length > 0) {
			return continueAccountDeletion(context, operation, request.plannedCounts);
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
			kind: "account_delete_complete",
			profile: publicUser(deleted),
			deleted: request.plannedCounts,
		};
	} catch (error) {
		return recordAccountDeleteFailure(context, operation, request.plannedCounts, error);
	}
}

async function resumeAccountDeleteChildOperations(
	context: LifecycleRuntimeContext,
	parent: AccountDeleteLifecycleOperation,
): Promise<AccountDeleteChildResumeResult> {
	const prefix = `account-delete:${parent.operationId}:`;
	const children = await nonterminalLifecycleDeleteOperationsByPrefix(
		context.env.BICKR_D1,
		parent.ownerUserId,
		prefix,
		accountDeleteChildOperationsPerAttempt,
	);
	for (const child of children) {
		switch (child.entityKind) {
			case "bot":
				await runBotDeleteOperation(context, child);
				break;
			case "world":
				await runWorldDeleteOperation(context, child);
				break;
			case "account":
				throw new RepositoryError("server_error", "Account deletion has an invalid child operation.", 500);
		}
	}
	const remaining = await nonterminalLifecycleDeleteOperationsByPrefix(
		context.env.BICKR_D1,
		parent.ownerUserId,
		prefix,
		1,
	);
	return remaining.length === 0
		? { kind: "complete", processed: children.length }
		: { kind: "continuation_required" };
}

async function continueAccountDeletion(
	context: LifecycleRuntimeContext,
	operation: AccountDeleteLifecycleOperation,
	planned: AccountDeleteLifecycleRequest["plannedCounts"],
): Promise<AccountDeletionResult> {
	await recordAccountDeleteChildrenContinuation(
		context.env.BICKR_D1,
		operation,
		new Date().toISOString(),
	);
	await bestEffortAccountDeleteAlarm(context);
	return { kind: "account_delete_pending", planned };
}

async function recordAccountDeleteFailure(
	context: LifecycleRuntimeContext,
	operation: AccountDeleteLifecycleOperation,
	planned: AccountDeleteLifecycleRequest["plannedCounts"],
	error: unknown,
): Promise<AccountDeletionResult> {
	const currentOperation = await lifecycleOperationById(context.env.BICKR_D1, operation.operationId);
	if (currentOperation?.phase === "terminal") {
		const current = await readJson<UserDocument>(context.env.BICKR_KV, kvKeys.user(operation.entityId));
		if (!current?.deletedAt) {
			throw new RepositoryError("server_error", "Deleted account document is missing.", 500);
		}
		return { kind: "account_delete_complete", profile: publicUser(current), deleted: planned };
	}
	const failure = classifyLifecycleFailure(error);
	// Once cascade execution starts, a child coordinator or the account writer
	// may already have committed an irreversible side effect. Keep the parent
	// hidden and resumable regardless of the originating failure's retry flag.
	await persistAccountDeleteConvergenceFailure(context.env.BICKR_D1, operation, {
		category: "external_retryable",
		code: failure.code,
		retryable: true,
	}, new Date().toISOString());
	await bestEffortAccountDeleteAlarm(context);
	return { kind: "account_delete_pending", planned };
}

async function bestEffortAccountDeleteAlarm(context: LifecycleRuntimeContext): Promise<void> {
	try {
		await scheduleUserLifecycleAlarm(context.coordinator);
	} catch (error) {
		// The D1 transition atomically refreshes the indexed global recovery
		// projection. A local alarm is only a latency optimization after that
		// durable write, so its failure must not turn accepted deletion into an
		// owner-visible error.
		console.warn("account deletion local alarm scheduling failed", error);
	}
}

function accountDeleteChildIdempotencyKey(
	operation: AccountDeleteLifecycleOperation,
	kind: "bot" | "world",
	entityId: string,
): string {
	return `account-delete:${operation.operationId}:attempt:${operation.retryCount}:${kind}:${entityId}`;
}

function lifecycleChildContext(
	context: LifecycleRuntimeContext,
	idempotencyKey: string,
): LifecycleReservationContext {
	const userId = context.coordinator.ownerUserId;
	if (!userId) throw new RepositoryError("server_error", "Lifecycle child operation is missing its owner.", 500);
	return {
		request: new Request("https://agent.internal/lifecycle-child", {
			method: "DELETE",
			headers: { "x-bickr-user-id": userId, "idempotency-key": idempotencyKey },
		}),
		env: context.env,
		coordinator: context.coordinator,
	};
}

function parseAccountDeleteLifecycleRequest(serialized: string): AccountDeleteLifecycleRequest {
	const value: unknown = JSON.parse(serialized);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RepositoryError("server_error", "Account deletion request is invalid.", 500);
	}
	const request = value as Partial<AccountDeleteLifecycleRequest>;
	const plannedCounts = request.plannedCounts;
	const countValues = plannedCounts && typeof plannedCounts === "object" && !Array.isArray(plannedCounts)
		? [plannedCounts.worlds, plannedCounts.forums, plannedCounts.bots]
		: [];
	if (
		request.kind !== "account_delete" ||
		typeof request.userId !== "string" ||
		countValues.length !== 3 ||
		!countValues.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
	) {
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
