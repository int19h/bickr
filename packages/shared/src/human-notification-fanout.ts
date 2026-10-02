import { deterministicId } from "./ids";
import { humanNotificationInsertRow, type HumanNotificationInput, type HumanNotificationInsertRow } from "./human-notifications";
import type { HumanSubscriptionScope } from "./model";
import type { D1DatabaseLike } from "./storage";

export type HumanNotificationAudience =
	| { kind: "subscriptions"; scopes: Array<{ scopeType: HumanSubscriptionScope; scopeId: string }> }
	| { kind: "world_owners"; worldId: string; excludeUserId: string };
type Source = { kind: "thread" | "comment" | "bot"; id: string } | { kind: "world"; id: string; revision: number };
type Event = { audience: HumanNotificationAudience; source: Source; notification: HumanNotificationInsertRow };
type Job = { eventSequence: number; eventId: string; eventJson: string; scopeIndex: number; userCursor: string };

export const humanNotificationFanoutPageSize = 50;
const defaultPagesPerRun = 100;
const retentionMs = 30 * 24 * 60 * 60 * 1_000;

/** Enqueue only: thread coordinators stage this write before the content commit. */
export async function enqueueHumanNotificationFanout(
	db: D1DatabaseLike,
	input: { audience: HumanNotificationAudience; source: Source; notification: Omit<HumanNotificationInput, "userId"> },
): Promise<void> {
	const createdAt = input.notification.now;
	const eventId = await deterministicId("hnt", JSON.stringify([input.notification.eventKey, input.source.kind === "world" ? input.source.revision : createdAt]));
	const audience = input.audience.kind === "subscriptions"
		? { ...input.audience, scopes: [...new Map(input.audience.scopes.map(scope => [JSON.stringify(scope), scope])).values()] }
		: input.audience;
	const event: Event = {
		audience,
		source: input.source,
		notification: humanNotificationInsertRow({ ...input.notification, userId: "" }),
	};
	await db.prepare(`INSERT OR IGNORE INTO human_notification_fanout
		(event_id, event_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(eventId, JSON.stringify(event), createdAt, createdAt, new Date(Date.parse(createdAt) + retentionMs).toISOString()).run();
}

/**
 * Each page reads one indexed scope and commits notification rows and its cursor
 * in one transaction. A competing or replayed page cannot recreate a consumed
 * notification: every insert checks the old cursor inside that same transaction.
 * Unsubscription before delivery takes effect; membership/subscription activations
 * after the event's D1 publication are excluded by sequence, not wall-clock time. One recipient may occur in several scopes; event keys dedup.
 */
export async function runHumanNotificationFanout(
	db: D1DatabaseLike,
	now = new Date().toISOString(),
	options: { maxPages?: number } = {},
): Promise<{ pages: number; recipients: number; expiredJobs: number; pending: boolean }> {
	const maxPages = options.maxPages ?? defaultPagesPerRun;
	if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new RangeError("maxPages must be between 1 and 100.");
	const expired = await db.prepare(`DELETE FROM human_notification_fanout WHERE event_id IN (
		SELECT event_id FROM human_notification_fanout WHERE expires_at <= ? ORDER BY expires_at, event_id LIMIT 500
	)`).bind(now).run();
	let pages = 0;
	let recipients = 0;
	// Fair rotation by updated_at prevents one large audience from pinning new jobs.
	const jobs = await db.prepare(`SELECT sequence AS eventSequence, event_id AS eventId, event_json AS eventJson,
		scope_index AS scopeIndex, user_cursor AS userCursor FROM human_notification_fanout
		WHERE phase = 'pending' AND expires_at > ? ORDER BY updated_at, event_id LIMIT ?`)
		.bind(now, maxPages).all<Job>();
	const queue = jobs.results ?? [];
	for (let index = 0; index < queue.length && pages < maxPages; index += 1) {
		const job = queue[index]!;
		const event = JSON.parse(job.eventJson) as Event;
		const users = await audiencePage(db, event, job);
		const scopeCount = event.audience.kind === "subscriptions" ? event.audience.scopes.length : 1;
		const scopeDone = users.length < humanNotificationFanoutPageSize;
		const nextScope = scopeDone ? job.scopeIndex + 1 : job.scopeIndex;
		const nextCursor = scopeDone ? "" : users[users.length - 1]!;
		const complete = nextScope >= scopeCount;
		const deliveries = await Promise.all(users.map(async userId => ({ userId, notificationId: await deterministicId("hnt", JSON.stringify(["fanout", job.eventId, userId])) })));
		const statements = users.length ? [notificationPageStatement(db, event, job, deliveries, now)] : [];
		statements.push(db.prepare(`UPDATE human_notification_fanout SET scope_index = ?, user_cursor = ?,
			phase = ?, event_json = CASE WHEN ? THEN NULL ELSE event_json END, updated_at = ?
			WHERE event_id = ? AND phase = 'pending' AND scope_index = ? AND user_cursor = ?`)
			.bind(nextScope, nextCursor, complete ? "complete" : "pending", complete ? 1 : 0, now,
				job.eventId, job.scopeIndex, job.userCursor));
		const results = await db.batch(statements);
		pages += 1;
		recipients += users.length ? results[0]?.meta?.changes ?? 0 : 0;
		if (!complete && results[results.length - 1]?.meta?.changes) {
			queue.push({ ...job, scopeIndex: nextScope, userCursor: nextCursor });
		}
	}
	const pending = await db.prepare("SELECT event_id FROM human_notification_fanout WHERE phase = 'pending' AND expires_at > ? LIMIT 1").bind(now).first();
	return { pages, recipients, expiredJobs: expired.meta?.changes ?? 0, pending: Boolean(pending) };
}

async function audiencePage(db: D1DatabaseLike, event: Event, job: Job): Promise<string[]> {
	const audience = event.audience;
	if (audience.kind === "world_owners") {
		const rows = await db.prepare(`SELECT DISTINCT owner_user_id AS userId FROM bots_index
			WHERE home_world_id = ? AND lifecycle_state = 'active' AND deleted_at IS NULL
				AND owner_user_id > ? AND owner_user_id != ? AND membership_after_sequence < ?
			ORDER BY owner_user_id LIMIT ?`)
			.bind(audience.worldId, job.userCursor, audience.excludeUserId, job.eventSequence, humanNotificationFanoutPageSize)
			.all<{ userId: string }>();
		return (rows.results ?? []).map(row => row.userId);
	}
	const scope = audience.scopes[job.scopeIndex];
	if (!scope) return [];
	const rows = await db.prepare(`SELECT user_id AS userId FROM human_subscriptions
		WHERE scope_type = ? AND scope_id = ? AND active = 1 AND user_id > ? AND activation_after_sequence < ?
		ORDER BY user_id LIMIT ?`)
		.bind(scope.scopeType, scope.scopeId, job.userCursor, job.eventSequence, humanNotificationFanoutPageSize)
		.all<{ userId: string }>();
	return (rows.results ?? []).map(row => row.userId);
}

function activeBotSql(parameter: string): string {
	return `EXISTS (SELECT 1 FROM bots_index AS actor JOIN users_index AS owner ON owner.user_id = actor.owner_user_id
		JOIN worlds_index AS home ON home.world_id = actor.home_world_id
		WHERE actor.bot_id = ${parameter} AND actor.deleted_at IS NULL AND actor.lifecycle_state = 'active'
		AND owner.deleted_at IS NULL AND owner.lifecycle_state = 'active'
		AND home.deleted_at IS NULL AND home.lifecycle_state = 'active')`;
}

function sourceSql(source: Source): string {
	switch (source.kind) {
		case "world": return "EXISTS (SELECT 1 FROM worlds_index WHERE world_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active')";
		case "bot": return activeBotSql("?");
		case "thread": return `EXISTS (SELECT 1 FROM threads_index AS thread JOIN forums_index AS forum ON forum.forum_id = thread.forum_id
			WHERE thread.thread_id = ? AND thread.deleted_at IS NULL AND forum.deleted_at IS NULL)`;
		case "comment": return `EXISTS (SELECT 1 FROM comments_index AS comment JOIN threads_index AS thread ON thread.thread_id = comment.thread_id
			JOIN forums_index AS forum ON forum.forum_id = thread.forum_id
			WHERE comment.comment_id = ? AND comment.deleted_at IS NULL AND thread.deleted_at IS NULL AND forum.deleted_at IS NULL)`;
	}
}

function notificationPageStatement(db: D1DatabaseLike, event: Event, job: Job, deliveries: Array<{ userId: string; notificationId: string }>, now: string) {
	const row = event.notification;
	const coalesce = row.notificationType === "world_settings_changed";
	const audience = event.audience;
	const scope = audience.kind === "subscriptions" ? audience.scopes[job.scopeIndex]! : null;
	const audienceWhere = audience.kind === "subscriptions"
		? `EXISTS (SELECT 1 FROM human_subscriptions WHERE user_id = recipients.value AND scope_type = ? AND scope_id = ? AND active = 1 AND activation_after_sequence < data.sequence)`
		: `EXISTS (SELECT 1 FROM bots_index WHERE owner_user_id = recipients.value AND home_world_id = ? AND owner_user_id != ? AND lifecycle_state = 'active' AND deleted_at IS NULL AND membership_after_sequence < data.sequence)`;
	const audienceBindings = audience.kind === "subscriptions" ? [scope!.scopeType, scope!.scopeId] : [audience.worldId, audience.excludeUserId];
	// Reuse the newest unread world-settings row, as the synchronous writer did.
	// The timestamp condition prevents a delayed older job overwriting newer text.
	const existing = `SELECT old.notification_id FROM human_notifications AS old
		WHERE old.user_id = recipients.value AND old.world_id = data.world_id
		AND old.notification_type = 'world_settings_changed' AND old.read_at IS NULL AND old.archived_at IS NULL
		ORDER BY old.created_at DESC, old.notification_id DESC LIMIT 1`;
	return db.prepare(`WITH data AS (SELECT ? AS sequence, ? AS event_id, ? AS world_id, ? AS event_key, ? AS notification_type,
		? AS actor_bot_id, ? AS actor_handle, ? AS actor_display_name, ? AS actor_display_name_lang,
		? AS source_type, ? AS source_id, ? AS target_type, ? AS target_id, ? AS title, ? AS title_lang,
		? AS body, ? AS body_lang, ? AS url_path, ? AS spotlight_id, ? AS spotlight_label, ? AS created_at, ? AS world_settings_revision),
		recipients AS (SELECT json_extract(value, '$.userId') AS value, json_extract(value, '$.notificationId') AS notification_id FROM json_each(?))
		INSERT INTO human_notifications (notification_id, user_id, world_id, event_key, notification_type,
		actor_bot_id, actor_handle, actor_display_name, actor_display_name_lang, source_type, source_id,
		target_type, target_id, title, title_lang, body, body_lang, url_path, spotlight_id, spotlight_label, created_at, read_at, archived_at, world_settings_revision)
		SELECT ${coalesce ? `COALESCE((${existing}), recipients.notification_id)` : "recipients.notification_id"},
		recipients.value, data.world_id, ${coalesce ? `COALESCE((SELECT event_key FROM human_notifications WHERE notification_id = (${existing})), data.event_key)` : "data.event_key"}, data.notification_type,
		data.actor_bot_id, data.actor_handle, data.actor_display_name, data.actor_display_name_lang,
		data.source_type, data.source_id, data.target_type, data.target_id, data.title, data.title_lang, data.body, data.body_lang,
		data.url_path, data.spotlight_id, data.spotlight_label, data.created_at, NULL, NULL, data.world_settings_revision
		FROM recipients CROSS JOIN data
		WHERE EXISTS (SELECT 1 FROM human_notification_fanout WHERE event_id = data.event_id
			AND phase = 'pending' AND scope_index = ? AND user_cursor = ? AND expires_at > ?)
		AND EXISTS (SELECT 1 FROM users_index WHERE user_id = recipients.value AND deleted_at IS NULL AND lifecycle_state = 'active')
		AND EXISTS (SELECT 1 FROM worlds_index WHERE world_id = data.world_id AND deleted_at IS NULL AND lifecycle_state = 'active')
		AND (data.actor_bot_id IS NULL OR ${activeBotSql("data.actor_bot_id")})
		AND ${sourceSql(event.source)}
		AND ${audienceWhere}
		ON CONFLICT(notification_id) ${coalesce ? `DO UPDATE SET title = excluded.title, title_lang = excluded.title_lang,
			body = excluded.body, body_lang = excluded.body_lang, url_path = excluded.url_path,
			target_id = excluded.target_id, created_at = excluded.created_at, world_settings_revision = excluded.world_settings_revision
			WHERE (human_notifications.world_settings_revision IS NULL AND human_notifications.created_at <= excluded.created_at)
			OR human_notifications.world_settings_revision < excluded.world_settings_revision` : "DO NOTHING"}
		ON CONFLICT(user_id, event_key) DO NOTHING`)
		.bind(job.eventSequence, job.eventId, row.worldId, row.eventKey, row.notificationType, row.actorBotId, row.actorHandle,
			row.actorDisplayName, row.actorDisplayNameLang, row.sourceType, row.sourceId, row.targetType, row.targetId,
			row.title, row.titleLang, row.body, row.bodyLang, row.urlPath, row.spotlightId, row.spotlightLabel, row.createdAt,
			(event.source.kind === "world" ? event.source.revision : null),
			JSON.stringify(deliveries), job.scopeIndex, job.userCursor, now, event.source.id, ...audienceBindings);
}
