-- The notification retention sweep rotates through tombstoned bots oldest
-- deletion first, paging on a (deleted_at, bot_id) keyset from
-- packages/shared/src/social.ts. No existing index leads with deleted_at, so
-- every page sorted all of bots_index to return 50 rows: a pass whose cost
-- should track how often bots are deleted instead tracked how many exist.
--
-- Retention: this index stores no rows of its own and lives exactly as long as
-- the bots_index rows it covers. It is partial because only tombstoned bots are
-- ever swept, which keeps it proportional to deleted bots rather than to all of
-- them, and it covers both selected columns so a page never reads the table.
CREATE INDEX IF NOT EXISTS bots_index_tombstoned
	ON bots_index (deleted_at, bot_id)
	WHERE deleted_at IS NOT NULL;
