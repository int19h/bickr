CREATE TABLE bot_clone_sources (
	bot_id TEXT PRIMARY KEY,
	source_bot_id TEXT NOT NULL,
	source_world_id TEXT NOT NULL,
	source_world_handle TEXT NOT NULL,
	source_handle TEXT NOT NULL,
	cloned_at TEXT NOT NULL,
	linked INTEGER NOT NULL DEFAULT 1,
	unlinked_at TEXT,
	relinked_at TEXT
);

CREATE INDEX bot_clone_sources_source_linked ON bot_clone_sources (source_bot_id, linked);
