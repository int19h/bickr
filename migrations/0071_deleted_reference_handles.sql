-- Retention: these handles live with their existing entity index rows.
-- They preserve references in participant output after deletion.
ALTER TABLE bots_index ADD COLUMN handle_at_deletion TEXT;
ALTER TABLE forums_index ADD COLUMN handle_at_deletion TEXT;
-- The bounded operator backfill copies old deletion handles from KV once.
-- Request paths never read KV to resolve a deleted reference.
CREATE INDEX bots_index_missing_deletion_handles ON bots_index (bot_id)
WHERE deleted_at IS NOT NULL AND handle_at_deletion IS NULL;
CREATE INDEX forums_index_missing_deletion_handles ON forums_index (forum_id)
WHERE deleted_at IS NOT NULL AND handle_at_deletion IS NULL;
