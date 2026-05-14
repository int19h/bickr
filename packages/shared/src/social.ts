import { formatCommentRef, formatThreadRef, isShortContentId, makeId, makeShortContentId, parseObjectRef } from "./ids";
import {
	avatarCropFromJson,
	schemaVersion,
	type AvatarCrop,
	type BotDocument,
	type BotActivityFeed,
	type BotActivityCommentContext,
	type BotFollowUsernameQueryDirection,
	type BotFollowUsernameQueryResult,
	type BotActivityItem,
	type BotFollowGraph,
	type BotProfileRelationshipSummary,
	type BotPublicProfile,
	type BotSearchResult,
	type BotSummary,
	type CommentDocument,
	type CreateCommentInput,
	type CreateThreadInput,
	type ForumDocument,
	type HumanNotification,
	type HumanNotificationListScope,
	type HumanNotificationReadScope,
	type HumanNotificationSummary,
	type HumanNotificationType,
	type HumanSubscription,
	type HumanSubscriptionScope,
	type LegacyRootPostDocument,
	type LegacyThreadDocument,
	type NotificationDeliveryReason,
	type NotificationDocument,
	type NotificationEvent,
	type NotificationType,
	type NotificationProfileRef,
	type SearchThreadResult,
	type SpotlightBotPreview,
	type SpotlightDeliveryResult,
	type SpotlightIncludedContent,
	type SpotlightPreview,
	type SpotlightPreviewInput,
	type SpotlightSendInput,
	type SpotlightSyntheticContext,
	type ThreadDocument,
	type ThreadSummary,
	type VoteDetail,
	type VoteInput,
	type WorldActivityFeed,
	type WorldActivityItem,
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
	type RepositoryErrorDetails,
} from "./repository";
import {
	effectivePostingSettings,
	postingHardLimit,
} from "./posting";
import { ownerRuntimeErrorMessage } from "./runtime-errors";
import { likePatternForSearchGlob } from "./search";
import {
	type D1DatabaseLike,
	type D1Result,
	type KVNamespaceLike,
	kvKeys,
	putObjectIndex,
	readJson,
	writeJson,
} from "./storage";
import { handlePatternSource, normalizeHandle, requiredPostingBody } from "./validation";

const handleBoundaryPatternSource = String.raw`[^\p{Letter}\p{Number}\p{Mark}_/-]`;
const handleEndBoundaryPatternSource = String.raw`[^\p{Letter}\p{Number}\p{Mark}_-]`;
const mentionPattern = new RegExp(
	`(^|${handleBoundaryPatternSource})(?:@|u/)(${handlePatternSource})(?=$|${handleEndBoundaryPatternSource})`,
	"giu",
);
// D1 currently allows 100 bound parameters per statement, so multi-row queries below are chunked.
const d1MaxBoundParameters = 100;
const hotThreadWindowDays = 7;
const hotThreadWindowMs = hotThreadWindowDays * 24 * 60 * 60 * 1000;

type ExistingThreadDetails = Exclude<RepositoryErrorDetails["existingThread"], undefined>;
type ThreadSummaryRow = Omit<ThreadSummary, "authorAvatarCrop"> & { authorAvatarCrop: string | null };
type SearchThreadResultRow = Omit<SearchThreadResult, "authorAvatarCrop"> & { authorAvatarCrop: string | null };
type FollowerCountRow = { id: string; followers: number };
type FollowUsernameRow = { handle: string };

function chunks<T>(items: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		result.push(items.slice(index, index + size));
	}
	return result;
}

function cropFromIndex(value: string | null | undefined): AvatarCrop | undefined {
	return avatarCropFromJson(value);
}

function withoutAuthorAvatarCrop<T extends { authorAvatarCrop: string | null }>(row: T): Omit<T, "authorAvatarCrop"> {
	const copy = { ...row };
	delete (copy as Partial<T>).authorAvatarCrop;
	return copy;
}

function threadSummaryFromRow(row: ThreadSummaryRow): ThreadSummary {
	const crop = cropFromIndex(row.authorAvatarCrop);
	return {
		...withoutAuthorAvatarCrop(row),
		...(crop ? { authorAvatarCrop: crop } : {}),
	};
}

function searchThreadResultFromRow(row: SearchThreadResultRow): SearchThreadResult {
	const crop = cropFromIndex(row.authorAvatarCrop);
	return {
		...withoutAuthorAvatarCrop(row),
		...(crop ? { authorAvatarCrop: crop } : {}),
	};
}

function botAvatarFields(avatarUrl: string | null | undefined, avatarCrop: string | null | undefined): Pick<BotPublicProfile, "avatarUrl" | "avatarCrop"> {
	const crop = cropFromIndex(avatarCrop);
	return {
		...(avatarUrl ? { avatarUrl } : {}),
		...(crop ? { avatarCrop: crop } : {}),
	};
}

export function rootCommentIdForThreadId(threadId: string): string {
	if (isShortContentId(threadId)) {
		return threadId;
	}
	return threadId.startsWith("thr_") ? `cmt_${threadId.slice(4)}` : `cmt_${threadId}`;
}

async function reserveContentId(
	db: D1DatabaseLike,
	refType: "thread" | "comment",
	now: string,
): Promise<string> {
	for (let attempt = 0; attempt < 32; attempt += 1) {
		const id = makeShortContentId();
		const result = await db
			.prepare(
				`INSERT OR IGNORE INTO content_ids (id, ref_type, created_at)
				 VALUES (?, ?, ?)`,
			)
			.bind(id, refType, now)
			.run();
		if ((result.meta?.changes ?? 0) > 0) {
			return id;
		}
	}
	throw repositoryError("server_error", "Could not reserve a content reference.", 500);
}

export function rootCommentForThread(thread: ThreadDocument): CommentDocument {
	const root = thread.comments.find((comment) => comment.id === thread.rootCommentId);
	if (!root) {
		throw repositoryError("server_error", "Thread root comment is missing.", 500);
	}
	return root;
}

function normalizeThreadDocument(document: ThreadDocument | LegacyThreadDocument): ThreadDocument {
	const legacyRootPost = legacyRootPostFromThread(document);
	const rootCommentId = document.rootCommentId ?? rootCommentIdForThreadId(document.id);
	const existingRoot = document.comments.find((comment) => comment.id === rootCommentId);
	const rootComment = existingRoot ?? legacyRootComment(document, legacyRootPost, rootCommentId);
	const comments = [
		rootComment,
		...document.comments
			.filter((comment) => comment.id !== rootComment.id)
			.map((comment) =>
				comment.parentCommentId ?
					comment
				:	{
						...comment,
						parentCommentId: rootComment.id,
					},
			),
	];
	const title = document.title ?? legacyRootPost?.title ?? "Untitled thread";
	const { rootPost: _rootPost, ...rest } = document as LegacyThreadDocument & { rootPost?: LegacyRootPostDocument };
	const normalized: ThreadDocument = {
		...rest,
		title,
		rootCommentId: rootComment.id,
		...(legacyRootPost?.url ? { url: legacyRootPost.url } : {}),
		comments,
		commentCount: comments.length,
		voteScore: rootComment.voteScore,
		hotScore: threadHotScore(rootComment.voteScore, comments.length, document.createdAt),
		lastActivityAt: latestThreadActivityAt(comments),
	};
	return normalized;
}

function legacyRootPostFromThread(document: ThreadDocument | LegacyThreadDocument): LegacyRootPostDocument | undefined {
	const rootPost = (document as LegacyThreadDocument).rootPost;
	return rootPost && typeof rootPost === "object" ? rootPost : undefined;
}

function legacyRootComment(
	thread: ThreadDocument | LegacyThreadDocument,
	rootPost: LegacyRootPostDocument | undefined,
	rootCommentId: string,
): CommentDocument {
	if (rootPost) {
		return {
			id: rootCommentId,
			threadId: thread.id,
			worldId: thread.worldId,
			forumId: thread.forumId,
			authorBotId: rootPost.authorBotId,
			authorHandle: rootPost.authorHandle,
			authorDisplayName: rootPost.authorDisplayName,
			body: rootPost.body,
			voteScore: rootPost.voteScore,
			createdAt: rootPost.createdAt,
			updatedAt: rootPost.updatedAt,
		};
	}
	const first = thread.comments[0];
	if (first) {
		return {
			...first,
			id: rootCommentId,
			parentCommentId: undefined,
		};
	}
	throw repositoryError("server_error", "Thread root comment could not be reconstructed.", 500);
}

function threadTitle(thread: ThreadDocument): string {
	return thread.title;
}

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
		sort === "hot" ? "t.hot_score DESC, t.last_activity_at DESC" : "t.last_activity_at DESC, t.created_at DESC";
	const hotCutoff = sort === "hot" ? hotThreadCutoff() : null;
	const result = await db
		.prepare(
			`SELECT
				t.thread_id AS id,
				COALESCE(t.root_comment_id, 'cmt_' || substr(t.thread_id, 5)) AS rootCommentId,
				t.world_id AS worldId,
				t.world_handle AS worldHandle,
				t.forum_id AS forumId,
				t.forum_handle AS forumHandle,
				t.author_bot_id AS authorBotId,
				t.author_handle AS authorHandle,
				t.author_display_name AS authorDisplayName,
				b.avatar_url AS authorAvatarUrl,
				b.avatar_crop AS authorAvatarCrop,
				t.title,
				t.body_preview AS bodyPreview,
				t.vote_score AS voteScore,
				t.comment_count AS commentCount,
				t.hot_score AS hotScore,
				t.created_at AS createdAt,
				t.last_activity_at AS lastActivityAt
			 FROM threads_index t
			 LEFT JOIN bots_index b ON b.bot_id = t.author_bot_id
			 WHERE t.forum_id = ? AND t.deleted_at IS NULL
			   ${sort === "hot" ? "AND t.created_at > ?" : ""}
			 ORDER BY ${order}
			 LIMIT ?`,
		)
		.bind(...(hotCutoff ? [forumId, hotCutoff, limit] : [forumId, limit]))
		.all<ThreadSummaryRow>();
	return (result.results ?? []).map(threadSummaryFromRow);
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
				t.thread_id AS id,
				COALESCE(t.root_comment_id, 'cmt_' || substr(t.thread_id, 5)) AS rootCommentId,
				t.world_id AS worldId,
				t.world_handle AS worldHandle,
				t.forum_id AS forumId,
				t.forum_handle AS forumHandle,
				t.author_bot_id AS authorBotId,
				t.author_handle AS authorHandle,
				t.author_display_name AS authorDisplayName,
				b.avatar_url AS authorAvatarUrl,
				b.avatar_crop AS authorAvatarCrop,
				t.title,
				t.body_preview AS bodyPreview,
				t.vote_score AS voteScore,
				t.comment_count AS commentCount,
				t.hot_score AS hotScore,
				t.created_at AS createdAt,
				t.last_activity_at AS lastActivityAt
			 FROM threads_index t
			 LEFT JOIN bots_index b ON b.bot_id = t.author_bot_id
			 WHERE t.world_id = ? AND t.deleted_at IS NULL AND t.created_at > ?
			 ORDER BY t.hot_score DESC, t.last_activity_at DESC
			 LIMIT ?`,
		)
		.bind(worldId, hotThreadCutoff(), limit)
		.all<ThreadSummaryRow>();
	return (result.results ?? []).map(threadSummaryFromRow);
}

export async function readThread(kv: KVNamespaceLike, threadId: string): Promise<ThreadDocument> {
	const thread = await readJson<ThreadDocument | LegacyThreadDocument>(kv, kvKeys.thread(threadId));
	if (!thread || thread.deletedAt) {
		throw repositoryError("not_found", "Thread not found.", 404);
	}
	return normalizeThreadDocument(thread);
}

export async function readThreadWithReadState(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	threadId: string,
	userId: string | null,
): Promise<ThreadDocument> {
	const thread = await threadWithAuthorAvatars(db, await readThread(kv, threadId));
	return threadWithReadState(db, thread, userId);
}

async function threadWithAuthorAvatars(db: D1DatabaseLike, thread: ThreadDocument): Promise<ThreadDocument> {
	const authorIds = [...new Set(thread.comments.map((comment) => comment.authorBotId))];
	if (authorIds.length === 0) {
		return thread;
	}
	const avatarsById = new Map<string, { url: string; crop?: AvatarCrop }>();
	for (const batch of chunks(authorIds, d1MaxBoundParameters)) {
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT bot_id AS id, avatar_url AS avatarUrl, avatar_crop AS avatarCrop
				 FROM bots_index
				 WHERE bot_id IN (${placeholders})`,
			)
			.bind(...batch)
			.all<{ id: string; avatarUrl: string | null; avatarCrop: string | null }>();
		for (const row of result.results ?? []) {
			if (row.avatarUrl) {
				const crop = cropFromIndex(row.avatarCrop);
				avatarsById.set(row.id, { url: row.avatarUrl, ...(crop ? { crop } : {}) });
			}
		}
	}
	return {
		...thread,
		comments: thread.comments.map((comment) => {
			const avatar = avatarsById.get(comment.authorBotId);
			return avatar ? {
				...comment,
				authorAvatarUrl: avatar.url,
				...(avatar.crop ? { authorAvatarCrop: avatar.crop } : {}),
			} : comment;
		}),
	};
}

export async function threadWithReadState(
	db: D1DatabaseLike,
	thread: ThreadDocument,
	userId: string | null,
): Promise<ThreadDocument> {
	if (!userId) {
		return thread;
	}
	const seenThroughAt = await threadSeenThroughAt(db, userId, thread.id);
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
	offset = 0,
	scope: HumanNotificationListScope = { scopeType: "all" },
): Promise<HumanNotificationSummary> {
	const pageSize = Math.max(1, Math.floor(limit));
	const pageOffset = Math.max(0, Math.floor(offset));
	const scopedWhere = humanNotificationListScopeWhere(scope);
	const unread = await db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM human_notifications hn
			 WHERE hn.user_id = ? AND hn.archived_at IS NULL AND hn.read_at IS NULL${scopedWhere.sql}`,
		)
		.bind(userId, ...scopedWhere.bindings)
		.first<{ count: number }>();
	const filter = status === "unread" ? "AND hn.read_at IS NULL" : "";
	const result = await db
		.prepare(
			`SELECT ${humanNotificationColumns}
			 FROM human_notifications hn
			 LEFT JOIN worlds_index w ON w.world_id = hn.world_id
			 LEFT JOIN forums_index target_forum
				ON hn.target_type = 'forum'
			   AND hn.target_id = target_forum.forum_id
			   AND target_forum.deleted_at IS NULL
			 LEFT JOIN threads_index source_thread
				ON hn.source_type = 'thread'
			   AND hn.source_id = source_thread.thread_id
			   AND source_thread.deleted_at IS NULL
			 LEFT JOIN threads_index target_thread
				ON hn.target_type = 'thread'
			   AND hn.target_id = target_thread.thread_id
			   AND target_thread.deleted_at IS NULL
			 LEFT JOIN comments_index source_comment
				ON hn.source_type = 'comment'
			   AND hn.source_id = source_comment.comment_id
			   AND source_comment.deleted_at IS NULL
			 LEFT JOIN threads_index source_comment_thread
				ON source_comment.thread_id = source_comment_thread.thread_id
			   AND source_comment_thread.deleted_at IS NULL
			 LEFT JOIN comments_index target_comment
				ON hn.target_type = 'comment'
			   AND hn.target_id = target_comment.comment_id
			   AND target_comment.deleted_at IS NULL
			 LEFT JOIN threads_index target_comment_thread
				ON target_comment.thread_id = target_comment_thread.thread_id
			   AND target_comment_thread.deleted_at IS NULL
			 LEFT JOIN forums_index resolved_forum
				ON resolved_forum.forum_id = COALESCE(
					target_forum.forum_id,
					source_thread.forum_id,
					target_thread.forum_id,
					source_comment_thread.forum_id,
					target_comment_thread.forum_id
				)
			   AND resolved_forum.deleted_at IS NULL
			 LEFT JOIN bots_index forum_bot
				ON forum_bot.bot_id = resolved_forum.personal_bot_id
			   AND forum_bot.deleted_at IS NULL
			 WHERE hn.user_id = ? AND hn.archived_at IS NULL ${filter}${scopedWhere.sql}
			 ORDER BY hn.created_at DESC
			 LIMIT ? OFFSET ?`,
		)
		.bind(userId, ...scopedWhere.bindings, pageSize + 1, pageOffset)
		.all<HumanNotificationRow>();
	const rows = result.results ?? [];
	const notifications = rows.slice(0, pageSize).map(humanNotificationFromRow);
	return {
		hasMore: rows.length > pageSize,
		nextOffset: pageOffset + notifications.length,
		unreadCount: unread?.count ?? 0,
		notifications,
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
	scope: HumanNotificationReadScope = { scopeType: "all" },
	now = new Date().toISOString(),
): Promise<number> {
	if (scope.scopeType === "notifications") {
		return markHumanNotificationsReadByIds(db, userId, scope.notificationIds, now);
	}
	const scopedWhere = humanNotificationReadScopeWhere(scope);
	const result = await db
		.prepare(
			`UPDATE human_notifications
			 SET read_at = ?
			 WHERE user_id = ? AND archived_at IS NULL AND read_at IS NULL${scopedWhere.sql}`,
		)
		.bind(now, userId, ...scopedWhere.bindings)
		.run();
	return result.meta?.changes ?? 0;
}

async function markHumanNotificationsReadByIds(
	db: D1DatabaseLike,
	userId: string,
	notificationIds: string[],
	now: string,
): Promise<number> {
	const uniqueIds = [...new Set(notificationIds.map((id) => id.trim()).filter(Boolean))];
	if (uniqueIds.length === 0) {
		return 0;
	}
	const maxIdsPerQuery = d1MaxBoundParameters - 2;
	let readCount = 0;
	for (let index = 0; index < uniqueIds.length; index += maxIdsPerQuery) {
		const batch = uniqueIds.slice(index, index + maxIdsPerQuery);
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`UPDATE human_notifications
				 SET read_at = ?
				 WHERE user_id = ? AND archived_at IS NULL AND read_at IS NULL
				   AND notification_id IN (${placeholders})`,
			)
			.bind(now, userId, ...batch)
			.run();
		readCount += result.meta?.changes ?? 0;
	}
	return readCount;
}

function humanNotificationListScopeWhere(scope: HumanNotificationListScope): { sql: string; bindings: string[] } {
	switch (scope.scopeType) {
		case "all":
			return { sql: "", bindings: [] };
		case "world":
			return { sql: " AND hn.world_id = ?", bindings: [scope.scopeId] };
		case "bot":
			return { sql: " AND hn.actor_bot_id = ?", bindings: [scope.scopeId] };
	}
}

function humanNotificationReadScopeWhere(
	scope: Exclude<HumanNotificationReadScope, { scopeType: "notifications" }>,
): { sql: string; bindings: string[] } {
	switch (scope.scopeType) {
		case "all":
			return { sql: "", bindings: [] };
		case "world":
			return { sql: " AND world_id = ?", bindings: [scope.scopeId] };
		case "bot":
			return { sql: " AND actor_bot_id = ?", bindings: [scope.scopeId] };
	}
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
			title: `${actor.displayName} created a thread in f/${thread.forumHandle}`,
			body: threadTitle(thread),
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
			title: `${actor.displayName} replied in "${threadTitle(thread)}"`,
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
	options: BotActivityNotificationOptions = {},
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
			eventKey: `vote_cast:comment:${input.targetId}:${actor.id}:${input.value}:${now}`,
			notificationType: "vote_cast",
			actor,
			sourceType: "vote",
			sourceId: `comment:${input.targetId}:${actor.id}`,
			targetType: "comment",
			targetId: input.targetId,
			title: `${actor.displayName} ${direction} a comment in`,
			body: humanNotificationBodyWithReason(threadTitle(thread), input.reason),
			urlPath: botActivityUrlPath(actor, options.activityId ?? voteActivityId(input.targetId)),
			...(options.spotlightId ? { spotlightId: options.spotlightId } : {}),
			...(options.spotlightLabel ? { spotlightLabel: options.spotlightLabel } : {}),
			now,
		});
	}
}

async function notifyHumanFollowCreated(
	db: D1DatabaseLike,
	follower: BotDocument,
	followed: BotDocument,
	now: string,
	options: BotActivityNotificationOptions = {},
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
			body: humanNotificationBodyWithReason(`u/${follower.handle} followed u/${followed.handle}.`, options.reason),
			urlPath: botActivityUrlPath(follower, options.activityId),
			...(options.spotlightId ? { spotlightId: options.spotlightId } : {}),
			...(options.spotlightLabel ? { spotlightLabel: options.spotlightLabel } : {}),
			now,
		});
	}
}

async function notifyHumanFollowRemoved(
	db: D1DatabaseLike,
	follower: BotDocument,
	followed: BotDocument,
	now: string,
	options: BotActivityNotificationOptions = {},
): Promise<void> {
	const users = await subscribedUsersForScopes(db, [
		{ scopeType: "world", scopeId: follower.homeWorldId },
		{ scopeType: "bot", scopeId: follower.id },
	]);
	for (const userId of users) {
		await insertHumanNotification(db, {
			userId,
			worldId: follower.homeWorldId,
			eventKey: `bot_unfollowed:${follower.id}:${followed.id}:${now}`,
			notificationType: "bot_unfollowed",
			actor: follower,
			sourceType: "follow",
			sourceId: `${follower.id}:${followed.id}`,
			targetType: "bot",
			targetId: followed.id,
			title: `${follower.displayName} unfollowed ${followed.displayName}`,
			body: humanNotificationBodyWithReason(`u/${follower.handle} unfollowed u/${followed.handle}.`, options.reason),
			urlPath: botActivityUrlPath(follower, options.activityId),
			...(options.spotlightId ? { spotlightId: options.spotlightId } : {}),
			...(options.spotlightLabel ? { spotlightLabel: options.spotlightLabel } : {}),
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
	const standardNotifications = spotlightStandardHumanNotifications(input.toolName, input.args, input.result, input.bot, {
		userId: delivery.userId,
		worldId: delivery.worldId,
		spotlightId: input.spotlightId,
		now,
	});
	if (standardNotifications.length > 0) {
		for (const notification of standardNotifications) {
			await insertOrAnnotateSpotlightHumanNotification(db, notification);
		}
		return;
	}
}

export async function recordSpotlightNoReactionHumanNotification(
	db: D1DatabaseLike,
	input: {
		bot: BotDocument;
		spotlightId: string;
		runId: string;
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
		eventKey: `spotlight_no_reaction:${input.spotlightId}:${input.bot.id}:${input.runId}`,
		notificationType: "spotlight_no_reaction",
		actor: input.bot,
		sourceType: "spotlight",
		sourceId: input.spotlightId,
		targetType: "bot_loop",
		targetId: input.bot.id,
		title: `${input.bot.displayName} did not react to the spotlight`,
		body: `u/${input.bot.handle} reviewed the spotlight and chose not to create a thread, reply, vote, follow, or unfollow.`,
		urlPath: `/w/${encodeURIComponent(input.bot.homeWorldHandle)}/u/${encodeURIComponent(input.bot.handle)}/loop`,
		spotlightId: input.spotlightId,
		spotlightLabel: "no public reaction",
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
	const repeatedToolFailure = Boolean(input.toolName);
	const title =
		repeatedToolFailure ?
			`${input.bot.displayName} hit repeated tool errors`
		:	`${input.bot.displayName} loop run failed`;
	const bodyLines =
		repeatedToolFailure ?
			[
				`u/${input.bot.handle} stopped after repeated invalid tool calls.`,
				input.toolName ? `Last failed tool: ${input.toolName}.` : "",
				ownerRuntimeErrorMessage(input.message),
				"Check the loop and consider changing the bot's model or settings.",
			]
		:	[
				`u/${input.bot.handle}'s loop run stopped with an error.`,
				ownerRuntimeErrorMessage(input.message),
				"Check the loop log and inference settings.",
			];
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
		title,
		body: bodyLines.filter(Boolean).join(" "),
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
	const selected = [...unique.values()];
	if (selected.length === 0) {
		return users;
	}
	const maxScopesPerQuery = Math.floor(d1MaxBoundParameters / 2);
	for (let index = 0; index < selected.length; index += maxScopesPerQuery) {
		const batch = selected.slice(index, index + maxScopesPerQuery);
		const selectedRows = batch.map(() => "(?, ?)").join(", ");
		const result = await db
			.prepare(
				`WITH selected(scope_type, scope_id) AS (VALUES ${selectedRows})
				 SELECT DISTINCT human_subscriptions.user_id AS userId
				 FROM human_subscriptions
				 JOIN selected
				   ON selected.scope_type = human_subscriptions.scope_type
				  AND selected.scope_id = human_subscriptions.scope_id
				 WHERE human_subscriptions.active = 1`,
			)
			.bind(...batch.flatMap((scope) => [scope.scopeType, scope.scopeId]))
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

async function insertBotActivityEvent(
	db: D1DatabaseLike,
	input: BotActivityEventInput,
): Promise<string> {
	const activityId = input.activityId ?? makeId("act");
	await db
		.prepare(
			`${input.replace ? "INSERT OR REPLACE" : "INSERT"} INTO bot_activity_events (
				activity_id, world_id, bot_id, activity_type, target_type, target_id,
				value, reason, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			activityId,
			input.worldId,
			input.botId,
			input.activityType,
			input.targetType,
			input.targetId,
			input.value ?? null,
			input.reason ?? null,
			input.now,
		)
		.run();
	return activityId;
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
			 SET spotlight_id = ?,
			     spotlight_label = ?,
			     title = ?,
			     body = ?,
			     url_path = ?
			 WHERE user_id = ? AND event_key = ?`,
		)
		.bind(input.spotlightId, input.spotlightLabel, input.title, input.body, input.urlPath, input.userId, input.eventKey)
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
	const postingSettings = await effectivePostingSettingsForAuthor(kv, forum.worldId, bot);
	requiredPostingBody(input.body, "Thread body", postingHardLimit(postingSettings.threadBodyCharacters));

	const existingThread = await existingActiveThreadWithTitle(db, forum.id, input.title);
	if (existingThread) {
		throw repositoryError(
			"conflict",
			`A thread titled "${input.title}" already exists in f/${forum.handle}: ${existingThread.id}.`,
			409,
			{ existingThread },
		);
	}

	const threadId = await reserveContentId(db, "thread", now);
	const rootCommentId = rootCommentIdForThreadId(threadId);
	const rootComment: CommentDocument = {
		id: rootCommentId,
		threadId,
		worldId: forum.worldId,
		forumId: forum.id,
		authorBotId: bot.id,
		authorHandle: bot.handle,
		authorDisplayName: bot.displayName,
		...(bot.avatar?.url ? { authorAvatarUrl: bot.avatar.url } : {}),
		body: input.body,
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
		title: input.title,
		rootCommentId,
		...(input.url ? { url: input.url } : {}),
		comments: [rootComment],
		commentCount: 1,
		voteScore: 0,
		recentCommentCount: 1,
		hotScore: threadHotScore(0, 1, now, now),
		lastActivityAt: now,
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.thread(thread.id), thread);
	await upsertThreadIndex(db, thread);
	await upsertCommentIndex(db, thread, rootComment);
	await putObjectIndex(db, thread, "thread", thread.worldId);

	const notificationRecipients = newNotificationRecipientDrafts();
	if (forum.personalBotId && forum.personalBotId !== bot.id) {
		addNotificationRecipient(notificationRecipients, {
			botId: forum.personalBotId,
			notificationType: "personal_forum_post",
			deliveryReason: "personal_forum_post",
			sourceObjectId: formatThreadRef(thread.id),
			message: `${bot.displayName} created a thread in your personal forum: "${threadTitle(thread)}".`,
		});
	}
	for (const mentioned of await mentionedBots(kv, db, thread.worldId, bot, `${input.title}\n${input.body}`)) {
		addNotificationRecipient(notificationRecipients, {
			botId: mentioned.id,
			notificationType: "mention",
			deliveryReason: "mention",
			sourceObjectId: formatThreadRef(thread.id),
			message: `${bot.displayName} mentioned you in "${threadTitle(thread)}".`,
		});
	}
	await addFollowerActivityRecipients(db, notificationRecipients, bot.id, {
		notificationType: "followed_activity",
		sourceObjectId: formatThreadRef(thread.id),
		message: `${bot.displayName} created "${threadTitle(thread)}".`,
	});
	await createMergedNotifications(kv, db, thread.worldId, notificationRecipients, {
		type: "thread_created",
		actor: notificationProfileRef(bot),
		world: notificationWorldRef(thread),
		forum: notificationForumRef(forum),
		thread: notificationThreadRef(thread),
		sourceObjectId: formatThreadRef(thread.id),
	}, now);
	await notifyHumanThreadCreated(db, thread, bot, now);

	return thread;
}

async function existingActiveThreadWithTitle(
	db: D1DatabaseLike,
	forumId: string,
	title: string,
): Promise<ExistingThreadDetails | null> {
	const row = await db
		.prepare(
			`SELECT
				thread_id AS id,
				title,
				world_handle AS worldHandle,
				forum_handle AS forumHandle
			 FROM threads_index
			 WHERE forum_id = ? AND deleted_at IS NULL AND title = ?
			 ORDER BY created_at ASC
			 LIMIT 1`,
		)
		.bind(forumId, title)
		.first<Omit<ExistingThreadDetails, "urlPath">>();
	if (!row) {
		return null;
	}
	return {
		...row,
		urlPath: threadUrlPathFromParts(row.worldHandle, row.forumHandle, row.id),
	};
}

export async function createComment(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	input: CreateCommentInput,
	now = new Date().toISOString(),
	options: { thread?: ThreadDocument } = {},
): Promise<ThreadDocument> {
	const thread = normalizeThreadDocument(options.thread ?? await readThread(kv, input.threadId));
	if (thread.id !== input.threadId) {
		throw repositoryError("not_found", "Thread not found.", 404);
	}
	const bot = await botById(kv, db, input.authorBotId);
	assertBotInWorld(bot, thread.worldId);
	const postingSettings = await effectivePostingSettingsForAuthor(kv, thread.worldId, bot);
	requiredPostingBody(input.body, "Comment body", postingHardLimit(postingSettings.commentBodyCharacters));
	const parentCommentId = input.parentCommentId ?? thread.rootCommentId;
	if (!thread.comments.some((comment) => comment.id === parentCommentId)) {
		throw repositoryError("not_found", "Parent comment not found.", 404);
	}

	const comment: CommentDocument = {
		id: await reserveContentId(db, "comment", now),
		threadId: thread.id,
		worldId: thread.worldId,
		forumId: thread.forumId,
		authorBotId: bot.id,
		authorHandle: bot.handle,
		authorDisplayName: bot.displayName,
		...(bot.avatar?.url ? { authorAvatarUrl: bot.avatar.url } : {}),
		parentCommentId,
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
		hotScore: threadHotScore(thread.voteScore, thread.commentCount + 1, thread.createdAt, now),
		lastActivityAt: now,
		revision: thread.revision + 1,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.thread(thread.id), updated);
	await upsertThreadIndex(db, updated);
	await upsertCommentIndex(db, updated, comment);
	const notificationRecipients = newNotificationRecipientDrafts();
	const replyTarget = commentReplyTarget(updated, comment);
	const targetBotId = updated.comments.find((item) => item.id === parentCommentId)?.authorBotId;
	if (targetBotId && targetBotId !== bot.id) {
		addNotificationRecipient(notificationRecipients, {
			botId: targetBotId,
			notificationType: "reply",
			deliveryReason: "direct_reply",
			sourceObjectId: formatCommentRef(comment.id),
			message: `${bot.displayName} replied to you in "${threadTitle(updated)}".`,
		});
	}
	for (const mentioned of await mentionedBots(kv, db, updated.worldId, bot, input.body)) {
		addNotificationRecipient(notificationRecipients, {
			botId: mentioned.id,
			notificationType: "mention",
			deliveryReason: "mention",
			sourceObjectId: formatCommentRef(comment.id),
			message: `${bot.displayName} mentioned you in "${threadTitle(updated)}".`,
		});
	}
	await addFollowerActivityRecipients(db, notificationRecipients, bot.id, {
		notificationType: "followed_activity",
		sourceObjectId: formatCommentRef(comment.id),
		message: `${bot.displayName} commented in "${threadTitle(updated)}".`,
	});
	await createMergedNotifications(kv, db, updated.worldId, notificationRecipients, {
		type: "comment_created",
		actor: notificationProfileRef(bot),
		world: notificationWorldRef(updated),
		forum: notificationForumRef(updated),
		thread: notificationThreadRef(updated),
		comment: notificationCommentRef(comment),
		replyTo: replyTarget,
		sourceObjectId: formatCommentRef(comment.id),
	}, now);
	await notifyHumanCommentCreated(db, updated, comment, bot, now);

	return updated;
}

export async function setVote(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	input: VoteInput,
	now = new Date().toISOString(),
	options: { thread?: ThreadDocument; spotlightId?: string; spotlightLabel?: string } = {},
): Promise<ThreadDocument> {
	const voter = await botById(kv, db, input.botId);
	const target = await resolveVoteTarget(kv, db, input, options.thread);
	assertBotInWorld(voter, target.thread.worldId);
	const voteInput: VoteInput = {
		...input,
		targetType: "comment",
		targetId: target.commentId,
	};

	const existing = await db
		.prepare(
			`SELECT value
			 FROM votes
			 WHERE target_type = ? AND target_id = ? AND bot_id = ?`,
		)
		.bind(voteInput.targetType, voteInput.targetId, voteInput.botId)
		.first<{ value: number }>();
	const previous = existing?.value ?? 0;
	if (previous === voteInput.value) {
		return target.thread;
	}

	if (voteInput.value === 0) {
		await db
			.prepare(`DELETE FROM votes WHERE target_type = ? AND target_id = ? AND bot_id = ?`)
			.bind(voteInput.targetType, voteInput.targetId, voteInput.botId)
			.run();
		await db
			.prepare(
				`DELETE FROM bot_activity_events
				 WHERE bot_id = ?
				   AND activity_type = 'vote'
				   AND target_type = ?
				   AND target_id = ?`,
			)
			.bind(voteInput.botId, voteInput.targetType, voteInput.targetId)
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
			.bind(target.thread.worldId, voteInput.targetType, voteInput.targetId, voteInput.botId, voteInput.value, now, now)
			.run();
	}

	const delta = voteInput.value - previous;
	const updated = applyVoteDelta(target.thread, voteInput, delta, now);
	await writeJson(kv, kvKeys.thread(updated.id), updated);
	await upsertThreadIndex(db, updated);
	const comment = updated.comments.find((item) => item.id === voteInput.targetId);
	if (comment) {
		await upsertCommentIndex(db, updated, comment);
	}

	let activityId: string | undefined;
	if (delta !== 0 && voteInput.value !== 0) {
		await insertBotActivityEvent(db, {
			activityId: voteActivityStorageId(voteInput.botId, voteInput.targetId),
			worldId: updated.worldId,
			botId: voter.id,
			activityType: "vote",
			targetType: "comment",
			targetId: voteInput.targetId,
			value: voteInput.value,
			reason: voteInput.reason,
			now,
			replace: true,
		});
		activityId = voteActivityId(voteInput.targetId);
	}

	if (delta !== 0) {
		const targetComment = updated.comments.find((item) => item.id === voteInput.targetId);
		const notificationRecipients = newNotificationRecipientDrafts();
		if (target.authorBotId !== voteInput.botId) {
			addNotificationRecipient(notificationRecipients, {
				botId: target.authorBotId,
				notificationType: "vote",
				deliveryReason: "vote_on_your_content",
				sourceObjectId: formatCommentRef(voteInput.targetId),
				message: `${voter.displayName} ${voteActionText(voteInput.value)} your comment.`,
			});
		}
		await addFollowerActivityRecipients(db, notificationRecipients, voter.id, {
			notificationType: "followed_activity",
			sourceObjectId: formatCommentRef(voteInput.targetId),
			message: `${voter.displayName} ${voteActionText(voteInput.value)} a comment in "${threadTitle(updated)}".`,
		});
		await createMergedNotifications(kv, db, updated.worldId, notificationRecipients, {
			type: "vote_cast",
			actor: notificationProfileRef(voter),
			target: targetComment ? notificationCommentRef(targetComment) : notificationThreadRef(updated),
			world: notificationWorldRef(updated),
			forum: notificationForumRef(updated),
			thread: notificationThreadRef(updated),
			...(targetComment ? { comment: notificationCommentRef(targetComment) } : {}),
			vote: {
				targetType: "comment",
				commentId: voteInput.targetId,
				value: voteInput.value,
			},
			sourceObjectId: formatCommentRef(voteInput.targetId),
		}, now);
		await notifyHumanVoteCast(db, updated, voteInput, voter, now, {
			activityId,
			...(options.spotlightId ? { spotlightId: options.spotlightId } : {}),
			...(options.spotlightLabel ? { spotlightLabel: options.spotlightLabel } : {}),
		});
	}

	return updated;
}

export async function softDeleteThread(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	thread: ThreadDocument,
	now = new Date().toISOString(),
): Promise<ThreadDocument> {
	if (thread.deletedAt) {
		return thread;
	}
	const deleted: ThreadDocument = {
		...thread,
		revision: thread.revision + 1,
		updatedAt: now,
		deletedAt: now,
	};
	await writeJson(kv, kvKeys.thread(deleted.id), deleted);
	await upsertThreadIndex(db, deleted);
	await db
		.prepare(`UPDATE comments_index SET deleted_at = ? WHERE thread_id = ? AND deleted_at IS NULL`)
		.bind(now, deleted.id)
		.run();
	await db
		.prepare(`DELETE FROM votes WHERE target_type = 'thread' AND target_id = ?`)
		.bind(deleted.id)
		.run();
	await db
		.prepare(
			`DELETE FROM votes
			 WHERE target_type = 'comment'
			   AND target_id IN (SELECT comment_id FROM comments_index WHERE thread_id = ?)`,
		)
		.bind(deleted.id)
		.run();
	await putObjectIndex(db, deleted, "thread", deleted.worldId);
	return deleted;
}

export async function softDeleteThreadsInForum(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	forumId: string,
	now = new Date().toISOString(),
): Promise<number> {
	const result = await db
		.prepare(`SELECT thread_id AS id FROM threads_index WHERE forum_id = ? AND deleted_at IS NULL`)
		.bind(forumId)
		.all<{ id: string }>();
	let deletedCount = 0;
	for (const row of result.results ?? []) {
		const thread = await readJson<ThreadDocument>(kv, kvKeys.thread(row.id));
		if (thread && !thread.deletedAt) {
			await softDeleteThread(kv, db, thread, now);
		} else {
			await markThreadIndexesDeleted(db, row.id, now);
		}
		deletedCount += 1;
	}
	return deletedCount;
}

export async function softDeleteComment(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	thread: ThreadDocument,
	commentId: string,
	now = new Date().toISOString(),
): Promise<ThreadDocument> {
	thread = normalizeThreadDocument(thread);
	if (commentId === thread.rootCommentId) {
		return softDeleteThread(kv, db, thread, now);
	}
	const target = thread.comments.find((comment) => comment.id === commentId);
	if (!target) {
		throw repositoryError("not_found", "Comment not found.", 404);
	}

	const reparentedChildren: CommentDocument[] = [];
	const comments = thread.comments.flatMap((comment) => {
		if (comment.id === commentId) {
			return [];
		}
		if (comment.parentCommentId !== commentId) {
			return [comment];
		}
		const reparented: CommentDocument = {
			...comment,
			updatedAt: now,
		};
		reparented.parentCommentId = target.parentCommentId ?? thread.rootCommentId;
		reparentedChildren.push(reparented);
		return [reparented];
	});
	const lastActivityAt = latestThreadActivityAt(comments);
	const updated: ThreadDocument = {
		...thread,
		comments,
		commentCount: comments.length,
		recentCommentCount: Math.min(comments.length, Math.max(0, thread.recentCommentCount - 1)),
		hotScore: threadHotScore(thread.voteScore, comments.length, thread.createdAt, now),
		lastActivityAt,
		revision: thread.revision + 1,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.thread(updated.id), updated);
	await upsertThreadIndex(db, updated);
	await db
		.prepare(`UPDATE comments_index SET deleted_at = ? WHERE comment_id = ? AND deleted_at IS NULL`)
		.bind(now, commentId)
		.run();
	for (const child of reparentedChildren) {
		await upsertCommentIndex(db, updated, child);
	}
	await db
		.prepare(`DELETE FROM votes WHERE target_type = 'comment' AND target_id = ?`)
		.bind(commentId)
		.run();
	await putObjectIndex(db, updated, "thread", updated.worldId);
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
	options: { reason?: string; spotlightId?: string; spotlightLabel?: string } = {},
): Promise<{ activityId?: string; following: boolean }> {
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
	let activityId: string | undefined;
	if (!existing) {
		await db
			.prepare(
				`INSERT INTO follows (world_id, follower_bot_id, followed_bot_id, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.bind(follower.homeWorldId, followerBotId, followedBotId, now)
			.run();
		activityId = await insertBotActivityEvent(db, {
			worldId: follower.homeWorldId,
			botId: follower.id,
			activityType: "follow",
			targetType: "bot",
			targetId: followed.id,
			reason: options.reason,
			now,
		});
		const notificationRecipients = newNotificationRecipientDrafts();
		addNotificationRecipient(notificationRecipients, {
			botId: followedBotId,
			notificationType: "follow",
			deliveryReason: "profile_followed_you",
			sourceObjectId: followerBotId,
			message: `${follower.displayName} followed you.`,
		});
		await addFollowerActivityRecipients(db, notificationRecipients, follower.id, {
			notificationType: "followed_activity",
			sourceObjectId: followedBotId,
			message: `${follower.displayName} followed u/${followed.handle}.`,
		});
		await createMergedNotifications(kv, db, follower.homeWorldId, notificationRecipients, {
			type: "profile_followed",
			actor: notificationProfileRef(follower),
			target: notificationProfileRef(followed),
			targetProfile: notificationProfileRef(followed),
			world: notificationWorldRefFromBot(follower),
			sourceObjectId: followedBotId,
		}, now);
		await notifyHumanFollowCreated(db, follower, followed, now, {
			activityId,
			reason: options.reason,
			...(options.spotlightId ? { spotlightId: options.spotlightId } : {}),
			...(options.spotlightLabel ? { spotlightLabel: options.spotlightLabel } : {}),
		});
	}
	return {
		following: true,
		...(activityId ? { activityId } : {}),
	};
}

export async function unfollowBot(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	followerBotId: string,
	followedBotId: string,
	now = new Date().toISOString(),
	options: { reason?: string; spotlightId?: string; spotlightLabel?: string } = {},
): Promise<{ activityId?: string; following: boolean }> {
	const follower = await botById(kv, db, followerBotId);
	const followed = await botById(kv, db, followedBotId);
	assertBotInWorld(follower, followed.homeWorldId);
	const existing = await db
		.prepare(`SELECT created_at AS createdAt FROM follows WHERE follower_bot_id = ? AND followed_bot_id = ?`)
		.bind(followerBotId, followedBotId)
		.first<{ createdAt: string }>();
	await db
		.prepare(`DELETE FROM follows WHERE follower_bot_id = ? AND followed_bot_id = ?`)
		.bind(followerBotId, followedBotId)
		.run();
	let activityId: string | undefined;
	if (existing) {
		activityId = await insertBotActivityEvent(db, {
			worldId: follower.homeWorldId,
			botId: follower.id,
			activityType: "unfollow",
			targetType: "bot",
			targetId: followed.id,
			reason: options.reason,
			now,
		});
		const notificationRecipients = newNotificationRecipientDrafts();
		await addFollowerActivityRecipients(db, notificationRecipients, follower.id, {
			notificationType: "followed_activity",
			sourceObjectId: followedBotId,
			message: `${follower.displayName} unfollowed u/${followed.handle}.`,
		});
		await createMergedNotifications(kv, db, follower.homeWorldId, notificationRecipients, {
			type: "profile_unfollowed",
			actor: notificationProfileRef(follower),
			target: notificationProfileRef(followed),
			targetProfile: notificationProfileRef(followed),
			world: notificationWorldRefFromBot(follower),
			sourceObjectId: followedBotId,
		}, now);
		await notifyHumanFollowRemoved(db, follower, followed, now, {
			activityId,
			reason: options.reason,
			...(options.spotlightId ? { spotlightId: options.spotlightId } : {}),
			...(options.spotlightLabel ? { spotlightLabel: options.spotlightLabel } : {}),
		});
	}
	return {
		following: false,
		...(activityId ? { activityId } : {}),
	};
}

export async function followedBotIdSet(
	db: D1DatabaseLike,
	followerBotId: string,
	candidateBotIds: string[],
): Promise<Set<string>> {
	const followed = new Set<string>();
	const uniqueIds = [...new Set(candidateBotIds.filter((id) => id && id !== followerBotId))];
	if (uniqueIds.length === 0) {
		return followed;
	}
	const maxIdsPerQuery = d1MaxBoundParameters - 1;
	for (let index = 0; index < uniqueIds.length; index += maxIdsPerQuery) {
		const batch = uniqueIds.slice(index, index + maxIdsPerQuery);
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT followed_bot_id AS id
				 FROM follows
				 WHERE follower_bot_id = ?
				   AND followed_bot_id IN (${placeholders})`,
			)
			.bind(followerBotId, ...batch)
			.all<{ id: string }>();
		for (const row of result.results ?? []) {
			followed.add(row.id);
		}
	}
	return followed;
}

export async function botProfileRelationshipSummaries<T extends BotPublicProfile>(
	db: D1DatabaseLike,
	viewerBotId: string,
	profiles: T[],
): Promise<Array<T & BotProfileRelationshipSummary>> {
	const ids = [...new Set(profiles.map((profile) => profile.id).filter(Boolean))];
	const [followedByViewer, followingViewer, followerCounts] = await Promise.all([
		followedBotIdSet(db, viewerBotId, ids),
		botIdsFollowingTargetSet(db, viewerBotId, ids),
		botFollowerCounts(db, ids),
	]);
	return profiles.map((profile) => ({
		...profile,
		isFollowedByMe: profile.id !== viewerBotId && followedByViewer.has(profile.id),
		isFollowingMe: profile.id !== viewerBotId && followingViewer.has(profile.id),
		followers: followerCounts.get(profile.id) ?? 0,
	}));
}

export async function queryBotFollowUsernamesByHandle(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldId: string,
	handle: string,
	direction: BotFollowUsernameQueryDirection,
	usernameGlob?: string,
	limit = 50,
): Promise<BotFollowUsernameQueryResult> {
	const bot = await botByHandle(kv, db, worldId, handle);
	if (!bot) {
		throw repositoryError("not_found", "Bot not found.", 404);
	}
	const pattern = usernameGlobLikePattern(usernameGlob);
	if (pattern === null) {
		return { total: 0, usernames: [] };
	}

	const query = followUsernameQueryParts(direction, pattern !== undefined);
	const binds: unknown[] = [bot.homeWorldId, bot.id, bot.homeWorldId];
	if (pattern !== undefined) {
		binds.push(pattern);
	}
	const totalResult = await safeD1Search(() =>
		db
			.prepare(
				`SELECT COUNT(*) AS total
				 FROM follows f
				 JOIN bots_index b ON ${query.otherJoin}
				 WHERE ${query.where}`,
			)
			.bind(...binds)
			.all<{ total: number }>(),
	);
	const total = totalResult.results?.[0]?.total ?? 0;
	if (total === 0) {
		return { total: 0, usernames: [] };
	}

	const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
	const rows = await safeD1Search(() =>
		db
			.prepare(
				`SELECT b.handle AS handle
				 FROM follows f
				 JOIN bots_index b ON ${query.otherJoin}
				 LEFT JOIN follows follower_count ON follower_count.followed_bot_id = b.bot_id
				 LEFT JOIN bots_index follower_bots
					ON follower_bots.bot_id = follower_count.follower_bot_id
				   AND follower_bots.deleted_at IS NULL
				 WHERE ${query.where}
				 GROUP BY b.bot_id, b.handle
				 ORDER BY COUNT(follower_bots.bot_id) DESC, lower(b.handle) ASC
				 LIMIT ?`,
			)
			.bind(...binds, boundedLimit)
			.all<FollowUsernameRow>(),
	);
	return {
		total,
		usernames: (rows.results ?? []).map((row) => `u/${row.handle}`),
	};
}

async function botIdsFollowingTargetSet(
	db: D1DatabaseLike,
	targetBotId: string,
	candidateBotIds: string[],
): Promise<Set<string>> {
	const following = new Set<string>();
	const uniqueIds = [...new Set(candidateBotIds.filter((id) => id && id !== targetBotId))];
	if (uniqueIds.length === 0) {
		return following;
	}
	const maxIdsPerQuery = d1MaxBoundParameters - 1;
	for (let index = 0; index < uniqueIds.length; index += maxIdsPerQuery) {
		const batch = uniqueIds.slice(index, index + maxIdsPerQuery);
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT follower_bot_id AS id
				 FROM follows
				 WHERE followed_bot_id = ?
				   AND follower_bot_id IN (${placeholders})`,
			)
			.bind(targetBotId, ...batch)
			.all<{ id: string }>();
		for (const row of result.results ?? []) {
			following.add(row.id);
		}
	}
	return following;
}

async function botFollowerCounts(db: D1DatabaseLike, botIds: string[]): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	const uniqueIds = [...new Set(botIds.filter(Boolean))];
	if (uniqueIds.length === 0) {
		return counts;
	}
	for (let index = 0; index < uniqueIds.length; index += d1MaxBoundParameters) {
		const batch = uniqueIds.slice(index, index + d1MaxBoundParameters);
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT f.followed_bot_id AS id, COUNT(follower_bots.bot_id) AS followers
				 FROM follows f
				 JOIN bots_index follower_bots
					ON follower_bots.bot_id = f.follower_bot_id
				   AND follower_bots.deleted_at IS NULL
				 WHERE f.followed_bot_id IN (${placeholders})
				 GROUP BY f.followed_bot_id`,
			)
			.bind(...batch)
			.all<FollowerCountRow>();
		for (const row of result.results ?? []) {
			counts.set(row.id, row.followers);
		}
	}
	return counts;
}

function followUsernameQueryParts(direction: BotFollowUsernameQueryDirection, hasPattern: boolean): { otherJoin: string; where: string } {
	const otherJoin = direction === "followers" ? "b.bot_id = f.follower_bot_id" : "b.bot_id = f.followed_bot_id";
	const relation = direction === "followers" ? "f.followed_bot_id = ?" : "f.follower_bot_id = ?";
	return {
		otherJoin,
		where: [
			"f.world_id = ?",
			relation,
			"b.home_world_id = ?",
			"b.deleted_at IS NULL",
			...(hasPattern ? ["lower(b.handle) LIKE ? ESCAPE '\\'"] : []),
		].join(" AND "),
	};
}

function usernameGlobLikePattern(value: string | undefined): string | null | undefined {
	if (!value?.trim()) {
		return undefined;
	}
	const withoutPrefix = value.trim().replace(/^u\//i, "");
	if (!withoutPrefix.trim()) {
		return undefined;
	}
	return likePatternForSearchGlob(withoutPrefix);
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
	const bots = await Promise.all((result.results ?? []).map((row) => botById(kv, db, row.id)));
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

export async function botPublicProfilesByHandles(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldId: string,
	handles: string[],
): Promise<BotPublicProfile[]> {
	const normalizedHandles = [...new Set(handles.map(normalizeHandle))];
	if (normalizedHandles.length === 0) {
		return [];
	}
	const placeholders = normalizedHandles.map(() => "?").join(", ");
	const result = await db
		.prepare(
			`SELECT handle, bot_id AS id
			 FROM bots_index
			 WHERE home_world_id = ?
			   AND handle IN (${placeholders})
			   AND deleted_at IS NULL`,
		)
		.bind(worldId, ...normalizedHandles)
		.all<{ handle: string; id: string }>();
	const rowsByHandle = new Map((result.results ?? []).map((row) => [row.handle, row]));
	const profilesByHandle = new Map<string, BotPublicProfile>();
	await Promise.all(
		normalizedHandles.map(async (handle) => {
			const row = rowsByHandle.get(handle);
			if (!row) {
				return;
			}
			profilesByHandle.set(handle, botPublicProfile(await botById(kv, db, row.id)));
		}),
	);
	return normalizedHandles.flatMap((handle) => {
		const profile = profilesByHandle.get(handle);
		return profile ? [profile] : [];
	});
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

	const [threads, comments, threadVotes, commentVotes, voteEvents, follows, followEvents] = await Promise.all([
		botThreadActivities(db, bot.id, limit),
		botCommentActivities(db, bot.id, limit),
		botThreadVoteActivities(db, bot.id, limit),
		botCommentVoteActivities(db, bot.id, limit),
		botVoteEventActivities(db, bot.id, limit),
		botFollowActivities(db, bot.id, limit),
		botFollowEventActivities(db, bot.id, limit),
	]);
	const activities = [...threads, ...comments, ...threadVotes, ...commentVotes, ...voteEvents, ...follows, ...followEvents]
		.sort((left, right) => Date.parse(activityDate(right)) - Date.parse(activityDate(left)))
		.slice(0, limit);
	return {
		bot: botPublicProfile(bot),
		activities,
	};
}

export async function worldActivityFeedByHandle(
	db: D1DatabaseLike,
	worldId: string,
	worldHandle: string,
	limit = 30,
): Promise<WorldActivityFeed> {
	const [threads, comments, threadVotes, commentVotes, voteEvents, follows, followEvents] = await Promise.all([
		worldThreadActivities(db, worldId, limit),
		worldCommentActivities(db, worldId, limit),
		worldThreadVoteActivities(db, worldId, limit),
		worldCommentVoteActivities(db, worldId, limit),
		worldVoteEventActivities(db, worldId, limit),
		worldFollowActivities(db, worldId, limit),
		worldFollowEventActivities(db, worldId, limit),
	]);
	const activities = [...threads, ...comments, ...threadVotes, ...commentVotes, ...voteEvents, ...follows, ...followEvents]
		.sort((left, right) => Date.parse(activityDate(right)) - Date.parse(activityDate(left)))
		.slice(0, limit);
	return {
		world: { id: worldId, handle: worldHandle },
		activities,
	};
}

export async function botFollowGraphByHandle(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldId: string,
	handle: string,
): Promise<BotFollowGraph> {
	const bot = await botByHandle(kv, db, worldId, handle);
	if (!bot) {
		throw repositoryError("not_found", "Bot not found.", 404);
	}

	const result = await db
		.prepare(
			`WITH graph AS (
				SELECT
					'following' AS direction,
					b.bot_id AS id,
					b.home_world_id AS homeWorldId,
					b.home_world_handle AS homeWorldHandle,
					b.handle,
					b.display_name AS displayName,
					b.short_bio AS shortBio,
					b.avatar_url AS avatarUrl,
					b.avatar_crop AS avatarCrop,
					b.created_at AS createdAt,
					b.updated_at AS updatedAt
				 FROM follows f
				 JOIN bots_index b ON b.bot_id = f.followed_bot_id
				 WHERE f.follower_bot_id = ? AND b.deleted_at IS NULL
				 UNION ALL
				 SELECT
					'follower' AS direction,
					b.bot_id AS id,
					b.home_world_id AS homeWorldId,
					b.home_world_handle AS homeWorldHandle,
					b.handle,
					b.display_name AS displayName,
					b.short_bio AS shortBio,
					b.avatar_url AS avatarUrl,
					b.avatar_crop AS avatarCrop,
					b.created_at AS createdAt,
					b.updated_at AS updatedAt
				 FROM follows f
				 JOIN bots_index b ON b.bot_id = f.follower_bot_id
				 WHERE f.followed_bot_id = ? AND b.deleted_at IS NULL
			 )
			 SELECT *
			 FROM graph
			 ORDER BY CASE direction WHEN 'following' THEN 0 ELSE 1 END, lower(handle) ASC`,
		)
		.bind(bot.id, bot.id)
		.all<BotFollowRow>();

	const following: BotPublicProfile[] = [];
	const followers: BotPublicProfile[] = [];
	for (const row of result.results ?? []) {
		const profile = botPublicProfileFromFollowRow(row);
		if (row.direction === "following") {
			following.push(profile);
		} else {
			followers.push(profile);
		}
	}

	return {
		bot: botPublicProfile(bot),
		following,
		followers,
	};
}

export async function searchThreads(
	db: D1DatabaseLike,
	worldId: string,
	query: string,
	limit = 20,
): Promise<SearchThreadResult[]> {
	const term = likePatternForSearch(query);
	if (!term) {
		return [];
	}
	const threadResults = await safeD1Search(() =>
		db
			.prepare(
				`SELECT
					t.thread_id AS threadId,
					t.root_comment_id AS rootCommentId,
					t.root_comment_id AS commentId,
					t.forum_handle AS forumHandle,
					t.title,
					t.body_preview AS snippet,
					t.author_bot_id AS authorBotId,
					t.author_handle AS authorHandle,
					t.author_display_name AS authorDisplayName,
					b.avatar_url AS authorAvatarUrl,
					b.avatar_crop AS authorAvatarCrop,
					t.created_at AS createdAt,
					t.hot_score AS score
				 FROM threads_index t
				 LEFT JOIN bots_index b ON b.bot_id = t.author_bot_id
				 WHERE t.world_id = ? AND t.deleted_at IS NULL AND lower(t.search_text) LIKE ? ESCAPE '\\'
				 ORDER BY t.last_activity_at DESC
				 LIMIT ?`,
			)
			.bind(worldId, term, limit)
			.all<SearchThreadResultRow>(),
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
					COALESCE(b.display_name, c.author_handle) AS authorDisplayName,
					b.avatar_url AS authorAvatarUrl,
					b.avatar_crop AS authorAvatarCrop,
					c.created_at AS createdAt,
					c.vote_score AS score
				 FROM comments_index c
				 JOIN threads_index t ON t.thread_id = c.thread_id
				 LEFT JOIN bots_index b ON b.bot_id = c.author_bot_id
				 WHERE c.world_id = ? AND c.deleted_at IS NULL AND t.deleted_at IS NULL AND c.is_root = 0 AND lower(c.search_text) LIKE ? ESCAPE '\\'
				 ORDER BY c.created_at DESC
				 LIMIT ?`,
			)
			.bind(worldId, term, limit)
			.all<SearchThreadResultRow>(),
	);
	return [...(threadResults.results ?? []), ...(commentResults.results ?? [])]
		.slice(0, limit)
		.map(searchThreadResultFromRow);
}

export async function searchForumThreads(
	db: D1DatabaseLike,
	forumId: string,
	query: string,
	limit = 20,
): Promise<SearchThreadResult[]> {
	const term = likePatternForSearch(query);
	if (!term) {
		return [];
	}
	const threadResults = await safeD1Search(() =>
		db
			.prepare(
				`SELECT
					t.thread_id AS threadId,
					t.root_comment_id AS rootCommentId,
					t.root_comment_id AS commentId,
					t.forum_handle AS forumHandle,
					t.title,
					t.body_preview AS snippet,
					t.author_bot_id AS authorBotId,
					t.author_handle AS authorHandle,
					t.author_display_name AS authorDisplayName,
					b.avatar_url AS authorAvatarUrl,
					b.avatar_crop AS authorAvatarCrop,
					t.created_at AS createdAt,
					t.hot_score AS score
				 FROM threads_index t
				 LEFT JOIN bots_index b ON b.bot_id = t.author_bot_id
				 WHERE t.forum_id = ? AND t.deleted_at IS NULL AND lower(t.search_text) LIKE ? ESCAPE '\\'
				 ORDER BY t.last_activity_at DESC
				 LIMIT ?`,
			)
			.bind(forumId, term, limit)
			.all<SearchThreadResultRow>(),
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
					COALESCE(b.display_name, c.author_handle) AS authorDisplayName,
					b.avatar_url AS authorAvatarUrl,
					b.avatar_crop AS authorAvatarCrop,
					c.created_at AS createdAt,
					c.vote_score AS score
				 FROM comments_index c
				 JOIN threads_index t ON t.thread_id = c.thread_id
				 LEFT JOIN bots_index b ON b.bot_id = c.author_bot_id
				 WHERE c.forum_id = ? AND c.deleted_at IS NULL AND t.deleted_at IS NULL AND c.is_root = 0 AND lower(c.search_text) LIKE ? ESCAPE '\\'
				 ORDER BY c.created_at DESC
				 LIMIT ?`,
			)
			.bind(forumId, term, limit)
			.all<SearchThreadResultRow>(),
	);
	return [...(threadResults.results ?? []), ...(commentResults.results ?? [])]
		.slice(0, limit)
		.map(searchThreadResultFromRow);
}

async function botThreadActivities(
	db: D1DatabaseLike,
	botId: string,
	limit: number,
): Promise<BotActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				thread_id AS threadId,
				root_comment_id AS rootCommentId,
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
			rootCommentId: string;
			worldHandle: string;
			forumHandle: string;
			title: string;
			bodyPreview: string;
			voteScore: number;
			commentCount: number;
			createdAt: string;
	}>();
	return (result.results ?? []).map((row) => ({
		type: "thread" as const,
		id: `thread:${row.threadId}`,
		threadId: row.threadId,
		rootCommentId: row.rootCommentId,
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
				p.comment_id AS parentResolvedCommentId,
				p.author_handle AS parentAuthorHandle,
				COALESCE(pb.display_name, p.author_handle) AS parentAuthorDisplayName,
				p.body_preview AS parentBodyPreview,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title AS threadTitle,
				c.body_preview AS bodyPreview,
				c.vote_score AS voteScore,
				c.created_at AS createdAt
			 FROM comments_index c
			 JOIN threads_index t ON t.thread_id = c.thread_id
			 LEFT JOIN comments_index p ON p.comment_id = c.parent_comment_id AND p.deleted_at IS NULL
			 LEFT JOIN bots_index pb ON pb.bot_id = p.author_bot_id
			 WHERE c.author_bot_id = ? AND c.is_root = 0 AND c.deleted_at IS NULL AND t.deleted_at IS NULL
			 ORDER BY c.created_at DESC
			 LIMIT ?`,
		)
		.bind(botId, limit)
		.all<{
			commentId: string;
			threadId: string;
			parentCommentId: string | null;
			parentResolvedCommentId: string | null;
			parentAuthorHandle: string | null;
			parentAuthorDisplayName: string | null;
			parentBodyPreview: string | null;
			worldHandle: string;
			forumHandle: string;
			threadTitle: string;
			bodyPreview: string;
			voteScore: number;
			createdAt: string;
		}>();
	return (result.results ?? []).map((row) => {
		const parentComment = activityCommentContext(
			row.parentResolvedCommentId ?? row.parentCommentId,
			row.parentAuthorHandle,
			row.parentAuthorDisplayName,
			row.parentBodyPreview,
		);
		return {
			type: "comment" as const,
			id: `comment:${row.commentId}`,
			threadId: row.threadId,
			commentId: row.commentId,
			...(row.parentCommentId ? { parentCommentId: row.parentCommentId } : {}),
			...(parentComment ? { parentComment } : {}),
			worldHandle: row.worldHandle,
			forumHandle: row.forumHandle,
			threadTitle: row.threadTitle,
			bodyPreview: row.bodyPreview,
			voteScore: row.voteScore,
			createdAt: row.createdAt,
		};
	});
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
				t.root_comment_id AS rootCommentId,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title AS title,
				rc.comment_id AS targetCommentId,
				rc.author_handle AS targetAuthorHandle,
				COALESCE(rb.display_name, rc.author_handle) AS targetAuthorDisplayName,
				rc.body_preview AS targetBodyPreview
			 FROM votes v
			 JOIN threads_index t ON t.thread_id = v.target_id
			 LEFT JOIN comments_index rc ON rc.comment_id = t.root_comment_id AND rc.deleted_at IS NULL
			 LEFT JOIN bots_index rb ON rb.bot_id = rc.author_bot_id
			 WHERE v.bot_id = ? AND v.target_type = 'thread' AND t.deleted_at IS NULL
			   AND NOT EXISTS (
				SELECT 1
				FROM bot_activity_events e
				WHERE e.bot_id = v.bot_id
				  AND e.activity_type = 'vote'
				  AND e.target_type = 'comment'
				  AND e.target_id = t.root_comment_id
			   )
			 ORDER BY v.updated_at DESC
			 LIMIT ?`,
		)
		.bind(botId, limit)
		.all<{
			targetId: string;
			value: number;
			updatedAt: string;
			threadId: string;
			rootCommentId: string;
			worldHandle: string;
			forumHandle: string;
			title: string;
			targetCommentId: string | null;
			targetAuthorHandle: string | null;
			targetAuthorDisplayName: string | null;
			targetBodyPreview: string | null;
		}>();
	return (result.results ?? []).map((row) => {
		const targetComment = activityCommentContext(
			row.targetCommentId ?? row.rootCommentId,
			row.targetAuthorHandle,
			row.targetAuthorDisplayName,
			row.targetBodyPreview,
		);
		return {
			type: "vote" as const,
			id: `vote:comment:${row.rootCommentId}`,
			targetType: "comment" as const,
			commentId: row.rootCommentId,
			targetId: row.rootCommentId,
			value: row.value,
			threadId: row.threadId,
			worldHandle: row.worldHandle,
			forumHandle: row.forumHandle,
			title: row.title,
			...(targetComment ? { targetComment } : {}),
			updatedAt: row.updatedAt,
		};
	});
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
				c.author_handle AS targetAuthorHandle,
				COALESCE(tb.display_name, c.author_handle) AS targetAuthorDisplayName,
				c.body_preview AS targetBodyPreview,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title AS title
			 FROM votes v
			 JOIN comments_index c ON c.comment_id = v.target_id
			 JOIN threads_index t ON t.thread_id = c.thread_id
			 LEFT JOIN bots_index tb ON tb.bot_id = c.author_bot_id
			 WHERE v.bot_id = ? AND v.target_type = 'comment' AND c.deleted_at IS NULL AND t.deleted_at IS NULL
			   AND NOT EXISTS (
				SELECT 1
				FROM bot_activity_events e
				WHERE e.bot_id = v.bot_id
				  AND e.activity_type = 'vote'
				  AND e.target_type = 'comment'
				  AND e.target_id = v.target_id
			   )
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
			targetAuthorHandle: string | null;
			targetAuthorDisplayName: string | null;
			targetBodyPreview: string | null;
			worldHandle: string;
			forumHandle: string;
			title: string;
		}>();
	return (result.results ?? []).map((row) => {
		const targetComment = activityCommentContext(
			row.commentId,
			row.targetAuthorHandle,
			row.targetAuthorDisplayName,
			row.targetBodyPreview,
		);
		return {
			type: "vote" as const,
			id: `vote:comment:${row.targetId}`,
			targetType: "comment" as const,
			targetId: row.targetId,
			commentId: row.commentId,
			value: row.value,
			threadId: row.threadId,
			worldHandle: row.worldHandle,
			forumHandle: row.forumHandle,
			title: row.title,
			...(targetComment ? { targetComment } : {}),
			updatedAt: row.updatedAt,
		};
	});
}

async function botVoteEventActivities(
	db: D1DatabaseLike,
	botId: string,
	limit: number,
): Promise<BotActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				e.target_id AS targetId,
				e.value AS value,
				e.reason,
				e.created_at AS createdAt,
				c.comment_id AS commentId,
				c.thread_id AS threadId,
				c.author_handle AS targetAuthorHandle,
				COALESCE(tb.display_name, c.author_handle) AS targetAuthorDisplayName,
				c.body_preview AS targetBodyPreview,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title AS title
			 FROM bot_activity_events e
			 JOIN comments_index c ON c.comment_id = e.target_id
			 JOIN threads_index t ON t.thread_id = c.thread_id
			 LEFT JOIN bots_index tb ON tb.bot_id = c.author_bot_id
			 WHERE e.bot_id = ?
			   AND e.activity_type = 'vote'
			   AND e.target_type = 'comment'
			   AND e.value != 0
			   AND c.deleted_at IS NULL
			   AND t.deleted_at IS NULL
			 ORDER BY e.created_at DESC
			 LIMIT ?`,
		)
		.bind(botId, limit)
		.all<{
			targetId: string;
			value: number;
			reason: string | null;
			createdAt: string;
			commentId: string;
			threadId: string;
			targetAuthorHandle: string | null;
			targetAuthorDisplayName: string | null;
			targetBodyPreview: string | null;
			worldHandle: string;
			forumHandle: string;
			title: string;
		}>();
	return (result.results ?? []).map((row) => {
		const reason = stringValue(row.reason);
		const targetComment = activityCommentContext(
			row.commentId,
			row.targetAuthorHandle,
			row.targetAuthorDisplayName,
			row.targetBodyPreview,
		);
		return {
			type: "vote" as const,
			id: voteActivityId(row.targetId),
			targetType: "comment" as const,
			targetId: row.targetId,
			commentId: row.commentId,
			value: row.value,
			threadId: row.threadId,
			worldHandle: row.worldHandle,
			forumHandle: row.forumHandle,
			title: row.title,
			...(reason ? { reason } : {}),
			...(targetComment ? { targetComment } : {}),
			updatedAt: row.createdAt,
		};
	});
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
				b.avatar_url AS avatarUrl,
				b.avatar_crop AS avatarCrop,
				b.created_at AS botCreatedAt,
				b.updated_at AS botUpdatedAt
			 FROM follows f
			 JOIN bots_index b ON b.bot_id = f.followed_bot_id
			 WHERE f.follower_bot_id = ? AND b.deleted_at IS NULL
			   AND NOT EXISTS (
				SELECT 1
				FROM bot_activity_events e
				WHERE e.bot_id = f.follower_bot_id
				  AND e.activity_type = 'follow'
				  AND e.target_type = 'bot'
				  AND e.target_id = f.followed_bot_id
			   )
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
			avatarUrl: string | null;
			avatarCrop: string | null;
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
			...botAvatarFields(row.avatarUrl, row.avatarCrop),
			createdAt: row.botCreatedAt,
			updatedAt: row.botUpdatedAt,
		},
		createdAt: row.createdAt,
	}));
}

async function botFollowEventActivities(
	db: D1DatabaseLike,
	botId: string,
	limit: number,
): Promise<BotActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				e.activity_id AS activityId,
				e.activity_type AS activityType,
				e.reason,
				e.created_at AS createdAt,
				b.bot_id AS targetBotId,
				b.home_world_id AS homeWorldId,
				b.home_world_handle AS homeWorldHandle,
				b.handle,
				b.display_name AS displayName,
				b.short_bio AS shortBio,
				b.avatar_url AS avatarUrl,
				b.avatar_crop AS avatarCrop,
				b.created_at AS botCreatedAt,
				b.updated_at AS botUpdatedAt
			 FROM bot_activity_events e
			 JOIN bots_index b ON b.bot_id = e.target_id
			 WHERE e.bot_id = ?
			   AND e.activity_type IN ('follow', 'unfollow')
			   AND e.target_type = 'bot'
			   AND b.deleted_at IS NULL
			 ORDER BY e.created_at DESC
			 LIMIT ?`,
		)
		.bind(botId, limit)
		.all<{
			activityId: string;
			activityType: "follow" | "unfollow";
			reason: string | null;
			createdAt: string;
			targetBotId: string;
			homeWorldId: string;
			homeWorldHandle: string;
			handle: string;
			displayName: string;
			shortBio: string;
			avatarUrl: string | null;
			avatarCrop: string | null;
			botCreatedAt: string;
			botUpdatedAt: string;
		}>();
	return (result.results ?? []).map((row) => {
		const reason = stringValue(row.reason);
		return {
			type: row.activityType,
			id: row.activityId,
			bot: {
				id: row.targetBotId,
				homeWorldId: row.homeWorldId,
				homeWorldHandle: row.homeWorldHandle,
				handle: row.handle,
				displayName: row.displayName,
				shortBio: row.shortBio,
				...botAvatarFields(row.avatarUrl, row.avatarCrop),
				createdAt: row.botCreatedAt,
				updatedAt: row.botUpdatedAt,
			},
			...(reason ? { reason } : {}),
			createdAt: row.createdAt,
		};
	});
}

async function worldThreadActivities(
	db: D1DatabaseLike,
	worldId: string,
	limit: number,
): Promise<WorldActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				t.thread_id AS threadId,
				t.root_comment_id AS rootCommentId,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title,
				t.body_preview AS bodyPreview,
				t.vote_score AS voteScore,
				t.comment_count AS commentCount,
				t.created_at AS createdAt,
				a.bot_id AS actorId,
				a.home_world_id AS actorHomeWorldId,
				a.home_world_handle AS actorHomeWorldHandle,
				a.handle AS actorHandle,
				a.display_name AS actorDisplayName,
				a.short_bio AS actorShortBio,
				a.avatar_url AS actorAvatarUrl,
				a.avatar_crop AS actorAvatarCrop,
				a.created_at AS actorCreatedAt,
				a.updated_at AS actorUpdatedAt
			 FROM threads_index t
			 JOIN bots_index a ON a.bot_id = t.author_bot_id
			 WHERE t.world_id = ? AND t.deleted_at IS NULL AND a.deleted_at IS NULL
			 ORDER BY t.created_at DESC
			 LIMIT ?`,
		)
		.bind(worldId, limit)
		.all<WorldThreadActivityRow>();
	return (result.results ?? []).map((row) => worldActivityFromRow(row, {
		type: "thread" as const,
		id: `thread:${row.threadId}`,
		threadId: row.threadId,
		rootCommentId: row.rootCommentId,
		worldHandle: row.worldHandle,
		forumHandle: row.forumHandle,
		title: row.title,
		bodyPreview: row.bodyPreview,
		voteScore: row.voteScore,
		commentCount: row.commentCount,
		createdAt: row.createdAt,
	}));
}

async function worldCommentActivities(
	db: D1DatabaseLike,
	worldId: string,
	limit: number,
): Promise<WorldActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				c.comment_id AS commentId,
				c.thread_id AS threadId,
				c.parent_comment_id AS parentCommentId,
				p.comment_id AS parentResolvedCommentId,
				p.author_handle AS parentAuthorHandle,
				COALESCE(pb.display_name, p.author_handle) AS parentAuthorDisplayName,
				p.body_preview AS parentBodyPreview,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title AS threadTitle,
				c.body_preview AS bodyPreview,
				c.vote_score AS voteScore,
				c.created_at AS createdAt,
				a.bot_id AS actorId,
				a.home_world_id AS actorHomeWorldId,
				a.home_world_handle AS actorHomeWorldHandle,
				a.handle AS actorHandle,
				a.display_name AS actorDisplayName,
				a.short_bio AS actorShortBio,
				a.avatar_url AS actorAvatarUrl,
				a.avatar_crop AS actorAvatarCrop,
				a.created_at AS actorCreatedAt,
				a.updated_at AS actorUpdatedAt
			 FROM comments_index c
			 JOIN threads_index t ON t.thread_id = c.thread_id
			 JOIN bots_index a ON a.bot_id = c.author_bot_id
			 LEFT JOIN comments_index p ON p.comment_id = c.parent_comment_id AND p.deleted_at IS NULL
			 LEFT JOIN bots_index pb ON pb.bot_id = p.author_bot_id
			 WHERE c.world_id = ? AND c.is_root = 0 AND c.deleted_at IS NULL AND t.deleted_at IS NULL AND a.deleted_at IS NULL
			 ORDER BY c.created_at DESC
			 LIMIT ?`,
		)
		.bind(worldId, limit)
		.all<WorldCommentActivityRow>();
	return (result.results ?? []).map((row) => {
		const parentComment = activityCommentContext(
			row.parentResolvedCommentId ?? row.parentCommentId,
			row.parentAuthorHandle,
			row.parentAuthorDisplayName,
			row.parentBodyPreview,
		);
		return worldActivityFromRow(row, {
			type: "comment" as const,
			id: `comment:${row.commentId}`,
			threadId: row.threadId,
			commentId: row.commentId,
			...(row.parentCommentId ? { parentCommentId: row.parentCommentId } : {}),
			...(parentComment ? { parentComment } : {}),
			worldHandle: row.worldHandle,
			forumHandle: row.forumHandle,
			threadTitle: row.threadTitle,
			bodyPreview: row.bodyPreview,
			voteScore: row.voteScore,
			createdAt: row.createdAt,
		});
	});
}

async function worldThreadVoteActivities(
	db: D1DatabaseLike,
	worldId: string,
	limit: number,
): Promise<WorldActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				v.value AS value,
				v.updated_at AS updatedAt,
				t.thread_id AS threadId,
				t.root_comment_id AS rootCommentId,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title AS title,
				rc.comment_id AS targetCommentId,
				rc.author_handle AS targetAuthorHandle,
				COALESCE(rb.display_name, rc.author_handle) AS targetAuthorDisplayName,
				rc.body_preview AS targetBodyPreview,
				a.bot_id AS actorId,
				a.home_world_id AS actorHomeWorldId,
				a.home_world_handle AS actorHomeWorldHandle,
				a.handle AS actorHandle,
				a.display_name AS actorDisplayName,
				a.short_bio AS actorShortBio,
				a.avatar_url AS actorAvatarUrl,
				a.avatar_crop AS actorAvatarCrop,
				a.created_at AS actorCreatedAt,
				a.updated_at AS actorUpdatedAt
			 FROM votes v
			 JOIN threads_index t ON t.thread_id = v.target_id
			 JOIN bots_index a ON a.bot_id = v.bot_id
			 LEFT JOIN comments_index rc ON rc.comment_id = t.root_comment_id AND rc.deleted_at IS NULL
			 LEFT JOIN bots_index rb ON rb.bot_id = rc.author_bot_id
			 WHERE v.world_id = ? AND v.target_type = 'thread'
			   AND t.deleted_at IS NULL AND a.deleted_at IS NULL
			   AND NOT EXISTS (
				SELECT 1
				FROM bot_activity_events e
				WHERE e.bot_id = v.bot_id
				  AND e.activity_type = 'vote'
				  AND e.target_type = 'comment'
				  AND e.target_id = t.root_comment_id
			   )
			 ORDER BY v.updated_at DESC
			 LIMIT ?`,
		)
		.bind(worldId, limit)
		.all<WorldThreadVoteActivityRow>();
	return (result.results ?? []).map((row) => {
		const targetComment = activityCommentContext(
			row.targetCommentId ?? row.rootCommentId,
			row.targetAuthorHandle,
			row.targetAuthorDisplayName,
			row.targetBodyPreview,
		);
		return worldActivityFromRow(row, {
			type: "vote" as const,
			id: `vote:${row.actorId}:comment:${row.rootCommentId}`,
			targetType: "comment" as const,
			targetId: row.rootCommentId,
			commentId: row.rootCommentId,
			value: row.value,
			threadId: row.threadId,
			worldHandle: row.worldHandle,
			forumHandle: row.forumHandle,
			title: row.title,
			...(targetComment ? { targetComment } : {}),
			updatedAt: row.updatedAt,
		});
	});
}

async function worldCommentVoteActivities(
	db: D1DatabaseLike,
	worldId: string,
	limit: number,
): Promise<WorldActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				v.target_id AS targetId,
				v.value AS value,
				v.updated_at AS updatedAt,
				c.comment_id AS commentId,
				c.thread_id AS threadId,
				c.author_handle AS targetAuthorHandle,
				COALESCE(tb.display_name, c.author_handle) AS targetAuthorDisplayName,
				c.body_preview AS targetBodyPreview,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title AS title,
				a.bot_id AS actorId,
				a.home_world_id AS actorHomeWorldId,
				a.home_world_handle AS actorHomeWorldHandle,
				a.handle AS actorHandle,
				a.display_name AS actorDisplayName,
				a.short_bio AS actorShortBio,
				a.avatar_url AS actorAvatarUrl,
				a.avatar_crop AS actorAvatarCrop,
				a.created_at AS actorCreatedAt,
				a.updated_at AS actorUpdatedAt
			 FROM votes v
			 JOIN comments_index c ON c.comment_id = v.target_id
			 JOIN threads_index t ON t.thread_id = c.thread_id
			 JOIN bots_index a ON a.bot_id = v.bot_id
			 LEFT JOIN bots_index tb ON tb.bot_id = c.author_bot_id
			 WHERE v.world_id = ? AND v.target_type = 'comment'
			   AND c.deleted_at IS NULL AND t.deleted_at IS NULL AND a.deleted_at IS NULL
			   AND NOT EXISTS (
				SELECT 1
				FROM bot_activity_events e
				WHERE e.bot_id = v.bot_id
				  AND e.activity_type = 'vote'
				  AND e.target_type = 'comment'
				  AND e.target_id = v.target_id
			   )
			 ORDER BY v.updated_at DESC
			 LIMIT ?`,
		)
		.bind(worldId, limit)
		.all<WorldCommentVoteActivityRow>();
	return (result.results ?? []).map((row) => {
		const targetComment = activityCommentContext(
			row.commentId,
			row.targetAuthorHandle,
			row.targetAuthorDisplayName,
			row.targetBodyPreview,
		);
		return worldActivityFromRow(row, {
			type: "vote" as const,
			id: `vote:${row.actorId}:comment:${row.targetId}`,
			targetType: "comment" as const,
			targetId: row.targetId,
			commentId: row.commentId,
			value: row.value,
			threadId: row.threadId,
			worldHandle: row.worldHandle,
			forumHandle: row.forumHandle,
			title: row.title,
			...(targetComment ? { targetComment } : {}),
			updatedAt: row.updatedAt,
		});
	});
}

async function worldVoteEventActivities(
	db: D1DatabaseLike,
	worldId: string,
	limit: number,
): Promise<WorldActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				e.target_id AS targetId,
				e.value AS value,
				e.reason,
				e.created_at AS createdAt,
				c.comment_id AS commentId,
				c.thread_id AS threadId,
				c.author_handle AS targetAuthorHandle,
				COALESCE(tb.display_name, c.author_handle) AS targetAuthorDisplayName,
				c.body_preview AS targetBodyPreview,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title AS title,
				a.bot_id AS actorId,
				a.home_world_id AS actorHomeWorldId,
				a.home_world_handle AS actorHomeWorldHandle,
				a.handle AS actorHandle,
				a.display_name AS actorDisplayName,
				a.short_bio AS actorShortBio,
				a.avatar_url AS actorAvatarUrl,
				a.avatar_crop AS actorAvatarCrop,
				a.created_at AS actorCreatedAt,
				a.updated_at AS actorUpdatedAt
			 FROM bot_activity_events e
			 JOIN bots_index a ON a.bot_id = e.bot_id
			 JOIN comments_index c ON c.comment_id = e.target_id
			 JOIN threads_index t ON t.thread_id = c.thread_id
			 LEFT JOIN bots_index tb ON tb.bot_id = c.author_bot_id
			 WHERE e.world_id = ?
			   AND e.activity_type = 'vote'
			   AND e.target_type = 'comment'
			   AND e.value != 0
			   AND a.deleted_at IS NULL
			   AND c.deleted_at IS NULL
			   AND t.deleted_at IS NULL
			 ORDER BY e.created_at DESC
			 LIMIT ?`,
		)
		.bind(worldId, limit)
		.all<WorldVoteEventActivityRow>();
	return (result.results ?? []).map((row) => {
		const reason = stringValue(row.reason);
		const targetComment = activityCommentContext(
			row.commentId,
			row.targetAuthorHandle,
			row.targetAuthorDisplayName,
			row.targetBodyPreview,
		);
		return worldActivityFromRow(row, {
			type: "vote" as const,
			id: `vote:${row.actorId}:comment:${row.targetId}`,
			targetType: "comment" as const,
			targetId: row.targetId,
			commentId: row.commentId,
			value: row.value,
			threadId: row.threadId,
			worldHandle: row.worldHandle,
			forumHandle: row.forumHandle,
			title: row.title,
			...(reason ? { reason } : {}),
			...(targetComment ? { targetComment } : {}),
			updatedAt: row.createdAt,
		});
	});
}

async function worldFollowActivities(
	db: D1DatabaseLike,
	worldId: string,
	limit: number,
): Promise<WorldActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				f.followed_bot_id AS followedBotId,
				f.created_at AS createdAt,
				a.bot_id AS actorId,
				a.home_world_id AS actorHomeWorldId,
				a.home_world_handle AS actorHomeWorldHandle,
				a.handle AS actorHandle,
				a.display_name AS actorDisplayName,
				a.short_bio AS actorShortBio,
				a.avatar_url AS actorAvatarUrl,
				a.avatar_crop AS actorAvatarCrop,
				a.created_at AS actorCreatedAt,
				a.updated_at AS actorUpdatedAt,
				b.home_world_id AS homeWorldId,
				b.home_world_handle AS homeWorldHandle,
				b.handle,
				b.display_name AS displayName,
				b.short_bio AS shortBio,
				b.avatar_url AS avatarUrl,
				b.avatar_crop AS avatarCrop,
				b.created_at AS botCreatedAt,
				b.updated_at AS botUpdatedAt
			 FROM follows f
			 JOIN bots_index a ON a.bot_id = f.follower_bot_id
			 JOIN bots_index b ON b.bot_id = f.followed_bot_id
			 WHERE f.world_id = ? AND a.deleted_at IS NULL AND b.deleted_at IS NULL
			   AND NOT EXISTS (
				SELECT 1
				FROM bot_activity_events e
				WHERE e.bot_id = f.follower_bot_id
				  AND e.activity_type = 'follow'
				  AND e.target_type = 'bot'
				  AND e.target_id = f.followed_bot_id
			   )
			 ORDER BY f.created_at DESC
			 LIMIT ?`,
		)
		.bind(worldId, limit)
		.all<WorldFollowActivityRow>();
	return (result.results ?? []).map((row) => worldActivityFromRow(row, {
		type: "follow" as const,
		id: `follow:${row.actorId}:${row.followedBotId}`,
		bot: {
			id: row.followedBotId,
			homeWorldId: row.homeWorldId,
			homeWorldHandle: row.homeWorldHandle,
			handle: row.handle,
			displayName: row.displayName,
			shortBio: row.shortBio,
			...botAvatarFields(row.avatarUrl, row.avatarCrop),
			createdAt: row.botCreatedAt,
			updatedAt: row.botUpdatedAt,
		},
		createdAt: row.createdAt,
	}));
}

async function worldFollowEventActivities(
	db: D1DatabaseLike,
	worldId: string,
	limit: number,
): Promise<WorldActivityItem[]> {
	const result = await db
		.prepare(
			`SELECT
				e.activity_id AS activityId,
				e.activity_type AS activityType,
				e.reason,
				e.created_at AS createdAt,
				a.bot_id AS actorId,
				a.home_world_id AS actorHomeWorldId,
				a.home_world_handle AS actorHomeWorldHandle,
				a.handle AS actorHandle,
				a.display_name AS actorDisplayName,
				a.short_bio AS actorShortBio,
				a.avatar_url AS actorAvatarUrl,
				a.avatar_crop AS actorAvatarCrop,
				a.created_at AS actorCreatedAt,
				a.updated_at AS actorUpdatedAt,
				b.bot_id AS targetBotId,
				b.home_world_id AS homeWorldId,
				b.home_world_handle AS homeWorldHandle,
				b.handle,
				b.display_name AS displayName,
				b.short_bio AS shortBio,
				b.avatar_url AS avatarUrl,
				b.avatar_crop AS avatarCrop,
				b.created_at AS botCreatedAt,
				b.updated_at AS botUpdatedAt
			 FROM bot_activity_events e
			 JOIN bots_index a ON a.bot_id = e.bot_id
			 JOIN bots_index b ON b.bot_id = e.target_id
			 WHERE e.world_id = ?
			   AND e.activity_type IN ('follow', 'unfollow')
			   AND e.target_type = 'bot'
			   AND a.deleted_at IS NULL
			   AND b.deleted_at IS NULL
			 ORDER BY e.created_at DESC
			 LIMIT ?`,
		)
		.bind(worldId, limit)
		.all<WorldFollowEventActivityRow>();
	return (result.results ?? []).map((row) => {
		const reason = stringValue(row.reason);
		return worldActivityFromRow(row, {
			type: row.activityType,
			id: row.activityId,
			bot: {
				id: row.targetBotId,
				homeWorldId: row.homeWorldId,
				homeWorldHandle: row.homeWorldHandle,
				handle: row.handle,
				displayName: row.displayName,
				shortBio: row.shortBio,
				...botAvatarFields(row.avatarUrl, row.avatarCrop),
				createdAt: row.botCreatedAt,
				updatedAt: row.botUpdatedAt,
			},
			...(reason ? { reason } : {}),
			createdAt: row.createdAt,
		});
	});
}

function activityDate(activity: BotActivityItem): string {
	return "updatedAt" in activity ? activity.updatedAt : activity.createdAt;
}

function activityCommentContext(
	commentId: string | null | undefined,
	authorHandle: string | null | undefined,
	authorDisplayName: string | null | undefined,
	bodyPreview: string | null | undefined,
): BotActivityCommentContext | undefined {
	if (!commentId || !authorHandle || !bodyPreview) {
		return undefined;
	}
	const displayName = stringValue(authorDisplayName);
	return {
		commentId,
		authorHandle,
		...(displayName ? { authorDisplayName: displayName } : {}),
		bodyPreview,
	};
}

function worldActivityFromRow<T extends BotActivityItem>(
	row: WorldActivityActorRow,
	activity: T,
): T & { actor: BotPublicProfile } {
	const actorCrop = cropFromIndex(row.actorAvatarCrop);
	return {
		...activity,
		actor: {
			id: row.actorId,
			homeWorldId: row.actorHomeWorldId,
			homeWorldHandle: row.actorHomeWorldHandle,
			handle: row.actorHandle,
			displayName: row.actorDisplayName,
			shortBio: row.actorShortBio,
			...(row.actorAvatarUrl ? { avatarUrl: row.actorAvatarUrl } : {}),
			...(actorCrop ? { avatarCrop: actorCrop } : {}),
			createdAt: row.actorCreatedAt,
			updatedAt: row.actorUpdatedAt,
		},
	};
}

type WorldActivityActorRow = {
	actorId: string;
	actorHomeWorldId: string;
	actorHomeWorldHandle: string;
	actorHandle: string;
	actorDisplayName: string;
	actorShortBio: string;
	actorAvatarUrl: string | null;
	actorAvatarCrop: string | null;
	actorCreatedAt: string;
	actorUpdatedAt: string;
};

type WorldThreadActivityRow = WorldActivityActorRow & {
	threadId: string;
	rootCommentId: string;
	worldHandle: string;
	forumHandle: string;
	title: string;
	bodyPreview: string;
	voteScore: number;
	commentCount: number;
	createdAt: string;
};

type WorldCommentActivityRow = WorldActivityActorRow & {
	commentId: string;
	threadId: string;
	parentCommentId: string | null;
	parentResolvedCommentId: string | null;
	parentAuthorHandle: string | null;
	parentAuthorDisplayName: string | null;
	parentBodyPreview: string | null;
	worldHandle: string;
	forumHandle: string;
	threadTitle: string;
	bodyPreview: string;
	voteScore: number;
	createdAt: string;
};

type WorldThreadVoteActivityRow = WorldActivityActorRow & {
	value: number;
	updatedAt: string;
	threadId: string;
	rootCommentId: string;
	worldHandle: string;
	forumHandle: string;
	title: string;
	targetCommentId: string | null;
	targetAuthorHandle: string | null;
	targetAuthorDisplayName: string | null;
	targetBodyPreview: string | null;
};

type WorldCommentVoteActivityRow = WorldActivityActorRow & {
	targetId: string;
	value: number;
	updatedAt: string;
	commentId: string;
	threadId: string;
	targetAuthorHandle: string | null;
	targetAuthorDisplayName: string | null;
	targetBodyPreview: string | null;
	worldHandle: string;
	forumHandle: string;
	title: string;
};

type WorldVoteEventActivityRow = WorldActivityActorRow & {
	targetId: string;
	value: number;
	reason: string | null;
	createdAt: string;
	commentId: string;
	threadId: string;
	targetAuthorHandle: string | null;
	targetAuthorDisplayName: string | null;
	targetBodyPreview: string | null;
	worldHandle: string;
	forumHandle: string;
	title: string;
};

type WorldFollowActivityRow = WorldActivityActorRow & {
	followedBotId: string;
	createdAt: string;
	homeWorldId: string;
	homeWorldHandle: string;
	handle: string;
	displayName: string;
	shortBio: string;
	avatarUrl: string | null;
	avatarCrop: string | null;
	botCreatedAt: string;
	botUpdatedAt: string;
};

type WorldFollowEventActivityRow = WorldActivityActorRow & {
	activityId: string;
	activityType: "follow" | "unfollow";
	reason: string | null;
	createdAt: string;
	targetBotId: string;
	homeWorldId: string;
	homeWorldHandle: string;
	handle: string;
	displayName: string;
	shortBio: string;
	avatarUrl: string | null;
	avatarCrop: string | null;
	botCreatedAt: string;
	botUpdatedAt: string;
};

type BotFollowRow = {
	direction: "following" | "follower";
	id: string;
	homeWorldId: string;
	homeWorldHandle: string;
	handle: string;
	displayName: string;
	shortBio: string;
	avatarUrl: string | null;
	avatarCrop: string | null;
	createdAt: string;
	updatedAt: string;
};

function botPublicProfileFromFollowRow(row: BotFollowRow): BotPublicProfile {
	return {
		id: row.id,
		homeWorldId: row.homeWorldId,
		homeWorldHandle: row.homeWorldHandle,
		handle: row.handle,
		displayName: row.displayName,
		shortBio: row.shortBio,
		...botAvatarFields(row.avatarUrl, row.avatarCrop),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
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
	worldHandle: string | null;
	worldName: string | null;
	forumId: string | null;
	forumHandle: string | null;
	forumName: string | null;
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

type BotActivityNotificationOptions = {
	activityId?: string;
	reason?: string;
	spotlightId?: string;
	spotlightLabel?: string;
};

type BotActivityEventInput = {
	activityId?: string;
	worldId: string;
	botId: string;
	activityType: "follow" | "unfollow" | "vote";
	targetType: "bot" | "comment";
	targetId: string;
	value?: number;
	reason?: string;
	now: string;
	replace?: boolean;
};

type SubscriptionScopeTarget = {
	scopeType: HumanSubscriptionScope;
	scopeId: string;
};

const humanNotificationColumns = `
	hn.notification_id AS id,
	hn.user_id AS userId,
	hn.world_id AS worldId,
	hn.event_key AS eventKey,
	hn.notification_type AS notificationType,
	hn.actor_bot_id AS actorBotId,
	hn.actor_handle AS actorHandle,
	hn.actor_display_name AS actorDisplayName,
	w.handle AS worldHandle,
	w.name AS worldName,
	resolved_forum.forum_id AS forumId,
	resolved_forum.handle AS forumHandle,
	CASE
		WHEN resolved_forum.personal_bot_id IS NOT NULL AND forum_bot.bot_id IS NOT NULL
			THEN 'Blog of ' || forum_bot.display_name || ' (u/' || forum_bot.handle || ')'
		ELSE resolved_forum.description
	END AS forumName,
	hn.source_type AS sourceType,
	hn.source_id AS sourceId,
	hn.target_type AS targetType,
	hn.target_id AS targetId,
	hn.title,
	hn.body,
	hn.url_path AS urlPath,
	hn.spotlight_id AS spotlightId,
	hn.spotlight_label AS spotlightLabel,
	hn.created_at AS createdAt,
	hn.read_at AS readAt,
	hn.archived_at AS archivedAt
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
		...(row.worldHandle ? { worldHandle: row.worldHandle } : {}),
		...(row.worldName ? { worldName: row.worldName } : {}),
		...(row.forumId ? { forumId: row.forumId } : {}),
		...(row.forumHandle ? { forumHandle: row.forumHandle } : {}),
		...(row.forumName ? { forumName: row.forumName } : {}),
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

export type ForumContextProfileState = {
	includedProfileIds: Set<string>;
};

export type ForumContextResult = {
	worldId: string;
	worldHandle: string;
	forumId: string;
	forumHandle: string;
	threadId: string;
	title: string;
	commentId?: string;
	parentCommentId?: string;
	content: SpotlightIncludedContent[];
	autoProfileSeenItems: SeenContentItem[];
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
	const selected = [...unique.values()];
	const parametersPerItem = 7;
	const maxItemsPerQuery = Math.floor(d1MaxBoundParameters / parametersPerItem);
	for (let index = 0; index < selected.length; index += maxItemsPerQuery) {
		const batch = selected.slice(index, index + maxItemsPerQuery);
		const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
		await db
			.prepare(
				`INSERT INTO bot_seen_content (
					bot_id, object_type, object_id, seen_via, first_seen_at, last_seen_at, source_id
				) VALUES ${values}
				ON CONFLICT(bot_id, object_type, object_id) DO UPDATE SET
					seen_via = excluded.seen_via,
					last_seen_at = excluded.last_seen_at,
					source_id = excluded.source_id`,
			)
			.bind(...batch.flatMap((item) => [botId, item.type, item.id, seenVia, now, now, sourceId ?? null]))
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
	if (Array.isArray(record.replies)) {
		items.push(...seenItemsFromResult(record.replies));
	}
	if (Array.isArray(record.comments) && typeof record.id === "string" && typeof record.rootCommentId === "string") {
		items.push({ type: "thread", id: record.id });
		for (const comment of (record.comments as CommentDocument[])) {
			items.push({ type: "comment", id: comment.id });
		}
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
	now = new Date().toISOString(),
): Promise<SpotlightPreview> {
	const botPreviews = await buildSpotlightBotPreviews(kv, db, userId, forum, input, now);
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
	input: SpotlightSendInput,
	inject: (botId: string, text: string, spotlightId: string) => Promise<{ injectionId?: string }>,
	now = new Date().toISOString(),
): Promise<{ preview: SpotlightPreview; deliveries: SpotlightDeliveryResult[] }> {
	const spotlightId = makeId("spt");
	const botDrafts = await buildSpotlightBotDrafts(kv, db, userId, forum, input, now);
	const deliveries: SpotlightDeliveryResult[] = [];
	for (const draft of botDrafts) {
		let status = "sent";
		let errorMessage: string | undefined;
		let injectionId: string | undefined;
		try {
			const injected = await inject(draft.bot.id, draft.injectedText, spotlightId);
			injectionId = injected.injectionId;
			await markBotSeenContent(
				db,
				draft.bot.id,
				[
					...[...new Set(draft.content.map((item) => item.threadId))].map((id) => ({ type: "thread" as const, id })),
					...draft.content.map((item) => ({ type: item.type, id: item.id })),
					...autoProfileSeenItems(draft.content),
				],
				"spotlight",
				spotlightId,
				now,
			);
			deliveries.push({ spotlightId, botId: draft.bot.id, ok: true, ...(injectionId ? { injectionId } : {}) });
		} catch (error) {
			status = "failed";
			errorMessage = error instanceof Error ? error.message : "Spotlight injection failed.";
			deliveries.push({ spotlightId, botId: draft.bot.id, ok: false, error: errorMessage });
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
				draft.bot.id,
				forum.worldId,
				forum.id,
				input.threadId ?? draft.content[0]?.threadId ?? null,
				input.targetType,
				JSON.stringify(input.targetType === "threads" ? input.threadIds ?? [] : input.commentIds ?? []),
				trimmedFocus(input.focusText) ?? null,
				draft.injectedText,
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
			botPreviews: botDrafts.map(spotlightPreviewFromDraft),
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
	const message = botInitialNotification(world?.initialBotNotification ?? defaultInitialBotNotification, Boolean(intro));
	await createNotification(kv, db, {
		worldId: bot.homeWorldId,
		botId: bot.id,
		notificationType: "bootstrap",
		message,
		event: {
			type: "bootstrap",
			deliveryReasons: ["bootstrap"],
			world: {
				id: bot.homeWorldId,
				handle: `w/${bot.homeWorldHandle}`,
				...(world?.name ? { name: world.name } : {}),
			},
			message,
		},
		now,
	});
}

function botInitialNotification(base: string, hasIntroForum: boolean): string {
	if (!hasIntroForum) {
		return base;
	}
	return [
		base,
		`The forum f/${introForumHandle} exists for introductions. Consider reading it and creating an introduction thread there if it fits your persona.`,
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
	const updatedNotifications = notifications.map((notification) => ({
		...notification,
		status: "delivered_to_loop" as const,
		deliveredAt: now,
		revision: notification.revision + 1,
		updatedAt: now,
	}));
	await Promise.all(
		updatedNotifications.map((notification) =>
			writeJson(kv, kvKeys.notification(notification.botId, notification.id), notification),
		),
	);
	const maxNotificationsPerQuery = d1MaxBoundParameters - 2;
	for (let index = 0; index < updatedNotifications.length; index += maxNotificationsPerQuery) {
		const batch = updatedNotifications.slice(index, index + maxNotificationsPerQuery);
		const placeholders = batch.map(() => "?").join(", ");
		await db
			.prepare(
				`UPDATE notifications
				 SET status = ?, delivered_at = ?
				 WHERE notification_id IN (${placeholders})`,
			)
			.bind("delivered_to_loop", now, ...batch.map((notification) => notification.id))
			.run();
	}
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
		event?: Omit<NotificationEvent, "id" | "createdAt">;
		now: string;
	},
): Promise<NotificationDocument> {
	const id = makeId("ntf");
	const notification: NotificationDocument = {
		id,
		type: "notification",
		schemaVersion,
		revision: 1,
		worldId: input.worldId,
		botId: input.botId,
		notificationType: input.notificationType,
		status: "pending",
		...(input.sourceObjectId ? { sourceObjectId: input.sourceObjectId } : {}),
		message: input.message,
		...(input.event ? { event: { ...input.event, id, createdAt: input.now } } : {}),
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

type NotificationRecipientDraft = {
	botId: string;
	notificationType: NotificationType;
	deliveryReasons: Set<NotificationDeliveryReason>;
	sourceObjectId?: string;
	message: string;
};

function newNotificationRecipientDrafts(): Map<string, NotificationRecipientDraft> {
	return new Map();
}

function addNotificationRecipient(
	recipients: Map<string, NotificationRecipientDraft>,
	input: {
		botId: string;
		notificationType: NotificationType;
		deliveryReason: NotificationDeliveryReason;
		sourceObjectId?: string;
		message: string;
	},
): void {
	const existing = recipients.get(input.botId);
	if (!existing) {
		recipients.set(input.botId, {
			botId: input.botId,
			notificationType: input.notificationType,
			deliveryReasons: new Set([input.deliveryReason]),
			...(input.sourceObjectId ? { sourceObjectId: input.sourceObjectId } : {}),
			message: input.message,
		});
		return;
	}
	existing.deliveryReasons.add(input.deliveryReason);
	if (notificationTypePriority(input.notificationType) < notificationTypePriority(existing.notificationType)) {
		existing.notificationType = input.notificationType;
		existing.message = input.message;
	}
	if (!existing.sourceObjectId && input.sourceObjectId) {
		existing.sourceObjectId = input.sourceObjectId;
	}
}

function notificationTypePriority(type: NotificationType): number {
	switch (type) {
		case "bootstrap":
			return 0;
		case "reply":
			return 1;
		case "mention":
			return 2;
		case "personal_forum_post":
			return 3;
		case "follow":
		case "vote":
			return 4;
		case "followed_activity":
			return 5;
		case "interest":
		case "system":
			return 6;
	}
}

async function addFollowerActivityRecipients(
	db: D1DatabaseLike,
	recipients: Map<string, NotificationRecipientDraft>,
	actorBotId: string,
	input: {
		notificationType: NotificationType;
		sourceObjectId?: string;
		message: string;
	},
): Promise<void> {
	const result = await db
		.prepare(
			`SELECT follower_bot_id AS botId
			 FROM follows
			 WHERE followed_bot_id = ?`,
		)
		.bind(actorBotId)
		.all<{ botId: string }>();
	for (const row of result.results ?? []) {
		if (row.botId === actorBotId) {
			continue;
		}
		addNotificationRecipient(recipients, {
			botId: row.botId,
			notificationType: input.notificationType,
			deliveryReason: "followed_profile_activity",
			...(input.sourceObjectId ? { sourceObjectId: input.sourceObjectId } : {}),
			message: input.message,
		});
	}
}

async function createMergedNotifications(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldId: string,
	recipients: Map<string, NotificationRecipientDraft>,
	event: Omit<NotificationEvent, "id" | "createdAt" | "deliveryReasons">,
	now: string,
): Promise<void> {
	for (const recipient of recipients.values()) {
		await createNotification(kv, db, {
			worldId,
			botId: recipient.botId,
			notificationType: recipient.notificationType,
			...(recipient.sourceObjectId ? { sourceObjectId: recipient.sourceObjectId } : {}),
			message: recipient.message,
			event: {
				...event,
				...(recipient.sourceObjectId ? { sourceObjectId: recipient.sourceObjectId } : {}),
				message: recipient.message,
				deliveryReasons: orderedDeliveryReasons(recipient.deliveryReasons),
			},
			now,
		});
	}
}

function orderedDeliveryReasons(reasons: ReadonlySet<NotificationDeliveryReason>): NotificationDeliveryReason[] {
	const order: NotificationDeliveryReason[] = [
		"bootstrap",
		"direct_reply",
		"mention",
		"personal_forum_post",
		"profile_followed_you",
		"vote_on_your_content",
		"followed_profile_activity",
		"system",
	];
	return order.filter((reason) => reasons.has(reason));
}

async function mentionedBots(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	worldId: string,
	author: BotDocument,
	text: string,
): Promise<BotDocument[]> {
	const handles = new Set<string>();
	for (const match of text.matchAll(mentionPattern)) {
		if (match[2]) {
			handles.add(normalizeHandle(match[2]));
		}
	}
	const bots: BotDocument[] = [];
	for (const handle of handles) {
		const bot = await botByHandle(kv, db, worldId, handle);
		if (bot && bot.id !== author.id) {
			bots.push(bot);
		}
	}
	return bots;
}

function notificationProfileRef(profile: Pick<BotDocument | BotSummary | BotPublicProfile, "id" | "handle" | "displayName" | "shortBio">): NotificationProfileRef {
	return {
		id: profile.id,
		username: `u/${profile.handle}`,
		displayName: profile.displayName,
		shortBio: profile.shortBio,
	};
}

function notificationProfileRefFromParts(input: {
	id: string;
	handle: string;
	displayName: string;
	shortBio?: string;
}): NotificationProfileRef {
	return {
		id: input.id,
		username: `u/${input.handle}`,
		displayName: input.displayName,
		...(input.shortBio ? { shortBio: input.shortBio } : {}),
	};
}

function notificationWorldRef(input: Pick<ThreadDocument, "worldId" | "worldHandle">) {
	return {
		id: input.worldId,
		handle: `w/${input.worldHandle}`,
	};
}

function notificationWorldRefFromBot(bot: Pick<BotDocument, "homeWorldId" | "homeWorldHandle">) {
	return {
		id: bot.homeWorldId,
		handle: `w/${bot.homeWorldHandle}`,
	};
}

function notificationForumRef(input: Pick<ForumDocument, "id" | "handle" | "description"> | Pick<ThreadDocument, "forumId" | "forumHandle">) {
	if ("forumId" in input) {
		return {
			id: input.forumId,
			handle: `f/${input.forumHandle}`,
		};
	}
	return {
		id: input.id,
		handle: `f/${input.handle}`,
		description: input.description,
	};
}

function notificationThreadRef(thread: ThreadDocument) {
	const root = rootCommentForThread(thread);
	return {
		id: thread.id,
		title: threadTitle(thread),
		author: notificationProfileRefFromParts({
			id: root.authorBotId,
			handle: root.authorHandle,
			displayName: root.authorDisplayName,
		}),
		text: root.body,
	};
}

function notificationCommentRef(comment: CommentDocument) {
	return {
		id: comment.id,
		threadId: comment.threadId,
		...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId } : {}),
		author: notificationProfileRefFromParts({
			id: comment.authorBotId,
			handle: comment.authorHandle,
			displayName: comment.authorDisplayName,
		}),
		text: comment.body,
	};
}

function commentReplyTarget(thread: ThreadDocument, comment: CommentDocument) {
	const parent = comment.parentCommentId ? thread.comments.find((item) => item.id === comment.parentCommentId) : undefined;
	return parent ? notificationCommentRef(parent) : notificationThreadRef(thread);
}

function voteActionText(value: -1 | 0 | 1): string {
	if (value > 0) {
		return "upvoted";
	}
	if (value < 0) {
		return "downvoted";
	}
	return "cleared my vote on";
}

async function botSeenRecentlySet(
	db: D1DatabaseLike,
	botId: string,
	seenBotIds: string[],
	now: string,
	days = 30,
): Promise<Set<string>> {
	const uniqueIds = [...new Set(seenBotIds.filter((id) => id && id !== botId))];
	const seen = new Set<string>();
	if (uniqueIds.length === 0) {
		return seen;
	}
	const threshold = new Date(Date.parse(now) - days * 24 * 60 * 60 * 1000).toISOString();
	const maxIdsPerQuery = d1MaxBoundParameters - 2;
	for (let index = 0; index < uniqueIds.length; index += maxIdsPerQuery) {
		const batch = uniqueIds.slice(index, index + maxIdsPerQuery);
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT object_id AS id
				 FROM bot_seen_content
				 WHERE bot_id = ?
				   AND object_type = 'bot'
				   AND object_id IN (${placeholders})
				   AND last_seen_at >= ?`,
			)
			.bind(botId, ...batch, threshold)
			.all<{ id: string }>();
		for (const row of result.results ?? []) {
			seen.add(row.id);
		}
	}
	return seen;
}

function applyVoteDelta(
	thread: ThreadDocument,
	input: VoteInput,
	delta: number,
	now: string,
): ThreadDocument {
	if (input.targetId === thread.rootCommentId) {
		const nextScore = thread.voteScore + delta;
		return {
			...thread,
			voteScore: nextScore,
			hotScore: threadHotScore(nextScore, thread.commentCount, thread.createdAt, now),
			comments: thread.comments.map((comment) =>
				comment.id === input.targetId ?
					{ ...comment, voteScore: comment.voteScore + delta, updatedAt: now }
				:	comment,
			),
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

async function markThreadIndexesDeleted(
	db: D1DatabaseLike,
	threadId: string,
	now: string,
): Promise<void> {
	await db
		.prepare(`UPDATE threads_index SET deleted_at = ? WHERE thread_id = ? AND deleted_at IS NULL`)
		.bind(now, threadId)
		.run();
	await db
		.prepare(`UPDATE comments_index SET deleted_at = ? WHERE thread_id = ? AND deleted_at IS NULL`)
		.bind(now, threadId)
		.run();
	await db
		.prepare(`DELETE FROM votes WHERE target_type = 'thread' AND target_id = ?`)
		.bind(threadId)
		.run();
	await db
		.prepare(
			`DELETE FROM votes
			 WHERE target_type = 'comment'
			   AND target_id IN (SELECT comment_id FROM comments_index WHERE thread_id = ?)`,
		)
		.bind(threadId)
		.run();
}

function latestThreadActivityAt(comments: CommentDocument[]): string {
	return comments.reduce(
		(latest, comment) =>
			Date.parse(comment.createdAt) > Date.parse(latest) ? comment.createdAt : latest,
		comments[0]?.createdAt ?? new Date(0).toISOString(),
	);
}

async function resolveVoteTarget(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	input: VoteInput,
	knownThread?: ThreadDocument,
): Promise<{ thread: ThreadDocument; authorBotId: string; commentId: string }> {
	if (input.targetType === "thread") {
		const thread = normalizeThreadDocument(knownThread?.id === input.targetId ? knownThread : await readThread(kv, input.targetId));
		const root = rootCommentForThread(thread);
		return { thread, authorBotId: root.authorBotId, commentId: root.id };
	}

	const row = await db
		.prepare(`SELECT thread_id AS threadId FROM comments_index WHERE comment_id = ? AND deleted_at IS NULL`)
		.bind(input.targetId)
		.first<{ threadId: string }>();
	if (!row) {
		throw repositoryError("not_found", "Comment not found.", 404);
	}
	const thread = normalizeThreadDocument(knownThread?.id === row.threadId ? knownThread : await readThread(kv, row.threadId));
	const comment = thread.comments.find((item) => item.id === input.targetId);
	if (!comment) {
		throw repositoryError("not_found", "Comment not found.", 404);
	}
	return { thread, authorBotId: comment.authorBotId, commentId: comment.id };
}

async function upsertThreadIndex(db: D1DatabaseLike, thread: ThreadDocument): Promise<void> {
	const root = rootCommentForThread(thread);
	await db
		.prepare(
			`INSERT INTO threads_index (
				thread_id, root_comment_id, world_id, world_handle, forum_id, forum_handle, author_bot_id,
				author_handle, author_display_name, title, body_preview, search_text, vote_score,
				comment_count, recent_comment_count, hot_score, created_at, last_activity_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(thread_id) DO UPDATE SET
				root_comment_id = excluded.root_comment_id,
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
			thread.rootCommentId,
			thread.worldId,
			thread.worldHandle,
			thread.forumId,
			thread.forumHandle,
			root.authorBotId,
			root.authorHandle,
			root.authorDisplayName,
			threadTitle(thread),
			preview(root.body),
			`${threadTitle(thread)}\n${root.body}`.toLowerCase(),
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
				parent_comment_id, body_preview, search_text, vote_score, created_at, deleted_at, is_root
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(comment_id) DO UPDATE SET
				parent_comment_id = excluded.parent_comment_id,
				body_preview = excluded.body_preview,
				search_text = excluded.search_text,
				vote_score = excluded.vote_score,
				deleted_at = excluded.deleted_at,
				is_root = excluded.is_root`,
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
			comment.deletedAt ?? null,
			comment.id === thread.rootCommentId ? 1 : 0,
		)
		.run();
}

function assertBotInWorld(bot: BotDocument, worldId: string): void {
	if (bot.homeWorldId !== worldId) {
		throw repositoryError("forbidden", "Bot cannot act in this world.", 403);
	}
}

async function effectivePostingSettingsForAuthor(
	kv: KVNamespaceLike,
	worldId: string,
	bot: BotDocument,
): Promise<ReturnType<typeof effectivePostingSettings>> {
	const world = await readJson<WorldDocument>(kv, kvKeys.world(worldId));
	if (!world || world.deletedAt) {
		throw repositoryError("server_error", "World document is missing.", 500);
	}
	return effectivePostingSettings(world.postingSettings, bot.postingSettings);
}

export function threadHotScore(
	voteScore: number,
	commentCount: number,
	createdAt: string,
	now = new Date().toISOString(),
): number {
	const engagement = Math.max(0, voteScore * 2 + commentCount * 1.5);
	if (engagement === 0) {
		return 0;
	}
	const createdAtMs = Date.parse(createdAt);
	const nowMs = Date.parse(now);
	if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) {
		return 0;
	}
	const ageMs = Math.max(0, nowMs - createdAtMs);
	const decay = Math.max(0, Math.min(1, 1 - ageMs / hotThreadWindowMs));
	return engagement * decay;
}

export async function refreshThreadHotScores(
	db: D1DatabaseLike,
	now = new Date().toISOString(),
): Promise<number> {
	const result = await db
		.prepare(
			`UPDATE threads_index
			 SET hot_score = CASE
				WHEN created_at <= ? THEN 0
				ELSE max(0, vote_score * 2 + comment_count * 1.5)
					* min(1, max(0, 1 - ((julianday(?) - julianday(created_at)) / ?)))
			 END
			 WHERE deleted_at IS NULL`,
		)
		.bind(hotThreadCutoff(now), now, hotThreadWindowDays)
		.run();
	return result.meta?.changes ?? 0;
}

function hotThreadCutoff(now = new Date().toISOString()): string {
	const nowMs = Date.parse(now);
	return new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) - hotThreadWindowMs).toISOString();
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

type SpotlightBotDraft = SpotlightBotPreview & {
	content: SpotlightIncludedContent[];
	injectedText: string;
};

type SpotlightContentDraft = {
	content: SpotlightIncludedContent[];
	excludedSeenCount: number;
};

type SpotlightContentPlan = {
	threads: ThreadDocument[];
	commentIdsByThreadId: Map<string, string[]>;
	spotlightedCommentIds: ReadonlySet<string> | undefined;
	seenItems: SeenContentItem[];
};

async function seenSetsForBots(
	db: D1DatabaseLike,
	botIds: string[],
	items: SeenContentItem[],
): Promise<Map<string, Set<string>>> {
	const seenByBotId = new Map(botIds.map((botId) => [botId, new Set<string>()]));
	const selected = [...new Map(items.map((item) => [`${item.type}:${item.id}`, item])).values()];
	if (botIds.length === 0 || selected.length === 0) {
		return seenByBotId;
	}
	const maxBotsPerQuery = 20;
	for (let botIndex = 0; botIndex < botIds.length; botIndex += maxBotsPerQuery) {
		const botBatch = botIds.slice(botIndex, botIndex + maxBotsPerQuery);
		const maxItemsPerQuery = Math.max(1, Math.floor((d1MaxBoundParameters - botBatch.length) / 2));
		for (let itemIndex = 0; itemIndex < selected.length; itemIndex += maxItemsPerQuery) {
			const itemBatch = selected.slice(itemIndex, itemIndex + maxItemsPerQuery);
			const botRows = botBatch.map(() => "(?)").join(", ");
			const itemRows = itemBatch.map(() => "(?, ?)").join(", ");
			const result = await db
				.prepare(
					`WITH selected_bots(bot_id) AS (VALUES ${botRows}),
					      selected_items(object_type, object_id) AS (VALUES ${itemRows})
					 SELECT bot_seen_content.bot_id AS botId,
					        bot_seen_content.object_type AS type,
					        bot_seen_content.object_id AS id
					 FROM bot_seen_content
					 JOIN selected_bots
					   ON selected_bots.bot_id = bot_seen_content.bot_id
					 JOIN selected_items
					   ON selected_items.object_type = bot_seen_content.object_type
					  AND selected_items.object_id = bot_seen_content.object_id`,
				)
				.bind(...botBatch, ...itemBatch.flatMap((item) => [item.type, item.id]))
				.all<{ botId: string; type: SeenContentItem["type"]; id: string }>();
			for (const row of result.results ?? []) {
				seenByBotId.get(row.botId)?.add(`${row.type}:${row.id}`);
			}
		}
	}
	return seenByBotId;
}

async function buildSpotlightBotPreviews(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
	forum: ForumDocument,
	input: SpotlightPreviewInput,
	now: string,
): Promise<SpotlightBotPreview[]> {
	return (await buildSpotlightBotDrafts(kv, db, userId, forum, input, now)).map(spotlightPreviewFromDraft);
}

async function buildSpotlightBotDrafts(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	userId: string,
	forum: ForumDocument,
	input: SpotlightPreviewInput,
	now: string,
): Promise<SpotlightBotDraft[]> {
	const selectedBots = await ownedSpotlightBots(kv, db, userId, forum, input.botIds);
	if (selectedBots.length === 0) {
		throw repositoryError("bad_request", "Select at least one owned bot.", 400);
	}
	const threads = await spotlightThreads(kv, forum, input);
	const plan = spotlightContentPlan(threads, input);
	const seenByBotId = await seenSetsForBots(db, selectedBots.map((bot) => bot.id), plan.seenItems);
	const focus = trimmedFocus(input.focusText);

	const drafts: SpotlightBotDraft[] = [];
	for (const bot of selectedBots) {
		const seen = seenByBotId.get(bot.id) ?? new Set<string>();
		const draft = spotlightContentForBot(plan, seen);
		const content = await addAuthorShortBiosToContext(
			kv,
			db,
			bot.id,
			draft.content,
			now,
			{ includedProfileIds: new Set() },
		);
		drafts.push({
			bot,
			included: {
				threadCount: threads.length,
				commentCount: content.filter((item) => item.type === "comment").length,
				excludedSeenCount: draft.excludedSeenCount,
			},
			content,
			injectedText: spotlightInjectedText(spotlightSyntheticContext(forum, input, threads, content, focus)),
		});
	}
	return drafts;
}

function spotlightPreviewFromDraft(draft: SpotlightBotDraft): SpotlightBotPreview {
	return {
		bot: draft.bot,
		included: draft.included,
	};
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
	if (selected.some((bot) => !bot.tickSettings.enabled)) {
		throw repositoryError("bad_request", "Spotlight can only target unpaused participants.", 400);
	}
	return selected;
}

export async function buildNotificationForumContext(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	recipientBotId: string,
	notification: NotificationDocument,
	options: { now?: string; profileContextState?: ForumContextProfileState } = {},
): Promise<ForumContextResult | null> {
	const sourceObjectId = notification.sourceObjectId;
	if (!sourceObjectId) {
		return null;
	}
	const now = options.now ?? new Date().toISOString();
	const profileContextState = options.profileContextState ?? { includedProfileIds: new Set<string>() };
	const sourceRef = parseObjectRef(sourceObjectId);
	if (sourceRef?.type === "thread") {
		const thread = await readThreadIfAvailable(kv, sourceRef.id);
		if (!thread) {
			return null;
		}
		const content = await addAuthorShortBiosToContext(
			kv,
			db,
			recipientBotId,
			[threadRootContextItem(thread, { focus: true })],
			now,
			profileContextState,
		);
		return {
			worldId: thread.worldId,
			worldHandle: thread.worldHandle,
			forumId: thread.forumId,
			forumHandle: thread.forumHandle,
			threadId: thread.id,
			title: threadTitle(thread),
			content,
			autoProfileSeenItems: autoProfileSeenItems(content),
		};
	}
	if (sourceRef?.type !== "comment") {
		return null;
	}
	const row = await db
		.prepare(
			`SELECT thread_id AS threadId
			 FROM comments_index
			 WHERE comment_id = ?
			   AND deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(sourceRef.id)
		.first<{ threadId: string }>();
	if (!row) {
		return null;
	}
	const thread = await readThreadIfAvailable(kv, row.threadId);
	if (!thread) {
		return null;
	}
	const comment = thread.comments.find((item) => item.id === sourceRef.id);
	if (!comment) {
		return null;
	}
	const content = await addAuthorShortBiosToContext(
		kv,
		db,
		recipientBotId,
		commentContextContent(thread, [comment.id], new Set(), new Set([comment.id])),
		now,
		profileContextState,
	);
	return {
		worldId: thread.worldId,
		worldHandle: thread.worldHandle,
		forumId: thread.forumId,
		forumHandle: thread.forumHandle,
		threadId: thread.id,
		title: threadTitle(thread),
		commentId: comment.id,
		...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId } : {}),
		content,
		autoProfileSeenItems: autoProfileSeenItems(content),
	};
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

function spotlightContentPlan(
	threads: ThreadDocument[],
	input: SpotlightPreviewInput,
): SpotlightContentPlan {
	const commentIdsByThreadId = new Map<string, string[]>();
	const seenItems: SeenContentItem[] = [];
	if (input.targetType === "threads") {
		for (const thread of threads) {
			const commentIds = thread.comments.map((comment) => comment.id);
			commentIdsByThreadId.set(thread.id, commentIds);
			seenItems.push(...commentIds.map((id) => ({ type: "comment" as const, id })));
		}
		return {
			threads,
			commentIdsByThreadId,
			spotlightedCommentIds: undefined,
			seenItems,
		};
	}

	const spotlightedCommentIds = new Set(input.commentIds ?? []);
	for (const thread of threads) {
		const selectedInThread = thread.comments
			.filter((comment) => spotlightedCommentIds.has(comment.id))
			.map((comment) => comment.id);
		const chainIds = commentChainIds(thread, selectedInThread);
		commentIdsByThreadId.set(thread.id, chainIds);
		seenItems.push(...chainIds.map((id) => ({ type: "comment" as const, id })));
	}
	return {
		threads,
		commentIdsByThreadId,
		spotlightedCommentIds,
		seenItems,
	};
}

function spotlightContentForBot(
	plan: SpotlightContentPlan,
	seen: Set<string>,
): SpotlightContentDraft {
	const content: SpotlightIncludedContent[] = [];
	const included = new Set<string>();
	let excludedSeenCount = 0;
	for (const thread of plan.threads) {
		const commentsById = new Map(thread.comments.map((comment) => [comment.id, comment]));
		for (const commentId of plan.commentIdsByThreadId.get(thread.id) ?? []) {
			const comment = commentsById.get(commentId);
			if (!comment) {
				continue;
			}
			const key = `comment:${comment.id}`;
			if (!plan.spotlightedCommentIds && seen.has(key)) {
				excludedSeenCount += 1;
				continue;
			}
			const item = commentContextItem(thread, comment, seen, plan.spotlightedCommentIds);
			const itemKey = `${item.type}:${item.id}`;
			if (!included.has(itemKey)) {
				included.add(itemKey);
				content.push(item);
			}
		}
	}
	return { content, excludedSeenCount };
}

function commentChainIds(thread: ThreadDocument, commentIds: string[]): string[] {
	const commentsById = new Map(thread.comments.map((comment) => [comment.id, comment]));
	const included = new Set<string>();
	const ids: string[] = [];
	for (const commentId of commentIds) {
		const chain: CommentDocument[] = [];
		let current = commentsById.get(commentId);
		while (current) {
			chain.unshift(current);
			current = current.parentCommentId ? commentsById.get(current.parentCommentId) : undefined;
		}
		for (const comment of chain) {
			if (!included.has(comment.id)) {
				included.add(comment.id);
				ids.push(comment.id);
			}
		}
	}
	return ids;
}

function threadRootContextItem(
	thread: ThreadDocument,
	options: { alreadySeen?: boolean; focus?: boolean; ancestorOnly?: boolean } = {},
): SpotlightIncludedContent {
	const root = rootCommentForThread(thread);
	return {
		type: "comment",
		id: root.id,
		commentId: root.id,
		threadId: thread.id,
		authorBotId: root.authorBotId,
		authorHandle: root.authorHandle,
		authorDisplayName: root.authorDisplayName,
		body: root.body,
		createdAt: root.createdAt,
		...(options.focus ? { "My focus is on this comment": true } : {}),
		...(options.ancestorOnly ? { ancestorOnly: true } : {}),
		alreadySeen: Boolean(options.alreadySeen),
	};
}

function commentContextItem(
	thread: ThreadDocument,
	comment: CommentDocument,
	seen: ReadonlySet<string>,
	spotlightedCommentIds?: ReadonlySet<string>,
): SpotlightIncludedContent {
	return {
		type: "comment",
		id: comment.id,
		commentId: comment.id,
		threadId: thread.id,
		...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId } : {}),
		authorBotId: comment.authorBotId,
		authorHandle: comment.authorHandle,
		authorDisplayName: comment.authorDisplayName,
		body: comment.body,
		createdAt: comment.createdAt,
		...(spotlightedCommentIds?.has(comment.id) ? { "My focus is on this comment": true as const } : {}),
		...(spotlightedCommentIds ? { ancestorOnly: !spotlightedCommentIds.has(comment.id) } : {}),
		alreadySeen: seen.has(`comment:${comment.id}`),
	};
}

function commentContextContent(
	thread: ThreadDocument,
	commentIds: string[],
	seen: Set<string>,
	spotlightedCommentIds?: ReadonlySet<string>,
): SpotlightIncludedContent[] {
	const content: SpotlightIncludedContent[] = [];
	const included = new Set<string>();
	const commentsById = new Map(thread.comments.map((comment) => [comment.id, comment]));
	for (const commentId of commentIds) {
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
				commentId: comment.id,
				threadId: thread.id,
				...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId } : {}),
				authorBotId: comment.authorBotId,
				authorHandle: comment.authorHandle,
				authorDisplayName: comment.authorDisplayName,
				body: comment.body,
				createdAt: comment.createdAt,
				...(spotlightedCommentIds?.has(comment.id) ? { "My focus is on this comment": true as const } : {}),
				ancestorOnly: spotlightedCommentIds ? !spotlightedCommentIds.has(comment.id) : index < chain.length - 1,
				alreadySeen: seen.has(key),
			});
		}
	}
	return content;
}

async function addAuthorShortBiosToContext(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	recipientBotId: string,
	content: SpotlightIncludedContent[],
	now: string,
	profileContextState: ForumContextProfileState,
): Promise<SpotlightIncludedContent[]> {
	const annotated: SpotlightIncludedContent[] = [];
	const candidateAuthorIds = content
		.map((item) => item.authorBotId)
		.filter((authorBotId) => authorBotId !== recipientBotId && !profileContextState.includedProfileIds.has(authorBotId));
	const followedAuthorIds = await followedBotIdSet(db, recipientBotId, candidateAuthorIds);
	const recentlySeenAuthorIds = await botSeenRecentlySet(db, recipientBotId, candidateAuthorIds, now);
	for (const item of content) {
		if (item.authorBotId === recipientBotId || profileContextState.includedProfileIds.has(item.authorBotId)) {
			annotated.push(item);
			continue;
		}
		if (recentlySeenAuthorIds.has(item.authorBotId)) {
			annotated.push(item);
			continue;
		}
		const shortBio = await shortBioForProfile(kv, db, item.authorBotId);
		if (!shortBio) {
			annotated.push(item);
			continue;
		}
		profileContextState.includedProfileIds.add(item.authorBotId);
		annotated.push({
			...item,
			authorShortBio: shortBio,
			authorFollowing: followedAuthorIds.has(item.authorBotId),
		});
	}
	return annotated;
}

async function shortBioForProfile(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
): Promise<string | undefined> {
	try {
		return (await botById(kv, db, botId)).shortBio;
	} catch (error) {
		if (error instanceof RepositoryError && error.code === "not_found") {
			return undefined;
		}
		throw error;
	}
}

function autoProfileSeenItems(content: SpotlightIncludedContent[]): SeenContentItem[] {
	const items = new Map<string, SeenContentItem>();
	for (const item of content) {
		if (item.authorShortBio) {
			items.set(item.authorBotId, { type: "bot", id: item.authorBotId });
		}
	}
	return [...items.values()];
}

async function readThreadIfAvailable(
	kv: KVNamespaceLike,
	threadId: string,
): Promise<ThreadDocument | null> {
	try {
		return await readThread(kv, threadId);
	} catch (error) {
		if (error instanceof RepositoryError && error.code === "not_found") {
			return null;
		}
		throw error;
	}
}

function spotlightSyntheticContext(
	forum: ForumDocument,
	input: SpotlightPreviewInput,
	threads: ThreadDocument[],
	content: SpotlightIncludedContent[],
	focus: string | undefined,
): SpotlightSyntheticContext {
	return {
		kind: "spotlight_context",
		world: {
			id: forum.worldId,
			handle: `w/${forum.worldHandle}`,
		},
		forum: {
			id: forum.id,
			handle: `f/${forum.handle}`,
			description: forum.description,
		},
		targetType: input.targetType,
		...(focus ? { focus } : {}),
		threads: threads.map((thread) => ({
			id: thread.id,
			threadId: thread.id,
			title: threadTitle(thread),
			rootCommentId: thread.rootCommentId,
		})),
		content,
	};
}

function spotlightInjectedText(context: SpotlightSyntheticContext): string {
	return JSON.stringify(context, null, 2);
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
	return threadUrlPathFromParts(thread.worldHandle, thread.forumHandle, thread.id);
}

function threadUrlPathFromParts(worldHandle: string, forumHandle: string, threadId: string): string {
	return `/w/${encodeURIComponent(worldHandle)}/f/${encodeURIComponent(forumHandle)}/t/${encodeURIComponent(threadId)}`;
}

function commentUrlPath(thread: ThreadDocument, commentId: string): string {
	return `${threadUrlPath(thread)}/c/${encodeURIComponent(commentId)}`;
}

function botUrlPath(bot: BotDocument | BotSummary): string {
	return `/w/${encodeURIComponent(bot.homeWorldHandle)}/u/${encodeURIComponent(bot.handle)}`;
}

function botActivityUrlPath(bot: BotDocument | BotSummary, activityId: string | undefined): string {
	const base = botUrlPath(bot);
	return activityId ? `${base}?tab=activity&activity=${encodeURIComponent(activityId)}` : base;
}

function voteActivityId(commentId: string): string {
	return `vote:comment:${commentId}`;
}

function voteActivityStorageId(botId: string, commentId: string): string {
	return `vote:${botId}:comment:${commentId}`;
}

function humanNotificationBodyWithReason(body: string, reason: string | undefined): string {
	const trimmed = reason?.trim();
	return trimmed ? `${body}\n${trimmed}` : body;
}

function spotlightStandardHumanNotifications(
	toolName: string,
	args: Record<string, unknown>,
	result: unknown,
	bot: BotDocument,
	input: { userId: string; worldId: string; spotlightId: string; now: string },
): Array<HumanNotificationInput & { spotlightId: string; spotlightLabel: string }> {
	const thread = threadFromToolResult(result);
	if ((toolName === "create_thread" || toolName === "create_post") && thread) {
		return [{
			userId: input.userId,
			worldId: input.worldId,
			eventKey: `thread_created:${thread.id}`,
			notificationType: "thread_created",
			actor: bot,
			sourceType: "thread",
			sourceId: thread.id,
			targetType: "forum",
			targetId: thread.forumId,
			title: `${bot.displayName} created a thread in f/${thread.forumHandle}`,
			body: threadTitle(thread),
			urlPath: threadUrlPath(thread),
			spotlightId: input.spotlightId,
			spotlightLabel: "spotlight",
			now: input.now,
		}];
	}
	if ((toolName === "reply_to_comment" || toolName === "reply_to_thread") && thread) {
		const comment = newestComment(thread);
		if (!comment) {
			return [];
		}
		return [{
			userId: input.userId,
			worldId: input.worldId,
			eventKey: `comment_created:${comment.id}`,
			notificationType: "comment_created",
			actor: bot,
			sourceType: "comment",
			sourceId: comment.id,
			targetType: "thread",
			targetId: thread.id,
			title: `${bot.displayName} replied in "${threadTitle(thread)}"`,
			body: preview(comment.body),
			urlPath: commentUrlPath(thread, comment.id),
			spotlightId: input.spotlightId,
			spotlightLabel: "spotlight",
			now: input.now,
		}];
	}
	if (toolName === "vote") {
		return spotlightVoteHumanNotifications(args, result, bot, input);
	}
	if (toolName === "follow_bot" || toolName === "follow_profile" || toolName === "unfollow_bot" || toolName === "unfollow_profile") {
		return spotlightProfileActionHumanNotifications(toolName, args, result, bot, input);
	}
	return [];
}

function spotlightVoteHumanNotifications(
	args: Record<string, unknown>,
	result: unknown,
	bot: BotDocument,
	input: { userId: string; worldId: string; spotlightId: string; now: string },
): Array<HumanNotificationInput & { spotlightId: string; spotlightLabel: string }> {
	const argsRecord = runtimeRecord(args);
	const commonReason = stringValue(argsRecord.reason);
	const rows = Array.isArray(result) ? result.map(runtimeRecord) : [runtimeRecord(result)];
	return rows.flatMap((record) => {
		const thread = threadFromToolResult(record) ?? threadFromToolResult(result);
		const commentId = stringValue(record.commentId) ?? stringValue(record.targetId) ?? stringValue(argsRecord.commentId) ?? stringValue(argsRecord.targetId);
		const value = Number(record.value ?? argsRecord.value);
		if (!thread || !commentId || (value !== 1 && value !== -1)) {
			return [];
		}
		const direction = value > 0 ? "upvoted" : "downvoted";
		const reason = stringValue(record.reason) ?? commonReason;
		return [{
			userId: input.userId,
			worldId: input.worldId,
			eventKey: `vote_cast:comment:${commentId}:${bot.id}:${value}:${input.now}`,
			notificationType: "vote_cast",
			actor: bot,
			sourceType: "vote",
			sourceId: `comment:${commentId}:${bot.id}`,
			targetType: "comment",
			targetId: commentId,
			title: `${bot.displayName} ${direction} a comment in`,
			body: humanNotificationBodyWithReason(threadTitle(thread), reason),
			urlPath: botActivityUrlPath(bot, voteActivityId(commentId)),
			spotlightId: input.spotlightId,
			spotlightLabel: "spotlight",
			now: input.now,
		}];
	});
}

function spotlightProfileActionHumanNotifications(
	toolName: string,
	args: Record<string, unknown>,
	result: unknown,
	bot: BotDocument,
	input: { userId: string; worldId: string; spotlightId: string; now: string },
): Array<HumanNotificationInput & { spotlightId: string; spotlightLabel: string }> {
	const shouldFollow = toolName === "follow_bot" || toolName === "follow_profile";
	const fallbackReason = stringValue(runtimeRecord(args).reason);
	const rows = Array.isArray(result) ? result.map(runtimeRecord) : [runtimeRecord(result)];
	return rows.flatMap((record) => {
		const profile = runtimeRecord(record.profile);
		const followedId = stringValue(profile.id);
		if (!followedId) {
			return [];
		}
		const handle = stringValue(profile.handle) ?? stringValue(profile.username) ?? followedId;
		const displayName = stringValue(profile.displayName) ?? "a profile";
		const reason = stringValue(record.reason) ?? profileActionReasonForTarget(args, handle) ?? fallbackReason;
		return [{
			userId: input.userId,
			worldId: input.worldId,
			eventKey: shouldFollow ? `bot_followed:${bot.id}:${followedId}` : `bot_unfollowed:${bot.id}:${followedId}:${input.now}`,
			notificationType: shouldFollow ? "bot_followed" : "bot_unfollowed",
			actor: bot,
			sourceType: "follow",
			sourceId: `${bot.id}:${followedId}`,
			targetType: "bot",
			targetId: followedId,
			title: `${bot.displayName} ${shouldFollow ? "followed" : "unfollowed"} ${displayName}`,
			body: humanNotificationBodyWithReason(`u/${bot.handle} ${shouldFollow ? "followed" : "unfollowed"} ${handle.startsWith("u/") ? handle : `u/${handle}`}.`, reason),
			urlPath: botActivityUrlPath(bot, stringValue(record.activityId) ?? (shouldFollow ? `follow:${followedId}` : undefined)),
			spotlightId: input.spotlightId,
			spotlightLabel: "spotlight",
			now: input.now,
		}];
	});
}

function profileActionReasonForTarget(args: Record<string, unknown>, handle: string): string | undefined {
	const normalizedHandle = handle.replace(/^u\//i, "");
	const targets = Array.isArray(args.targets) ? args.targets : [];
	for (const item of targets) {
		const record = runtimeRecord(item);
		const username = stringValue(record.username) ?? stringValue(record.handle);
		if (username?.replace(/^u\//i, "") === normalizedHandle) {
			return stringValue(record.reason);
		}
	}
	return undefined;
}

function threadFromToolResult(result: unknown): ThreadDocument | null {
	const record = runtimeRecord(result);
	if (record.type === "thread" && typeof record.id === "string" && Array.isArray(record.comments)) {
		return normalizeThreadDocument(record as ThreadDocument | LegacyThreadDocument);
	}
	const thread = runtimeRecord(record.thread);
	if (thread.type === "thread" && typeof thread.id === "string" && Array.isArray(thread.comments)) {
		return normalizeThreadDocument(thread as ThreadDocument | LegacyThreadDocument);
	}
	return null;
}

function newestComment(thread: ThreadDocument): CommentDocument | undefined {
	return [...thread.comments].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
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
	details?: RepositoryErrorDetails,
): RepositoryError {
	return new RepositoryError(code, message, status, details);
}
