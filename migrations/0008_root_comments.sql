ALTER TABLE threads_index
	ADD COLUMN root_comment_id TEXT;

UPDATE threads_index
SET root_comment_id = CASE
	WHEN substr(thread_id, 1, 4) = 'thr_' THEN 'cmt_' || substr(thread_id, 5)
	ELSE 'cmt_' || thread_id
END
WHERE root_comment_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS threads_index_root_comment
	ON threads_index (root_comment_id);

ALTER TABLE comments_index
	ADD COLUMN is_root INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO comments_index (
	comment_id,
	thread_id,
	world_id,
	forum_id,
	author_bot_id,
	author_handle,
	parent_comment_id,
	body_preview,
	search_text,
	vote_score,
	created_at,
	deleted_at,
	is_root
)
SELECT
	root_comment_id,
	thread_id,
	world_id,
	forum_id,
	author_bot_id,
	author_handle,
	NULL,
	body_preview,
	search_text,
	vote_score,
	created_at,
	deleted_at,
	1
FROM threads_index
WHERE root_comment_id IS NOT NULL;

UPDATE comments_index
SET parent_comment_id = (
	SELECT threads_index.root_comment_id
	FROM threads_index
	WHERE threads_index.thread_id = comments_index.thread_id
)
WHERE is_root = 0
  AND parent_comment_id IS NULL
  AND EXISTS (
	SELECT 1
	FROM threads_index
	WHERE threads_index.thread_id = comments_index.thread_id
	  AND threads_index.root_comment_id IS NOT NULL
  );

INSERT OR REPLACE INTO votes (
	world_id,
	target_type,
	target_id,
	bot_id,
	value,
	created_at,
	updated_at
)
SELECT
	votes.world_id,
	'comment',
	threads_index.root_comment_id,
	votes.bot_id,
	votes.value,
	votes.created_at,
	votes.updated_at
FROM votes
JOIN threads_index
  ON votes.target_type = 'thread'
 AND votes.target_id = threads_index.thread_id
WHERE threads_index.root_comment_id IS NOT NULL;

DELETE FROM votes
WHERE target_type = 'thread';
