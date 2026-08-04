import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	hashLifecycleRequest,
	reserveCreateLifecycle,
	type LifecycleEntityKind,
	type LifecycleReservation,
} from "@bickr/shared/entity-lifecycle";
import { localizedText } from "@bickr/shared/model";
import { RepositoryError } from "@bickr/shared/repository";
import { kvKeys, type D1DatabaseLike, type KVNamespaceLike } from "@bickr/shared/storage";
import { parseLanguageTag } from "@bickr/shared/validation";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";
import {
	createBot,
	createWorld,
	updateBot,
	updateUserProfile,
	updateWorld,
	upsertProviderUser,
	userCoordinatorMutation,
} from "./helpers/coordinator-mutations";

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
});

describe("canonical lifecycle identity claims", () => {
	it("does not permit a live projection to release its canonical identity claim", async () => {
		const user = await seedAccount("claim-release-guard");
		await expect(testEnv.BICKR_D1.prepare(
			`DELETE FROM entity_lifecycle_identity_claims
			 WHERE key_kind = 'user_handle' AND key_scope = 'global' AND key_value = ?`,
		).bind(user.handle).run()).rejects.toThrow();
	});

	it("serializes pending account creates and active user-handle renames in both orders and under a race", async () => {
		const pendingFirst = await seedAccount("user-pending-first");
		await reserveClaim(pendingFirst.id, "account", "usr_pending_first", {
			kind: "user_handle", scope: "global", value: "claimed-user-a",
		});
		await expect(updateUserProfile(testEnv.BICKR_KV, testEnv.BICKR_D1, pendingFirst.id, { handle: "claimed-user-a" }))
			.rejects.toMatchObject({ code: "conflict" });

		const activeFirst = await seedAccount("user-active-first");
		await updateUserProfile(testEnv.BICKR_KV, testEnv.BICKR_D1, activeFirst.id, { handle: "claimed-user-b" });
		await expect(reserveClaim(activeFirst.id, "account", "usr_pending_second", {
			kind: "user_handle", scope: "global", value: "claimed-user-b",
		})).rejects.toMatchObject({ code: "conflict" });

		const racing = await seedAccount("user-racing");
		await expectExactlyOneClaimant([
			reserveClaim(racing.id, "account", "usr_pending_race", {
				kind: "user_handle", scope: "global", value: "claimed-user-race",
			}),
			updateUserProfile(testEnv.BICKR_KV, testEnv.BICKR_D1, racing.id, { handle: "claimed-user-race" }),
		]);
	});

	it("serializes pending world creates and active world-handle renames in both orders and under a race", async () => {
		const owner = await seedAccount("world-claim-owner");
		const first = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("world-claim-first"), owner.id);
		await reserveClaim(owner.id, "world", "wld_pending_first", {
			kind: "world_handle", scope: "global", value: "claimed-world-a",
		});
		await expect(updateWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, first.handle, owner.id, { handle: "claimed-world-a" }))
			.rejects.toMatchObject({ code: "conflict" });

		const second = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("world-claim-second"), owner.id);
		await updateWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, second.handle, owner.id, { handle: "claimed-world-b" });
		await expect(reserveClaim(owner.id, "world", "wld_pending_second", {
			kind: "world_handle", scope: "global", value: "claimed-world-b",
		})).rejects.toMatchObject({ code: "conflict" });

		const racing = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("world-claim-race-source"), owner.id);
		await expectExactlyOneClaimant([
			reserveClaim(owner.id, "world", "wld_pending_race", {
				kind: "world_handle", scope: "global", value: "claimed-world-race",
			}),
			updateWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, racing.handle, owner.id, { handle: "claimed-world-race" }),
		]);
	});

	it("serializes pending bot creates and active bot-handle renames in both orders and under a race", async () => {
		const owner = await seedAccount("bot-claim-owner");
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("bot-claim-home"), owner.id);
		const first = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, botInput("bot-claim-first"), owner.id);
		await reserveClaim(owner.id, "bot", "bot_pending_first", {
			kind: "bot_handle", scope: world.id, value: "claimed-bot-a",
		});
		await expect(updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, first.id, owner.id, { handle: "claimed-bot-a" }))
			.rejects.toMatchObject({ code: "conflict" });

		const second = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, botInput("bot-claim-second"), owner.id);
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, second.id, owner.id, { handle: "claimed-bot-b" });
		await expect(reserveClaim(owner.id, "bot", "bot_pending_second", {
			kind: "bot_handle", scope: world.id, value: "claimed-bot-b",
		})).rejects.toMatchObject({ code: "conflict" });

		const racing = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, botInput("bot-claim-race-source"), owner.id);
		await expectExactlyOneClaimant([
			reserveClaim(owner.id, "bot", "bot_pending_race", {
				kind: "bot_handle", scope: world.id, value: "claimed-bot-race",
			}),
			updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, racing.id, owner.id, { handle: "claimed-bot-race" }),
		]);
	});

	it("serializes pending account subjects and active provider links in both orders and under a race", async () => {
		const pendingFirst = await seedAccount("provider-pending-first");
		await reserveClaim(pendingFirst.id, "account", "usr_provider_pending_first", {
			kind: "provider_subject", scope: "google", value: "claimed-provider-a",
		});
		await expect(linkGoogle(pendingFirst.id, "claimed-provider-a")).rejects.toMatchObject({ code: "conflict" });

		const activeFirst = await seedAccount("provider-active-first");
		await linkGoogle(activeFirst.id, "claimed-provider-b");
		await expect(reserveClaim(activeFirst.id, "account", "usr_provider_pending_second", {
			kind: "provider_subject", scope: "google", value: "claimed-provider-b",
		})).rejects.toMatchObject({ code: "conflict" });

		const racing = await seedAccount("provider-racing");
		await expectExactlyOneClaimant([
			reserveClaim(racing.id, "account", "usr_provider_pending_race", {
				kind: "provider_subject", scope: "google", value: "claimed-provider-race",
			}),
			linkGoogle(racing.id, "claimed-provider-race"),
		]);
	});

	it("converges a user-handle rename after D1 commits and the KV write fails", async () => {
		const user = await seedAccount("user-rename-replay");
		const nextHandle = "user-rename-replayed";
		const kv = failNextPut(testEnv.BICKR_KV, kvKeys.user(user.id));

		await expect(updateUserProfile(kv, testEnv.BICKR_D1, user.id, { handle: nextHandle }))
			.rejects.toMatchObject({ code: "server_error" });
		expect(await indexedHandle("users_index", "user_id", user.id)).toBe(nextHandle);
		expect(await documentHandle(kv, kvKeys.user(user.id))).toBe(user.handle);

		await updateUserProfile(kv, testEnv.BICKR_D1, user.id, { handle: nextHandle });
		expect(await documentHandle(kv, kvKeys.user(user.id))).toBe(nextHandle);
		await expectSingleActiveClaim("user_handle", "global", nextHandle, user.id);
	});

	it("converges a world-handle rename through the same public request after D1 commits and KV fails", async () => {
		const owner = await seedAccount("world-rename-replay-owner");
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("world-rename-replay"), owner.id);
		const nextHandle = "world-rename-replayed";
		const kv = failNextPut(testEnv.BICKR_KV, kvKeys.world(world.id));

		await expect(updateWorld(kv, testEnv.BICKR_D1, world.handle, owner.id, { handle: nextHandle }))
			.rejects.toMatchObject({ code: "server_error" });
		expect(await indexedHandle("worlds_index", "world_id", world.id)).toBe(nextHandle);
		expect(await documentHandle(kv, kvKeys.world(world.id))).toBe(world.handle);

		await updateWorld(kv, testEnv.BICKR_D1, world.handle, owner.id, { handle: nextHandle });
		expect(await documentHandle(kv, kvKeys.world(world.id))).toBe(nextHandle);
		await expectSingleActiveClaim("world_handle", "global", nextHandle, world.id);
	});

	it("converges a bot-handle rename after D1 commits and the KV write fails", async () => {
		const owner = await seedAccount("bot-rename-replay-owner");
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("bot-rename-replay-home"), owner.id);
		const bot = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, botInput("bot-rename-replay"), owner.id);
		const nextHandle = "bot-rename-replayed";
		const kv = failNextPut(testEnv.BICKR_KV, kvKeys.bot(bot.id));

		await expect(updateBot(kv, testEnv.BICKR_D1, bot.id, owner.id, { handle: nextHandle }))
			.rejects.toMatchObject({ code: "server_error" });
		expect(await indexedHandle("bots_index", "bot_id", bot.id)).toBe(nextHandle);
		expect(await documentHandle(kv, kvKeys.bot(bot.id))).toBe(bot.handle);

		await updateBot(kv, testEnv.BICKR_D1, bot.id, owner.id, { handle: nextHandle });
		expect(await documentHandle(kv, kvKeys.bot(bot.id))).toBe(nextHandle);
		await expectSingleActiveClaim("bot_handle", world.id, nextHandle, bot.id);
	});

	it("converges a provider link when the committed D1 batch is reported as failed", async () => {
		const user = await seedAccount("provider-link-replay");
		const db = failAfterNextCommittedBatch(testEnv.BICKR_D1);
		db.arm();

		await expect(linkGoogle(user.id, "provider-link-replayed", db))
			.rejects.toMatchObject({ code: "server_error" });
		await linkGoogle(user.id, "provider-link-replayed");
		await expectSingleActiveClaim("provider_subject", "google", "provider-link-replayed", user.id);
		const count = await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count FROM provider_identities
			 WHERE provider = 'google' AND provider_subject = ? AND user_id = ?`,
		).bind("provider-link-replayed", user.id).first<{ count: number }>();
		expect(count?.count).toBe(1);
	});
});

async function reserveClaim(
	ownerUserId: string,
	entityKind: LifecycleEntityKind,
	entityId: string,
	reservation: LifecycleReservation,
): Promise<void> {
	const request = { kind: "identity_claim_test", entityKind, entityId, reservation };
	await reserveCreateLifecycle(testEnv.BICKR_D1, {
		ownerUserId,
		idempotencyKey: `claim:${entityId}`,
		requestHash: await hashLifecycleRequest(request),
		requestJson: JSON.stringify(request),
		entityKind,
		entityId,
		reservations: [reservation],
		now: new Date().toISOString(),
	});
}

async function expectExactlyOneClaimant(promises: readonly Promise<unknown>[]): Promise<void> {
	const results = await Promise.allSettled(promises);
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
	expect(rejection?.reason).toBeInstanceOf(RepositoryError);
	expect(rejection?.reason).toMatchObject({ code: "conflict" });
}

async function seedAccount(suffix: string) {
	return upsertProviderUser(testEnv.BICKR_KV, testEnv.BICKR_D1, {
		provider: "github",
		subject: `claim-${suffix}`,
		login: `claim-${suffix}`.slice(0, 60),
	});
}

async function linkGoogle(userId: string, subject: string, db: D1DatabaseLike = testEnv.BICKR_D1): Promise<void> {
	await userCoordinatorMutation(
		{ BICKR_D1: db, BICKR_KV: testEnv.BICKR_KV },
		userId,
		"/auth/identities",
		"POST",
		{ provider: "google", subject, login: subject },
	);
}

function failNextPut(kv: KVNamespaceLike, targetKey: string): KVNamespaceLike {
	let shouldFail = true;
	return {
		get: (key, options) => kv.get(key, options),
		put: async (key, value, options) => {
			if (key === targetKey && shouldFail) {
				shouldFail = false;
				throw new Error(`Injected KV write failure for ${targetKey}`);
			}
			await kv.put(key, value, options);
		},
		delete: (key) => kv.delete(key),
	};
}

function failAfterNextCommittedBatch(db: D1DatabaseLike): D1DatabaseLike & { arm(): void } {
	let armed = false;
	return {
		arm: () => {
			armed = true;
		},
		prepare: (query) => db.prepare(query),
		batch: async (statements) => {
			const results = await db.batch(statements);
			if (armed) {
				armed = false;
				throw new Error("Injected failure after committed D1 batch");
			}
			return results;
		},
	};
}

async function indexedHandle(table: "users_index" | "worlds_index" | "bots_index", idColumn: "user_id" | "world_id" | "bot_id", id: string): Promise<string | null> {
	const row = await testEnv.BICKR_D1.prepare(`SELECT handle FROM ${table} WHERE ${idColumn} = ?`).bind(id).first<{ handle: string }>();
	return row?.handle ?? null;
}

async function documentHandle(kv: KVNamespaceLike, key: string): Promise<string | null> {
	const document = await kv.get(key, { type: "json" });
	return document && typeof document === "object" && "handle" in document && typeof document.handle === "string"
		? document.handle
		: null;
}

async function expectSingleActiveClaim(kind: LifecycleReservation["kind"], scope: string, value: string, entityId: string): Promise<void> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT COUNT(*) AS count, MIN(claim_state) AS claimState, MIN(operation_id) AS operationId
		 FROM entity_lifecycle_identity_claims
		 WHERE key_kind = ? AND key_scope = ? AND key_value = ? AND entity_id = ?`,
	).bind(kind, scope, value, entityId).first<{ count: number; claimState: string | null; operationId: string | null }>();
	expect(row).toMatchObject({ count: 1, claimState: "active", operationId: null });
}

function worldInput(handle: string) {
	const language = parseLanguageTag("en");
	return {
		handle,
		language,
		name: localizedText(handle, language),
		description: localizedText("Description", language),
	};
}

function botInput(handle: string) {
	const language = parseLanguageTag("en");
	return {
		handle,
		language,
		displayName: localizedText(handle, language),
		shortBio: localizedText("Short bio", language),
		prompt: localizedText("Prompt", language),
	};
}
