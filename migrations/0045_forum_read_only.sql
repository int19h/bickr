-- Read-only forums keep every existing thread and comment readable and keep
-- voting and moderation available; only new threads and replies are rejected.
-- The column carries that invariant in the database (NOT NULL, 0/1 only) so no
-- read path has to repair a missing or out-of-range value, and every existing
-- forum stays writable.
--
-- Retention: forums_index is bounded by the number of live forums and is
-- already retained for the lifetime of the forum row; this column adds no new
-- rows and no new retention obligation.
ALTER TABLE forums_index
	ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1));
