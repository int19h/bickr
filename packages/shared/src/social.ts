import { formatCommentRef, formatThreadRef, isShortContentId, makeId, makeShortContentId, parseObjectRef } from "./ids";
import { entityIndexVersions } from "./index-versions";
import { legacyToolResultEnvelope } from "./legacy-tool-result-adapter";
import {
	avatarCropFromJson,
	localizedText,
	localizedTextFromStored,
	localizedTextString,
	schemaVersion,
	type AvatarCrop,
	type BotDocument,
	type BotActivityFeed,
	type BotActivityCommentContext,
	type BotFollowUsernameQueryDirection,
	type BotFollowUsernameQueryResult,
	type BotActivityItem,
	type BotFollowGraph,
	type BotProfileListMode,
	type BotProfileListResult,
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
	type HumanSubscriptionChange,
	type HumanSubscriptionCommentNode,
	type HumanSubscriptionCommentSummary,
	type HumanSubscriptionForumNode,
	type HumanSubscriptionScope,
	type HumanSubscriptionThreadNode,
	type HumanSubscriptionTreeResponse,
	type HumanSubscriptionWorldNode,
	type LocalizedText,
	type NotificationDeliveryReason,
	type NotificationDocument,
	type NotificationEvent,
	type NotificationStatus,
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
	type ForumSummary,
	type WorldActivityFeed,
	type WorldActivityItem,
	type WorldDocument,
	type WorldSummary,
} from "./model";
import { assertNeverToolResultEnvelope, type ToolResultEnvelope } from "./tool-results";
import {
	booleanFromStored,
	botByHandle,
	botById,
	botPublicProfile,
	defaultInitialBotNotification,
	introForumHandle,
	listUserBots,
	normalizeForumDefaults,
	normalizeWorldDefaults,
	RepositoryError,
	type RepositoryErrorDetails,
	worldSummariesByIds,
} from "./repository";
import {
	effectivePostingSettings,
	postingHardLimit,
} from "./posting";
import {
	defaultThreadCommentLimit,
	effectiveThreadSettings,
	threadLock,
} from "./thread-policy";
import { ownerFacingRuntimeErrorMessage, type RuntimeErrorCause } from "./runtime-errors";
import { likePatternForSearchGlob } from "./search";
import {
	type D1DatabaseLike,
	type D1PreparedStatementLike,
	type D1Result,
	type KVNamespaceLike,
	chunks,
	d1MaxBoundParameters,
	d1SafeBoundParameters,
	kvKeys,
	deleteKey,
	putObjectIndex,
	readJson,
	writeJson,
} from "./storage";
import { handlePatternSource, InputError, normalizeHandle, requiredPostingBody } from "./validation";

const handleBoundaryPatternSource = String.raw`[^\p{Letter}\p{Number}\p{Mark}_/-]`;
const handleEndBoundaryPatternSource = String.raw`[^\p{Letter}\p{Number}\p{Mark}_-]`;
const mentionPattern = new RegExp(
	`(^|${handleBoundaryPatternSource})(?:@|u/)(${handlePatternSource})(?=$|${handleEndBoundaryPatternSource})`,
	"giu",
);
const threadHotScoreCoefficients = {
	voteScore: 2,
	recentCommentCount: 1.5,
	decayDays: 7,
} as const;
const hotThreadWindowDays = threadHotScoreCoefficients.decayDays;
const hotThreadWindowMs = hotThreadWindowDays * 24 * 60 * 60 * 1000;
const threadHotScoreSql = `max(0,
	t.vote_score * ${threadHotScoreCoefficients.voteScore}
	+ t.recent_comment_count * ${threadHotScoreCoefficients.recentCommentCount}
) * min(1, max(0,
	1 - ((julianday(?) - julianday(t.last_activity_at)) / ${threadHotScoreCoefficients.decayDays})
))`;
const effectiveThreadCommentLimitSql = `min(
	${defaultThreadCommentLimit},
	coalesce(w.thread_comment_limit, ${defaultThreadCommentLimit}),
	coalesce(f.thread_comment_limit, ${defaultThreadCommentLimit})
)`;
const threadLockCommentLimitSql = `CASE
	WHEN t.comment_count >= ${effectiveThreadCommentLimitSql} THEN ${effectiveThreadCommentLimitSql}
	ELSE NULL
END`;
const secondsPerDay = 24 * 60 * 60;

export const notificationRetentionSecondsByStatus: Readonly<Record<NotificationStatus, number>> = {
	pending: 90 * secondsPerDay,
	delivered_to_loop: 30 * secondsPerDay,
	read_or_consumed: 30 * secondsPerDay,
	archived: 30 * secondsPerDay,
};

export const notificationKvExpirationTtlSeconds = Math.max(...Object.values(notificationRetentionSecondsByStatus));
// This cutover is intentionally after the expected PR deployment time. Too late
// is harmless because some TTL-backed rows get extra legacy KV deletes; too early
// would permanently strand pre-TTL KV documents once their D1 rows are removed.
export const notificationKvTtlSince = new Date("2026-07-12T00:00:00Z").toISOString();
export const notificationPruneSelectLimit = 500;
// Phase 2 only drains the finite pre-TTL legacy set. Live inflow was measured at
// about 7k rows/day, so the old all-rows 1,900/day design could never catch up.
// Current Workers docs count KV and D1 calls as subrequests; 8k legacy rows fit
// under the paid 10k default with 16 selects and about 80 D1 delete batches.
export const notificationPruneMaxRowsPerRun = 8_000;
export const notificationPruneKvDeleteChunkSize = 50;
const notificationKvWriteChunkSize = 50;

export type NotificationPruneResult = {
	selectedRows: number;
	deletedRows: number;
	kvDeleteFailures: number;
	batches: number;
	budgetExhausted: boolean;
	phase1DeletedRows: number;
	phase2DeletedRows: number;
};

// Cloudflare's D1 limits guidance recommends batching large UPDATE/DELETE work;
// 1k rows per query keeps each mutation small while the 100k run cap drains the
// current stale backlog in under a week.
export const botSeenContentPruneBatchSize = 1_000;
export const botSeenContentPruneMaxRowsPerRun = 100_000;

export type BotSeenContentPruneResult = {
	deletedRows: number;
	batches: number;
	budgetExhausted: boolean;
};

type ExpiredNotificationRow = {
	id: string;
	botId: string;
	createdAt: string;
};

type ThreadHotScoreInput = {
	voteScore: number;
	recentCommentCount: number;
	lastActivityAt: string;
};

type ExistingThreadDetails = Exclude<RepositoryErrorDetails["existingThread"], undefined>;
type ThreadSummaryRow = Omit<ThreadSummary, "authorAvatarCrop" | "authorDisplayName" | "title" | "bodyPreview" | "lock"> & {
	authorAvatarCrop: string | null;
	authorDisplayName: string;
	authorDisplayNameLang: string | null;
	title: string;
	titleLang: string | null;
	bodyPreview: string;
	bodyPreviewLang: string | null;
	lockCommentLimit: number | null;
};
type SearchThreadResultRow = Omit<SearchThreadResult, "authorAvatarCrop" | "authorDisplayName" | "title" | "snippet"> & {
	authorAvatarCrop: string | null;
	authorDisplayName: string;
	authorDisplayNameLang: string | null;
	title: string;
	titleLang: string | null;
	snippet: string;
	snippetLang: string | null;
};
type BotProfileListRow = {
	id: string;
	homeWorldId: string;
	homeWorldHandle: string;
	handle: string;
	language: string | null;
	displayName: string;
	displayNameLang: string | null;
	shortBio: string;
	shortBioLang: string | null;
	avatarUrl: string | null;
	avatarCrop: string | null;
	createdAt: string;
	updatedAt: string;
};
type FollowerCountRow = { id: string; followers: number };
type FollowUsernameRow = { handle: string };
type NewCommentCountRow = { threadId: string; count: number };

function localizedTextFromIndex(text: string, lang: string | null | undefined): LocalizedText {
	return localizedTextFromStored({ lang: lang ?? null, text });
}

function optionalLocalizedTextFromIndex(text: string | null | undefined, lang: string | null | undefined): LocalizedText | undefined {
	return text ? localizedTextFromIndex(text, lang) : undefined;
}

function localizedPreview(value: LocalizedText | string): LocalizedText {
	const localized = localizedTextFromStored(value);
	return localizedText(preview(localized.text), localized.lang);
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
	const {
		authorAvatarCrop: _authorAvatarCrop,
		authorDisplayName,
		authorDisplayNameLang,
		title,
		titleLang,
		bodyPreview,
		bodyPreviewLang,
		lockCommentLimit,
		...thread
	} = row;
	return {
		...thread,
		authorDisplayName: localizedTextFromIndex(authorDisplayName, authorDisplayNameLang),
		title: localizedTextFromIndex(title, titleLang),
		bodyPreview: localizedTextFromIndex(bodyPreview, bodyPreviewLang),
		...(crop ? { authorAvatarCrop: crop } : {}),
		...(lockCommentLimit === null ? {} : { lock: { kind: "comment_limit" as const, limit: lockCommentLimit } }),
	};
}

function searchThreadResultFromRow(row: SearchThreadResultRow): SearchThreadResult {
	const crop = cropFromIndex(row.authorAvatarCrop);
	const {
		authorAvatarCrop: _authorAvatarCrop,
		authorDisplayName,
		authorDisplayNameLang,
		title,
		titleLang,
		snippet,
		snippetLang,
		...thread
	} = row;
	return {
		...thread,
		authorDisplayName: localizedTextFromIndex(authorDisplayName, authorDisplayNameLang),
		title: localizedTextFromIndex(title, titleLang),
		snippet: localizedTextFromIndex(snippet, snippetLang),
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

function botPublicProfileFromListRow(row: BotProfileListRow): BotPublicProfile {
	return {
		id: row.id,
		homeWorldId: row.homeWorldId,
		homeWorldHandle: row.homeWorldHandle,
		handle: row.handle,
		language: row.language as BotPublicProfile["language"],
		displayName: localizedTextFromIndex(row.displayName, row.displayNameLang),
		shortBio: localizedTextFromIndex(row.shortBio, row.shortBioLang),
		...botAvatarFields(row.avatarUrl, row.avatarCrop),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function rootCommentIdForThreadId(threadId: string): string {
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

export function normalizeThreadDefaults(document: ThreadDocument): ThreadDocument {
	const current = document;
	if (!isCurrentThreadDocumentShape(current)) {
		throw new InputError("Thread document does not match the current schema.");
	}
	if (current.schemaVersion >= schemaVersion) {
		return current;
	}
	const rootComment = current.comments.find((comment) => comment.id === current.rootCommentId);
	if (!rootComment) {
		throw new InputError("Thread document root comment is missing.");
	}
	const comments = document.comments.map(normalizeCommentDocument);
	const lastActivityAt = latestThreadActivityAt(comments);
	const now = new Date().toISOString();
	const recentCommentCount = recentThreadCommentCount(comments, now);
	const normalized: ThreadDocument = {
		...current,
		schemaVersion,
		comments,
		commentCount: comments.length,
		voteScore: rootComment.voteScore,
		recentCommentCount,
		lastActivityAt,
	};
	return normalized;
}

function isCurrentThreadDocumentShape(document: ThreadDocument): boolean {
	const value = document as unknown as Record<string, unknown>;
	const title = value.title;
	return (
		typeof value.rootCommentId === "string" &&
		value.rootCommentId.length > 0 &&
		!!title &&
		typeof title === "object" &&
		!Array.isArray(title) &&
		typeof (title as Record<string, unknown>).text === "string" &&
		Array.isArray(value.comments)
	);
}

function normalizeCommentDocument(comment: CommentDocument): CommentDocument {
	const raw = comment as CommentDocument & Record<string, unknown>;
	return {
		...comment,
		authorDisplayName: localizedTextFromStored(raw.authorDisplayName),
		body: localizedTextFromStored(raw.body),
	};
}

function threadTitle(thread: ThreadDocument): string {
	return localizedTextString(thread.title);
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
			 WHERE world_handle = ? AND handle = ? AND deleted_at IS NULL
			   AND EXISTS (
				SELECT 1 FROM worlds_index worlds
				WHERE worlds.world_id = forums_index.world_id
				  AND worlds.deleted_at IS NULL AND worlds.lifecycle_state = 'active'
			   )`,
		)
		.bind(worldHandle, forumHandle)
		.first<{ id: string }>();
	if (!row) {
		throw repositoryError("not_found", "Forum not found.", 404);
	}
	return forumById(kv, db, row.id);
}

async function forumById(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	forumId: string,
): Promise<ForumDocument> {
	const row = await db
		.prepare(
			`SELECT
				f.world_id AS worldId,
				f.deleted_at AS forumDeletedAt,
				w.deleted_at AS worldDeletedAt
			 FROM forums_index f
			 JOIN worlds_index w ON w.world_id = f.world_id AND w.lifecycle_state = 'active'
			 WHERE f.forum_id = ?`,
		)
		.bind(forumId)
		.first<{ forumDeletedAt: string | null; worldDeletedAt: string | null; worldId: string }>();
	if (!row) {
		throw repositoryError("not_found", "Forum not found.", 404);
	}
	const [forum, world] = await Promise.all([
		readJson<ForumDocument>(kv, kvKeys.forum(forumId)),
		readJson<WorldDocument>(kv, kvKeys.world(row.worldId)),
	]);
	if (!forum) {
		throw repositoryError("not_found", "Forum not found.", 404);
	}
	if (!world) {
		throw repositoryError("not_found", "This forum's world was not found.", 404);
	}
	if (row.worldDeletedAt || world.deletedAt) {
		throw repositoryError("not_found", "This forum's world has been deleted.", 410);
	}
	if (row.forumDeletedAt || forum.deletedAt) {
		throw repositoryError("not_found", "This forum has been deleted.", 410);
	}
	return normalizeForumDefaults(forum);
}

async function assertThreadForumIsLive(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	thread: ThreadDocument,
): Promise<ForumDocument> {
	const forum = await forumById(kv, db, thread.forumId);
	if (forum.worldId !== thread.worldId) {
		throw repositoryError("not_found", "Thread not found in this forum.", 404);
	}
	return forum;
}

/**
 * Participant-facing wording for a rejected write into a read-only forum. It
 * states the narrow meaning of the setting so a participant does not conclude
 * that the forum is gone or that voting is blocked too.
 */
const forumReadOnlyConflictMessage =
	"This forum is read-only: existing threads and comments stay readable and votes still count, but it accepts no new threads or replies.";

/**
 * The read-only gate for authored forum content.
 *
 * The value is read from the D1 projection rather than the KV forum document
 * because `forums_index.read_only` is what the forum PATCH commits before it
 * returns, while KV reads are only eventually consistent. Thread creation and
 * forum PATCH are serialized by the same forum-ID coordinator; replies run on a
 * thread-ID coordinator and therefore rely on that committed D1 visibility.
 *
 * It is deliberately not part of `assertThreadForumIsLive`, which votes also
 * use: read-only governs authored content, not reactions. A missing row takes
 * the existing not-found path, and a D1 failure propagates to the structured
 * server-error boundary, so the gate can never fail open.
 */
async function assertForumAcceptsNewContent(db: D1DatabaseLike, forumId: string): Promise<void> {
	const row = await db
		.prepare(`SELECT read_only AS readOnly FROM forums_index WHERE forum_id = ? AND deleted_at IS NULL`)
		.bind(forumId)
		.first<{ readOnly: number }>();
	if (!row) {
		throw repositoryError("not_found", "Forum not found.", 404);
	}
	if (booleanFromStored(row.readOnly)) {
		throw repositoryError("conflict", forumReadOnlyConflictMessage, 409, { forumWriteCause: "forum_read_only" });
	}
}

export async function listThreads(
	db: D1DatabaseLike,
	forumId: string,
	sort: "recent" | "hot" = "recent",
	limit = 40,
	offset = 0,
	now = new Date().toISOString(),
): Promise<ThreadSummary[]> {
	const order =
		sort === "hot" ? `${threadHotScoreSql} DESC, t.last_activity_at DESC` : "t.last_activity_at DESC, t.created_at DESC";
	const hotCutoff = sort === "hot" ? hotThreadCutoff(now) : null;
	const result = await db
		.prepare(
			`SELECT
				t.thread_id AS id,
				t.root_comment_id AS rootCommentId,
				t.world_id AS worldId,
				t.world_handle AS worldHandle,
				t.forum_id AS forumId,
				t.forum_handle AS forumHandle,
				t.author_bot_id AS authorBotId,
				t.author_handle AS authorHandle,
				t.author_display_name AS authorDisplayName,
				t.author_display_name_lang AS authorDisplayNameLang,
				b.avatar_url AS authorAvatarUrl,
				b.avatar_crop AS authorAvatarCrop,
				t.title,
				t.title_lang AS titleLang,
				t.body_preview AS bodyPreview,
				t.body_preview_lang AS bodyPreviewLang,
				t.vote_score AS voteScore,
				t.comment_count AS commentCount,
				${threadLockCommentLimitSql} AS lockCommentLimit,
				t.created_at AS createdAt,
				t.last_activity_at AS lastActivityAt
			 FROM threads_index t
			 JOIN forums_index f ON f.forum_id = t.forum_id AND f.deleted_at IS NULL
			 JOIN worlds_index w ON w.world_id = t.world_id AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'
			 LEFT JOIN bots_index b ON b.bot_id = t.author_bot_id AND b.lifecycle_state = 'active'
			 WHERE t.forum_id = ? AND t.deleted_at IS NULL
			   ${sort === "hot" ? "AND t.last_activity_at > ?" : ""}
			 ORDER BY ${order}
			 LIMIT ? OFFSET ?`,
		)
		.bind(...(hotCutoff ? [forumId, hotCutoff, now, limit, offset] : [forumId, limit, offset]))
		.all<ThreadSummaryRow>();
	return (result.results ?? []).map(threadSummaryFromRow);
}

export async function listThreadsWithReadState(
	db: D1DatabaseLike,
	forumId: string,
	userId: string | null,
	sort: "recent" | "hot" = "recent",
	limit = 40,
	offset = 0,
): Promise<ThreadSummary[]> {
	const threads = await listThreads(db, forumId, sort, limit, offset);
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
	const readStates = threads.map((thread) => {
		const isNew = Date.parse(thread.createdAt) > Date.parse(seenThroughAt);
		return {
			thread,
			isNew,
			hasNewComments: !isNew && Date.parse(thread.lastActivityAt) > Date.parse(seenThroughAt),
		};
	});
	const newCommentCounts = await countNewCommentsForThreads(
		db,
		readStates.filter((state) => state.hasNewComments).map((state) => state.thread.id),
		seenThroughAt,
	);
	return readStates.map(({ thread, isNew, hasNewComments }) => ({
		...thread,
		readState: {
			isNew,
			hasNewComments,
			newCommentCount: hasNewComments ? newCommentCounts.get(thread.id) ?? 0 : 0,
		},
	}));
}

export async function listHotThreads(
	db: D1DatabaseLike,
	worldId: string,
	limit = 20,
	now = new Date().toISOString(),
): Promise<ThreadSummary[]> {
	const result = await db
		.prepare(
			`SELECT
				t.thread_id AS id,
				t.root_comment_id AS rootCommentId,
				t.world_id AS worldId,
				t.world_handle AS worldHandle,
				t.forum_id AS forumId,
				t.forum_handle AS forumHandle,
				t.author_bot_id AS authorBotId,
				t.author_handle AS authorHandle,
				t.author_display_name AS authorDisplayName,
				t.author_display_name_lang AS authorDisplayNameLang,
				b.avatar_url AS authorAvatarUrl,
				b.avatar_crop AS authorAvatarCrop,
				t.title,
				t.title_lang AS titleLang,
				t.body_preview AS bodyPreview,
				t.body_preview_lang AS bodyPreviewLang,
				t.vote_score AS voteScore,
				t.comment_count AS commentCount,
				${threadLockCommentLimitSql} AS lockCommentLimit,
				t.created_at AS createdAt,
				t.last_activity_at AS lastActivityAt
			 FROM threads_index t
			 JOIN forums_index f ON f.forum_id = t.forum_id AND f.deleted_at IS NULL
			 JOIN worlds_index w ON w.world_id = t.world_id AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'
			 LEFT JOIN bots_index b ON b.bot_id = t.author_bot_id AND b.lifecycle_state = 'active'
			 WHERE t.world_id = ? AND t.deleted_at IS NULL AND t.last_activity_at > ?
			 ORDER BY ${threadHotScoreSql} DESC, t.last_activity_at DESC
			 LIMIT ?`,
		)
		.bind(worldId, hotThreadCutoff(now), now, limit)
		.all<ThreadSummaryRow>();
	return (result.results ?? []).map(threadSummaryFromRow);
}

export async function readThread(kv: KVNamespaceLike, threadId: string): Promise<ThreadDocument> {
	const thread = await readJson<ThreadDocument>(kv, kvKeys.thread(threadId));
	if (!thread || thread.deletedAt) {
		throw repositoryError("not_found", "Thread not found.", 404);
	}
	return normalizeThreadDefaults(thread);
}

export async function readThreadWithReadState(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	threadId: string,
	userId: string | null,
): Promise<ThreadDocument> {
	const thread = await readThread(kv, threadId);
	await assertThreadForumIsLive(kv, db, thread);
	const withAvatars = await threadWithAuthorAvatars(db, thread);
	return threadWithReadState(db, withAvatars, userId);
}

async function threadWithAuthorAvatars(db: D1DatabaseLike, thread: ThreadDocument): Promise<ThreadDocument> {
	const authorIds = [...new Set(thread.comments.map((comment) => comment.authorBotId))];
	if (authorIds.length === 0) {
		return thread;
	}
	const avatarsById = new Map<string, { url: string; crop?: AvatarCrop }>();
	for (const batch of chunks(authorIds, d1SafeBoundParameters)) {
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT bot_id AS id, avatar_url AS avatarUrl, avatar_crop AS avatarCrop
				 FROM bots_index
				 WHERE bot_id IN (${placeholders}) AND deleted_at IS NULL AND lifecycle_state = 'active'`,
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

export async function listHumanSubscriptionTree(
	db: D1DatabaseLike,
	userId: string,
): Promise<HumanSubscriptionTreeResponse> {
	const subscriptions = await listActiveHumanSubscriptions(db, userId);
	if (subscriptions.length === 0) {
		return { subscriptions: [], tree: { worlds: [] } };
	}

	const resolvedSubscriptionKeys = new Set<string>();
	const directSubscriptions = directHumanSubscriptionsByScope(subscriptions);
	const sources = await readHumanSubscriptionTreeSources(db, subscriptions, directSubscriptions);
	const worldNodes = buildHumanSubscriptionWorldNodes(directSubscriptions.directByKey, sources, resolvedSubscriptionKeys);

	return {
		subscriptions: subscriptions.filter((subscription) =>
			resolvedSubscriptionKeys.has(subscriptionKey(subscription.scopeType, subscription.scopeId)),
		),
		tree: { worlds: worldNodes },
	};
}

type DirectHumanSubscriptions = {
	directByKey: Map<string, HumanSubscription>;
	worldIds: Set<string>;
	forumIds: Set<string>;
	threadIds: Set<string>;
	commentIds: Set<string>;
	botIds: Set<string>;
};

type HumanSubscriptionTreeSources = {
	worlds: WorldSummary[];
	forums: ForumSummary[];
	threads: ThreadSummary[];
	comments: HumanSubscriptionCommentSummary[];
	bots: BotPublicProfile[];
};

function directHumanSubscriptionsByScope(subscriptions: HumanSubscription[]): DirectHumanSubscriptions {
	return {
		directByKey: new Map(subscriptions.map((subscription) => [
			subscriptionKey(subscription.scopeType, subscription.scopeId),
			subscription,
		])),
		worldIds: idsForScope(subscriptions, "world"),
		forumIds: idsForScope(subscriptions, "forum"),
		threadIds: idsForScope(subscriptions, "thread"),
		commentIds: idsForScope(subscriptions, "comment"),
		botIds: idsForScope(subscriptions, "bot"),
	};
}

async function readHumanSubscriptionTreeSources(
	db: D1DatabaseLike,
	subscriptions: HumanSubscription[],
	direct: DirectHumanSubscriptions,
): Promise<HumanSubscriptionTreeSources> {
	const comments = await subscriptionCommentSummariesByIds(db, direct.commentIds);
	const threadIds = new Set([...direct.threadIds, ...comments.map((comment) => comment.threadId)]);
	const threads = await subscriptionThreadSummariesByIds(db, threadIds);
	const forumIds = new Set([
		...direct.forumIds,
		...threads.map((thread) => thread.forumId),
		...comments.map((comment) => comment.forumId),
	]);
	const forums = await subscriptionForumSummariesByIds(db, forumIds);
	const bots = await subscriptionBotProfilesByIds(db, direct.botIds);
	const worldIds = new Set([
		...direct.worldIds,
		...subscriptions.map((subscription) => subscription.worldId),
		...forums.map((forum) => forum.worldId),
		...threads.map((thread) => thread.worldId),
		...comments.map((comment) => comment.worldId),
		...bots.map((bot) => bot.homeWorldId),
	]);
	const worlds = await subscriptionWorldSummariesByIds(db, worldIds);
	return { worlds, forums, threads, comments, bots };
}

function buildHumanSubscriptionWorldNodes(
	directByKey: Map<string, HumanSubscription>,
	sources: HumanSubscriptionTreeSources,
	resolvedSubscriptionKeys: Set<string>,
): HumanSubscriptionWorldNode[] {
	const worldsById = itemsById(sources.worlds);
	const forumsById = itemsById(sources.forums);
	const threadsById = itemsById(sources.threads);
	const commentNodesByThreadId = buildHumanSubscriptionCommentNodes(
		sources.comments,
		{ worldsById, forumsById, threadsById },
		directByKey,
		resolvedSubscriptionKeys,
	);
	const threadNodesByForumId = buildHumanSubscriptionThreadNodes(
		sources.threads,
		{ worldsById, forumsById },
		commentNodesByThreadId,
		directByKey,
		resolvedSubscriptionKeys,
	);
	const forumNodesByWorldId = buildHumanSubscriptionForumNodes(
		sources.forums,
		worldsById,
		threadNodesByForumId,
		directByKey,
		resolvedSubscriptionKeys,
	);
	const botNodesByWorldId = buildHumanSubscriptionBotNodes(
		sources.bots,
		worldsById,
		directByKey,
		resolvedSubscriptionKeys,
	);
	const worldNodes = buildHumanSubscriptionWorldNodesFromGroups(
		sources.worlds,
		directByKey,
		botNodesByWorldId,
		forumNodesByWorldId,
		resolvedSubscriptionKeys,
	);
	return worldNodes.sort((left, right) =>
		left.world.handle.localeCompare(right.world.handle, undefined, { sensitivity: "base" }));
}

function buildHumanSubscriptionCommentNodes(
	comments: HumanSubscriptionCommentSummary[],
	indexes: {
		worldsById: Map<string, WorldSummary>;
		forumsById: Map<string, ForumSummary>;
		threadsById: Map<string, ThreadSummary>;
	},
	directByKey: Map<string, HumanSubscription>,
	resolvedSubscriptionKeys: Set<string>,
): Map<string, HumanSubscriptionCommentNode[]> {
	const commentNodesByThreadId = new Map<string, HumanSubscriptionCommentNode[]>();
	for (const comment of comments) {
		if (
			!indexes.threadsById.has(comment.threadId) ||
			!indexes.forumsById.has(comment.forumId) ||
			!indexes.worldsById.has(comment.worldId)
		) {
			continue;
		}
		const key = subscriptionKey("comment", comment.id);
		const subscription = directByKey.get(key);
		if (!subscription) {
			continue;
		}
		resolvedSubscriptionKeys.add(key);
		const nodes = commentNodesByThreadId.get(comment.threadId) ?? [];
		nodes.push({
			type: "comment",
			comment,
			target: { scopeType: "comment", scopeId: comment.id, worldId: comment.worldId },
			subscription,
		});
		commentNodesByThreadId.set(comment.threadId, nodes);
	}
	return commentNodesByThreadId;
}

function buildHumanSubscriptionThreadNodes(
	threads: ThreadSummary[],
	indexes: {
		worldsById: Map<string, WorldSummary>;
		forumsById: Map<string, ForumSummary>;
	},
	commentNodesByThreadId: Map<string, HumanSubscriptionCommentNode[]>,
	directByKey: Map<string, HumanSubscription>,
	resolvedSubscriptionKeys: Set<string>,
): Map<string, HumanSubscriptionThreadNode[]> {
	const threadNodesByForumId = new Map<string, HumanSubscriptionThreadNode[]>();
	for (const thread of threads) {
		if (!indexes.forumsById.has(thread.forumId) || !indexes.worldsById.has(thread.worldId)) {
			continue;
		}
		const comments = [...(commentNodesByThreadId.get(thread.id) ?? [])]
			.sort((left, right) => left.comment.createdAt.localeCompare(right.comment.createdAt));
		const key = subscriptionKey("thread", thread.id);
		const subscription = directByKey.get(key);
		if (!subscription && comments.length === 0) {
			continue;
		}
		if (subscription) {
			resolvedSubscriptionKeys.add(key);
		}
		const nodes = threadNodesByForumId.get(thread.forumId) ?? [];
		nodes.push({
			type: "thread",
			thread,
			target: { scopeType: "thread", scopeId: thread.id, worldId: thread.worldId },
			...(subscription ? { subscription } : {}),
			comments,
		});
		threadNodesByForumId.set(thread.forumId, nodes);
	}
	return threadNodesByForumId;
}

function buildHumanSubscriptionForumNodes(
	forums: ForumSummary[],
	worldsById: Map<string, WorldSummary>,
	threadNodesByForumId: Map<string, HumanSubscriptionThreadNode[]>,
	directByKey: Map<string, HumanSubscription>,
	resolvedSubscriptionKeys: Set<string>,
): Map<string, HumanSubscriptionForumNode[]> {
	const forumNodesByWorldId = new Map<string, HumanSubscriptionForumNode[]>();
	for (const forum of forums) {
		if (!worldsById.has(forum.worldId)) {
			continue;
		}
		const threads = [...(threadNodesByForumId.get(forum.id) ?? [])]
			.sort((left, right) => right.thread.lastActivityAt.localeCompare(left.thread.lastActivityAt));
		const key = subscriptionKey("forum", forum.id);
		const subscription = directByKey.get(key);
		if (!subscription && threads.length === 0) {
			continue;
		}
		if (subscription) {
			resolvedSubscriptionKeys.add(key);
		}
		const nodes = forumNodesByWorldId.get(forum.worldId) ?? [];
		nodes.push({
			type: "forum",
			forum,
			target: { scopeType: "forum", scopeId: forum.id, worldId: forum.worldId },
			...(subscription ? { subscription } : {}),
			threads,
		});
		forumNodesByWorldId.set(forum.worldId, nodes);
	}
	return forumNodesByWorldId;
}

function buildHumanSubscriptionBotNodes(
	bots: BotPublicProfile[],
	worldsById: Map<string, WorldSummary>,
	directByKey: Map<string, HumanSubscription>,
	resolvedSubscriptionKeys: Set<string>,
): Map<string, HumanSubscriptionWorldNode["bots"]> {
	const botNodesByWorldId = new Map<string, HumanSubscriptionWorldNode["bots"]>();
	for (const bot of bots) {
		if (!worldsById.has(bot.homeWorldId)) {
			continue;
		}
		const key = subscriptionKey("bot", bot.id);
		const subscription = directByKey.get(key);
		if (!subscription) {
			continue;
		}
		resolvedSubscriptionKeys.add(key);
		const nodes = botNodesByWorldId.get(bot.homeWorldId) ?? [];
		nodes.push({
			type: "bot",
			bot,
			target: { scopeType: "bot", scopeId: bot.id, worldId: bot.homeWorldId },
			subscription,
		});
		botNodesByWorldId.set(bot.homeWorldId, nodes);
	}
	return botNodesByWorldId;
}

function buildHumanSubscriptionWorldNodesFromGroups(
	worlds: WorldSummary[],
	directByKey: Map<string, HumanSubscription>,
	botNodesByWorldId: Map<string, HumanSubscriptionWorldNode["bots"]>,
	forumNodesByWorldId: Map<string, HumanSubscriptionForumNode[]>,
	resolvedSubscriptionKeys: Set<string>,
): HumanSubscriptionWorldNode[] {
	const worldNodes: HumanSubscriptionWorldNode[] = [];
	for (const world of worlds) {
		const bots = [...(botNodesByWorldId.get(world.id) ?? [])]
			.sort((left, right) => left.bot.handle.localeCompare(right.bot.handle, undefined, { sensitivity: "base" }));
		const forums = [...(forumNodesByWorldId.get(world.id) ?? [])]
			.sort((left, right) => left.forum.handle.localeCompare(right.forum.handle, undefined, { sensitivity: "base" }));
		const key = subscriptionKey("world", world.id);
		const subscription = directByKey.get(key);
		if (!subscription && bots.length === 0 && forums.length === 0) {
			continue;
		}
		if (subscription) {
			resolvedSubscriptionKeys.add(key);
		}
		worldNodes.push({
			type: "world",
			world,
			target: { scopeType: "world", scopeId: world.id, worldId: world.id },
			...(subscription ? { subscription } : {}),
			bots,
			forums,
		});
	}
	return worldNodes;
}

function itemsById<T extends { id: string }>(items: T[]): Map<string, T> {
	return new Map(items.map((item) => [item.id, item]));
}

export async function applyHumanSubscriptionChanges(
	db: D1DatabaseLike,
	userId: string,
	changes: HumanSubscriptionChange[],
	now = new Date().toISOString(),
): Promise<void> {
	const latestByKey = new Map<string, HumanSubscriptionChange>();
	for (const change of changes) {
		latestByKey.set(subscriptionKey(change.scopeType, change.scopeId), change);
	}
	await validateHumanSubscriptionTargets(
		db,
		[...latestByKey.values()].filter((change) => change.active),
	);

	const statements: D1PreparedStatementLike[] = [];
	for (const change of latestByKey.values()) {
		if (change.active) {
			statements.push(
				db.prepare(
					`INSERT INTO human_subscriptions (
						subscription_id, user_id, world_id, scope_type, scope_id,
						active, auto_created, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
					ON CONFLICT(user_id, scope_type, scope_id) DO UPDATE SET
						world_id = excluded.world_id,
						active = 1,
						auto_created = excluded.auto_created,
						updated_at = excluded.updated_at`,
				)
					.bind(makeId("hsb"), userId, change.worldId, change.scopeType, change.scopeId, now, now),
			);
		} else {
			statements.push(
				db.prepare(
					`UPDATE human_subscriptions
					 SET active = 0, updated_at = ?
					 WHERE user_id = ? AND scope_type = ? AND scope_id = ?`,
				)
					.bind(now, userId, change.scopeType, change.scopeId),
			);
		}
	}

	if (statements.length > 0) {
		await db.batch(statements);
	}
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
	await validateHumanSubscriptionTargets(db, [input]);
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

type HumanSubscriptionTargetInput = Pick<HumanSubscription, "scopeType" | "scopeId" | "worldId">;

type HumanSubscriptionValidationRow = {
	position: number;
	scopeType: HumanSubscriptionScope;
	scopeId: string;
	claimedWorldId: string;
	actualWorldId: string | null;
};

const humanSubscriptionValidationBatchSize = 20;

async function validateHumanSubscriptionTargets(
	db: D1DatabaseLike,
	targets: HumanSubscriptionTargetInput[],
): Promise<void> {
	for (let start = 0; start < targets.length; start += humanSubscriptionValidationBatchSize) {
		const batch = targets.slice(start, start + humanSubscriptionValidationBatchSize);
		const binds: unknown[] = [];
		const selects = batch.map((target, position) => {
			binds.push(target.scopeType, target.scopeId, target.worldId, target.scopeId);
			return `SELECT
				${position} AS position,
				? AS scopeType,
				? AS scopeId,
				? AS claimedWorldId,
				${humanSubscriptionScopeWorldIdSql(target.scopeType)} AS actualWorldId`;
		});
		const result = await db
			.prepare(selects.join(" UNION ALL "))
			.bind(...binds)
			.all<HumanSubscriptionValidationRow>();
		const rows = [...(result.results ?? [])].sort((left, right) => left.position - right.position);
		for (const row of rows) {
			if (!row.actualWorldId) {
				throw repositoryError("not_found", `Subscription ${row.scopeType} scope not found.`, 404);
			}
			if (row.actualWorldId !== row.claimedWorldId) {
				throw repositoryError("bad_request", "Subscription scope does not belong to the specified world.", 400);
			}
		}
	}
}

function humanSubscriptionScopeWorldIdSql(scopeType: HumanSubscriptionScope): string {
	switch (scopeType) {
		case "world":
			return `(SELECT w.world_id
				FROM worlds_index w
				WHERE w.world_id = ? AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'
				LIMIT 1)`;
		case "forum":
			return `(SELECT f.world_id
				FROM forums_index f
				JOIN worlds_index w ON w.world_id = f.world_id AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'
				WHERE f.forum_id = ? AND f.deleted_at IS NULL
				LIMIT 1)`;
		case "thread":
			return `(SELECT t.world_id
				FROM threads_index t
				JOIN worlds_index w ON w.world_id = t.world_id AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'
				WHERE t.thread_id = ? AND t.deleted_at IS NULL
				LIMIT 1)`;
		case "comment":
			return `(SELECT c.world_id
				FROM comments_index c
				JOIN worlds_index w ON w.world_id = c.world_id AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'
				WHERE c.comment_id = ? AND c.deleted_at IS NULL
				LIMIT 1)`;
		case "bot":
			return `(SELECT b.home_world_id
				FROM bots_index b
				JOIN worlds_index w ON w.world_id = b.home_world_id AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'
				WHERE b.bot_id = ? AND b.deleted_at IS NULL AND b.lifecycle_state = 'active'
				LIMIT 1)`;
	}
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

async function listActiveHumanSubscriptions(
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
			 WHERE user_id = ? AND active = 1
			 ORDER BY updated_at DESC`,
		)
		.bind(userId)
		.all<HumanSubscriptionRow>();
	return (result.results ?? []).map(subscriptionFromRow);
}

function subscriptionKey(scopeType: HumanSubscriptionScope, scopeId: string): string {
	return `${scopeType}:${scopeId}`;
}

function idsForScope(
	subscriptions: HumanSubscription[],
	scopeType: HumanSubscriptionScope,
): Set<string> {
	return new Set(
		subscriptions
			.filter((subscription) => subscription.scopeType === scopeType)
			.map((subscription) => subscription.scopeId),
	);
}

async function subscriptionWorldSummariesByIds(
	db: D1DatabaseLike,
	ids: Set<string>,
): Promise<WorldSummary[]> {
	const worlds = await worldSummariesByIds(db, [...ids]);
	return [...ids].flatMap((id) => {
		const world = worlds.get(id);
		return world ? [world] : [];
	});
}

async function subscriptionForumSummariesByIds(
	db: D1DatabaseLike,
	ids: Set<string>,
): Promise<ForumSummary[]> {
	return rowsByIds<{
		id: string;
		worldId: string;
		worldHandle: string;
		handle: string;
		language: string | null;
		description: string;
		descriptionLang: string | null;
		createdByUserId: string;
		personalBotId: string | null;
		readOnly: number;
		createdAt: string;
		updatedAt: string;
	}>(
		db,
		ids,
		(placeholders) => `SELECT
			f.forum_id AS id,
			f.world_id AS worldId,
			f.world_handle AS worldHandle,
			f.handle,
			f.language,
			f.description,
			f.description_lang AS descriptionLang,
			f.created_by_user_id AS createdByUserId,
			f.personal_bot_id AS personalBotId,
			f.read_only AS readOnly,
			f.created_at AS createdAt,
			f.updated_at AS updatedAt
		 FROM forums_index f
		 WHERE f.forum_id IN (${placeholders}) AND f.deleted_at IS NULL`,
	).then((forums) => forums.map((row) => ({
		id: row.id,
		worldId: row.worldId,
		worldHandle: row.worldHandle,
		handle: row.handle,
		language: row.language as ForumSummary["language"],
		description: localizedTextFromIndex(row.description, row.descriptionLang),
		createdByUserId: row.createdByUserId,
		...(row.personalBotId ? { personalBotId: row.personalBotId } : {}),
		readOnly: booleanFromStored(row.readOnly),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	})));
}

async function subscriptionThreadSummariesByIds(
	db: D1DatabaseLike,
	ids: Set<string>,
): Promise<ThreadSummary[]> {
	return rowsByIds<ThreadSummaryRow>(
		db,
		ids,
		(placeholders) => `SELECT
			t.thread_id AS id,
			t.root_comment_id AS rootCommentId,
			t.world_id AS worldId,
			t.world_handle AS worldHandle,
			t.forum_id AS forumId,
			t.forum_handle AS forumHandle,
			t.author_bot_id AS authorBotId,
			t.author_handle AS authorHandle,
			t.author_display_name AS authorDisplayName,
			t.author_display_name_lang AS authorDisplayNameLang,
			b.avatar_url AS authorAvatarUrl,
			b.avatar_crop AS authorAvatarCrop,
			t.title,
			t.title_lang AS titleLang,
			t.body_preview AS bodyPreview,
			t.body_preview_lang AS bodyPreviewLang,
			t.vote_score AS voteScore,
			t.comment_count AS commentCount,
			${threadLockCommentLimitSql} AS lockCommentLimit,
			t.created_at AS createdAt,
			t.last_activity_at AS lastActivityAt
		 FROM threads_index t
		 JOIN forums_index f ON f.forum_id = t.forum_id AND f.deleted_at IS NULL
		 JOIN worlds_index w ON w.world_id = t.world_id AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'
		 LEFT JOIN bots_index b ON b.bot_id = t.author_bot_id AND b.lifecycle_state = 'active'
		 WHERE t.thread_id IN (${placeholders}) AND t.deleted_at IS NULL`,
	).then((threads) => threads.map(threadSummaryFromRow));
}

async function subscriptionCommentSummariesByIds(
	db: D1DatabaseLike,
	ids: Set<string>,
): Promise<HumanSubscriptionCommentSummary[]> {
	return rowsByIds<SubscriptionCommentSummaryRow>(
		db,
		ids,
		(placeholders) => `SELECT
			c.comment_id AS id,
			c.thread_id AS threadId,
			c.world_id AS worldId,
			c.forum_id AS forumId,
			c.author_bot_id AS authorBotId,
			c.author_handle AS authorHandle,
			COALESCE(b.display_name, c.author_handle) AS authorDisplayName,
			b.display_name_lang AS authorDisplayNameLang,
			b.avatar_url AS authorAvatarUrl,
			b.avatar_crop AS authorAvatarCrop,
			c.body_preview AS bodyPreview,
			c.body_preview_lang AS bodyPreviewLang,
			c.created_at AS createdAt
		 FROM comments_index c
		 LEFT JOIN bots_index b ON b.bot_id = c.author_bot_id AND b.lifecycle_state = 'active'
		 WHERE c.comment_id IN (${placeholders}) AND c.deleted_at IS NULL`,
	).then((comments) => comments.map(subscriptionCommentSummaryFromRow));
}

async function subscriptionBotProfilesByIds(
	db: D1DatabaseLike,
	ids: Set<string>,
): Promise<BotPublicProfile[]> {
	return rowsByIds<SubscriptionBotProfileRow>(
		db,
		ids,
		(placeholders) => `SELECT
			bot_id AS id,
			home_world_id AS homeWorldId,
			home_world_handle AS homeWorldHandle,
			handle,
			display_name AS displayName,
			display_name_lang AS displayNameLang,
			short_bio AS shortBio,
			short_bio_lang AS shortBioLang,
			avatar_url AS avatarUrl,
			avatar_crop AS avatarCrop,
			created_at AS createdAt,
			updated_at AS updatedAt
		 FROM bots_index
		 WHERE bot_id IN (${placeholders}) AND deleted_at IS NULL AND lifecycle_state = 'active'`,
	).then((bots) => bots.map(subscriptionBotProfileFromRow));
}

async function rowsByIds<T>(
	db: D1DatabaseLike,
	ids: Set<string>,
	query: (placeholders: string) => string,
): Promise<T[]> {
	const rows: T[] = [];
	for (const batch of chunks([...ids], d1SafeBoundParameters)) {
		if (batch.length === 0) {
			continue;
		}
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db.prepare(query(placeholders)).bind(...batch).all<T>();
		rows.push(...(result.results ?? []));
	}
	return rows;
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
	const notifications: HumanNotificationInput[] = [...users].map((userId) => ({
		userId,
		worldId: thread.worldId,
		eventKey: `thread_created:${thread.id}`,
		notificationType: "thread_created",
		actor,
		sourceType: "thread",
		sourceId: thread.id,
		targetType: "forum",
		targetId: thread.forumId,
		title: `${localizedTextString(actor.displayName)} created a thread in f/${thread.forumHandle}`,
		body: threadTitle(thread),
		urlPath: threadUrlPath(thread),
		now,
	}));
	await insertHumanNotifications(db, notifications);
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
	const notifications: HumanNotificationInput[] = [...users].map((userId) => ({
		userId,
		worldId: thread.worldId,
		eventKey: `comment_created:${comment.id}`,
		notificationType: "comment_created",
		actor,
		sourceType: "comment",
		sourceId: comment.id,
		targetType: "thread",
		targetId: thread.id,
		title: `${localizedTextString(actor.displayName)} replied in "${threadTitle(thread)}"`,
		body: localizedPreview(comment.body),
		urlPath: commentUrlPath(thread, comment.id),
		now,
	}));
	await insertHumanNotifications(db, notifications);
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
	const direction = input.value > 0 ? "upvoted" : "downvoted";
	const notifications: HumanNotificationInput[] = [...users].map((userId) => ({
		userId,
		worldId: thread.worldId,
		eventKey: `vote_cast:comment:${input.targetId}:${actor.id}:${input.value}:${now}`,
		notificationType: "vote_cast",
		actor,
		sourceType: "vote",
		sourceId: `comment:${input.targetId}:${actor.id}`,
		targetType: "comment",
		targetId: input.targetId,
		title: `${localizedTextString(actor.displayName)} ${direction} a comment in`,
		body: humanNotificationBodyWithReason(threadTitle(thread), input.reason),
		urlPath: botActivityUrlPath(actor, options.activityId ?? voteActivityId(input.targetId)),
		...(options.spotlightId ? { spotlightId: options.spotlightId } : {}),
		...(options.spotlightLabel ? { spotlightLabel: options.spotlightLabel } : {}),
		now,
	}));
	await insertHumanNotifications(db, notifications);
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
	const notifications: HumanNotificationInput[] = [...users].map((userId) => ({
		userId,
		worldId: follower.homeWorldId,
		eventKey: `bot_followed:${follower.id}:${followed.id}`,
		notificationType: "bot_followed",
		actor: follower,
		sourceType: "follow",
		sourceId: `${follower.id}:${followed.id}`,
		targetType: "bot",
		targetId: followed.id,
		title: `${localizedTextString(follower.displayName)} followed ${localizedTextString(followed.displayName)}`,
		body: humanNotificationBodyWithReason(`u/${follower.handle} followed u/${followed.handle}.`, options.reason),
		urlPath: botActivityUrlPath(follower, options.activityId),
		...(options.spotlightId ? { spotlightId: options.spotlightId } : {}),
		...(options.spotlightLabel ? { spotlightLabel: options.spotlightLabel } : {}),
		now,
	}));
	await insertHumanNotifications(db, notifications);
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
	const notifications: HumanNotificationInput[] = [...users].map((userId) => ({
		userId,
		worldId: follower.homeWorldId,
		eventKey: `bot_unfollowed:${follower.id}:${followed.id}:${now}`,
		notificationType: "bot_unfollowed",
		actor: follower,
		sourceType: "follow",
		sourceId: `${follower.id}:${followed.id}`,
		targetType: "bot",
		targetId: followed.id,
		title: `${localizedTextString(follower.displayName)} unfollowed ${localizedTextString(followed.displayName)}`,
		body: humanNotificationBodyWithReason(`u/${follower.handle} unfollowed u/${followed.handle}.`, options.reason),
		urlPath: botActivityUrlPath(follower, options.activityId),
		...(options.spotlightId ? { spotlightId: options.spotlightId } : {}),
		...(options.spotlightLabel ? { spotlightLabel: options.spotlightLabel } : {}),
		now,
	}));
	await insertHumanNotifications(db, notifications);
}

export async function recordSpotlightToolHumanNotification(
	db: D1DatabaseLike,
	input: {
		bot: BotDocument;
		spotlightId: string;
		runId: string;
		now?: string;
	} & (
		| { envelope: ToolResultEnvelope; toolName?: never; args?: never; result?: never }
		| { envelope?: never; toolName: string; args: Record<string, unknown>; result: unknown }
	),
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
	const envelope = input.envelope ?? legacyToolResultEnvelope(input.toolName ?? "", input.result, input.args);
	const standardNotifications = spotlightStandardHumanNotifications(envelope, input.bot, {
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
		title: `${localizedTextString(input.bot.displayName)} did not react to the spotlight`,
		body: `u/${input.bot.handle} reviewed the spotlight but did not act on the spotlighted content or its authors.`,
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
		message: RuntimeErrorCause | string;
		toolName?: string;
		now?: string;
	},
): Promise<void> {
	const now = input.now ?? new Date().toISOString();
	const repeatedToolFailure = Boolean(input.toolName);
	const title =
		repeatedToolFailure ?
			`${localizedTextString(input.bot.displayName)} hit repeated tool errors`
		:	`${localizedTextString(input.bot.displayName)} loop run failed`;
	const bodyLines =
		repeatedToolFailure ?
			[
				`u/${input.bot.handle} stopped after repeated invalid tool calls.`,
				input.toolName ? `Last failed tool: ${input.toolName}.` : "",
				ownerFacingRuntimeErrorMessage(input.message),
				"Check the loop and consider changing the bot's model or settings.",
			]
		:	[
				`u/${input.bot.handle}'s loop run stopped with an error.`,
				ownerFacingRuntimeErrorMessage(input.message),
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
		title: `${localizedTextString(input.bot.displayName)} could not process spotlight`,
		body: `u/${input.bot.handle} could not finish the spotlight tick: ${input.message}`,
		urlPath: `/w/${encodeURIComponent(input.bot.homeWorldHandle)}/u/${encodeURIComponent(input.bot.handle)}/loop`,
		spotlightId: input.spotlightId,
		spotlightLabel: "spotlight failed",
		now,
	});
}

export async function recordWorldSettingsChangedHumanNotifications(
	db: D1DatabaseLike,
	input: {
		previous: WorldDocument;
		updated: WorldDocument;
		editorUserId: string;
		now?: string;
	},
): Promise<void> {
	const now = input.now ?? new Date().toISOString();
	const changed = worldSettingsChangeLabels(input.previous, input.updated);
	if (changed.length === 0) {
		return;
	}
	const ownerRows = await db
		.prepare(
			`SELECT DISTINCT owner_user_id AS userId
			 FROM bots_index
			 WHERE home_world_id = ?
			   AND deleted_at IS NULL
			   AND lifecycle_state = 'active'
			   AND owner_user_id != ?`,
		)
		.bind(input.updated.id, input.editorUserId)
		.all<{ userId: string }>();
	const users = (ownerRows.results ?? []).map((row) => row.userId).filter(Boolean);
	if (users.length === 0) {
		return;
	}
	const title = `${localizedTextString(input.updated.name)} settings changed`;
	const body = `World settings changed: ${changed.join(", ")}.`;
	const urlPath = `/w/${encodeURIComponent(input.updated.handle)}/edit`;
	for (const userId of users) {
		const existing = await db
			.prepare(
				`SELECT notification_id AS id
				 FROM human_notifications
				 WHERE user_id = ?
				   AND world_id = ?
				   AND notification_type = 'world_settings_changed'
				   AND read_at IS NULL
				   AND archived_at IS NULL
				 ORDER BY created_at DESC
				 LIMIT 1`,
			)
			.bind(userId, input.updated.id)
			.first<{ id: string }>();
		if (existing) {
			await db
				.prepare(
					`UPDATE human_notifications
					 SET title = ?,
					     title_lang = ?,
					     body = ?,
					     body_lang = ?,
					     url_path = ?,
					     target_id = ?,
					     created_at = ?
					 WHERE notification_id = ?`,
				)
				.bind(title, null, body, null, urlPath, input.updated.id, now, existing.id)
				.run();
			continue;
		}
		await insertHumanNotification(db, {
			userId,
			worldId: input.updated.id,
			eventKey: `world_settings_changed:${input.updated.id}:${now}`,
			notificationType: "world_settings_changed",
			sourceType: "world",
			sourceId: input.updated.id,
			targetType: "world",
			targetId: input.updated.id,
			title,
			body,
			urlPath,
			now,
		});
	}
}

function worldSettingsChangeLabels(previous: WorldDocument, updated: WorldDocument): string[] {
	const labels: string[] = [];
	if (previous.handle !== updated.handle) labels.push("handle");
	if (localizedTextString(previous.name) !== localizedTextString(updated.name)) labels.push("name");
	if (localizedTextString(previous.description) !== localizedTextString(updated.description)) labels.push("short description");
	if (localizedTextString(previous.prompt) !== localizedTextString(updated.prompt)) labels.push("prompt");
	if (
		previous.recurringPromptEnabled !== updated.recurringPromptEnabled ||
		localizedTextString(previous.recurringPrompt) !== localizedTextString(updated.recurringPrompt)
	) {
		labels.push("recurring prompt");
	}
	if (localizedTextString(previous.initialBotNotification) !== localizedTextString(updated.initialBotNotification)) labels.push("initial participant notification");
	if (JSON.stringify(previous.postingSettings ?? {}) !== JSON.stringify(updated.postingSettings ?? {})) labels.push("posting limits");
	if (JSON.stringify(previous.threadSettings ?? {}) !== JSON.stringify(updated.threadSettings ?? {})) labels.push("thread comment limit");
	if ((previous.avatar?.url ?? "") !== (updated.avatar?.url ?? "") ||
		JSON.stringify(previous.avatar?.crop ?? null) !== JSON.stringify(updated.avatar?.crop ?? null)) {
		labels.push("avatar");
	}
	if (JSON.stringify(previous.imageGeneration ?? {}) !== JSON.stringify(updated.imageGeneration ?? {})) {
		labels.push("avatar generation settings");
	}
	return labels;
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
	await insertHumanNotificationRows(db, [humanNotificationInsertRow(input)]);
}

async function insertHumanNotifications(
	db: D1DatabaseLike,
	inputs: HumanNotificationInput[],
): Promise<void> {
	if (inputs.length === 0) {
		return;
	}
	await insertHumanNotificationRows(db, inputs.map(humanNotificationInsertRow));
}

function humanNotificationInsertRow(input: HumanNotificationInput): HumanNotificationInsertRow {
	const title = localizedTextFromStored(input.title);
	const body = localizedTextFromStored(input.body);
	const actorDisplayName = input.actor ? localizedTextFromStored(input.actor.displayName) : null;
	return {
		id: makeId("hnt"),
		userId: input.userId,
		worldId: input.worldId,
		eventKey: input.eventKey,
		notificationType: input.notificationType,
		actorBotId: input.actor?.id ?? null,
		actorHandle: input.actor?.handle ?? null,
		actorDisplayName: actorDisplayName?.text ?? null,
		actorDisplayNameLang: actorDisplayName?.lang ?? null,
		sourceType: input.sourceType ?? null,
		sourceId: input.sourceId ?? null,
		targetType: input.targetType ?? null,
		targetId: input.targetId ?? null,
		title: title.text,
		titleLang: title.lang,
		body: body.text,
		bodyLang: body.lang,
		urlPath: input.urlPath,
		spotlightId: input.spotlightId ?? null,
		spotlightLabel: input.spotlightLabel ?? null,
		createdAt: input.now,
	};
}

async function insertHumanNotificationRows(
	db: D1DatabaseLike,
	rows: HumanNotificationInsertRow[],
): Promise<void> {
	if (rows.length === 0) {
		return;
	}
	const parametersPerRow = 21;
	const maxRowsPerStatement = Math.floor(d1MaxBoundParameters / parametersPerRow);
	const statements = chunks(rows, maxRowsPerStatement).map((batch) => {
		const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)").join(", ");
		return db
			.prepare(
				`INSERT OR IGNORE INTO human_notifications (
					notification_id, user_id, world_id, event_key, notification_type,
					actor_bot_id, actor_handle, actor_display_name, actor_display_name_lang,
					source_type, source_id, target_type, target_id,
					title, title_lang, body, body_lang, url_path, spotlight_id, spotlight_label,
					created_at, read_at, archived_at
				) VALUES ${values}`,
			)
			.bind(...batch.flatMap(humanNotificationInsertBindings));
	});
	await db.batch(statements);
}

function humanNotificationInsertBindings(row: HumanNotificationInsertRow): unknown[] {
	return [
		row.id,
		row.userId,
		row.worldId,
		row.eventKey,
		row.notificationType,
		row.actorBotId,
		row.actorHandle,
		row.actorDisplayName,
		row.actorDisplayNameLang,
		row.sourceType,
		row.sourceId,
		row.targetType,
		row.targetId,
		row.title,
		row.titleLang,
		row.body,
		row.bodyLang,
		row.urlPath,
		row.spotlightId,
		row.spotlightLabel,
		row.createdAt,
	];
}

async function insertBotActivityEvent(
	db: D1DatabaseLike,
	input: BotActivityEventInput,
): Promise<string> {
	const activityId = input.activityId ?? makeId("act");
	const reason = input.reason ? localizedTextFromStored(input.reason) : null;
	await db
		.prepare(
			`${input.replace ? "INSERT OR REPLACE" : "INSERT"} INTO bot_activity_events (
				activity_id, world_id, bot_id, activity_type, target_type, target_id,
				value, reason, reason_lang, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			activityId,
			input.worldId,
			input.botId,
			input.activityType,
			input.targetType,
			input.targetId,
			input.value ?? null,
			reason?.text ?? null,
			reason?.lang ?? null,
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
	const title = localizedTextFromStored(input.title);
	const body = localizedTextFromStored(input.body);
	await db
		.prepare(
			`UPDATE human_notifications
			 SET spotlight_id = ?,
			     spotlight_label = ?,
			     title = ?,
			     title_lang = ?,
			     body = ?,
			     body_lang = ?,
			     url_path = ?
			 WHERE user_id = ? AND event_key = ?`,
		)
		.bind(input.spotlightId, input.spotlightLabel, title.text, title.lang, body.text, body.lang, input.urlPath, input.userId, input.eventKey)
		.run();
}

export async function createThread(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	input: CreateThreadInput,
	now = new Date().toISOString(),
): Promise<ThreadDocument> {
	const forum = await forumById(kv, db, input.forumId);
	await assertForumAcceptsNewContent(db, forum.id);
	const bot = await botById(kv, db, input.authorBotId);
	assertBotInWorld(bot, forum.worldId);
	const postingSettings = await effectivePostingSettingsForAuthor(kv, forum.worldId, bot);
	requiredPostingBody(input.body.text, "Thread body", postingHardLimit(postingSettings.threadBodyCharacters));

	const existingThread = await existingActiveThreadWithTitle(db, forum.id, input.title.text);
	if (existingThread) {
		throw repositoryError(
			"conflict",
			`A thread titled "${input.title.text}" already exists in f/${forum.handle}: ${existingThread.id}.`,
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
		lastActivityAt: now,
		createdAt: now,
		updatedAt: now,
	};

	await writeJson(kv, kvKeys.thread(thread.id), thread);
	await upsertThreadIndex(db, thread);
	await upsertCommentIndex(db, thread, rootComment);
	await putObjectIndex(db, thread, "thread", entityIndexVersions.thread, thread.worldId);

	const notificationRecipients = newNotificationRecipientDrafts();
	if (forum.personalBotId && forum.personalBotId !== bot.id) {
		addNotificationRecipient(notificationRecipients, {
			botId: forum.personalBotId,
			notificationType: "personal_forum_post",
			deliveryReason: "personal_forum_post",
			sourceObjectId: formatThreadRef(thread.id),
			message: `${localizedTextString(bot.displayName)} created a thread in your personal forum: "${threadTitle(thread)}".`,
		});
	}
	for (const mentioned of await mentionedBots(kv, db, thread.worldId, bot, `${input.title.text}\n${input.body.text}`)) {
		addNotificationRecipient(notificationRecipients, {
			botId: mentioned.id,
			notificationType: "mention",
			deliveryReason: "mention",
			sourceObjectId: formatThreadRef(thread.id),
			message: `${localizedTextString(bot.displayName)} mentioned you in "${threadTitle(thread)}".`,
		});
	}
	await addFollowerActivityRecipients(db, notificationRecipients, bot.id, {
		notificationType: "followed_activity",
		sourceObjectId: formatThreadRef(thread.id),
		message: `${localizedTextString(bot.displayName)} created "${threadTitle(thread)}".`,
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
				title_lang AS titleLang,
				world_handle AS worldHandle,
				forum_handle AS forumHandle
			 FROM threads_index
			 WHERE forum_id = ? AND deleted_at IS NULL AND title = ?
			 ORDER BY created_at ASC
			 LIMIT 1`,
		)
		.bind(forumId, title)
		.first<Omit<ExistingThreadDetails, "urlPath" | "title"> & { title: string; titleLang: string | null }>();
	if (!row) {
		return null;
	}
	return {
		...row,
		title: localizedTextFromStored({ lang: row.titleLang, text: row.title }),
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
	const thread = normalizeThreadDefaults(options.thread ?? await readThread(kv, input.threadId));
	if (thread.id !== input.threadId) {
		throw repositoryError("not_found", "Thread not found.", 404);
	}
	const forum = await assertThreadForumIsLive(kv, db, thread);
	await assertForumAcceptsNewContent(db, forum.id);
	const effectiveSettings = await effectiveThreadSettingsForForum(kv, forum);
	const lock = threadLock(thread.comments.length, effectiveSettings);
	if (lock) {
		throw repositoryError(
			"conflict",
			`Thread is locked after reaching its ${lock.limit}-comment limit.`,
			409,
		);
	}
	const bot = await botById(kv, db, input.authorBotId);
	assertBotInWorld(bot, thread.worldId);
	const postingSettings = await effectivePostingSettingsForAuthor(kv, thread.worldId, bot);
	requiredPostingBody(input.body.text, "Comment body", postingHardLimit(postingSettings.commentBodyCharacters));
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
	const comments = [...thread.comments, comment];
	const recentCommentCount = recentThreadCommentCount(comments, now);
	const updated: ThreadDocument = {
		...thread,
		comments,
		commentCount: comments.length,
		recentCommentCount,
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
			message: `${localizedTextString(bot.displayName)} replied to you in "${threadTitle(updated)}".`,
		});
	}
	for (const mentioned of await mentionedBots(kv, db, updated.worldId, bot, input.body.text)) {
		addNotificationRecipient(notificationRecipients, {
			botId: mentioned.id,
			notificationType: "mention",
			deliveryReason: "mention",
			sourceObjectId: formatCommentRef(comment.id),
			message: `${localizedTextString(bot.displayName)} mentioned you in "${threadTitle(updated)}".`,
		});
	}
	await addFollowerActivityRecipients(db, notificationRecipients, bot.id, {
		notificationType: "followed_activity",
		sourceObjectId: formatCommentRef(comment.id),
		message: `${localizedTextString(bot.displayName)} commented in "${threadTitle(updated)}".`,
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
	await assertThreadForumIsLive(kv, db, target.thread);
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
				message: `${localizedTextString(voter.displayName)} ${voteActionText(voteInput.value)} your comment.`,
			});
		}
		await addFollowerActivityRecipients(db, notificationRecipients, voter.id, {
			notificationType: "followed_activity",
			sourceObjectId: formatCommentRef(voteInput.targetId),
			message: `${localizedTextString(voter.displayName)} ${voteActionText(voteInput.value)} a comment in "${threadTitle(updated)}".`,
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
	await putObjectIndex(db, deleted, "thread", entityIndexVersions.thread, deleted.worldId);
	return deleted;
}

export async function softDeleteThreadForForum(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	forumId: string,
	threadId: string,
	now = new Date().toISOString(),
	options: { thread?: ThreadDocument } = {},
): Promise<ThreadDocument | null> {
	const thread = options.thread?.id === threadId ?
		options.thread
	:	await readJson<ThreadDocument>(kv, kvKeys.thread(threadId));
	if (!thread) {
		await markThreadIndexesDeleted(db, threadId, now);
		return null;
	}
	if (thread.id !== threadId || thread.forumId !== forumId) {
		throw repositoryError("not_found", "Thread not found in this forum.", 404);
	}
	if (thread.deletedAt) {
		await markThreadIndexesDeleted(db, thread.id, thread.deletedAt);
		await putObjectIndex(db, thread, "thread", entityIndexVersions.thread, thread.worldId);
		return thread;
	}
	return softDeleteThread(kv, db, thread, now);
}

export async function softDeleteComment(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	thread: ThreadDocument,
	commentId: string,
	now = new Date().toISOString(),
): Promise<ThreadDocument> {
	thread = normalizeThreadDefaults(thread);
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
	const recentCommentCount = recentThreadCommentCount(comments, now);
	const updated: ThreadDocument = {
		...thread,
		comments,
		commentCount: comments.length,
		recentCommentCount,
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
	await putObjectIndex(db, updated, "thread", entityIndexVersions.thread, updated.worldId);
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
				b.display_name_lang AS displayNameLang,
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
		.all<Omit<VoteDetail, "displayName"> & { displayName: string; displayNameLang: string | null }>();
	return (result.results ?? []).map(({ displayName, displayNameLang, ...row }) => ({
		...row,
		displayName: localizedTextFromIndex(displayName, displayNameLang),
	}));
}

export async function followBot(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	followerBotId: string,
	followedBotId: string,
	now = new Date().toISOString(),
	options: { reason?: LocalizedText | string; spotlightId?: string; spotlightLabel?: string } = {},
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
			message: `${localizedTextString(follower.displayName)} followed you.`,
		});
		await addFollowerActivityRecipients(db, notificationRecipients, follower.id, {
			notificationType: "followed_activity",
			sourceObjectId: followedBotId,
			message: `${localizedTextString(follower.displayName)} followed u/${followed.handle}.`,
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
	options: { reason?: LocalizedText | string; spotlightId?: string; spotlightLabel?: string } = {},
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
			message: `${localizedTextString(follower.displayName)} unfollowed u/${followed.handle}.`,
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

export async function listWorldPublicProfiles(
	db: D1DatabaseLike,
	worldId: string,
	viewerBotId: string,
	options: {
		mode: BotProfileListMode;
		limit: number;
		offset?: number;
	},
): Promise<BotProfileListResult> {
	const limit = Math.max(1, Math.min(50, Math.floor(options.limit)));
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const count = await db
		.prepare(
			`SELECT COUNT(*) AS total
			 FROM bots_index
			 WHERE home_world_id = ?
			   AND deleted_at IS NULL
			   AND lifecycle_state = 'active'
			   AND bot_id <> ?`,
		)
		.bind(worldId, viewerBotId)
		.first<{ total: number }>();
	const total = count?.total ?? 0;
	const rows = options.mode === "random" ?
		await db
			.prepare(
				`SELECT
					bot_id AS id,
					home_world_id AS homeWorldId,
					home_world_handle AS homeWorldHandle,
					handle,
					language,
					display_name AS displayName,
					display_name_lang AS displayNameLang,
					short_bio AS shortBio,
					short_bio_lang AS shortBioLang,
					avatar_url AS avatarUrl,
					avatar_crop AS avatarCrop,
					created_at AS createdAt,
					updated_at AS updatedAt
				 FROM bots_index
				 WHERE home_world_id = ?
				   AND deleted_at IS NULL
				   AND lifecycle_state = 'active'
				   AND bot_id <> ?
				 ORDER BY random()
				 LIMIT ?`,
			)
			.bind(worldId, viewerBotId, limit)
			.all<BotProfileListRow>()
	:	await db
			.prepare(
				`SELECT
					bot_id AS id,
					home_world_id AS homeWorldId,
					home_world_handle AS homeWorldHandle,
					handle,
					language,
					display_name AS displayName,
					display_name_lang AS displayNameLang,
					short_bio AS shortBio,
					short_bio_lang AS shortBioLang,
					avatar_url AS avatarUrl,
					avatar_crop AS avatarCrop,
					created_at AS createdAt,
					updated_at AS updatedAt
				 FROM bots_index
				 WHERE home_world_id = ?
				   AND deleted_at IS NULL
				   AND lifecycle_state = 'active'
				   AND bot_id <> ?
				 ORDER BY handle ASC
				 LIMIT ? OFFSET ?`,
			)
			.bind(worldId, viewerBotId, limit, offset)
			.all<BotProfileListRow>();
	const profiles = await botProfileRelationshipSummaries(
		db,
		viewerBotId,
		(rows.results ?? []).map(botPublicProfileFromListRow),
	);
	if (options.mode === "random") {
		return {
			mode: "random",
			limit,
			total,
			profiles,
		};
	}
	return {
		mode: "window",
		offset,
		limit,
		total,
		hasMore: offset + profiles.length < total,
		profiles,
	};
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
				   AND follower_bots.lifecycle_state = 'active'
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
	for (let index = 0; index < uniqueIds.length; index += d1SafeBoundParameters) {
		const batch = uniqueIds.slice(index, index + d1SafeBoundParameters);
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT f.followed_bot_id AS id, COUNT(follower_bots.bot_id) AS followers
				 FROM follows f
				 JOIN bots_index follower_bots
					ON follower_bots.bot_id = f.follower_bot_id
				   AND follower_bots.deleted_at IS NULL
				   AND follower_bots.lifecycle_state = 'active'
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
			"b.lifecycle_state = 'active'",
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
				   AND lifecycle_state = 'active'
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
			   AND deleted_at IS NULL
			   AND lifecycle_state = 'active'`,
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

	const activities = await activityItems(db, { scope: "bot", id: bot.id }, limit);
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
	const activities = await activityItems(db, { scope: "world", id: worldId }, limit);
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
					b.language,
					b.display_name AS displayName,
					b.display_name_lang AS displayNameLang,
					b.short_bio AS shortBio,
					b.short_bio_lang AS shortBioLang,
					b.avatar_url AS avatarUrl,
					b.avatar_crop AS avatarCrop,
					b.created_at AS createdAt,
					b.updated_at AS updatedAt
				 FROM follows f
				 JOIN bots_index b ON b.bot_id = f.followed_bot_id
				 WHERE f.follower_bot_id = ? AND b.deleted_at IS NULL AND b.lifecycle_state = 'active'
				 UNION ALL
				 SELECT
					'follower' AS direction,
					b.bot_id AS id,
					b.home_world_id AS homeWorldId,
					b.home_world_handle AS homeWorldHandle,
					b.handle,
					b.language,
					b.display_name AS displayName,
					b.display_name_lang AS displayNameLang,
					b.short_bio AS shortBio,
					b.short_bio_lang AS shortBioLang,
					b.avatar_url AS avatarUrl,
					b.avatar_crop AS avatarCrop,
					b.created_at AS createdAt,
					b.updated_at AS updatedAt
				 FROM follows f
				 JOIN bots_index b ON b.bot_id = f.follower_bot_id
				 WHERE f.followed_bot_id = ? AND b.deleted_at IS NULL AND b.lifecycle_state = 'active'
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
	now = new Date().toISOString(),
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
					t.title_lang AS titleLang,
					t.body_preview AS snippet,
					t.body_preview_lang AS snippetLang,
					t.author_bot_id AS authorBotId,
					t.author_handle AS authorHandle,
					t.author_display_name AS authorDisplayName,
					t.author_display_name_lang AS authorDisplayNameLang,
					b.avatar_url AS authorAvatarUrl,
					b.avatar_crop AS authorAvatarCrop,
					t.created_at AS createdAt,
					${threadHotScoreSql} AS score
				 FROM threads_index t
				 LEFT JOIN bots_index b ON b.bot_id = t.author_bot_id
				 WHERE t.world_id = ? AND t.deleted_at IS NULL AND lower(t.search_text) LIKE ? ESCAPE '\\'
				 ORDER BY t.last_activity_at DESC
				 LIMIT ?`,
			)
			.bind(now, worldId, term, limit)
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
					t.title_lang AS titleLang,
					c.body_preview AS snippet,
					c.body_preview_lang AS snippetLang,
					c.author_bot_id AS authorBotId,
					c.author_handle AS authorHandle,
					COALESCE(b.display_name, c.author_handle) AS authorDisplayName,
					b.display_name_lang AS authorDisplayNameLang,
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
	now = new Date().toISOString(),
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
					t.title_lang AS titleLang,
					t.body_preview AS snippet,
					t.body_preview_lang AS snippetLang,
					t.author_bot_id AS authorBotId,
					t.author_handle AS authorHandle,
					t.author_display_name AS authorDisplayName,
					t.author_display_name_lang AS authorDisplayNameLang,
					b.avatar_url AS authorAvatarUrl,
					b.avatar_crop AS authorAvatarCrop,
					t.created_at AS createdAt,
					${threadHotScoreSql} AS score
				 FROM threads_index t
				 LEFT JOIN bots_index b ON b.bot_id = t.author_bot_id
				 WHERE t.forum_id = ? AND t.deleted_at IS NULL AND lower(t.search_text) LIKE ? ESCAPE '\\'
				 ORDER BY t.last_activity_at DESC
				 LIMIT ?`,
			)
			.bind(now, forumId, term, limit)
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
					t.title_lang AS titleLang,
					c.body_preview AS snippet,
					c.body_preview_lang AS snippetLang,
					c.author_bot_id AS authorBotId,
					c.author_handle AS authorHandle,
					COALESCE(b.display_name, c.author_handle) AS authorDisplayName,
					b.display_name_lang AS authorDisplayNameLang,
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

type ActivityScope =
	| { scope: "bot"; id: string }
	| { scope: "world"; id: string };

const activityActorColumns = `a.bot_id AS actorId,
	a.home_world_id AS actorHomeWorldId,
	a.home_world_handle AS actorHomeWorldHandle,
	a.handle AS actorHandle,
	a.language AS actorLanguage,
	a.display_name AS actorDisplayName,
	a.display_name_lang AS actorDisplayNameLang,
	a.short_bio AS actorShortBio,
	a.short_bio_lang AS actorShortBioLang,
	a.avatar_url AS actorAvatarUrl,
	a.avatar_crop AS actorAvatarCrop,
	a.created_at AS actorCreatedAt,
	a.updated_at AS actorUpdatedAt`;

type ActivityQuerySource = {
	actorIdColumn: string;
	botIdColumn: string;
	worldIdColumn: string;
};

function activityQueryScope(scope: ActivityScope, source: ActivityQuerySource): {
	actorColumns: string;
	actorJoin: string;
	predicate: string;
} {
	switch (scope.scope) {
		case "bot":
			return {
				actorColumns: "",
				actorJoin: "",
				predicate: `${source.botIdColumn} = ?`,
			};
		case "world":
			return {
				actorColumns: `,\n\t\t\t\t${activityActorColumns}`,
				actorJoin: `JOIN bots_index a ON a.bot_id = ${source.actorIdColumn}`,
				predicate: `${source.worldIdColumn} = ? AND a.deleted_at IS NULL AND a.lifecycle_state = 'active'`,
			};
	}
}

function activityFromScopeRow<T extends BotActivityItem>(
	scope: ActivityScope,
	row: Partial<WorldActivityActorRow>,
	activity: T,
): T {
	if (scope.scope === "bot") {
		return activity;
	}
	return worldActivityFromRow(worldActivityActorRow(row), activity);
}

function worldActivityActorRow(row: Partial<WorldActivityActorRow>): WorldActivityActorRow {
	// The world query fragment selects every actor column as one unit. Keeping the
	// assertion here lets bot rows accurately omit those columns from their type.
	return row as WorldActivityActorRow;
}

async function activityItems(
	db: D1DatabaseLike,
	scope: { scope: "bot"; id: string },
	limit: number,
): Promise<BotActivityItem[]>;
async function activityItems(
	db: D1DatabaseLike,
	scope: { scope: "world"; id: string },
	limit: number,
): Promise<WorldActivityItem[]>;
async function activityItems(
	db: D1DatabaseLike,
	scope: ActivityScope,
	limit: number,
): Promise<BotActivityItem[]> {
	const groups = await Promise.all([
		threadActivities(db, scope, limit),
		commentActivities(db, scope, limit),
		voteEventActivities(db, scope, limit),
		followActivities(db, scope, limit),
		followEventActivities(db, scope, limit),
	]);
	return groups
		.flat()
		.sort((left, right) => Date.parse(activityDate(right)) - Date.parse(activityDate(left)))
		.slice(0, limit);
}

async function threadActivities(
	db: D1DatabaseLike,
	scope: ActivityScope,
	limit: number,
): Promise<BotActivityItem[]> {
	const query = activityQueryScope(scope, {
		actorIdColumn: "t.author_bot_id",
		botIdColumn: "t.author_bot_id",
		worldIdColumn: "t.world_id",
	});
	const result = await db
		.prepare(
			`SELECT
				t.thread_id AS threadId,
				t.root_comment_id AS rootCommentId,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title,
				t.title_lang AS titleLang,
				t.body_preview AS bodyPreview,
				t.body_preview_lang AS bodyPreviewLang,
				t.vote_score AS voteScore,
				t.comment_count AS commentCount,
				t.created_at AS createdAt${query.actorColumns}
			 FROM threads_index t
			 ${query.actorJoin}
			 WHERE ${query.predicate} AND t.deleted_at IS NULL
			 ORDER BY t.created_at DESC
			 LIMIT ?`,
		)
		.bind(scope.id, limit)
		.all<Partial<WorldActivityActorRow> & {
			threadId: string;
			rootCommentId: string;
			worldHandle: string;
			forumHandle: string;
			title: string;
			titleLang: string | null;
			bodyPreview: string;
			bodyPreviewLang: string | null;
			voteScore: number;
			commentCount: number;
			createdAt: string;
	}>();
	return (result.results ?? []).map((row) => activityFromScopeRow(scope, row, {
		type: "thread" as const,
		id: `thread:${row.threadId}`,
		threadId: row.threadId,
		rootCommentId: row.rootCommentId,
		worldHandle: row.worldHandle,
		forumHandle: row.forumHandle,
		title: localizedTextFromIndex(row.title, row.titleLang),
		bodyPreview: localizedTextFromIndex(row.bodyPreview, row.bodyPreviewLang),
		voteScore: row.voteScore,
		commentCount: row.commentCount,
		createdAt: row.createdAt,
	}));
}

async function commentActivities(
	db: D1DatabaseLike,
	scope: ActivityScope,
	limit: number,
): Promise<BotActivityItem[]> {
	const query = activityQueryScope(scope, {
		actorIdColumn: "c.author_bot_id",
		botIdColumn: "c.author_bot_id",
		worldIdColumn: "c.world_id",
	});
	const result = await db
		.prepare(
			`SELECT
				c.comment_id AS commentId,
				c.thread_id AS threadId,
				c.parent_comment_id AS parentCommentId,
				p.comment_id AS parentResolvedCommentId,
				p.author_handle AS parentAuthorHandle,
				COALESCE(pb.display_name, p.author_handle) AS parentAuthorDisplayName,
				pb.display_name_lang AS parentAuthorDisplayNameLang,
				p.body_preview AS parentBodyPreview,
				p.body_preview_lang AS parentBodyPreviewLang,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title AS threadTitle,
				t.title_lang AS threadTitleLang,
				c.body_preview AS bodyPreview,
				c.body_preview_lang AS bodyPreviewLang,
				c.vote_score AS voteScore,
				c.created_at AS createdAt${query.actorColumns}
			 FROM comments_index c
			 JOIN threads_index t ON t.thread_id = c.thread_id
			 ${query.actorJoin}
			 LEFT JOIN comments_index p ON p.comment_id = c.parent_comment_id AND p.deleted_at IS NULL
			 LEFT JOIN bots_index pb ON pb.bot_id = p.author_bot_id
			 WHERE ${query.predicate} AND c.is_root = 0 AND c.deleted_at IS NULL AND t.deleted_at IS NULL
			 ORDER BY c.created_at DESC
			 LIMIT ?`,
		)
		.bind(scope.id, limit)
		.all<Partial<WorldActivityActorRow> & {
			commentId: string;
			threadId: string;
			parentCommentId: string | null;
			parentResolvedCommentId: string | null;
			parentAuthorHandle: string | null;
			parentAuthorDisplayName: string | null;
			parentAuthorDisplayNameLang: string | null;
			parentBodyPreview: string | null;
			parentBodyPreviewLang: string | null;
			worldHandle: string;
			forumHandle: string;
			threadTitle: string;
			threadTitleLang: string | null;
			bodyPreview: string;
			bodyPreviewLang: string | null;
			voteScore: number;
			createdAt: string;
		}>();
	return (result.results ?? []).map((row) => {
		const parentComment = activityCommentContext(
			row.parentResolvedCommentId ?? row.parentCommentId,
			row.parentAuthorHandle,
			row.parentAuthorDisplayName,
			row.parentAuthorDisplayNameLang,
			row.parentBodyPreview,
			row.parentBodyPreviewLang,
		);
		return activityFromScopeRow(scope, row, {
			type: "comment" as const,
			id: `comment:${row.commentId}`,
			threadId: row.threadId,
			commentId: row.commentId,
			...(row.parentCommentId ? { parentCommentId: row.parentCommentId } : {}),
			...(parentComment ? { parentComment } : {}),
			worldHandle: row.worldHandle,
			forumHandle: row.forumHandle,
			threadTitle: localizedTextFromIndex(row.threadTitle, row.threadTitleLang),
			bodyPreview: localizedTextFromIndex(row.bodyPreview, row.bodyPreviewLang),
			voteScore: row.voteScore,
			createdAt: row.createdAt,
		});
	});
}

async function voteEventActivities(
	db: D1DatabaseLike,
	scope: ActivityScope,
	limit: number,
): Promise<BotActivityItem[]> {
	const query = activityQueryScope(scope, {
		actorIdColumn: "e.bot_id",
		botIdColumn: "e.bot_id",
		worldIdColumn: "e.world_id",
	});
	const result = await db
		.prepare(
			`SELECT
				e.target_id AS targetId,
				e.value AS value,
				e.reason,
				e.reason_lang AS reasonLang,
				e.created_at AS createdAt,
				c.comment_id AS commentId,
				c.thread_id AS threadId,
				c.author_handle AS targetAuthorHandle,
				COALESCE(tb.display_name, c.author_handle) AS targetAuthorDisplayName,
				tb.display_name_lang AS targetAuthorDisplayNameLang,
				c.body_preview AS targetBodyPreview,
				c.body_preview_lang AS targetBodyPreviewLang,
				t.world_handle AS worldHandle,
				t.forum_handle AS forumHandle,
				t.title AS title,
				t.title_lang AS titleLang${query.actorColumns}
			 FROM bot_activity_events e
			 ${query.actorJoin}
			 JOIN comments_index c ON c.comment_id = e.target_id
			 JOIN threads_index t ON t.thread_id = c.thread_id
			 LEFT JOIN bots_index tb ON tb.bot_id = c.author_bot_id
			 WHERE ${query.predicate}
			   AND e.activity_type = 'vote'
			   AND e.target_type = 'comment'
			   AND e.value != 0
			   AND c.deleted_at IS NULL
			   AND t.deleted_at IS NULL
			 ORDER BY e.created_at DESC
			 LIMIT ?`,
		)
		.bind(scope.id, limit)
		.all<Partial<WorldActivityActorRow> & {
			targetId: string;
			value: number;
			reason: string | null;
			reasonLang: string | null;
			createdAt: string;
			commentId: string;
			threadId: string;
			targetAuthorHandle: string | null;
			targetAuthorDisplayName: string | null;
			targetAuthorDisplayNameLang: string | null;
			targetBodyPreview: string | null;
			targetBodyPreviewLang: string | null;
			worldHandle: string;
			forumHandle: string;
			title: string;
			titleLang: string | null;
		}>();
	return (result.results ?? []).map((row) => {
		const reason = optionalLocalizedTextFromIndex(row.reason, row.reasonLang);
		const targetComment = activityCommentContext(
			row.commentId,
			row.targetAuthorHandle,
			row.targetAuthorDisplayName,
			row.targetAuthorDisplayNameLang,
			row.targetBodyPreview,
			row.targetBodyPreviewLang,
		);
		return activityFromScopeRow(scope, row, {
			type: "vote" as const,
			id: scope.scope === "world"
				? voteActivityStorageId(worldActivityActorRow(row).actorId, row.targetId)
				: voteActivityId(row.targetId),
			targetType: "comment" as const,
			targetId: row.targetId,
			commentId: row.commentId,
			value: row.value,
			threadId: row.threadId,
			worldHandle: row.worldHandle,
			forumHandle: row.forumHandle,
			title: localizedTextFromIndex(row.title, row.titleLang),
			...(reason ? { reason } : {}),
			...(targetComment ? { targetComment } : {}),
			updatedAt: row.createdAt,
		});
	});
}

async function followActivities(
	db: D1DatabaseLike,
	scope: ActivityScope,
	limit: number,
): Promise<BotActivityItem[]> {
	const query = activityQueryScope(scope, {
		actorIdColumn: "f.follower_bot_id",
		botIdColumn: "f.follower_bot_id",
		worldIdColumn: "f.world_id",
	});
	const result = await db
		.prepare(
			`SELECT
				f.followed_bot_id AS followedBotId,
				f.created_at AS createdAt,
				b.home_world_id AS homeWorldId,
				b.home_world_handle AS homeWorldHandle,
				b.handle,
				b.language,
				b.display_name AS displayName,
				b.display_name_lang AS displayNameLang,
				b.short_bio AS shortBio,
				b.short_bio_lang AS shortBioLang,
				b.avatar_url AS avatarUrl,
				b.avatar_crop AS avatarCrop,
				b.created_at AS botCreatedAt,
				b.updated_at AS botUpdatedAt${query.actorColumns}
			 FROM follows f
			 ${query.actorJoin}
			 JOIN bots_index b ON b.bot_id = f.followed_bot_id
			 LEFT JOIN bot_activity_events existing_event
				ON existing_event.bot_id = f.follower_bot_id
				AND existing_event.activity_type = 'follow'
				AND existing_event.target_type = 'bot'
				AND existing_event.target_id = f.followed_bot_id
			 WHERE ${query.predicate} AND b.deleted_at IS NULL AND b.lifecycle_state = 'active'
			   AND existing_event.activity_id IS NULL
			 ORDER BY f.created_at DESC
			 LIMIT ?`,
		)
		.bind(scope.id, limit)
		.all<Partial<WorldActivityActorRow> & {
			followedBotId: string;
			createdAt: string;
			homeWorldId: string;
			homeWorldHandle: string;
			handle: string;
			language: string | null;
			displayName: string;
			displayNameLang: string | null;
			shortBio: string;
			shortBioLang: string | null;
			avatarUrl: string | null;
			avatarCrop: string | null;
			botCreatedAt: string;
			botUpdatedAt: string;
		}>();
	return (result.results ?? []).map((row) => activityFromScopeRow(scope, row, {
		type: "follow" as const,
		id: scope.scope === "world"
			? `follow:${worldActivityActorRow(row).actorId}:${row.followedBotId}`
			: `follow:${row.followedBotId}`,
		bot: {
			id: row.followedBotId,
			homeWorldId: row.homeWorldId,
			homeWorldHandle: row.homeWorldHandle,
			handle: row.handle,
			language: row.language as BotPublicProfile["language"],
			displayName: localizedTextFromIndex(row.displayName, row.displayNameLang),
			shortBio: localizedTextFromIndex(row.shortBio, row.shortBioLang),
			...botAvatarFields(row.avatarUrl, row.avatarCrop),
			createdAt: row.botCreatedAt,
			updatedAt: row.botUpdatedAt,
		},
		createdAt: row.createdAt,
	}));
}

async function followEventActivities(
	db: D1DatabaseLike,
	scope: ActivityScope,
	limit: number,
): Promise<BotActivityItem[]> {
	const query = activityQueryScope(scope, {
		actorIdColumn: "e.bot_id",
		botIdColumn: "e.bot_id",
		worldIdColumn: "e.world_id",
	});
	const result = await db
		.prepare(
			`SELECT
				e.activity_id AS activityId,
				e.activity_type AS activityType,
				e.reason,
				e.reason_lang AS reasonLang,
				e.created_at AS createdAt,
				b.bot_id AS targetBotId,
				b.home_world_id AS homeWorldId,
				b.home_world_handle AS homeWorldHandle,
				b.handle,
				b.language,
				b.display_name AS displayName,
				b.display_name_lang AS displayNameLang,
				b.short_bio AS shortBio,
				b.short_bio_lang AS shortBioLang,
				b.avatar_url AS avatarUrl,
				b.avatar_crop AS avatarCrop,
				b.created_at AS botCreatedAt,
				b.updated_at AS botUpdatedAt${query.actorColumns}
			 FROM bot_activity_events e
			 ${query.actorJoin}
			 JOIN bots_index b ON b.bot_id = e.target_id
			 WHERE ${query.predicate}
			   AND e.activity_type IN ('follow', 'unfollow')
			   AND e.target_type = 'bot'
			   AND b.deleted_at IS NULL
			   AND b.lifecycle_state = 'active'
			 ORDER BY e.created_at DESC
			 LIMIT ?`,
		)
		.bind(scope.id, limit)
		.all<Partial<WorldActivityActorRow> & {
			activityId: string;
			activityType: "follow" | "unfollow";
			reason: string | null;
			reasonLang: string | null;
			createdAt: string;
			targetBotId: string;
			homeWorldId: string;
			homeWorldHandle: string;
			handle: string;
			language: string | null;
			displayName: string;
			displayNameLang: string | null;
			shortBio: string;
			shortBioLang: string | null;
			avatarUrl: string | null;
			avatarCrop: string | null;
			botCreatedAt: string;
			botUpdatedAt: string;
	}>();
	return (result.results ?? []).map((row) => {
		const reason = optionalLocalizedTextFromIndex(row.reason, row.reasonLang);
		return activityFromScopeRow(scope, row, {
			type: row.activityType,
			id: row.activityId,
			bot: {
				id: row.targetBotId,
				homeWorldId: row.homeWorldId,
				homeWorldHandle: row.homeWorldHandle,
				handle: row.handle,
				language: row.language as BotPublicProfile["language"],
				displayName: localizedTextFromIndex(row.displayName, row.displayNameLang),
				shortBio: localizedTextFromIndex(row.shortBio, row.shortBioLang),
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
	authorDisplayNameLang: string | null | undefined,
	bodyPreview: string | null | undefined,
	bodyPreviewLang: string | null | undefined,
): BotActivityCommentContext | undefined {
	if (!commentId || !authorHandle || !bodyPreview) {
		return undefined;
	}
	const displayName = optionalLocalizedTextFromIndex(authorDisplayName, authorDisplayNameLang);
	return {
		commentId,
		authorHandle,
		...(displayName ? { authorDisplayName: displayName } : {}),
		bodyPreview: localizedTextFromIndex(bodyPreview, bodyPreviewLang),
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
			language: row.actorLanguage as BotPublicProfile["language"],
			displayName: localizedTextFromIndex(row.actorDisplayName, row.actorDisplayNameLang),
			shortBio: localizedTextFromIndex(row.actorShortBio, row.actorShortBioLang),
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
	actorLanguage: string | null;
	actorDisplayName: string;
	actorDisplayNameLang: string | null;
	actorShortBio: string;
	actorShortBioLang: string | null;
	actorAvatarUrl: string | null;
	actorAvatarCrop: string | null;
	actorCreatedAt: string;
	actorUpdatedAt: string;
};

type BotFollowRow = {
	direction: "following" | "follower";
	id: string;
	homeWorldId: string;
	homeWorldHandle: string;
	handle: string;
	language: string | null;
	displayName: string;
	displayNameLang: string | null;
	shortBio: string;
	shortBioLang: string | null;
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
		language: row.language as BotPublicProfile["language"],
		displayName: localizedTextFromIndex(row.displayName, row.displayNameLang),
		shortBio: localizedTextFromIndex(row.shortBio, row.shortBioLang),
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

type SubscriptionCommentSummaryRow = Omit<HumanSubscriptionCommentSummary, "authorAvatarCrop" | "authorAvatarUrl"> & {
	authorAvatarUrl: string | null;
	authorAvatarCrop: string | null;
	authorDisplayName: string;
	authorDisplayNameLang: string | null;
	bodyPreview: string;
	bodyPreviewLang: string | null;
};

type SubscriptionBotProfileRow = Omit<BotPublicProfile, "avatarCrop" | "avatarUrl" | "displayName" | "shortBio"> & {
	avatarUrl: string | null;
	avatarCrop: string | null;
	displayName: string;
	displayNameLang: string | null;
	shortBio: string;
	shortBioLang: string | null;
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
	actorDisplayNameLang: string | null;
	worldHandle: string | null;
	worldName: string | null;
	worldNameLang: string | null;
	forumId: string | null;
	forumHandle: string | null;
	forumName: string | null;
	forumNameLang: string | null;
	sourceType: string | null;
	sourceId: string | null;
	targetType: string | null;
	targetId: string | null;
	title: string;
	titleLang: string | null;
	body: string;
	bodyLang: string | null;
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
	title: LocalizedText | string;
	body: LocalizedText | string;
	urlPath: string;
	spotlightId?: string;
	spotlightLabel?: string;
	now: string;
};

type HumanNotificationInsertRow = {
	id: string;
	userId: string;
	worldId: string;
	eventKey: string;
	notificationType: HumanNotificationType;
	actorBotId: string | null;
	actorHandle: string | null;
	actorDisplayName: string | null;
	actorDisplayNameLang: string | null;
	sourceType: string | null;
	sourceId: string | null;
	targetType: string | null;
	targetId: string | null;
	title: string;
	titleLang: string | null;
	body: string;
	bodyLang: string | null;
	urlPath: string;
	spotlightId: string | null;
	spotlightLabel: string | null;
	createdAt: string;
};

type BotActivityNotificationOptions = {
	activityId?: string;
	reason?: LocalizedText | string;
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
	reason?: LocalizedText | string;
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
	hn.actor_display_name_lang AS actorDisplayNameLang,
	w.handle AS worldHandle,
	w.name AS worldName,
	w.name_lang AS worldNameLang,
	resolved_forum.forum_id AS forumId,
	resolved_forum.handle AS forumHandle,
	resolved_forum.description AS forumName,
	resolved_forum.description_lang AS forumNameLang,
	hn.source_type AS sourceType,
	hn.source_id AS sourceId,
	hn.target_type AS targetType,
	hn.target_id AS targetId,
	hn.title,
	hn.title_lang AS titleLang,
	hn.body,
	hn.body_lang AS bodyLang,
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

function subscriptionCommentSummaryFromRow(row: SubscriptionCommentSummaryRow): HumanSubscriptionCommentSummary {
	const crop = cropFromIndex(row.authorAvatarCrop);
	const { authorAvatarUrl, authorDisplayName, authorDisplayNameLang, bodyPreview, bodyPreviewLang, ...comment } = withoutAuthorAvatarCrop(row);
	return {
		...comment,
		authorDisplayName: localizedTextFromIndex(authorDisplayName, authorDisplayNameLang),
		bodyPreview: localizedTextFromIndex(bodyPreview, bodyPreviewLang),
		...(authorAvatarUrl ? { authorAvatarUrl } : {}),
		...(crop ? { authorAvatarCrop: crop } : {}),
	};
}

function subscriptionBotProfileFromRow(row: SubscriptionBotProfileRow): BotPublicProfile {
	const { avatarCrop, avatarUrl, displayName, displayNameLang, shortBio, shortBioLang, ...bot } = row;
	const crop = cropFromIndex(avatarCrop);
	return {
		...bot,
		displayName: localizedTextFromIndex(displayName, displayNameLang),
		shortBio: localizedTextFromIndex(shortBio, shortBioLang),
		...(avatarUrl ? { avatarUrl } : {}),
		...(crop ? { avatarCrop: crop } : {}),
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
		...(row.actorDisplayName ? { actorDisplayName: localizedTextFromIndex(row.actorDisplayName, row.actorDisplayNameLang) } : {}),
		...(row.worldHandle ? { worldHandle: row.worldHandle } : {}),
		...(row.worldName ? { worldName: localizedTextFromIndex(row.worldName, row.worldNameLang) } : {}),
		...(row.forumId ? { forumId: row.forumId } : {}),
		...(row.forumHandle ? { forumHandle: row.forumHandle } : {}),
		...(row.forumName ? { forumName: localizedTextFromIndex(row.forumName, row.forumNameLang) } : {}),
		...(row.sourceType ? { sourceType: row.sourceType } : {}),
		...(row.sourceId ? { sourceId: row.sourceId } : {}),
		...(row.targetType ? { targetType: row.targetType } : {}),
		...(row.targetId ? { targetId: row.targetId } : {}),
		title: localizedTextFromIndex(row.title, row.titleLang),
		body: localizedTextFromIndex(row.body, row.bodyLang),
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
	title: LocalizedText;
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
	await markBotSeenFromEnvelope(db, botId, legacyToolResultEnvelope("", result), seenVia, sourceId, now);
}

export async function markBotSeenFromEnvelope(
	db: D1DatabaseLike,
	botId: string,
	envelope: ToolResultEnvelope,
	seenVia: string,
	sourceId?: string,
	now = new Date().toISOString(),
): Promise<void> {
	await markBotSeenContent(db, botId, seenItemsFromToolResultEnvelope(envelope), seenVia, sourceId, now);
}

export function seenItemsFromToolResultEnvelope(envelope: ToolResultEnvelope): SeenContentItem[] {
	switch (envelope.kind) {
		case "thread_created":
			return seenItemsForThread(envelope.thread);
		case "comment_created":
			return seenItemsForThread(envelope.thread);
		case "vote_set":
			return envelope.votes.flatMap((vote) => seenItemsForThread(vote.thread));
		case "content_read":
			return envelope.items.map((item) => ({ type: item.kind, id: item.id }));
		case "profile_followed":
		case "profile_unfollowed":
		case "opaque":
			return [];
		default:
			return assertNeverToolResultEnvelope(envelope);
	}
}

function seenItemsForThread(thread: ThreadDocument): SeenContentItem[] {
	return [
		{ type: "thread", id: thread.id },
		...thread.comments.map((comment): SeenContentItem => ({ type: "comment", id: comment.id })),
	];
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

	const storedWorld = await readJson<WorldDocument>(kv, kvKeys.world(bot.homeWorldId));
	const world = storedWorld ? normalizeWorldDefaults(storedWorld) : null;
	const intro = await db
		.prepare(
			`SELECT forum_id AS id
			 FROM forums_index
			 WHERE world_id = ? AND handle = ? AND deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(bot.homeWorldId, introForumHandle)
		.first<{ id: string }>();
	const message = botInitialNotification(world?.initialBotNotification ?? localizedText(defaultInitialBotNotification, null), Boolean(intro));
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

function botInitialNotification(base: LocalizedText, hasIntroForum: boolean): LocalizedText {
	if (!hasIntroForum) {
		return base;
	}
	return localizedText([
		base.text,
		`The forum f/${introForumHandle} exists for introductions. Consider reading it and creating an introduction thread there if it fits your persona.`,
	].join("\n\n"), null);
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
			// KV put replaces the entry including its expiration, so this rewrite
			// must re-arm the retention TTL or delivered documents would outlive
			// their phase-1 D1 rows forever.
			writeJson(kv, kvKeys.notification(notification.botId, notification.id), notification, {
				expirationTtl: notificationKvExpirationTtlSeconds,
			}),
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

export async function pruneExpiredNotifications(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	options: {
		now?: string;
		selectLimit?: number;
		maxRowsPerRun?: number;
		kvDeleteChunkSize?: number;
	} = {},
): Promise<NotificationPruneResult> {
	const now = options.now ?? new Date().toISOString();
	const cutoffs = notificationRetentionCutoffs(now);
	const selectLimit = positiveIntegerOption(options.selectLimit ?? notificationPruneSelectLimit, "selectLimit");
	const maxRowsPerRun = nonNegativeIntegerOption(options.maxRowsPerRun ?? notificationPruneMaxRowsPerRun, "maxRowsPerRun");
	const kvDeleteChunkSize = positiveIntegerOption(
		options.kvDeleteChunkSize ?? notificationPruneKvDeleteChunkSize,
		"kvDeleteChunkSize",
	);
	const result: NotificationPruneResult = {
		selectedRows: 0,
		deletedRows: 0,
		kvDeleteFailures: 0,
		batches: 0,
		budgetExhausted: false,
		phase1DeletedRows: 0,
		phase2DeletedRows: 0,
	};

	result.phase1DeletedRows = await deleteTtlBackedNotificationRows(db, cutoffs);
	result.deletedRows += result.phase1DeletedRows;

	let cursor: ExpiredNotificationCursor | undefined;
	while (result.selectedRows < maxRowsPerRun) {
		const remainingBudget = maxRowsPerRun - result.selectedRows;
		const limit = Math.min(selectLimit, remainingBudget);
		const rows = await selectLegacyExpiredNotifications(db, cutoffs, limit, cursor);
		if (rows.length === 0) {
			break;
		}

		result.batches += 1;
		result.selectedRows += rows.length;
		cursor = legacyNotificationCursor(rows[rows.length - 1]);
		const kvDeleteResult = await deleteExpiredNotificationKvDocuments(kv, rows, kvDeleteChunkSize);
		result.kvDeleteFailures += kvDeleteResult.failures;
		const phase2DeletedRows = await deleteNotificationRows(db, kvDeleteResult.deletedRows.map((row) => row.id));
		result.phase2DeletedRows += phase2DeletedRows;
		result.deletedRows += phase2DeletedRows;

		if (rows.length < limit) {
			break;
		}
	}

	result.budgetExhausted = maxRowsPerRun > 0 && result.selectedRows >= maxRowsPerRun;
	return result;
}

export async function pruneExpiredBotSeenContent(
	db: D1DatabaseLike,
	options: {
		now?: string;
		batchSize?: number;
		maxRowsPerRun?: number;
	} = {},
): Promise<BotSeenContentPruneResult> {
	const now = options.now ?? new Date().toISOString();
	const cutoff = botSeenContentRetentionCutoff(now);
	const batchSize = positiveIntegerOption(options.batchSize ?? botSeenContentPruneBatchSize, "batchSize");
	const maxRowsPerRun = nonNegativeIntegerOption(options.maxRowsPerRun ?? botSeenContentPruneMaxRowsPerRun, "maxRowsPerRun");
	const result: BotSeenContentPruneResult = {
		deletedRows: 0,
		batches: 0,
		budgetExhausted: false,
	};

	while (result.deletedRows < maxRowsPerRun) {
		const limit = Math.min(batchSize, maxRowsPerRun - result.deletedRows);
		const deleteResult = await db
			.prepare(
				`DELETE FROM bot_seen_content
				 WHERE last_seen_at < ?
				 LIMIT ?`,
			)
			.bind(cutoff, limit)
			.run();
		const deletedRows = deleteResult.meta?.changes ?? 0;
		if (deletedRows === 0) {
			break;
		}
		result.deletedRows += deletedRows;
		result.batches += 1;
		if (deletedRows < limit) {
			break;
		}
	}

	result.budgetExhausted = maxRowsPerRun > 0 && result.deletedRows >= maxRowsPerRun;
	return result;
}

function botSeenContentRetentionCutoff(now: string): string {
	const nowMs = Date.parse(now);
	if (!Number.isFinite(nowMs)) {
		throw new Error(`Invalid bot seen-content retention timestamp: ${now}`);
	}
	return new Date(nowMs - botSeenContentRetentionDays * secondsPerDay * 1000).toISOString();
}

function notificationRetentionCutoffs(now: string): Readonly<Record<NotificationStatus, string>> {
	const nowMs = Date.parse(now);
	if (!Number.isFinite(nowMs)) {
		throw new Error(`Invalid notification retention timestamp: ${now}`);
	}
	return {
		pending: new Date(nowMs - notificationRetentionSecondsByStatus.pending * 1000).toISOString(),
		delivered_to_loop: new Date(nowMs - notificationRetentionSecondsByStatus.delivered_to_loop * 1000).toISOString(),
		read_or_consumed: new Date(nowMs - notificationRetentionSecondsByStatus.read_or_consumed * 1000).toISOString(),
		archived: new Date(nowMs - notificationRetentionSecondsByStatus.archived * 1000).toISOString(),
	};
}

async function deleteTtlBackedNotificationRows(
	db: D1DatabaseLike,
	cutoffs: Readonly<Record<NotificationStatus, string>>,
): Promise<number> {
	let deletedRows = 0;
	for (const status of notificationStatuses) {
		const result = await db
			.prepare(
				`DELETE FROM notifications
				 WHERE status = ?
				   AND created_at <= ?
				   AND created_at >= ?`,
			)
			.bind(status, cutoffs[status], notificationKvTtlSince)
			.run();
		deletedRows += result.meta?.changes ?? 0;
	}
	return deletedRows;
}

const notificationStatuses: readonly NotificationStatus[] = [
	"pending",
	"delivered_to_loop",
	"read_or_consumed",
	"archived",
];

type ExpiredNotificationCursor = {
	createdAt: string;
	id: string;
};

function legacyNotificationCursor(row: ExpiredNotificationRow | undefined): ExpiredNotificationCursor | undefined {
	return row ? { createdAt: row.createdAt, id: row.id } : undefined;
}

async function selectLegacyExpiredNotifications(
	db: D1DatabaseLike,
	cutoffs: Readonly<Record<NotificationStatus, string>>,
	limit: number,
	cursor?: ExpiredNotificationCursor,
): Promise<ExpiredNotificationRow[]> {
	const result = await db
		.prepare(
			`WITH expired_notifications AS (
				SELECT notification_id AS id, bot_id AS botId, created_at AS createdAt
				FROM notifications
				WHERE status = 'pending' AND created_at <= ? AND created_at < ?
				UNION ALL
				SELECT notification_id AS id, bot_id AS botId, created_at AS createdAt
				FROM notifications
				WHERE status = 'delivered_to_loop' AND created_at <= ? AND created_at < ?
				UNION ALL
				SELECT notification_id AS id, bot_id AS botId, created_at AS createdAt
				FROM notifications
				WHERE status = 'read_or_consumed' AND created_at <= ? AND created_at < ?
				UNION ALL
				SELECT notification_id AS id, bot_id AS botId, created_at AS createdAt
				FROM notifications
				WHERE status = 'archived' AND created_at <= ? AND created_at < ?
			)
			SELECT id, botId, createdAt
			FROM expired_notifications
			WHERE (? IS NULL OR createdAt > ? OR (createdAt = ? AND id > ?))
			ORDER BY createdAt ASC, id ASC
			LIMIT ?`,
		)
		.bind(
			cutoffs.pending,
			notificationKvTtlSince,
			cutoffs.delivered_to_loop,
			notificationKvTtlSince,
			cutoffs.read_or_consumed,
			notificationKvTtlSince,
			cutoffs.archived,
			notificationKvTtlSince,
			cursor?.createdAt ?? null,
			cursor?.createdAt ?? null,
			cursor?.createdAt ?? null,
			cursor?.id ?? null,
			limit,
		)
		.all<ExpiredNotificationRow>();
	return result.results ?? [];
}

async function deleteExpiredNotificationKvDocuments(
	kv: KVNamespaceLike,
	rows: ExpiredNotificationRow[],
	chunkSize: number,
): Promise<{ deletedRows: ExpiredNotificationRow[]; failures: number }> {
	let failures = 0;
	const deletedRows: ExpiredNotificationRow[] = [];
	for (const batch of chunks(rows, chunkSize)) {
		const outcomes = await Promise.all(
			batch.map(async (row) => {
				try {
					await deleteKey(kv, kvKeys.notification(row.botId, row.id));
					return row;
				} catch {
					return null;
				}
			}),
		);
		for (const row of outcomes) {
			if (row) {
				deletedRows.push(row);
			} else {
				failures += 1;
			}
		}
	}
	return { deletedRows, failures };
}

async function deleteNotificationRows(db: D1DatabaseLike, notificationIds: string[]): Promise<number> {
	let deletedRows = 0;
	for (const batch of chunks(notificationIds, d1SafeBoundParameters)) {
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db
			.prepare(`DELETE FROM notifications WHERE notification_id IN (${placeholders})`)
			.bind(...batch)
			.run();
		deletedRows += result.meta?.changes ?? batch.length;
	}
	return deletedRows;
}

function positiveIntegerOption(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return value;
}

function nonNegativeIntegerOption(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative integer.`);
	}
	return value;
}

type NotificationCreateInput = {
	worldId: string;
	botId: string;
	notificationType: NotificationType;
	sourceObjectId?: string;
	message: LocalizedText | string;
	event?: Omit<NotificationEvent, "id" | "createdAt">;
	now: string;
};

async function createNotification(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	input: NotificationCreateInput,
): Promise<NotificationDocument> {
	const notification = notificationDocumentFromInput(input);
	await writeNotificationDocuments(kv, [notification]);
	await insertNotificationRows(db, [notification], "insert");
	return notification;
}

function notificationDocumentFromInput(input: NotificationCreateInput): NotificationDocument {
	const id = makeId("ntf");
	const message = localizedTextFromStored(input.message);
	return {
		id,
		type: "notification",
		schemaVersion,
		revision: 1,
		worldId: input.worldId,
		botId: input.botId,
		notificationType: input.notificationType,
		status: "pending",
		...(input.sourceObjectId ? { sourceObjectId: input.sourceObjectId } : {}),
		message,
		...(input.event ? { event: { ...input.event, id, createdAt: input.now } } : {}),
		createdAt: input.now,
		updatedAt: input.now,
	};
}

async function writeNotificationDocuments(
	kv: KVNamespaceLike,
	notifications: NotificationDocument[],
): Promise<void> {
	// Bot notifications are retained from creation: delivered/read/archived rows
	// are pruned after 30 days, pending rows after 90 days. KV mirrors use the
	// max retention TTL so new documents self-clean even if a prune run is delayed.
	for (const batch of chunks(notifications, notificationKvWriteChunkSize)) {
		await Promise.all(
			batch.map((notification) =>
				writeJson(kv, kvKeys.notification(notification.botId, notification.id), notification, {
					expirationTtl: notificationKvExpirationTtlSeconds,
				}),
			),
		);
	}
}

async function insertNotificationRows(
	db: D1DatabaseLike,
	notifications: NotificationDocument[],
	mode: "insert" | "insertOrIgnore",
): Promise<void> {
	if (notifications.length === 0) {
		return;
	}
	const parametersPerRow = 9;
	const maxRowsPerStatement = Math.floor(d1MaxBoundParameters / parametersPerRow);
	const insertMode = mode === "insertOrIgnore" ? "INSERT OR IGNORE" : "INSERT";
	const statements = chunks(notifications, maxRowsPerStatement).map((batch) => {
		const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)").join(", ");
		return db
			.prepare(
				`${insertMode} INTO notifications (
					notification_id, world_id, bot_id, type, source_object_id, status, message, message_lang,
					created_at, delivered_at, read_at
				) VALUES ${values}`,
			)
			.bind(...batch.flatMap(notificationInsertBindings));
	});
	await db.batch(statements);
}

function notificationInsertBindings(notification: NotificationDocument): unknown[] {
	return [
		notification.id,
		notification.worldId,
		notification.botId,
		notification.notificationType,
		notification.sourceObjectId ?? null,
		notification.status,
		notification.message.text,
		notification.message.lang,
		notification.createdAt,
	];
}

type NotificationRecipientDraft = {
	botId: string;
	notificationType: NotificationType;
	deliveryReasons: Set<NotificationDeliveryReason>;
	sourceObjectId?: string;
	message: LocalizedText | string;
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
		message: LocalizedText | string;
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
		message: LocalizedText | string;
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
	const notifications = [...recipients.values()].map((recipient) => {
		const message = localizedTextFromStored(recipient.message);
		return notificationDocumentFromInput({
			worldId,
			botId: recipient.botId,
			notificationType: recipient.notificationType,
			...(recipient.sourceObjectId ? { sourceObjectId: recipient.sourceObjectId } : {}),
			message,
			event: {
				...event,
				...(recipient.sourceObjectId ? { sourceObjectId: recipient.sourceObjectId } : {}),
				message,
				deliveryReasons: orderedDeliveryReasons(recipient.deliveryReasons),
			},
			now,
		});
	});
	if (notifications.length > 0) {
		await writeNotificationDocuments(kv, notifications);
		await insertNotificationRows(db, notifications, "insertOrIgnore");
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
	displayName: LocalizedText | string;
	shortBio?: LocalizedText | string;
}): NotificationProfileRef {
	const shortBio = input.shortBio ? localizedTextFromStored(input.shortBio) : undefined;
	return {
		id: input.id,
		username: `u/${input.handle}`,
		displayName: localizedTextFromStored(input.displayName),
		...(shortBio ? { shortBio } : {}),
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
		title: thread.title,
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

// seenSetsForBots intentionally treats bot_seen_content as a timeless dedup set.
// Pruning this D1-only table means spotlight may re-show content a bot last saw
// before this retention window; fresher seen rows keep their current behavior.
export const botSeenContentRetentionDays = 90;

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
	const recentCommentCount = recentThreadCommentCount(thread.comments, now);
	if (input.targetId === thread.rootCommentId) {
		const nextScore = thread.voteScore + delta;
		return {
			...thread,
			voteScore: nextScore,
			recentCommentCount,
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
		recentCommentCount,
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
		const thread = normalizeThreadDefaults(knownThread?.id === input.targetId ? knownThread : await readThread(kv, input.targetId));
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
	const thread = normalizeThreadDefaults(knownThread?.id === row.threadId ? knownThread : await readThread(kv, row.threadId));
	const comment = thread.comments.find((item) => item.id === input.targetId);
	if (!comment) {
		throw repositoryError("not_found", "Comment not found.", 404);
	}
	return { thread, authorBotId: comment.authorBotId, commentId: comment.id };
}

export async function upsertThreadIndexProjection(
	db: D1DatabaseLike,
	thread: ThreadDocument,
): Promise<ThreadDocument> {
	const normalized = normalizeThreadDefaults(thread);
	await upsertThreadIndex(db, normalized);
	return normalized;
}

async function upsertThreadIndex(db: D1DatabaseLike, thread: ThreadDocument): Promise<void> {
	const root = rootCommentForThread(thread);
	const authorDisplayName = localizedTextFromStored(root.authorDisplayName);
	const title = localizedTextFromStored(thread.title);
	const bodyPreview = localizedPreview(root.body);
	const rootBody = localizedTextString(root.body);
	await db
		.prepare(
			`INSERT INTO threads_index (
				thread_id, root_comment_id, world_id, world_handle, forum_id, forum_handle, author_bot_id,
				author_handle, author_display_name, author_display_name_lang, title, title_lang,
				body_preview, body_preview_lang, search_text, vote_score,
				comment_count, recent_comment_count, created_at, last_activity_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(thread_id) DO UPDATE SET
				root_comment_id = excluded.root_comment_id,
				world_id = excluded.world_id,
				world_handle = excluded.world_handle,
				forum_id = excluded.forum_id,
				forum_handle = excluded.forum_handle,
				author_bot_id = excluded.author_bot_id,
				author_handle = excluded.author_handle,
				author_display_name = excluded.author_display_name,
				author_display_name_lang = excluded.author_display_name_lang,
				title = excluded.title,
				title_lang = excluded.title_lang,
				body_preview = excluded.body_preview,
				body_preview_lang = excluded.body_preview_lang,
				search_text = excluded.search_text,
				vote_score = excluded.vote_score,
				comment_count = excluded.comment_count,
				recent_comment_count = excluded.recent_comment_count,
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
			authorDisplayName.text,
			authorDisplayName.lang,
			title.text,
			title.lang,
			bodyPreview.text,
			bodyPreview.lang,
			`${title.text}\n${rootBody}`.toLowerCase(),
			thread.voteScore,
			thread.commentCount,
			thread.recentCommentCount,
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
	const bodyPreview = localizedPreview(comment.body);
	const body = localizedTextString(comment.body);
	await db
		.prepare(
			`INSERT INTO comments_index (
				comment_id, thread_id, world_id, forum_id, author_bot_id, author_handle,
				parent_comment_id, body_preview, body_preview_lang, search_text, vote_score, created_at, deleted_at, is_root
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(comment_id) DO UPDATE SET
				parent_comment_id = excluded.parent_comment_id,
				body_preview = excluded.body_preview,
				body_preview_lang = excluded.body_preview_lang,
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
			bodyPreview.text,
			bodyPreview.lang,
			body.toLowerCase(),
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

async function effectiveThreadSettingsForForum(
	kv: KVNamespaceLike,
	forum: ForumDocument,
): Promise<ReturnType<typeof effectiveThreadSettings>> {
	const world = await readJson<WorldDocument>(kv, kvKeys.world(forum.worldId));
	if (!world || world.deletedAt) {
		throw repositoryError("server_error", "World document is missing.", 500);
	}
	return effectiveThreadSettings(world.threadSettings, forum.threadSettings);
}

export function threadHotScore(input: ThreadHotScoreInput, now = new Date().toISOString()): number {
	const engagement = Math.max(
		0,
		input.voteScore * threadHotScoreCoefficients.voteScore
			+ input.recentCommentCount * threadHotScoreCoefficients.recentCommentCount,
	);
	if (engagement === 0) {
		return 0;
	}
	const lastActivityAtMs = Date.parse(input.lastActivityAt);
	const nowMs = Date.parse(now);
	if (!Number.isFinite(lastActivityAtMs) || !Number.isFinite(nowMs)) {
		return 0;
	}
	const ageMs = Math.max(0, nowMs - lastActivityAtMs);
	const decay = Math.max(0, Math.min(1, 1 - ageMs / hotThreadWindowMs));
	return engagement * decay;
}

export async function refreshThreadHotScores(
	db: D1DatabaseLike,
	now = new Date().toISOString(),
): Promise<number> {
	const cutoff = hotThreadCutoff(now);
	const recentCommentCountSql = `(
		SELECT count(*)
		FROM comments_index c
		WHERE c.thread_id = threads_index.thread_id
		  AND c.deleted_at IS NULL
		  AND c.created_at > ?
	)`;
	const result = await db
		.prepare(
			`UPDATE threads_index
			 SET recent_comment_count = ${recentCommentCountSql}
			 WHERE deleted_at IS NULL`,
		)
		.bind(cutoff)
		.run();
	return result.meta?.changes ?? 0;
}

function recentThreadCommentCount(comments: CommentDocument[], now: string): number {
	const cutoffMs = Date.parse(hotThreadCutoff(now));
	return comments.reduce((count, comment) => {
		const createdAtMs = Date.parse(comment.createdAt);
		return Number.isFinite(createdAtMs) && createdAtMs > cutoffMs ? count + 1 : count;
	}, 0);
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

async function countNewCommentsForThreads(
	db: D1DatabaseLike,
	threadIds: string[],
	seenThroughAt: string,
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	const uniqueThreadIds = [...new Set(threadIds)];
	if (uniqueThreadIds.length === 0) {
		return counts;
	}
	const maxThreadIdsPerQuery = d1MaxBoundParameters - 1;
	for (const batch of chunks(uniqueThreadIds, maxThreadIdsPerQuery)) {
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT thread_id AS threadId, COUNT(*) AS count
				 FROM comments_index
				 WHERE thread_id IN (${placeholders})
				   AND deleted_at IS NULL
				   AND created_at > ?
				 GROUP BY thread_id`,
			)
			.bind(...batch, seenThroughAt)
			.all<NewCommentCountRow>();
		for (const row of result.results ?? []) {
			counts.set(row.threadId, row.count);
		}
	}
	return counts;
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
			title: thread.title,
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
		title: thread.title,
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
		...(options.focus ? { focused: true } : {}),
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
		...(spotlightedCommentIds?.has(comment.id) ? { focused: true as const } : {}),
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
				...(spotlightedCommentIds?.has(comment.id) ? { focused: true as const } : {}),
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
		if (!shortBio || !localizedTextString(shortBio)) {
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
): Promise<LocalizedText | undefined> {
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
			title: thread.title,
			rootCommentId: thread.rootCommentId,
		})),
		content,
	};
}

type SpotlightPromptIncludedContent = Omit<SpotlightIncludedContent, "focused"> & {
	"My focus is on this comment"?: true;
};

export function spotlightInjectedText(context: SpotlightSyntheticContext): string {
	const promptContext = {
		...context,
		content: context.content.map(spotlightPromptIncludedContent),
	};
	return JSON.stringify(promptContext, null, 2);
}

function spotlightPromptIncludedContent(item: SpotlightIncludedContent): SpotlightPromptIncludedContent {
	const promptItem: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(item)) {
		promptItem[key === "focused" ? "My focus is on this comment" : key] = value;
	}
	return promptItem as SpotlightPromptIncludedContent;
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

export function voteActivityStorageId(botId: string, commentId: string): string {
	return `vote:${botId}:comment:${commentId}`;
}

function humanNotificationBodyWithReason(body: string, reason: LocalizedText | string | undefined): string {
	const trimmed = reason ? localizedTextString(reason).trim() : "";
	return trimmed ? `${body}\n${trimmed}` : body;
}

function spotlightStandardHumanNotifications(
	envelope: ToolResultEnvelope,
	bot: BotDocument,
	input: { userId: string; worldId: string; spotlightId: string; now: string },
): Array<HumanNotificationInput & { spotlightId: string; spotlightLabel: string }> {
	switch (envelope.kind) {
		case "thread_created": {
			const { thread } = envelope;
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
			title: `${localizedTextString(bot.displayName)} created a thread in f/${thread.forumHandle}`,
			body: threadTitle(thread),
			urlPath: threadUrlPath(thread),
			spotlightId: input.spotlightId,
			spotlightLabel: "spotlight",
			now: input.now,
			}];
		}
		case "comment_created": {
			const { comment, thread } = envelope;
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
			title: `${localizedTextString(bot.displayName)} replied in "${threadTitle(thread)}"`,
			body: localizedPreview(comment.body),
			urlPath: commentUrlPath(thread, comment.id),
			spotlightId: input.spotlightId,
			spotlightLabel: "spotlight",
			now: input.now,
			}];
		}
		case "vote_set":
			return spotlightVoteHumanNotifications(envelope.votes, bot, input);
		case "profile_followed":
			return spotlightProfileActionHumanNotifications(envelope.profiles, true, bot, input);
		case "profile_unfollowed":
			return spotlightProfileActionHumanNotifications(envelope.profiles, false, bot, input);
		case "content_read":
		case "opaque":
			return [];
		default:
			return assertNeverToolResultEnvelope(envelope);
	}
}

function spotlightVoteHumanNotifications(
	votes: Extract<ToolResultEnvelope, { kind: "vote_set" }>["votes"],
	bot: BotDocument,
	input: { userId: string; worldId: string; spotlightId: string; now: string },
): Array<HumanNotificationInput & { spotlightId: string; spotlightLabel: string }> {
	return votes.flatMap((vote) => {
		if (vote.value !== 1 && vote.value !== -1) {
			return [];
		}
		const direction = vote.value > 0 ? "upvoted" : "downvoted";
		return [{
			userId: input.userId,
			worldId: input.worldId,
			eventKey: `vote_cast:comment:${vote.commentId}:${bot.id}:${vote.value}:${input.now}`,
			notificationType: "vote_cast",
			actor: bot,
			sourceType: "vote",
			sourceId: `comment:${vote.commentId}:${bot.id}`,
			targetType: "comment",
			targetId: vote.commentId,
			title: `${localizedTextString(bot.displayName)} ${direction} a comment in`,
			body: humanNotificationBodyWithReason(threadTitle(vote.thread), vote.reason),
			urlPath: botActivityUrlPath(bot, voteActivityId(vote.commentId)),
			spotlightId: input.spotlightId,
			spotlightLabel: "spotlight",
			now: input.now,
		}];
	});
}

function spotlightProfileActionHumanNotifications(
	profiles: Extract<ToolResultEnvelope, { kind: "profile_followed" }>["profiles"],
	shouldFollow: boolean,
	bot: BotDocument,
	input: { userId: string; worldId: string; spotlightId: string; now: string },
): Array<HumanNotificationInput & { spotlightId: string; spotlightLabel: string }> {
	return profiles.map((action) => {
		const followedId = action.profile.id;
		const handle = action.profile.handle;
		const profileDisplayName = action.profile.displayName;
		const displayName = profileDisplayName.text || "a profile";
		return {
			userId: input.userId,
			worldId: input.worldId,
			eventKey: shouldFollow ? `bot_followed:${bot.id}:${followedId}` : `bot_unfollowed:${bot.id}:${followedId}:${input.now}`,
			notificationType: shouldFollow ? "bot_followed" : "bot_unfollowed",
			actor: bot,
			sourceType: "follow",
			sourceId: `${bot.id}:${followedId}`,
			targetType: "bot",
			targetId: followedId,
			title: `${localizedTextString(bot.displayName)} ${shouldFollow ? "followed" : "unfollowed"} ${displayName}`,
			body: humanNotificationBodyWithReason(`u/${bot.handle} ${shouldFollow ? "followed" : "unfollowed"} ${handle.startsWith("u/") ? handle : `u/${handle}`}.`, action.reason),
			urlPath: botActivityUrlPath(bot, action.activityId ?? (shouldFollow ? `follow:${followedId}` : undefined)),
			spotlightId: input.spotlightId,
			spotlightLabel: "spotlight",
			now: input.now,
		};
	});
}

function repositoryError(
	code: RepositoryError["code"],
	message: string,
	status: number,
	details?: RepositoryErrorDetails,
): RepositoryError {
	return new RepositoryError(code, message, status, details);
}
