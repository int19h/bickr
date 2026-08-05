import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	activateLifecycleEntity,
	abortLifecycleDeletion,
	beginDeleteLifecycle,
	beginWorldDeleteLifecycle,
	beginAccountDeleteLifecycle,
	beginLifecycleCompensation,
	claimDueLifecycleRecoveryOwners,
	cleanupTerminalLifecycleOperations,
	finalizeLifecycleCompensation,
	finalizeLifecycleDeletion,
	hashLifecycleRequest,
	lifecycleOperationById,
	markLifecycleMaterializing,
	recordAccountDeleteChildrenContinuation,
	recordAccountDeleteConvergenceFailure,
	requiredAccountDeleteLifecycleOperation,
	reserveAccountCreateLifecycle,
	reserveBotCreateLifecycle,
	reserveOwnedCreateLifecycle,
	serializedLifecycleRequest,
	terminalLifecycleCleanupDeleteSql,
	type LifecycleOperation,
} from "@bickr/shared/entity-lifecycle";
import { localizedText, schemaVersion, type LanguageTag, type UserDocument, type WorldDocument } from "@bickr/shared/model";
import type { D1DatabaseLike } from "@bickr/shared/storage";
import {
	configurationCredentialValueStatement,
	fixedConfigurationDeletionStatements,
	inferenceConfigurationMutations,
	insertAccountDefaultConfigurationStatement,
	insertFixedConfigurationStatement,
	insertTranslationSelectionStatement,
} from "@bickr/shared/inference-configuration-repository";
import {
	accountDefaultConfigurationId,
	botConfigurationId,
	worldConfigurationId,
} from "@bickr/shared/inference-configuration-repository";
import {
	deleteBotGroupMembershipsByBotSql,
	userIndexProjectionStatement,
	worldIndexProjectionStatement,
} from "@bickr/shared/repository";
import {
	applyD1LifecycleRecoveryMigration,
	clearKv,
	resetD1Schema,
} from "./helpers/d1-schema";

const now = "2026-08-04T00:00:00.000Z";
const en = "en" as LanguageTag;

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
});

describe("entity lifecycle foundation", () => {
	it("reserves idempotently, rejects request-hash reuse, and activates visibility atomically", async () => {
		const user = testUser("usr_lifecycle", "lifecycle-user");
		const request = { kind: "account_create", subject: "provider-subject" };
		const requestHash = await hashLifecycleRequest(request);
		const reserved = await reserveAccountCreateLifecycle(testEnv.BICKR_D1, {
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
		expect((await reserveAccountCreateLifecycle(testEnv.BICKR_D1, {
			ownerUserId: user.id,
			idempotencyKey: "account-key",
			requestHash,
			requestJson: serializedLifecycleRequest(request),
			entityKind: "account",
			entityId: "usr_ignored_on_resume",
			reservations: [],
			now,
		})).operation.operationId).toBe(reserved.operation.operationId);

		await expect(reserveAccountCreateLifecycle(testEnv.BICKR_D1, {
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
		const reserved = await reserveAccountCreateLifecycle(testEnv.BICKR_D1, {
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

		const configurationId = await accountDefaultConfigurationId(user.id);
		await expect(activateLifecycleEntity(testEnv.BICKR_D1, reserved.operation, {
			kind: "inference_graph",
			entityKind: "account",
			projectionStatements: [userIndexProjectionStatement(testEnv.BICKR_D1, user, { lifecycleState: "pending" })],
			accountDefaultStatement: insertAccountDefaultConfigurationStatement(testEnv.BICKR_D1, {
				configurationId,
				ownerUserId: user.id,
				now,
			}),
			accountCredentialStatement: insertAccountDefaultConfigurationStatement(testEnv.BICKR_D1, {
				configurationId,
				ownerUserId: user.id,
				now,
			}),
			translationReferenceStatement: insertTranslationSelectionStatement(testEnv.BICKR_D1, {
				ownerUserId: user.id,
				configurationId,
				now,
			}),
		}, now)).rejects.toThrow();
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id FROM inference_configurations WHERE configuration_id = ?`,
		).bind(configurationId).first()).toBeNull();
		await activateLifecycleEntity(testEnv.BICKR_D1, reserved.operation, {
			kind: "inference_graph",
			entityKind: "account",
			projectionStatements: [userIndexProjectionStatement(testEnv.BICKR_D1, user, { lifecycleState: "pending" })],
			accountDefaultStatement: insertAccountDefaultConfigurationStatement(testEnv.BICKR_D1, {
				configurationId,
				ownerUserId: user.id,
				now,
			}),
			accountCredentialStatement: configurationCredentialValueStatement(testEnv.BICKR_D1, {
				configurationId,
				ownerUserId: user.id,
				secret: "account-bootstrap-secret",
				now,
			}),
			translationReferenceStatement: insertTranslationSelectionStatement(testEnv.BICKR_D1, {
				ownerUserId: user.id,
				configurationId,
				now,
			}),
		}, now);
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id AS configurationId, kind, parent_id AS parentId
			 FROM inference_configurations WHERE owner_user_id = ?`,
		).bind(user.id).first()).toEqual({ configurationId, kind: "account_default", parentId: null });
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id AS configurationId FROM inference_translation_selections WHERE owner_user_id = ?`,
		).bind(user.id).first()).toEqual({ configurationId });
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT writer_version AS writerVersion, cutover_version AS cutoverVersion
			 FROM inference_graph_users WHERE owner_user_id = ?`,
		).bind(user.id).first()).toEqual({ writerVersion: 1, cutoverVersion: 1 });
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT mode, secret_value AS secret, secret_version AS secretVersion
			 FROM inference_configuration_credentials WHERE configuration_id = ?`,
		).bind(configurationId).first()).toEqual({
			mode: "value",
			secret: "account-bootstrap-secret",
			secretVersion: 1,
		});
	});

	it("atomically activates and deletes a fixed world entry while preserving child intent", async () => {
		const ownerId = "usr_world_graph";
		await seedGraphLifecycleOwner(ownerId, "world-graph-owner");
		const world = testWorld("wld_graph", ownerId, "graph-world");
		const reserved = await reserveOwnedCreateLifecycle(testEnv.BICKR_D1, {
			ownerUserId: ownerId,
			idempotencyKey: "world-graph-create",
			requestHash: await hashLifecycleRequest({ kind: "world_create", worldId: world.id }),
			requestJson: "{}",
			entityKind: "world",
			entityId: world.id,
			reservations: [{ kind: "world_handle", scope: "global", value: world.handle }],
			now,
		});
		await worldIndexProjectionStatement(testEnv.BICKR_D1, world, { lifecycleState: "pending" }).run();
		const rootId = await accountDefaultConfigurationId(ownerId);
		const fixedId = await worldConfigurationId(world.id);
		await expect(activateLifecycleEntity(testEnv.BICKR_D1, reserved.operation, {
			kind: "inference_graph",
			entityKind: "world",
			fixedConfigurationStatement: insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "world",
				configurationId: fixedId,
				ownerUserId: ownerId,
				parentId: "cfg_missing_parent",
				worldId: world.id,
				now,
			}),
		}, now)).rejects.toThrow();
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id FROM inference_configurations WHERE configuration_id = ?`,
		).bind(fixedId).first()).toBeNull();
		await activateLifecycleEntity(testEnv.BICKR_D1, reserved.operation, {
			kind: "inference_graph",
			entityKind: "world",
			fixedConfigurationStatement: insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "world",
				configurationId: fixedId,
				ownerUserId: ownerId,
				parentId: rootId,
				worldId: world.id,
				now,
			}),
		}, now);
		await activateLifecycleEntity(testEnv.BICKR_D1, reserved.operation, {
			kind: "inference_graph",
			entityKind: "world",
			fixedConfigurationStatement: insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "world", configurationId: fixedId, ownerUserId: ownerId, parentId: rootId, worldId: world.id, now,
			}),
		}, now);
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count FROM inference_configurations WHERE world_id = ?`,
		).bind(world.id).first<{ count: number }>())?.count).toBe(1);
		const child = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "World child",
			parentId: fixedId,
			overrides: { temperature: { kind: "value", value: 0 } },
			credential: { mode: "value", secret: "child-secret" },
		}, now);
		const deleting = await beginWorldDeleteLifecycle(testEnv.BICKR_D1, {
			ownerUserId: ownerId,
			idempotencyKey: "world-graph-delete",
			requestHash: await hashLifecycleRequest({ kind: "world_delete", worldId: world.id }),
			requestJson: "{}",
			entityId: world.id,
			now,
		});
		await testEnv.BICKR_D1.prepare(
			`UPDATE worlds_index SET handle = ?, deleted_at = ?, lifecycle_state = 'deleting' WHERE world_id = ?`,
		).bind(`deleted-${world.id}`, now, world.id).run();
		const worldDeleteStatements = await fixedConfigurationDeletionStatements(testEnv.BICKR_D1, {
			ownerUserId: ownerId,
			configurationId: fixedId,
			entityKind: "world",
			now,
		});
		await expect(finalizeLifecycleDeletion(testEnv.BICKR_D1, deleting.operation, {
			kind: "inference_graph",
			entityKind: "world",
			configurationStatements: [...worldDeleteStatements, testEnv.BICKR_D1.prepare(
				`INSERT INTO inference_configuration_credentials
				 SELECT * FROM inference_configuration_credentials WHERE configuration_id = ?`,
			).bind(rootId)],
		}, now)).rejects.toThrow();
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id FROM inference_configurations WHERE configuration_id = ?`,
		).bind(fixedId).first()).not.toBeNull();
		await finalizeLifecycleDeletion(testEnv.BICKR_D1, deleting.operation, {
			kind: "inference_graph",
			entityKind: "world",
			configurationStatements: worldDeleteStatements,
		}, now);
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id FROM inference_configurations WHERE configuration_id = ?`,
		).bind(fixedId).first()).toBeNull();
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT parent_id AS parentId, overrides_json AS overridesJson
			 FROM inference_configurations WHERE configuration_id = ?`,
		).bind(child.id).first<{ parentId: string; overridesJson: string }>())).toEqual({
			parentId: rootId,
			overridesJson: JSON.stringify({ temperature: { kind: "value", value: 0 } }),
		});
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT secret_value AS secret FROM inference_configuration_credentials WHERE configuration_id = ?`,
		).bind(child.id).first<{ secret: string }>())?.secret).toBe("child-secret");
	});

	it("keeps clone-of-clone graph parentage and reparents once when a fixed participant is deleted", async () => {
		const ownerId = "usr_clone_graph";
		await seedGraphLifecycleOwner(ownerId, "clone-graph-owner");
		const world = testWorld("wld_clone_graph", ownerId, "clone-graph-world");
		await seedActiveWorld(world);
		const rootId = await accountDefaultConfigurationId(ownerId);
		const source = await activateGraphBot(ownerId, world, "bot_graph_source", "graph-source", rootId, "source-secret");
		const clone = await activateGraphBot(ownerId, world, "bot_graph_clone", "graph-clone", source, undefined);
		const cloneOfClone = await activateGraphBot(ownerId, world, "bot_graph_clone_two", "graph-clone-two", clone, undefined);
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT parent_id AS parentId FROM inference_configurations WHERE configuration_id = ?`,
		).bind(cloneOfClone).first<{ parentId: string }>())?.parentId).toBe(clone);

		await testEnv.BICKR_D1.prepare(
			`INSERT INTO bot_clone_sources (
				bot_id, source_bot_id, source_world_id, source_world_handle,
				source_handle, cloned_at, linked
			) VALUES ('bot_graph_clone_two', 'bot_graph_clone', ?, ?, 'graph-clone', ?, 1)`,
		).bind(world.id, world.handle, now).run();
		await testEnv.BICKR_D1.prepare(`UPDATE bot_clone_sources SET linked = 0 WHERE bot_id = 'bot_graph_clone_two'`).run();
		await testEnv.BICKR_D1.prepare(`UPDATE bot_clone_sources SET linked = 1 WHERE bot_id = 'bot_graph_clone_two'`).run();
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT parent_id AS parentId FROM inference_configurations WHERE configuration_id = ?`,
		).bind(cloneOfClone).first<{ parentId: string }>())?.parentId).toBe(clone);

		const deleting = await beginDeleteLifecycle(testEnv.BICKR_D1, {
			ownerUserId: ownerId,
			idempotencyKey: "clone-graph-delete",
			requestHash: await hashLifecycleRequest({ kind: "bot_delete", botId: "bot_graph_clone" }),
			requestJson: "{}",
			entityKind: "bot",
			entityId: "bot_graph_clone",
			now,
		});
		await testEnv.BICKR_D1.prepare(
			`UPDATE bots_index SET handle = ?, deleted_at = ?, lifecycle_state = 'deleting' WHERE bot_id = ?`,
		).bind("deleted-bot_graph_clone", now, "bot_graph_clone").run();
		const cloneDeleteStatements = await fixedConfigurationDeletionStatements(testEnv.BICKR_D1, {
			ownerUserId: ownerId,
			configurationId: clone,
			entityKind: "bot",
			now,
		});
		await expect(finalizeLifecycleDeletion(testEnv.BICKR_D1, deleting.operation, {
			kind: "inference_graph",
			entityKind: "bot",
			configurationStatements: [...cloneDeleteStatements, testEnv.BICKR_D1.prepare(
				`INSERT INTO inference_configuration_credentials
				 SELECT * FROM inference_configuration_credentials WHERE configuration_id = ?`,
			).bind(rootId)],
		}, now)).rejects.toThrow();
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT parent_id AS parentId FROM inference_configurations WHERE configuration_id = ?`,
		).bind(cloneOfClone).first<{ parentId: string }>())?.parentId).toBe(clone);
		await finalizeLifecycleDeletion(testEnv.BICKR_D1, deleting.operation, {
			kind: "inference_graph",
			entityKind: "bot",
			configurationStatements: cloneDeleteStatements,
		}, now);
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT parent_id AS parentId FROM inference_configurations WHERE configuration_id = ?`,
		).bind(cloneOfClone).first<{ parentId: string }>())?.parentId).toBe(source);
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id FROM inference_configurations WHERE configuration_id = ?`,
		).bind(clone).first()).toBeNull();
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT secret_value AS secret FROM inference_configuration_credentials WHERE configuration_id = ?`,
		).bind(source).first<{ secret: string }>())?.secret).toBe("source-secret");
	});

	it("keeps a claimed same-id tombstone recreation pending across a crash before activation", async () => {
		const user = testUser("usr_same_id_recreate", "same-id-recreated");
		await userIndexProjectionStatement(testEnv.BICKR_D1, {
			...user,
			handle: `deleted-${user.id}`,
			deletedAt: now,
		}).run();

		await expect(userIndexProjectionStatement(testEnv.BICKR_D1, user).run()).rejects.toThrow();
		const reserved = await reserveAccountCreateLifecycle(testEnv.BICKR_D1, {
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
		await seedLifecycleOwner("usr_owner", "lifecycle-owner");
		const first = await reserveOwnedCreateLifecycle(testEnv.BICKR_D1, {
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
		const second = await reserveOwnedCreateLifecycle(testEnv.BICKR_D1, {
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
		await seedLifecycleOwner("usr_recovery_owner", "recovery-owner");
		const reserved = await reserveOwnedCreateLifecycle(testEnv.BICKR_D1, {
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

	it("uses indexed existence plans for account, world, and participant reservation ordering", async () => {
		const accountPlan = await testEnv.BICKR_D1.prepare(
			`EXPLAIN QUERY PLAN
			 SELECT 1
			 FROM worlds_index AS worlds INDEXED BY worlds_index_owner_public_lifecycle
			 WHERE worlds.created_by_user_id = ?
			   AND EXISTS (
				SELECT 1
				FROM entity_lifecycle_identity_claims AS claims
				     INDEXED BY entity_lifecycle_identity_claims_scope_owner
				WHERE claims.key_kind = 'bot_handle'
				  AND claims.key_scope = worlds.world_id
				  AND claims.owner_user_id <> ?
				LIMIT 1
			   )
			 LIMIT 1`,
		).bind("usr_owner", "usr_owner").all<{ detail: string }>();
		const accountDetails = (accountPlan.results ?? []).map((row) => row.detail);
		expect(accountDetails.some((detail) => detail.includes("worlds_index_owner_public_lifecycle"))).toBe(true);
		expect(accountDetails.some((detail) => detail.includes("entity_lifecycle_identity_claims_scope_owner"))).toBe(true);
		expect(accountDetails.some((detail) =>
			detail.includes("key_kind=? AND key_scope=?"),
		)).toBe(true);

		const worldPlan = await testEnv.BICKR_D1.prepare(
			`EXPLAIN QUERY PLAN
			 SELECT 1
			 FROM entity_lifecycle_identity_claims
			      INDEXED BY entity_lifecycle_identity_claims_scope_owner
			 WHERE key_kind = 'bot_handle' AND key_scope = ?
			 LIMIT 1`,
		).bind("wld_target").all<{ detail: string }>();
		expect((worldPlan.results ?? []).some((row) =>
			row.detail.includes("entity_lifecycle_identity_claims_scope_owner"),
		)).toBe(true);

		const participantPlan = await testEnv.BICKR_D1.prepare(
			`EXPLAIN QUERY PLAN
			 SELECT 1
			 FROM worlds_index worlds
			 JOIN users_index world_owners ON world_owners.user_id = worlds.created_by_user_id
			 WHERE worlds.world_id = ?
			   AND worlds.deleted_at IS NULL AND worlds.lifecycle_state = 'active'
			   AND world_owners.deleted_at IS NULL AND world_owners.lifecycle_state = 'active'`,
		).bind("wld_target").all<{ detail: string }>();
		const participantDetails = (participantPlan.results ?? []).map((row) => row.detail);
		expect(participantDetails.some((detail) => detail.includes("sqlite_autoindex_worlds_index_1"))).toBe(true);
		expect(participantDetails.some((detail) => detail.includes("sqlite_autoindex_users_index_1"))).toBe(true);
	});

	it("uses the operation child-key index for terminal cleanup cascades", async () => {
		const plan = await testEnv.BICKR_D1.prepare(
			`EXPLAIN QUERY PLAN ${terminalLifecycleCleanupDeleteSql}`,
		).bind("2026-09-04T00:00:00.000Z", 100).all<{ detail: string }>();
		const details = (plan.results ?? []).map((row) => row.detail);
		expect(details.some((detail) =>
			/\bSCAN entity_lifecycle_identity_claims\b/u.test(detail),
		)).toBe(false);
		expect(details.some((detail) =>
			detail.startsWith("SEARCH entity_lifecycle_identity_claims ") &&
			detail.includes("entity_lifecycle_identity_claims_operation (operation_id=?)"),
		)).toBe(true);
	});

	it("uses the by-participant index for exact membership cleanup", async () => {
		const plan = await testEnv.BICKR_D1.prepare(
			`EXPLAIN QUERY PLAN ${deleteBotGroupMembershipsByBotSql}`,
		).bind("bot_plan_target").all<{ detail: string }>();
		const details = (plan.results ?? []).map((row) => row.detail);
		expect(details.some((detail) => /\bSCAN bot_group_members\b/u.test(detail))).toBe(false);
		expect(details.some((detail) =>
			detail.startsWith("SEARCH bot_group_members ") &&
			detail.includes("bot_group_members_bot (bot_id=?)"),
		)).toBe(true);
	});

	it("does not move an entity when compensation receives a stale terminal operation", async () => {
		const reserved = await reserveAccountCreateLifecycle(testEnv.BICKR_D1, {
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
		await seedLifecycleOwner("usr_pre_recovery_migration", "pre-recovery-owner");
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare("DROP TRIGGER entity_lifecycle_recovery_after_insert"),
			testEnv.BICKR_D1.prepare("DROP TRIGGER entity_lifecycle_recovery_after_update"),
			testEnv.BICKR_D1.prepare("DROP TRIGGER entity_lifecycle_recovery_after_delete"),
			testEnv.BICKR_D1.prepare("DROP INDEX entity_lifecycle_operations_owner_due"),
			testEnv.BICKR_D1.prepare("DROP INDEX worlds_index_owner_public_lifecycle"),
			testEnv.BICKR_D1.prepare("DROP INDEX bots_index_owner_public_handle"),
			testEnv.BICKR_D1.prepare("DROP TABLE entity_lifecycle_recovery_owners"),
		]);
		await reserveOwnedCreateLifecycle(testEnv.BICKR_D1, {
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
		const started = await beginAccountDeleteLifecycle(testEnv.BICKR_D1, {
			ownerUserId: user.id,
			idempotencyKey: "account-delete-continuation",
			requestHash: await hashLifecycleRequest({ kind: "account_delete", userId: user.id }),
			requestJson: JSON.stringify({
				kind: "account_delete",
				userId: user.id,
				plannedCounts: { worlds: 0, forums: 0, bots: 0 },
			}),
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
		const started = await beginAccountDeleteLifecycle(testEnv.BICKR_D1, {
			ownerUserId: user.id,
			idempotencyKey: "account-convergence",
			requestHash: await hashLifecycleRequest({ kind: "account_delete", userId: user.id }),
			requestJson: "{}",
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

async function seedLifecycleOwner(userId: string, handle: string): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO entity_lifecycle_identity_claims (
			key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
			claim_state, operation_id, created_at, updated_at
		 ) VALUES ('user_handle', 'global', ?, 'account', ?, ?, 'active', NULL, ?, ?)`,
	).bind(handle, userId, userId, now, now).run();
	await userIndexProjectionStatement(testEnv.BICKR_D1, testUser(userId, handle)).run();
}

async function seedGraphLifecycleOwner(userId: string, handle: string): Promise<void> {
	await seedLifecycleOwner(userId, handle);
	const rootId = await accountDefaultConfigurationId(userId);
	await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
		insertAccountDefaultConfigurationStatement(testEnv.BICKR_D1, {
			configurationId: rootId,
			ownerUserId: userId,
			now,
		}),
		insertTranslationSelectionStatement(testEnv.BICKR_D1, {
			ownerUserId: userId,
			configurationId: rootId,
			now,
		}),
		testEnv.BICKR_D1.prepare(
			`UPDATE entity_lifecycle_control SET activation_mode = 'inference_graph_required', updated_at = ? WHERE id = 1`,
		).bind(now),
	]);
}

async function seedActiveWorld(world: WorldDocument): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO entity_lifecycle_identity_claims (
			key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
			claim_state, operation_id, created_at, updated_at
		) VALUES ('world_handle', 'global', ?, 'world', ?, ?, 'active', NULL, ?, ?)`,
	).bind(world.handle, world.id, world.createdByUserId, now, now).run();
	await worldIndexProjectionStatement(testEnv.BICKR_D1, world).run();
}

async function activateGraphBot(
	ownerUserId: string,
	world: WorldDocument,
	botId: string,
	handle: string,
	parentId: string,
	secret: string | undefined,
): Promise<string> {
	const reserved = await reserveBotCreateLifecycle(testEnv.BICKR_D1, {
		ownerUserId,
		idempotencyKey: `create-${botId}`,
		requestHash: await hashLifecycleRequest({ kind: "bot_create", botId }),
		requestJson: "{}",
		entityKind: "bot",
		entityId: botId,
		worldId: world.id,
		reservations: [{ kind: "bot_handle", scope: world.id, value: handle }],
		...(secret ? { secrets: [{ kind: "bot_openrouter_api_key" as const, value: secret }] } : {}),
		now,
	});
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO bots_index (
			bot_id, home_world_id, home_world_handle, handle, display_name,
			owner_user_id, short_bio, created_at, updated_at, lifecycle_state
		) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 'pending')`,
	).bind(botId, world.id, world.handle, handle, handle, ownerUserId, now, now).run();
	const configurationId = await botConfigurationId(botId);
	await activateLifecycleEntity(testEnv.BICKR_D1, reserved.operation, {
		kind: "inference_graph",
		entityKind: "bot",
		fixedConfigurationStatement: insertFixedConfigurationStatement(testEnv.BICKR_D1, {
			kind: "bot",
			configurationId,
			ownerUserId,
			parentId,
			botId,
			now,
		}),
	}, now);
	return configurationId;
}

function testWorld(id: string, ownerUserId: string, handle: string): WorldDocument {
	return {
		id,
		type: "world",
		schemaVersion,
		revision: 1,
		handle,
		language: en,
		name: localizedText(handle, en),
		description: localizedText("Graph lifecycle world", en),
		prompt: localizedText("World prompt", en),
		recurringPromptEnabled: false,
		recurringPrompt: localizedText("", en),
		initialBotNotification: localizedText("", en),
		createdByUserId: ownerUserId,
		visibility: "public",
		createdAt: now,
		updatedAt: now,
	};
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
