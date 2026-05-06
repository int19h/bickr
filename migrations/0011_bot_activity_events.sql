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

CREATE INDEX IF NOT EXISTS bot_activity_events_target
	ON bot_activity_events (activity_type, target_type, target_id, created_at);
