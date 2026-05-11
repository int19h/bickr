CREATE TABLE IF NOT EXISTS content_ids (
	id TEXT PRIMARY KEY,
	ref_type TEXT NOT NULL,
	created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO content_ids (id, ref_type, created_at)
SELECT thread_id, 'thread', created_at
FROM threads_index;

INSERT OR IGNORE INTO content_ids (id, ref_type, created_at)
SELECT comment_id, 'comment', created_at
FROM comments_index;
