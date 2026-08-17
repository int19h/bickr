import {
	deleteDeliveredNotifications,
	describe,
	expect,
	it,
	kvKeys,
	listPendingNotifications,
	testEnv,
} from "./helpers/index-harness";

const botId = "bot_delivery";
const now = "2026-08-17T12:00:00.000Z";

type NotificationFixture = {
	id: string;
	type: string;
	createdAt: string;
	botId?: string;
	/** Omitted for a ghost: a row whose KV document is gone. */
	document?: false;
};

async function insertNotification(input: NotificationFixture): Promise<void> {
	const owner = input.botId ?? botId;
	if (input.document !== false) {
		await testEnv.BICKR_KV.put(kvKeys.notification(owner, input.id), JSON.stringify({
			id: input.id,
			type: "notification",
			notificationType: input.type,
			botId: owner,
			status: "pending",
			createdAt: input.createdAt,
		}));
	}
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO notifications (
			notification_id, world_id, bot_id, type, source_object_id, status, message, message_lang,
			created_at, delivered_at, read_at
		) VALUES (?, 'wld_delivery', ?, ?, NULL, 'pending', ?, NULL, ?, NULL, NULL)`,
	)
		.bind(input.id, owner, input.type, `Notification ${input.id}`, input.createdAt)
		.run();
}

async function insertBot(input: { botId?: string; bootstrapNotifiedAt?: string } = {}): Promise<void> {
	const owner = input.botId ?? botId;
	// bots_index enforces a live handle claim by trigger, so a fixture row needs
	// one even though nothing in these tests reads the handle.
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO entity_lifecycle_identity_claims (
			key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
			claim_state, operation_id, created_at, updated_at
		) VALUES ('bot_handle', 'wld_delivery', ?, 'bot', ?, 'usr_delivery', 'active', NULL, ?, ?)`,
	)
		.bind(`handle-${owner}`, owner, now, now)
		.run();
	await testEnv.BICKR_D1.prepare(
		`INSERT OR IGNORE INTO bots_index (
			bot_id, home_world_id, home_world_handle, handle, display_name,
			owner_user_id, short_bio, created_at, updated_at, lifecycle_state, bootstrap_notified_at
		) VALUES (?, 'wld_delivery', 'delivery-world', ?, 'Delivery bot', 'usr_delivery', 'Bio', ?, ?, 'active', ?)`,
	)
		.bind(owner, `handle-${owner}`, now, now, input.bootstrapNotifiedAt ?? null)
		.run();
}

async function pendingRowIds(owner = botId): Promise<string[]> {
	const result = await testEnv.BICKR_D1.prepare(
		`SELECT notification_id AS id FROM notifications WHERE bot_id = ? ORDER BY notification_id`,
	)
		.bind(owner)
		.all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id);
}

async function bootstrapFlag(owner = botId): Promise<string | null> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT bootstrap_notified_at AS bootstrapNotifiedAt FROM bots_index WHERE bot_id = ?`,
	)
		.bind(owner)
		.first<{ bootstrapNotifiedAt: string | null }>();
	return row?.bootstrapNotifiedAt ?? null;
}

function minutesBefore(from: string, minutes: number): string {
	return new Date(Date.parse(from) - minutes * 60 * 1000).toISOString();
}

describe("pending notification delivery order", () => {
	it("delivers by priority first and by recency within a priority", async () => {
		// Deliberately inserted in an order that neither ranking would produce on
		// its own: the oldest row is the most important one, the newest the least.
		await insertNotification({ id: "ntf_activity_new", type: "followed_activity", createdAt: minutesBefore(now, 1) });
		await insertNotification({ id: "ntf_vote", type: "vote", createdAt: minutesBefore(now, 2) });
		await insertNotification({ id: "ntf_follow", type: "follow", createdAt: minutesBefore(now, 3) });
		await insertNotification({ id: "ntf_unfollow", type: "unfollow", createdAt: minutesBefore(now, 4) });
		await insertNotification({ id: "ntf_personal", type: "personal_forum_post", createdAt: minutesBefore(now, 5) });
		await insertNotification({ id: "ntf_mention", type: "mention", createdAt: minutesBefore(now, 6) });
		await insertNotification({ id: "ntf_reply_old", type: "reply", createdAt: minutesBefore(now, 8) });
		await insertNotification({ id: "ntf_reply_new", type: "reply", createdAt: minutesBefore(now, 7) });
		await insertNotification({ id: "ntf_bootstrap", type: "bootstrap", createdAt: minutesBefore(now, 9) });

		const delivered = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, botId, 20, { now });

		expect(delivered.map((notification) => notification.id)).toEqual([
			"ntf_bootstrap",
			// Same priority: the newer reply comes first.
			"ntf_reply_new",
			"ntf_reply_old",
			"ntf_mention",
			"ntf_personal",
			// follow and unfollow share a rank, so recency decides between them.
			"ntf_follow",
			"ntf_unfollow",
			"ntf_vote",
			"ntf_activity_new",
		]);
	});

	it("sorts stored types the priority table does not name last, not first", async () => {
		await insertNotification({ id: "ntf_unknown", type: "weather_alert", createdAt: minutesBefore(now, 1) });
		await insertNotification({ id: "ntf_interest", type: "interest", createdAt: minutesBefore(now, 2) });
		await insertNotification({ id: "ntf_system", type: "system", createdAt: minutesBefore(now, 3) });
		await insertNotification({ id: "ntf_activity", type: "followed_activity", createdAt: minutesBefore(now, 4) });

		const delivered = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, botId, 20, { now });

		// Without the CASE's ELSE arm these three would rank NULL, which SQLite
		// sorts before every number — a retired or unrecognized type would take
		// over the window ahead of a real one.
		expect(delivered.map((notification) => notification.id)).toEqual([
			"ntf_activity",
			"ntf_unknown",
			"ntf_interest",
			"ntf_system",
		]);
	});

	it("truncates to the delivery window from the least important end", async () => {
		await insertNotification({ id: "ntf_reply", type: "reply", createdAt: minutesBefore(now, 5) });
		await insertNotification({ id: "ntf_mention", type: "mention", createdAt: minutesBefore(now, 4) });
		await insertNotification({ id: "ntf_vote", type: "vote", createdAt: minutesBefore(now, 3) });

		const delivered = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, botId, 2, { now });

		expect(delivered.map((notification) => notification.id)).toEqual(["ntf_reply", "ntf_mention"]);
		// What did not fit is still pending, not consumed.
		expect(await pendingRowIds()).toEqual(["ntf_mention", "ntf_reply", "ntf_vote"]);
	});
});

describe("ghost notification self-heal", () => {
	it("deletes rows whose document is gone and refills the window with real ones", async () => {
		for (let index = 0; index < 3; index += 1) {
			await insertNotification({
				id: `ntf_ghost_${index}`,
				type: "reply",
				createdAt: minutesBefore(now, 61 + index),
				document: false,
			});
		}
		await insertNotification({ id: "ntf_real_a", type: "vote", createdAt: minutesBefore(now, 70) });
		await insertNotification({ id: "ntf_real_b", type: "vote", createdAt: minutesBefore(now, 71) });

		// A window of two: the ghosts would otherwise occupy it on every visit,
		// because they rank ahead of the real notifications and never go away.
		const delivered = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, botId, 2, { now });

		expect(delivered.map((notification) => notification.id)).toEqual(["ntf_real_a", "ntf_real_b"]);
		expect(await pendingRowIds()).toEqual(["ntf_real_a", "ntf_real_b"]);
	});

	it("pages past a young miss without deleting its row, and still terminates", async () => {
		// KV negative lookups are cached and cross-location writes propagate
		// asynchronously, so a missing document this young is not evidence of a
		// ghost. Excluding it from the refill is what keeps the newest-first
		// re-query from selecting it forever.
		await insertNotification({ id: "ntf_young_miss", type: "reply", createdAt: minutesBefore(now, 30), document: false });
		await insertNotification({ id: "ntf_old_ghost", type: "reply", createdAt: minutesBefore(now, 90), document: false });
		await insertNotification({ id: "ntf_real", type: "reply", createdAt: minutesBefore(now, 120) });

		const delivered = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, botId, 2, { now });

		expect(delivered.map((notification) => notification.id)).toEqual(["ntf_real"]);
		expect(await pendingRowIds()).toEqual(["ntf_real", "ntf_young_miss"]);
	});

	it("clears bootstrap_notified_at when it reaps a bootstrap ghost", async () => {
		await insertBot({ bootstrapNotifiedAt: minutesBefore(now, 200) });
		await insertNotification({
			id: "ntf_bootstrap_ghost",
			type: "bootstrap",
			createdAt: minutesBefore(now, 200),
			document: false,
		});
		await insertNotification({ id: "ntf_reply", type: "reply", createdAt: minutesBefore(now, 100) });

		const delivered = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, botId, 20, { now });

		expect(delivered.map((notification) => notification.id)).toEqual(["ntf_reply"]);
		expect(await pendingRowIds()).toEqual(["ntf_reply"]);
		// The bootstrap this participant never received is owed again: with the flag
		// left set, nothing would ever create a replacement.
		expect(await bootstrapFlag()).toBeNull();
	});

	it("returns a partial batch when the scan budget runs out", async () => {
		// More ghosts than the per-call scan budget: the visit gets what it could
		// reach, and the rest is healed by the next visit and by the prune.
		for (let index = 0; index < 70; index += 1) {
			await insertNotification({
				id: `ntf_many_ghosts_${String(index).padStart(2, "0")}`,
				type: "reply",
				createdAt: minutesBefore(now, 200 + index),
				document: false,
			});
		}
		await insertNotification({ id: "ntf_real", type: "vote", createdAt: minutesBefore(now, 400) });

		const delivered = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, botId, 20, { now });

		expect(delivered).toEqual([]);
		// 60 scanned rows is the budget, so 10 ghosts and the real notification
		// survive this call.
		expect(await pendingRowIds()).toHaveLength(11);

		const second = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, botId, 20, { now });

		expect(second.map((notification) => notification.id)).toEqual(["ntf_real"]);
		expect(await pendingRowIds()).toEqual(["ntf_real"]);
	});
});

describe("delete-on-delivery", () => {
	it("removes delivered notifications from both stores and leaves the rest pending", async () => {
		await insertNotification({ id: "ntf_reply", type: "reply", createdAt: minutesBefore(now, 5) });
		await insertNotification({ id: "ntf_vote", type: "vote", createdAt: minutesBefore(now, 4) });
		const delivered = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, botId, 1, { now });

		await deleteDeliveredNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, delivered);

		expect(delivered.map((notification) => notification.id)).toEqual(["ntf_reply"]);
		expect(await pendingRowIds()).toEqual(["ntf_vote"]);
		expect(await testEnv.BICKR_KV.get(kvKeys.notification(botId, "ntf_reply"))).toBeNull();
		expect(await testEnv.BICKR_KV.get(kvKeys.notification(botId, "ntf_vote"))).not.toBeNull();
		// The second visit sees only what is new, with no status to filter on.
		expect((await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, botId, 20, { now })).map((item) => item.id))
			.toEqual(["ntf_vote"]);
	});
});
