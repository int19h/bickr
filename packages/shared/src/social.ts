import { makeId } from "./ids";
import {
	schemaVersion,
	type BotDocument,
	type BotActivityFeed,
	type BotActivityItem,
	type BotPublicProfile,
	type BotSearchResult,
	type BotSummary,
	type CommentDocument,
	type CreateCommentInput,
	type CreateThreadInput,
	type ForumDocument,
	type HumanNotification,
	type HumanNotificationSummary,
	type HumanNotificationType,
	type HumanSubscription,
	type HumanSubscriptionScope,
	type NotificationDocument,
	type NotificationType,
	type SearchPostResult,
	type SpotlightBotPreview,
	type SpotlightDeliveryResult,
	type SpotlightIncludedContent,
	type SpotlightPreview,
	type SpotlightPreviewInput,
	type ThreadDocument,
	type ThreadSummary,
	type VoteDetail,
	type VoteInput,
	type WorldDocument,
} from "./model";
import {
	botByHandle,
	botById,
	botPublicProfile,
	defaultInitialBotNotification,
	introForumHandle,
	listUserBots,
	RepositoryError,
} from "./repository";
import {
	type D1DatabaseLike,
	type D1Result,
	type KVNamespaceLike,
	kvKeys,
	putObjectIndex,
	readJson,
	writeJson,
} from "./storage";

export async function forumByHandle(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldHandle: string,
	forumHandle: string,
): Promise<ForumDocument> {
	const row = await db
		.prepare(
			`SELECT forum_id AS id
			 FROM forums_index
			 WHERE world_handle = ? AND handle = ? AND deleted_at IS NULL`,
		)
		.bind(worldHandle, forumHandle)
		.first<{ id: string }>();
	if (!row) {
		throw repositoryError("not_found", "Forum not found.", 404);
	}
	return forumById(kv, db, row.id);
}

export async function forumById(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	forumId: string,
): Promise<ForumDocument> {
	const row = await db
		.prepare(`SELECT deleted_at AS deletedAt FROM forums_index WHERE forum_id = ?`)
		.bind(forumId)
		.first<{ deletedAt: string | null }>();
	if (!row || row.deletedAt) {
		throw repositoryError("not_found", "Forum not found.", 404);
	}
	const forum = await readJson<ForumDocument>(kv, kvKeys.forum(forumId));
	if (!forum || forum.deletedAt) {
		throw repositoryError("not_found", "Forum not found.", 404);
	}
	return forum;
}

export async function listThreads(
	db: D1DatabaseLike,
	forumId: string,
	sort: "recent" | "hot" = "recent",
	limit = 40,
): Promise<ThreadSummary[]> {
	const order =
		sort === "hot" ? "hot_score DESC, last_activity_at DESC" : "last_activity_at DESC, created_at DESC";
	const result = await db
		.prepare(
			`SELECT
				thread_id AS id,
				world_id AS worldId,
				world_handle AS worldHandle,
				forum_id AS forumId,
				forum_handle AS forumHandle,
				author_bot_id AS authorBotId,
				author_handle AS authorHandle,
				author_display_name AS authorDisplayName,
				title,
				body_preview AS bodyPreview,
				vote_score AS voteScore,
				comment_count AS commentCount,
				hot_score AS hotScore,
				created_at AS createdAt,
				last_activity_at AS lastActivityAt
			 FROM threads_index
			 WHERE forum_id = ? AND deleted_at IS NULL
			 ORDER BY ${order}
			 LIMIT ?`,
		)
		.bind(forumId, limit)
		.all<ThreadSummary>();
	return result.results ?? [];
}

export async function listThreadsWithReadState(
	db: D1DatabaseLike,
	forumId: string,
	userId: string | null,
	sort: "recent" | "hot" = "recent",
	limit = 40,
): Promise<ThreadSummary[]> {
	const threads = await listThreads(db, forumId, sort, limit);
	if (!userId) {
		return threads;
	}
	const seenThroughAt = await forumSeenThroughAt(db, userId, forumId);
	if (!seenThroughAt) {
		return threads.map((thread) => ({
			...thread,
			readState: {
				isNew: true,
				hasNewComments: false,
				newCommentCount: thread.commentCount,
			},
		}));
	}
	const decorated: ThreadSummary[] = [];
	for (const thread of threads) {
		const isNew = Date.parse(thread.createdAt) > Date.parse(seenThroughAt);
		const hasNewComments = !isNew && Date.parse(thread.lastActivityAt) > Date.parse(seenThroughAt);
		decorated.push({
			...thread,
			readState: {
				isNew,
				hasNewComments,
				newCommentCount: hasNewComments ? await countNewComments(db, thread.id, seenThroughAt) : 0,
			},
		});
	}
	return decorated;
}

export async function listHotThreads(
	db: D1DatabaseLike,
	worldId: string,
	limit = 20,
): Promise<ThreadSummary[]> {
	const result = await db
		.prepare(
			`SELECT
				thread_id AS id,
				world_id AS worldId,
				world_handle AS worldHandle,
				forum_id AS forumId,
				forum_handle AS forumHandle,
				author_bot_id AS authorBotId,
				author_handle AS authorHandle,
				author_display_name AS authorDisplayName,
				title,
				body_preview AS bodyPreview,
				vote_score AS voteScore,
				comment_count AS commentCount,
				hot_score AS hotScore,
				created_at AS createdAt,
				last_activity_at AS lastActivityAt
			 FROM threads_index
			 WHERE world_id = ? AND deleted_at IS NULL
			 ORDER BY hot_score DESC, last_activity_at DESC
			 LIMIT ?`,
		)
		.bind(worldId, limit)
		.all<ThreadSummary>();
	return result.results ?? [];
}

export async function readThread(kv: KVNamespaceLike, threadId: string): Promise<ThreadDocument> {
	const thread = await readJson<ThreadDocument>(kv, kvKeys.thread(threadId));
	if (!thread || thread.deletedAt) {
		throw repositoryError("not_found", "Thread not found.", 404);
	}
	return thread;
}

export async function readThreadWithReadState(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	threadId: string,
	userId: string | null,
): Promise<ThreadDocument> {
	const thread = await readThread(kv, threadId);
	if (!userId) {
		return thread;
	}
	const seenThroughAt = await threadSeenThroughAt(db, userId, threadId);
	if (!seenThroughAt) {
		return {
			...thread,
			readState: {
				isNew: true,
				hasNewComments: false,
				newCommentCount: thread.commentCount,
			},
			comments: thread.comments.map((comment) => ({
				...comment,
				readState: { isNew: true },
			})),
		};
	}
	return {
		...thread,
		readState: {
			isNew: Date.parse(thread.createdAt) > Date.parse(seenThroughAt),
			hasNewComments: Date.parse(thread.lastActivityAt) > Date.parse(seenThroughAt),
			newCommentCount: await countNewComments(db, thread.id, seenThroughAt),
		},
		comments: thread.comments.map((comment) => ({
			...comment,
			readState: { isNew: Date.parse(comment.createdAt) > Date.parse(seenThroughAt) },
		})),
	};
}

export async function recordForumRead(
	db: D1DatabaseLike,
	userId: string,
	forumId: string,
	seenThroughAt = new Date().toISOString(),
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO user_forum_reads (user_id, forum_id, seen_through_at, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id, forum_id) DO UPDATE SET
				seen_through_at = CASE
					WHEN excluded.seen_through_at > user_forum_reads.seen_through_at
					THEN excluded.seen_through_at
					ELSE user_forum_reads.seen_through_at
				END,
				updated_at = excluded.updated_at`,
		)
		.bind(userId, forumId, seenThroughAt, seenThroughAt)
		.run();
}

export async function recordThreadRead(
	db: D1DatabaseLike,
	userId: string,
	threadId: string,
	seenThroughAt = new Date().toISOString(),
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO user_thread_reads (user_id, thread_id, seen_through_at, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id, thread_id) DO UPDATE SET
				seen_through_at = CASE
					WHEN excluded.seen_through_at > user_thread_reads.seen_through_at
					THEN excluded.seen_through_at
					ELSE user_thread_reads.seen_through_at
				END,
				updated_at = excluded.updated_at`,
		)
		.bind(userId, threadId, seenThroughAt, seenThroughAt)
		.run();
}

export async function forumActivitySince(
	db: D1DatabaseLike,
	forumId: string,
	since: string,
): Promise<{ newThreadCount: number; updatedThreadCount: number; latestActivityAt?: string }> {
	const row = await db
		.prepare(
			`SELECT
				SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS newThreadCount,
				SUM(CASE WHEN created_at <= ? AND last_activity_at > ? THEN 1 ELSE 0 END) AS updatedThreadCount,
				MAX(last_activity_at) AS latestActivityAt
			 FROM threads_index
			 WHERE forum_id = ? AND deleted_at IS NULL AND last_activity_at > ?`,
		)
		.bind(since, since, since, forumId, since)
		.first<{ newThreadCount: number | null; updatedThreadCount: number | null; latestActivityAt: string | null }>();
	return {
		newThreadCount: row?.newThreadCount ?? 0,
		updatedThreadCount: row?.updatedThreadCount ?? 0,
		...(row?.latestActivityAt ? { latestActivityAt: row.latestActivityAt } : {}),
	};
}

export async function threadActivitySince(
	db: D1DatabaseLike,
	threadId: string,
	since: string,
): Promise<{ newCommentCount: number; latestActivityAt?: string }> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS newCommentCount, MAX(created_at) AS latestActivityAt
			 FROM comments_index
			 WHERE thread_id = ? AND deleted_at IS NULL AND created_at > ?`,
		)
		.bind(threadId, since)
		.first<{ newCommentCount: number; latestActivityAt: string | null }>();
	return {
		newCommentCount: row?.newCommentCount ?? 0,
		...(row?.latestActivityAt ? { latestActivityAt: row.latestActivityAt } : {}),
	};
}

export async function listHumanSubscriptions(
	db: D1DatabaseLike,
	userId: string,
): Promise<HumanSubscription[]> {
	const result = await db
		.prepare(
			`SELECT
				subscription_id AS id,
				user_id AS userId,
				world_id AS worldId,
				scope_type AS scopeType,
				scope_id AS scopeId,
				active,
				auto_created AS autoCreated,
				created_at AS createdAt,
				updated_at AS updatedAt
			 FROM human_subscriptions
			 WHERE user_id = ?
			 ORDER BY updated_at DESC`,
		)
		.bind(userId)
		.all<HumanSubscriptionRow>();
	return (result.results ?? []).map(subscriptionFromRow);
}

export async function upsertHumanSubscription(
	db: D1DatabaseLike,
	input: {
		userId: string;
		worldId: string;
		scopeType: HumanSubscriptionScope;
		scopeId: string;
		autoCreated?: boolean;
	},
	now = new Date().toISOString(),
): Promise<HumanSubscription> {
	const id = makeId("hsb");
	await db
		.prepare(
			`INSERT INTO human_subscriptions (
				subscription_id, user_id, world_id, scope_type, scope_id,
				active, auto_created, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
			ON CONFLICT(user_id, scope_type, scope_id) DO UPDATE SET
				world_id = excluded.world_id,
				active = 1,
				auto_created = excluded.auto_created,
				updated_at = excluded.updated_at`,
		)
		.bind(
			id,
			input.userId,
			input.worldId,
			input.scopeType,
			input.scopeId,
			input.autoCreated ? 1 : 0,
			now,
			now,
		)
		.run();
	const row = await db
		.prepare(
			`SELECT
				subscription_id AS id,
				user_id AS userId,
				world_id AS worldId,
				scope_type AS scopeType,
				scope_id AS scopeId,
				active,
				auto_created AS autoCreated,
				created_at AS createdAt,
				updated_at AS updatedAt
			 FROM human_subscriptions
			 WHERE user_id = ? AND scope_type = ? AND scope_id = ?`,
		)
		.bind(input.userId, input.scopeType, input.scopeId)
		.first<HumanSubscriptionRow>();
	if (!row) {
		throw repositoryError("server_error", "Subscription was not saved.", 500);
	}
	return subscriptionFromRow(row);
}

export async function deactivateHumanSubscription(
	db: D1DatabaseLike,
	userId: string,
	scopeType: HumanSubscriptionScope,
	scopeId: string,
	now = new Date().toISOString(),
): Promise<void> {
	await db
		.prepare(
			`UPDATE human_subscriptions
			 SET active = 0, updated_at = ?
			 WHERE user_id = ? AND scope_type = ? AND scope_id = ?`,
		)
		.bind(now, userId, scopeType, scopeId)
		.run();
}

export async function listHumanNotifications(
	db: D1DatabaseLike,
	userId: string,
	status: "unread" | "all" = "unread",
	limit = 30,
): Promise<HumanNotificationSummary> {
	const unread = await db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM human_notifications
			 WHERE user_id = ? AND archived_at IS NULL AND read_at IS NULL`,
		)
		.bind(userId)
		.first<{ count: number }>();
	const filter = status === "unread" ? "AND read_at IS NULL" : "";
	const result = await db
		.prepare(
			`SELECT ${humanNotificationColumns}
			 FROM human_notifications
			 WHERE user_id = ? AND archived_at IS NULL ${filter}
			 ORDER BY created_at DESC
			 LIMIT ?`,
		)
		.bind(userId, limit)
		.all<HumanNotificationRow>();
	return {
		unreadCount: unread?.count ?? 0,
		notifications: (result.results ?? []).map(humanNotificationFromRow),
	};
}

export async function markHumanNotificationRead(
	db: D1DatabaseLike,
	userId: string,
	notificationId: string,
	read = true,
	now = new Date().toISOString(),
): Promise<void> {
	await db
		.prepare(
			`UPDATE human_notifications
			 SET read_at = ?
			 WHERE user_id = ? AND notification_id = ?`,
		)
		.bind(read ? now : null, userId, notificationId)
		.run();
}

export async function archiveHumanNotification(
	db: D1DatabaseLike,
	userId: string,
	notificationId: string,
	now = new Date().toISOString(),
): Promise<void> {
	await db
		.prepare(
			`UPDATE human_notifications
			 SET archived_at = ?, read_at = COALESCE(read_at, ?)
			 WHERE user_id = ? AND notification_id = ?`,
		)
		.bind(now, now, userId, notificationId)
		.run();
}

export async function markAllHumanNotificationsRead(
	db: D1DatabaseLike,
	userId: string,
	now = new Date().toISOString(),
): Promise<void> {
	await db
		.prepare(
			`UPDATE human_notifications
			 SET read_at = ?
			 WHERE user_id = ? AND archived_at IS NULL AND read_at IS NULL`,
		)
		.bind(now, userId)
		.run();
}

async function notifyHumanThreadCreated(
	db: D1DatabaseLike,
	thread: ThreadDocument,
	actor: BotDocument,
	now: string,
): Promise<void> {
	const users = await subscribedUsersForScopes(db, [
		{ scopeType: "world", scopeId: thread.worldId },
		{ scopeType: "forum", scopeId: thread.forumId },
		{ scopeType: "bot", scopeId: actor.id },
	]);
	for (const userId of users) {
		await insertHumanNotification(db, {
			userId,
			worldId: thread.worldId,
			eventKey: `thread_created:${thread.id}`,
			notificationType: "thread_created",
			actor,
			sourceType: "thread",
			sourceId: thread.id,
			targetType: "forum",
			targetId: thread.forumId,
			title: `${actor.displayName} posted in f/${thread.forumHandle}`,
			body: thread.rootPost.title,
			urlPath: threadUrlPath(thread),
			now,
		});
	}
}

async function notifyHumanCommentCreated(
	db: D1DatabaseLike,
	thread: ThreadDocument,
	comment: CommentDocument,
	actor: BotDocument,
	now: string,
): Promise<void> {
	const ancestorIds = commentAncestorIds(thread, comment);
	const users = await subscribedUsersForScopes(db, [
		{ scopeType: "world", scopeId: thread.worldId },
		{ scopeType: "thread", scopeId: thread.id },
		{ scopeType: "bot", scopeId: actor.id },
		...ancestorIds.map((scopeId) => ({ scopeType: "comment" as const, scopeId })),
	]);
	for (const userId of users) {
		await insertHumanNotification(db, {
			userId,
			worldId: thread.worldId,
			eventKey: `comment_created:${comment.id}`,
			notificationType: "comment_created",
			actor,
			sourceType: "comment",
			sourceId: comment.id,
			targetType: "thread",
			targetId: thread.id,
			title: `${actor.displayName} replied in "${thread.rootPost.title}"`,
			body: preview(comment.body),
			urlPath: commentUrlPath(thread, comment.id),
			now,
		});
	}
}

async function notifyHumanVoteCast(
	db: D1DatabaseLike,
	thread: ThreadDocument,
	input: VoteInput,
	actor: BotDocument,
	now: string,
): Promise<void> {
	if (input.value === 0) {
		return;
	}
	const users = await subscribedUsersForScopes(db, [
		{ scopeType: "world", scopeId: thread.worldId },
		{ scopeType: "bot", scopeId: actor.id },
	]);
	for (const userId of users) {
		const direction = input.value > 0 ? "upvoted" : "downvoted";
		await insertHumanNotification(db, {
			userId,
			worldId: thread.worldId,
			eventKey: `vote_cast:${input.targetType}:${input.targetId}:${actor.id}:${input.value}:${now}`,
			notificationType: "vote_cast",
			actor,
			sourceType: "vote",
			sourceId: `${input.targetType}:${input.targetId}:${actor.id}`,
			targetType: input.targetType,
			targetId: input.targetId,
			title: `${actor.displayName} ${direction} a ${input.targetType}`,
			body: thread.rootPost.title,
			urlPath:
				input.targetType === "comment" ? commentUrlPath(thread, input.targetId) : threadUrlPath(thread),
			now,
		});
	}
}

async function notifyHumanFollowCreated(
	db: D1DatabaseLike,
	follower: BotDocument,
	followed: BotDocument,
	now: string,
): Promise<void> {
	const users = await subscribedUsersForScopes(db, [
		{ scopeType: "world", scopeId: follower.homeWorldId },
		{ scopeType: "bot", scopeId: follower.id },
	]);
	for (const userId of users) {
		await insertHumanNotification(db, {
			userId,
			worldId: follower.homeWorldId,
			eventKey: `bot_followed:${follower.id}:${followed.id}`,
			notificationType: "bot_followed",
			actor: follower,
			sourceType: "follow",
			sourceId: `${follower.id}:${followed.id}`,
			targetType: "bot",
			targetId: followed.id,
			title: `${follower.displayName} followed ${followed.displayName}`,
			body: `u/${follower.handle} followed u/${followed.handle}.`,
			urlPath: botUrlPath(followed),
			now,
		});
	}
}

export async function recordSpotlightToolHumanNotification(
	db: D1DatabaseLike,
	input: {
		bot: BotDocument;
		spotlightId: string;
		runId: string;
		toolName: string;
		args: Record<string, unknown>;
		result: unknown;
		now?: string;
	},
): Promise<void> {
	const now = input.now ?? new Date().toISOString();
	const delivery = await db
		.prepare(
			`SELECT user_id AS userId, world_id AS worldId
			 FROM spotlight_deliveries
			 WHERE spotlight_id = ? AND bot_id = ?
			 LIMIT 1`,
		)
		.bind(input.spotlightId, input.bot.id)
		.first<{ userId: string; worldId: string }>();
	if (!delivery) {
		return;
	}
	const action = spotlightActionSummary(input.toolName, input.args, input.result, input.bot);
	const standardNotification = spotlightStandardHumanNotification(input.toolName, input.result, input.bot, {
		userId: delivery.userId,
		worldId: delivery.worldId,
		spotlightId: input.spotlightId,
		now,
	});
	if (standardNotification) {
		await insertOrAnnotateSpotlightHumanNotification(db, standardNotification);
		return;
	}
	if (!action) {
		return;
	}
	await insertHumanNotification(db, {
		userId: delivery.userId,
		worldId: delivery.worldId,
		eventKey: `spotlight_action:${input.spotlightId}:${input.runId}:${input.toolName}:${action.targetType ?? "tool"}:${action.targetId ?? now}`,
		notificationType: "spotlight_action",
		actor: input.bot,
		sourceType: "spotlight",
		sourceId: input.spotlightId,
		targetType: action.targetType,
		targetId: action.targetId,
		title: action.title,
		body: action.body,
		urlPath: action.urlPath,
		spotlightId: input.spotlightId,
		spotlightLabel: "caused by spotlight",
		now,
	});
}

export async function recordBotRuntimeFailureHumanNotification(
	db: D1DatabaseLike,
	input: {
		bot: BotDocument;
		runId: string;
		message: string;
		toolName?: string;
		now?: string;
	},
): Promise<void> {
	const now = input.now ?? new Date().toISOString();
	await insertHumanNotification(db, {
		userId: input.bot.ownerUserId,
		worldId: input.bot.homeWorldId,
		eventKey: `bot_runtime_failed:${input.bot.id}:${input.runId}`,
		notificationType: "bot_runtime_failed",
		actor: input.bot,
		sourceType: "bot",
		sourceId: input.bot.id,
		targetType: "bot_loop",
		targetId: input.bot.id,
		title: `${input.bot.displayName} hit repeated tool errors`,
		body: [
			`u/${input.bot.handle} stopped after repeated invalid tool calls.`,
			input.toolName ? `Last failed tool: ${input.toolName}.` : "",
			input.message,
			"Check the loop and consider changing the bot's model or settings.",
		]
			.filter(Boolean)
			.join(" "),
		urlPath: `/w/${encodeURIComponent(input.bot.homeWorldHandle)}/u/${encodeURIComponent(input.bot.handle)}/loop`,
		now,
	});
}

export async function recordSpotlightFailureHumanNotification(
	db: D1DatabaseLike,
	input: {
		bot: BotDocument;
		spotlightId: string;
		runId: string;
		message: string;
		now?: string;
	},
): Promise<void> {
	const now = input.now ?? new Date().toISOString();
	const delivery = await db
		.prepare(
			`SELECT user_id AS userId, world_id AS worldId
			 FROM spotlight_deliveries
			 WHERE spotlight_id = ? AND bot_id = ?
			 LIMIT 1`,
		)
		.bind(input.spotlightId, input.bot.id)
		.first<{ userId: string; worldId: string }>();
	if (!delivery) {
		return;
	}
	await insertHumanNotification(db, {
		userId: delivery.userId,
		worldId: delivery.worldId,
		eventKey: `spotlight_failed:${input.spotlightId}:${input.bot.id}:${input.runId}`,
		notificationType: "spotlight_failed",
		actor: input.bot,
		sourceType: "spotlight",
		sourceId: input.spotlightId,
		targetType: "bot_loop",
		targetId: input.bot.id,
		title: `${input.bot.displayName} could not process spotlight`,
		body: `u/${input.bot.handle} could not finish the spotlight tick: ${input.message}`,
		urlPath: `/w/${encodeURIComponent(input.bot.homeWorldHandle)}/u/${encodeURIComponent(input.bot.handle)}/loop`,
		spotlightId: input.spotlightId,
		spotlightLabel: "spotlight failed",
		now,
	});
}

async function subscribedUsersForScopes(
	db: D1DatabaseLike,
	scopes: SubscriptionScopeTarget[],
): Promise<Set<string>> {
	const users = new Set<string>();
	const unique = new Map(scopes.map((scope) => [`${scope.scopeType}:${scope.scopeId}`, scope]));
	for (const scope of unique.values()) {
		const result = await db
			.prepare(
				`SELECT user_id AS userId
				 FROM human_subscriptions
				 WHERE scope_type = ? AND scope_id = ? AND active = 1`,
			)
			.bind(scope.scopeType, scope.scopeId)
			.all<{ userId: string }>();
		for (const row of result.results ?? []) {
			users.add(row.userId);
		}
	}
	return users;
}

async function insertHumanNotification(
	db: D1DatabaseLike,
	input: HumanNotificationInput,
): Promise<void> {
	await db
		.prepare(
			`INSERT OR IGNORE INTO human_notifications (
				notification_id, user_id, world_id, event_key, notification_type,
				actor_bot_id, actor_handle, actor_display_name,
				source_type, source_id, target_type, target_id,
				title, body, url_path, spotlight_id, spotlight_label,
				created_at, read_at, archived_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
		)
		.bind(
			makeId("hnt"),
			input.userId,
			input.worldId,
			input.eventKey,
			input.notificationType,
			input.actor?.id ?? null,
			input.actor?.handle ?? null,
			input.actor?.displayName ?? null,
			input.sourceType ?? null,
			input.sourceId ?? null,
			input.targetType ?? null,
			input.targetId ?? null,
			input.title,
			input.body,
			input.urlPath,
			input.spotlightId ?? null,
			input.spotlightLabel ?? null,
			input.now,
		)
		.run();
}

async function insertOrAnnotateSpotlightHumanNotification(
	db: D1DatabaseLike,
	input: HumanNotificationInput & { spotlightId: string; spotlightLabel: string },
): Promise<void> {
	const existing = await db
		.prepare(
			`SELECT notification_id AS id
			 FROM human_notifications
			 WHERE user_id = ? AND event_key = ?
			 LIMIT 1`,
		)
		.bind(input.userId, input.eventKey)
		.first<{ id: string }>();
	if (!existing) {
		await insertHumanNotification(db, input);
	}
	await db
		.prepare(
			`UPDATE human_notifications
			 SET spotlight_id = COALESCE(spotlight_id, ?),
			     spotlight_label = COALESCE(spotlight_label, ?)
			 WHERE user_id = ? AND event_key = ?`,
		)
		.bind(input.spotlightId, input.spotlightLabel, input.userId, input.eventKey)
		.run();
}

export async function createThread(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	input: CreateThreadInput,
	now = new Date().toISOString(),
): Promise<ThreadDocument> {
	const forum = await forumById(kv, db, input.forumId);
	const bot = await botById(kv, db, input.authorBotId);
	assertBotInWorld(bot, forum.worldId);

	const threadId = makeId("thr");
	const postId = makeId("pst");
	const rootPost = {
		id: postId,
		threadId,
		worldId: forum.worldId,
		worldHandle: forum.worldHandle,
		forumId: forum.id,
		forumHandle: forum.handle,
		authorBotId: bot.id,
		authorHandle: bot.handle,
		authorDisplayName: bot.displayName,
		title: input.title,
		body: input.body,
		...(input.url ? { url: input.url } : {}),
		voteScore: 0,
		createdAt: now,
		updatedAt: now,
	};
	const thread: ThreadDocument = {
		id: threadId,
		type: "thread",
		schemaVersion,
		revision: 1,
		worldId: forum.worldId,
		worldHandle: forum.worldHandle,
		forumId: forum.id,
		forumHandle: forum.handle,
		rootPost,
		comments: [],
		commentCount: 0,
		voteScore: 0,
		recentCommentCount: 0,
		hotScore: hotScore(0, 0, now),
		lastActivityAt: now,
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.thread(thread.id), thread);
	await upsertThreadIndex(db, thread);
	await putObjectIndex(db, thread, "thread", thread.worldId);

	if (forum.personalBotId && forum.personalBotId !== bot.id) {
		await createNotification(kv, db, {
			worldId: forum.worldId,
			botId: forum.personalBotId,
			notificationType: "personal_forum_post",
			sourceObjectId: thread.id,
			message: `${bot.displayName} posted in your personal forum: "${thread.rootPost.title}".`,
			now,
		});
	}
	await notifyMentions(kv, db, thread.worldId, bot, `${input.title}\n${input.body}`, thread.id, thread.rootPost.title, now);
	await notifyHumanThreadCreated(db, thread, bot, now);

	return thread;
}

export async function createComment(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	input: CreateCommentInput,
	now = new Date().toISOString(),
): Promise<ThreadDocument> {
	const thread = await readThread(kv, input.threadId);
	const bot = await botById(kv, db, input.authorBotId);
	assertBotInWorld(bot, thread.worldId);
	if (input.parentCommentId && !thread.comments.some((comment) => comment.id === input.parentCommentId)) {
		throw repositoryError("not_found", "Parent comment not found.", 404);
	}

	const comment: CommentDocument = {
		id: makeId("cmt"),
		threadId: thread.id,
		worldId: thread.worldId,
		forumId: thread.forumId,
		authorBotId: bot.id,
		authorHandle: bot.handle,
		authorDisplayName: bot.displayName,
		...(input.parentCommentId ? { parentCommentId: input.parentCommentId } : {}),
		body: input.body,
		voteScore: 0,
		createdAt: now,
		updatedAt: now,
	};
	const updated: ThreadDocument = {
		...thread,
		comments: [...thread.comments, comment],
		commentCount: thread.commentCount + 1,
		recentCommentCount: thread.recentCommentCount + 1,
		hotScore: hotScore(thread.voteScore, thread.commentCount + 1, now),
		lastActivityAt: now,
		revision: thread.revision + 1,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.thread(thread.id), updated);
	await upsertThreadIndex(db, updated);
	await upsertCommentIndex(db, updated, comment);
	await notifyReply(kv, db, updated, comment, bot, now);
	await notifyMentions(kv, db, updated.worldId, bot, input.body, comment.id, updated.rootPost.title, now);
	await notifyHumanCommentCreated(db, updated, comment, bot, now);

	return updated;
}

export async function setVote(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	input: VoteInput,
	now = new Date().toISOString(),
): Promise<ThreadDocument> {
	const voter = await botById(kv, db, input.botId);
	const target = await resolveVoteTarget(kv, db, input);
	assertBotInWorld(voter, target.thread.worldId);

	const existing = await db
		.prepare(
			`SELECT value
			 FROM votes
			 WHERE target_type = ? AND target_id = ? AND bot_id = ?`,
		)
		.bind(input.targetType, input.targetId, input.botId)
		.first<{ value: number }>();
	const previous = existing?.value ?? 0;
	if (previous === input.value) {
		return target.thread;
	}

	if (input.value === 0) {
		await db
			.prepare(`DELETE FROM votes WHERE target_type = ? AND target_id = ? AND bot_id = ?`)
			.bind(input.targetType, input.targetId, input.botId)
			.run();
	} else {
		await db
			.prepare(
				`INSERT INTO votes (
					world_id, target_type, target_id, bot_id, value, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(target_type, target_id, bot_id) DO UPDATE SET
					value = excluded.value,
					updated_at = excluded.updated_at`,
			)
			.bind(target.thread.worldId, input.targetType, input.targetId, input.botId, input.value, now, now)
			.run();
	}

	const delta = input.value - previous;
	const updated = applyVoteDelta(target.thread, input, delta, now);
	await writeJson(kv, kvKeys.thread(updated.id), updated);
	await upsertThreadIndex(db, updated);
	if (input.targetType === "comment") {
		const comment = updated.comments.find((item) => item.id === input.targetId);
		if (comment) {
			await upsertCommentIndex(db, updated, comment);
		}
	}

	if (delta !== 0 && target.authorBotId !== input.botId) {
		await createNotification(kv, db, {
			worldId: updated.worldId,
			botId: target.authorBotId,
			notificationType: "vote",
			sourceObjectId: input.targetId,
			message: `${voter.displayName} ${delta > 0 ? "upvoted" : "downvoted"} your ${input.targetType}.`,
			now,
		});
	}
	if (delta !== 0) {
		await notifyHumanVoteCast(db, updated, input, voter, now);
	}

	return updated;
}

export async function listVotesForTarget(
	db: D1DatabaseLike,
	worldId: string,
	targetType: "thread" | "comment",
	targetId: string,
): Promise<VoteDetail[]> {
	const result = await db
		.prepare(
			`SELECT
				v.bot_id AS botId,
				b.handle,
				b.display_name AS displayName,
				v.value,
				v.created_at AS createdAt,
				v.updated_at AS updatedAt
			 FROM votes v
			 JOIN bots_index b ON b.bot_id = v.bot_id
			 WHERE v.world_id = ?
			   AND v.target_type = ?
			   AND v.target_id = ?
			   AND v.value != 0
			 ORDER BY v.updated_at DESC`,
		)
		.bind(worldId, targetType, targetId)
		.all<VoteDetail>();
	return result.results ?? [];
}

export async function followBot(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	followerBotId: string,
	followedBotId: string,
	now = new Date().toISOString(),
): Promise<{ following: boolean }> {
	if (followerBotId === followedBotId) {
		throw repositoryError("bad_request", "A bot cannot follow itself.", 400);
	}
	const follower = await botById(kv, db, followerBotId);
	const followed = await botById(kv, db, followedBotId);
	assertBotInWorld(follower, followed.homeWorldId);

	const existing = await db
		.prepare(`SELECT created_at AS createdAt FROM follows WHERE follower_bot_id = ? AND followed_bot_id = ?`)
		.bind(followerBotId, followedBotId)
		.first<{ createdAt: string }>();
	if (!existing) {
		await db
			.prepare(
				`INSERT INTO follows (world_id, follower_bot_id, followed_bot_id, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.bind(follower.homeWorldId, followerBotId, followedBotId, now)
			.run();
		await createNotification(kv, db, {
			worldId: follower.homeWorldId,
			botId: followedBotId,
			notificationType: "follow",
			sourceObjectId: followerBotId,
			message: `${follower.displayName} followed you.`,
			now,
		});
		await notifyHumanFollowCreated(db, follower, followed, now);
	}
	return { following: true };
}

export async function unfollowBot(
	db: D1DatabaseLike,
	followerBotId: string,
	followedBotId: string,
): Promise<{ following: boolean }> {
	await db
		.prepare(`DELETE FROM follows WHERE follower_bot_id = ? AND followed_bot_id = ?`)
		.bind(followerBotId, followedBotId)
		.run();
	return { following: false };
}

export async function searchBots(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldId: string,
	query: string,
	limit = 20,
): Promise<BotSearchResult[]> {
	const term = likePatternForSearch(query);
	if (!term) {
		return [];
	}
	const result = await safeD1Search(() =>
		db
			.prepare(
				`SELECT bot_id AS id
				 FROM bots_index
				 WHERE home_world_id = ?
				   AND deleted_at IS NULL
				   AND (
					lower(handle) LIKE ? ESCAPE '\\'
					OR lower(display_name) LIKE ? ESCAPE '\\'
					OR lower(short_bio) LIKE ? ESCAPE '\\'
				   )
				 ORDER BY handle ASC
				 LIMIT ?`,
			)
			.bind(worldId, term, term, term, limit)
			.all<{ id: string }>(),
	);
	const bots = await Promise.all((result.results ?? []).map((row) => readJson<BotDocument>(kv, kvKeys.bot(row.id))));
	return bots
		.filter((bot): bot is BotDocument => Boolean(bot && !bot.deletedAt))
		.map((bot) => ({ ...botPublicProfile(bot), source: "text" as const }));
}

export async function botPublicProfileByHandle(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldId: string,
	handle: string,
): Promise<BotPublicProfile> {
	const bot = await botByHandle(kv, db, worldId, handle);
	if (!bot) {
		throw repositoryError("not_found", "Bot not found.", 404);
	}
	return botPublicProfile(bot);
}

export async function botActivityFeedByHandle(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldId: string,
	handle: string,
	limit = 30,
): Promise<BotActivityFeed> {
	const bot = await botByHandle(kv, db, worldId, handle);
	if (!bot) {
		throw repositoryError("not_found", "Bot not found.", 404);
	}

	const [posts, comments, threadVotes, commentVotes, follows] = await Promise.all([
		botPostActivities(db, bot.id, limit),
		botCommentActivities(db, bot.id, limit),
		botThreadVoteActivities(db, bot.id, limit),
		botCommentVoteActivities(db, bot.id, limit),
		botFollowActivities(db, bot.id, limit),
	]);
	const activities = [...posts, ...comments, ...threadVotes, ...commentVotes, ...follows]
		.sort((left, right) => Date.parse(activityDate(right)) - Date.parse(activityDate(left)))
		.slice(0, limit);
	return {
		bot: botPublicProfile(bot),
		activities,
	};
}

export async function searchPosts(
	db: D1DatabaseLike,
	worldId: string,
	query: string,
	limit = 20,
): Promise<SearchPostResult[]> {
	const term = likePatternForSearch(query);
	if (!term) {
		return [];
	}
	const threadResults = await safeD1Search(() =>
		db
			.prepare(
				`SELECT
					thread_id AS threadId,
					forum_handle AS forumHandle,
					title,
					body_preview AS snippet,
					author_bot_id AS authorBotId,
					author_handle AS authorHandle,
					created_at AS createdAt,
					hot_score AS score
				 FROM threads_index
				 WHERE world_id = ? AND deleted_at IS NULL AND lower(search_text) LIKE ? ESCAPE '\\'
				 ORDER BY last_activity_at DESC
				 LIMIT ?`,
			)
			.bind(worldId, term, limit)
			.all<SearchPostResult>(),
	);
	const commentResults = await safeD1Search(() =>
		db
			.prepare(
				`SELECT
					c.thread_id AS threadId,
					c.comment_id AS commentId,
					t.forum_handle AS forumHandle,
					t.title AS title,
					c.body_preview AS snippet,
					c.author_bot_id AS authorBotId,
					c.author_handle AS authorHandle,
					c.created_at AS createdAt,
					c.vote_score AS score
				 FROM comments_index c
				 JOIN threads_index t ON t.thread_id = c.thread_id
				 WHERE c.world_id = ? AND c.deleted_at IS NULL AND lower(c.search_text) LIKE ? ESCAPE '\\'
				 ORDER BY c.created_at DESC
				 LIMIT ?`,
			)
			.bind(worldId, term, limit)
			.all<SearchPostResult>(),
	);
	return [...(threadResults.results ?? []), ...(commentResults.results ?? [])].slice(0, limit);
}

export async function searchForumPosts(
	db: D1DatabaseLike,
	forumId: string,
	query: string,
	limit = 20,
): Promise<SearchPostResult[]> {
	const term = likePatternForSearch(query);
	if (!term) {
		return [];
	}
	const threadResults = await safeD1Search(() =>
		db
			.prepare(
				`SELECT
					thread_id AS threadId,
					forum_handle AS forumHandle,
					title,
					body_preview AS snippet,
					author_bot_id AS authorBotId,
					author_handle AS authorHandle,
					created_at AS createdAt,
					hot_score AS score
				 FROM threads_index
				 WHERE forum_id = ? AND deleted_at IS NULL AND lower(search_text) LIKE ? ESCAPE '\\'
				 ORDER BY last_activity_at DESC
				 LIMIT ?`,
			)
			.bind(forumId, term, limit)
			.all<SearchPostResult>(),
	);
	const commentResults = await safeD1Search(() =>
		db
			.prepare(
				`SELECT
					c.thread_id AS threadId,
					c.comment_id AS commentId,
					t.forum_handle AS forumHandle,
					t.title AS title,
					c.body_preview AS snippet,
					c.author_bot_id AS authorBotId,
					c.author_handle AS authorHandle,
					c.created_at AS createdAt,
					c.vote_score AS score
				 FROM comments_index c
				 JOIN threads_index t ON t.thread_id = c.thread_id
				 WHERE c.forum_id = ? AND c.deleted_at IS NULL AND lower(c.search_text) LIKE ? ESCAPE '\\'
				 ORDER BY c.created_at DESC
				 LIMIT ?`,
			)
			.bind(forumId, term, limit)
			.all<SearchPostResult>(),
	);
	return [...(threadResults.results ?? []), ...(commentResults.results ?? [])].slice(0, limit);
}

async function botPostActivities(
	db: D1DatabaseLike,
	botId: string,
	limit: number,
): Promise<BotActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				thread_id AS threadId,
				world_handle AS worldHandle,
				forum_handle AS forumHandle,
				title,
				body_preview AS bodyPreview,
				vote_score AS voteScore,
				comment_count AS commentCount,
				created_at AS createdAt
			 FROM threads_index
			 WHERE author_bot_id = ? AND deleted_at IS NULL
			 ORDER BY created_at DESC
			 LIMIT ?`,
		)
		.bind(botId, limit)
		.all<{
			threadId: string;
			worldHandle: string;
			forumHandle: string;
			title: string;
			bodyPreview: string;
			voteScore: number;
			commentCount: number;
			createdAt: string;
		}>();
	return (result.results ?? []).map((row) => ({
		type: "post" as const,
		id: `post:${row.threadId}`,
		threadId: row.threadId,
		worldHandle: row.worldHandle,
		forumHandle: row.forumHandle,
		title: row.title,
		bodyPreview: row.bodyPreview,
		voteScore: row.voteScore,
		commentCount: row.commentCount,
		createdAt: row.createdAt,
	}));
}

async function botCommentActivities(
	db: D1DatabaseLike,
	botId: string,
	limit: number,
): Promise<BotActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				c.comment_id AS commentId,
				c.thread_id AS threadId,
				c.parent_comment_id AS parentCommentId,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title AS threadTitle,
				c.body_preview AS bodyPreview,
				c.vote_score AS voteScore,
				c.created_at AS createdAt
			 FROM comments_index c
			 JOIN threads_index t ON t.thread_id = c.thread_id
			 WHERE c.author_bot_id = ? AND c.deleted_at IS NULL AND t.deleted_at IS NULL
			 ORDER BY c.created_at DESC
			 LIMIT ?`,
		)
		.bind(botId, limit)
		.all<{
			commentId: string;
			threadId: string;
			parentCommentId: string | null;
			worldHandle: string;
			forumHandle: string;
			threadTitle: string;
			bodyPreview: string;
			voteScore: number;
			createdAt: string;
		}>();
	return (result.results ?? []).map((row) => ({
		type: "comment" as const,
		id: `comment:${row.commentId}`,
		threadId: row.threadId,
		commentId: row.commentId,
		...(row.parentCommentId ? { parentCommentId: row.parentCommentId } : {}),
		worldHandle: row.worldHandle,
		forumHandle: row.forumHandle,
		threadTitle: row.threadTitle,
		bodyPreview: row.bodyPreview,
		voteScore: row.voteScore,
		createdAt: row.createdAt,
	}));
}

async function botThreadVoteActivities(
	db: D1DatabaseLike,
	botId: string,
	limit: number,
): Promise<BotActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				v.target_id AS targetId,
				v.value AS value,
				v.updated_at AS updatedAt,
				t.thread_id AS threadId,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title AS title
			 FROM votes v
			 JOIN threads_index t ON t.thread_id = v.target_id
			 WHERE v.bot_id = ? AND v.target_type = 'thread' AND t.deleted_at IS NULL
			 ORDER BY v.updated_at DESC
			 LIMIT ?`,
		)
		.bind(botId, limit)
		.all<{
			targetId: string;
			value: number;
			updatedAt: string;
			threadId: string;
			worldHandle: string;
			forumHandle: string;
			title: string;
		}>();
	return (result.results ?? []).map((row) => ({
		type: "vote" as const,
		id: `vote:thread:${row.targetId}`,
		targetType: "thread" as const,
		targetId: row.targetId,
		value: row.value,
		threadId: row.threadId,
		worldHandle: row.worldHandle,
		forumHandle: row.forumHandle,
		title: row.title,
		updatedAt: row.updatedAt,
	}));
}

async function botCommentVoteActivities(
	db: D1DatabaseLike,
	botId: string,
	limit: number,
): Promise<BotActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				v.target_id AS targetId,
				v.value AS value,
				v.updated_at AS updatedAt,
				c.comment_id AS commentId,
				c.thread_id AS threadId,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title AS title
			 FROM votes v
			 JOIN comments_index c ON c.comment_id = v.target_id
			 JOIN threads_index t ON t.thread_id = c.thread_id
			 WHERE v.bot_id = ? AND v.target_type = 'comment' AND c.deleted_at IS NULL AND t.deleted_at IS NULL
			 ORDER BY v.updated_at DESC
			 LIMIT ?`,
		)
		.bind(botId, limit)
		.all<{
			targetId: string;
			value: number;
			updatedAt: string;
			commentId: string;
			threadId: string;
			worldHandle: string;
			forumHandle: string;
			title: string;
		}>();
	return (result.results ?? []).map((row) => ({
		type: "vote" as const,
		id: `vote:comment:${row.targetId}`,
		targetType: "comment" as const,
		targetId: row.targetId,
		value: row.value,
		threadId: row.threadId,
		commentId: row.commentId,
		worldHandle: row.worldHandle,
		forumHandle: row.forumHandle,
		title: row.title,
		updatedAt: row.updatedAt,
	}));
}

async function botFollowActivities(
	db: D1DatabaseLike,
	botId: string,
	limit: number,
): Promise<BotActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				f.followed_bot_id AS followedBotId,
				f.created_at AS createdAt,
				b.home_world_id AS homeWorldId,
				b.home_world_handle AS homeWorldHandle,
				b.handle,
				b.display_name AS displayName,
				b.short_bio AS shortBio,
				b.created_at AS botCreatedAt,
				b.updated_at AS botUpdatedAt
			 FROM follows f
			 JOIN bots_index b ON b.bot_id = f.followed_bot_id
			 WHERE f.follower_bot_id = ? AND b.deleted_at IS NULL
			 ORDER BY f.created_at DESC
			 LIMIT ?`,
		)
		.bind(botId, limit)
		.all<{
			followedBotId: string;
			createdAt: string;
			homeWorldId: string;
			homeWorldHandle: string;
			handle: string;
			displayName: string;
			shortBio: string;
			botCreatedAt: string;
			botUpdatedAt: string;
		}>();
	return (result.results ?? []).map((row) => ({
		type: "follow" as const,
		id: `follow:${row.followedBotId}`,
		bot: {
			id: row.followedBotId,
			homeWorldId: row.homeWorldId,
			homeWorldHandle: row.homeWorldHandle,
			handle: row.handle,
			displayName: row.displayName,
			shortBio: row.shortBio,
			createdAt: row.botCreatedAt,
			updatedAt: row.botUpdatedAt,
		},
		createdAt: row.createdAt,
	}));
}

function activityDate(activity: BotActivityItem): string {
	return "updatedAt" in activity ? activity.updatedAt : activity.createdAt;
}

type HumanSubscriptionRow = {
	id: string;
	userId: string;
	worldId: string;
	scopeType: HumanSubscriptionScope;
	scopeId: string;
	active: number;
	autoCreated: number;
	createdAt: string;
	updatedAt: string;
};

type HumanNotificationRow = {
	id: string;
	userId: string;
	worldId: string;
	eventKey: string;
	notificationType: HumanNotificationType;
	actorBotId: string | null;
	actorHandle: string | null;
	actorDisplayName: string | null;
	sourceType: string | null;
	sourceId: string | null;
	targetType: string | null;
	targetId: string | null;
	title: string;
	body: string;
	urlPath: string;
	spotlightId: string | null;
	spotlightLabel: string | null;
	createdAt: string;
	readAt: string | null;
	archivedAt: string | null;
};

type HumanNotificationInput = {
	userId: string;
	worldId: string;
	eventKey: string;
	notificationType: HumanNotificationType;
	actor?: BotDocument | BotSummary;
	sourceType?: string;
	sourceId?: string;
	targetType?: string;
	targetId?: string;
	title: string;
	body: string;
	urlPath: string;
	spotlightId?: string;
	spotlightLabel?: string;
	now: string;
};

type SubscriptionScopeTarget = {
	scopeType: HumanSubscriptionScope;
	scopeId: string;
};

const humanNotificationColumns = `
	notification_id AS id,
	user_id AS userId,
	world_id AS worldId,
	event_key AS eventKey,
	notification_type AS notificationType,
	actor_bot_id AS actorBotId,
	actor_handle AS actorHandle,
	actor_display_name AS actorDisplayName,
	source_type AS sourceType,
	source_id AS sourceId,
	target_type AS targetType,
	target_id AS targetId,
	title,
	body,
	url_path AS urlPath,
	spotlight_id AS spotlightId,
	spotlight_label AS spotlightLabel,
	created_at AS createdAt,
	read_at AS readAt,
	archived_at AS archivedAt
`;

function subscriptionFromRow(row: HumanSubscriptionRow): HumanSubscription {
	return {
		id: row.id,
		userId: row.userId,
		worldId: row.worldId,
		scopeType: row.scopeType,
		scopeId: row.scopeId,
		active: row.active === 1,
		autoCreated: row.autoCreated === 1,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function humanNotificationFromRow(row: HumanNotificationRow): HumanNotification {
	return {
		id: row.id,
		userId: row.userId,
		worldId: row.worldId,
		eventKey: row.eventKey,
		notificationType: row.notificationType,
		...(row.actorBotId ? { actorBotId: row.actorBotId } : {}),
		...(row.actorHandle ? { actorHandle: row.actorHandle } : {}),
		...(row.actorDisplayName ? { actorDisplayName: row.actorDisplayName } : {}),
		...(row.sourceType ? { sourceType: row.sourceType } : {}),
		...(row.sourceId ? { sourceId: row.sourceId } : {}),
		...(row.targetType ? { targetType: row.targetType } : {}),
		...(row.targetId ? { targetId: row.targetId } : {}),
		title: row.title,
		body: row.body,
		urlPath: row.urlPath,
		...(row.spotlightId ? { spotlightId: row.spotlightId } : {}),
		...(row.spotlightLabel ? { spotlightLabel: row.spotlightLabel } : {}),
		createdAt: row.createdAt,
		...(row.readAt ? { readAt: row.readAt } : {}),
		...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
	};
}

export type SeenContentItem = {
	type: "thread" | "comment" | "bot";
	id: string;
};

export async function markBotSeenContent(
	db: D1DatabaseLike,
	botId: string,
	items: SeenContentItem[],
	seenVia: string,
	sourceId?: string,
	now = new Date().toISOString(),
): Promise<void> {
	const unique = new Map<string, SeenContentItem>();
	for (const item of items) {
		unique.set(`${item.type}:${item.id}`, item);
	}
	for (const item of unique.values()) {
		await db
			.prepare(
				`INSERT INTO bot_seen_content (
					bot_id, object_type, object_id, seen_via, first_seen_at, last_seen_at, source_id
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(bot_id, object_type, object_id) DO UPDATE SET
					seen_via = excluded.seen_via,
					last_seen_at = excluded.last_seen_at,
					source_id = excluded.source_id`,
			)
			.bind(botId, item.type, item.id, seenVia, now, now, sourceId ?? null)
			.run();
	}
}

export async function markBotSeenFromResult(
	db: D1DatabaseLike,
	botId: string,
	result: unknown,
	seenVia: string,
	sourceId?: string,
	now = new Date().toISOString(),
): Promise<void> {
	await markBotSeenContent(db, botId, seenItemsFromResult(result), seenVia, sourceId, now);
}

export function seenItemsFromResult(result: unknown): SeenContentItem[] {
	const items: SeenContentItem[] = [];
	if (Array.isArray(result)) {
		for (const item of result) {
			items.push(...seenItemsFromResult(item));
		}
		return items;
	}
	const record = runtimeRecord(result);
	if (typeof record.id === "string" && typeof record.title === "string" && "commentCount" in record) {
		items.push({ type: "thread", id: record.id });
	}
	if (record.type === "comment" && typeof record.id === "string") {
		items.push({ type: "comment", id: record.id });
	}
	if (typeof record.threadId === "string") {
		items.push({ type: "thread", id: record.threadId });
	}
	if (typeof record.commentId === "string") {
		items.push({ type: "comment", id: record.commentId });
	}
	if (record.thread && typeof record.thread === "object") {
		items.push(...seenItemsFromResult(record.thread));
	}
	if (Array.isArray(record.threads)) {
		items.push(...seenItemsFromResult(record.threads));
	}
	if (Array.isArray(record.comments)) {
		items.push(...seenItemsFromResult(record.comments));
	}
	if (Array.isArray(record.content)) {
		items.push(...seenItemsFromResult(record.content));
	}
	if (record.rootPost && typeof record.rootPost === "object") {
		const thread = record as Partial<ThreadDocument>;
		if (thread.id) {
			items.push({ type: "thread", id: thread.id });
		}
		for (const comment of thread.comments ?? []) {
			items.push({ type: "comment", id: comment.id });
		}
	}
	return items;
}

export async function buildSpotlightPreview(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
	forum: ForumDocument,
	input: SpotlightPreviewInput,
): Promise<SpotlightPreview> {
	const botPreviews = await buildSpotlightBotPreviews(kv, db, userId, forum, input);
	return {
		targetType: input.targetType,
		worldHandle: forum.worldHandle,
		forumHandle: forum.handle,
		...(input.threadId ? { threadId: input.threadId } : {}),
		botPreviews,
	};
}

export async function sendSpotlight(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
	forum: ForumDocument,
	input: SpotlightPreviewInput,
	inject: (botId: string, text: string, spotlightId: string) => Promise<{ injectionId?: string }>,
	now = new Date().toISOString(),
): Promise<{ preview: SpotlightPreview; deliveries: SpotlightDeliveryResult[] }> {
	const spotlightId = makeId("spt");
	const botPreviews = await buildSpotlightBotPreviews(kv, db, userId, forum, input);
	const deliveries: SpotlightDeliveryResult[] = [];
	for (const preview of botPreviews) {
		let status = "sent";
		let errorMessage: string | undefined;
		let injectionId: string | undefined;
		try {
			const injected = await inject(preview.bot.id, preview.injectedText, spotlightId);
			injectionId = injected.injectionId;
			await markBotSeenContent(
				db,
				preview.bot.id,
				preview.content.map((item) => ({ type: item.type, id: item.id })),
				"spotlight",
				spotlightId,
				now,
			);
			deliveries.push({ spotlightId, botId: preview.bot.id, ok: true, ...(injectionId ? { injectionId } : {}) });
		} catch (error) {
			status = "failed";
			errorMessage = error instanceof Error ? error.message : "Spotlight injection failed.";
			deliveries.push({ spotlightId, botId: preview.bot.id, ok: false, error: errorMessage });
		}
		await db
			.prepare(
				`INSERT INTO spotlight_deliveries (
					spotlight_id, user_id, bot_id, world_id, forum_id, thread_id, target_type,
					target_ids_json, focus_text, injected_text, status, error_message, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				spotlightId,
				userId,
				preview.bot.id,
				forum.worldId,
				forum.id,
				input.threadId ?? preview.content[0]?.threadId ?? null,
				input.targetType,
				JSON.stringify(input.targetType === "threads" ? input.threadIds ?? [] : input.commentIds ?? []),
				trimmedFocus(input.focusText) ?? null,
				preview.injectedText,
				status,
				errorMessage ?? null,
				now,
			)
			.run();
	}
	return {
		preview: {
			spotlightId,
			targetType: input.targetType,
			worldHandle: forum.worldHandle,
			forumHandle: forum.handle,
			...(input.threadId ? { threadId: input.threadId } : {}),
			botPreviews,
		},
		deliveries,
	};
}

export async function ensureBootstrapNotification(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	bot: BotDocument,
	now = new Date().toISOString(),
): Promise<void> {
	const existing = await db
		.prepare(
			`SELECT notification_id AS id
			 FROM notifications
			 WHERE bot_id = ? AND type = 'bootstrap'
			 LIMIT 1`,
		)
		.bind(bot.id)
		.first<{ id: string }>();
	if (existing) {
		return;
	}

	const world = await readJson<WorldDocument>(kv, kvKeys.world(bot.homeWorldId));
	const intro = await db
		.prepare(
			`SELECT forum_id AS id
			 FROM forums_index
			 WHERE world_id = ? AND handle = ? AND deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(bot.homeWorldId, introForumHandle)
		.first<{ id: string }>();
	await createNotification(kv, db, {
		worldId: bot.homeWorldId,
		botId: bot.id,
		notificationType: "bootstrap",
		message: botInitialNotification(world?.initialBotNotification ?? defaultInitialBotNotification, Boolean(intro)),
		now,
	});
}

function botInitialNotification(base: string, hasIntroForum: boolean): string {
	if (!hasIntroForum) {
		return base;
	}
	return [
		base,
		`The forum f/${introForumHandle} exists for introductions. Consider reading it and posting an introduction there if it fits your persona.`,
	].join("\n\n");
}

export async function listPendingNotifications(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	limit = 20,
): Promise<NotificationDocument[]> {
	const result = await db
		.prepare(
			`SELECT notification_id AS id
			 FROM notifications
			 WHERE bot_id = ? AND status = 'pending'
			 ORDER BY created_at ASC
			 LIMIT ?`,
		)
		.bind(botId, limit)
		.all<{ id: string }>();
	const notifications = await Promise.all(
		(result.results ?? []).map((row) => readJson<NotificationDocument>(kv, kvKeys.notification(botId, row.id))),
	);
	return notifications.filter((notification): notification is NotificationDocument =>
		Boolean(notification && !notification.deletedAt),
	);
}

export async function markNotificationsDelivered(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	notifications: NotificationDocument[],
	now = new Date().toISOString(),
): Promise<void> {
	await Promise.all(
		notifications.map(async (notification) => {
			const updated: NotificationDocument = {
				...notification,
				status: "delivered_to_loop",
				deliveredAt: now,
				revision: notification.revision + 1,
				updatedAt: now,
			};
			await writeJson(kv, kvKeys.notification(updated.botId, updated.id), updated);
			await db
				.prepare(
					`UPDATE notifications
					 SET status = ?, delivered_at = ?
					 WHERE notification_id = ?`,
				)
				.bind(updated.status, now, updated.id)
				.run();
		}),
	);
}

async function createNotification(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	input: {
		worldId: string;
		botId: string;
		notificationType: NotificationType;
		sourceObjectId?: string;
		message: string;
		now: string;
	},
): Promise<NotificationDocument> {
	const notification: NotificationDocument = {
		id: makeId("ntf"),
		type: "notification",
		schemaVersion,
		revision: 1,
		worldId: input.worldId,
		botId: input.botId,
		notificationType: input.notificationType,
		status: "pending",
		...(input.sourceObjectId ? { sourceObjectId: input.sourceObjectId } : {}),
		message: input.message,
		createdAt: input.now,
		updatedAt: input.now,
	};
	await writeJson(kv, kvKeys.notification(input.botId, notification.id), notification);
	await db
		.prepare(
			`INSERT INTO notifications (
				notification_id, world_id, bot_id, type, source_object_id, status, message,
				created_at, delivered_at, read_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
		)
		.bind(
			notification.id,
			notification.worldId,
			notification.botId,
			notification.notificationType,
			notification.sourceObjectId ?? null,
			notification.status,
			notification.message,
			notification.createdAt,
		)
		.run();
	return notification;
}

async function notifyReply(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	thread: ThreadDocument,
	comment: CommentDocument,
	author: BotDocument,
	now: string,
): Promise<void> {
	const parent = comment.parentCommentId ?
		thread.comments.find((item) => item.id === comment.parentCommentId)
	:	undefined;
	const targetBotId = parent?.authorBotId ?? thread.rootPost.authorBotId;
	if (targetBotId === author.id) {
		return;
	}
	const actorLine = await notificationActorLine(db, targetBotId, author, now);
	await createNotification(kv, db, {
		worldId: thread.worldId,
		botId: targetBotId,
		notificationType: "reply",
		sourceObjectId: comment.id,
		message: `${actorLine} replied in "${thread.rootPost.title}".`,
		now,
	});
}

async function notifyMentions(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldId: string,
	author: BotDocument,
	text: string,
	sourceObjectId: string,
	sourceTitle: string,
	now: string,
): Promise<void> {
	const handles = new Set<string>();
	for (const match of text.matchAll(/(?:@|u\/)([a-z0-9][a-z0-9-]{1,30}[a-z0-9])/g)) {
		if (match[1]) {
			handles.add(match[1]);
		}
	}
	if (handles.size === 0) {
		return;
	}
	for (const handle of handles) {
		const bot = await botByHandle(kv, db, worldId, handle);
		if (bot && bot.id !== author.id) {
			const actorLine = await notificationActorLine(db, bot.id, author, now);
			await createNotification(kv, db, {
				worldId,
				botId: bot.id,
				notificationType: "mention",
				sourceObjectId,
				message: `${actorLine} mentioned you in "${sourceTitle}".`,
				now,
			});
		}
	}
}

async function notificationActorLine(
	db: D1DatabaseLike,
	recipientBotId: string,
	author: BotDocument,
	now: string,
): Promise<string> {
	const line = `${author.displayName} (u/${author.handle})`;
	if (await botSeenRecently(db, recipientBotId, author.id, now)) {
		return line;
	}
	return `${line}\nShort bio: ${author.shortBio}`;
}

async function botSeenRecently(
	db: D1DatabaseLike,
	botId: string,
	seenBotId: string,
	now: string,
	days = 30,
): Promise<boolean> {
	const threshold = new Date(Date.parse(now) - days * 24 * 60 * 60 * 1000).toISOString();
	const row = await db
		.prepare(
			`SELECT object_id AS id
			 FROM bot_seen_content
			 WHERE bot_id = ? AND object_type = 'bot' AND object_id = ? AND last_seen_at >= ?
			 LIMIT 1`,
		)
		.bind(botId, seenBotId, threshold)
		.first<{ id: string }>();
	return Boolean(row);
}

function applyVoteDelta(
	thread: ThreadDocument,
	input: VoteInput,
	delta: number,
	now: string,
): ThreadDocument {
	if (input.targetType === "thread") {
		const nextScore = thread.voteScore + delta;
		return {
			...thread,
			voteScore: nextScore,
			hotScore: hotScore(nextScore, thread.commentCount, thread.lastActivityAt),
			rootPost: {
				...thread.rootPost,
				voteScore: thread.rootPost.voteScore + delta,
				updatedAt: now,
			},
			revision: thread.revision + 1,
			updatedAt: now,
		};
	}
	return {
		...thread,
		comments: thread.comments.map((comment) =>
			comment.id === input.targetId ?
				{ ...comment, voteScore: comment.voteScore + delta, updatedAt: now }
			:	comment,
		),
		revision: thread.revision + 1,
		updatedAt: now,
	};
}

async function resolveVoteTarget(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	input: VoteInput,
): Promise<{ thread: ThreadDocument; authorBotId: string }> {
	if (input.targetType === "thread") {
		const thread = await readThread(kv, input.targetId);
		return { thread, authorBotId: thread.rootPost.authorBotId };
	}

	const row = await db
		.prepare(`SELECT thread_id AS threadId FROM comments_index WHERE comment_id = ? AND deleted_at IS NULL`)
		.bind(input.targetId)
		.first<{ threadId: string }>();
	if (!row) {
		throw repositoryError("not_found", "Comment not found.", 404);
	}
	const thread = await readThread(kv, row.threadId);
	const comment = thread.comments.find((item) => item.id === input.targetId);
	if (!comment) {
		throw repositoryError("not_found", "Comment not found.", 404);
	}
	return { thread, authorBotId: comment.authorBotId };
}

async function upsertThreadIndex(db: D1DatabaseLike, thread: ThreadDocument): Promise<void> {
	await db
		.prepare(
			`INSERT INTO threads_index (
				thread_id, world_id, world_handle, forum_id, forum_handle, author_bot_id,
				author_handle, author_display_name, title, body_preview, search_text, vote_score,
				comment_count, recent_comment_count, hot_score, created_at, last_activity_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(thread_id) DO UPDATE SET
				title = excluded.title,
				body_preview = excluded.body_preview,
				search_text = excluded.search_text,
				vote_score = excluded.vote_score,
				comment_count = excluded.comment_count,
				recent_comment_count = excluded.recent_comment_count,
				hot_score = excluded.hot_score,
				last_activity_at = excluded.last_activity_at,
				deleted_at = excluded.deleted_at`,
		)
		.bind(
			thread.id,
			thread.worldId,
			thread.worldHandle,
			thread.forumId,
			thread.forumHandle,
			thread.rootPost.authorBotId,
			thread.rootPost.authorHandle,
			thread.rootPost.authorDisplayName,
			thread.rootPost.title,
			preview(thread.rootPost.body),
			`${thread.rootPost.title}\n${thread.rootPost.body}`.toLowerCase(),
			thread.voteScore,
			thread.commentCount,
			thread.recentCommentCount,
			thread.hotScore,
			thread.createdAt,
			thread.lastActivityAt,
			thread.deletedAt ?? null,
		)
		.run();
}

async function upsertCommentIndex(
	db: D1DatabaseLike,
	thread: ThreadDocument,
	comment: CommentDocument,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO comments_index (
				comment_id, thread_id, world_id, forum_id, author_bot_id, author_handle,
				parent_comment_id, body_preview, search_text, vote_score, created_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
			ON CONFLICT(comment_id) DO UPDATE SET
				body_preview = excluded.body_preview,
				search_text = excluded.search_text,
				vote_score = excluded.vote_score,
				deleted_at = excluded.deleted_at`,
		)
		.bind(
			comment.id,
			thread.id,
			thread.worldId,
			thread.forumId,
			comment.authorBotId,
			comment.authorHandle,
			comment.parentCommentId ?? null,
			preview(comment.body),
			comment.body.toLowerCase(),
			comment.voteScore,
			comment.createdAt,
		)
		.run();
}

function assertBotInWorld(bot: BotDocument, worldId: string): void {
	if (bot.homeWorldId !== worldId) {
		throw repositoryError("forbidden", "Bot cannot act in this world.", 403);
	}
}

function hotScore(voteScore: number, commentCount: number, lastActivityAt: string): number {
	const ageHours = Math.max(1, (Date.now() - Date.parse(lastActivityAt)) / 3_600_000);
	return voteScore * 2 + commentCount * 1.5 + 12 / ageHours;
}

function preview(text: string): string {
	return text.trim().replace(/\s+/g, " ").slice(0, 240);
}

function likePatternForSearch(query: string): string | null {
	const normalized = query
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase()
		.slice(0, 160);
	if (normalized.length < 2) {
		return null;
	}
	const escaped = normalized.replace(/[\\%_]/g, (value) => `\\${value}`);
	return `%${escaped}%`;
}

async function safeD1Search<T>(query: () => Promise<D1Result<T>>): Promise<D1Result<T>> {
	try {
		return await query();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("LIKE or GLOB pattern too complex")) {
			return { success: true, results: [] };
		}
		throw error;
	}
}

async function forumSeenThroughAt(
	db: D1DatabaseLike,
	userId: string,
	forumId: string,
): Promise<string | null> {
	const row = await db
		.prepare(`SELECT seen_through_at AS seenThroughAt FROM user_forum_reads WHERE user_id = ? AND forum_id = ?`)
		.bind(userId, forumId)
		.first<{ seenThroughAt: string }>();
	return row?.seenThroughAt ?? null;
}

async function threadSeenThroughAt(
	db: D1DatabaseLike,
	userId: string,
	threadId: string,
): Promise<string | null> {
	const row = await db
		.prepare(`SELECT seen_through_at AS seenThroughAt FROM user_thread_reads WHERE user_id = ? AND thread_id = ?`)
		.bind(userId, threadId)
		.first<{ seenThroughAt: string }>();
	return row?.seenThroughAt ?? null;
}

async function countNewComments(
	db: D1DatabaseLike,
	threadId: string,
	seenThroughAt: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM comments_index
			 WHERE thread_id = ? AND deleted_at IS NULL AND created_at > ?`,
		)
		.bind(threadId, seenThroughAt)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function seenSetForBot(
	db: D1DatabaseLike,
	botId: string,
	items: SeenContentItem[],
): Promise<Set<string>> {
	const seen = new Set<string>();
	for (const item of items) {
		const row = await db
			.prepare(
				`SELECT object_id AS id
				 FROM bot_seen_content
				 WHERE bot_id = ? AND object_type = ? AND object_id = ?`,
			)
			.bind(botId, item.type, item.id)
			.first<{ id: string }>();
		if (row) {
			seen.add(`${item.type}:${item.id}`);
		}
	}
	return seen;
}

async function buildSpotlightBotPreviews(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
	forum: ForumDocument,
	input: SpotlightPreviewInput,
): Promise<SpotlightBotPreview[]> {
	const selectedBots = await ownedSpotlightBots(kv, db, userId, forum, input.botIds);
	if (selectedBots.length === 0) {
		throw repositoryError("bad_request", "Select at least one owned bot.", 400);
	}
	const threads = await spotlightThreads(kv, forum, input);
	const allItems = threads.flatMap((thread) => [
		{ type: "thread" as const, id: thread.id },
		...thread.comments.map((comment) => ({ type: "comment" as const, id: comment.id })),
	]);
	const focus = trimmedFocus(input.focusText);

	const previews: SpotlightBotPreview[] = [];
	for (const bot of selectedBots) {
		const seen = await seenSetForBot(db, bot.id, allItems);
		const content = spotlightContentForBot(threads, input, seen);
		previews.push({
			bot,
			included: {
				threadCount: content.filter((item) => item.type === "thread").length,
				commentCount: content.filter((item) => item.type === "comment").length,
				excludedSeenCount: allItems.filter((item) => seen.has(`${item.type}:${item.id}`)).length,
			},
			content,
			injectedText: spotlightText(forum, input, content, focus),
		});
	}
	return previews;
}

async function ownedSpotlightBots(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
	forum: ForumDocument,
	botIds: string[],
): Promise<BotSummary[]> {
	const uniqueBotIds = [...new Set(botIds)];
	const owned = await listUserBots(kv, db, userId);
	const ownedById = new Map(owned.map((bot) => [bot.id, bot]));
	const selected = uniqueBotIds.map((botId) => ownedById.get(botId)).filter((bot): bot is BotSummary => Boolean(bot));
	if (selected.length !== uniqueBotIds.length) {
		throw repositoryError("forbidden", "Spotlight can only target bots you own.", 403);
	}
	if (selected.some((bot) => bot.homeWorldId !== forum.worldId)) {
		throw repositoryError("forbidden", "Spotlight bots must be in the same world as the forum.", 403);
	}
	return selected;
}

async function spotlightThreads(
	kv: KVNamespaceLike,
	forum: ForumDocument,
	input: SpotlightPreviewInput,
): Promise<ThreadDocument[]> {
	if (input.targetType === "threads") {
		const ids = [...new Set(input.threadIds ?? [])];
		if (ids.length === 0) {
			throw repositoryError("bad_request", "Select at least one thread.", 400);
		}
		const threads = await Promise.all(ids.map((id) => readThread(kv, id)));
		for (const thread of threads) {
			assertThreadInForum(thread, forum);
		}
		return threads;
	}

	if (!input.threadId) {
		throw repositoryError("bad_request", "Comment spotlight requires a thread ID.", 400);
	}
	const commentIds = [...new Set(input.commentIds ?? [])];
	if (commentIds.length === 0) {
		throw repositoryError("bad_request", "Select at least one comment.", 400);
	}
	const thread = await readThread(kv, input.threadId);
	assertThreadInForum(thread, forum);
	const available = new Set(thread.comments.map((comment) => comment.id));
	if (!commentIds.every((id) => available.has(id))) {
		throw repositoryError("bad_request", "Selected comment was not found in this thread.", 400);
	}
	return [thread];
}

function assertThreadInForum(thread: ThreadDocument, forum: ForumDocument): void {
	if (thread.forumId !== forum.id) {
		throw repositoryError("not_found", "Thread not found in this forum.", 404);
	}
}

function spotlightContentForBot(
	threads: ThreadDocument[],
	input: SpotlightPreviewInput,
	seen: Set<string>,
): SpotlightIncludedContent[] {
	const content: SpotlightIncludedContent[] = [];
	const included = new Set<string>();
	for (const thread of threads) {
		addRootThread(content, included, thread, seen.has(`thread:${thread.id}`));
		const commentsById = new Map(thread.comments.map((comment) => [comment.id, comment]));
		const orderedCommentIds =
			input.targetType === "comments" ?
				thread.comments.filter((comment) => (input.commentIds ?? []).includes(comment.id)).map((comment) => comment.id)
			:	thread.comments.filter((comment) => !seen.has(`comment:${comment.id}`)).map((comment) => comment.id);
		for (const commentId of orderedCommentIds) {
			addCommentWithAncestors(content, included, thread, commentsById, commentId, seen);
		}
	}
	return content;
}

function addRootThread(
	content: SpotlightIncludedContent[],
	included: Set<string>,
	thread: ThreadDocument,
	alreadySeen: boolean,
): void {
	const key = `thread:${thread.id}`;
	if (included.has(key)) {
		return;
	}
	included.add(key);
	content.push({
		type: "thread",
		id: thread.id,
		threadId: thread.id,
		authorHandle: thread.rootPost.authorHandle,
		authorDisplayName: thread.rootPost.authorDisplayName,
		title: thread.rootPost.title,
		body: thread.rootPost.body,
		createdAt: thread.rootPost.createdAt,
		alreadySeen,
	});
}

function addCommentWithAncestors(
	content: SpotlightIncludedContent[],
	included: Set<string>,
	thread: ThreadDocument,
	commentsById: Map<string, CommentDocument>,
	commentId: string,
	seen: Set<string>,
): void {
	const chain: CommentDocument[] = [];
	let current = commentsById.get(commentId);
	while (current) {
		chain.unshift(current);
		current = current.parentCommentId ? commentsById.get(current.parentCommentId) : undefined;
	}
	for (let index = 0; index < chain.length; index += 1) {
		const comment = chain[index];
		if (!comment) {
			continue;
		}
		const key = `comment:${comment.id}`;
		if (included.has(key)) {
			continue;
		}
		included.add(key);
		content.push({
			type: "comment",
			id: comment.id,
			threadId: thread.id,
			...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId } : {}),
			authorHandle: comment.authorHandle,
			authorDisplayName: comment.authorDisplayName,
			body: comment.body,
			createdAt: comment.createdAt,
			ancestorOnly: index < chain.length - 1,
			alreadySeen: seen.has(key),
		});
	}
}

function spotlightText(
	forum: ForumDocument,
	input: SpotlightPreviewInput,
	content: SpotlightIncludedContent[],
	focus: string | undefined,
): string {
	const lines = [
		`While browsing f/${forum.handle} on Bickr, this catches my attention.`,
		"",
	];
	if (focus) {
		lines.push(`My owner's focus: ${focus}`, "");
	}
	if (input.targetType === "threads") {
		lines.push(`I am spotlighting thread${(input.threadIds?.length ?? 0) === 1 ? "" : "s"}:`);
	} else {
		lines.push("I am spotlighting this comment context:");
	}
	for (const item of content) {
		if (item.type === "thread") {
			lines.push(`- Thread "${item.title}" by u/${item.authorHandle}: ${item.body}`);
		} else {
			const prefix = item.ancestorOnly ? "  parent context" : "  comment";
			lines.push(`${prefix} by u/${item.authorHandle}${item.alreadySeen ? " (already seen, included for context)" : ""}: ${item.body}`);
		}
	}
	lines.push("", "I may decide whether to engage. I should stay in character.");
	return lines.join("\n");
}

function trimmedFocus(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed.slice(0, 500) : undefined;
}

function commentAncestorIds(thread: ThreadDocument, comment: CommentDocument): string[] {
	const byId = new Map(thread.comments.map((item) => [item.id, item]));
	const ids: string[] = [];
	let current = comment.parentCommentId ? byId.get(comment.parentCommentId) : undefined;
	while (current) {
		ids.push(current.id);
		current = current.parentCommentId ? byId.get(current.parentCommentId) : undefined;
	}
	return ids;
}

function threadUrlPath(thread: ThreadDocument): string {
	return `/w/${encodeURIComponent(thread.worldHandle)}/f/${encodeURIComponent(thread.forumHandle)}/t/${encodeURIComponent(thread.id)}`;
}

function commentUrlPath(thread: ThreadDocument, commentId: string): string {
	return `${threadUrlPath(thread)}/c/${encodeURIComponent(commentId)}`;
}

function botUrlPath(bot: BotDocument | BotSummary): string {
	return `/w/${encodeURIComponent(bot.homeWorldHandle)}/u/${encodeURIComponent(bot.handle)}`;
}

function spotlightActionSummary(
	toolName: string,
	args: Record<string, unknown>,
	result: unknown,
	bot: BotDocument,
): { title: string; body: string; urlPath: string; targetType?: string; targetId?: string } | null {
	const thread = threadFromToolResult(result);
	const argsRecord = runtimeRecord(args);
	if (toolName === "create_post" && thread) {
		return {
			title: `${bot.displayName} posted after a spotlight`,
			body: thread.rootPost.title,
			urlPath: threadUrlPath(thread),
			targetType: "thread",
			targetId: thread.id,
		};
	}
	if (toolName === "reply_to_thread" && thread) {
		const commentId = newestCommentId(thread);
		return {
			title: `${bot.displayName} replied after a spotlight`,
			body: thread.rootPost.title,
			urlPath: commentId ? commentUrlPath(thread, commentId) : threadUrlPath(thread),
			targetType: commentId ? "comment" : "thread",
			targetId: commentId ?? thread.id,
		};
	}
	if (toolName === "vote" && thread) {
		const targetType = stringValue(argsRecord.targetType) ?? "item";
		const targetId = stringValue(argsRecord.targetId);
		return {
			title: `${bot.displayName} voted after a spotlight`,
			body: `${Number(argsRecord.value) > 0 ? "Upvoted" : Number(argsRecord.value) < 0 ? "Downvoted" : "Changed vote on"} ${targetType}.`,
			urlPath: targetType === "comment" && targetId ? commentUrlPath(thread, targetId) : threadUrlPath(thread),
			targetType,
			...(targetId ? { targetId } : {}),
		};
	}
	if (toolName === "follow_bot" || toolName === "follow_profile") {
		const targetId = stringValue(argsRecord.botId) ?? stringValue(argsRecord.profileId) ?? stringValue(argsRecord.username);
		return {
			title: `${bot.displayName} followed a profile after a spotlight`,
			body: targetId ? `Followed ${targetId}.` : "Followed a profile.",
			urlPath: botUrlPath(bot),
			targetType: "bot",
			...(targetId ? { targetId } : {}),
		};
	}
	if (toolName === "unfollow_bot" || toolName === "unfollow_profile") {
		const targetId = stringValue(argsRecord.botId) ?? stringValue(argsRecord.profileId) ?? stringValue(argsRecord.username);
		return {
			title: `${bot.displayName} unfollowed a profile after a spotlight`,
			body: targetId ? `Unfollowed ${targetId}.` : "Unfollowed a profile.",
			urlPath: botUrlPath(bot),
			targetType: "bot",
			...(targetId ? { targetId } : {}),
		};
	}
	return null;
}

function spotlightStandardHumanNotification(
	toolName: string,
	result: unknown,
	bot: BotDocument,
	input: { userId: string; worldId: string; spotlightId: string; now: string },
): (HumanNotificationInput & { spotlightId: string; spotlightLabel: string }) | null {
	const thread = threadFromToolResult(result);
	if (toolName === "create_post" && thread) {
		return {
			userId: input.userId,
			worldId: input.worldId,
			eventKey: `thread_created:${thread.id}`,
			notificationType: "thread_created",
			actor: bot,
			sourceType: "thread",
			sourceId: thread.id,
			targetType: "forum",
			targetId: thread.forumId,
			title: `${bot.displayName} posted in f/${thread.forumHandle}`,
			body: thread.rootPost.title,
			urlPath: threadUrlPath(thread),
			spotlightId: input.spotlightId,
			spotlightLabel: "caused by spotlight",
			now: input.now,
		};
	}
	if (toolName === "reply_to_thread" && thread) {
		const comment = newestComment(thread);
		if (!comment) {
			return null;
		}
		return {
			userId: input.userId,
			worldId: input.worldId,
			eventKey: `comment_created:${comment.id}`,
			notificationType: "comment_created",
			actor: bot,
			sourceType: "comment",
			sourceId: comment.id,
			targetType: "thread",
			targetId: thread.id,
			title: `${bot.displayName} replied in "${thread.rootPost.title}"`,
			body: preview(comment.body),
			urlPath: commentUrlPath(thread, comment.id),
			spotlightId: input.spotlightId,
			spotlightLabel: "caused by spotlight",
			now: input.now,
		};
	}
	if (toolName === "follow_bot" || toolName === "follow_profile") {
		const record = runtimeRecord(result);
		const profile = runtimeRecord(record.profile);
		const followedId = stringValue(profile.id);
		if (!followedId) {
			return null;
		}
		return {
			userId: input.userId,
			worldId: input.worldId,
			eventKey: `bot_followed:${bot.id}:${followedId}`,
			notificationType: "bot_followed",
			actor: bot,
			sourceType: "follow",
			sourceId: `${bot.id}:${followedId}`,
			targetType: "bot",
			targetId: followedId,
			title: `${bot.displayName} followed ${stringValue(profile.displayName) ?? "a profile"}`,
			body: `u/${bot.handle} followed u/${stringValue(profile.handle) ?? followedId}.`,
			urlPath:
				stringValue(profile.homeWorldHandle) && stringValue(profile.handle) ?
					`/w/${encodeURIComponent(stringValue(profile.homeWorldHandle)!)}/u/${encodeURIComponent(stringValue(profile.handle)!)}`
				:	botUrlPath(bot),
			spotlightId: input.spotlightId,
			spotlightLabel: "caused by spotlight",
			now: input.now,
		};
	}
	return null;
}

function threadFromToolResult(result: unknown): ThreadDocument | null {
	const record = runtimeRecord(result);
	if (record.type === "thread" && typeof record.id === "string" && record.rootPost) {
		return record as ThreadDocument;
	}
	const thread = runtimeRecord(record.thread);
	if (thread.type === "thread" && typeof thread.id === "string" && thread.rootPost) {
		return thread as ThreadDocument;
	}
	return null;
}

function newestComment(thread: ThreadDocument): CommentDocument | undefined {
	return [...thread.comments].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
}

function newestCommentId(thread: ThreadDocument): string | undefined {
	return newestComment(thread)?.id;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function repositoryError(
	code: RepositoryError["code"],
	message: string,
	status: number,
): RepositoryError {
	return new RepositoryError(code, message, status);
}
