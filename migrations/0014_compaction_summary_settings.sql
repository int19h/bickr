ALTER TABLE bot_runtime_index
	ADD COLUMN compaction_summary_percent INTEGER NOT NULL DEFAULT 10;

ALTER TABLE bot_runtime_index
	ADD COLUMN compaction_max_characters INTEGER NOT NULL DEFAULT 4000;
