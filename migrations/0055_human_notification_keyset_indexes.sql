-- The notification list orders by `(created_at DESC, notification_id DESC)`, a
-- total order, because `created_at` ties are routine (one bot fan-out writes
-- several rows in the same millisecond) and the mark-all anchor is the maximum
-- of that tuple over what the client rendered, so it has to be well defined
-- before the sweep can bound anything by it. Both existing user indexes stop at
-- `created_at`, so with the tie-break added SQLite could no longer satisfy the
-- ORDER BY from the index: it would materialize and sort every one of the user's
-- notifications — joined against six index tables — before applying
-- LIMIT/OFFSET.
--
-- With them, the list plans as `SEARCH hn USING COVERING INDEX
-- human_notifications_user_unread_keyset (user_id=? AND archived_at=? AND
-- read_at=?)` and no temp b-tree for the ORDER BY, which is the whole point.
--
-- These extend the two indexes by the tie-break column. Each old index is a
-- strict prefix of its replacement, so nothing that used the old one loses its
-- plan, and keeping both would only cost writes.
--
-- Retention: these indexes store no rows of their own and live exactly as long
-- as the human_notifications rows they cover.
CREATE INDEX IF NOT EXISTS human_notifications_user_unread_keyset
	ON human_notifications (user_id, archived_at, read_at, created_at, notification_id);

CREATE INDEX IF NOT EXISTS human_notifications_user_recent_keyset
	ON human_notifications (user_id, archived_at, created_at, notification_id);

DROP INDEX IF EXISTS human_notifications_user_unread;

DROP INDEX IF EXISTS human_notifications_user_recent;
