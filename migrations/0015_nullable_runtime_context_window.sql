CREATE TABLE bot_runtime_index_next (
	bot_id TEXT PRIMARY KEY,
	owner_user_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	enabled INTEGER NOT NULL,
	tick_interval_seconds INTEGER NOT NULL,
	context_window_tokens INTEGER,
	compaction_threshold REAL NOT NULL,
	compaction_summary_percent INTEGER NOT NULL DEFAULT 10,
	compaction_max_characters INTEGER NOT NULL DEFAULT 4000,
	max_tool_calls_per_tick INTEGER NOT NULL,
	max_successful_tool_calls_per_iteration INTEGER NOT NULL DEFAULT 8,
	max_generated_tokens_per_tick INTEGER NOT NULL DEFAULT 15000,
	max_generated_tokens_per_iteration INTEGER NOT NULL DEFAULT 30000,
	next_due_at TEXT,
	status TEXT NOT NULL,
	active_run_id TEXT,
	lease_expires_at TEXT,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

INSERT INTO bot_runtime_index_next (
	bot_id, owner_user_id, world_id, enabled, tick_interval_seconds, context_window_tokens,
	compaction_threshold, compaction_summary_percent, compaction_max_characters,
	max_tool_calls_per_tick, max_successful_tool_calls_per_iteration,
	max_generated_tokens_per_tick, max_generated_tokens_per_iteration,
	next_due_at, status, active_run_id, lease_expires_at, last_error, created_at, updated_at
)
SELECT
	bot_id, owner_user_id, world_id, enabled, tick_interval_seconds,
	CASE WHEN context_window_tokens = 16000 THEN NULL ELSE context_window_tokens END,
	compaction_threshold, compaction_summary_percent, compaction_max_characters,
	max_tool_calls_per_tick, max_successful_tool_calls_per_iteration,
	max_generated_tokens_per_tick, max_generated_tokens_per_iteration,
	next_due_at, status, active_run_id, lease_expires_at, last_error, created_at, updated_at
FROM bot_runtime_index;

DROP INDEX IF EXISTS bot_runtime_due;
DROP TABLE bot_runtime_index;
ALTER TABLE bot_runtime_index_next RENAME TO bot_runtime_index;

CREATE INDEX IF NOT EXISTS bot_runtime_due
	ON bot_runtime_index (enabled, next_due_at, lease_expires_at);
