import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { clearKv, execD1Statements, resetD1Schema } from "./helpers/d1-schema";
import migrationSql from "../migrations/0031_tombstone_deleted_handles.sql?raw";
import { deleteForum } from "../packages/shared/src/governance";
import {
	createForum,
} from "../packages/shared/src/repository";
import {
	createBot,
	createWorld,
	deleteBot,
	deleteWorld,
	upsertProviderUser,
} from "./helpers/coordinator-mutations";
import {
	localizedText,
	schemaVersion,
	type BotDocument,
	type ForumDocument,
	type LanguageTag,
	type UserDocument,
	type WorldDocument,
} from "../packages/shared/src/model";
import { tombstoneHandle } from "../packages/shared/src/handles";
import { kvKeys } from "../packages/shared/src/storage";

const testLanguage = "en" as LanguageTag;
const ownerId = "usr_handle_reuse";
const now = "2026-07-09T00:00:00.000Z";

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
	await seedOwner();
});

describe("soft-deleted handle reuse", () => {
	it("allows recreating a bot with the original handle in the same world", async () => {
		await createTestWorld("reuse-bots");
		const original = await createTestBot("reuse-bots", "same-bot");

		await deleteBot(testEnv.BICKR_KV, testEnv.BICKR_D1, original.id, ownerId, now);
		const deleted = await readBotDocument(original.id);
		expect(deleted.handle).toBe(tombstoneHandle(original.id));
		expect(deleted.handleAtDeletion).toBe("same-bot");

		const recreated = await createTestBot("reuse-bots", "same-bot");
		expect(recreated.id).not.toBe(original.id);
		expect(recreated.handle).toBe("same-bot");

		const personalForum = await testEnv.BICKR_D1
			.prepare(
				`SELECT forum_id AS id, handle
				 FROM forums_index
				 WHERE personal_bot_id = ? AND deleted_at IS NULL`,
			)
			.bind(recreated.id)
			.first<{ id: string; handle: string }>();
		expect(personalForum?.id).toMatch(/^frm_/);
		expect(personalForum?.handle).toMatch(/^same-bot(?:-\d+)?$/);
	});

	it("allows recreating a world with the original handle", async () => {
		const original = await createTestWorld("same-world");

		await deleteWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, original.handle, ownerId, now);
		const deleted = await readWorldDocument(original.id);
		expect(deleted.handle).toBe(tombstoneHandle(original.id));
		expect(deleted.handleAtDeletion).toBe("same-world");

		const recreated = await createTestWorld("same-world");
		expect(recreated.id).not.toBe(original.id);
		expect(recreated.handle).toBe("same-world");

		const introForum = await testEnv.BICKR_D1
			.prepare(
				`SELECT forum_id AS id
				 FROM forums_index
				 WHERE world_id = ? AND handle = 'intro' AND deleted_at IS NULL`,
			)
			.bind(recreated.id)
			.first<{ id: string }>();
		expect(introForum?.id).toMatch(/^frm_/);
	});

	it("allows recreating a forum with the original handle in the same world", async () => {
		const world = await createTestWorld("reuse-forums");
		const original = await createTestForum(world.handle, "same-forum");

		await deleteForum(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, original.handle, ownerId, now);
		const deleted = await readForumDocument(original.id);
		expect(deleted.handle).toBe(tombstoneHandle(original.id));
		expect(deleted.handleAtDeletion).toBe("same-forum");

		const recreated = await createTestForum(world.handle, "same-forum");
		expect(recreated.id).not.toBe(original.id);
		expect(recreated.handle).toBe("same-forum");
	});

	it("frees deleted index handles when migration 0031 is applied", async () => {
		await testEnv.BICKR_D1
			.prepare(
				`INSERT INTO worlds_index (
					world_id, handle, language, name, name_lang, description, description_lang, prompt, prompt_lang,
					avatar_url, avatar_crop, image_generation, initial_bot_notification, initial_bot_notification_lang,
					created_by_user_id, visibility, posting_thread_body_characters, posting_comment_body_characters,
					created_at, updated_at, deleted_at
				) VALUES ('wld_123456789012345678901234567890', 'taken-world', NULL, 'Deleted', NULL, 'Deleted', NULL, '', NULL,
					NULL, NULL, NULL, 'Initial', NULL, ?, 'public', NULL, NULL, ?, ?, ?)`,
			)
			.bind(ownerId, now, now, now)
			.run();
		await testEnv.BICKR_D1
			.prepare(
				`INSERT INTO forums_index (
					forum_id, world_id, world_handle, handle, language, description, description_lang,
					created_by_user_id, personal_bot_id, created_at, updated_at, deleted_at
				) VALUES ('frm_123456789012345678901234567890', 'wld_123456789012345678901234567890', 'taken-world', 'taken-forum',
					NULL, 'Deleted', NULL, ?, NULL, ?, ?, ?)`,
			)
			.bind(ownerId, now, now, now)
			.run();
		await testEnv.BICKR_D1
			.prepare(
				`INSERT INTO bots_index (
					bot_id, home_world_id, home_world_handle, handle, language, display_name, display_name_lang,
					owner_user_id, include_language_in_system_prompt, short_bio, short_bio_lang, avatar_url, avatar_crop,
					import_provider, import_external_handle, created_at, updated_at, deleted_at
				) VALUES ('bot_123456789012345678901234567890', 'wld_123456789012345678901234567890', 'taken-world', 'taken-bot',
					NULL, 'Deleted', NULL, ?, 1, 'Deleted', NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
			)
			.bind(ownerId, now, now, now)
			.run();

		await execD1Statements(testEnv.BICKR_D1, migrationSql);
		await testEnv.BICKR_D1.batch([
			activeClaim("world_handle", "global", "taken-world", "world", "wld_active-fixture-world", ownerId),
			activeClaim("bot_handle", "wld_123456789012345678901234567890", "taken-bot", "bot", "bot_active-fixture-bot", ownerId),
		]);

		await testEnv.BICKR_D1
			.prepare(
				`INSERT INTO worlds_index (
					world_id, handle, language, name, name_lang, description, description_lang, prompt, prompt_lang,
					avatar_url, avatar_crop, image_generation, initial_bot_notification, initial_bot_notification_lang,
					created_by_user_id, visibility, posting_thread_body_characters, posting_comment_body_characters,
					created_at, updated_at, deleted_at
				) VALUES ('wld_active-fixture-world', 'taken-world', NULL, 'Active', NULL, 'Active', NULL, '', NULL,
					NULL, NULL, NULL, 'Initial', NULL, ?, 'public', NULL, NULL, ?, ?, NULL)`,
			)
			.bind(ownerId, now, now)
			.run();
		await testEnv.BICKR_D1
			.prepare(
				`INSERT INTO forums_index (
					forum_id, world_id, world_handle, handle, language, description, description_lang,
					created_by_user_id, personal_bot_id, created_at, updated_at, deleted_at
				) VALUES ('frm_active-fixture-forum', 'wld_123456789012345678901234567890', 'taken-world', 'taken-forum',
					NULL, 'Active', NULL, ?, NULL, ?, ?, NULL)`,
			)
			.bind(ownerId, now, now)
			.run();
		await testEnv.BICKR_D1
			.prepare(
				`INSERT INTO bots_index (
					bot_id, home_world_id, home_world_handle, handle, language, display_name, display_name_lang,
					owner_user_id, include_language_in_system_prompt, short_bio, short_bio_lang, avatar_url, avatar_crop,
					import_provider, import_external_handle, created_at, updated_at, deleted_at
				) VALUES ('bot_active-fixture-bot', 'wld_123456789012345678901234567890', 'taken-world', 'taken-bot',
					NULL, 'Active', NULL, ?, 1, 'Active', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
			)
			.bind(ownerId, now, now)
			.run();

		const tombstoned = await testEnv.BICKR_D1
			.prepare(
				`SELECT
					(SELECT handle FROM worlds_index WHERE world_id = 'wld_123456789012345678901234567890') AS worldHandle,
					(SELECT handle FROM forums_index WHERE forum_id = 'frm_123456789012345678901234567890') AS forumHandle,
					(SELECT handle FROM bots_index WHERE bot_id = 'bot_123456789012345678901234567890') AS botHandle`,
			)
			.first<{ worldHandle: string; forumHandle: string; botHandle: string }>();
		expect(tombstoned).toEqual({
			botHandle: "deleted-bot_12345678901234567890",
			forumHandle: "deleted-frm_12345678901234567890",
			worldHandle: "deleted-wld_12345678901234567890",
		});
	});
});

describe("generated handle collision probes", () => {
	it("selects the first free generated user handle after an escaped base probe", async () => {
		await insertUserHandles(["mixed_-case", "mixed_-case-2"]);

		const user = await upsertProviderUser(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			provider: "github",
			subject: "special-login",
			login: "mixed_%/case",
			displayName: "Special Login",
		}, now);

		expect(user.handle).toBe("mixed_-case-3");
	});

	it("falls back to a random user handle suffix after 50 ordered collisions", async () => {
		await insertUserHandles(collidingHandles("crowded_user", 50));
		const restore = mockRandomTokenBytes([1, 2, 3, 4]);
		try {
			const user = await upsertProviderUser(testEnv.BICKR_KV, testEnv.BICKR_D1, {
				provider: "github",
				subject: "crowded-login",
				login: "crowded_user",
				displayName: "Crowded Login",
			}, now);

			expect(user.handle).toBe("crowded_user-AQIDBA");
		} finally {
			restore();
		}
	});

	it("selects the first free generated personal-forum handle after an escaped base probe", async () => {
		const world = await createTestWorld("forum-probes");
		await insertForumHandles(world, ["probe_bot", "probe_bot-2"]);

		const bot = await createTestBot(world.handle, "probe_bot");

		const personalForum = await personalForumForBot(bot.id);
		expect(personalForum?.handle).toBe("probe_bot-3");
	});

	it("falls back to a random personal-forum handle suffix after 50 ordered collisions", async () => {
		const world = await createTestWorld("forum-fallbacks");
		await insertForumHandles(world, collidingHandles("crowded-forum", 50));
		const restore = mockRandomTokenBytes([1, 2, 3, 4]);
		try {
			const bot = await createTestBot(world.handle, "crowded-forum");

			const personalForum = await personalForumForBot(bot.id);
			expect(personalForum?.handle).toBe("crowded-forum-AQIDBA");
		} finally {
			restore();
		}
	});
});

async function createTestWorld(handle: string) {
	return createWorld(
		testEnv.BICKR_KV,
		testEnv.BICKR_D1,
		{
			handle,
			language: testLanguage,
			name: lt(`${handle} world`),
			description: lt(`${handle} description`),
		},
		ownerId,
		now,
	);
}

async function createTestForum(worldHandle: string, handle: string) {
	return createForum(
		testEnv.BICKR_KV,
		testEnv.BICKR_D1,
		worldHandle,
		{
			handle,
			language: testLanguage,
			description: lt(`${handle} discussion`),
		},
		ownerId,
		now,
	);
}

async function createTestBot(worldHandle: string, handle: string) {
	return createBot(
		testEnv.BICKR_KV,
		testEnv.BICKR_D1,
		worldHandle,
		{
			handle,
			language: testLanguage,
			displayName: lt(`${handle} display`),
			shortBio: lt(`${handle} bio`),
			prompt: lt(`${handle} prompt`),
		},
		ownerId,
		now,
	);
}

async function seedOwner(): Promise<void> {
	const user: UserDocument = {
		id: ownerId,
		type: "user",
		schemaVersion,
		revision: 1,
		handle: "handle-reuse-owner",
		language: testLanguage,
		displayName: lt("Handle Reuse Owner"),
		createdAt: now,
		updatedAt: now,
	};
	await testEnv.BICKR_KV.put(kvKeys.user(user.id), JSON.stringify(user));
	await testEnv.BICKR_D1.batch([
		activeClaim("user_handle", "global", user.handle, "account", user.id, user.id),
		testEnv.BICKR_D1.prepare(
			`INSERT INTO users_index (
				user_id, handle, language, ui_locale, display_name, display_name_lang,
				avatar_url, avatar_crop, profile_completed_at, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
		).bind(
			user.id,
			user.handle,
			user.language,
			user.displayName.text,
			user.displayName.lang,
			user.createdAt,
			user.updatedAt,
		),
	]);
}

async function insertUserHandles(handles: string[]): Promise<void> {
	if (handles.length === 0) {
		return;
	}
	await testEnv.BICKR_D1.batch(handles.flatMap((handle, index) => [
		activeClaim("user_handle", "global", handle, "account", `usr_existing_${index}`, `usr_existing_${index}`),
		testEnv.BICKR_D1
			.prepare(
				`INSERT INTO users_index (
					user_id, handle, language, ui_locale, display_name, display_name_lang,
					avatar_url, avatar_crop, profile_completed_at, created_at, updated_at, deleted_at
				) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
			)
			.bind(`usr_existing_${index}`, handle, testLanguage, handle, testLanguage, now, now),
	]));
}

function activeClaim(
	kind: "user_handle" | "world_handle" | "bot_handle",
	scope: string,
	value: string,
	entityKind: "account" | "world" | "bot",
	entityId: string,
	ownerUserId: string,
) {
	return testEnv.BICKR_D1.prepare(
		`INSERT INTO entity_lifecycle_identity_claims (
			key_kind, key_scope, key_value, entity_kind, entity_id,
			owner_user_id, claim_state, operation_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
	).bind(kind, scope, value, entityKind, entityId, ownerUserId, now, now);
}

async function insertForumHandles(world: Pick<WorldDocument, "id" | "handle">, handles: string[]): Promise<void> {
	if (handles.length === 0) {
		return;
	}
	await testEnv.BICKR_D1.batch(handles.map((handle, index) =>
		testEnv.BICKR_D1
			.prepare(
				`INSERT INTO forums_index (
					forum_id, world_id, world_handle, handle, language, description, description_lang,
					created_by_user_id, personal_bot_id, created_at, updated_at, deleted_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
			)
			.bind(`frm_existing_${index}`, world.id, world.handle, handle, testLanguage, `${handle} discussion`, testLanguage, ownerId, now, now),
	));
}

async function personalForumForBot(botId: string): Promise<{ id: string; handle: string } | null> {
	return testEnv.BICKR_D1
		.prepare(
			`SELECT forum_id AS id, handle
			 FROM forums_index
			 WHERE personal_bot_id = ? AND deleted_at IS NULL`,
		)
		.bind(botId)
		.first<{ id: string; handle: string }>();
}

function collidingHandles(base: string, count: number): string[] {
	return Array.from({ length: count }, (_, index) => index === 0 ? base : `${base}-${index + 1}`);
}

function mockRandomTokenBytes(bytes: number[]): () => void {
	const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
		array.set(bytes.slice(0, array.length));
		return array;
	}) as Crypto["getRandomValues"]);
	return () => spy.mockRestore();
}

async function readBotDocument(id: string): Promise<BotDocument> {
	const document = await testEnv.BICKR_KV.get(kvKeys.bot(id), { type: "json" }) as BotDocument | null;
	if (!document) {
		throw new Error(`Missing bot ${id}`);
	}
	return document;
}

async function readWorldDocument(id: string): Promise<WorldDocument> {
	const document = await testEnv.BICKR_KV.get(kvKeys.world(id), { type: "json" }) as WorldDocument | null;
	if (!document) {
		throw new Error(`Missing world ${id}`);
	}
	return document;
}

async function readForumDocument(id: string): Promise<ForumDocument> {
	const document = await testEnv.BICKR_KV.get(kvKeys.forum(id), { type: "json" }) as ForumDocument | null;
	if (!document) {
		throw new Error(`Missing forum ${id}`);
	}
	return document;
}

function lt(text: string) {
	return localizedText(text, testLanguage);
}
