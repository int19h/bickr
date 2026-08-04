import { isD1UniqueConstraintError } from "./d1-errors";
import { makeId, sha256Hex } from "./ids";
import { RepositoryError } from "./repository";
import { InputError } from "./validation";
import type {
	D1DatabaseLike,
	D1PreparedStatementLike,
} from "./storage";

export const lifecycleTerminalRetentionDays = 30;
export const lifecycleRetryLimit = 8;
export const lifecycleRetryDelayMs = 5_000;

export type LifecycleEntityKind = "account" | "world" | "bot";
export type LifecycleAction = "create" | "delete";
export type LifecycleEntityPhase =
	| "pending"
	| "materializing"
	| "active"
	| "deleting"
	| "compensating"
	| "terminal_failed";
export type LifecycleOperationPhase =
	| "pending"
	| "materializing"
	| "active"
	| "deleting"
	| "compensating"
	| "terminal"
	| "terminal_failed";
export type LifecycleFailureCategory =
	| "validation"
	| "conflict"
	| "forbidden"
	| "not_found"
	| "external_retryable"
	| "external_terminal"
	| "retry_exhausted"
	| "internal";

export type LifecycleReservation = {
	kind: "provider_subject" | "user_handle" | "world_handle" | "bot_handle";
	scope: string;
	value: string;
};

export type LifecycleSecret = {
	kind: "bot_openrouter_api_key";
	value: string;
};

export type LifecycleOperation = {
	operationId: string;
	ownerUserId: string;
	idempotencyKey: string;
	requestHash: string;
	requestJson: string | null;
	entityKind: LifecycleEntityKind;
	entityId: string;
	action: LifecycleAction;
	phase: LifecycleOperationPhase;
	revision: number;
	retryCount: number;
	nextRetryAt: string | null;
	failureCategory: LifecycleFailureCategory | null;
	failureCode: string | null;
	createdAt: string;
	updatedAt: string;
	terminalAt: string | null;
	terminalCleanupAt: string | null;
};

type LifecycleOperationRow = {
	operationId: string;
	ownerUserId: string;
	idempotencyKey: string;
	requestHash: string;
	requestJson: string | null;
	entityKind: LifecycleEntityKind;
	entityId: string;
	action: LifecycleAction;
	phase: LifecycleOperationPhase;
	revision: number;
	retryCount: number;
	nextRetryAt: string | null;
	failureCategory: LifecycleFailureCategory | null;
	failureCode: string | null;
	createdAt: string;
	updatedAt: string;
	terminalAt: string | null;
	terminalCleanupAt: string | null;
};

export type LegacyLifecycleTransition = {
	kind: "legacy_compatible";
	projectionStatements?: readonly D1PreparedStatementLike[];
};

export type InferenceGraphActivationTransition =
	| {
			kind: "inference_graph";
			entityKind: "account";
			projectionStatements?: readonly D1PreparedStatementLike[];
			accountDefaultStatement: D1PreparedStatementLike;
			translationReferenceStatement: D1PreparedStatementLike;
	  }
	| {
			kind: "inference_graph";
			entityKind: "world" | "bot";
			projectionStatements?: readonly D1PreparedStatementLike[];
			fixedConfigurationStatement: D1PreparedStatementLike;
	  };

export type LifecycleActivationTransition =
	| LegacyLifecycleTransition
	| InferenceGraphActivationTransition;

export type InferenceGraphDeletionTransition = {
	kind: "inference_graph";
	entityKind: LifecycleEntityKind;
	// Phase 3 supplies the already ordered reparent/consumer-reset/secret/delete
	// statements. They join the same D1 visibility batch below; a second
	// lifecycle wrapper is intentionally impossible.
	configurationStatements: readonly [D1PreparedStatementLike, ...D1PreparedStatementLike[]];
};

export type LifecycleDeletionTransition =
	| LegacyLifecycleTransition
	| InferenceGraphDeletionTransition;

export type LifecycleFailure = {
	category: LifecycleFailureCategory;
	code: string;
	retryable: boolean;
};

export type LifecycleFailurePoint =
	| "account.reserve.d1"
	| "account.materialize.kv"
	| "account.activate.d1"
	| "account.delete.hide.d1"
	| "account.delete.kv"
	| "account.delete.indexes.d1"
	| "account.delete.finish.d1"
	| "world.reserve.d1"
	| "world.materialize.kv"
	| "world.materialize.indexes.d1"
	| "world.materialize.intro_forum"
	| "world.materialize.search"
	| "world.activate.d1"
	| "world.delete.hide.d1"
	| "world.delete.kv"
	| "world.delete.indexes.d1"
	| "world.delete.forum_search"
	| "world.delete.finish.d1"
	| "bot.reserve.d1"
	| "bot.materialize.kv"
	| "bot.materialize.personal_forum"
	| "bot.materialize.indexes.d1"
	| "bot.materialize.import_avatar"
	| "bot.materialize.vector"
	| "bot.activate.d1"
	| "bot.delete.hide.d1"
	| "bot.delete.kv"
	| "bot.delete.indexes.d1"
	| "bot.delete.runtime_vector"
	| "bot.delete.finish.d1"
	| "clone.reserve.d1"
	| "clone.materialize.kv"
	| "clone.materialize.personal_forum"
	| "clone.materialize.indexes.d1"
	| "clone.materialize.vector"
	| "clone.activate.d1"
	| "clone.delete.hide.d1"
	| "clone.delete.kv"
	| "clone.delete.indexes.d1"
	| "clone.delete.runtime_vector"
	| "clone.delete.finish.d1";

export type LifecycleFailureInjector = {
	checkpoint(point: LifecycleFailurePoint): void | Promise<void>;
};

export class InjectedLifecycleFailure extends Error {
	readonly failure: LifecycleFailure;
	readonly point: LifecycleFailurePoint;

	constructor(point: LifecycleFailurePoint, failure: LifecycleFailure) {
		super(`Injected lifecycle failure at ${point}.`);
		this.name = "InjectedLifecycleFailure";
		this.point = point;
		this.failure = failure;
	}
}

const lifecycleFailurePointValues = new Set<string>([
	"account.reserve.d1", "account.materialize.kv", "account.activate.d1",
	"account.delete.hide.d1", "account.delete.kv", "account.delete.indexes.d1", "account.delete.finish.d1",
	"world.reserve.d1", "world.materialize.kv", "world.materialize.indexes.d1",
	"world.materialize.intro_forum", "world.materialize.search", "world.activate.d1",
	"world.delete.hide.d1", "world.delete.kv", "world.delete.indexes.d1", "world.delete.forum_search", "world.delete.finish.d1",
	"bot.reserve.d1", "bot.materialize.kv", "bot.materialize.personal_forum",
	"bot.materialize.indexes.d1", "bot.materialize.import_avatar", "bot.materialize.vector", "bot.activate.d1",
	"bot.delete.hide.d1", "bot.delete.kv", "bot.delete.indexes.d1", "bot.delete.runtime_vector", "bot.delete.finish.d1",
	"clone.reserve.d1", "clone.materialize.kv", "clone.materialize.personal_forum",
	"clone.materialize.indexes.d1", "clone.materialize.vector", "clone.activate.d1",
	"clone.delete.hide.d1", "clone.delete.kv", "clone.delete.indexes.d1", "clone.delete.runtime_vector", "clone.delete.finish.d1",
]);

export function serializedInjectedLifecycleFailure(error: InjectedLifecycleFailure): {
	kind: "injected_lifecycle_failure";
	point: LifecycleFailurePoint;
	failure: LifecycleFailure;
} {
	return { kind: "injected_lifecycle_failure", point: error.point, failure: error.failure };
}

export function injectedLifecycleFailureFromSerialized(value: unknown): InjectedLifecycleFailure | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const failure = record.failure;
	if (
		record.kind !== "injected_lifecycle_failure" ||
		typeof record.point !== "string" ||
		!lifecycleFailurePointValues.has(record.point) ||
		!failure || typeof failure !== "object" || Array.isArray(failure)
	) {
		return null;
	}
	const failureRecord = failure as Record<string, unknown>;
	if (
		typeof failureRecord.category !== "string" ||
		!lifecycleFailureCategories.has(failureRecord.category) ||
		typeof failureRecord.code !== "string" ||
		typeof failureRecord.retryable !== "boolean"
	) {
		return null;
	}
	return new InjectedLifecycleFailure(record.point as LifecycleFailurePoint, {
		category: failureRecord.category as LifecycleFailureCategory,
		code: failureRecord.code,
		retryable: failureRecord.retryable,
	});
}

const lifecycleFailureCategories = new Set<string>([
	"validation", "conflict", "forbidden", "not_found", "external_retryable",
	"external_terminal", "retry_exhausted", "internal",
]);

export async function lifecycleCheckpoint(
	injector: LifecycleFailureInjector | undefined,
	point: LifecycleFailurePoint,
): Promise<void> {
	await injector?.checkpoint(point);
}

export async function hashLifecycleRequest(value: unknown): Promise<string> {
	return sha256Hex(canonicalJson(value));
}

export function serializedLifecycleRequest(value: unknown): string {
	return canonicalJson(value);
}

export function lifecycleIdempotencyKey(request: Request): string {
	const supplied = request.headers.get("idempotency-key")?.trim();
	if (supplied) {
		if (supplied.length > 200) {
			throw new RepositoryError("bad_request", "Idempotency key is too long.", 400);
		}
		return supplied;
	}
	// Legacy callers did not send a key. A generated key preserves their
	// create/delete behavior while every accepted operation still has a stable
	// identity for alarm-driven convergence after this request returns.
	return makeId("opn");
}

export async function reserveCreateLifecycle(
	db: D1DatabaseLike,
	input: {
		ownerUserId: string;
		idempotencyKey: string;
		requestHash: string;
		requestJson: string;
		entityKind: LifecycleEntityKind;
		entityId: string;
		reservations: readonly LifecycleReservation[];
		secrets?: readonly LifecycleSecret[];
		now: string;
	},
): Promise<{ operation: LifecycleOperation; created: boolean }> {
	const existing = await lifecycleOperationByKey(db, input.ownerUserId, input.idempotencyKey);
	if (existing) {
		assertMatchingRequest(existing, input.requestHash, "create");
		return { operation: existing, created: false };
	}

	const operationId = makeId("opn");
	const statements = [
		db
			.prepare(
				`INSERT INTO entity_lifecycle_operations (
					operation_id, owner_user_id, idempotency_key, request_hash, request_json,
					entity_kind, entity_id, action, phase, revision, retry_count,
					next_retry_at, failure_category, failure_code, created_at, updated_at,
					terminal_at, terminal_cleanup_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, 'create', 'pending', 1, 0, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
			)
			.bind(
				operationId,
				input.ownerUserId,
				input.idempotencyKey,
				input.requestHash,
				input.requestJson,
				input.entityKind,
				input.entityId,
				input.now,
				input.now,
			),
		db
			.prepare(
				`INSERT INTO entity_lifecycle_entities (
					entity_kind, entity_id, owner_user_id, phase, revision,
					active_operation_id, created_at, updated_at
				) VALUES (?, ?, ?, 'pending', 1, ?, ?, ?)`,
			)
			.bind(input.entityKind, input.entityId, input.ownerUserId, operationId, input.now, input.now),
		...input.reservations.map((reservation) =>
			db
				.prepare(
					`INSERT INTO entity_lifecycle_identity_claims (
						key_kind, key_scope, key_value, entity_kind, entity_id,
						owner_user_id, claim_state, operation_id, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
				)
				.bind(
					reservation.kind,
					reservation.scope,
					reservation.value,
					input.entityKind,
					input.entityId,
					input.ownerUserId,
					operationId,
					input.now,
					input.now,
				),
		),
		...(input.secrets ?? []).map((secret) =>
			db
				.prepare(
					`INSERT INTO entity_lifecycle_secrets (
						operation_id, secret_kind, secret_value, created_at
					) VALUES (?, ?, ?, ?)`,
				)
				.bind(operationId, secret.kind, secret.value, input.now),
		),
	];

	try {
		await db.batch(statements);
	} catch (error) {
		if (!isD1UniqueConstraintError(error)) {
			throw error;
		}
		const raced = await lifecycleOperationByKey(db, input.ownerUserId, input.idempotencyKey);
		if (raced) {
			assertMatchingRequest(raced, input.requestHash, "create");
			return { operation: raced, created: false };
		}
		throw new RepositoryError("conflict", "That pending entity identity is already reserved.", 409);
	}

	const operation = await lifecycleOperationById(db, operationId);
	if (!operation) {
		throw new RepositoryError("server_error", "Lifecycle reservation was not persisted.", 500);
	}
	return { operation, created: true };
}

export async function beginDeleteLifecycle(
	db: D1DatabaseLike,
	input: {
		ownerUserId: string;
		idempotencyKey: string;
		requestHash: string;
		requestJson: string;
		entityKind: LifecycleEntityKind;
		entityId: string;
		now: string;
	},
): Promise<{ operation: LifecycleOperation; created: boolean }> {
	const existing = await lifecycleOperationByKey(db, input.ownerUserId, input.idempotencyKey);
	if (existing) {
		assertMatchingRequest(existing, input.requestHash, "delete");
		return { operation: existing, created: false };
	}
	if (!(await lifecycleIndexEntityIsActive(db, input.entityKind, input.entityId))) {
		throw new RepositoryError("not_found", `${lifecycleEntityLabel(input.entityKind)} not found.`, 404);
	}
	const operationId = makeId("opn");
	const indexStatement = lifecycleIndexStateStatement(db, input.entityKind, input.entityId, "deleting");
	try {
		const results = await db.batch([
			db
				.prepare(
					`INSERT INTO entity_lifecycle_operations (
						operation_id, owner_user_id, idempotency_key, request_hash, request_json,
						entity_kind, entity_id, action, phase, revision, retry_count,
						next_retry_at, failure_category, failure_code, created_at, updated_at,
						terminal_at, terminal_cleanup_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, 'delete', 'deleting', 1, 0, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
				)
				.bind(
					operationId,
					input.ownerUserId,
					input.idempotencyKey,
					input.requestHash,
					input.requestJson,
					input.entityKind,
					input.entityId,
					input.now,
					input.now,
				),
			db
				.prepare(
					`INSERT INTO entity_lifecycle_entities (
						entity_kind, entity_id, owner_user_id, phase, revision,
						active_operation_id, created_at, updated_at
					) VALUES (?, ?, ?, 'deleting', 1, ?, ?, ?)
					ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
						phase = 'deleting',
						revision = entity_lifecycle_entities.revision + 1,
						active_operation_id = excluded.active_operation_id,
						updated_at = excluded.updated_at
					WHERE entity_lifecycle_entities.owner_user_id = excluded.owner_user_id`,
				)
				.bind(input.entityKind, input.entityId, input.ownerUserId, operationId, input.now, input.now),
			indexStatement,
		]);
		if ((results.at(-1)?.meta?.changes ?? 0) !== 1) {
			throw new RepositoryError("not_found", `${lifecycleEntityLabel(input.entityKind)} not found.`, 404);
		}
	} catch (error) {
		if (error instanceof RepositoryError || !isD1UniqueConstraintError(error)) {
			throw error;
		}
		const raced = await lifecycleOperationByKey(db, input.ownerUserId, input.idempotencyKey);
		if (raced) {
			assertMatchingRequest(raced, input.requestHash, "delete");
			return { operation: raced, created: false };
		}
		throw new RepositoryError("conflict", "A lifecycle operation already owns this deletion.", 409);
	}
	const operation = await lifecycleOperationById(db, operationId);
	if (!operation) {
		throw new RepositoryError("server_error", "Lifecycle deletion was not persisted.", 500);
	}
	return { operation, created: true };
}

export async function markLifecycleMaterializing(
	db: D1DatabaseLike,
	operation: LifecycleOperation,
	now: string,
): Promise<LifecycleOperation> {
	if (operation.phase === "materializing") {
		return operation;
	}
	if (operation.phase !== "pending") {
		return operation;
	}
	await db.batch([
		db
			.prepare(
				`UPDATE entity_lifecycle_operations
				 SET phase = 'materializing', revision = revision + 1, updated_at = ?
				 WHERE operation_id = ? AND phase = 'pending'`,
			)
			.bind(now, operation.operationId),
		db
			.prepare(
				`UPDATE entity_lifecycle_entities
				 SET phase = 'materializing', revision = revision + 1, updated_at = ?
				 WHERE entity_kind = ? AND entity_id = ? AND active_operation_id = ? AND phase = 'pending'`,
			)
			.bind(now, operation.entityKind, operation.entityId, operation.operationId),
	]);
	return requiredLifecycleOperation(db, operation.operationId);
}

export async function activateLifecycleEntity(
	db: D1DatabaseLike,
	operation: LifecycleOperation,
	transition: LifecycleActivationTransition,
	now: string,
): Promise<void> {
	if (operation.phase === "terminal") {
		return;
	}
	if (operation.action !== "create") {
		throw new RepositoryError("server_error", "A delete operation cannot activate an entity.", 500);
	}
	const extensionStatements = await lifecycleActivationExtensionStatements(db, operation.entityKind, transition);
	const projectionStatements = transition.projectionStatements ?? [];
	const cleanupAt = terminalCleanupAt(now);
	const results = await db.batch([
		...projectionStatements,
		...extensionStatements,
		db
			.prepare(
				`UPDATE entity_lifecycle_identity_claims
				 SET claim_state = 'active', operation_id = NULL, updated_at = ?
				 WHERE operation_id = ? AND claim_state = 'pending'`,
			)
			.bind(now, operation.operationId),
		lifecycleIndexStateStatement(db, operation.entityKind, operation.entityId, "active"),
		db
			.prepare(
				`UPDATE entity_lifecycle_entities
				 SET phase = 'active', revision = revision + 1, updated_at = ?
				 WHERE entity_kind = ? AND entity_id = ? AND active_operation_id = ?
				   AND phase IN ('pending', 'materializing')`,
			)
			.bind(now, operation.entityKind, operation.entityId, operation.operationId),
		db.prepare(`DELETE FROM entity_lifecycle_secrets WHERE operation_id = ?`).bind(operation.operationId),
		db
			.prepare(
				`UPDATE entity_lifecycle_operations
				 SET phase = 'terminal', revision = revision + 1, request_json = NULL,
				     next_retry_at = NULL, failure_category = NULL, failure_code = NULL,
				     updated_at = ?, terminal_at = ?, terminal_cleanup_at = ?
				 WHERE operation_id = ? AND action = 'create'
				   AND phase IN ('pending', 'materializing', 'active')`,
			)
			.bind(now, now, cleanupAt, operation.operationId),
	]);
	const indexResult = results[projectionStatements.length + extensionStatements.length + 1];
	if ((indexResult?.meta?.changes ?? 0) !== 1) {
		throw new RepositoryError("server_error", "Lifecycle activation could not expose the entity.", 500);
	}
}

export async function finalizeLifecycleDeletion(
	db: D1DatabaseLike,
	operation: LifecycleOperation,
	transition: LifecycleDeletionTransition,
	now: string,
): Promise<void> {
	if (operation.phase === "terminal") {
		return;
	}
	if (operation.action !== "delete") {
		throw new RepositoryError("server_error", "A create operation cannot finish deletion.", 500);
	}
	const extensionStatements = await lifecycleDeletionExtensionStatements(db, operation.entityKind, transition);
	await db.batch([
		...extensionStatements,
		db
			.prepare(`DELETE FROM entity_lifecycle_identity_claims WHERE entity_kind = ? AND entity_id = ?`)
			.bind(operation.entityKind, operation.entityId),
		db.prepare(`DELETE FROM entity_lifecycle_secrets WHERE operation_id = ?`).bind(operation.operationId),
		db
			.prepare(`DELETE FROM entity_lifecycle_entities WHERE entity_kind = ? AND entity_id = ? AND active_operation_id = ?`)
			.bind(operation.entityKind, operation.entityId, operation.operationId),
		db
			.prepare(
				`UPDATE entity_lifecycle_operations
				 SET phase = 'terminal', revision = revision + 1, request_json = NULL,
				     next_retry_at = NULL, failure_category = NULL, failure_code = NULL,
				     updated_at = ?, terminal_at = ?, terminal_cleanup_at = ?
				 WHERE operation_id = ? AND action = 'delete'
				   AND phase IN ('deleting', 'compensating')`,
			)
			.bind(now, now, terminalCleanupAt(now), operation.operationId),
	]);
}

export async function abortLifecycleDeletion(
	db: D1DatabaseLike,
	operation: LifecycleOperation,
	failure: LifecycleFailure,
	now: string,
): Promise<void> {
	if (operation.action !== "delete") {
		throw new RepositoryError("server_error", "Only a deletion can be aborted.", 500);
	}
	await db.batch([
		lifecycleIndexStateStatement(db, operation.entityKind, operation.entityId, "active"),
		db
			.prepare(
				`UPDATE entity_lifecycle_entities
				 SET phase = 'active', revision = revision + 1, updated_at = ?
				 WHERE entity_kind = ? AND entity_id = ? AND active_operation_id = ?`,
			)
			.bind(now, operation.entityKind, operation.entityId, operation.operationId),
		db
			.prepare(
				`UPDATE entity_lifecycle_operations
				 SET phase = 'terminal_failed', revision = revision + 1, request_json = NULL,
				     next_retry_at = NULL, failure_category = ?, failure_code = ?,
				     updated_at = ?, terminal_at = ?, terminal_cleanup_at = ?
				 WHERE operation_id = ? AND action = 'delete' AND phase NOT IN ('terminal', 'terminal_failed')`,
			)
			.bind(failure.category, failure.code, now, now, terminalCleanupAt(now), operation.operationId),
	]);
}

export async function recordRetryableLifecycleFailure(
	db: D1DatabaseLike,
	operation: LifecycleOperation,
	failure: LifecycleFailure,
	now: string,
): Promise<LifecycleOperation> {
	const retryCount = operation.retryCount + 1;
	const exhausted = retryCount >= lifecycleRetryLimit;
	const category: LifecycleFailureCategory = exhausted ? "retry_exhausted" : failure.category;
	const nextRetryAt = exhausted ? null : new Date(Date.parse(now) + lifecycleRetryDelayMs).toISOString();
	const nextPhase: LifecycleOperationPhase = exhausted ? "compensating" : operation.action === "create" ? "materializing" : "deleting";
	const entityPhase: LifecycleEntityPhase = exhausted ? "compensating" : operation.action === "create" ? "materializing" : "deleting";
	await db.batch([
		db
			.prepare(
				`UPDATE entity_lifecycle_operations
				 SET phase = ?, revision = revision + 1, retry_count = ?, next_retry_at = ?,
				     failure_category = ?, failure_code = ?, updated_at = ?
				 WHERE operation_id = ? AND phase NOT IN ('terminal', 'terminal_failed')`,
			)
			.bind(nextPhase, retryCount, nextRetryAt, category, failure.code, now, operation.operationId),
		db
			.prepare(
				`UPDATE entity_lifecycle_entities
				 SET phase = ?, revision = revision + 1, updated_at = ?
				 WHERE entity_kind = ? AND entity_id = ? AND active_operation_id = ?
				   AND EXISTS (
					SELECT 1 FROM entity_lifecycle_operations operations
					WHERE operations.operation_id = ?
					  AND operations.phase NOT IN ('terminal', 'terminal_failed')
				   )`,
			)
			.bind(entityPhase, now, operation.entityKind, operation.entityId, operation.operationId, operation.operationId),
	]);
	return requiredLifecycleOperation(db, operation.operationId);
}

export async function beginLifecycleCompensation(
	db: D1DatabaseLike,
	operation: LifecycleOperation,
	failure: LifecycleFailure,
	now: string,
): Promise<LifecycleOperation> {
	if (operation.phase === "terminal_failed") {
		return operation;
	}
	await db.batch([
		db
			.prepare(
				`UPDATE entity_lifecycle_operations
				 SET phase = 'compensating', revision = revision + 1, next_retry_at = NULL,
				     failure_category = ?, failure_code = ?, updated_at = ?
				 WHERE operation_id = ? AND phase NOT IN ('terminal', 'terminal_failed')`,
			)
			.bind(failure.category, failure.code, now, operation.operationId),
		db
			.prepare(
				`UPDATE entity_lifecycle_entities
				 SET phase = 'compensating', revision = revision + 1, updated_at = ?
				 WHERE entity_kind = ? AND entity_id = ? AND active_operation_id = ?`,
			)
			.bind(now, operation.entityKind, operation.entityId, operation.operationId),
	]);
	return requiredLifecycleOperation(db, operation.operationId);
}

export async function finalizeLifecycleCompensation(
	db: D1DatabaseLike,
	operation: LifecycleOperation,
	cleanupStatements: readonly D1PreparedStatementLike[],
	now: string,
): Promise<void> {
	if (operation.phase === "terminal_failed") {
		return;
	}
	await db.batch([
		...cleanupStatements,
		db.prepare(`DELETE FROM entity_lifecycle_identity_claims WHERE operation_id = ?`).bind(operation.operationId),
		db.prepare(`DELETE FROM entity_lifecycle_secrets WHERE operation_id = ?`).bind(operation.operationId),
		db
			.prepare(`DELETE FROM entity_lifecycle_entities WHERE entity_kind = ? AND entity_id = ? AND active_operation_id = ?`)
			.bind(operation.entityKind, operation.entityId, operation.operationId),
		db
			.prepare(
				`UPDATE entity_lifecycle_operations
				 SET phase = 'terminal_failed', revision = revision + 1, request_json = NULL,
				     next_retry_at = NULL, updated_at = ?, terminal_at = ?, terminal_cleanup_at = ?
				 WHERE operation_id = ? AND phase = 'compensating'`,
			)
			.bind(now, now, terminalCleanupAt(now), operation.operationId),
	]);
}

export async function lifecycleSecretValue(
	db: D1DatabaseLike,
	operationId: string,
	kind: LifecycleSecret["kind"],
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT secret_value AS value
			 FROM entity_lifecycle_secrets
			 WHERE operation_id = ? AND secret_kind = ?
			 LIMIT 1`,
		)
		.bind(operationId, kind)
		.first<{ value: string }>();
	return row?.value ?? null;
}

export async function lifecycleOperationById(
	db: D1DatabaseLike,
	operationId: string,
): Promise<LifecycleOperation | null> {
	return db
		.prepare(`${lifecycleOperationSelect()} WHERE operation_id = ? LIMIT 1`)
		.bind(operationId)
		.first<LifecycleOperationRow>();
}

export async function lifecycleOperationByKey(
	db: D1DatabaseLike,
	ownerUserId: string,
	idempotencyKey: string,
): Promise<LifecycleOperation | null> {
	return db
		.prepare(`${lifecycleOperationSelect()} WHERE owner_user_id = ? AND idempotency_key = ? LIMIT 1`)
		.bind(ownerUserId, idempotencyKey)
		.first<LifecycleOperationRow>();
}

export async function nextDueLifecycleOperation(
	db: D1DatabaseLike,
	ownerUserId: string,
	now: string,
): Promise<LifecycleOperation | null> {
	return db
		.prepare(
			`${lifecycleOperationSelect()}
			 WHERE owner_user_id = ?
			   AND phase NOT IN ('terminal', 'terminal_failed')
			   AND (next_retry_at IS NULL OR next_retry_at <= ?)
			 ORDER BY created_at ASC, operation_id ASC
			 LIMIT 1`,
		)
		.bind(ownerUserId, now)
		.first<LifecycleOperationRow>();
}

export async function nextLifecycleAlarmAt(
	db: D1DatabaseLike,
	ownerUserId: string,
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT COALESCE(next_retry_at, updated_at) AS alarmAt
			 FROM entity_lifecycle_operations
			 WHERE owner_user_id = ? AND phase NOT IN ('terminal', 'terminal_failed')
			 ORDER BY COALESCE(next_retry_at, updated_at) ASC, operation_id ASC
			 LIMIT 1`,
		)
		.bind(ownerUserId)
		.first<{ alarmAt: string }>();
	return row?.alarmAt ?? null;
}

export async function cleanupTerminalLifecycleOperations(
	db: D1DatabaseLike,
	now: string,
	limit = 100,
): Promise<number> {
	const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
	const result = await db
		.prepare(
			`DELETE FROM entity_lifecycle_operations
			 WHERE operation_id IN (
				SELECT operation_id
				FROM entity_lifecycle_operations
				WHERE terminal_cleanup_at IS NOT NULL AND terminal_cleanup_at <= ?
				ORDER BY terminal_cleanup_at ASC, operation_id ASC
				LIMIT ?
			 )`,
		)
		.bind(now, boundedLimit)
		.run();
	return result.meta?.changes ?? 0;
}

export function classifyLifecycleFailure(error: unknown): LifecycleFailure {
	if (error instanceof InjectedLifecycleFailure) {
		return error.failure;
	}
	if (error instanceof RepositoryError) {
		switch (error.code) {
			case "bad_request":
				return { category: "validation", code: error.code, retryable: false };
			case "conflict":
				return { category: "conflict", code: error.code, retryable: false };
			case "forbidden":
			case "unauthorized":
				return { category: "forbidden", code: error.code, retryable: false };
			case "not_found":
				return { category: "not_found", code: error.code, retryable: false };
			case "server_error":
				return { category: "external_retryable", code: error.code, retryable: true };
		}
	}
	if (error instanceof InputError) {
		return { category: "validation", code: "invalid_external_material", retryable: false };
	}
	if (isD1UniqueConstraintError(error)) {
		return { category: "conflict", code: "d1_unique_conflict", retryable: false };
	}
	const durableObjectError = structuredDurableObjectError(error);
	if (durableObjectError) {
		return {
			category: durableObjectError.retryable ? "external_retryable" : "external_terminal",
			code: durableObjectError.overloaded ? "durable_object_overloaded" : "durable_object_error",
			retryable: durableObjectError.retryable,
		};
	}
	return { category: "internal", code: "unexpected_error", retryable: true };
}

function assertMatchingRequest(
	operation: LifecycleOperation,
	requestHash: string,
	action: LifecycleAction,
): void {
	if (operation.requestHash !== requestHash || operation.action !== action) {
		throw new RepositoryError("conflict", "Idempotency key was already used with different input.", 409);
	}
}

async function requiredLifecycleOperation(
	db: D1DatabaseLike,
	operationId: string,
): Promise<LifecycleOperation> {
	const operation = await lifecycleOperationById(db, operationId);
	if (!operation) {
		throw new RepositoryError("server_error", "Lifecycle operation is missing.", 500);
	}
	return operation;
}

async function lifecycleActivationExtensionStatements(
	db: D1DatabaseLike,
	entityKind: LifecycleEntityKind,
	transition: LifecycleActivationTransition,
): Promise<D1PreparedStatementLike[]> {
	const mode = await lifecycleActivationMode(db);
	if (mode === "legacy_compatible") {
		if (transition.kind !== "legacy_compatible") {
			throw new RepositoryError("conflict", "Inference-graph activation is not enabled.", 409);
		}
		return [];
	}
	if (transition.kind !== "inference_graph" || transition.entityKind !== entityKind) {
		throw new RepositoryError(
			"conflict",
			"Lifecycle activation requires the fixed inference-configuration extension payload.",
			409,
		);
	}
	return transition.entityKind === "account"
		? [transition.accountDefaultStatement, transition.translationReferenceStatement]
		: [transition.fixedConfigurationStatement];
}

async function lifecycleDeletionExtensionStatements(
	db: D1DatabaseLike,
	entityKind: LifecycleEntityKind,
	transition: LifecycleDeletionTransition,
): Promise<D1PreparedStatementLike[]> {
	const mode = await lifecycleActivationMode(db);
	if (mode === "legacy_compatible") {
		if (transition.kind !== "legacy_compatible") {
			throw new RepositoryError("conflict", "Inference-graph deletion is not enabled.", 409);
		}
		return [];
	}
	if (transition.kind !== "inference_graph" || transition.entityKind !== entityKind) {
		throw new RepositoryError(
			"conflict",
			"Lifecycle deletion requires the fixed inference-configuration extension payload.",
			409,
		);
	}
	return [...transition.configurationStatements];
}

async function lifecycleActivationMode(
	db: D1DatabaseLike,
): Promise<"legacy_compatible" | "inference_graph_required"> {
	const row = await db
		.prepare(`SELECT activation_mode AS mode FROM entity_lifecycle_control WHERE id = 1 LIMIT 1`)
		.first<{ mode: "legacy_compatible" | "inference_graph_required" }>();
	if (!row) {
		throw new RepositoryError("server_error", "Lifecycle control row is missing.", 500);
	}
	return row.mode;
}

function lifecycleIndexStateStatement(
	db: D1DatabaseLike,
	entityKind: LifecycleEntityKind,
	entityId: string,
	state: "active" | "deleting",
): D1PreparedStatementLike {
	switch (entityKind) {
		case "account":
			return db
				.prepare(`UPDATE users_index SET lifecycle_state = ? WHERE user_id = ? AND deleted_at IS NULL`)
				.bind(state, entityId);
		case "world":
			return db
				.prepare(`UPDATE worlds_index SET lifecycle_state = ? WHERE world_id = ? AND deleted_at IS NULL`)
				.bind(state, entityId);
		case "bot":
			return db
				.prepare(`UPDATE bots_index SET lifecycle_state = ? WHERE bot_id = ? AND deleted_at IS NULL`)
				.bind(state, entityId);
	}
}

async function lifecycleIndexEntityIsActive(
	db: D1DatabaseLike,
	entityKind: LifecycleEntityKind,
	entityId: string,
): Promise<boolean> {
	const query = (() => {
		switch (entityKind) {
			case "account":
				return `SELECT user_id AS id FROM users_index WHERE user_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active' LIMIT 1`;
			case "world":
				return `SELECT world_id AS id FROM worlds_index WHERE world_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active' LIMIT 1`;
			case "bot":
				return `SELECT bot_id AS id FROM bots_index WHERE bot_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active' LIMIT 1`;
		}
	})();
	return Boolean(await db.prepare(query).bind(entityId).first<{ id: string }>());
}

function lifecycleOperationSelect(): string {
	return `SELECT
		operation_id AS operationId,
		owner_user_id AS ownerUserId,
		idempotency_key AS idempotencyKey,
		request_hash AS requestHash,
		request_json AS requestJson,
		entity_kind AS entityKind,
		entity_id AS entityId,
		action,
		phase,
		revision,
		retry_count AS retryCount,
		next_retry_at AS nextRetryAt,
		failure_category AS failureCategory,
		failure_code AS failureCode,
		created_at AS createdAt,
		updated_at AS updatedAt,
		terminal_at AS terminalAt,
		terminal_cleanup_at AS terminalCleanupAt
	 FROM entity_lifecycle_operations`;
}

function lifecycleEntityLabel(kind: LifecycleEntityKind): string {
	switch (kind) {
		case "account":
			return "Account";
		case "world":
			return "World";
		case "bot":
			return "Bot";
	}
}

function terminalCleanupAt(now: string): string {
	return new Date(Date.parse(now) + lifecycleTerminalRetentionDays * 24 * 60 * 60 * 1_000).toISOString();
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalJsonValue);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalJsonValue(child)]),
		);
	}
	return value;
}

function structuredDurableObjectError(
	error: unknown,
): { retryable: boolean; overloaded: boolean } | null {
	// Cloudflare documents these structured fields on errors crossing a Durable
	// Object boundary. This adapter is the single third-party shape boundary;
	// internal subsystems use the discriminated LifecycleFailure type instead.
	if (!error || typeof error !== "object") {
		return null;
	}
	const candidate = error as { retryable?: unknown; overloaded?: unknown };
	if (typeof candidate.retryable !== "boolean" && typeof candidate.overloaded !== "boolean") {
		return null;
	}
	return {
		retryable: candidate.retryable === true || candidate.overloaded === true,
		overloaded: candidate.overloaded === true,
	};
}
