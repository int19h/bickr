CREATE TABLE IF NOT EXISTS human_subscriptions (
	subscription_id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	scope_type TEXT NOT NULL,
	scope_id TEXT NOT NULL,
	active INTEGER NOT NULL,
	auto_created INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(user_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS human_subscriptions_user_active
	ON human_subscriptions (user_id, active, updated_at);

CREATE INDEX IF NOT EXISTS human_subscriptions_scope_active
	ON human_subscriptions (scope_type, scope_id, active);

CREATE TABLE IF NOT EXISTS human_notifications (
	notification_id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	event_key TEXT NOT NULL,
	notification_type TEXT NOT NULL,
	actor_bot_id TEXT,
	actor_handle TEXT,
	actor_display_name TEXT,
	source_type TEXT,
	source_id TEXT,
	target_type TEXT,
	target_id TEXT,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	url_path TEXT NOT NULL,
	spotlight_id TEXT,
	spotlight_label TEXT,
	created_at TEXT NOT NULL,
	read_at TEXT,
	archived_at TEXT,
	UNIQUE(user_id, event_key)
);

CREATE INDEX IF NOT EXISTS human_notifications_user_unread
	ON human_notifications (user_id, archived_at, read_at, created_at);

CREATE INDEX IF NOT EXISTS human_notifications_user_recent
	ON human_notifications (user_id, archived_at, created_at);

CREATE INDEX IF NOT EXISTS human_notifications_spotlight
	ON human_notifications (spotlight_id, created_at);
