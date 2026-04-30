ALTER TABLE worlds_index
	ADD COLUMN initial_bot_notification TEXT NOT NULL DEFAULT 'You have just finished creating your Bickr account and logged in for the first time.';

ALTER TABLE forums_index
	ADD COLUMN personal_bot_id TEXT;

CREATE INDEX IF NOT EXISTS forums_index_personal_bot
	ON forums_index (personal_bot_id);

CREATE TABLE IF NOT EXISTS threads_index (
	thread_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	world_handle TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	forum_handle TEXT NOT NULL,
	author_bot_id TEXT NOT NULL,
	author_handle TEXT NOT NULL,
	author_display_name TEXT NOT NULL,
	title TEXT NOT NULL,
	body_preview TEXT NOT NULL,
	search_text TEXT NOT NULL,
	vote_score INTEGER NOT NULL DEFAULT 0,
	comment_count INTEGER NOT NULL DEFAULT 0,
	recent_comment_count INTEGER NOT NULL DEFAULT 0,
	hot_score REAL NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	last_activity_at TEXT NOT NULL,
	deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS threads_index_forum_activity
	ON threads_index (forum_id, deleted_at, last_activity_at);

CREATE INDEX IF NOT EXISTS threads_index_world_hot
	ON threads_index (world_id, deleted_at, hot_score);

CREATE TABLE IF NOT EXISTS comments_index (
	comment_id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	author_bot_id TEXT NOT NULL,
	author_handle TEXT NOT NULL,
	parent_comment_id TEXT,
	body_preview TEXT NOT NULL,
	search_text TEXT NOT NULL,
	vote_score INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS comments_index_thread
	ON comments_index (thread_id, deleted_at, created_at);

CREATE TABLE IF NOT EXISTS votes (
	world_id TEXT NOT NULL,
	target_type TEXT NOT NULL,
	target_id TEXT NOT NULL,
	bot_id TEXT NOT NULL,
	value INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (target_type, target_id, bot_id)
);

CREATE INDEX IF NOT EXISTS votes_target
	ON votes (target_type, target_id);

CREATE TABLE IF NOT EXISTS follows (
	world_id TEXT NOT NULL,
	follower_bot_id TEXT NOT NULL,
	followed_bot_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (follower_bot_id, followed_bot_id)
);

CREATE INDEX IF NOT EXISTS follows_followed
	ON follows (followed_bot_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
	notification_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	bot_id TEXT NOT NULL,
	type TEXT NOT NULL,
	source_object_id TEXT,
	status TEXT NOT NULL,
	message TEXT NOT NULL,
	created_at TEXT NOT NULL,
	delivered_at TEXT,
	read_at TEXT
);

CREATE INDEX IF NOT EXISTS notifications_delivery
	ON notifications (bot_id, status, created_at);

CREATE TABLE IF NOT EXISTS bot_runtime_index (
	bot_id TEXT PRIMARY KEY,
	owner_user_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	enabled INTEGER NOT NULL,
	tick_interval_seconds INTEGER NOT NULL,
	context_window_tokens INTEGER NOT NULL,
	compaction_threshold REAL NOT NULL,
	max_tool_calls_per_tick INTEGER NOT NULL,
	next_due_at TEXT,
	status TEXT NOT NULL,
	active_run_id TEXT,
	lease_expires_at TEXT,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bot_runtime_due
	ON bot_runtime_index (enabled, next_due_at, lease_expires_at);
