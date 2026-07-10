-- Bot seen-content rows are D1-only and retain last_seen_at for at most 90 days.
-- The forum-coordinator daily cron prunes by a global last_seen_at cutoff; the
-- existing bot-scoped recent index cannot serve that D1-wide retention scan.
CREATE INDEX IF NOT EXISTS bot_seen_content_retention
	ON bot_seen_content (last_seen_at);
