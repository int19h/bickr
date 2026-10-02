import { beforeEach, expect, it } from "vitest";
import { runBotNotificationFanout, type BotNotificationFanout } from "@bickr/shared/bot-notification-fanout";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";
import { authCookie, createBotForTest, createForumForTest, createThreadForTest, seedWorld, testEnv, handleForumCoordinatorRequest, memoryDurableStorage, ExclusiveOperationQueue, jsonRequest, requiredLt } from "./helpers/index-harness";

beforeEach(async () => { await resetD1Schema(testEnv.BICKR_D1); await clearKv(testEnv.BICKR_KV); });

async function audience(count: number) {
	const cookie = await authCookie();
	await seedWorld(cookie);
	const forum = await createForumForTest(cookie, "fanout");
	const author = await createBotForTest(cookie, "fanout-author");
	for (let offset = 0; offset < count; offset += 50) {
		await testEnv.BICKR_D1.batch(Array.from({ length: Math.min(50, count - offset) }, (_, index) => {
			const id = `audience-${String(offset + index).padStart(5, "0")}`;
			return [testEnv.BICKR_D1.prepare(`INSERT INTO entity_lifecycle_identity_claims (key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id, claim_state, created_at, updated_at) SELECT 'bot_handle', home_world_id, ?, 'bot', ?, owner_user_id, 'active', created_at, updated_at FROM bots_index WHERE bot_id = ?`).bind(id, id, author.id), testEnv.BICKR_D1.prepare(`INSERT INTO bots_index (bot_id, home_world_id, home_world_handle, handle, display_name, owner_user_id, short_bio, created_at, updated_at)
				SELECT ?, home_world_id, home_world_handle, ?, display_name, owner_user_id, short_bio, created_at, updated_at FROM bots_index WHERE bot_id = ?`).bind(id, id, author.id)];
		}).flat());
	}
	await testEnv.BICKR_D1.prepare(`INSERT INTO follows (world_id, follower_bot_id, followed_bot_id, created_at)
		SELECT home_world_id, bot_id, ?, created_at FROM bots_index WHERE bot_id >= 'audience-' AND bot_id < 'audience.'`).bind(author.id).run();
	const thread = await createThreadForTest(forum.id, author.id, "Bounded delivery", "Payload");
	return { author, thread };
}

async function countNotifications(threadId: string) {
	return (await testEnv.BICKR_D1.prepare(`SELECT count(*) AS count FROM notifications WHERE source_object_id = ?`).bind(`t/${threadId}`).first<{ count: number }>())!.count;
}

it("publishes only one 50-recipient page inline and drains larger audiences through bounded indexed pages", async () => {
	const { author, thread } = await audience(125);
	expect(await countNotifications(thread.id)).toBe(50);
	const first = await runBotNotificationFanout(testEnv.BICKR_KV, testEnv.BICKR_D1, new Date(Date.now() + 60_000).toISOString());
	expect(first.recipients).toBe(50);
	expect(await countNotifications(thread.id)).toBe(100);
	const second = await runBotNotificationFanout(testEnv.BICKR_KV, testEnv.BICKR_D1, new Date(Date.now() + 10 * 60_000).toISOString());
	expect(second.recipients).toBe(25);
	expect(await countNotifications(thread.id)).toBe(125);
	expect(await testEnv.BICKR_D1.prepare(`SELECT event_id FROM bot_notification_fanouts LIMIT 1`).first()).toBeNull();
	const plan = await testEnv.BICKR_D1.prepare(`EXPLAIN QUERY PLAN SELECT follower_bot_id FROM follows WHERE followed_bot_id = ? AND follower_bot_id > ? ORDER BY follower_bot_id LIMIT 50`).bind(author.id, "audience-00049").all<{ detail: string }>();
	expect(plan.results.map((row) => row.detail).join(" ")).toContain("follows_recipient_page");
	expect(plan.results.map((row) => row.detail).join(" ")).not.toContain("TEMP B-TREE");
});

it("does not publish the remainder after its source or recipient is deleted", async () => {
	const { thread } = await audience(125);
	await testEnv.BICKR_D1.prepare(`UPDATE threads_index SET deleted_at = ? WHERE thread_id = ?`).bind(new Date().toISOString(), thread.id).run();
	await testEnv.BICKR_D1.prepare(`DELETE FROM notifications WHERE source_object_id = ?`).bind(`t/${thread.id}`).run();
	await runBotNotificationFanout(testEnv.BICKR_KV, testEnv.BICKR_D1, new Date(Date.now() + 60_000).toISOString());
	expect(await countNotifications(thread.id)).toBe(0);
});

it("advances bounded raw pages without sending an older event to later followers", async () => {
	const { author, thread } = await audience(125);
	const event = (await testEnv.BICKR_D1.prepare(`SELECT sequence FROM bot_notification_fanouts LIMIT 1`).first<{ sequence: number }>())!;
	// Re-follow after the first page, with the same old timestamp. Sequence
	// ordering excludes these recipients without relying on clock precision.
	await testEnv.BICKR_D1.prepare(`DELETE FROM follows WHERE followed_bot_id = ? AND follower_bot_id > 'audience-00049'`).bind(author.id).run();
	await testEnv.BICKR_D1.prepare(`INSERT INTO follows (world_id, follower_bot_id, followed_bot_id, created_at)
		SELECT home_world_id, bot_id, ?, created_at FROM bots_index WHERE bot_id > 'audience-00049' AND bot_id < 'audience.'`).bind(author.id).run();
	expect(await testEnv.BICKR_D1.prepare(`SELECT min(activation_after_sequence) AS sequence FROM follows WHERE followed_bot_id = ? AND follower_bot_id > 'audience-00049'`).bind(author.id).first()).toEqual({ sequence: event.sequence });
	const first = await runBotNotificationFanout(testEnv.BICKR_KV, testEnv.BICKR_D1, new Date(Date.now() + 60_000).toISOString());
	expect(first.candidates).toBe(50);
	expect(first.recipients).toBe(0);
	expect(await countNotifications(thread.id)).toBe(50);
	expect(await testEnv.BICKR_D1.prepare(`SELECT after_bot_id AS cursor FROM bot_notification_fanouts LIMIT 1`).first()).toEqual({ cursor: "audience-00099" });
	const second = await runBotNotificationFanout(testEnv.BICKR_KV, testEnv.BICKR_D1, new Date(Date.now() + 10 * 60_000).toISOString());
	expect(second.candidates).toBe(25);
	expect(second.recipients).toBe(0);
	expect(await countNotifications(thread.id)).toBe(50);
	expect(await testEnv.BICKR_D1.prepare(`SELECT event_id FROM bot_notification_fanouts LIMIT 1`).first()).toBeNull();
});


it("does not select a staged audience before its event is published", async () => {
	const { author, thread } = await audience(125);
	await testEnv.BICKR_D1.prepare(`DELETE FROM bot_notification_fanouts`).run();
	await testEnv.BICKR_D1.prepare(`DELETE FROM notifications`).run();
	const newcomer = "aaa-before-publication";
	await testEnv.BICKR_D1.batch([
		testEnv.BICKR_D1.prepare(`INSERT INTO entity_lifecycle_identity_claims (key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id, claim_state, created_at, updated_at)
		 SELECT 'bot_handle', home_world_id, ?, 'bot', ?, owner_user_id, 'active', created_at, updated_at FROM bots_index WHERE bot_id = ?`).bind(newcomer, newcomer, author.id),
		testEnv.BICKR_D1.prepare(`INSERT INTO bots_index (bot_id, home_world_id, home_world_handle, handle, display_name, owner_user_id, short_bio, created_at, updated_at)
		 SELECT ?, home_world_id, home_world_handle, ?, display_name, owner_user_id, short_bio, created_at, updated_at FROM bots_index WHERE bot_id = ?`).bind(newcomer, newcomer, author.id),
	]);
	let joined = false;
	let notificationWrites = 0;
	const kv = { get: testEnv.BICKR_KV.get.bind(testEnv.BICKR_KV), delete: testEnv.BICKR_KV.delete.bind(testEnv.BICKR_KV), put: async (key: string, value: string) => {
		if (key.startsWith("v1:notification:")) notificationWrites += 1;
		if (!joined && key.startsWith("v1:thread:")) {
			joined = true;
			await testEnv.BICKR_D1.prepare(`INSERT INTO follows (world_id, follower_bot_id, followed_bot_id, created_at)
			 SELECT home_world_id, bot_id, ?, created_at FROM bots_index WHERE bot_id = ?`).bind(author.id, newcomer).run();
		}
		await testEnv.BICKR_KV.put(key, value);
	} } as KVNamespace;
	const request = jsonRequest(`https://internal.bickr/threads/${thread.id}/comments`, "POST", { body: requiredLt("Published together") }, undefined, { "x-bickr-bot-id": author.id });
	const response = await handleForumCoordinatorRequest(request, { BICKR_D1: testEnv.BICKR_D1, BICKR_KV: kv }, { objectId: thread.id, queue: new ExclusiveOperationQueue(), storage: memoryDurableStorage().storage });
	expect(response.status).toBe(201);
	expect(joined).toBe(true);
	expect(notificationWrites).toBe(0);
	expect(await testEnv.BICKR_D1.prepare(`SELECT after_bot_id AS cursor FROM bot_notification_fanouts`).first()).toEqual({ cursor: "" });
	const result = await runBotNotificationFanout(testEnv.BICKR_KV, testEnv.BICKR_D1, new Date(Date.now() + 60_000).toISOString());
	expect(result.candidates).toBe(50);
	expect(await testEnv.BICKR_D1.prepare(`SELECT bot_id FROM notifications WHERE bot_id = ?`).bind(newcomer).first()).toEqual({ bot_id: newcomer });
});


it("drains small jobs up to 100 while capping total candidate work at 500", async () => {
	const { thread } = await audience(125);
	const template = (await testEnv.BICKR_D1.prepare(`SELECT payload_json AS payload FROM bot_notification_fanouts LIMIT 1`).first<{ payload: string }>())!;
	const source = JSON.parse(template.payload) as BotNotificationFanout;
	await testEnv.BICKR_D1.prepare(`DELETE FROM bot_notification_fanouts`).run();
	await testEnv.BICKR_D1.prepare(`DELETE FROM notifications`).run();
	const seed = (count: number, small: boolean) => testEnv.BICKR_D1.batch(Array.from({ length: count }, (_, index) => {
		const event: BotNotificationFanout = { ...source, id: `${small ? "small" : "large"}-${index}`,
			...(small ? { follower: undefined, direct: [{ botId: "audience-00000", template: 0, reasons: ["followed_profile_activity"] }] } : {}),
		};
		return testEnv.BICKR_D1.prepare(`INSERT INTO bot_notification_fanouts (event_id, payload_json, after_bot_id, created_at, next_attempt_at) VALUES (?, ?, '', ?, ?)`)
			.bind(event.id, JSON.stringify(event), event.createdAt, event.createdAt);
	}));
	await seed(100, true);
	expect(await runBotNotificationFanout(testEnv.BICKR_KV, testEnv.BICKR_D1, new Date(Date.now() + 60_000).toISOString())).toEqual({ events: 100, candidates: 100, recipients: 100 });
	await seed(13, false);
	await seed(1, true);
	// Place a one-recipient job between large jobs to leave a final 49-ID page.
	await testEnv.BICKR_D1.prepare(`UPDATE bot_notification_fanouts SET event_id = 'large-1a', payload_json = json_set(payload_json, '$.id', 'large-1a') WHERE event_id = 'small-0'`).run();
	expect(await runBotNotificationFanout(testEnv.BICKR_KV, testEnv.BICKR_D1, new Date(Date.now() + 60_000).toISOString())).toEqual({ events: 11, candidates: 500, recipients: 500 });
	expect(await countNotifications(thread.id)).toBe(600);
	expect(await testEnv.BICKR_D1.prepare(`SELECT count(*) AS count FROM bot_notification_fanouts WHERE after_bot_id = ''`).first()).toEqual({ count: 3 });
	const failingKv = { get: testEnv.BICKR_KV.get.bind(testEnv.BICKR_KV), delete: testEnv.BICKR_KV.delete.bind(testEnv.BICKR_KV), put: async () => { throw new Error("Injected fanout payload failure"); } } as KVNamespace;
	expect(await runBotNotificationFanout(failingKv, testEnv.BICKR_D1, new Date(Date.now() + 10 * 60_000).toISOString())).toEqual({ events: 10, candidates: 500, recipients: 0 });
});
