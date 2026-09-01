import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	listHumanNotifications,
	markAllHumanNotificationsRead,
	recordWorldSettingsChangedHumanNotifications,
} from "@bickr/shared/social";
import type { HumanNotificationReadAnchor, WorldDocument } from "@bickr/shared/model";
import type { D1DatabaseLike } from "@bickr/shared/storage";
import { resetD1Schema } from "./helpers/d1-schema";

/**
 * The one thing the mark-all anchor exists to guarantee: a notification that
 * arrives *after* the user's gesture is never marked read. Marking older
 * unrendered rows read is intended; marking a newer one is the bug.
 *
 * These run against real D1 because both things the sweep now leans on are
 * SQLite's, not a fake's: the `rowid` an INSERT assigns, and the fact that the
 * coalescing `UPDATE ... SET created_at = ?` does not move it.
 *
 * The ids here are shaped like the ones `makeId("hnt")` mints — a prefix and a
 * random UUID — because that is the whole point of the first case: within a
 * `created_at` tie, id order says nothing about insertion order, so a row
 * written after the anchor is as likely to sort below the anchor's id as above
 * it. The favourable direction alone proves nothing.
 */

const userId = "usr_anchor";
const worldId = "wld_anchor";
const botId = "bot_anchor";
const tieAt = "2026-05-06T12:00:00.000Z";
const afterAt = "2026-05-06T12:00:03.000Z";
const readAt = "2026-05-06T12:00:09.000Z";

/** Sorts above every id below it; the anchor in the tie case. */
const highId = "hnt_ffffffff-ffff-4fff-8fff-ffffffffffff";
/** Sorts below `highId`, and is written after it. */
const lowId = "hnt_00000000-0000-4000-8000-000000000000";

function db(): D1DatabaseLike {
	return testEnv.BICKR_D1 as unknown as D1DatabaseLike;
}

async function insertNotification(id: string, createdAt: string, type = "mention"): Promise<void> {
	await testEnv.BICKR_D1
		.prepare(
			`INSERT INTO human_notifications (
				notification_id, user_id, world_id, event_key, notification_type,
				actor_bot_id, title, body, url_path, created_at
			) VALUES (?, ?, ?, ?, ?, ?, 'Title', 'Body', '/', ?)`,
		)
		.bind(id, userId, worldId, `evt_${id}`, type, botId, createdAt)
		.run();
}

/**
 * The owner of an active bot in the world is who a settings change notifies.
 * `bots_index` will not take a live row without the canonical handle claim that
 * backs it, so the claim goes in first.
 */
async function insertOwnedBot(): Promise<void> {
	await testEnv.BICKR_D1
		.prepare(
			`INSERT INTO entity_lifecycle_identity_claims (
				key_kind, key_scope, key_value, entity_kind, entity_id,
				owner_user_id, claim_state, created_at, updated_at
			) VALUES ('bot_handle', ?, 'anchor-bot', 'bot', ?, ?, 'active', ?, ?)`,
		)
		.bind(worldId, botId, userId, tieAt, tieAt)
		.run();
	await testEnv.BICKR_D1
		.prepare(
			`INSERT INTO bots_index (
				bot_id, home_world_id, home_world_handle, handle, display_name,
				owner_user_id, short_bio, created_at, updated_at
			) VALUES (?, ?, 'anchor-world', 'anchor-bot', 'Anchor Bot', ?, 'Bio', ?, ?)`,
		)
		.bind(botId, worldId, userId, tieAt, tieAt)
		.run();
}

function world(name: string): WorldDocument {
	return {
		id: worldId,
		type: "world",
		schemaVersion: 1,
		revision: 1,
		createdAt: tieAt,
		updatedAt: tieAt,
		handle: "anchor-world",
		language: null,
		name: { lang: null, text: name },
		description: { lang: null, text: "A world" },
		prompt: { lang: null, text: "Prompt" },
		recurringPromptEnabled: false,
		recurringPrompt: { lang: null, text: "" },
		initialBotNotification: { lang: null, text: "" },
		createdByUserId: "usr_editor",
		visibility: "public",
	};
}

/**
 * The coalescing path, driven through its real entry point: with an unread
 * `world_settings_changed` row already there it takes that row and rewrites it,
 * `created_at` included, rather than inserting a new one.
 */
async function recordSettingsChange(now: string, name: string): Promise<void> {
	await recordWorldSettingsChangedHumanNotifications(db(), {
		previous: world("Anchor World"),
		updated: world(name),
		editorUserId: "usr_editor",
		now,
	});
}

async function unreadIds(): Promise<string[]> {
	const result = await testEnv.BICKR_D1
		.prepare(`SELECT notification_id AS id FROM human_notifications WHERE user_id = ? AND read_at IS NULL`)
		.bind(userId)
		.all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id).sort();
}

async function createdAtOf(id: string): Promise<string | undefined> {
	const row = await testEnv.BICKR_D1
		.prepare(`SELECT created_at AS createdAt FROM human_notifications WHERE notification_id = ?`)
		.bind(id)
		.first<{ createdAt: string }>();
	return row?.createdAt;
}

/** The newest row the list rendered, which is what the client sends as the anchor. */
async function anchorFromRenderedList(): Promise<HumanNotificationReadAnchor> {
	const page = await listHumanNotifications(db(), userId, "all", 50, 0);
	const newest = page.notifications[0];
	expect(newest).toBeDefined();
	return { notificationId: newest.id, createdAt: newest.createdAt };
}

describe("mark-all never reaches a notification that arrived after the gesture", () => {
	beforeEach(async () => {
		await resetD1Schema(testEnv.BICKR_D1);
	});

	it("leaves a row written after the anchor in the anchor's millisecond unread, id order notwithstanding", async () => {
		await insertNotification(highId, tieAt);
		const anchor = await anchorFromRenderedList();
		expect(anchor.notificationId).toBe(highId);
		// The rest of the fan-out lands after the click, in the same millisecond,
		// with an id that sorts *below* the anchor's — which is where a random
		// UUID lands about half the time, and where `(created_at, notification_id)`
		// stops being able to tell the two apart.
		await insertNotification(lowId, tieAt);
		expect(lowId < highId).toBe(true);

		await markAllHumanNotificationsRead(db(), userId, { scopeType: "all" }, readAt, anchor);

		expect(await unreadIds()).toEqual([lowId]);
	});

	it("leaves it unread when the coalescing path bumps the anchor's own created_at past it", async () => {
		await insertOwnedBot();
		// The anchor is a `world_settings_changed` row, which is the one kind the
		// coalescing path rewrites in place.
		await recordSettingsChange(tieAt, "Renamed Once");
		const anchor = await anchorFromRenderedList();
		expect(anchor.createdAt).toBe(tieAt);
		// After the click: a new notification, and then a second settings change,
		// which coalesces onto the anchor row and stamps it later than that new
		// notification. Re-reading the anchor row's stored `created_at` now would
		// sweep straight over the row the user never saw.
		await insertNotification(lowId, afterAt);
		await recordSettingsChange("2026-05-06T12:00:06.000Z", "Renamed Twice");
		expect(await createdAtOf(anchor.notificationId)).toBe("2026-05-06T12:00:06.000Z");

		await markAllHumanNotificationsRead(db(), userId, { scopeType: "all" }, readAt, anchor);

		// The bumped anchor row is carrying a change of its own that the user has
		// not seen, so it stays unread too.
		expect(await unreadIds()).toEqual([anchor.notificationId, lowId].sort());
	});

	it("leaves a row bumped above the rendered anchor timestamp unread, though it predates the anchor", async () => {
		await insertOwnedBot();
		await recordSettingsChange("2026-05-06T11:59:00.000Z", "Renamed Once");
		await insertNotification(highId, tieAt);
		const anchor = await anchorFromRenderedList();
		expect(anchor.notificationId).toBe(highId);
		// The older row was rendered — but the change it now carries was not.
		await recordSettingsChange(afterAt, "Renamed Twice");

		await markAllHumanNotificationsRead(db(), userId, { scopeType: "all" }, readAt, anchor);

		const settingsId = (await unreadIds())[0];
		expect(settingsId).toBeDefined();
		expect(settingsId).not.toBe(highId);
		expect(await createdAtOf(settingsId)).toBe(afterAt);
	});
});
