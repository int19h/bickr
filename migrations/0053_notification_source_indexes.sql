-- Content deletion now retracts the notifications the deleted content generated
-- (issue #200): every comment and thread tombstone carries `source_object_id`
-- and `source_id`/`target_id` deletes in its batch, and a backstop sweep pages
-- the same columns for rows a delete raced. Neither notification table had an
-- index on any of those columns, so each of those deletes was a full scan —
-- ~160k rows in production, inside a user-facing delete request.
--
-- DEPLOY ORDERING IS NOT OPTIONAL: these indexes must exist before the Workers
-- that issue the new deletes. `npm run deploy:test` already applies migrations
-- first; the production runbook step is migration-before-workers, verified with
--
--   SELECT name FROM sqlite_master
--    WHERE type = 'index'
--      AND name IN ('notifications_source', 'human_notifications_source', 'human_notifications_target');
--
-- returning all three before the Workers deploy proceeds.
--
-- Retention: these indexes store no rows of their own and live exactly as long
-- as the notification rows they cover.

CREATE INDEX IF NOT EXISTS notifications_source
	ON notifications (source_object_id);

CREATE INDEX IF NOT EXISTS human_notifications_source
	ON human_notifications (source_type, source_id);

CREATE INDEX IF NOT EXISTS human_notifications_target
	ON human_notifications (target_type, target_id);
