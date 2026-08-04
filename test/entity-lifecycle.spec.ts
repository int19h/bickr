import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	activateLifecycleEntity,
	abortLifecycleDeletion,
	beginDeleteLifecycle,
	beginLifecycleCompensation,
	claimDueLifecycleRecoveryOwners,
	cleanupTerminalLifecycleOperations,
	finalizeLifecycleCompensation,
	hashLifecycleRequest,
	lifecycleOperationById,
	markLifecycleMaterializing,
	recordAccountDeleteChildrenContinuation,
	recordAccountDeleteConvergenceFailure,
	requiredAccountDeleteLifecycleOperation,
	reserveCreateLifecycle,
	serializedLifecycleRequest,
	type LifecycleOperation,
} from "@bickr/shared/entity-lifecycle";
import { localizedText, schemaVersion, type UserDocument } from "@bickr/shared/model";
import { userIndexProjectionStatement } from "@bickr/shared/repository";
import {
	applyD1LifecycleRecoveryMigration,
	clearKv,
	resetD1Schema,
} from "./helpers/d1-schema";

const now = "2026-08-04T00:00:00.000Z";

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
});

describe("entity lifecycle foundation", () => {
	it("reserves idempotently, rejects request-hash reuse, and activates visibility atomically", async () => {
		const user = testUser("usr_lifecycle", "lifecycle-user");
		const request = { kind: "account_create", subject: "provider-subject" };
		const requestHash = await hashLifecycleRequest(request);
		const reserved = await reserveCreateLifecycle(testEnv.BICKR_D1, {
			ownerUserId: user.id,
			idempotencyKey: "account-key",
			requestHash,
			requestJson: serializedLifecycleRequest(request),
			entityKind: "account",
			entityId: user.id,
			reservations: [
				{ kind: "provider_subject", scope: "github", value: "provider-subject" },
				{ kind: "user_handle", scope: "global", value: user.handle },
			],
			now,
		});
		expect(reserved.created).toBe(true);
		expect((await reserveCreateLifecycle(testEnv.BICKR_D1, {
			ownerUserId: user.id,
			idempotencyKey: "account-key",
			requestHash,
			requestJson: serializedLifecycleRequest(request),
			entityKind: "account",
			entityId: "usr_ignored_on_resume",
			reservations: [],
			now,
		})).operation.operationId).toBe(reserved.operation.operationId);

		await expect(reserveCreateLifecycle(testEnv.BICKR_D1, {
			ownerUserId: user.id,
			idempotencyKey: "account-key",
			requestHash: await hashLifecycleRequest({ ...request, subject: "different" }),
			requestJson: "{}",
			entityKind: "account",
			entityId: user.id,
			reservations: [],
			now,
		})).rejects.toMatchObject({ code: "conflict", status: 409 });

		await activateLifecycleEntity(testEnv.BICKR_D1, reserved.operation, {
			kind: "legacy_compatible",
			projectionStatements: [userIndexProjectionStatement(testEnv.BICKR_D1, user, { lifecycleState: "pending" })],
		}, now);
		const projection = await testEnv.BICKR_D1
			.prepare(`SELECT lifecycle_state AS state FROM users_index WHERE user_id = ?`)
			.bind(user.id)
			.first<{ state: string }>();
		expect(projection?.state).toBe("active");
		expect(await lifecycleOperationById(testEnv.BICKR_D1, reserved.operation.operationId)).toMatchObject({
			phase: "terminal",
			requestJson: null,
		});
	});

	it("makes graph-mode activation require the typed fixed-configuration extension payload", async () => {
		const user = testUser("usr_graph_gate", "graph-gate");
		const reserved = await reserveCreateLifecycle(testEnv.BICKR_D1, {
			ownerUserId: user.id,
			idempotencyKey: "graph-key",
			requestHash: await hashLifecycleRequest({ kind: "account_create" }),
			requestJson: "{}",
			entityKind: "account",
			entityId: user.id,
			reservations: [{ kind: "user_handle", scope: "global", value: user.handle }],
			now,
		});
		await testEnv.BICKR_D1
			.prepare(`UPDATE entity_lifecycle_control SET activation_mode = 'inference_graph_required', updated_at = ? WHERE id = 1`)
			.bind(now)
			.run();
		await expect(activateLifecycleEntity(testEnv.BICKR_D1, reserved.operation, {
			kind: "legacy_compatible",
			projectionStatements: [userIndexProjectionStatement(testEnv.BICKR_D1, user, { lifecycleState: "pending" })],
		}, now)).rejects.toMatchObject({ code: "conflict", status: 409 });
		expect(await testEnv.BICKR_D1.prepare(`SELECT user_id FROM users_index WHERE user_id = ?`).bind(user.id).first()).toBeNull();
	});

	it("keeps a claimed same-id tombstone recreation pending across a crash before activation", async () => {
		const user = testUser("usr_same_id_recreate", "same-id-recreated");
		await userIndexProjectionStatement(testEnv.BICKR_D1, {
			...user,
			handle: `deleted-${user.id}`,
			deletedAt: now,
		}).run();

		await expect(userIndexProjectionStatement(testEnv.BICKR_D1, user).run()).rejects.toThrow();
		const reserved = await reserveCreateLifecycle(testEnv.BICKR_D1, {
			ownerUserId: user.id,
			idempotencyKey: "same-id-recreate",
			requestHash: await hashLifecycleRequest({ kind: "account_create", handle: user.handle }),
			requestJson: "{}",
			entityKind: "account",
			entityId: user.id,
			reservations: [{ kind: "user_handle", scope: "global", value: user.handle }],
			now,
		});
		const pendingProjection = userIndexProjectionStatement(testEnv.BICKR_D1, user, { lifecycleState: "pending" });
		await pendingProjection.run();

		expect(await testEnv.BICKR_D1.prepare(
			`SELECT lifecycle_state AS lifecycleState, deleted_at AS deletedAt
			 FROM users_index WHERE user_id = ?`,
		).bind(user.id).first()).toEqual({ lifecycleState: "pending", deletedAt: null });
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT user_id FROM users_index
			 WHERE user_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active'`,
		).bind(user.id).first()).toBeNull();
		await expect(testEnv.BICKR_D1.prepare(
			`UPDATE users_index SET lifecycle_state = 'active' WHERE user_id = ?`,
		).bind(user.id).run()).rejects.toThrow();

		await activateLifecycleEntity(testEnv.BICKR_D1, reserved.operation, {
			kind: "legacy_compatible",
			projectionStatements: [userIndexProjectionStatement(testEnv.BICKR_D1, user, { lifecycleState: "pending" })],
		}, now);
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT lifecycle_state AS lifecycleState, deleted_at AS deletedAt
			 FROM users_index WHERE user_id = ?`,
		).bind(user.id).first()).toEqual({ lifecycleState: "active", deletedAt: null });
	});

	it("releases terminally compensated unique identities and deletes terminal history in bounded batches", async () => {
		const first = await reserveCreateLifecycle(testEnv.BICKR_D1, {
			ownerUserId: "usr_owner",
			idempotencyKey: "world-first",
			requestHash: await hashLifecycleRequest({ handle: "reusable" }),
			requestJson: "{}",
			entityKind: "world",
			entityId: "wld_first",
			reservations: [{ kind: "world_handle", scope: "global", value: "reusable" }],
			now,
		});
		const compensating = await beginLifecycleCompensation(testEnv.BICKR_D1, first.operation, {
			category: "validation",
			code: "invalid_world",
			retryable: false,
		}, now);
		await finalizeLifecycleCompensation(testEnv.BICKR_D1, compensating, [], now);
		const second = await reserveCreateLifecycle(testEnv.BICKR_D1, {
			ownerUserId: "usr_owner",
			idempotencyKey: "world-second",
			requestHash: await hashLifecycleRequest({ handle: "reusable" }),
			requestJson: "{}",
			entityKind: "world",
			entityId: "wld_second",
			reservations: [{ kind: "world_handle", scope: "global", value: "reusable" }],
			now,
		});
		expect(second.created).toBe(true);
		expect(await cleanupTerminalLifecycleOperations(testEnv.BICKR_D1, "2026-09-04T00:00:00.000Z", 1)).toBe(1);
		expect(await lifecycleOperationById(testEnv.BICKR_D1, first.operation.operationId)).toBeNull();
	});

	it("maintains one indexed recovery lease per nonterminal owner in the operation transaction", async () => {
		const reserved = await reserveCreateLifecycle(testEnv.BICKR_D1, {
			ownerUserId: "usr_recovery_owner",
			idempotencyKey: "recovery-world",
			requestHash: await hashLifecycleRequest({ handle: "recovery-world" }),
			requestJson: "{}",
			entityKind: "world",
			entityId: "wld_recovery",
			reservations: [{ kind: "world_handle", scope: "global", value: "recovery-world" }],
			now,
		});
		expect(await recoveryOwner("usr_recovery_owner")).toMatchObject({
			dueAt: now,
			leaseToken: null,
			leaseExpiresAt: null,
		});
		const plan = await testEnv.BICKR_D1.prepare(
			`EXPLAIN QUERY PLAN
			 SELECT owner_user_id
			 FROM entity_lifecycle_recovery_owners
			 WHERE due_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
			 ORDER BY due_at ASC, owner_user_id ASC
			 LIMIT ?`,
		).bind(now, now, 25).all<{ detail: string }>();
		expect((plan.results ?? []).some((row) => row.detail.includes("entity_lifecycle_recovery_owners_due"))).toBe(true);
		const ownerDuePlan = await testEnv.BICKR_D1.prepare(
			`EXPLAIN QUERY PLAN
			 SELECT COALESCE(next_retry_at, updated_at)
			 FROM entity_lifecycle_operations
			 WHERE owner_user_id = ? AND phase NOT IN ('terminal', 'terminal_failed')
			 ORDER BY COALESCE(next_retry_at, updated_at) ASC, operation_id ASC
			 LIMIT 1`,
		).bind("usr_recovery_owner").all<{ detail: string }>();
		expect((ownerDuePlan.results ?? []).some((row) =>
			row.detail.includes("entity_lifecycle_operations_owner_due"),
		)).toBe(true);
		const ownerNonterminalPlan = await testEnv.BICKR_D1.prepare(
			`EXPLAIN QUERY PLAN
			 SELECT 1
			 FROM entity_lifecycle_operations
			 WHERE owner_user_id = ? AND phase NOT IN ('terminal', 'terminal_failed')
			 LIMIT 1`,
		).bind("usr_recovery_owner").all<{ detail: string }>();
		expect((ownerNonterminalPlan.results ?? []).some((row) =>
			row.detail.includes("entity_lifecycle_operations_owner_phase"),
		)).toBe(true);
		const childPlan = await testEnv.BICKR_D1.prepare(
			`EXPLAIN QUERY PLAN
			 SELECT operation_id
			 FROM entity_lifecycle_operations
			 WHERE owner_user_id = ? AND action = 'delete'
			   AND phase NOT IN ('terminal', 'terminal_failed')
			   AND idempotency_key >= ? AND idempotency_key < ?
			 ORDER BY idempotency_key ASC
			 LIMIT ?`,
		).bind("usr_recovery_owner", "account-delete:prefix:", "account-delete:prefix:\uffff", 8)
			.all<{ detail: string }>();
		expect((childPlan.results ?? []).some((row) =>
			row.detail.includes("owner_user_id=? AND idempotency_key>? AND idempotency_key<?"),
		)).toBe(true);
		expect(await claimDueLifecycleRecoveryOwners(testEnv.BICKR_D1, {
			now,
			leaseToken: "lease-test",
			leaseExpiresAt: "2026-08-04T00:10:00.000Z",
		})).toEqual([{
			ownerUserId: "usr_recovery_owner",
			dueAt: now,
			leaseToken: "lease-test",
			leaseExpiresAt: "2026-08-04T00:10:00.000Z",
		}]);

		await markLifecycleMaterializing(testEnv.BICKR_D1, reserved.operation, "2026-08-04T00:00:01.000Z");
		expect(await recoveryOwner("usr_recovery_owner")).toMatchObject({
			dueAt: "2026-08-04T00:00:01.000Z",
			leaseToken: null,
			leaseExpiresAt: null,
		});
		const compensating = await beginLifecycleCompensation(testEnv.BICKR_D1, reserved.operation, {
			category: "validation",
			code: "stop_recovery_test",
			retryable: false,
		}, "2026-08-04T00:00:02.000Z");
		await finalizeLifecycleCompensation(testEnv.BICKR_D1, compensating, [], "2026-08-04T00:00:03.000Z");
		expect(await recoveryOwner("usr_recovery_owner")).toBeNull();
	});

	it("does not move an entity when compensation receives a stale terminal operation", async () => {
		const reserved = await reserveCreateLifecycle(testEnv.BICKR_D1, {
			ownerUserId: "usr_stale_compensation",
			idempotencyKey: "stale-compensation",
			requestHash: await hashLifecycleRequest({ handle: "stale-compensation" }),
			requestJson: "{}",
			entityKind: "account",
			entityId: "usr_stale_compensation",
			reservations: [{ kind: "user_handle", scope: "global", value: "stale-compensation" }],
			now,
		});
		await testEnv.BICKR_D1.prepare(
			`UPDATE entity_lifecycle_operations
			 SET phase = 'terminal_failed', terminal_at = ?, terminal_cleanup_at = ?
			 WHERE operation_id = ?`,
		).bind(now, "2026-09-03T00:00:00.000Z", reserved.operation.operationId).run();

		const current = await beginLifecycleCompensation(testEnv.BICKR_D1, reserved.operation, {
			category: "validation",
			code: "stale_input",
			retryable: false,
		}, "2026-08-04T00:00:01.000Z");

		expect(current.phase).toBe("terminal_failed");
		expect(await lifecyclePair(reserved.operation.operationId, reserved.operation.entityId)).toMatchObject({
			operationPhase: "terminal_failed",
			entityPhase: "pending",
		});
	});

	it("backfills recovery owners for nonterminal operations committed before migration 0040", async () => {
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare("DROP TRIGGER entity_lifecycle_recovery_after_insert"),
			testEnv.BICKR_D1.prepare("DROP TRIGGER entity_lifecycle_recovery_after_update"),
			testEnv.BICKR_D1.prepare("DROP TRIGGER entity_lifecycle_recovery_after_delete"),
			testEnv.BICKR_D1.prepare("DROP INDEX entity_lifecycle_operations_owner_due"),
			testEnv.BICKR_D1.prepare("DROP INDEX worlds_index_owner_public_lifecycle"),
			testEnv.BICKR_D1.prepare("DROP INDEX bots_index_owner_public_handle"),
			testEnv.BICKR_D1.prepare("DROP TABLE entity_lifecycle_recovery_owners"),
		]);
		await reserveCreateLifecycle(testEnv.BICKR_D1, {
			ownerUserId: "usr_pre_recovery_migration",
			idempotencyKey: "pre-recovery-migration",
			requestHash: await hashLifecycleRequest({ handle: "pre-recovery-migration" }),
			requestJson: "{}",
			entityKind: "world",
			entityId: "wld_pre_recovery_migration",
			reservations: [{ kind: "world_handle", scope: "global", value: "pre-recovery-migration" }],
			now,
		});

		await applyD1LifecycleRecoveryMigration(testEnv.BICKR_D1);

		expect(await recoveryOwner("usr_pre_recovery_migration")).toMatchObject({
			dueAt: now,
			leaseToken: null,
			leaseExpiresAt: null,
		});
	});

	it("rejects wrong-kind and stale account continuations without diverging entity state", async () => {
		const user = testUser("usr_account_continuation", "account-continuation");
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO entity_lifecycle_identity_claims (
				key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
				claim_state, operation_id, created_at, updated_at
			 ) VALUES ('user_handle', 'global', ?, 'account', ?, ?, 'active', NULL, ?, ?)`,
		).bind(user.handle, user.id, user.id, now, now).run();
		await userIndexProjectionStatement(testEnv.BICKR_D1, user).run();
		const started = await beginDeleteLifecycle(testEnv.BICKR_D1, {
			ownerUserId: user.id,
			idempotencyKey: "account-delete-continuation",
			requestHash: await hashLifecycleRequest({ kind: "account_delete", userId: user.id }),
			requestJson: JSON.stringify({
				kind: "account_delete",
				userId: user.id,
				plannedCounts: { worlds: 0, forums: 0, bots: 0 },
			}),
			entityKind: "account",
			entityId: user.id,
			now,
		});
		const accountOperation = requiredAccountDeleteLifecycleOperation(started.operation);
		const wrongKind: LifecycleOperation = { ...started.operation, entityKind: "world" };
		expect(() => requiredAccountDeleteLifecycleOperation(wrongKind)).toThrow();
		const beforeAbort = await lifecyclePair(started.operation.operationId, user.id);
		expect(beforeAbort).toMatchObject({ operationPhase: "deleting", entityPhase: "deleting" });

		await abortLifecycleDeletion(testEnv.BICKR_D1, accountOperation, {
			category: "validation",
			code: "safe_abort",
			retryable: false,
		}, "2026-08-04T00:00:01.000Z");
		const afterAbort = await lifecyclePair(started.operation.operationId, user.id);
		expect(afterAbort).toMatchObject({ operationPhase: "terminal_failed", entityPhase: "active" });
		await expect(recordAccountDeleteChildrenContinuation(
			testEnv.BICKR_D1,
			accountOperation,
			"2026-08-04T00:00:02.000Z",
		)).rejects.toMatchObject({ code: "conflict", status: 409 });
		expect(await lifecyclePair(started.operation.operationId, user.id)).toEqual(afterAbort);
	});

	it("keeps irreversible account deletion convergence out of retry-exhaustion compensation", async () => {
		const user = testUser("usr_account_convergence", "account-convergence");
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO entity_lifecycle_identity_claims (
				key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
				claim_state, operation_id, created_at, updated_at
			 ) VALUES ('user_handle', 'global', ?, 'account', ?, ?, 'active', NULL, ?, ?)`,
		).bind(user.handle, user.id, user.id, now, now).run();
		await userIndexProjectionStatement(testEnv.BICKR_D1, user).run();
		const started = await beginDeleteLifecycle(testEnv.BICKR_D1, {
			ownerUserId: user.id,
			idempotencyKey: "account-convergence",
			requestHash: await hashLifecycleRequest({ kind: "account_delete", userId: user.id }),
			requestJson: "{}",
			entityKind: "account",
			entityId: user.id,
			now,
		});
		let operation = requiredAccountDeleteLifecycleOperation(started.operation);
		for (let retry = 1; retry <= 10; retry += 1) {
			operation = requiredAccountDeleteLifecycleOperation(await recordAccountDeleteConvergenceFailure(
				testEnv.BICKR_D1,
				operation,
				{ category: "external_retryable", code: `child_side_effect_${retry}`, retryable: true },
				new Date(Date.parse(now) + retry * 1_000).toISOString(),
			));
		}
		expect(operation).toMatchObject({
			phase: "deleting",
			retryCount: 10,
			failureCategory: "external_retryable",
			failureCode: "child_side_effect_10",
		});
		expect(await lifecyclePair(operation.operationId, user.id)).toMatchObject({
			operationPhase: "deleting",
			entityPhase: "deleting",
		});
	});
});

async function recoveryOwner(ownerUserId: string) {
	return testEnv.BICKR_D1.prepare(
		`SELECT due_at AS dueAt, lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt
		 FROM entity_lifecycle_recovery_owners WHERE owner_user_id = ?`,
	).bind(ownerUserId).first<{ dueAt: string; leaseToken: string | null; leaseExpiresAt: string | null }>();
}

async function lifecyclePair(operationId: string, entityId: string) {
	return testEnv.BICKR_D1.prepare(
		`SELECT
			operations.phase AS operationPhase,
			operations.revision AS operationRevision,
			entities.phase AS entityPhase,
			entities.revision AS entityRevision
		 FROM entity_lifecycle_operations operations
		 JOIN entity_lifecycle_entities entities
		   ON entities.active_operation_id = operations.operation_id
		 WHERE operations.operation_id = ? AND entities.entity_kind = 'account' AND entities.entity_id = ?`,
	).bind(operationId, entityId).first<{
		operationPhase: string;
		operationRevision: number;
		entityPhase: string;
		entityRevision: number;
	}>();
}

function testUser(id: string, handle: string): UserDocument {
	return {
		id,
		type: "user",
		schemaVersion,
		revision: 1,
		handle,
		language: null,
		displayName: localizedText(handle, null),
		createdAt: now,
		updatedAt: now,
	};
}
