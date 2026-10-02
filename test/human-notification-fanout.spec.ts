import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { enqueueHumanNotificationFanout, runHumanNotificationFanout } from "@bickr/shared/human-notification-fanout";
import type { D1DatabaseLike, D1PreparedStatementLike } from "@bickr/shared/storage";
import { resetD1Schema } from "./helpers/d1-schema";

const db = env.BICKR_D1 as unknown as D1DatabaseLike;
const createdAt = "2026-10-01T00:00:00.000Z";
const now = "2026-10-02T00:00:00.000Z";
const worldId = "wld_fanout";
const input = {
	audience: { kind: "subscriptions" as const, scopes: [{ scopeType: "world" as const, scopeId: worldId }] },
	source: { kind: "world" as const, id: worldId, revision: 1 },
	notification: { worldId, eventKey: "event1", notificationType: "thread_created" as const, title: "Title", body: "Body", urlPath: "/", now: createdAt },
};

beforeEach(async () => {
	await resetD1Schema(env.BICKR_D1);
	await claim("world_handle", "global", "fanout", "world", worldId, "usr_editor");
	await db.prepare(`INSERT INTO worlds_index (world_id,handle,name,description,created_by_user_id,visibility,created_at,updated_at)
		VALUES (?, 'fanout', 'Fanout', '', 'usr_editor', 'public', ?, ?)`).bind(worldId, createdAt, createdAt).run();
});

async function claim(key: string, scope: string, handle: string, kind: string, id: string, owner: string) {
	await db.prepare(`INSERT INTO entity_lifecycle_identity_claims (key_kind,key_scope,key_value,entity_kind,entity_id,owner_user_id,claim_state,created_at,updated_at)
		VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`).bind(key, scope, handle, kind, id, owner, createdAt, createdAt).run();
}

async function recipients(count: number) {
	const ids = Array.from({ length: count }, (_, index) => `usr_${String(index).padStart(4, "0")}`);
	for (let i = 0; i < ids.length; i += 50) {
		await db.batch(ids.slice(i, i + 50).flatMap(id => [
			db.prepare(`INSERT INTO entity_lifecycle_identity_claims (key_kind,key_scope,key_value,entity_kind,entity_id,owner_user_id,claim_state,created_at,updated_at) VALUES ('user_handle','global',?,'account',?,?,'active',?,?)`).bind(id,id,id,createdAt,createdAt),
			db.prepare(`INSERT INTO users_index (user_id,handle,display_name,created_at,updated_at) VALUES (?, ?, ?, ?, ?)`).bind(id, id, id, createdAt, createdAt),
			db.prepare(`INSERT INTO human_subscriptions (subscription_id,user_id,world_id,scope_type,scope_id,active,auto_created,created_at,updated_at)
				VALUES (?, ?, ?, 'world', ?, 1, 0, ?, ?)`).bind(id, id, worldId, worldId, createdAt, createdAt),
		]));
	}
	return ids;
}

async function count() { return (await db.prepare("SELECT COUNT(*) AS n FROM human_notifications").first<{ n: number }>())!.n; }

describe("human notification fanout", () => {
	it("bounds each page at 50 and resumes through a 123-person audience without duplicates", async () => {
		await recipients(123);
		await enqueueHumanNotificationFanout(db, input);
		expect(await count()).toBe(0);
		expect(await runHumanNotificationFanout(db, now, { maxPages: 1 })).toMatchObject({ pages: 1, recipients: 50, pending: true });
		expect(await count()).toBe(50);
		await runHumanNotificationFanout(db, now, { maxPages: 1 });
		expect(await count()).toBe(100);
		expect(await runHumanNotificationFanout(db, now, { maxPages: 1 })).toMatchObject({ recipients: 23, pending: false });
		expect(await count()).toBe(123);
		await enqueueHumanNotificationFanout(db, input);
		expect(await runHumanNotificationFanout(db, now, { maxPages: 1 })).toMatchObject({ pages: 0 });
		expect(await db.prepare("SELECT event_json FROM human_notification_fanout").first()).toEqual({ event_json: null });
	});

	it("fences stale batches even after delivered rows have been removed", async () => {
		await recipients(60);
		await enqueueHumanNotificationFanout(db, input);
		let page: D1PreparedStatementLike[] = [];
		const capture: D1DatabaseLike = { prepare: sql => db.prepare(sql), batch: async statements => {
			page = statements;
			return db.batch(statements);
		} };
		await runHumanNotificationFanout(capture, now, { maxPages: 1 });
		expect(await count()).toBe(50);
		await db.prepare("DELETE FROM human_notifications").run();
		await db.batch(page);
		expect(await count()).toBe(0);
		await runHumanNotificationFanout(db, now, { maxPages: 1 });
		expect(await count()).toBe(10);
	});

	it("rolls back notification inserts when the cursor commit fails", async () => {
		await recipients(3);
		await enqueueHumanNotificationFanout(db, input);
		const failing: D1DatabaseLike = { prepare: sql => db.prepare(sql), batch: statements =>
			db.batch([...statements.slice(0, 1), db.prepare("INSERT INTO missing_fanout_table VALUES (1)"), ...statements.slice(1)]) };
		await expect(runHumanNotificationFanout(failing, now)).rejects.toThrow();
		expect(await count()).toBe(0);
		await runHumanNotificationFanout(db, now, { maxPages: 1 });
		expect(await count()).toBe(3);
	});

	it("checks recipient and source deletion inside the delivery transaction", async () => {
		await recipients(3);
		await enqueueHumanNotificationFanout(db, input);
		const deleting: D1DatabaseLike = { prepare: sql => db.prepare(sql), batch: async statements => {
			await db.prepare("UPDATE users_index SET lifecycle_state = 'deleting' WHERE user_id = 'usr_0000'").run();
			return db.batch(statements);
		} };
		await runHumanNotificationFanout(deleting, now);
		expect(await count()).toBe(2);
		await enqueueHumanNotificationFanout(db, { ...input, notification: { ...input.notification, eventKey: "event2" } });
		await db.prepare("UPDATE worlds_index SET deleted_at = ?").bind(now).run();
		await runHumanNotificationFanout(db, now, { maxPages: 1 });
		expect(await count()).toBe(2);
	});

	it("deduplicates overlapping subscriptions and excludes same-time subscriptions added after publication", async () => {
		await recipients(2);
		await db.prepare("DELETE FROM human_subscriptions WHERE user_id = 'usr_0001'").run();
		await db.prepare(`INSERT INTO human_subscriptions (subscription_id,user_id,world_id,scope_type,scope_id,active,auto_created,created_at,updated_at)
			SELECT subscription_id || '-bot', user_id,world_id,'bot','bot_a',active,auto_created,created_at,updated_at FROM human_subscriptions`).run();
		await enqueueHumanNotificationFanout(db, { ...input, audience: { kind: "subscriptions", scopes: [...input.audience.scopes, { scopeType: "bot", scopeId: "bot_a" }] } });
		await db.prepare(`INSERT INTO human_subscriptions (subscription_id,user_id,world_id,scope_type,scope_id,active,auto_created,created_at,updated_at)
			VALUES ('late', 'usr_0001', ?, 'world', ?, 1, 0, ?, ?)`).bind(worldId, worldId, createdAt, createdAt).run();
		await runHumanNotificationFanout(db, now);
		expect(await count()).toBe(1);
	});

	it("coalesces unread world changes without replacing newer text or changing read anchors", async () => {
		const [owner] = await recipients(1);
		await claim("bot_handle", worldId, "member", "bot", "bot_member", owner!);
		await db.prepare(`INSERT INTO bots_index (bot_id,home_world_id,home_world_handle,handle,display_name,owner_user_id,short_bio,created_at,updated_at)
			VALUES ('bot_member', ?, 'fanout', 'member', 'Member', ?, '', ?, ?)`).bind(worldId, owner, createdAt, createdAt).run();
		const settings = { ...input, audience: { kind: "world_owners" as const, worldId, excludeUserId: "usr_editor" },
			notification: { ...input.notification, eventKey: "settings1", notificationType: "world_settings_changed" as const } };
		await enqueueHumanNotificationFanout(db, settings);
		await runHumanNotificationFanout(db, now, { maxPages: 1 });
		const first = await db.prepare("SELECT rowid, notification_id FROM human_notifications").first();
		await enqueueHumanNotificationFanout(db, { ...settings, source: { ...settings.source, revision: 2 }, notification: { ...settings.notification, eventKey: "settings2", now: createdAt, title: "New settings" } });
		await runHumanNotificationFanout(db, now, { maxPages: 1 });
		expect(await count()).toBe(1);
		expect(await db.prepare("SELECT rowid, notification_id FROM human_notifications").first()).toEqual(first);
		expect(await db.prepare("SELECT title FROM human_notifications").first()).toEqual({ title: "New settings" });
		await enqueueHumanNotificationFanout(db, { ...settings, notification: { ...settings.notification, eventKey: "delayed_old", title: "Old settings" } });
		await runHumanNotificationFanout(db, now, { maxPages: 1 });
		expect(await db.prepare("SELECT title FROM human_notifications").first()).toEqual({ title: "New settings" });
		await db.prepare("UPDATE human_notifications SET read_at = ?").bind(now).run();
		await enqueueHumanNotificationFanout(db, { ...settings, source: { ...settings.source, revision: 3 }, notification: { ...settings.notification, eventKey: "settings3", now } });
		await runHumanNotificationFanout(db, now, { maxPages: 1 });
		expect(await count()).toBe(2);
	});

	it("expires pending jobs at the feed retention cutoff", async () => {
		await recipients(1);
		await enqueueHumanNotificationFanout(db, input);
		expect(await runHumanNotificationFanout(db, "2026-11-01T00:00:00.000Z")).toMatchObject({ expiredJobs: 1, pages: 0, pending: false });
		expect(await count()).toBe(0);
	});

	it("excludes reactivation after an event but keeps redundant active updates eligible", async () => {
		await recipients(2);
		await db.prepare("UPDATE human_subscriptions SET active = 0 WHERE user_id = 'usr_0000'").run();
		await enqueueHumanNotificationFanout(db, input);
		await db.prepare("UPDATE human_subscriptions SET active = 1, updated_at = ?").bind(createdAt).run();
		await runHumanNotificationFanout(db, now);
		expect((await db.prepare("SELECT user_id FROM human_notifications").all()).results).toEqual([{ user_id: "usr_0001" }]);
	});

	it("excludes world membership created after publication in the same millisecond", async () => {
		const owners = await recipients(2);
		async function addMember(index: number) {
			const id = `bot_member_${index}`;
			await claim("bot_handle", worldId, id, "bot", id, owners[index]!);
			await db.prepare(`INSERT INTO bots_index (bot_id,home_world_id,home_world_handle,handle,display_name,owner_user_id,short_bio,created_at,updated_at)
				VALUES (?, ?, 'fanout', ?, 'Member', ?, '', ?, ?)`).bind(id, worldId, id, owners[index], createdAt, createdAt).run();
		}
		await addMember(0);
		await enqueueHumanNotificationFanout(db, { ...input, audience: { kind: "world_owners", worldId, excludeUserId: "usr_editor" },
			notification: { ...input.notification, notificationType: "world_settings_changed" } });
		await addMember(1);
		await runHumanNotificationFanout(db, now);
		expect((await db.prepare("SELECT user_id FROM human_notifications").all()).results).toEqual([{ user_id: owners[0] }]);
	});

	it("finishes small multi-scope jobs within one pump invocation", async () => {
		await recipients(3);
		await enqueueHumanNotificationFanout(db, { ...input, audience: { kind: "subscriptions", scopes: [...input.audience.scopes, { scopeType: "forum", scopeId: "frm_empty" }] } });
		expect(await runHumanNotificationFanout(db, now)).toMatchObject({ pages: 2, recipients: 3, pending: false });
	});

	it.each(["comment", "thread", "forum"] as const)("suppresses delivery when its %s is deleted", async kind => {
		await recipients(1);
		await db.batch([
			db.prepare(`INSERT INTO forums_index (forum_id,world_id,world_handle,handle,description,created_by_user_id,created_at,updated_at)
				VALUES ('frm_source',?,'fanout','source','','usr_editor',?,?)`).bind(worldId,createdAt,createdAt),
			db.prepare(`INSERT INTO threads_index (thread_id,world_id,world_handle,forum_id,forum_handle,author_bot_id,author_handle,author_display_name,title,body_preview,search_text,created_at,last_activity_at)
				VALUES ('thr_source',?,'fanout','frm_source','source','bot_source','source','Source','Title','Body','Body',?,?)`).bind(worldId,createdAt,createdAt),
			db.prepare(`INSERT INTO comments_index (comment_id,thread_id,world_id,forum_id,author_bot_id,author_handle,body_preview,search_text,created_at)
				VALUES ('cmt_source','thr_source',?,'frm_source','bot_source','source','Body','Body',?)`).bind(worldId,createdAt),
		]);
		await enqueueHumanNotificationFanout(db, { ...input, source: { kind: "comment", id: "cmt_source" } });
		const deletion = { comment: "UPDATE comments_index SET deleted_at = ?", thread: "UPDATE threads_index SET deleted_at = ?", forum: "UPDATE forums_index SET deleted_at = ?" };
		const deleting: D1DatabaseLike = { prepare: sql => db.prepare(sql), batch: async statements => {
			await db.prepare(deletion[kind]).bind(now).run();
			return db.batch(statements);
		} };
		await runHumanNotificationFanout(deleting, now);
		expect(await count()).toBe(0);
	});

	it("uses keyset indexes for both audience shapes", async () => {
		const subscriptions = await db.prepare(`EXPLAIN QUERY PLAN SELECT user_id FROM human_subscriptions WHERE scope_type = 'world'
			AND scope_id = ? AND active = 1 AND user_id > '' AND activation_after_sequence < ? ORDER BY user_id LIMIT 50`).bind(worldId, 1).all<{ detail: string }>();
		const owners = await db.prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT owner_user_id FROM bots_index WHERE home_world_id = ?
			AND lifecycle_state = 'active' AND deleted_at IS NULL AND owner_user_id > '' AND membership_after_sequence < ? ORDER BY owner_user_id LIMIT 50`).bind(worldId, 1).all<{ detail: string }>();
		expect(subscriptions.results?.map(row => row.detail).join(" ")).toContain("human_subscriptions_fanout");
		expect(owners.results?.map(row => row.detail).join(" ")).toContain("bots_index_human_fanout");
		expect([...subscriptions.results!, ...owners.results!].some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
	});
});
