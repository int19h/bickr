-- Spotlight delivery rows are D1-only and retain created_at for at most 14 days,
-- matching the injection retention the runtime applies to the same batch
-- (spotlightDeliveryRetentionDays in packages/shared/src/social.ts). The
-- forum-coordinator daily cron prunes by a global created_at cutoff; the
-- existing user- and bot-scoped recent indexes lead with the wrong column and
-- cannot serve that D1-wide retention scan, so every batch would sort the table.
--
-- Retention: this index stores no rows of its own and lives exactly as long as
-- the spotlight_deliveries rows it covers.
CREATE INDEX IF NOT EXISTS spotlight_deliveries_retention
	ON spotlight_deliveries (created_at);

-- Human notification rows are D1-only and retain created_at for at most 30 days,
-- read or unread, archived or not (humanNotificationRetentionDays in
-- packages/shared/src/social.ts). The same daily cron prunes them by a global
-- created_at cutoff. Every existing index on this table leads with user_id or
-- spotlight_id, so none of them can answer that cutoff either.
--
-- Retention: this index stores no rows of its own and lives exactly as long as
-- the human_notifications rows it covers.
CREATE INDEX IF NOT EXISTS human_notifications_retention
	ON human_notifications (created_at);
