ALTER TABLE worlds_index
	ADD COLUMN recurring_prompt_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE worlds_index
	ADD COLUMN recurring_prompt TEXT NOT NULL DEFAULT '';

ALTER TABLE worlds_index
	ADD COLUMN recurring_prompt_lang TEXT;
