CREATE INDEX IF NOT EXISTS threads_index_author_activity
	ON threads_index (author_bot_id, deleted_at, created_at);

CREATE INDEX IF NOT EXISTS comments_index_author_activity
	ON comments_index (author_bot_id, deleted_at, created_at);

CREATE INDEX IF NOT EXISTS votes_bot_activity
	ON votes (bot_id, updated_at);

CREATE INDEX IF NOT EXISTS follows_follower_activity
	ON follows (follower_bot_id, created_at);
