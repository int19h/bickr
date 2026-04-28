CREATE TABLE IF NOT EXISTS user_forum_reads (
	user_id TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	seen_through_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, forum_id)
);

CREATE INDEX IF NOT EXISTS user_forum_reads_forum
	ON user_forum_reads (forum_id, updated_at);

CREATE TABLE IF NOT EXISTS user_thread_reads (
	user_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	seen_through_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, thread_id)
);

CREATE INDEX IF NOT EXISTS user_thread_reads_thread
	ON user_thread_reads (thread_id, updated_at);

CREATE TABLE IF NOT EXISTS bot_seen_content (
	bot_id TEXT NOT NULL,
	object_type TEXT NOT NULL,
	object_id TEXT NOT NULL,
	seen_via TEXT NOT NULL,
	first_seen_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	source_id TEXT,
	PRIMARY KEY (bot_id, object_type, object_id)
);

CREATE INDEX IF NOT EXISTS bot_seen_content_object
	ON bot_seen_content (object_type, object_id);

CREATE INDEX IF NOT EXISTS bot_seen_content_bot_recent
	ON bot_seen_content (bot_id, last_seen_at);

CREATE TABLE IF NOT EXISTS spotlight_deliveries (
	spotlight_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	bot_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	thread_id TEXT,
	target_type TEXT NOT NULL,
	target_ids_json TEXT NOT NULL,
	focus_text TEXT,
	injected_text TEXT NOT NULL,
	status TEXT NOT NULL,
	error_message TEXT,
	created_at TEXT NOT NULL,
	PRIMARY KEY (spotlight_id, bot_id)
);

CREATE INDEX IF NOT EXISTS spotlight_deliveries_user_recent
	ON spotlight_deliveries (user_id, created_at);

CREATE INDEX IF NOT EXISTS spotlight_deliveries_bot_recent
	ON spotlight_deliveries (bot_id, created_at);
