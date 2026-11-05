import { substringIndexFields } from "../packages/shared/src/indexed-substring-search";
import { internalServiceAuthHeader } from "../packages/shared/src/internal-service";
import {
	botById,
	listUserBots,
	listUserBotsByIds,
	listWorldBots,
	upsertBotIndexProjection,
} from "../packages/shared/src/repository";
import {
	createComment,
	createThread,
	followBot,
	setVote,
	softDeleteComment,
	softDeleteThread,
	unfollowBot,
	upsertThreadIndexProjection,
} from "../packages/shared/src/social";
import type { D1DatabaseLike, D1PreparedStatementLike, D1Result } from "../packages/shared/src/storage";
import forumCoordinatorWorker from "../workers/forum-coordinator/src/index";
import { updateBot } from "./helpers/coordinator-mutations";
import { testServiceBindings } from "./helpers/coordinator-topology";
import { backfillBotLastActiveMigration } from "./helpers/d1-schema";
import {
	authCookie,
	createBotForTest,
	createBotInWorld,
	createForumForTest,
	createWorldForTest,
	jsonRequest,
	requiredLt,
	testEnv,
	testLanguage,
	userIdForHandle,
} from "./helpers/index-harness";
import { describe, expect, it } from "vitest";

const t1 = "2026-10-01T00:00:00.000Z";
const t2 = "2026-10-02T00:00:00.000Z";
const t3 = "2026-10-03T00:00:00.000Z";
const t4 = "2026-10-04T00:00:00.000Z";
const t5 = "2026-10-05T00:00:00.000Z";
const t6 = "2026-10-06T00:00:00.000Z";
const t7 = "2026-10-07T00:00:00.000Z";
const t8 = "2026-10-08T00:00:00.000Z";
const t9 = "2026-10-09T00:00:00.000Z";
const tokens = substringIndexFields("seed activity");

type IndexRow = {
	bot_id: string;
	home_world_id: string;
	home_world_handle: string;
	handle: string;
	display_name: string;
	owner_user_id: string;
	short_bio: string;
	created_at: string;
	updated_at: string;
	lifecycle_state: string;
};

describe("bots_index.last_active_at", () => {
	it("raises through the writers and never moves the stored time backward", async () => {
		const cookie = await authCookie();
		await seed();
		const forum = await createForumForTest(cookie, "activity-forum");
		const author = await createBotForTest(cookie, "activity-author");
		const other = await createBotForTest(cookie, "activity-other");
		const kv = testEnv.BICKR_KV;
		const db = testEnv.BICKR_D1;

		const thread = await createThread(kv, db, {
			forumId: forum.id,
			authorBotId: author.id,
			title: requiredLt("First activity"),
			body: requiredLt("A thread starts the clock."),
		}, t2);
		expect(await lastActive(author.id)).toBe(t2);

		const older = await createComment(kv, db, {
			threadId: thread.id,
			authorBotId: author.id,
			body: requiredLt("An older reply."),
		}, t1);
		expect(await lastActive(author.id)).toBe(t2);

		const newer = await createComment(kv, db, {
			threadId: thread.id,
			authorBotId: author.id,
			body: requiredLt("A newer reply."),
		}, t3);
		expect(await lastActive(author.id)).toBe(t3);
		await softDeleteComment(kv, db, newer.thread, newer.comment.id, t4);
		expect(await lastActive(author.id)).toBe(t3);

		await setVote(kv, db, { targetType: "comment", targetId: older.comment.id, botId: author.id, value: 1 }, t2);
		expect(await lastActive(author.id)).toBe(t3);
		await setVote(kv, db, { targetType: "comment", targetId: older.comment.id, botId: author.id, value: -1 }, t3);
		expect(await lastActive(author.id)).toBe(t3);
		await setVote(kv, db, { targetType: "comment", targetId: older.comment.id, botId: author.id, value: 1 }, t4);
		expect(await lastActive(author.id)).toBe(t4);
		await setVote(kv, db, { targetType: "comment", targetId: older.comment.id, botId: author.id, value: 0 }, t5);
		expect(await lastActive(author.id)).toBe(t4);

		await followBot(kv, db, author.id, other.id, t5);
		expect(await lastActive(author.id)).toBe(t5);
		await unfollowBot(kv, db, author.id, other.id, t6);
		expect(await lastActive(author.id)).toBe(t5);

		const tombstoneId = "thr_deleted_activity";
		const tombstoneRoot = "cmt_deleted_activity";
		const tombstone = {
			...thread,
			id: tombstoneId,
			rootCommentId: tombstoneRoot,
			createdAt: t7,
			deletedAt: t7,
			title: requiredLt("Deleted until restored"),
			comments: thread.comments.filter((comment) => comment.id === thread.rootCommentId).map((comment) => ({
				...comment,
				id: tombstoneRoot,
				threadId: tombstoneId,
				createdAt: t7,
				updatedAt: t7,
			})),
		};
		await upsertThreadIndexProjection(db, tombstone);
		expect(await lastActive(author.id)).toBe(t5);
		const restored = { ...tombstone, deletedAt: undefined };
		await upsertThreadIndexProjection(db, restored);
		expect(await lastActive(author.id)).toBe(t7);

		const repaired = {
			...restored,
			comments: restored.comments.map((comment) => comment.id === tombstoneRoot
				? { ...comment, authorBotId: other.id, authorHandle: other.handle }
				: comment),
		};
		await upsertThreadIndexProjection(db, repaired);
		expect(await lastActive(other.id)).toBe(t7);
		expect(await lastActive(author.id)).toBe(t7);
		await upsertThreadIndexProjection(db, { ...repaired, title: requiredLt("Ordinary title edit") });
		expect(await lastActive(author.id)).toBe(t7);
		expect(await lastActive(other.id)).toBe(t7);
		await softDeleteThread(kv, db, { ...repaired, title: requiredLt("Ordinary title edit") }, t8);
		expect(await lastActive(author.id)).toBe(t7);
		expect(await lastActive(other.id)).toBe(t7);

		// setVote on a thread upserts that thread's root comment. A deleted index row
		// stays invisible to a comment vote, so the restore goes through the thread vote.
		// The vote time is older than the stored clock. The comment row's created_at is
		// what the restore raises, and the projection upsert does not rewrite it.
		await testEnv.BICKR_D1.prepare(
			`UPDATE comments_index SET created_at = ?, deleted_at = ? WHERE comment_id = ?`,
		).bind(t8, t8, thread.rootCommentId).run();
		expect(await lastActive(author.id)).toBe(t7);
		await setVote(kv, db, { targetType: "thread", targetId: thread.id, botId: author.id, value: 1 }, t1);
		expect(await lastActive(author.id)).toBe(t8);
	});

	it("raises a thread created through the staged coordinator plan", async () => {
		const cookie = await authCookie();
		await seed();
		const forum = await createForumForTest(cookie, "staged-forum");
		const author = await createBotForTest(cookie, "staged-author");
		const secret = "test-internal-service-secret";
		const bindings = testServiceBindings({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			INTERNAL_SERVICE_SECRET: secret,
		});
		const request = jsonRequest(`https://internal.bickr/forums/${forum.id}/threads`, "POST", {
			title: requiredLt("Staged activity"),
			body: requiredLt("The replay writes the index."),
		});
		request.headers.set("x-bickr-bot-id", author.id);
		request.headers.set(internalServiceAuthHeader, secret);
		const response = await forumCoordinatorWorker.fetch(request as never, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			INTERNAL_SERVICE_SECRET: secret,
			FORUM_COORDINATOR: bindings.FORUM_COORDINATOR,
		} as never);
		expect(response.status, await response.clone().text()).toBe(201);
		const created = await testEnv.BICKR_D1.prepare(
			`SELECT created_at AS createdAt FROM threads_index WHERE author_bot_id = ? AND deleted_at IS NULL`,
		).bind(author.id).first<{ createdAt: string }>();
		expect(await lastActive(author.id)).toBe(created?.createdAt);
	});

	it("seeds a replaced bots_index row from each surviving activity source", async () => {
		const cookie = await authCookie();
		await seed();
		const threadBot = await createBotForTest(cookie, "seed-thread");
		const commentBot = await createBotForTest(cookie, "seed-comment");
		const voteBot = await createBotForTest(cookie, "seed-vote");
		const followBotRow = await createBotForTest(cookie, "seed-follow");
		const quietBot = await createBotForTest(cookie, "seed-quiet");
		const newerBot = await createBotForTest(cookie, "seed-newer");
		const threadRow = await indexRow(threadBot.id);
		const commentRow = await indexRow(commentBot.id);
		const voteRow = await indexRow(voteBot.id);
		const followRow = await indexRow(followBotRow.id);
		const quietRow = await indexRow(quietBot.id);
		const newerRow = await indexRow(newerBot.id);

		await insertThread(threadRow, "thr_seed_thread", t2);
		await insertComment(commentRow, "cmt_seed_comment", t3);
		await insertVote(voteRow, "vote_seed", t4);
		await insertFollow(followRow, t5);
		await insertThread(quietRow, "thr_seed_deleted", t9, t9);
		await insertThread(newerRow, "thr_seed_newer", t2);

		await reinsert(threadRow);
		await reinsert(commentRow);
		await reinsert(voteRow);
		await reinsert(followRow);
		await reinsert(quietRow);
		await reinsert(newerRow, t9);

		expect(await lastActive(threadBot.id)).toBe(t2);
		expect(await lastActive(commentBot.id)).toBe(t3);
		expect(await lastActive(voteBot.id)).toBe(t4);
		expect(await lastActive(followBotRow.id)).toBe(t5);
		expect(await lastActive(quietBot.id)).toBeNull();
		expect(await lastActive(newerBot.id)).toBe(t9);

		const triggerSql = await testEnv.BICKR_D1.prepare(
			`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'bots_index_last_active_seed'`,
		).first<{ sql: string }>();
		expect(triggerSql?.sql).toContain("INDEXED BY threads_index_author_activity");
		expect(triggerSql?.sql).toContain("INDEXED BY comments_index_author_activity");
		expect(triggerSql?.sql).toContain("INDEXED BY votes_bot_activity");
		expect(triggerSql?.sql).toContain("INDEXED BY follows_follower_activity");
	});

	it("keeps the column across projection writes and ignores activity-only updates elsewhere", async () => {
		const cookie = await authCookie();
		await seed();
		const forum = await createForumForTest(cookie, "projection-forum");
		const bot = await createBotForTest(cookie, "projection-author");
		const kv = testEnv.BICKR_KV;
		const db = testEnv.BICKR_D1;
		await createThread(kv, db, {
			forumId: forum.id,
			authorBotId: bot.id,
			title: requiredLt("Projection clock"),
			body: requiredLt("The projection does not own this time."),
		}, t4);
		const document = await botById(kv, db, bot.id);
		await upsertBotIndexProjection(kv, db, document);
		expect(await lastActive(bot.id)).toBe(t4);
		await testEnv.BICKR_D1.prepare(`DELETE FROM bots_index WHERE bot_id = ?`).bind(bot.id).run();
		await upsertBotIndexProjection(kv, db, document);
		expect(await lastActive(bot.id)).toBe(t4);
		const ownerId = document.ownerUserId;
		// The profile route parses short bio as text and reads language beside it.
		await updateBot(kv, db, bot.id, ownerId, { language: testLanguage, shortBio: "Kept activity." } as unknown as Parameters<typeof updateBot>[4]);
		expect(await lastActive(bot.id)).toBe(t4);

		const sequence = await testEnv.BICKR_D1.prepare(
			`SELECT membership_after_sequence AS seq FROM bots_index WHERE bot_id = ?`,
		).bind(bot.id).first<{ seq: number }>();
		await testEnv.BICKR_D1.prepare(
			`UPDATE bots_index SET avatar_url = 'https://cdn.example/avatars/kept.png' WHERE bot_id = ?`,
		).bind(bot.id).run();
		await testEnv.BICKR_D1.prepare(
			`UPDATE avatar_janitor_control SET phase = 'mark', epoch = 'epoch-kept' WHERE id = 1`,
		).run();
		const marks = await markCount();
		await createThread(kv, db, {
			forumId: forum.id,
			authorBotId: bot.id,
			title: requiredLt("Activity only"),
			body: requiredLt("This write touches only the activity column."),
		}, t6);
		expect(await markCount()).toBe(marks);
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT membership_after_sequence AS seq FROM bots_index WHERE bot_id = ?`,
		).bind(bot.id).first<{ seq: number }>()).toEqual(sequence);
		expect(await lastActive(bot.id)).toBe(t6);
	});

	it("backfills every lifecycle from the migration statement and does not lower a newer value", async () => {
		const cookie = await authCookie();
		await seed();
		const active = await createBotForTest(cookie, "backfill-active");
		const pending = await createBotForTest(cookie, "backfill-pending");
		const deleting = await createBotForTest(cookie, "backfill-deleting");
		const quiet = await createBotForTest(cookie, "backfill-quiet");
		const raised = await createBotForTest(cookie, "backfill-raised");
		const activeRow = await indexRow(active.id);
		const pendingRow = await indexRow(pending.id);
		const deletingRow = await indexRow(deleting.id);
		const quietRow = await indexRow(quiet.id);
		const raisedRow = await indexRow(raised.id);
		await insertThread(raisedRow, "thr_backfill_raised", t9);

		for (const name of [
			"bots_last_active_thread_insert",
			"bots_last_active_thread_update",
			"bots_last_active_comment_insert",
			"bots_last_active_comment_update",
			"bots_last_active_vote_insert",
			"bots_last_active_vote_update",
			"bots_last_active_follow_insert",
		]) {
			await testEnv.BICKR_D1.prepare(`DROP TRIGGER ${name}`).run();
		}
		await insertThread(activeRow, "thr_backfill_live", t2);
		await insertThread(activeRow, "thr_backfill_deleted", t9, t9);
		await insertComment(activeRow, "cmt_backfill_live", t1);
		await insertComment(activeRow, "cmt_backfill_deleted", t8, t8);
		await insertComment(activeRow, "cmt_backfill_root", t4, null, 1);
		await insertVote(activeRow, "vote_backfill_active", t3);
		await insertFollow(activeRow, t6);
		await insertVote(pendingRow, "vote_backfill_pending", t3);
		await insertFollow(deletingRow, t4);
		await insertThread(quietRow, "thr_backfill_quiet", t9, t9);
		await insertComment(raisedRow, "cmt_backfill_older", t1);
		await insertThread({ ...activeRow, bot_id: "bot_orphan", handle: "orphan" }, "thr_backfill_orphan", t9);

		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare(
				`UPDATE entity_lifecycle_identity_claims
				 SET claim_state = 'pending', operation_id = (SELECT operation_id FROM entity_lifecycle_operations WHERE entity_id = ? LIMIT 1)
				 WHERE entity_kind = 'bot' AND entity_id = ?`,
			).bind(pending.id, pending.id),
			testEnv.BICKR_D1.prepare(`UPDATE bots_index SET lifecycle_state = 'pending' WHERE bot_id = ?`).bind(pending.id),
		]);
		await testEnv.BICKR_D1.prepare(`UPDATE bots_index SET lifecycle_state = 'deleting' WHERE bot_id = ?`).bind(deleting.id).run();

		await backfillBotLastActiveMigration(testEnv.BICKR_D1);
		const filled = {
			active: await lastActive(active.id),
			pending: await lastActive(pending.id),
			deleting: await lastActive(deleting.id),
			quiet: await lastActive(quiet.id),
			raised: await lastActive(raised.id),
		};
		await backfillBotLastActiveMigration(testEnv.BICKR_D1);
		expect(filled).toEqual({ active: t6, pending: t3, deleting: t4, quiet: null, raised: t9 });
		expect({
			active: await lastActive(active.id),
			pending: await lastActive(pending.id),
			deleting: await lastActive(deleting.id),
			quiet: await lastActive(quiet.id),
			raised: await lastActive(raised.id),
		}).toEqual(filled);
	});

	it("reads the column from each bot list and keeps ordering", async () => {
		const cookie = await authCookie();
		await seed();
		const userId = await userIdForHandle("octocat");
		const forum = await createForumForTest(cookie, "list-forum");
		const quiet = await createBotForTest(cookie, "list-quiet");
		const active = await createBotForTest(cookie, "list-active");
		await createThread(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			forumId: forum.id,
			authorBotId: active.id,
			title: requiredLt("Listed activity"),
			body: requiredLt("The list reads the stored time."),
		}, t4);
		const kv = testEnv.BICKR_KV;
		const recorded: string[] = [];
		const db = recordingDb(recorded);
		const unpaged = await listUserBots(kv, db, userId);
		const paged = await listUserBots(kv, db, userId, { limit: 1 });
		const byIds = await listUserBotsByIds(kv, db, userId, [quiet.id, active.id]);
		const world = await listWorldBots(kv, db, "patch-notes");
		const worldPage = await listWorldBots(kv, db, "patch-notes", { limit: 1 });

		expect(unpaged.find((bot) => bot.id === quiet.id)?.lastActiveAt).toBe(quiet.createdAt);
		expect(unpaged.find((bot) => bot.id === active.id)?.lastActiveAt).toBe(t4);
		expect(byIds.find((bot) => bot.id === quiet.id)?.lastActiveAt).toBe(quiet.createdAt);
		expect(byIds.find((bot) => bot.id === active.id)?.lastActiveAt).toBe(t4);
		expect(world.find((bot) => bot.id === active.id)?.lastActiveAt).toBe(t4);
		expect(paged.hasMore).toBe(true);
		expect(paged.nextCursor).toBeTruthy();
		const second = await listUserBots(kv, testEnv.BICKR_D1, userId, { limit: 1, cursor: paged.nextCursor });
		expect([paged.bots[0]?.id, second.bots[0]?.id].sort()).toEqual([quiet.id, active.id].sort());
		expect(second.hasMore).toBe(false);
		expect(worldPage.hasMore).toBe(true);
		const worldSecond = await listWorldBots(kv, testEnv.BICKR_D1, "patch-notes", { limit: 1, cursor: worldPage.nextCursor });
		expect([worldPage.bots[0]?.id, worldSecond.bots[0]?.id].sort()).toEqual([quiet.id, active.id].sort());

		const listSql = recorded.filter((sql) => sql.includes("last_active_at"));
		expect(listSql).toHaveLength(5);
		expect(listSql.every((sql) => !sql.includes("UNION") && !sql.includes("threads_index") && !sql.includes("comments_index"))).toBe(true);
		for (const sql of listSql) {
			const binds = sql.includes("home_world_id")
				? [await worldId("patch-notes")]
				: sql.includes("IN (")
					? [userId, quiet.id, active.id]
					: [userId];
			if (sql.includes("LIMIT")) continue;
			const plan = await testEnv.BICKR_D1.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
			const details = (plan.results ?? []).map((row) => row.detail).join("\n");
			expect(details).toMatch(/bots_index/);
			expect(details).toMatch(/bot_runtime_index/);
			expect(details).not.toMatch(/threads_index|comments_index|\bvotes\b|\bfollows\b/);
		}

		await createWorldForTest(cookie, "active-clock", "Active Clock");
		const alpha = await createBotInWorld(cookie, "active-clock", { handle: "clock-alpha" });
		await createBotInWorld(cookie, "active-clock", { handle: "clock-beta" });
		const clockWorld = await worldId("active-clock");
		const comment = testEnv.BICKR_D1.prepare(`INSERT INTO comments_index
			(comment_id, thread_id, world_id, forum_id, author_bot_id, author_handle, body_preview, search_text, search_short_tokens, created_at)
			VALUES (?, 'thr_clock', ?, 'frm_clock', ?, ?, 'Body', ?, ?, ?)`);
		for (let index = 0; index < 200; index += 1) {
			await comment.bind(`cmt_clock_${index}`, clockWorld, alpha.id, alpha.handle, tokens.searchText, tokens.shortTokens, t8).run();
		}
		let rowsRead: number | undefined;
		const measured = recordingDb([], (sql, result) => {
			if (sql.includes("last_active_at")) rowsRead = Number(result.meta?.rows_read);
		});
		const clock = await listWorldBots(kv, measured, "active-clock");
		expect(clock.find((bot) => bot.id === alpha.id)?.lastActiveAt).toBe(t8);
		expect(typeof rowsRead).toBe("number");
		// Workerd reported 4 and 5 for two bots plus the runtime join. The 200 comments stay unread.
		expect(rowsRead).toBeLessThanOrEqual(8);
	});
});

async function seed(): Promise<void> {
	const cookie = await authCookie();
	await (await import("./helpers/index-harness")).seedWorld(cookie);
}

async function lastActive(botId: string): Promise<string | null> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT last_active_at AS lastActiveAt FROM bots_index WHERE bot_id = ?`,
	).bind(botId).first<{ lastActiveAt: string | null }>();
	return row?.lastActiveAt ?? null;
}

async function indexRow(botId: string): Promise<IndexRow> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT bot_id, home_world_id, home_world_handle, handle, display_name, owner_user_id, short_bio, created_at, updated_at, lifecycle_state
		 FROM bots_index WHERE bot_id = ?`,
	).bind(botId).first<IndexRow>();
	if (!row) throw new Error(`Missing bots_index row ${botId}.`);
	return row;
}

async function reinsert(row: IndexRow, lastActiveAt?: string): Promise<void> {
	await testEnv.BICKR_D1.prepare(`DELETE FROM bots_index WHERE bot_id = ?`).bind(row.bot_id).run();
	if (lastActiveAt === undefined) {
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO bots_index (bot_id, home_world_id, home_world_handle, handle, display_name, owner_user_id, short_bio, created_at, updated_at, lifecycle_state)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(row.bot_id, row.home_world_id, row.home_world_handle, row.handle, row.display_name, row.owner_user_id, row.short_bio, row.created_at, row.updated_at, row.lifecycle_state).run();
		return;
	}
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO bots_index (bot_id, home_world_id, home_world_handle, handle, display_name, owner_user_id, short_bio, created_at, updated_at, lifecycle_state, last_active_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(row.bot_id, row.home_world_id, row.home_world_handle, row.handle, row.display_name, row.owner_user_id, row.short_bio, row.created_at, row.updated_at, row.lifecycle_state, lastActiveAt).run();
}

async function insertThread(row: IndexRow, id: string, createdAt: string, deletedAt: string | null = null): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO threads_index (thread_id, root_comment_id, world_id, world_handle, forum_id, forum_handle, author_bot_id, author_handle,
		 author_display_name, title, body_preview, search_text, search_short_tokens, created_at, last_activity_at, deleted_at)
		 VALUES (?, ?, ?, ?, 'forum', 'forum', ?, ?, 'Author', 'Title', 'Body', ?, ?, ?, ?, ?)`,
	).bind(id, `${id}-root`, row.home_world_id, row.home_world_handle, row.bot_id, row.handle, tokens.searchText, tokens.shortTokens, createdAt, createdAt, deletedAt).run();
}

async function insertComment(row: IndexRow, id: string, createdAt: string, deletedAt: string | null = null, isRoot = 0): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO comments_index (comment_id, thread_id, world_id, forum_id, author_bot_id, author_handle, body_preview, search_text, search_short_tokens, created_at, deleted_at, is_root)
		 VALUES (?, 'thr_seed_parent', ?, 'forum', ?, ?, 'Body', ?, ?, ?, ?, ?)`,
	).bind(id, row.home_world_id, row.bot_id, row.handle, tokens.searchText, tokens.shortTokens, createdAt, deletedAt, isRoot).run();
}

async function insertVote(row: IndexRow, id: string, updatedAt: string): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO votes (world_id, target_type, target_id, bot_id, value, created_at, updated_at)
		 VALUES (?, 'comment', ?, ?, 1, ?, ?)`,
	).bind(row.home_world_id, id, row.bot_id, updatedAt, updatedAt).run();
}

async function insertFollow(row: IndexRow, createdAt: string): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO follows (world_id, follower_bot_id, followed_bot_id, created_at)
		 VALUES (?, ?, 'bot_follow_target', ?)`,
	).bind(row.home_world_id, row.bot_id, createdAt).run();
}

async function markCount(): Promise<number> {
	const row = await testEnv.BICKR_D1.prepare(`SELECT COUNT(*) AS count FROM avatar_janitor_marks`).first<{ count: number }>();
	return row?.count ?? 0;
}

async function worldId(handle: string): Promise<string> {
	const row = await testEnv.BICKR_D1.prepare(`SELECT world_id AS id FROM worlds_index WHERE handle = ?`).bind(handle).first<{ id: string }>();
	if (!row) throw new Error(`Missing world ${handle}.`);
	return row.id;
}

function recordingDb(recorded: string[], onAll?: (sql: string, result: D1Result) => void): D1DatabaseLike {
	const native = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
	const real = testEnv.BICKR_D1 as unknown as D1DatabaseLike;
	function track(statement: D1PreparedStatementLike, sql: string): D1PreparedStatementLike {
		const tracked: D1PreparedStatementLike = {
			bind: (...args) => track(statement.bind(...args), sql),
			first: <T>() => statement.first<T>(),
			run: () => statement.run(),
			all: async <T>() => {
				recorded.push(sql);
				const result = await statement.all<T>();
				onAll?.(sql, result);
				return result;
			},
		};
		native.set(tracked, statement);
		return tracked;
	}
	return {
		prepare: (sql) => track(real.prepare(sql), sql),
		batch: (statements) => real.batch(statements.map((statement) => native.get(statement) ?? statement)),
	};
}
