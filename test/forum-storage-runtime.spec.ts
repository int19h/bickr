import { substringIndexFields } from "../packages/shared/src/indexed-substring-search";
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { dropForumSearchTokenGuards, installForumSearchTokenGuards, resetD1Schema } from "./helpers/d1-schema";
import { refreshThreadHotScores, searchForumThreads, searchThreads } from "../packages/shared/src/social";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../packages/shared/src/storage";

const db = () => (env as unknown as { BICKR_D1: D1Database }).BICKR_D1;

it("maintains substring indexes and hot expiry through real D1 writes", async () => {
	const database = db();
	await resetD1Schema(database);
	const threadText = "prefix needle 😀 xy";
	const threadTokens = substringIndexFields(threadText);
	await database.prepare(`INSERT INTO threads_index(thread_id, root_comment_id, world_id, world_handle,
		forum_id, forum_handle, author_bot_id, author_handle, author_display_name, title, body_preview,
		search_text, search_short_tokens, created_at, last_activity_at)
		VALUES('thread', 'root', 'world', 'world', 'forum', 'forum', 'bot', 'bot', 'Bot', 'Title', 'Body',
		?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).bind(threadTokens.searchText, threadTokens.shortTokens).run();
	const recorded: string[] = [];
	const recording = recordingDb(database, recorded);
	for (const query of ["needle", "xy", "😀"]) {
		expect(await searchForumThreads(recording, "forum", query)).toHaveLength(1);
		expect(await searchThreads(recording, "world", query)).toHaveLength(1);
	}
	expect(recorded.some((sql) => /search_short_tokens IS NULL/i.test(sql))).toBe(false);
	const replyText = "reply needle 😀 xy";
	const replyTokens = substringIndexFields(replyText);
	await database.prepare(`INSERT INTO comments_index(comment_id, thread_id, world_id, forum_id, author_bot_id,
		author_handle, body_preview, search_text, search_short_tokens, created_at, is_root)
		VALUES('reply', 'thread', 'world', 'forum', 'bot', 'bot', 'Reply', ?, ?, '2026-10-01T00:00:00.000Z', 0)`)
		.bind(replyTokens.searchText, replyTokens.shortTokens).run();
	for (const query of ["needle", "xy", "😀"]) expect(await searchForumThreads(database, "forum", query)).toHaveLength(2);
	expect(await refreshThreadHotScores(database, "2026-10-02T00:00:00.000Z")).toBe(1);
	expect(await database.prepare("SELECT recent_comment_count AS count FROM threads_index").first("count")).toBe(1);
	expect(await refreshThreadHotScores(database, "2026-10-08T00:00:00.000Z")).toBe(1);
	expect(await database.prepare("SELECT recent_comment_count AS count FROM threads_index").first("count")).toBe(0);
	await database.prepare("UPDATE comments_index SET deleted_at = '2026-10-08T00:00:00.000Z'").run();
	await database.prepare("DELETE FROM threads_index WHERE thread_id = 'thread'").run();
	for (const query of ["needle", "xy", "😀"]) expect(await searchForumThreads(database, "forum", query)).toHaveLength(0);
	await expect(database.prepare(`INSERT INTO threads_index(thread_id, root_comment_id, world_id, world_handle,
		forum_id, forum_handle, author_bot_id, author_handle, author_display_name, title, body_preview,
		search_text, created_at, last_activity_at)
		VALUES('missing-tokens', 'missing-root', 'world', 'world', 'forum', 'forum', 'bot', 'bot', 'Bot', 'Title', 'Body',
		'text', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).run()).rejects.toThrow();
});

it("installs the search token guards from the migration and keeps historical NULL rows", async () => {
	const database = db();
	await resetD1Schema(database);
	await dropForumSearchTokenGuards(database);
	const threadTokens = substringIndexFields("restored needle");
	const commentTokens = substringIndexFields("reply needle");
	await database.prepare(`INSERT INTO threads_index(thread_id, root_comment_id, world_id, world_handle,
		forum_id, forum_handle, author_bot_id, author_handle, author_display_name, title, body_preview,
		search_text, created_at, last_activity_at, deleted_at)
		VALUES('live-parent', 'live-parent-root', 'world', 'world', 'forum', 'forum', 'bot', 'bot', 'Bot', 'Parent', 'Parent',
		?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL)`).bind(substringIndexFields("parent").searchText).run();
	await database.prepare(`UPDATE threads_index SET search_short_tokens = ? WHERE thread_id = 'live-parent'`)
		.bind(substringIndexFields("parent").shortTokens).run();
	await database.prepare(`INSERT INTO threads_index(thread_id, root_comment_id, world_id, world_handle,
		forum_id, forum_handle, author_bot_id, author_handle, author_display_name, title, body_preview,
		search_text, created_at, last_activity_at, deleted_at)
		VALUES('deleted-thread', 'deleted-root', 'world', 'world', 'forum', 'forum', 'bot', 'bot', 'Bot', 'Old', 'Old',
		?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`).bind(threadTokens.searchText).run();
	await database.prepare(`INSERT INTO threads_index(thread_id, root_comment_id, world_id, world_handle,
		forum_id, forum_handle, author_bot_id, author_handle, author_display_name, title, body_preview,
		search_text, created_at, last_activity_at, deleted_at)
		VALUES('deleted-spare', 'deleted-spare-root', 'world', 'world', 'forum', 'forum', 'bot', 'bot', 'Bot', 'Spare', 'Spare',
		'spare', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`).run();
	await database.prepare(`INSERT INTO comments_index(comment_id, thread_id, world_id, forum_id, author_bot_id,
		author_handle, body_preview, search_text, created_at, is_root)
		VALUES('root-comment', 'live-parent', 'world', 'forum', 'bot', 'bot', 'Root', ?, '2026-10-01T00:00:00.000Z', 1)`)
		.bind(commentTokens.searchText).run();
	await database.prepare(`INSERT INTO comments_index(comment_id, thread_id, world_id, forum_id, author_bot_id,
		author_handle, body_preview, search_text, created_at, is_root)
		VALUES('root-spare', 'live-parent', 'world', 'forum', 'bot', 'bot', 'Spare', 'spare', '2026-10-01T00:00:00.000Z', 1)`).run();
	await installForumSearchTokenGuards(database);

	const census = await database.prepare(`SELECT
		(SELECT COUNT(*) FROM threads_index INDEXED BY thread_search_pending
		   WHERE search_short_tokens IS NULL AND deleted_at IS NULL) AS threads,
		(SELECT COUNT(*) FROM comments_index INDEXED BY comment_search_pending
		   WHERE search_short_tokens IS NULL AND deleted_at IS NULL AND is_root = 0) AS comments`)
		.first<{ threads: number; comments: number }>();
	expect(census).toEqual({ threads: 0, comments: 0 });

	await expect(database.prepare(`UPDATE threads_index SET deleted_at = NULL WHERE thread_id = 'deleted-thread'`).run()).rejects.toThrow();
	await expect(database.prepare(`UPDATE comments_index SET is_root = 0 WHERE comment_id = 'root-comment'`).run()).rejects.toThrow();
	await database.prepare(`UPDATE threads_index SET deleted_at = NULL, search_short_tokens = ? WHERE thread_id = 'deleted-thread'`)
		.bind(threadTokens.shortTokens).run();
	await database.prepare(`UPDATE comments_index SET is_root = 0, search_short_tokens = ? WHERE comment_id = 'root-comment'`)
		.bind(commentTokens.shortTokens).run();
	expect((await searchForumThreads(database, "forum", "restored")).map((row) => row.commentId)).toContain("deleted-root");
	expect((await searchForumThreads(database, "forum", "reply")).map((row) => row.commentId)).toContain("root-comment");

	await database.prepare(`UPDATE threads_index SET deleted_at = '2026-10-03T00:00:00.000Z' WHERE thread_id = 'deleted-spare'`).run();
	await database.prepare(`DELETE FROM threads_index WHERE thread_id = 'deleted-spare'`).run();
	await database.prepare(`UPDATE comments_index SET deleted_at = '2026-10-03T00:00:00.000Z' WHERE comment_id = 'root-spare'`).run();
	await database.prepare(`DELETE FROM comments_index WHERE comment_id = 'root-spare'`).run();
	await expect(database.prepare(`INSERT INTO comments_index(comment_id, thread_id, world_id, forum_id, author_bot_id,
		author_handle, body_preview, search_text, created_at, is_root)
		VALUES('null-insert', 'live-parent', 'world', 'forum', 'bot', 'bot', 'Body', 'body', '2026-10-04T00:00:00.000Z', 0)`).run()).rejects.toThrow();
	await expect(database.prepare(`UPDATE threads_index SET search_short_tokens = NULL WHERE thread_id = 'live-parent'`).run()).rejects.toThrow();
});

function recordingDb(database: D1Database, recorded: string[]): D1DatabaseLike {
	const native = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
	const real = database as unknown as D1DatabaseLike;
	function track(statement: D1PreparedStatementLike, sql: string): D1PreparedStatementLike {
		const tracked: D1PreparedStatementLike = {
			bind: (...args) => track(statement.bind(...args), sql),
			first: <T>() => statement.first<T>(),
			run: () => statement.run(),
			all: async <T>() => {
				recorded.push(sql);
				return statement.all<T>();
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
