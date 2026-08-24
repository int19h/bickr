-- Frequent stale-run recovery walks only the currently running runtime rows in
-- stable bot_id order and checks whether each progress lease is NULL or has
-- expired. Keeping lease_expires_at in the partial index makes that predicate
-- available without reading the much larger historical runtime set, while
-- bot_id remains the immutable keyset cursor (lease renewal mutates the clock).
--
-- Retention: this index creates no rows of its own and lives exactly as long as
-- the one-row-per-participant bot_runtime_index rows it covers. The partial
-- predicate keeps it proportional to active visits rather than participant
-- history.
CREATE INDEX IF NOT EXISTS bot_runtime_running_lease_recovery
	ON bot_runtime_index (bot_id, lease_expires_at)
	WHERE status = 'running';
