import { formatCommentRef, formatThreadRef, type ContentRef } from "./ids";
import { localizedTextFromStored, schemaVersion, type FollowerActivityItem, type NotificationDocument, type NotificationEvent } from "./model";
import { chunks, kvKeys, readJson, writeJson, type D1DatabaseLike, type D1PreparedStatementLike, type KVNamespaceLike } from "./storage";
import { InputError } from "./validation";

export const followerActivityProbeLimit = 500;
export const followerActivityActorLimit = 20;
export const followerActivityEventsPerActor = 6;
const activityLifetimeMs = 14 * 24 * 60 * 60_000;
const activitySequence = "COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'follower_activity_events'), 0)";
// One global orphan-sweep cursor, removed after each complete pass. An abandoned
// partial rotation expires after 14 days, the same lifetime as its event rows.
const orphanCursorKey = kvKeys.followerActivitySourceSweepCursor;

export type FollowerActivityReceipt = {
	kind: "follower_activity";
	version: 1;
	followerBotId: string;
	followedBotId: string;
	fromSequence: number;
	throughSequence: number;
};
export type FollowerActivityNotice = { kind: "follower_activity"; document: NotificationDocument & { event: Extract<NotificationEvent, { kind: "follower_activity_digest" }> }; receipt: FollowerActivityReceipt };
export type NotificationDeliveryCandidate = { kind: "stored"; document: NotificationDocument } | FollowerActivityNotice;
export type FollowerActivitySelection = {
	notices: FollowerActivityNotice[];
	silentReceipts: FollowerActivityReceipt[];
	/** Empty means the next runtime probe wraps to the start. */
	nextAfter: string;
	hasMore: boolean;
};

export function followerActivityInsertStatement(db: D1DatabaseLike, input: {
	actorBotId: string; worldId: string; source: ContentRef; createdAt: string; directRecipientIds: readonly string[];
}): D1PreparedStatementLike {
	const ref = input.source.type === "thread" ? formatThreadRef(input.source.id) : formatCommentRef(input.source.id);
	return db.prepare(`INSERT INTO follower_activity_events (source_ref, actor_bot_id, world_id, created_at, direct_recipient_ids_json)
		VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_ref) DO NOTHING`)
		.bind(ref, input.actorBotId, input.worldId, input.createdAt, JSON.stringify(input.directRecipientIds));
}

function safePosition(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function idPart(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 128; }
function encode(value: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(value: string): unknown {
	if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new InputError("Invalid notification cursor.");
	try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0)))) as unknown; }
	catch { throw new InputError("Invalid notification cursor."); }
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("Invalid notification cursor.");
	return value as Record<string, unknown>;
}
export function followerActivityReceiptId(receipt: FollowerActivityReceipt): string { return `fna1_${encode(receipt)}`; }
export function parseFollowerActivityReceiptId(id: string): FollowerActivityReceipt | null {
	if (!id.startsWith("fna1_")) return null;
	const v = record(decode(id.slice(5)));
	if (v.kind !== "follower_activity" || v.version !== 1 || !idPart(v.followerBotId) || !idPart(v.followedBotId)
		|| !safePosition(v.fromSequence) || !safePosition(v.throughSequence) || v.throughSequence <= v.fromSequence) {
		throw new InputError("Invalid follower activity receipt.");
	}
	return { kind: "follower_activity", version: 1, followerBotId: v.followerBotId, followedBotId: v.followedBotId,
		fromSequence: v.fromSequence, throughSequence: v.throughSequence };
}

export type OwnedNotificationCursor =
	| { kind: "stored"; after: { createdAt: string; id: string } | null }
	| { kind: "followers"; after: string };
export function encodeOwnedNotificationCursor(cursor: OwnedNotificationCursor): string { return encode({ version: 1, ...cursor }); }
export function parseOwnedNotificationCursor(value?: string): OwnedNotificationCursor {
	if (value === undefined) return { kind: "stored", after: null };
	const v = record(decode(value));
	if (v.version !== 1) throw new InputError("Unsupported notification cursor version.");
	if (v.kind === "followers" && typeof v.after === "string" && v.after.length <= 128) return { kind: "followers", after: v.after };
	if (v.kind === "stored") {
		if (v.after === null) return { kind: "stored", after: null };
		const after = record(v.after);
		if (typeof after.createdAt === "string" && after.createdAt.length <= 32 && Number.isFinite(Date.parse(after.createdAt))
			&& typeof after.id === "string" && after.id.length > 0 && after.id.length <= 256) {
			return { kind: "stored", after: { createdAt: after.createdAt, id: after.id } };
		}
	}
	throw new InputError("Invalid notification cursor.");
}

export async function followerActivityHighWater(db: D1DatabaseLike): Promise<number> {
	const row = await db.prepare(`SELECT ${activitySequence} AS sequence`).first<{ sequence: number }>();
	return row?.sequence ?? 0;
}
export function followerActivityAcknowledgement(db: D1DatabaseLike, receipt: FollowerActivityReceipt): D1PreparedStatementLike {
	return db.prepare(`UPDATE follows SET activity_delivered_sequence = ?1
		WHERE follower_bot_id = ?2 AND followed_bot_id = ?3 AND activity_delivered_sequence < ?1
		AND ?1 >= 0 AND ?1 <= ${activitySequence} RETURNING ?4 AS id`)
		.bind(receipt.throughSequence, receipt.followerBotId, receipt.followedBotId, followerActivityReceiptId(receipt));
}
export async function acknowledgeFollowerActivity(db: D1DatabaseLike, receipts: readonly FollowerActivityReceipt[]): Promise<void> {
	if (receipts.length) await db.batch(receipts.map(receipt => followerActivityAcknowledgement(db, receipt)));
	// Zero changed rows settle removed/refollowed relationships and database
	// restores. Only a thrown D1 failure leaves a runtime journal pending.
}

type ProbeRow = {
	followedBotId: string; cursor: number; head: number | null; active: number;
};
// MATERIALIZED and its internal LIMIT bound raw probes before filtering. A
// LIMIT attached only to head > cursor would still scan an unlimited quiet list.
export const followerActivityProbeSql = `WITH raw AS MATERIALIZED (
	SELECT followed_bot_id, activity_delivered_sequence FROM follows
	WHERE follower_bot_id = ?1 AND followed_bot_id > ?2 ORDER BY followed_bot_id LIMIT ?3
) SELECT raw.followed_bot_id AS followedBotId, raw.activity_delivered_sequence AS cursor,
	(SELECT MAX(sequence) FROM follower_activity_events e WHERE e.actor_bot_id = raw.followed_bot_id) AS head,
	CASE WHEN a.deleted_at IS NULL AND a.lifecycle_state = 'active' AND ao.deleted_at IS NULL AND ao.lifecycle_state = 'active'
	 AND r.deleted_at IS NULL AND r.lifecycle_state = 'active' AND ro.deleted_at IS NULL AND ro.lifecycle_state = 'active'
	 AND a.bot_id IS NOT NULL AND ao.user_id IS NOT NULL AND r.bot_id IS NOT NULL AND ro.user_id IS NOT NULL
	 THEN 1 ELSE 0 END AS active
FROM raw LEFT JOIN bots_index a ON a.bot_id = raw.followed_bot_id
LEFT JOIN users_index ao ON ao.user_id = a.owner_user_id
LEFT JOIN bots_index r ON r.bot_id = ?1 LEFT JOIN users_index ro ON ro.user_id = r.owner_user_id
ORDER BY raw.followed_bot_id`;

type ActivityRow = {
	kind: "thread" | "comment"; actorId: string; sequence: number; createdAt: string; sourceRef: string; direct: number; active: number; available: number;
	handle: string; displayName: string; displayNameLang: string | null; worldId: string;
	threadId: string | null; title: string | null; titleLang: string | null; commentId: string | null; parentId: string | null;
};
// Each json_each range is one of at most 20 (runtime) or 50 (owner) actors.
// Source eligibility is computed AFTER the six-row indexed scan, so deletions
// and direct duplicates cannot turn the LIMIT into an unbounded search.
// Materialization fences off eligibility joins. CROSS JOIN fixes the outer loop:
// SQLite otherwise starts with every follow and scans each actor's whole backlog
// before testing membership in the six-row subquery. Output LIMITs alone do not
// bound reads. The second CROSS JOIN makes each follow recheck a point lookup.
export const followerActivityEventsSql = `WITH ranges AS (SELECT value FROM json_each(?1)),
bounded AS MATERIALIZED (
	SELECT e.* FROM ranges CROSS JOIN follower_activity_events e
	WHERE e.sequence IN (
		SELECT sequence FROM follower_activity_events WHERE actor_bot_id = json_extract(ranges.value,'$.followedBotId')
		 AND sequence > json_extract(ranges.value,'$.cursor') AND sequence <= json_extract(ranges.value,'$.head')
		 ORDER BY sequence DESC LIMIT 6)
)
SELECT CASE substr(e.source_ref,1,2) WHEN 'c/' THEN 'comment' ELSE 'thread' END AS kind, e.actor_bot_id AS actorId, e.sequence, e.created_at AS createdAt, e.source_ref AS sourceRef,
	e.world_id AS worldId, a.handle, a.display_name AS displayName, a.display_name_lang AS displayNameLang,
	t.thread_id AS threadId, t.title, t.title_lang AS titleLang, c.comment_id AS commentId, c.parent_comment_id AS parentId,
	EXISTS(SELECT 1 FROM json_each(e.direct_recipient_ids_json) WHERE value = ?2) AS direct,
	CASE WHEN a.deleted_at IS NULL AND a.lifecycle_state = 'active' AND ao.deleted_at IS NULL AND ao.lifecycle_state = 'active'
	 AND r.deleted_at IS NULL AND r.lifecycle_state = 'active' AND ro.deleted_at IS NULL AND ro.lifecycle_state = 'active'
	 AND (w.world_id IS NULL OR w.deleted_at IS NOT NULL OR w.lifecycle_state = 'active')
	 AND (t.thread_id IS NULL OR sw.world_id IS NULL OR sw.deleted_at IS NOT NULL OR sw.lifecycle_state = 'active')
	 THEN 1 ELSE 0 END AS active,
	CASE WHEN w.world_id IS NOT NULL AND w.deleted_at IS NULL AND sw.world_id IS NOT NULL AND sw.deleted_at IS NULL
	 AND t.thread_id IS NOT NULL AND t.deleted_at IS NULL AND f.forum_id IS NOT NULL AND f.deleted_at IS NULL
	 AND (substr(e.source_ref,1,2) = 't/' OR (c.comment_id IS NOT NULL AND c.deleted_at IS NULL)) THEN 1 ELSE 0 END AS available
FROM bounded e CROSS JOIN follows edge ON edge.follower_bot_id = ?2 AND edge.followed_bot_id = e.actor_bot_id AND e.sequence > edge.activity_delivered_sequence
JOIN bots_index a ON a.bot_id = e.actor_bot_id JOIN users_index ao ON ao.user_id = a.owner_user_id
JOIN bots_index r ON r.bot_id = ?2 JOIN users_index ro ON ro.user_id = r.owner_user_id
LEFT JOIN worlds_index w ON w.world_id = e.world_id
LEFT JOIN comments_index c ON substr(e.source_ref,1,2) = 'c/' AND c.comment_id = substr(e.source_ref,3)
LEFT JOIN threads_index t ON t.thread_id = CASE WHEN substr(e.source_ref,1,2) = 't/' THEN substr(e.source_ref,3) ELSE c.thread_id END
LEFT JOIN forums_index f ON f.forum_id = t.forum_id
LEFT JOIN worlds_index sw ON sw.world_id = t.world_id
ORDER BY e.actor_bot_id, e.sequence DESC`;

export async function selectFollowerActivity(db: D1DatabaseLike, followerBotId: string, options: {
	after?: string; probeLimit?: number; actorLimit?: number; now?: string;
} = {}): Promise<FollowerActivitySelection> {
	const probeLimit = options.probeLimit ?? followerActivityProbeLimit;
	const actorLimit = options.actorLimit ?? followerActivityActorLimit;
	if (!Number.isInteger(probeLimit) || probeLimit < 1 || probeLimit > 500 || !Number.isInteger(actorLimit) || actorLimit < 1 || actorLimit > 50) {
		throw new InputError("Invalid follower activity page size.");
	}
	const now = options.now ?? new Date().toISOString();
	const nowMs = Date.parse(now);
	if (!Number.isFinite(nowMs)) throw new InputError("Invalid follower activity timestamp.");
	const probes = (await db.prepare(followerActivityProbeSql).bind(followerBotId, options.after ?? "", probeLimit).all<ProbeRow>()).results ?? [];
	const chosen: ProbeRow[] = [];
	let examined = 0;
	for (const row of probes) {
		examined += 1;
		if (row.active === 1 && row.followedBotId !== followerBotId && row.head !== null && row.head > row.cursor) chosen.push(row);
		if (chosen.length >= actorLimit) break;
	}
	const hasMore = examined < probes.length || probes.length === probeLimit;
	const last = probes[examined - 1]?.followedBotId ?? "";
	const selection: FollowerActivitySelection = { notices: [], silentReceipts: [], nextAfter: hasMore ? last : "", hasMore };
	if (!chosen.length) return selection;
	const rows = (await db.prepare(followerActivityEventsSql).bind(JSON.stringify(chosen), followerBotId).all<ActivityRow>()).results ?? [];
	const byActor = new Map<string, ActivityRow[]>();
	for (const row of rows) { const group = byActor.get(row.actorId) ?? []; group.push(row); byActor.set(row.actorId, group); }
	const cutoff = new Date(nowMs - activityLifetimeMs).toISOString();
	for (const probe of chosen) {
		const group = byActor.get(probe.followedBotId) ?? [];
		if (!group.length || group.some(row => row.active !== 1)) continue;
		const first = group[0]!;
		const receipt: FollowerActivityReceipt = { kind: "follower_activity", version: 1, followerBotId, followedBotId: probe.followedBotId,
			fromSequence: probe.cursor, throughSequence: first.sequence };
		const activities: FollowerActivityItem[] = [];
		for (const row of group.slice(0, 5)) {
			if (row.direct || !row.available || row.createdAt < cutoff || !row.threadId || row.title === null) continue;
			const thread = { id: row.threadId, title: localizedTextFromStored({ text: row.title, lang: row.titleLang }) };
			if (row.kind === "comment") {
				if (row.commentId) activities.push({ kind: "comment", createdAt: row.createdAt, thread,
					comment: { id: row.commentId, threadId: row.threadId, ...(row.parentId ? { parentCommentId: row.parentId } : {}) } });
			} else activities.push({ kind: "thread", createdAt: row.createdAt, thread });
		}
		// Count raw rows, including suppressed ones. Otherwise suppressing the
		// newest direct duplicate could hide an unscanned seventh event silently.
		const olderActivityOmitted = group.length === followerActivityEventsPerActor;
		if (!activities.length && !olderActivityOmitted) { selection.silentReceipts.push(receipt); continue; }
		const id = followerActivityReceiptId(receipt);
		const actor = { id: probe.followedBotId, username: `u/${first.handle}`, displayName: localizedTextFromStored({ text: first.displayName, lang: first.displayNameLang }) };
		selection.notices.push({ kind: "follower_activity", receipt, document: {
			id, type: "notification", schemaVersion, revision: 1, botId: followerBotId, worldId: first.worldId, status: "pending",
			notificationType: "followed_activity", createdAt: first.createdAt, updatedAt: first.createdAt,
			message: localizedTextFromStored(`Recent activity from ${actor.displayName.text}.`),
			event: { kind: "follower_activity_digest", type: "followed_activity", id, createdAt: first.createdAt,
				deliveryReasons: ["followed_profile_activity"], actor, activities, olderActivityOmitted },
		} });
	}
	return selection;
}

export async function pruneFollowerActivity(kv: KVNamespaceLike, db: D1DatabaseLike, now: string): Promise<{ expired: number; orphaned: number }> {
	const cutoff = new Date(Date.parse(now) - activityLifetimeMs).toISOString();
	const expired = await db.prepare(`DELETE FROM follower_activity_events WHERE sequence IN (
		SELECT sequence FROM follower_activity_events WHERE created_at < ? ORDER BY created_at, sequence LIMIT 8000)`)
		.bind(cutoff).run();
	const cursor = await readJson<number>(kv, orphanCursorKey);
	if (cursor !== null && !safePosition(cursor)) throw new TypeError("Invalid follower activity maintenance cursor.");
	const page = (await db.prepare(`SELECT e.sequence, CASE WHEN substr(source_ref,1,2) = 't/'
		THEN EXISTS(SELECT 1 FROM threads_index t JOIN forums_index f ON f.forum_id=t.forum_id WHERE t.thread_id=substr(e.source_ref,3) AND t.deleted_at IS NULL AND f.deleted_at IS NULL)
		ELSE EXISTS(SELECT 1 FROM comments_index c JOIN threads_index t ON t.thread_id=c.thread_id JOIN forums_index f ON f.forum_id=t.forum_id WHERE c.comment_id=substr(e.source_ref,3) AND c.deleted_at IS NULL AND t.deleted_at IS NULL AND f.deleted_at IS NULL) END AS available
		FROM follower_activity_events e WHERE e.sequence > ? ORDER BY e.sequence LIMIT 500`)
		.bind(cursor ?? 0).all<{ sequence: number; available: number }>()).results ?? [];
	const orphaned = page.filter(row => !row.available).map(row => row.sequence);
	const deleted = orphaned.length ? await db.batch(chunks(orphaned, 99).map(ids =>
		db.prepare(`DELETE FROM follower_activity_events WHERE sequence IN (${ids.map(() => "?").join(",")})`).bind(...ids))) : [];
	if (page.length < 500 && cursor !== null) await kv.delete(orphanCursorKey);
	else if (page.length === 500) await writeJson(kv, orphanCursorKey, page.at(-1)!.sequence, { expirationTtl: activityLifetimeMs / 1000 });
	return { expired: expired.meta?.changes ?? 0, orphaned: deleted.reduce((count, result) => count + (result.meta?.changes ?? 0), 0) };
}
