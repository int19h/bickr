import type { ThreadDocument } from "@bickr/shared/model";
import { RepositoryError } from "@bickr/shared/repository";
import { readThread } from "@bickr/shared/social";
import type { AppEnv } from "./api/_auth";
import { readCoordinatorThread } from "./api/_coordinator-thread";

/**
 * Reads a thread for a public page or image, KV first. An edge location can
 * serve a KV thread document for up to a minute after a write, or a cached
 * miss for a new thread. Crawlers fetch a link and its card image right after
 * someone shares it, which is exactly that window.
 *
 * So when the KV copy is missing or lacks what the request needs (`has`), and
 * the D1 index already shows that the content exists (`indexed`), this reads
 * the coordinator's copy, which has every committed write. The index gate
 * keeps requests for comments and threads that do not exist off the
 * coordinator. It cannot see drawing indexes, so a request for a drawing
 * index that a live comment does not have still reads the coordinator once.
 * That costs no more than the `?fresh=1` thread read that any visitor has.
 */
export async function readFreshThread(
	env: AppEnv,
	threadId: string,
	has: (thread: ThreadDocument) => boolean,
	indexed: () => Promise<boolean>,
): Promise<ThreadDocument> {
	let stored: ThreadDocument | null = null;
	try {
		stored = await readThread(env.BICKR_KV, threadId);
	} catch (error) {
		if (!(error instanceof RepositoryError) || error.status !== 404) throw error;
	}
	if (stored && has(stored)) return stored;
	if (!(await indexed())) {
		if (stored) return stored;
		throw new RepositoryError("not_found", "Thread not found.", 404);
	}
	return readCoordinatorThread(env, threadId);
}

/** Whether the index lists this comment as live in this live thread. */
export async function commentIndexed(db: D1Database, threadId: string, commentId: string): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS live
			 FROM comments_index c
			 JOIN threads_index t ON t.thread_id = c.thread_id
			 WHERE c.comment_id = ? AND c.thread_id = ? AND c.deleted_at IS NULL AND t.deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(commentId, threadId)
		.first<{ live: number }>();
	return Boolean(row);
}

/** Whether the index lists this thread as live. */
export async function threadIndexed(db: D1Database, threadId: string): Promise<boolean> {
	const row = await db.prepare(`SELECT 1 AS live FROM threads_index WHERE thread_id = ? AND deleted_at IS NULL LIMIT 1`).bind(threadId).first<{ live: number }>();
	return Boolean(row);
}
