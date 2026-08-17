-- Records that a participant's BotRuntime Durable Object storage has been
-- fully cleared because the participant itself is gone. Deleting a participant
-- keeps its runtime row (the row is the fleet's only durable handle on the
-- object), so without this marker the daily retention sweep would wake every
-- participant ever deleted, every cycle, forever: a deleted participant's
-- object has no ticks left to prove it is already empty.
--
-- Set only after a clear that the object itself confirmed, by the bot-delete
-- lifecycle or by the sweep working through the backlog of participants deleted
-- before that step existed. A failed clear leaves the marker NULL so the next
-- pass retries it.
--
-- Retention: bot_runtime_index holds exactly one row per participant for that
-- participant's lifetime. This column adds no rows and no new retention
-- obligation.
ALTER TABLE bot_runtime_index
	ADD COLUMN runtime_storage_cleared_at TEXT;

-- The sweep walks unmarked rows by bot_id. The partial index keeps that keyset
-- walk proportional to the participants still needing retention work rather
-- than to every participant that has ever existed.
CREATE INDEX IF NOT EXISTS bot_runtime_retention_pending
	ON bot_runtime_index (bot_id)
	WHERE runtime_storage_cleared_at IS NULL;
