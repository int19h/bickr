import { notificationSourceDeleteStatements } from "@bickr/shared/notification-source-deletes";
import {
	humanNotificationSweepArms,
	pruneExpiredNotifications,
	pruneHumanNotifications,
	selectHumanNotificationsOfArmSql,
	selectNotificationsInSourceRangeAfterCursorSql,
	selectNotificationsInSourceRangeFirstPageSql,
	softDeleteComment,
	sweepOrphanedBotNotifications,
	sweepOrphanedHumanNotifications,
} from "@bickr/shared/social";
import { d1SafeBoundParameters, type D1DatabaseLike } from "@bickr/shared/storage";
import type { ThreadDocument } from "@bickr/shared/model";
import {
	authCookie,
	contextFor,
	createBotForTest,
	createCommentForTest,
	createForumForTest,
	createThreadForTest,
	deleteBot,
	deleteCommentRoute,
	deleteForumRoute,
	deleteThreadRoute,
	deleteWorldRoute,
	describe,
	expect,
	handleForumCoordinatorRequest,
	it,
	jsonRequest,
	kvKeys,
	listPendingNotifications,
	requiredLt,
	seedWorld,
	testEnv,
} from "./helpers/index-harness";

/**
 * Content deletion has to retract the notifications the deleted content
 * generated (issue #200). Nothing else ever does: a bot notification carries its
 * source's full text in its stored payload and is delivered from that snapshot,
 * and a human notification survives as a row whose link resolves to nothing.
 *
 * The retraction is keyed on the deleted object itself. A reparented child's
 * reply notification quotes its deleted former parent in `replyTo`; that residual
 * is deliberate and asserted below, because the notification is about the child,
 * which is alive.
 *
 * These drive the real delete paths — including the governance cascades, which
 * reach them through the forum coordinator — rather than the statement builders,
 * whose bindings are asserted in
 * `packages/shared/src/notification-source-deletes.test.ts`.
 */

const worldHandle = "patch-notes";

function sharedDb(): D1DatabaseLike {
	return testEnv.BICKR_D1 as unknown as D1DatabaseLike;
}

async function insertBotNotification(input: {
	id: string;
	sourceObjectId: string | null;
	botId?: string;
	notificationType?: string;
	document?: boolean;
}): Promise<void> {
	const botId = input.botId ?? "bot_source_cleanup";
	const createdAt = "2026-08-01T00:00:00.000Z";
	if (input.document !== false) {
		await testEnv.BICKR_KV.put(kvKeys.notification(botId, input.id), JSON.stringify({
			id: input.id,
			type: "notification",
			notificationType: input.notificationType ?? "reply",
			botId,
			status: "pending",
			createdAt,
		}));
	}
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO notifications (
			notification_id, world_id, bot_id, type, source_object_id, status, message, message_lang,
			created_at, delivered_at, read_at
		) VALUES (?, 'wld_source_cleanup', ?, ?, ?, 'pending', 'Message', NULL, ?, NULL, NULL)`,
	)
		.bind(input.id, botId, input.notificationType ?? "reply", input.sourceObjectId, createdAt)
		.run();
}

async function insertHumanNotification(input: {
	id: string;
	sourceType?: string | null;
	sourceId?: string | null;
	targetType?: string | null;
	targetId?: string | null;
}): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO human_notifications (
			notification_id, user_id, world_id, event_key, notification_type,
			actor_bot_id, actor_handle, actor_display_name, source_type, source_id,
			target_type, target_id, title, body, url_path, spotlight_id, spotlight_label,
			created_at, read_at, archived_at
		) VALUES (?, 'usr_source_cleanup', 'wld_source_cleanup', ?, 'comment_created', NULL, NULL, NULL, ?, ?,
			?, ?, 'Title', 'Body', '/', NULL, NULL, '2026-08-01T00:00:00.000Z', NULL, NULL)`,
	)
		.bind(
			input.id,
			`event:${input.id}`,
			input.sourceType ?? null,
			input.sourceId ?? null,
			input.targetType ?? null,
			input.targetId ?? null,
		)
		.run();
}

async function insertTombstonedComment(commentId: string, options: { deletedAt?: string | null } = {}): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT OR REPLACE INTO comments_index (
			comment_id, thread_id, world_id, forum_id, author_bot_id, author_handle,
			parent_comment_id, body_preview, search_text, created_at, deleted_at, is_root
		) VALUES (?, 'thr_sweep', 'wld_source_cleanup', 'frm_sweep', 'bot_sweep', 'sweeper',
			NULL, 'Preview', 'Search', '2026-08-01T00:00:00.000Z', ?, 0)`,
	)
		.bind(commentId, options.deletedAt === undefined ? "2026-08-02T00:00:00.000Z" : options.deletedAt)
		.run();
}

async function insertTombstonedThread(threadId: string, options: { deletedAt?: string | null } = {}): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT OR REPLACE INTO threads_index (
			thread_id, world_id, world_handle, forum_id, forum_handle, author_bot_id, author_handle,
			author_display_name, title, body_preview, search_text, created_at, last_activity_at,
			deleted_at, root_comment_id
		) VALUES (?, 'wld_source_cleanup', 'sweep', 'frm_sweep', 'sweep', 'bot_sweep', 'sweeper',
			'Sweeper', 'Title', 'Preview', 'Search', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
			?, NULL)`,
	)
		.bind(threadId, options.deletedAt === undefined ? "2026-08-02T00:00:00.000Z" : options.deletedAt)
		.run();
}

async function botNotificationIds(): Promise<string[]> {
	const result = await testEnv.BICKR_D1
		.prepare(`SELECT notification_id AS id FROM notifications ORDER BY notification_id`)
		.all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id);
}

async function humanNotificationIds(): Promise<string[]> {
	const result = await testEnv.BICKR_D1
		.prepare(`SELECT notification_id AS id FROM human_notifications ORDER BY notification_id`)
		.all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id);
}

async function botNotificationCountFor(sourceObjectId: string): Promise<number> {
	const row = await testEnv.BICKR_D1
		.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE source_object_id = ?`)
		.bind(sourceObjectId)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function humanNotificationCountFor(
	column: "source" | "target",
	type: string,
	id: string,
): Promise<number> {
	const row = await testEnv.BICKR_D1
		.prepare(`SELECT COUNT(*) AS count FROM human_notifications WHERE ${column}_type = ? AND ${column}_id = ?`)
		.bind(type, id)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function commentTombstone(commentId: string): Promise<string | null> {
	const row = await testEnv.BICKR_D1
		.prepare(`SELECT deleted_at AS deletedAt FROM comments_index WHERE comment_id = ?`)
		.bind(commentId)
		.first<{ deletedAt: string | null }>();
	return row?.deletedAt ?? null;
}

/** A world, a forum, and two participants of it: an author and a replier. */
async function scenario(handle: string): Promise<{
	cookie: string;
	forumId: string;
	authorBotId: string;
	replierBotId: string;
}> {
	const cookie = await authCookie();
	await seedWorld(cookie);
	const forum = await createForumForTest(cookie, handle);
	const author = await createBotForTest(cookie, `${handle}-author`);
	const replier = await createBotForTest(cookie, `${handle}-replier`);
	return { cookie, forumId: forum.id, authorBotId: author.id, replierBotId: replier.id };
}

async function voteOnThread(threadId: string, botId: string, value: number): Promise<void> {
	const request = jsonRequest("http://example.com/votes", "POST", {
		threadId,
		value,
		reason: requiredLt("Worth reading."),
	});
	request.headers.set("x-bickr-bot-id", botId);
	const response = await handleForumCoordinatorRequest(request, {
		BICKR_D1: testEnv.BICKR_D1,
		BICKR_KV: testEnv.BICKR_KV,
	});
	expect(response.status).toBe(200);
}

async function deleteComment(forumHandle: string, threadId: string, commentId: string, cookie: string): Promise<void> {
	const response = await deleteCommentRoute(
		contextFor<typeof deleteCommentRoute>(
			new Request(
				`http://example.com/api/worlds/${worldHandle}/forums/${forumHandle}/threads/${threadId}/comments/${commentId}`,
				{ method: "DELETE", headers: { cookie } },
			),
			{ worldHandle, forumHandle, threadId, commentId },
		),
	);
	expect(response.status).toBe(200);
}

async function deleteThread(forumHandle: string, threadId: string, cookie: string): Promise<void> {
	const response = await deleteThreadRoute(
		contextFor<typeof deleteThreadRoute>(
			new Request(
				`http://example.com/api/worlds/${worldHandle}/forums/${forumHandle}/threads/${threadId}`,
				{ method: "DELETE", headers: { cookie } },
			),
			{ worldHandle, forumHandle, threadId },
		),
	);
	expect(response.status).toBe(200);
}

describe("content deletion retracts its notifications", () => {
	it("clears a deleted comment's notifications and leaves a reparented child's alone", async () => {
		const { cookie, forumId, authorBotId, replierBotId } = await scenario("comment-retraction");
		const thread = await createThreadForTest(forumId, authorBotId, "Retraction", "Root body.");
		// A real reply notifies the parent's author, so this row is the fan-out's
		// own, not a fixture: `c/<comment id>` is the shape it stores.
		const parent = await createCommentForTest(thread.id, replierBotId, "Parent comment.");
		const child = await createCommentForTest(thread.id, authorBotId, "Child comment.", parent.id);
		// The other two bot notification types that carry a comment ref.
		await insertBotNotification({ id: "ntf_mention", sourceObjectId: `c/${parent.id}`, notificationType: "mention" });
		await insertBotNotification({ id: "ntf_vote", sourceObjectId: `c/${parent.id}`, notificationType: "vote" });
		// A human vote row reaches its comment through the target alone: its
		// source_id is the composite dedup key, which nothing parses.
		await insertHumanNotification({
			id: "hnt_vote",
			sourceType: "vote",
			sourceId: `comment:${parent.id}:${replierBotId}`,
			targetType: "comment",
			targetId: parent.id,
		});

		expect(await botNotificationCountFor(`c/${parent.id}`)).toBeGreaterThan(2);
		expect(await humanNotificationCountFor("source", "comment", parent.id)).toBeGreaterThan(0);

		await deleteComment("comment-retraction", thread.id, parent.id, cookie);

		expect(await botNotificationCountFor(`c/${parent.id}`)).toBe(0);
		expect(await humanNotificationCountFor("source", "comment", parent.id)).toBe(0);
		expect(await humanNotificationCountFor("target", "comment", parent.id)).toBe(0);
		// The child was reparented, not deleted. Its reply notification quotes the
		// deleted parent in `replyTo`, and that residual is accepted: retracting it
		// would retract notice of live content.
		expect(await botNotificationCountFor(`c/${child.id}`)).toBeGreaterThan(0);
		expect(await humanNotificationCountFor("source", "comment", child.id)).toBeGreaterThan(0);
		// The thread is alive, so its own notifications are untouched.
		expect(await botNotificationCountFor(`t/${thread.id}`) + await humanNotificationCountFor("source", "thread", thread.id))
			.toBeGreaterThan(0);
	});

	it("retracts a thread's notifications and every one of its comments'", async () => {
		const { cookie, forumId, authorBotId, replierBotId } = await scenario("thread-retraction");
		const thread = await createThreadForTest(forumId, authorBotId, "Doomed", "Root body.");
		const comment = await createCommentForTest(thread.id, replierBotId, "Doomed comment.");
		const survivor = await createThreadForTest(forumId, authorBotId, "Survivor", "Untouched body.");
		await insertBotNotification({ id: "ntf_thread", sourceObjectId: `t/${thread.id}`, notificationType: "followed_activity" });
		await insertBotNotification({ id: "ntf_root", sourceObjectId: `c/${thread.rootCommentId}`, notificationType: "vote" });
		await insertBotNotification({ id: "ntf_survivor", sourceObjectId: `t/${survivor.id}`, notificationType: "followed_activity" });

		await deleteThread("thread-retraction", thread.id, cookie);

		expect(await botNotificationCountFor(`t/${thread.id}`)).toBe(0);
		expect(await botNotificationCountFor(`c/${thread.rootCommentId}`)).toBe(0);
		expect(await botNotificationCountFor(`c/${comment.id}`)).toBe(0);
		expect(await humanNotificationCountFor("source", "thread", thread.id)).toBe(0);
		expect(await humanNotificationCountFor("target", "thread", thread.id)).toBe(0);
		expect(await humanNotificationCountFor("source", "comment", comment.id)).toBe(0);
		expect(await botNotificationCountFor(`t/${survivor.id}`)).toBe(1);
	});

	it("retracts a vote-on-thread notification, whose ref is the root comment", async () => {
		const { cookie, forumId, authorBotId, replierBotId } = await scenario("vote-retraction");
		const thread = await createThreadForTest(forumId, authorBotId, "Voted", "Root body.");

		await voteOnThread(thread.id, replierBotId, 1);

		// A thread vote is normalized to the root comment, so its notification is
		// filed under `c/<root comment id>` — which, for a short content id, is the
		// thread id itself.
		expect(await botNotificationCountFor(`c/${thread.rootCommentId}`)).toBe(1);
		expect(await humanNotificationCountFor("target", "comment", thread.rootCommentId)).toBeGreaterThan(0);

		await deleteThread("vote-retraction", thread.id, cookie);

		expect(await botNotificationCountFor(`c/${thread.rootCommentId}`)).toBe(0);
		expect(await humanNotificationCountFor("target", "comment", thread.rootCommentId)).toBe(0);
	});

	it("delegates a root-comment delete to the thread path", async () => {
		const { cookie, forumId, authorBotId, replierBotId } = await scenario("root-retraction");
		const thread = await createThreadForTest(forumId, authorBotId, "Root delete", "Root body.");
		const comment = await createCommentForTest(thread.id, replierBotId, "Under a doomed root.");
		await insertBotNotification({ id: "ntf_thread", sourceObjectId: `t/${thread.id}`, notificationType: "mention" });

		await deleteComment("root-retraction", thread.id, thread.rootCommentId, cookie);

		expect(await botNotificationCountFor(`t/${thread.id}`)).toBe(0);
		expect(await botNotificationCountFor(`c/${comment.id}`)).toBe(0);
	});

	it("clears a comment the index never recorded when its thread is deleted", async () => {
		const { cookie, forumId, authorBotId, replierBotId } = await scenario("document-only");
		const thread = await createThreadForTest(forumId, authorBotId, "Index lag", "Root body.");
		const comment = await createCommentForTest(thread.id, replierBotId, "Newest comment.");
		await insertBotNotification({ id: "ntf_lagging", sourceObjectId: `c/${comment.id}`, notificationType: "mention" });
		// The thread document is authoritative and `comments_index` can lag it, so
		// the thread delete must not depend on the index row existing.
		await testEnv.BICKR_D1.prepare(`DELETE FROM comments_index WHERE comment_id = ?`).bind(comment.id).run();

		await deleteThread("document-only", thread.id, cookie);

		expect(await botNotificationCountFor(`c/${comment.id}`)).toBe(0);
		expect(await humanNotificationCountFor("source", "comment", comment.id)).toBe(0);
	});

	it("clears a comment the document no longer names when the forum deletes its thread", async () => {
		const { cookie, forumId, authorBotId, replierBotId } = await scenario("index-only");
		const thread = await createThreadForTest(forumId, authorBotId, "Missing document", "Root body.");
		const comment = await createCommentForTest(thread.id, replierBotId, "Only in the index.");
		await insertBotNotification({ id: "ntf_index_only", sourceObjectId: `c/${comment.id}`, notificationType: "mention" });
		await insertBotNotification({ id: "ntf_index_thread", sourceObjectId: `t/${thread.id}`, notificationType: "mention" });
		// With the document gone the index is the only remaining record of which
		// comments the dying thread carried.
		await testEnv.BICKR_KV.delete(kvKeys.thread(thread.id));

		const response = await deleteForumRoute(
			contextFor<typeof deleteForumRoute>(
				new Request(`http://example.com/api/worlds/${worldHandle}/forums/index-only`, {
					method: "DELETE",
					headers: { cookie },
				}),
				{ worldHandle, forumHandle: "index-only" },
			),
		);

		expect(response.status).toBe(200);
		expect(await botNotificationCountFor(`c/${comment.id}`)).toBe(0);
		expect(await botNotificationCountFor(`t/${thread.id}`)).toBe(0);
		expect(await humanNotificationCountFor("source", "comment", comment.id)).toBe(0);
		expect(await humanNotificationCountFor("source", "thread", thread.id)).toBe(0);
	});

	it("retracts through the forum-delete cascade", async () => {
		const { cookie, forumId, authorBotId, replierBotId } = await scenario("forum-cascade");
		const survivingForum = await createForumForTest(cookie, "forum-cascade-survivor");
		const thread = await createThreadForTest(forumId, authorBotId, "Doomed forum", "Root body.");
		const comment = await createCommentForTest(thread.id, replierBotId, "Doomed comment.");
		const survivor = await createThreadForTest(survivingForum.id, authorBotId, "Survivor", "Root body.");
		await insertBotNotification({ id: "ntf_survivor", sourceObjectId: `t/${survivor.id}`, notificationType: "mention" });

		// Governance deletes cascade forum -> coordinator forum_threads task ->
		// softDeleteThreadForForum -> softDeleteThread, so they need no wiring of
		// their own; this asserts that chain end to end.
		const response = await deleteForumRoute(
			contextFor<typeof deleteForumRoute>(
				new Request(`http://example.com/api/worlds/${worldHandle}/forums/forum-cascade`, {
					method: "DELETE",
					headers: { cookie },
				}),
				{ worldHandle, forumHandle: "forum-cascade" },
			),
		);

		expect(response.status).toBe(200);
		expect(await botNotificationCountFor(`t/${thread.id}`)).toBe(0);
		expect(await botNotificationCountFor(`c/${comment.id}`)).toBe(0);
		expect(await humanNotificationCountFor("source", "comment", comment.id)).toBe(0);
		expect(await humanNotificationCountFor("source", "thread", thread.id)).toBe(0);
		expect(await botNotificationCountFor(`t/${survivor.id}`)).toBe(1);
	});

	it("retracts through the world-delete cascade", async () => {
		const { cookie, forumId, authorBotId, replierBotId } = await scenario("world-cascade");
		const thread = await createThreadForTest(forumId, authorBotId, "Doomed world", "Root body.");
		const comment = await createCommentForTest(thread.id, replierBotId, "Doomed comment.");
		await insertBotNotification({ id: "ntf_world_thread", sourceObjectId: `t/${thread.id}` });
		await insertBotNotification({ id: "ntf_world_comment", sourceObjectId: `c/${comment.id}` });
		// A world is only deletable once its participants are, and that is not what
		// retracts these: the fixture rows belong to a participant of their own.
		for (const botId of [authorBotId, replierBotId]) {
			const response = await deleteBot(
				contextFor<typeof deleteBot>(
					new Request(`http://example.com/api/me/bots/${botId}`, { method: "DELETE", headers: { cookie } }),
					{ botId },
				),
			);
			expect(response.status).toBe(200);
		}
		expect(await botNotificationCountFor(`t/${thread.id}`)).toBe(1);
		expect(await botNotificationCountFor(`c/${comment.id}`)).toBeGreaterThan(0);

		const response = await deleteWorldRoute(
			contextFor<typeof deleteWorldRoute>(
				new Request(`http://example.com/api/worlds/${worldHandle}`, { method: "DELETE", headers: { cookie } }),
				{ worldHandle },
			),
		);

		expect(response.status).toBe(200);
		expect(await botNotificationCountFor(`t/${thread.id}`)).toBe(0);
		expect(await botNotificationCountFor(`c/${comment.id}`)).toBe(0);
		expect(await humanNotificationCountFor("source", "comment", comment.id)).toBe(0);
	});

	it("leaves the notifications and the tombstone alike when the delete batch fails", async () => {
		const { forumId, authorBotId, replierBotId } = await scenario("batch-atomicity");
		const thread = await createThreadForTest(forumId, authorBotId, "Atomicity", "Root body.");
		const comment = await createCommentForTest(thread.id, replierBotId, "Doomed comment.");
		await insertBotNotification({ id: "ntf_atomic", sourceObjectId: `c/${comment.id}`, notificationType: "mention" });
		const document = await testEnv.BICKR_KV.get(kvKeys.thread(thread.id), { type: "json" }) as ThreadDocument;
		// The comment's own reply notification is real; the fixture is a second row
		// under the same ref, and neither may move.
		const before = await botNotificationCountFor(`c/${comment.id}`);
		expect(before).toBe(2);

		// A statement D1 rejects, appended to whatever batch the delete builds: one
		// batch is one transaction, so either every row it names changes or none
		// does.
		const db = sharedDb();
		const failingDb: D1DatabaseLike = {
			prepare: (query) => db.prepare(query),
			batch: (statements) => db.batch([
				...statements,
				db.prepare(`INSERT INTO notifications (notification_id) VALUES (?)`).bind("ntf_atomic"),
			]),
		};

		await expect(softDeleteComment(testEnv.BICKR_KV, failingDb, document, comment.id)).rejects.toThrow();

		expect(await botNotificationCountFor(`c/${comment.id}`)).toBe(before);
		expect(await commentTombstone(comment.id)).toBeNull();
	});
});

describe("notification source delete statements against D1", () => {
	it("matches a legacy prefixed id in both of its stored shapes", async () => {
		await insertBotNotification({ id: "ntf_formatted", sourceObjectId: "c/cmt_9d0f" });
		await insertBotNotification({ id: "ntf_bare", sourceObjectId: "cmt_9d0f" });
		await insertBotNotification({ id: "ntf_other", sourceObjectId: "c/cmt_other" });
		await insertHumanNotification({ id: "hnt_raw", sourceType: "comment", sourceId: "cmt_9d0f" });
		await insertHumanNotification({ id: "hnt_target", targetType: "comment", targetId: "cmt_9d0f" });
		await insertHumanNotification({ id: "hnt_other", sourceType: "comment", sourceId: "cmt_other" });

		const db = sharedDb();
		await db.batch(notificationSourceDeleteStatements(db, [{ type: "comment", id: "cmt_9d0f" }]));

		expect(await botNotificationIds()).toEqual(["ntf_other"]);
		expect(await humanNotificationIds()).toEqual(["hnt_other"]);
	});

	it("never matches the sibling that shares a short content id", async () => {
		// A thread's root comment id equals its thread id, so `t/x` and `c/x` name
		// different objects and a bare `x` would name both.
		await insertBotNotification({ id: "ntf_thread", sourceObjectId: "t/abc23456" });
		await insertBotNotification({ id: "ntf_comment", sourceObjectId: "c/abc23456" });
		await insertHumanNotification({ id: "hnt_thread", sourceType: "thread", sourceId: "abc23456" });
		await insertHumanNotification({ id: "hnt_comment", sourceType: "comment", sourceId: "abc23456" });

		const db = sharedDb();
		await db.batch(notificationSourceDeleteStatements(db, [{ type: "comment", id: "abc23456" }]));

		expect(await botNotificationIds()).toEqual(["ntf_thread"]);
		expect(await humanNotificationIds()).toEqual(["hnt_thread"]);
	});

	it("chunks a ref set past D1's bound-parameter ceiling and still clears all of it", async () => {
		const refs: { type: "comment"; id: string }[] = [];
		for (let index = 0; index < d1SafeBoundParameters; index += 1) {
			const id = `cmt_bulk_${String(index).padStart(3, "0")}`;
			await insertBotNotification({ id: `ntf_bulk_${String(index).padStart(3, "0")}`, sourceObjectId: `c/${id}` });
			await insertHumanNotification({ id: `hnt_bulk_${String(index).padStart(3, "0")}`, sourceType: "comment", sourceId: id });
			refs.push({ type: "comment", id });
		}
		await insertBotNotification({ id: "ntf_bulk_survivor", sourceObjectId: "c/cmt_bulk_survivor" });

		const db = sharedDb();
		const statements = notificationSourceDeleteStatements(db, refs);
		await db.batch(statements);

		// Legacy refs cost two bot match values each, so the bot arm alone needs
		// more than one statement at this ref count.
		expect(statements.length).toBeGreaterThan(3);
		expect(await botNotificationIds()).toEqual(["ntf_bulk_survivor"]);
		expect(await humanNotificationIds()).toEqual([]);
	});
});

/**
 * The index carries every ordering term but the `notification_id` tie-break, so
 * SQLite sorts inside each block of rows that share a ref — bounded by how many
 * participants one comment can notify, and terminated early by the page's
 * `LIMIT`. What must never appear is the whole-result sort a page without the
 * index would pay.
 */
function expectNoFullSort(details: readonly string[]): void {
	for (const detail of details) {
		if (detail.includes("TEMP B-TREE")) {
			expect(detail).toContain("LAST TERM OF ORDER BY");
		}
	}
}

describe("orphaned notification source sweep", () => {
	it("deletes rows whose source is tombstoned across every stored ref shape", async () => {
		await insertTombstonedComment("dead2345");
		await insertTombstonedComment("cmt_dead");
		await insertTombstonedThread("thr_dead");
		await insertTombstonedThread("live2345", { deletedAt: null });
		await insertBotNotification({ id: "ntf_comment", sourceObjectId: "c/dead2345" });
		await insertBotNotification({ id: "ntf_comment_legacy_formatted", sourceObjectId: "c/cmt_dead" });
		await insertBotNotification({ id: "ntf_comment_legacy_bare", sourceObjectId: "cmt_dead" });
		await insertBotNotification({ id: "ntf_thread_legacy_formatted", sourceObjectId: "t/thr_dead" });
		await insertBotNotification({ id: "ntf_thread_legacy_bare", sourceObjectId: "thr_dead" });
		// A live source, a source with no index row at all, and a follow row whose
		// ref is a raw bot id: none of the three is this sweep's to delete.
		await insertBotNotification({ id: "ntf_live", sourceObjectId: "t/live2345" });
		await insertBotNotification({ id: "ntf_unindexed", sourceObjectId: "c/miss2345" });
		await insertBotNotification({ id: "ntf_follow", sourceObjectId: "bot_follower", notificationType: "follow" });

		const result = await sweepOrphanedBotNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1);

		// The follow row's raw bot id falls outside every range, so the rotation
		// never even examines it: deleted bots are the tombstoned-bot pass's.
		expect(result).toEqual({ scannedRows: 7, deletedRows: 5, budgetExhausted: false });
		expect(await botNotificationIds()).toEqual(["ntf_follow", "ntf_live", "ntf_unindexed"]);
	});

	it("deletes human rows through both column pairs, including a vote's target", async () => {
		await insertTombstonedComment("dead2345");
		await insertTombstonedThread("thr_dead");
		await insertHumanNotification({ id: "hnt_source_comment", sourceType: "comment", sourceId: "dead2345" });
		await insertHumanNotification({ id: "hnt_source_thread", sourceType: "thread", sourceId: "thr_dead" });
		await insertHumanNotification({ id: "hnt_target_thread", targetType: "thread", targetId: "thr_dead" });
		// The composite `source_type = 'vote'` key is deliberately not parsed: the
		// voted comment is reachable through the target arm.
		await insertHumanNotification({
			id: "hnt_vote",
			sourceType: "vote",
			sourceId: "comment:dead2345:bot_voter",
			targetType: "comment",
			targetId: "dead2345",
		});
		await insertTombstonedComment("live2345", { deletedAt: null });
		await insertHumanNotification({ id: "hnt_live", sourceType: "comment", sourceId: "live2345" });
		await insertHumanNotification({ id: "hnt_bot", sourceType: "follow", sourceId: "bot_a", targetType: "bot", targetId: "bot_b" });

		const result = await sweepOrphanedHumanNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1);

		expect(result.deletedRows).toBe(4);
		expect(await humanNotificationIds()).toEqual(["hnt_bot", "hnt_live"]);
	});

	it("leaves KV alone, and the swept row is invisible to delivery at once", async () => {
		await insertTombstonedComment("dead2345");
		await insertBotNotification({ id: "ntf_swept", sourceObjectId: "c/dead2345", botId: "bot_reader" });

		await sweepOrphanedBotNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1);

		// A document whose row is gone is unreachable by every reader and expires
		// on its own TTL, so the sweep pays no KV delete per row.
		expect(await testEnv.BICKR_KV.get(kvKeys.notification("bot_reader", "ntf_swept"))).not.toBeNull();
		expect(await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, "bot_reader", 20)).toEqual([]);
	});

	it("stops on its own row cap and resumes from the persisted cursor", async () => {
		for (let index = 0; index < 4; index += 1) {
			// Short content ids are base32 over `a-z2-7`, so the varying character
			// has to come from that alphabet for the ref to parse at all.
			const commentId = `deadcap${String.fromCharCode(97 + index)}`;
			await insertTombstonedComment(commentId);
			await insertBotNotification({ id: `ntf_capped_${index}`, sourceObjectId: `c/${commentId}` });
		}

		const capped = { selectLimit: 2, maxRowsPerRun: 2 };
		const firstRun = await sweepOrphanedBotNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, capped);

		expect(firstRun).toEqual({ scannedRows: 2, deletedRows: 2, budgetExhausted: true });
		expect(await botNotificationIds()).toEqual(["ntf_capped_2", "ntf_capped_3"]);
		expect(await testEnv.BICKR_KV.get(kvKeys.notificationSourceSweepCursor)).not.toBeNull();

		// Resuming past the deleted rows is what keeps the rotation moving: a run
		// that restarted at the head of the range would re-select nothing and never
		// reach the tail.
		const secondRun = await sweepOrphanedBotNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, capped);

		expect(secondRun.deletedRows).toBe(2);
		expect(await botNotificationIds()).toEqual([]);
	});

	it("clears the cursor when a rotation reaches the end, and is a no-op on the next run", async () => {
		await insertTombstonedComment("dead2345");
		await insertBotNotification({ id: "ntf_once", sourceObjectId: "c/dead2345" });

		const firstRun = await sweepOrphanedBotNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, { selectLimit: 1, maxRowsPerRun: 10 });
		expect(firstRun.deletedRows).toBe(1);
		expect(await testEnv.BICKR_KV.get(kvKeys.notificationSourceSweepCursor)).toBeNull();

		const secondRun = await sweepOrphanedBotNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, { selectLimit: 1, maxRowsPerRun: 10 });
		expect(secondRun).toEqual({ scannedRows: 0, deletedRows: 0, budgetExhausted: false });
	});

	it("pages both notification tables by seeking the index, not by scanning", async () => {
		const planCommentId = (index: number) =>
			`plan23${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
		for (let index = 0; index < 40; index += 1) {
			const suffix = String(index).padStart(2, "0");
			await insertBotNotification({ id: `ntf_plan_${suffix}`, sourceObjectId: `c/${planCommentId(index)}` });
			await insertHumanNotification({ id: `hnt_plan_${suffix}`, sourceType: "comment", sourceId: planCommentId(index) });
		}

		const planDetails = async (sql: string, binds: unknown[]): Promise<string[]> => {
			const plan = await testEnv.BICKR_D1
				.prepare(`EXPLAIN QUERY PLAN ${sql}`)
				.bind(...binds)
				.all<{ detail: string }>();
			return (plan.results ?? []).map((row) => row.detail);
		};

		for (const details of [
			await planDetails(selectNotificationsInSourceRangeFirstPageSql, ["c/", "c0", 10]),
			await planDetails(
				selectNotificationsInSourceRangeAfterCursorSql,
				[`c/${planCommentId(10)}`, "c0", `c/${planCommentId(10)}`, "ntf_plan_10", 10],
			),
		]) {
			// Migration 0053's index is what makes a page cost its own rows; without
			// it every page sorted the whole table.
			expect(details.some((detail) => detail.includes("notifications_source"))).toBe(true);
			expect(details.some((detail) => /\bSCAN notifications\b/u.test(detail))).toBe(false);
			expectNoFullSort(details);
		}

		for (const arm of humanNotificationSweepArms) {
			const index = `human_notifications_${arm.column}`;
			for (const details of [
				await planDetails(selectHumanNotificationsOfArmSql(arm, false), [arm.refType, 10]),
				await planDetails(
					selectHumanNotificationsOfArmSql(arm, true),
					[arm.refType, planCommentId(10), planCommentId(10), "hnt_plan_10", 10],
				),
			]) {
				expect(details.some((detail) => detail.includes(index))).toBe(true);
				expect(details.some((detail) => /\bSCAN human_notifications\b/u.test(detail))).toBe(false);
				expectNoFullSort(details);
			}
		}
	});
});

describe("the retention prunes carry the source sweep", () => {
	// Both prunes run their orphan pass last and on a budget of its own, so an
	// orphan backlog can never displace the expiry the table's retention needs.
	const now = "2026-08-03T00:00:00.000Z";

	it("reports the bot sweep in the notification prune result", async () => {
		await insertTombstonedComment("dead2345");
		await insertBotNotification({ id: "ntf_orphan", sourceObjectId: "c/dead2345" });
		await insertBotNotification({ id: "ntf_live", sourceObjectId: "c/live2345" });

		const result = await pruneExpiredNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, { now });

		expect(result.deletedRows).toBe(0);
		expect(result.orphanedSources).toEqual({ scannedRows: 2, deletedRows: 1, budgetExhausted: false });
		expect(await botNotificationIds()).toEqual(["ntf_live"]);
	});

	it("composes the human sweep with the human expiry prune", async () => {
		await insertTombstonedComment("dead2345");
		await insertHumanNotification({ id: "hnt_orphan", sourceType: "comment", sourceId: "dead2345" });
		await insertHumanNotification({ id: "hnt_live", sourceType: "comment", sourceId: "live2345" });

		const result = await pruneHumanNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, { now });

		expect(result.expired.deletedRows).toBe(0);
		expect(result.orphanedSources.deletedRows).toBe(1);
		expect(await humanNotificationIds()).toEqual(["hnt_live"]);
	});
});
