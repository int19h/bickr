import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { localizedText, type BotDocument, type LanguageTag } from "../packages/shared/src/model";
import { RepositoryError } from "../packages/shared/src/repository";
import {
	bootstrapNotificationId,
	deleteDeliveredNotifications,
	listOwnedBotPendingNotifications,
	listPendingNotifications,
	markOwnedBotNotificationsRead,
	ownedBotNotificationListMaxLimit,
} from "../packages/shared/src/social";
import { kvKeys, writeJson } from "../packages/shared/src/storage";
import { InputError } from "../packages/shared/src/validation";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";

const owner = "usr_owner";
const botId = "bot_inbox";
const otherBotId = "bot_inbox_sibling";
const now = "2026-09-25T12:00:00.000Z";
const en = "en" as LanguageTag;
const kv = testEnv.BICKR_KV;
const db = testEnv.BICKR_D1;

function minutesBefore(minutes: number): string {
	return new Date(Date.parse(now) - minutes * 60 * 1000).toISOString();
}

async function insertBot(input: {
	id: string;
	ownerUserId?: string;
	paused?: boolean;
	deleted?: boolean;
	bootstrapNotifiedAt?: string;
}): Promise<void> {
	const bot: BotDocument = {
		id: input.id,
		type: "bot",
		schemaVersion: 1,
		revision: 1,
		homeWorldId: "wld_inbox",
		homeWorldHandle: "inbox-world",
		ownerUserId: input.ownerUserId ?? owner,
		handle: `handle-${input.id}`,
		language: en,
		includeLanguageInSystemPrompt: false,
		displayName: localizedText("Inbox bot", en),
		shortBio: localizedText("Bio", en),
		prompt: localizedText("Prompt", en),
		inferenceSettings: {},
		toolSettings: {},
		tickSettings: { enabled: !input.paused, intervalSeconds: 86_400, compactionThreshold: 0.75 },
		createdAt: now,
		updatedAt: now,
	};
	await writeJson(kv, kvKeys.bot(bot.id), bot);
	// bots_index enforces a live handle claim by trigger.
	await db.prepare(
		`INSERT INTO entity_lifecycle_identity_claims (
			key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
			claim_state, operation_id, created_at, updated_at
		) VALUES ('bot_handle', 'wld_inbox', ?, 'bot', ?, ?, 'active', NULL, ?, ?)`,
	).bind(bot.handle, bot.id, bot.ownerUserId, now, now).run();
	await db.prepare(
		`INSERT INTO bots_index (
			bot_id, home_world_id, home_world_handle, handle, display_name,
			owner_user_id, short_bio, created_at, updated_at, lifecycle_state, bootstrap_notified_at
		) VALUES (?, 'wld_inbox', 'inbox-world', ?, 'Inbox bot', ?, 'Bio', ?, ?, 'active', ?)`,
	).bind(bot.id, bot.handle, bot.ownerUserId, now, now, input.bootstrapNotifiedAt ?? null).run();
	if (input.deleted) {
		await db.prepare(`UPDATE bots_index SET deleted_at = ? WHERE bot_id = ?`).bind(now, bot.id).run();
	}
}

async function insertNotification(input: {
	id: string;
	type: string;
	createdAt: string;
	botId?: string;
	status?: string;
	/** False for a ghost: a row whose KV document is gone. */
	document?: false;
}): Promise<void> {
	const target = input.botId ?? botId;
	if (input.document !== false) {
		await kv.put(kvKeys.notification(target, input.id), JSON.stringify({
			id: input.id,
			type: "notification",
			schemaVersion: 1,
			revision: 1,
			worldId: "wld_inbox",
			botId: target,
			notificationType: input.type,
			status: "pending",
			message: { lang: "en", text: `Notification ${input.id}` },
			event: { kind: "bootstrap", type: "bootstrap", id: input.id, createdAt: input.createdAt, deliveryReasons: ["bootstrap"] },
			createdAt: input.createdAt,
			updatedAt: input.createdAt,
		}));
	}
	await db.prepare(
		`INSERT INTO notifications (
			notification_id, world_id, bot_id, type, source_object_id, status, message, message_lang,
			created_at, delivered_at, read_at
		) VALUES (?, 'wld_inbox', ?, ?, NULL, ?, ?, 'en', ?, NULL, NULL)`,
	).bind(input.id, target, input.type, input.status ?? "pending", `Notification ${input.id}`, input.createdAt).run();
}

async function rowIds(target = botId): Promise<string[]> {
	const result = await db.prepare(
		`SELECT notification_id AS id FROM notifications WHERE bot_id = ? ORDER BY notification_id`,
	).bind(target).all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id);
}

async function hasDocument(id: string, target = botId): Promise<boolean> {
	return (await kv.get(kvKeys.notification(target, id))) !== null;
}

async function listIds(limit?: number): Promise<string[]> {
	const page = await listOwnedBotPendingNotifications(kv, db, { ownerUserId: owner, botId, ...(limit ? { limit } : {}) });
	return page.notifications.map((notification) => notification.id);
}

beforeEach(async () => {
	await resetD1Schema(db);
	await clearKv(kv);
	await insertBot({ id: botId });
	await insertBot({ id: otherBotId });
});

describe("owner listing of pending participant notifications", () => {
	it("orders by recency alone, ignoring delivery priority, with an id tie-break", async () => {
		// The delivery order would put the old reply first; the owner view does not.
		await insertNotification({ id: "ntf_reply_old", type: "reply", createdAt: minutesBefore(30) });
		await insertNotification({ id: "ntf_vote_new", type: "vote", createdAt: minutesBefore(1) });
		await insertNotification({ id: "ntf_tie_a", type: "follow", createdAt: minutesBefore(10) });
		await insertNotification({ id: "ntf_tie_b", type: "mention", createdAt: minutesBefore(10) });

		expect(await listIds()).toEqual(["ntf_vote_new", "ntf_tie_b", "ntf_tie_a", "ntf_reply_old"]);
		expect((await listPendingNotifications(kv, db, botId, 20, { now })).map((item) => item.id)[0]).toBe("ntf_reply_old");
	});

	it("returns the N most recent and reports whether older ones remain", async () => {
		for (let index = 0; index < 5; index += 1) {
			await insertNotification({ id: `ntf_${index}`, type: "vote", createdAt: minutesBefore(index + 1) });
		}
		const firstTwo = await listOwnedBotPendingNotifications(kv, db, { ownerUserId: owner, botId, limit: 2 });
		expect(firstTwo.notifications.map((item) => item.id)).toEqual(["ntf_0", "ntf_1"]);
		expect(firstTwo.hasMore).toBe(true);
		const all = await listOwnedBotPendingNotifications(kv, db, { ownerUserId: owner, botId, limit: 5 });
		expect(all.hasMore).toBe(false);
		expect(all.notifications[0]).toMatchObject({
			id: "ntf_0",
			botId,
			worldId: "wld_inbox",
			notificationType: "vote",
			message: { lang: "en", text: "Notification ntf_0" },
			event: { kind: "bootstrap" },
		});
	});

	it("does not consume, mark, or reorder what the next visit is handed", async () => {
		await insertNotification({ id: "ntf_a", type: "reply", createdAt: minutesBefore(3) });
		await insertNotification({ id: "ntf_b", type: "vote", createdAt: minutesBefore(2) });
		await listIds();
		await listIds();
		expect(await rowIds()).toEqual(["ntf_a", "ntf_b"]);
		expect(await hasDocument("ntf_a")).toBe(true);
		expect((await listPendingNotifications(kv, db, botId, 20, { now })).map((item) => item.id)).toEqual(["ntf_a", "ntf_b"]);
	});

	it("skips ghost rows without healing them, leaving the bootstrap flag alone", async () => {
		await insertBot({ id: "bot_ghostly", bootstrapNotifiedAt: minutesBefore(600) });
		const ghostId = await bootstrapNotificationId("bot_ghostly");
		await insertNotification({ id: ghostId, type: "bootstrap", createdAt: minutesBefore(600), botId: "bot_ghostly", document: false });
		await insertNotification({ id: "ntf_live", type: "vote", createdAt: minutesBefore(700), botId: "bot_ghostly" });

		const page = await listOwnedBotPendingNotifications(kv, db, { ownerUserId: owner, botId: "bot_ghostly" });
		expect(page.notifications.map((item) => item.id)).toEqual(["ntf_live"]);
		expect(page.unavailableCount).toBe(1);
		// The ghost row and its flag are the loop's to heal, not a listing's.
		expect(await rowIds("bot_ghostly")).toEqual([ghostId, "ntf_live"].sort());
		const flag = await db.prepare(`SELECT bootstrap_notified_at AS at FROM bots_index WHERE bot_id = 'bot_ghostly'`).first<{ at: string | null }>();
		expect(flag?.at).toBe(minutesBefore(600));
	});

	it("ignores rows left in a retired status and other participants' rows", async () => {
		await insertNotification({ id: "ntf_retired", type: "reply", createdAt: minutesBefore(1), status: "delivered" });
		await insertNotification({ id: "ntf_sibling", type: "reply", createdAt: minutesBefore(1), botId: otherBotId });
		await insertNotification({ id: "ntf_mine", type: "reply", createdAt: minutesBefore(2) });
		expect(await listIds()).toEqual(["ntf_mine"]);
	});

	it("bounds how many ghost rows and queries one listing spends", async () => {
		for (let index = 0; index < 120; index += 1) {
			await insertNotification({ id: `ntf_ghost_${String(index).padStart(3, "0")}`, type: "vote", createdAt: minutesBefore(index + 1), document: false });
		}
		await insertNotification({ id: "ntf_buried", type: "vote", createdAt: minutesBefore(500) });
		const page = await listOwnedBotPendingNotifications(kv, db, { ownerUserId: owner, botId, limit: ownedBotNotificationListMaxLimit });
		expect(page.notifications).toEqual([]);
		expect(page.unavailableCount).toBe(100);
		expect(page.hasMore).toBe(true);
		// A small limit refills one row at a time, so the round cap binds first.
		const small = await listOwnedBotPendingNotifications(kv, db, { ownerUserId: owner, botId, limit: 1 });
		expect(small).toMatchObject({ notifications: [], unavailableCount: 4, hasMore: true });
	});

	it("rejects a limit outside 1 through the maximum", async () => {
		for (const limit of [0, ownedBotNotificationListMaxLimit + 1, 1.5]) {
			await expect(listOwnedBotPendingNotifications(kv, db, { ownerUserId: owner, botId, limit })).rejects.toBeInstanceOf(InputError);
		}
	});

	it("serves a paused participant and rejects other owners and deleted participants", async () => {
		await insertBot({ id: "bot_paused", paused: true });
		await insertNotification({ id: "ntf_paused", type: "reply", createdAt: minutesBefore(1), botId: "bot_paused" });
		const paused = await listOwnedBotPendingNotifications(kv, db, { ownerUserId: owner, botId: "bot_paused" });
		expect(paused.notifications.map((item) => item.id)).toEqual(["ntf_paused"]);

		await insertBot({ id: "bot_foreign", ownerUserId: "usr_other" });
		await expect(listOwnedBotPendingNotifications(kv, db, { ownerUserId: owner, botId: "bot_foreign" }))
			.rejects.toMatchObject({ code: "forbidden", status: 403 });
		await insertBot({ id: "bot_gone", deleted: true });
		await expect(listOwnedBotPendingNotifications(kv, db, { ownerUserId: owner, botId: "bot_gone" }))
			.rejects.toMatchObject({ code: "not_found" });
		await expect(listOwnedBotPendingNotifications(kv, db, { ownerUserId: owner, botId: "bot_missing" }))
			.rejects.toBeInstanceOf(RepositoryError);
	});
});

describe("owner marking of participant notifications read", () => {
	it("removes only the named notifications from both stores, never newer unseen ones", async () => {
		await insertNotification({ id: "ntf_old", type: "reply", createdAt: minutesBefore(3) });
		await insertNotification({ id: "ntf_seen", type: "vote", createdAt: minutesBefore(2) });
		await insertNotification({ id: "ntf_unseen", type: "vote", createdAt: minutesBefore(1) });

		const result = await markOwnedBotNotificationsRead(kv, db, { ownerUserId: owner, botId, notificationIds: ["ntf_seen", "ntf_old"] });
		expect(result).toEqual({ botId, markedReadCount: 2, notPendingCount: 0 });
		expect(await rowIds()).toEqual(["ntf_unseen"]);
		expect(await hasDocument("ntf_seen")).toBe(false);
		expect(await hasDocument("ntf_unseen")).toBe(true);
		expect((await listPendingNotifications(kv, db, botId, 20, { now })).map((item) => item.id)).toEqual(["ntf_unseen"]);
	});

	it("is safe to repeat, and counts duplicates, unknown IDs and consumed IDs as not pending", async () => {
		await insertNotification({ id: "ntf_once", type: "reply", createdAt: minutesBefore(2) });
		await insertNotification({ id: "ntf_delivered", type: "reply", createdAt: minutesBefore(1) });
		const first = await markOwnedBotNotificationsRead(kv, db, { ownerUserId: owner, botId, notificationIds: ["ntf_once", "ntf_once"] });
		expect(first).toEqual({ botId, markedReadCount: 1, notPendingCount: 0 });
		const again = await markOwnedBotNotificationsRead(kv, db, { ownerUserId: owner, botId, notificationIds: ["ntf_once", "ntf_never"] });
		expect(again).toEqual({ botId, markedReadCount: 0, notPendingCount: 2 });

		// A visit delivers between the owner's listing and the owner's mark.
		const listed = await listIds();
		await deleteDeliveredNotifications(kv, db, await listPendingNotifications(kv, db, botId, 20, { now }));
		expect(await markOwnedBotNotificationsRead(kv, db, { ownerUserId: owner, botId, notificationIds: listed }))
			.toEqual({ botId, markedReadCount: 0, notPendingCount: 1 });
	});

	it("rejects the whole call when any ID belongs to another participant", async () => {
		await insertNotification({ id: "ntf_mine", type: "reply", createdAt: minutesBefore(2) });
		await insertNotification({ id: "ntf_sibling", type: "reply", createdAt: minutesBefore(1), botId: otherBotId });
		await expect(markOwnedBotNotificationsRead(kv, db, { ownerUserId: owner, botId, notificationIds: ["ntf_mine", "ntf_sibling"] }))
			.rejects.toBeInstanceOf(InputError);
		expect(await rowIds()).toEqual(["ntf_mine"]);
		expect(await rowIds(otherBotId)).toEqual(["ntf_sibling"]);
		expect(await hasDocument("ntf_sibling", otherBotId)).toBe(true);
	});

	it("leaves rows in a retired status to the prune", async () => {
		await insertNotification({ id: "ntf_retired", type: "reply", createdAt: minutesBefore(1), status: "read" });
		expect(await markOwnedBotNotificationsRead(kv, db, { ownerUserId: owner, botId, notificationIds: ["ntf_retired"] }))
			.toEqual({ botId, markedReadCount: 0, notPendingCount: 1 });
		expect(await rowIds()).toEqual(["ntf_retired"]);
	});

	it("keeps the bootstrap flag set when the bootstrap is marked read, so it is not recreated", async () => {
		await insertBot({ id: "bot_new", bootstrapNotifiedAt: minutesBefore(5) });
		const bootstrapId = await bootstrapNotificationId("bot_new");
		await insertNotification({ id: bootstrapId, type: "bootstrap", createdAt: minutesBefore(5), botId: "bot_new" });
		expect(await markOwnedBotNotificationsRead(kv, db, { ownerUserId: owner, botId: "bot_new", notificationIds: [bootstrapId] }))
			.toEqual({ botId: "bot_new", markedReadCount: 1, notPendingCount: 0 });
		const flag = await db.prepare(`SELECT bootstrap_notified_at AS at FROM bots_index WHERE bot_id = 'bot_new'`).first<{ at: string | null }>();
		expect(flag?.at).toBe(minutesBefore(5));
	});

	it("serves a paused participant, rejects other owners, and bounds the ID list", async () => {
		await insertBot({ id: "bot_paused", paused: true });
		await insertNotification({ id: "ntf_paused", type: "reply", createdAt: minutesBefore(1), botId: "bot_paused" });
		expect(await markOwnedBotNotificationsRead(kv, db, { ownerUserId: owner, botId: "bot_paused", notificationIds: ["ntf_paused"] }))
			.toMatchObject({ markedReadCount: 1 });

		await insertBot({ id: "bot_foreign", ownerUserId: "usr_other" });
		await insertNotification({ id: "ntf_foreign", type: "reply", createdAt: minutesBefore(1), botId: "bot_foreign" });
		await expect(markOwnedBotNotificationsRead(kv, db, { ownerUserId: owner, botId: "bot_foreign", notificationIds: ["ntf_foreign"] }))
			.rejects.toMatchObject({ code: "forbidden" });
		expect(await rowIds("bot_foreign")).toEqual(["ntf_foreign"]);

		await expect(markOwnedBotNotificationsRead(kv, db, { ownerUserId: owner, botId, notificationIds: [] }))
			.rejects.toBeInstanceOf(InputError);
		await expect(markOwnedBotNotificationsRead(kv, db, {
			ownerUserId: owner,
			botId,
			notificationIds: Array.from({ length: ownedBotNotificationListMaxLimit + 1 }, (_, index) => `ntf_${index}`),
		})).rejects.toBeInstanceOf(InputError);
	});
});
