-- The single bootstrap notification a participant ever receives is recorded on
-- the participant row itself, because the notification row it used to be read
-- from is prunable: once pruned, the next new-iteration tick re-created the
-- bootstrap (288 of 435 production bootstrap rows are such re-creations).
-- Retention: a nullable column on bots_index lives exactly as long as the bot
-- row it annotates, so there is nothing separate to prune.
ALTER TABLE bots_index ADD COLUMN bootstrap_notified_at TEXT;

-- Backfill ONLY bots that currently hold a bootstrap notification row, stamped
-- with that notification's own created_at — the accurate fact, and still
-- readable at migration time. Bots without such a row (never ticked, mid
-- lifecycle creation, paused since creation) deliberately keep NULL and receive
-- their single bootstrap on their first new-iteration tick; a blanket backfill
-- would silently cancel a bootstrap that was never sent.
UPDATE bots_index
SET bootstrap_notified_at = (
	SELECT MIN(n.created_at)
	FROM notifications n
	WHERE n.bot_id = bots_index.bot_id AND n.type = 'bootstrap'
)
WHERE bot_id IN (SELECT bot_id FROM notifications WHERE type = 'bootstrap');
