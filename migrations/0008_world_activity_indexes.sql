CREATE TABLE IF NOT EXISTS bot_activity_events (
	activity_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	bot_id TEXT NOT NULL,
	activity_type TEXT NOT NULL,
	target_type TEXT NOT NULL,
	target_id TEXT NOT NULL,
	value INTEGER,
	reason TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bot_activity_events_bot_recent
	ON bot_activity_events (bot_id, created_at);

CREATE INDEX IF NOT EXISTS bot_activity_events_world_recent
	ON bot_activity_events (world_id, created_at);

CREATE INDEX IF NOT EXISTS bot_activity_events_target
	ON bot_activity_events (activity_type, target_type, target_id, created_at);

CREATE INDEX IF NOT EXISTS threads_index_world_activity
	ON threads_index (world_id, deleted_at, created_at);

CREATE INDEX IF NOT EXISTS comments_index_world_activity
	ON comments_index (world_id, deleted_at, created_at);

CREATE INDEX IF NOT EXISTS votes_world_activity
	ON votes (world_id, updated_at);

CREATE INDEX IF NOT EXISTS follows_world_activity
	ON follows (world_id, created_at);
