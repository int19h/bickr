import { schemaVersion, localizedTextFromStored, type LocalizedText, type NotificationDeliveryReason, type NotificationDocument, type NotificationEventPayload, type NotificationType } from "./model";
import { kvKeys, writeJson, type D1DatabaseLike, type KVNamespaceLike } from "./storage";

export type BotNotificationTemplate = {
	notificationType: NotificationType;
	sourceObjectId?: string;
	message: LocalizedText | string;
	payload: NotificationEventPayload;
};
export type BotNotificationFanout = {
	id: string;
	worldId: string;
	actorBotId: string;
	createdAt: string;
	templates: BotNotificationTemplate[];
	direct: { botId: string; template: number; reasons: NotificationDeliveryReason[] }[];
	follower?: { botId: string; template: number };
};
const recipientChunkSize = 50;
const retentionMs = 14 * 24 * 60 * 60_000;

export async function enqueueBotNotificationFanout(kv: KVNamespaceLike, db: D1DatabaseLike, event: BotNotificationFanout): Promise<void> {
	await db.prepare(`INSERT INTO bot_notification_fanouts (event_id, payload_json, after_bot_id, created_at, next_attempt_at) VALUES (?, ?, '', ?, ?)`)
		.bind(event.id, JSON.stringify(event), event.createdAt, event.createdAt).run();
	// A staged event has no publication sequence yet. Its audience must wait
	// until the content and event commit together; selecting now could skip a
	// follower who joins during the later KV wait. Immediate writers can safely
	// publish one bounded page after their real event INSERT completes.
	if (!db.writesDeferred) await deliverBotNotificationChunk(kv, db, event, "");
}

export async function runBotNotificationFanout(kv: KVNamespaceLike, db: D1DatabaseLike, now = new Date().toISOString()): Promise<{ events: number; candidates: number; recipients: number }> {
	const rows = await db.prepare(`SELECT event_id AS id, payload_json AS payload, after_bot_id AS afterBotId FROM bot_notification_fanouts WHERE next_attempt_at <= ? ORDER BY next_attempt_at, event_id LIMIT 100`)
		.bind(now).all<{ id: string; payload: string; afterBotId: string }>();
	let recipients = 0;
	let candidates = 0;
	let events = 0;
	for (const row of rows.results ?? []) {
		// Small events can use the job budget without reducing the fixed cap on
		// recipient work. A large audience cannot consume more than 500 IDs.
		if (candidates >= 500) break;
		events += 1;
		await db.prepare(`UPDATE bot_notification_fanouts SET next_attempt_at = ? WHERE event_id = ?`)
			.bind(new Date(Date.parse(now) + 5 * 60_000).toISOString(), row.id).run();
		try {
			const event = JSON.parse(row.payload) as BotNotificationFanout;
			if (Date.parse(event.createdAt) + retentionMs <= Date.parse(now)) {
				await db.prepare(`DELETE FROM bot_notification_fanouts WHERE event_id = ?`).bind(row.id).run();
				continue;
			}
			const pageSize = Math.min(recipientChunkSize, 500 - candidates);
			// Reserve before I/O. A failed page can have performed payload writes;
			// it must not reset the work budget and let another 100 pages run.
			candidates += pageSize;
			const delivered = await deliverBotNotificationChunk(kv, db, event, row.afterBotId, pageSize);
			recipients += delivered.recipients;
			candidates -= pageSize - delivered.candidates;
		} catch (error) {
			console.error(JSON.stringify({ event: "bot_notification_fanout_failed", eventId: row.id, error: String(error) }));
		}
	}
	return { events, candidates, recipients };
}

async function deliverBotNotificationChunk(kv: KVNamespaceLike, db: D1DatabaseLike, event: BotNotificationFanout, afterBotId: string, pageSize = recipientChunkSize): Promise<{ candidates: number; recipients: number }> {
	const direct = new Map(event.direct.map((recipient) => [recipient.botId, recipient]));
	// Both arms seek after the same ID. Each arm is bounded before UNION, so a
	// very popular profile cannot force a complete follower scan or sort. New
	// followers still consume cursor positions; eligibility never filters the
	// indexed candidate page before LIMIT. Publication rechecks it atomically.
	const selected = await db.prepare(`WITH direct AS (
		SELECT value AS botId, 0 AS followed FROM json_each(?) WHERE value > ? ORDER BY value LIMIT ?
	), followers AS (
		SELECT follower_bot_id AS botId,
			CASE WHEN activation_after_sequence < (SELECT sequence FROM bot_notification_fanouts WHERE event_id = ?) THEN 1 ELSE 0 END AS followed
		FROM follows
		WHERE followed_bot_id = ? AND follower_bot_id > ? ORDER BY follower_bot_id LIMIT ?
	), audience AS (SELECT * FROM direct UNION ALL SELECT * FROM followers)
	SELECT botId, MAX(followed) AS followed FROM audience GROUP BY botId ORDER BY botId LIMIT ?`)
		.bind(JSON.stringify(event.direct.map((recipient) => recipient.botId)), afterBotId, pageSize,
			event.id, event.follower?.botId ?? "", afterBotId, pageSize, pageSize)
		.all<{ botId: string; followed: number }>();
	const rows = selected.results ?? [];
	const notifications: NotificationDocument[] = [];
	for (const row of rows) {
		if (row.botId === event.actorBotId) continue;
		const recipient = direct.get(row.botId);
		if (!recipient && !row.followed) continue;
		const templateIndex = recipient?.template ?? event.follower?.template;
		if (templateIndex === undefined) continue;
		const template = event.templates[templateIndex];
		if (!template) throw new Error("Notification fanout refers to a missing template.");
		const id = `ntf_${event.id}_${row.botId}`;
		const deliveryReasons = [...(recipient?.reasons ?? [])];
		if (row.followed && !deliveryReasons.includes("followed_profile_activity")) deliveryReasons.push("followed_profile_activity");
		const notification: NotificationDocument = {
			id, type: "notification", schemaVersion, revision: 1, worldId: event.worldId, botId: row.botId,
			notificationType: template.notificationType, status: "pending", message: localizedTextFromStored(template.message),
			...(template.sourceObjectId ? { sourceObjectId: template.sourceObjectId } : {}),
			event: { ...template.payload, id, createdAt: event.createdAt, deliveryReasons, ...(template.sourceObjectId ? { sourceObjectId: template.sourceObjectId } : {}) },
			createdAt: event.createdAt, updatedAt: event.createdAt,
		};
		notifications.push(notification);
	}
	const secondsRemaining = Math.max(60, Math.ceil((Date.parse(event.createdAt) + retentionMs - Date.now()) / 1000));
	// KV is only the payload mirror. Cursor-guarded D1 publication below is the
	// visibility boundary; a repeated/stale worker cannot republish a delivered
	// notification after its first batch advanced the cursor.
	for (let offset = 0; offset < notifications.length; offset += 10) {
		await Promise.all(notifications.slice(offset, offset + 10).map((notification) => writeJson(kv, kvKeys.notification(notification.botId, notification.id), notification, { expirationTtl: secondsRemaining })));
	}
	const nextCursor = rows.at(-1)?.botId ?? afterBotId;
	const published = await db.batch([
		db.prepare(`INSERT OR IGNORE INTO notifications (notification_id, world_id, bot_id, type, source_object_id, status, message, message_lang, created_at, delivered_at, read_at)
			SELECT json_extract(n.value, '$.id'), ?, recipient.bot_id, json_extract(n.value, '$.notificationType'), json_extract(n.value, '$.sourceObjectId'), 'pending', json_extract(n.value, '$.message.text'), json_extract(n.value, '$.message.lang'), ?, NULL, NULL
			FROM json_each(?) n
			JOIN bots_index recipient ON recipient.bot_id = json_extract(n.value, '$.botId') AND recipient.deleted_at IS NULL AND recipient.lifecycle_state = 'active'
			JOIN users_index recipient_owner ON recipient_owner.user_id = recipient.owner_user_id AND recipient_owner.deleted_at IS NULL AND recipient_owner.lifecycle_state = 'active'
			JOIN bots_index actor ON actor.bot_id = ? AND actor.deleted_at IS NULL AND actor.lifecycle_state = 'active'
			JOIN users_index actor_owner ON actor_owner.user_id = actor.owner_user_id AND actor_owner.deleted_at IS NULL AND actor_owner.lifecycle_state = 'active'
			JOIN worlds_index world ON world.world_id = ? AND world.deleted_at IS NULL AND world.lifecycle_state = 'active'
			WHERE EXISTS (SELECT 1 FROM bot_notification_fanouts WHERE event_id = ? AND after_bot_id = ?)
			AND (json_extract(n.value, '$.directRecipient') = 1 OR EXISTS (
			 SELECT 1 FROM follows f JOIN bot_notification_fanouts event ON event.event_id = ?
			 WHERE f.followed_bot_id = ? AND f.follower_bot_id = recipient.bot_id AND f.activation_after_sequence < event.sequence))
			AND CASE substr(json_extract(n.value, '$.sourceObjectId'), 1, 2)
			 WHEN 't/' THEN EXISTS (SELECT 1 FROM threads_index t JOIN forums_index f ON f.forum_id = t.forum_id WHERE t.thread_id = substr(json_extract(n.value, '$.sourceObjectId'), 3) AND t.deleted_at IS NULL AND f.deleted_at IS NULL)
			 WHEN 'c/' THEN EXISTS (SELECT 1 FROM comments_index c JOIN threads_index t ON t.thread_id = c.thread_id JOIN forums_index f ON f.forum_id = t.forum_id WHERE c.comment_id = substr(json_extract(n.value, '$.sourceObjectId'), 3) AND c.deleted_at IS NULL AND t.deleted_at IS NULL AND f.deleted_at IS NULL)
			 ELSE 1 END`)
			.bind(event.worldId, event.createdAt, JSON.stringify(notifications.map(({ event: _event, ...metadata }) => ({ ...metadata, directRecipient: direct.has(metadata.botId) }))), event.actorBotId, event.worldId, event.id, afterBotId, event.id, event.follower?.botId ?? ""),
		rows.length < pageSize
			? db.prepare(`DELETE FROM bot_notification_fanouts WHERE event_id = ? AND after_bot_id = ?`).bind(event.id, afterBotId)
			: db.prepare(`UPDATE bot_notification_fanouts SET after_bot_id = ? WHERE event_id = ? AND after_bot_id = ?`).bind(nextCursor, event.id, afterBotId),
	]);
	return { candidates: rows.length, recipients: published[0]?.meta?.changes ?? 0 };
}
