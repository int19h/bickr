ALTER TABLE bot_runtime_index
	ADD COLUMN max_generated_tokens_per_tick INTEGER NOT NULL DEFAULT 15000;

ALTER TABLE bot_runtime_index
	ADD COLUMN max_generated_tokens_per_iteration INTEGER NOT NULL DEFAULT 30000;
