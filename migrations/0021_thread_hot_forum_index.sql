CREATE INDEX IF NOT EXISTS threads_index_forum_hot
	ON threads_index (forum_id, deleted_at, hot_score DESC, last_activity_at DESC);
