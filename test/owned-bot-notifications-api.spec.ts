import { onRequestGet as listBotNotificationsRoute } from "../apps/web/functions/api/me/bots/[botId]/notifications";
import { onRequestPost as markBotNotificationsReadRoute } from "../apps/web/functions/api/me/bots/[botId]/notifications/read";
import {
	authCookie,
	authCookieFor,
	contextFor,
	createBotForTest,
	describe,
	expect,
	it,
	jsonRequest,
	kvKeys,
	seedWorld,
	testEnv,
} from "./helpers/index-harness";

/**
 * The REST routes the CLI uses. The behavior itself is specified in
 * owned-bot-notifications.spec.ts; this covers what the routes add on top:
 * session auth, query and body parsing, and the mapping of typed refusals to
 * HTTP statuses.
 */

async function insertNotification(botId: string, id: string, createdAt: string): Promise<void> {
	await testEnv.BICKR_KV.put(kvKeys.notification(botId, id), JSON.stringify({
		id,
		type: "notification",
		schemaVersion: 1,
		revision: 1,
		worldId: "wld_api",
		botId,
		notificationType: "reply",
		status: "pending",
		message: { lang: "en", text: `Notification ${id}` },
		createdAt,
		updatedAt: createdAt,
	}));
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO notifications (
			notification_id, world_id, bot_id, type, source_object_id, status, message, message_lang,
			created_at, delivered_at, read_at
		) VALUES (?, 'wld_api', ?, 'reply', NULL, 'pending', ?, 'en', ?, NULL, NULL)`,
	).bind(id, botId, `Notification ${id}`, createdAt).run();
}

async function list(botId: string, cookie: string, query = ""): Promise<Response> {
	return listBotNotificationsRoute(contextFor<typeof listBotNotificationsRoute>(
		new Request(`http://example.com/api/me/bots/${botId}/notifications${query}`, { headers: { cookie } }),
		{ botId },
	));
}

async function markRead(botId: string, cookie: string, body: unknown): Promise<Response> {
	return markBotNotificationsReadRoute(contextFor<typeof markBotNotificationsReadRoute>(
		jsonRequest(`http://example.com/api/me/bots/${botId}/notifications/read`, "POST", body, cookie),
		{ botId },
	));
}

describe("owned participant notification routes", () => {
	it("list newest first without consuming, and mark only the named IDs of a paused participant", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "api-paused", { enabled: false });
		expect(bot.tickSettings.enabled).toBe(false);
		await insertNotification(bot.id, "ntf_api_old", "2026-09-25T10:00:00.000Z");
		await insertNotification(bot.id, "ntf_api_new", "2026-09-25T11:00:00.000Z");

		const listed = await list(bot.id, cookie, "?limit=1");
		expect(listed.status).toBe(200);
		expect(await listed.json()).toMatchObject({
			ok: true,
			data: { botId: bot.id, notifications: [{ id: "ntf_api_new" }], unavailableCount: 0, hasMore: true },
		});
		expect(await (await list(bot.id, cookie)).json()).toMatchObject({
			data: { notifications: [{ id: "ntf_api_new" }, { id: "ntf_api_old" }], hasMore: false },
		});

		const marked = await markRead(bot.id, cookie, { notificationIds: ["ntf_api_new"] });
		expect(marked.status).toBe(200);
		expect(await marked.json()).toEqual({ ok: true, data: { botId: bot.id, markedReadCount: 1, notPendingCount: 0 } });
		expect(await (await markRead(bot.id, cookie, { notificationIds: ["ntf_api_new"] })).json())
			.toMatchObject({ data: { markedReadCount: 0, notPendingCount: 1 } });
		expect(await (await list(bot.id, cookie)).json()).toMatchObject({ data: { notifications: [{ id: "ntf_api_old" }] } });
	});

	it("maps refusals to typed HTTP failures", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "api-owner");
		const sibling = await createBotForTest(cookie, "api-sibling");
		await insertNotification(bot.id, "ntf_api_mine", "2026-09-25T10:00:00.000Z");
		await insertNotification(sibling.id, "ntf_api_sibling", "2026-09-25T10:00:00.000Z");

		for (const query of ["?limit=0", "?limit=51", "?limit=two"]) {
			const response = await list(bot.id, cookie, query);
			expect(response.status, query).toBe(400);
			expect(await response.json()).toMatchObject({ ok: false, error: "bad_request" });
		}
		const crossBot = await markRead(bot.id, cookie, { notificationIds: ["ntf_api_mine", "ntf_api_sibling"] });
		expect(crossBot.status).toBe(400);
		expect(await crossBot.json()).toMatchObject({ ok: false, error: "bad_request" });
		expect((await markRead(bot.id, cookie, { notificationIds: "ntf_api_mine" })).status).toBe(400);
		expect((await markRead(bot.id, cookie, { notificationIds: [] })).status).toBe(400);

		const stranger = await authCookieFor({ subject: "2", login: "stranger", displayName: "Stranger" });
		const foreignList = await list(bot.id, stranger);
		expect(foreignList.status).toBe(403);
		expect(await foreignList.json()).toMatchObject({ ok: false, error: "forbidden" });
		expect((await markRead(bot.id, stranger, { notificationIds: ["ntf_api_mine"] })).status).toBe(403);
		expect((await list("bot_api_missing", cookie)).status).toBe(404);

		// Nothing above was allowed to write.
		expect(await (await list(bot.id, cookie)).json()).toMatchObject({ data: { notifications: [{ id: "ntf_api_mine" }] } });
		expect(await (await list(sibling.id, cookie)).json()).toMatchObject({ data: { notifications: [{ id: "ntf_api_sibling" }] } });
	});

	it("requires a signed-in user", async () => {
		const response = await listBotNotificationsRoute(contextFor<typeof listBotNotificationsRoute>(
			new Request("http://example.com/api/me/bots/bot_any/notifications"),
			{ botId: "bot_any" },
		));
		expect(response.status).toBe(401);
	});
});
