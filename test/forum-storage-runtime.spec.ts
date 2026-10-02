import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { resetD1Schema } from "./helpers/d1-schema";
import { refreshThreadHotScores, searchForumThreads, searchThreads } from "../packages/shared/src/social";

it("maintains substring indexes and hot expiry through real D1 writes", async () => {
	const db = (env as unknown as { BICKR_D1: D1Database }).BICKR_D1;
	await resetD1Schema(db);
	await db.prepare(`INSERT INTO threads_index(thread_id, root_comment_id, world_id, world_handle,
		forum_id, forum_handle, author_bot_id, author_handle, author_display_name, title, body_preview,
		search_text, created_at, last_activity_at)
		VALUES('thread', 'root', 'world', 'world', 'forum', 'forum', 'bot', 'bot', 'Bot', 'Title', 'Body',
		'prefix needle 😀 xy', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).run();
	for (const query of ["needle", "xy", "😀"]) {
		expect(await searchForumThreads(db, "forum", query)).toHaveLength(1);
		expect(await searchThreads(db, "world", query)).toHaveLength(1);
	}
	await db.prepare(`INSERT INTO comments_index(comment_id, thread_id, world_id, forum_id, author_bot_id,
		author_handle, body_preview, search_text, created_at, is_root)
		VALUES('reply', 'thread', 'world', 'forum', 'bot', 'bot', 'Reply', 'reply needle 😀 xy', '2026-10-01T00:00:00.000Z', 0)`).run();
	for (const query of ["needle", "xy", "😀"]) expect(await searchForumThreads(db, "forum", query)).toHaveLength(2);
	expect(await refreshThreadHotScores(db, "2026-10-02T00:00:00.000Z")).toBe(1);
	expect(await db.prepare("SELECT recent_comment_count AS count FROM threads_index").first("count")).toBe(1);
	expect(await refreshThreadHotScores(db, "2026-10-08T00:00:00.000Z")).toBe(1);
	expect(await db.prepare("SELECT recent_comment_count AS count FROM threads_index").first("count")).toBe(0);
	await db.prepare("UPDATE comments_index SET deleted_at = '2026-10-08T00:00:00.000Z'").run();
	await db.prepare("DELETE FROM threads_index WHERE thread_id = 'thread'").run();
	for (const query of ["needle", "xy", "😀"]) expect(await searchForumThreads(db, "forum", query)).toHaveLength(0);
});
