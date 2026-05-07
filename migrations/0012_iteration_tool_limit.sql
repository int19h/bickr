ALTER TABLE bot_runtime_index
	ADD COLUMN max_successful_tool_calls_per_iteration INTEGER NOT NULL DEFAULT 8;
