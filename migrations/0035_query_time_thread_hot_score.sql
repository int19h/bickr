DROP INDEX IF EXISTS threads_index_world_hot;
DROP INDEX IF EXISTS threads_index_forum_hot;

ALTER TABLE threads_index DROP COLUMN hot_score;

-- Hot ordering is computed after this index bounds candidates to the active window.
CREATE INDEX threads_index_world_hot
	ON threads_index (world_id, deleted_at, last_activity_at DESC, vote_score, recent_comment_count);

CREATE INDEX threads_index_forum_hot
	ON threads_index (forum_id, deleted_at, last_activity_at DESC, vote_score, recent_comment_count);
