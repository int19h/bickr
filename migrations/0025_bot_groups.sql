CREATE TABLE IF NOT EXISTS bot_groups (
	group_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	custom_title TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS bot_groups_owner_world
	ON bot_groups (owner_user_id, world_id, deleted_at, created_at);

CREATE INDEX IF NOT EXISTS bot_groups_world
	ON bot_groups (world_id, deleted_at, updated_at);

CREATE TABLE IF NOT EXISTS bot_group_members (
	group_id TEXT NOT NULL,
	bot_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	added_at TEXT NOT NULL,
	PRIMARY KEY (group_id, bot_id)
);

CREATE INDEX IF NOT EXISTS bot_group_members_world_bot
	ON bot_group_members (world_id, bot_id);
