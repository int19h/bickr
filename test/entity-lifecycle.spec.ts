import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	activateLifecycleEntity,
	beginLifecycleCompensation,
	cleanupTerminalLifecycleOperations,
	finalizeLifecycleCompensation,
	hashLifecycleRequest,
	lifecycleOperationById,
	reserveCreateLifecycle,
	serializedLifecycleRequest,
} from "@bickr/shared/entity-lifecycle";
import { localizedText, schemaVersion, type UserDocument } from "@bickr/shared/model";
import { userIndexProjectionStatement } from "@bickr/shared/repository";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";

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
});

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
