CREATE INDEX IF NOT EXISTS threads_index_forum_title_active
	ON threads_index (forum_id, deleted_at, title);
