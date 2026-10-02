import type { D1DatabaseLike } from "./storage";

export const threadHotRefreshBatchSize = 64;

/** Refresh only changed threads or comments whose age crosses the hot window. */
export async function refreshDueThreadCommentCounts(db: D1DatabaseLike, now: string, windowDays: number): Promise<number> {
	const due = await db.prepare(
		`SELECT thread_id AS threadId FROM thread_hot_refresh
		 WHERE next_refresh_at <= ? ORDER BY next_refresh_at, thread_id LIMIT ?`,
	).bind(now, threadHotRefreshBatchSize).all<{ threadId: string }>();
	const ids = (due.results ?? []).map((row) => row.threadId);
	if (!ids.length) return 0;
	const cutoff = new Date(Date.parse(now) - windowDays * 86_400_000).toISOString();
	const placeholders = ids.map(() => "?").join(", ");
	const count = `(SELECT count(*) FROM comments_index c
		WHERE c.thread_id = threads_index.thread_id AND c.deleted_at IS NULL AND c.created_at > ?)`;
	// D1 batch is atomic: a concurrent comment write cannot be lost between the
	// count update and the queue reschedule. Its trigger runs before or after both.
	const results = await db.batch([
		db.prepare(`UPDATE threads_index SET recent_comment_count = ${count}
			WHERE thread_id IN (${placeholders}) AND deleted_at IS NULL AND recent_comment_count != ${count}`)
			.bind(cutoff, ...ids, cutoff),
		db.prepare(`UPDATE thread_hot_refresh SET next_refresh_at = (
			SELECT strftime('%Y-%m-%dT%H:%M:%fZ', min(c.created_at), ?)
			FROM comments_index c WHERE c.thread_id = thread_hot_refresh.thread_id
			AND c.deleted_at IS NULL AND c.created_at > ?
		) WHERE thread_id IN (${placeholders})
		AND EXISTS (SELECT 1 FROM threads_index t WHERE t.thread_id = thread_hot_refresh.thread_id AND t.deleted_at IS NULL)
		AND EXISTS (SELECT 1 FROM comments_index c WHERE c.thread_id = thread_hot_refresh.thread_id AND c.deleted_at IS NULL AND c.created_at > ?)`)
			.bind(`+${windowDays} days`, cutoff, ...ids, cutoff),
		db.prepare(`DELETE FROM thread_hot_refresh WHERE thread_id IN (${placeholders}) AND (
			NOT EXISTS (SELECT 1 FROM threads_index t WHERE t.thread_id = thread_hot_refresh.thread_id AND t.deleted_at IS NULL)
			OR NOT EXISTS (SELECT 1 FROM comments_index c WHERE c.thread_id = thread_hot_refresh.thread_id AND c.deleted_at IS NULL AND c.created_at > ?)
		)`).bind(...ids, cutoff),
	]);
	if (results.some((result) => !result.success)) throw new Error("Thread hot-count refresh batch failed.");
	return ids.length;
}
