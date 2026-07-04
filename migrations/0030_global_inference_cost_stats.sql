CREATE TABLE global_inference_cost_stats_cache (
	cache_key TEXT PRIMARY KEY,
	generated_at TEXT NOT NULL,
	window_start TEXT NOT NULL,
	window_end TEXT NOT NULL,
	window_days INTEGER NOT NULL,
	payload_json TEXT NOT NULL
);
