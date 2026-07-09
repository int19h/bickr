import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { clearKv, execD1Statements, resetD1Schema } from "./helpers/d1-schema";
import migrationSql from "../migrations/0031_tombstone_deleted_handles.sql?raw";
import { deleteForum, deleteWorld } from "../packages/shared/src/governance";
import {
	createBot,
	createForum,
	createWorld,
	deleteBot,
} from "../packages/shared/src/repository";
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
	await testEnv.BICKR_D1
		.prepare(
			`INSERT INTO users_index (
				user_id, handle, language, ui_locale, display_name, display_name_lang,
				avatar_url, avatar_crop, profile_completed_at, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
		)
		.bind(
			user.id,
			user.handle,
			user.language,
			user.displayName.text,
			user.displayName.lang,
			user.createdAt,
			user.updatedAt,
		)
		.run();
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
