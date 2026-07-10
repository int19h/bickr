-- Bot notifications retain KV mirror documents for at most 90 days from creation.
-- The forum-coordinator daily cron prunes rows from this table using the
-- status-specific policy in packages/shared/src/social.ts. Human notifications
-- have a separate lifecycle and are intentionally not covered by this index.
CREATE INDEX IF NOT EXISTS notifications_retention
	ON notifications (status, created_at, notification_id, bot_id);
