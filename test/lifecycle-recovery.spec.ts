import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExclusiveOperationQueue } from "@bickr/shared/exclusive-operation-queue";
import {
	cleanupTerminalLifecycleOperations,
	lifecycleRecoveryLeaseMs,
	lifecycleOperationById,
	markLifecycleMaterializing,
	recordAccountDeleteChildrenContinuation,
	requiredAccountDeleteLifecycleOperation,
	type LifecycleOperation,
} from "@bickr/shared/entity-lifecycle";
import {
	internalServiceAuthHeader,
	isTrustedInternalServiceRequest,
} from "@bickr/shared/internal-service";
import { localizedText } from "@bickr/shared/model";
import { parseLanguageTag } from "@bickr/shared/validation";
import { reserveAccountDelete } from "../workers/agent-runtime/src/lifecycle/account";
import { reserveOrJoinAccountBootstrap } from "../workers/agent-runtime/src/lifecycle/account-bootstrap-reservation";
import { reserveBotCreate, reserveBotDelete } from "../workers/agent-runtime/src/lifecycle/bot";
import {
	recoverDueLifecycleOwners,
	type LifecycleRecoveryCoordinatorNamespace,
} from "../workers/agent-runtime/src/lifecycle/recovery";
import type {
	AgentRuntimeRouteContext,
	AgentRuntimeRouteEnv,
	UserBotsCoordinatorStorage,
} from "../workers/agent-runtime/src/lifecycle/types";
import { reserveWorldCreate, reserveWorldDelete } from "../workers/agent-runtime/src/lifecycle/world";
import { handleAgentRuntimeRequest } from "../workers/agent-runtime/src/routes";
import { handleForumCoordinatorRequest } from "../workers/forum-coordinator/src/index";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";
import { createBot, createWorld, upsertProviderUser } from "./helpers/coordinator-mutations";

const internalSecret = "lifecycle-recovery-test-secret";

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
});

describe("hard-interruption lifecycle recovery", () => {
	it("recovers every create/delete kind and account continuation without a catch-path alarm", async () => {
		const routeEnv = recoveryRouteEnv();
		const entries: Array<{
			label: string;
			ownerUserId: string;
			operation: LifecycleOperation;
			storage: TestUserStorage;
		}> = [];

		const accountCreateStorage = testUserStorage();
		const accountReservation = await reserveOrJoinAccountBootstrap(testEnv.BICKR_D1, {
			candidateUserId: "usr_recovery_account_create",
			idempotencyKey: "hard-account-create",
			profile: { provider: "github", subject: "hard-account-create", login: "hard-account-create" },
			now: new Date().toISOString(),
		});
		if (accountReservation.kind !== "pending") throw new Error("Expected pending account reservation.");
		entries.push({
			label: "account create",
			ownerUserId: accountReservation.userId,
			operation: accountReservation.operation,
			storage: accountCreateStorage,
		});

		const worldCreateOwner = await seedAccount("hard-world-create");
		const worldCreateStorage = testUserStorage();
		let worldCreate = await reserveWorldCreate(
			reserveContext(routeEnv, worldCreateOwner.id, "/worlds", "POST", "hard-world-create", worldCreateStorage),
			worldCreateOwner.id,
			worldInput("hard-world-create"),
		);
		worldCreate = await markLifecycleMaterializing(testEnv.BICKR_D1, worldCreate, new Date().toISOString());
		entries.push({ label: "world create", ownerUserId: worldCreateOwner.id, operation: worldCreate, storage: worldCreateStorage });

		const worldDeleteOwner = await seedAccount("hard-world-delete");
		const deletedWorld = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("hard-world-delete"), worldDeleteOwner.id);
		const worldDeleteStorage = testUserStorage();
		const worldDelete = await reserveWorldDelete(
			reserveContext(routeEnv, worldDeleteOwner.id, `/worlds/${deletedWorld.handle}`, "DELETE", "hard-world-delete", worldDeleteStorage),
			worldDeleteOwner.id,
			deletedWorld.handle,
		);
		entries.push({ label: "world delete", ownerUserId: worldDeleteOwner.id, operation: worldDelete, storage: worldDeleteStorage });

		const botCreateOwner = await seedAccount("hard-bot-create");
		const botCreateWorld = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("hard-bot-create-home"), botCreateOwner.id);
		const botCreateStorage = testUserStorage();
		const botCreate = await reserveBotCreate(
			reserveContext(routeEnv, botCreateOwner.id, `/worlds/${botCreateWorld.handle}/bots`, "POST", "hard-bot-create", botCreateStorage),
			botCreateOwner.id,
			botCreateWorld.handle,
			botInput("hard-bot-create"),
		);
		entries.push({ label: "bot create", ownerUserId: botCreateOwner.id, operation: botCreate, storage: botCreateStorage });

		const cloneCreateOwner = await seedAccount("hard-clone-create");
		const cloneCreateWorld = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("hard-clone-create-home"), cloneCreateOwner.id);
		const cloneCreateSource = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, cloneCreateWorld.handle, botInput("hard-clone-source"), cloneCreateOwner.id);
		const cloneCreateStorage = testUserStorage();
		let cloneCreate = await reserveBotCreate(
			reserveContext(routeEnv, cloneCreateOwner.id, `/worlds/${cloneCreateWorld.handle}/bots`, "POST", "hard-clone-create", cloneCreateStorage),
			cloneCreateOwner.id,
			cloneCreateWorld.handle,
			botInput("hard-clone-create", cloneCreateSource.id),
		);
		cloneCreate = await markLifecycleMaterializing(testEnv.BICKR_D1, cloneCreate, new Date().toISOString());
		entries.push({ label: "clone create", ownerUserId: cloneCreateOwner.id, operation: cloneCreate, storage: cloneCreateStorage });

		const botDeleteOwner = await seedAccount("hard-bot-delete");
		const botDeleteWorld = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("hard-bot-delete-home"), botDeleteOwner.id);
		const deletedBot = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, botDeleteWorld.handle, botInput("hard-bot-delete"), botDeleteOwner.id);
		const botDeleteStorage = testUserStorage();
		const botDelete = await reserveBotDelete(
			reserveContext(routeEnv, botDeleteOwner.id, `/bots/${deletedBot.id}`, "DELETE", "hard-bot-delete", botDeleteStorage),
			botDeleteOwner.id,
			deletedBot.id,
		);
		entries.push({ label: "bot delete", ownerUserId: botDeleteOwner.id, operation: botDelete, storage: botDeleteStorage });

		const cloneDeleteOwner = await seedAccount("hard-clone-delete");
		const cloneDeleteWorld = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("hard-clone-delete-home"), cloneDeleteOwner.id);
		const cloneDeleteSource = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, cloneDeleteWorld.handle, botInput("hard-clone-delete-source"), cloneDeleteOwner.id);
		const deletedClone = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, cloneDeleteWorld.handle, botInput("hard-clone-delete", cloneDeleteSource.id), cloneDeleteOwner.id);
		const cloneDeleteStorage = testUserStorage();
		const cloneDelete = await reserveBotDelete(
			reserveContext(routeEnv, cloneDeleteOwner.id, `/bots/${deletedClone.id}`, "DELETE", "hard-clone-delete", cloneDeleteStorage),
			cloneDeleteOwner.id,
			deletedClone.id,
		);
		entries.push({ label: "clone delete", ownerUserId: cloneDeleteOwner.id, operation: cloneDelete, storage: cloneDeleteStorage });

		const accountDeleteOwner = await seedAccount("hard-account-delete");
		const accountDeleteStorage = testUserStorage();
		const accountDelete = await reserveAccountDelete(
			reserveContext(routeEnv, accountDeleteOwner.id, "/profile", "DELETE", "hard-account-delete", accountDeleteStorage),
			accountDeleteOwner.id,
		);
		entries.push({ label: "account delete", ownerUserId: accountDeleteOwner.id, operation: accountDelete, storage: accountDeleteStorage });

		const continuationOwner = await seedAccount("hard-account-continuation");
		const continuationStorage = testUserStorage();
		const continuationDelete = await reserveAccountDelete(
			reserveContext(routeEnv, continuationOwner.id, "/profile", "DELETE", "hard-account-continuation", continuationStorage),
			continuationOwner.id,
		);
		const continuation = await recordAccountDeleteChildrenContinuation(
			testEnv.BICKR_D1,
			requiredAccountDeleteLifecycleOperation(continuationDelete),
			new Date().toISOString(),
		);
		entries.push({ label: "account continuation", ownerUserId: continuationOwner.id, operation: continuation, storage: continuationStorage });

		for (const entry of entries) {
			expect(entry.storage.setAlarm, `${entry.label} unexpectedly armed a catch-path alarm`).not.toHaveBeenCalled();
			expect(await lifecycleOperationById(testEnv.BICKR_D1, entry.operation.operationId)).toMatchObject({
				operationId: entry.operation.operationId,
				ownerUserId: entry.ownerUserId,
			});
			expect(await recoveryOwnerCount(entry.ownerUserId), `${entry.label} has no durable recovery owner`).toBe(1);
		}
		expect(await testEnv.BICKR_KV.get(`v1:user:${accountReservation.userId}`)).toBeNull();
		expect(await testEnv.BICKR_KV.get(`v1:world:${worldCreate.entityId}`)).toBeNull();
		expect(await testEnv.BICKR_KV.get(`v1:bot:${botCreate.entityId}`)).toBeNull();
		expect(await testEnv.BICKR_KV.get(`v1:bot:${cloneCreate.entityId}`)).toBeNull();
		await expectLifecycleProjection("worlds_index", "world_id", worldDelete.entityId, "deleting", false);
		await expectLifecycleProjection("bots_index", "bot_id", botDelete.entityId, "deleting", false);
		await expectLifecycleProjection("bots_index", "bot_id", cloneDelete.entityId, "deleting", false);
		await expectLifecycleProjection("users_index", "user_id", accountDelete.entityId, "deleting", false);
		await expectLifecycleProjection("users_index", "user_id", continuation.entityId, "deleting", false);

		const namedOwners: string[] = [];
		const namespace = recoveryNamespace(routeEnv, new Map(entries.map((entry) => [entry.ownerUserId, entry.storage])), namedOwners);
		const result = await recoverDueLifecycleOwners({
			BICKR_D1: testEnv.BICKR_D1,
			USER_BOTS: namespace,
			INTERNAL_SERVICE_SECRET: internalSecret,
		}, Date.now() + 10_000, { limit: 25 });
		expect(result).toEqual({ claimed: entries.length, dispatched: entries.length, failed: 0, maintenanceDeferred: false });
		expect(namedOwners.toSorted()).toEqual(entries.map((entry) => entry.ownerUserId).toSorted());
		for (const entry of entries) {
			expect(await lifecycleOperationById(testEnv.BICKR_D1, entry.operation.operationId), entry.label)
				.toMatchObject({ phase: "terminal" });
			expect(await recoveryOwnerCount(entry.ownerUserId), entry.label).toBe(0);
		}
		await expectLifecycleProjection("users_index", "user_id", accountReservation.userId, "active", false);
		await expectLifecycleProjection("worlds_index", "world_id", worldCreate.entityId, "active", false);
		await expectLifecycleProjection("worlds_index", "world_id", worldDelete.entityId, "deleting", true);
		await expectLifecycleProjection("bots_index", "bot_id", botCreate.entityId, "active", false);
		await expectLifecycleProjection("bots_index", "bot_id", cloneCreate.entityId, "active", false);
		await expectLifecycleProjection("bots_index", "bot_id", botDelete.entityId, "deleting", true);
		await expectLifecycleProjection("bots_index", "bot_id", cloneDelete.entityId, "deleting", true);
		await expectLifecycleProjection("users_index", "user_id", accountDelete.entityId, "deleting", true);
		await expectLifecycleProjection("users_index", "user_id", continuation.entityId, "deleting", true);
	});

	it("leases a poisoned owner so a later due owner is not starved", async () => {
		const poison = await pendingAccount("usr_a_poison", "poison-subject");
		const healthy = await pendingAccount("usr_b_healthy", "healthy-subject");
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO entity_lifecycle_operations (
				operation_id, owner_user_id, idempotency_key, request_hash, request_json,
				entity_kind, entity_id, action, phase, revision, retry_count,
				next_retry_at, failure_category, failure_code, created_at, updated_at,
				terminal_at, terminal_cleanup_at
			 ) VALUES (
				'opn_poison_terminal_history', ?, 'poison-terminal-history', 'terminal-history', NULL,
				'account', 'usr_poison_terminal_history', 'create', 'terminal', 2, 0,
				NULL, NULL, NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:01.000Z',
				'2026-06-01T00:00:01.000Z', '2026-07-01T00:00:01.000Z'
			 )`,
		).bind(poison.userId).run();
		const routeEnv = recoveryRouteEnv();
		const poisonStorage = testUserStorage();
		const healthyStorage = testUserStorage();
		const namedOwners: string[] = [];
		const realNamespace = recoveryNamespace(routeEnv, new Map([
			[poison.userId, poisonStorage],
			[healthy.userId, healthyStorage],
		]), namedOwners);
		let poisonDispatch = true;
		const namespace: LifecycleRecoveryCoordinatorNamespace<string> = {
			idFromName: (ownerUserId) => {
				namedOwners.push(ownerUserId);
				return ownerUserId;
			},
			get: (ownerUserId) => ownerUserId === poison.userId && poisonDispatch
				? { fetch: async () => { throw new Error("poisoned owner"); } }
				: realNamespace.get(ownerUserId),
		};
		const scheduledTime = Date.now() + 1_000;
		expect(await recoverDueLifecycleOwners({
			BICKR_D1: testEnv.BICKR_D1,
			USER_BOTS: namespace,
			INTERNAL_SERVICE_SECRET: internalSecret,
		}, scheduledTime, { limit: 1, leaseMs: lifecycleRecoveryLeaseMs })).toEqual({
			claimed: 1, dispatched: 0, failed: 1, maintenanceDeferred: false,
		});
		const poisonLease = await recoveryOwner(poison.userId);
		expect(poisonLease).toMatchObject({
			leaseToken: expect.any(String),
			leaseExpiresAt: expect.any(String),
		});
		expect(await cleanupTerminalLifecycleOperations(
			testEnv.BICKR_D1,
			new Date(scheduledTime).toISOString(),
			1,
		)).toBe(1);
		expect(await recoveryOwner(poison.userId)).toEqual(poisonLease);
		expect(await recoverDueLifecycleOwners({
			BICKR_D1: testEnv.BICKR_D1,
			USER_BOTS: namespace,
			INTERNAL_SERVICE_SECRET: internalSecret,
		}, scheduledTime, { limit: 1, leaseMs: lifecycleRecoveryLeaseMs })).toEqual({
			claimed: 1, dispatched: 1, failed: 0, maintenanceDeferred: false,
		});
		expect(await lifecycleOperationById(testEnv.BICKR_D1, poison.operation.operationId)).toMatchObject({ phase: "pending" });
		expect(await lifecycleOperationById(testEnv.BICKR_D1, healthy.operation.operationId)).toMatchObject({ phase: "terminal" });
		poisonDispatch = false;
		expect(await recoverDueLifecycleOwners({
			BICKR_D1: testEnv.BICKR_D1,
			USER_BOTS: namespace,
			INTERNAL_SERVICE_SECRET: internalSecret,
		}, scheduledTime + lifecycleRecoveryLeaseMs + 1, {
			limit: 1,
			leaseMs: lifecycleRecoveryLeaseMs,
		})).toEqual({
			claimed: 1, dispatched: 1, failed: 0, maintenanceDeferred: false,
		});
		expect(namedOwners).toEqual([poison.userId, healthy.userId, poison.userId]);
		expect(await lifecycleOperationById(testEnv.BICKR_D1, poison.operation.operationId)).toMatchObject({ phase: "terminal" });
		expect(await recoveryOwnerCount(poison.userId)).toBe(0);
	});

	it("resumes an interrupted account child that persisted linked-source deletion authority", async () => {
		const owner = await seedAccount("hard-linked-source-delete");
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("hard-linked-source-home"), owner.id);
		const source = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, botInput("a-hard-linked-source"), owner.id);
		const clone = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, botInput("z-hard-linked-clone", source.id), owner.id);
		const storage = testUserStorage();
		const parent = await reserveAccountDelete(
			reserveContext(recoveryRouteEnv(), owner.id, "/profile", "DELETE", "hard-linked-account-delete", storage),
			owner.id,
		);
		const childIdempotencyKey = `account-delete:${parent.operationId}:attempt:${parent.retryCount}:bot:${source.id}`;
		const child = await reserveBotDelete(
			reserveContext(recoveryRouteEnv(), owner.id, `/bots/${source.id}`, "DELETE", childIdempotencyKey, storage),
			owner.id,
			source.id,
			{ allowLinkedCloneDelete: true },
		);
		expect(JSON.parse(child.requestJson ?? "null")).toMatchObject({
			kind: "bot_delete",
			botId: source.id,
			allowLinkedCloneDelete: true,
		});
		expect(storage.setAlarm).not.toHaveBeenCalled();
		const sourceBeforeRecovery = await testEnv.BICKR_KV.get<{ deletedAt?: string }>(`v1:bot:${source.id}`, { type: "json" });
		expect(sourceBeforeRecovery?.deletedAt).toBeUndefined();

		const namedOwners: string[] = [];
		const namespace = recoveryNamespace(recoveryRouteEnv(), new Map([[owner.id, storage]]), namedOwners);
		const first = await recoverDueLifecycleOwners({
			BICKR_D1: testEnv.BICKR_D1,
			USER_BOTS: namespace,
			INTERNAL_SERVICE_SECRET: internalSecret,
		}, Date.now() + 10_000, { limit: 1 });
		expect(first).toMatchObject({ claimed: 1, dispatched: 1, failed: 0 });
		if ((await lifecycleOperationById(testEnv.BICKR_D1, parent.operationId))?.phase !== "terminal") {
			expect(await recoverDueLifecycleOwners({
				BICKR_D1: testEnv.BICKR_D1,
				USER_BOTS: namespace,
				INTERNAL_SERVICE_SECRET: internalSecret,
			}, Date.now() + 20_000, { limit: 1 })).toMatchObject({ claimed: 1, dispatched: 1, failed: 0 });
		}
		expect(namedOwners.every((ownerUserId) => ownerUserId === owner.id)).toBe(true);
		expect(await lifecycleOperationById(testEnv.BICKR_D1, child.operationId)).toMatchObject({ phase: "terminal" });
		expect(await lifecycleOperationById(testEnv.BICKR_D1, parent.operationId)).toMatchObject({ phase: "terminal" });
		for (const bot of [source, clone]) {
			expect(await testEnv.BICKR_KV.get<{ deletedAt?: string }>(`v1:bot:${bot.id}`, { type: "json" }))
				.toMatchObject({ deletedAt: expect.any(String) });
		}
	});

	it.each([
		{ label: "missing", credential: undefined },
		{ label: "forged", credential: "forged-internal-secret" },
	])("rejects $label internal auth at the recovery route boundary", async ({ credential }) => {
		const pending = await pendingAccount(`usr_route_auth_${credential ?? "missing"}`, `route-auth-${credential ?? "missing"}`);
		const headers = new Headers({
			"content-type": "application/json",
			"x-bickr-scheduler": "1",
			"x-bickr-user-id": pending.userId,
		});
		if (credential) headers.set(internalServiceAuthHeader, credential);
		const response = await handleAgentRuntimeRequest(new Request(
			`https://internal.bickr/users/${encodeURIComponent(pending.userId)}/lifecycle/recover`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ kind: "lifecycle_recovery_wake", scheduledAt: new Date().toISOString() }),
			},
		), recoveryRouteEnv(), {
			objectId: pending.userId,
			ownerUserId: pending.userId,
			queue: new ExclusiveOperationQueue(),
			storage: testUserStorage(),
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ ok: false, error: "unauthorized" });
		expect(await lifecycleOperationById(testEnv.BICKR_D1, pending.operation.operationId)).toMatchObject({ phase: "pending" });
	});

	it("does not claim recovery work during maintenance", async () => {
		const pending = await pendingAccount("usr_maintenance_recovery", "maintenance-subject");
		const maintenanceAt = new Date().toISOString();
		await testEnv.BICKR_D1.prepare(
			"UPDATE maintenance_control SET enabled = 1, activated_at = ?, updated_at = ? WHERE id = 1",
		).bind(maintenanceAt, maintenanceAt).run();
		const fetch = vi.fn(async () => Response.json({ ok: true }));
		const namespace: LifecycleRecoveryCoordinatorNamespace<string> = {
			idFromName: (ownerUserId) => ownerUserId,
			get: () => ({ fetch }),
		};
		expect(await recoverDueLifecycleOwners({
			BICKR_D1: testEnv.BICKR_D1,
			USER_BOTS: namespace,
			INTERNAL_SERVICE_SECRET: internalSecret,
		}, Date.now() + 1_000)).toEqual({
			claimed: 0, dispatched: 0, failed: 0, maintenanceDeferred: true,
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(await recoveryOwner(pending.userId)).toMatchObject({ leaseToken: null, leaseExpiresAt: null });
	});
});

type TestUserStorage = UserBotsCoordinatorStorage & {
	setAlarm: ReturnType<typeof vi.fn<UserBotsCoordinatorStorage["setAlarm"]>>;
};

function testUserStorage(): TestUserStorage {
	const values = new Map<string, unknown>();
	return {
		get: async <T>(key: string) => values.get(key) as T | undefined,
		put: async (key, value) => {
			values.set(key, value);
		},
		delete: async (key) => values.delete(key),
		setAlarm: vi.fn(async () => undefined),
		deleteAlarm: async () => undefined,
	};
}

function recoveryRouteEnv(): AgentRuntimeRouteEnv {
	return {
		BICKR_D1: testEnv.BICKR_D1,
		BICKR_KV: testEnv.BICKR_KV,
		BICKR_R2: testEnv.BICKR_R2,
		BICKR_R2_PUBLIC_BASE_URL: testEnv.BICKR_R2_PUBLIC_BASE_URL,
		INTERNAL_SERVICE_SECRET: internalSecret,
		FORUM_COORDINATOR_SERVICE: {
			fetch: (request: Request) => handleForumCoordinatorRequest(request, {
				...testEnv,
				INTERNAL_SERVICE_SECRET: internalSecret,
			}, {
				objectId: "recovery-world-coordinator",
				queue: new ExclusiveOperationQueue(),
			}),
			connect: () => {
				throw new Error("Lifecycle recovery tests do not open sockets.");
			},
		},
	};
}

function reserveContext(
	env: AgentRuntimeRouteEnv,
	ownerUserId: string,
	path: string,
	method: string,
	idempotencyKey: string,
	storage: UserBotsCoordinatorStorage,
): AgentRuntimeRouteContext {
	const headers = new Headers({ "idempotency-key": idempotencyKey, "x-bickr-user-id": ownerUserId });
	const request = new Request(`https://agent.internal/users/${encodeURIComponent(ownerUserId)}${path}`, { method, headers });
	return {
		request,
		env,
		url: new URL(request.url),
		coordinator: {
			objectId: ownerUserId,
			ownerUserId,
			queue: new ExclusiveOperationQueue(),
			storage,
		},
		objectId: ownerUserId,
		match: /(?:)/u.exec("")!,
	};
}

function recoveryNamespace(
	env: AgentRuntimeRouteEnv,
	storages: ReadonlyMap<string, UserBotsCoordinatorStorage>,
	namedOwners: string[],
): LifecycleRecoveryCoordinatorNamespace<string> {
	const queues = new Map<string, ExclusiveOperationQueue>();
	return {
		idFromName: (ownerUserId) => {
			namedOwners.push(ownerUserId);
			return ownerUserId;
		},
		get: (ownerUserId) => ({
			fetch: async (request: Request) => {
				expect(isTrustedInternalServiceRequest(request, internalSecret)).toBe(true);
				expect(request.headers.get("x-bickr-scheduler")).toBe("1");
				expect(request.headers.get("x-bickr-user-id")).toBe(ownerUserId);
				return handleAgentRuntimeRequest(request, env, {
					objectId: ownerUserId,
					ownerUserId,
					queue: queues.get(ownerUserId) ?? createQueue(queues, ownerUserId),
					storage: storages.get(ownerUserId) ?? testUserStorage(),
				});
			},
		}),
	};
}

function createQueue(queues: Map<string, ExclusiveOperationQueue>, ownerUserId: string): ExclusiveOperationQueue {
	const queue = new ExclusiveOperationQueue();
	queues.set(ownerUserId, queue);
	return queue;
}

async function pendingAccount(candidateUserId: string, subject: string) {
	const reservation = await reserveOrJoinAccountBootstrap(testEnv.BICKR_D1, {
		candidateUserId,
		idempotencyKey: `pending:${subject}`,
		profile: { provider: "github" as const, subject, login: subject },
		now: "2026-08-04T00:00:00.000Z",
	});
	if (reservation.kind !== "pending") throw new Error("Expected pending account reservation.");
	return reservation;
}

async function seedAccount(suffix: string) {
	return upsertProviderUser(testEnv.BICKR_KV, testEnv.BICKR_D1, {
		provider: "github",
		subject: `recovery-${suffix}`,
		login: `recovery-${suffix}`.slice(0, 60),
	});
}

function worldInput(handle: string) {
	const language = parseLanguageTag("en");
	return {
		handle,
		language,
		name: localizedText(handle, language),
		description: localizedText("Recovery world", language),
	};
}

function botInput(handle: string, cloneSourceBotId?: string) {
	const language = parseLanguageTag("en");
	return {
		handle,
		language,
		displayName: localizedText(handle, language),
		shortBio: localizedText("Recovery bio", language),
		prompt: localizedText("Recovery prompt", language),
		...(cloneSourceBotId ? { cloneSourceBotId } : {}),
	};
}

async function recoveryOwnerCount(ownerUserId: string): Promise<number> {
	const row = await testEnv.BICKR_D1.prepare(
		"SELECT COUNT(*) AS count FROM entity_lifecycle_recovery_owners WHERE owner_user_id = ?",
	).bind(ownerUserId).first<{ count: number }>();
	return row?.count ?? 0;
}

async function recoveryOwner(ownerUserId: string) {
	return testEnv.BICKR_D1.prepare(
		`SELECT lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt
		 FROM entity_lifecycle_recovery_owners WHERE owner_user_id = ?`,
	).bind(ownerUserId).first<{ leaseToken: string | null; leaseExpiresAt: string | null }>();
}

async function expectLifecycleProjection(
	table: "users_index" | "worlds_index" | "bots_index",
	idColumn: "user_id" | "world_id" | "bot_id",
	entityId: string,
	lifecycleState: "active" | "deleting",
	deleted: boolean,
): Promise<void> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT lifecycle_state AS lifecycleState, deleted_at AS deletedAt FROM ${table} WHERE ${idColumn} = ?`,
	).bind(entityId).first<{ lifecycleState: string; deletedAt: string | null }>();
	expect(row).toMatchObject({
		lifecycleState,
		deletedAt: deleted ? expect.any(String) : null,
	});
}
