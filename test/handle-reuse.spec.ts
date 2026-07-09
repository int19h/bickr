import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
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

const schemaSql = `
CREATE TABLE objects_index (
	object_id TEXT PRIMARY KEY,
	object_type TEXT NOT NULL,
	world_id TEXT,
	revision INTEGER NOT NULL,
	index_version INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);
CREATE INDEX objects_index_world_type ON objects_index (world_id, object_type, deleted_at);
CREATE TABLE users_index (
	user_id TEXT PRIMARY KEY,
	handle TEXT NOT NULL UNIQUE,
	language TEXT,
	ui_locale TEXT,
	display_name TEXT NOT NULL,
	display_name_lang TEXT,
	avatar_url TEXT,
	avatar_crop TEXT,
	profile_completed_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);
CREATE TABLE worlds_index (
	world_id TEXT PRIMARY KEY,
	handle TEXT NOT NULL UNIQUE,
	language TEXT,
	name TEXT NOT NULL,
	name_lang TEXT,
	description TEXT NOT NULL,
	description_lang TEXT,
	prompt TEXT NOT NULL DEFAULT '',
	prompt_lang TEXT,
	avatar_url TEXT,
	avatar_crop TEXT,
	image_generation TEXT,
	initial_bot_notification TEXT NOT NULL,
	initial_bot_notification_lang TEXT,
	posting_thread_body_characters INTEGER,
	posting_comment_body_characters INTEGER,
	created_by_user_id TEXT NOT NULL,
	visibility TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);
CREATE INDEX worlds_index_visible ON worlds_index (deleted_at, updated_at);
CREATE TABLE forums_index (
	forum_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	world_handle TEXT NOT NULL,
	handle TEXT NOT NULL,
	language TEXT,
	description TEXT NOT NULL,
	description_lang TEXT,
	created_by_user_id TEXT NOT NULL,
	personal_bot_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT,
	UNIQUE (world_id, handle)
);
CREATE INDEX forums_index_world ON forums_index (world_id, deleted_at, updated_at);
CREATE INDEX forums_index_personal_bot ON forums_index (personal_bot_id);
CREATE TABLE bots_index (
	bot_id TEXT PRIMARY KEY,
	home_world_id TEXT NOT NULL,
	home_world_handle TEXT NOT NULL,
	handle TEXT NOT NULL,
	language TEXT,
	display_name TEXT NOT NULL,
	display_name_lang TEXT,
	owner_user_id TEXT NOT NULL,
	include_language_in_system_prompt INTEGER NOT NULL DEFAULT 0,
	short_bio TEXT NOT NULL,
	short_bio_lang TEXT,
	avatar_url TEXT,
	avatar_crop TEXT,
	import_provider TEXT,
	import_external_handle TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT,
	UNIQUE (home_world_id, handle)
);
CREATE INDEX bots_index_owner ON bots_index (owner_user_id, deleted_at, updated_at);
CREATE INDEX bots_index_world ON bots_index (home_world_id, deleted_at, handle);
CREATE TABLE bot_groups (
	group_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	language TEXT,
	custom_title TEXT,
	custom_title_lang TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);
CREATE INDEX bot_groups_owner_world ON bot_groups (owner_user_id, world_id, deleted_at, created_at);
CREATE INDEX bot_groups_world ON bot_groups (world_id, deleted_at, updated_at);
CREATE TABLE bot_group_members (
	group_id TEXT NOT NULL,
	bot_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	added_at TEXT NOT NULL,
	PRIMARY KEY (group_id, bot_id)
);
CREATE INDEX bot_group_members_world_bot ON bot_group_members (world_id, bot_id);
CREATE TABLE bot_clone_sources (
	bot_id TEXT PRIMARY KEY,
	source_bot_id TEXT NOT NULL,
	source_world_id TEXT NOT NULL,
	source_world_handle TEXT NOT NULL,
	source_handle TEXT NOT NULL,
	cloned_at TEXT NOT NULL,
	linked INTEGER NOT NULL DEFAULT 1,
	unlinked_at TEXT,
	relinked_at TEXT
);
CREATE INDEX bot_clone_sources_source_linked ON bot_clone_sources (source_bot_id, linked);
CREATE TABLE bot_runtime_index (
	bot_id TEXT PRIMARY KEY,
	owner_user_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	enabled INTEGER NOT NULL,
	tick_interval_seconds INTEGER NOT NULL,
	context_window_tokens INTEGER,
	compaction_threshold REAL NOT NULL,
	compaction_summary_percent INTEGER NOT NULL DEFAULT 10,
	compaction_max_characters INTEGER NOT NULL DEFAULT 4000,
	max_tool_calls_per_tick INTEGER NOT NULL,
	max_successful_tool_calls_per_iteration INTEGER NOT NULL DEFAULT 8,
	max_generated_tokens_per_tick INTEGER NOT NULL DEFAULT 15000,
	max_generated_tokens_per_iteration INTEGER NOT NULL DEFAULT 30000,
	next_due_at TEXT,
	status TEXT NOT NULL,
	active_run_id TEXT,
	lease_expires_at TEXT,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX bot_runtime_due ON bot_runtime_index (enabled, next_due_at, lease_expires_at);
CREATE TABLE human_subscriptions (
	subscription_id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	scope_type TEXT NOT NULL,
	scope_id TEXT NOT NULL,
	active INTEGER NOT NULL,
	auto_created INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(user_id, scope_type, scope_id)
);
CREATE INDEX human_subscriptions_user_active ON human_subscriptions (user_id, active, updated_at);
CREATE INDEX human_subscriptions_scope_active ON human_subscriptions (scope_type, scope_id, active);
CREATE TABLE threads_index (
	thread_id TEXT PRIMARY KEY,
	root_comment_id TEXT,
	world_id TEXT NOT NULL,
	world_handle TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	forum_handle TEXT NOT NULL,
	author_bot_id TEXT NOT NULL,
	author_handle TEXT NOT NULL,
	author_display_name TEXT NOT NULL,
	author_display_name_lang TEXT,
	title TEXT NOT NULL,
	title_lang TEXT,
	body_preview TEXT NOT NULL,
	body_preview_lang TEXT,
	search_text TEXT NOT NULL,
	vote_score INTEGER NOT NULL DEFAULT 0,
	comment_count INTEGER NOT NULL DEFAULT 0,
	recent_comment_count INTEGER NOT NULL DEFAULT 0,
	hot_score REAL NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	last_activity_at TEXT NOT NULL,
	deleted_at TEXT
);
CREATE INDEX threads_index_forum_activity ON threads_index (forum_id, deleted_at, last_activity_at);
CREATE VIRTUAL TABLE search_entities_fts USING fts5(
	entity_type UNINDEXED,
	entity_id UNINDEXED,
	world_id UNINDEXED,
	world_handle UNINDEXED,
	world_name UNINDEXED,
	forum_id UNINDEXED,
	forum_handle UNINDEXED,
	bot_id UNINDEXED,
	bot_handle UNINDEXED,
	title,
	body,
	updated_at UNINDEXED
);
`;

beforeEach(async () => {
	await execStatements(testEnv.BICKR_D1, `
		DROP TABLE IF EXISTS search_entities_fts;
		DROP TABLE IF EXISTS threads_index;
		DROP TABLE IF EXISTS human_subscriptions;
		DROP TABLE IF EXISTS bot_runtime_index;
		DROP TABLE IF EXISTS bot_clone_sources;
		DROP TABLE IF EXISTS bot_group_members;
		DROP TABLE IF EXISTS bot_groups;
		DROP TABLE IF EXISTS bots_index;
		DROP TABLE IF EXISTS forums_index;
		DROP TABLE IF EXISTS worlds_index;
		DROP TABLE IF EXISTS users_index;
		DROP TABLE IF EXISTS objects_index;
	`);
	await execStatements(testEnv.BICKR_D1, schemaSql);
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

		await execStatements(testEnv.BICKR_D1, migrationSql);

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

async function clearKv(kv: KVNamespace): Promise<void> {
	let cursor: string | undefined;
	do {
		const list = await kv.list({ cursor });
		await Promise.all(list.keys.map((key) => kv.delete(key.name)));
		cursor = list.list_complete ? undefined : list.cursor;
	} while (cursor);
}

async function execStatements(db: D1Database, sql: string): Promise<void> {
	const withoutLineComments = sql.replace(/^\s*--.*$/gm, "");
	for (const statement of withoutLineComments.split(";")) {
		const trimmed = statement.trim();
		if (trimmed.length > 0) {
			await db.prepare(trimmed).run();
		}
	}
}
