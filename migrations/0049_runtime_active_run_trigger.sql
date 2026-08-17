-- Records why the run currently holding a participant's runtime lease was
-- admitted. A spotlight visit interrupts a participant on a human's schedule
-- rather than its own, so neither claiming nor releasing it may move
-- next_due_at; without this column the paths that release a run — the visit's
-- own completion, an out-of-band stop, the stale-run reaper — have no way to
-- tell an interruption from the participant's own tick, because they can run
-- long after the request that knew.
--
-- Nullable by design: NULL means no run holds the lease, and a run claimed by
-- the previous deployment is read as 'cron'. That costs at most one in-flight
-- spotlight visit per participant a final schedule reset at deploy time, and
-- needs no two-phase rollout. The CHECK keeps the stored domain to the trigger
-- values themselves so no read path has to repair an unexpected string.
--
-- Retention: bot_runtime_index holds exactly one row per participant for that
-- participant's lifetime. This column adds no rows and no new retention
-- obligation; every release clears it back to NULL.
ALTER TABLE bot_runtime_index
	ADD COLUMN active_run_trigger TEXT
	CHECK (active_run_trigger IS NULL OR active_run_trigger IN ('cron', 'manual', 'spotlight'));
