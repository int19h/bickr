CREATE TABLE bot_inference_usage (
	bot_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	home_world_id TEXT NOT NULL,
	home_world_handle TEXT NOT NULL,
	source_usage_id INTEGER NOT NULL,
	run_id TEXT NOT NULL,
	request_seq INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	requested_model TEXT NOT NULL,
	response_model TEXT,
	model TEXT NOT NULL,
	context_window_tokens INTEGER NOT NULL,
	provider_base_url TEXT NOT NULL,
	provider_name TEXT,
	prompt_tokens INTEGER NOT NULL,
	completion_tokens INTEGER NOT NULL,
	total_tokens INTEGER NOT NULL,
	cached_tokens INTEGER NOT NULL DEFAULT 0,
	reasoning_tokens INTEGER NOT NULL DEFAULT 0,
	cost REAL,
	exported_at TEXT NOT NULL,
	PRIMARY KEY (bot_id, run_id, request_seq)
);

CREATE UNIQUE INDEX bot_inference_usage_source
	ON bot_inference_usage (bot_id, source_usage_id);

CREATE INDEX bot_inference_usage_owner_created
	ON bot_inference_usage (owner_user_id, created_at);

CREATE INDEX bot_inference_usage_bot_created
	ON bot_inference_usage (bot_id, created_at);

CREATE INDEX bot_inference_usage_created
	ON bot_inference_usage (created_at);

CREATE INDEX bot_inference_usage_bot_model_created
	ON bot_inference_usage (bot_id, requested_model, created_at);
