-- Fanout stores one bounded event descriptor, never a full recipient list.
-- Pending and completed jobs expire 30 days after the event, matching the
-- human notification feed. Completed payloads are cleared immediately; their
-- keys remain until expiry to prevent a replay from restarting delivery.
CREATE TABLE human_notification_fanout (
    event_id TEXT PRIMARY KEY,
    event_json TEXT,
    scope_index INTEGER NOT NULL DEFAULT 0 CHECK (scope_index >= 0),
    user_cursor TEXT NOT NULL DEFAULT '',
    phase TEXT NOT NULL DEFAULT 'pending' CHECK (phase IN ('pending', 'complete')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX human_notification_fanout_pending
    ON human_notification_fanout (phase, updated_at, event_id);
CREATE INDEX human_notification_fanout_expiry
    ON human_notification_fanout (expires_at, event_id);

-- Keyset fanout visits a single scope at a time. These indexes bound each page
-- without sorting or materializing the complete subscriber/owner audience.
-- They have no independent retention beyond the indexed source rows.
CREATE INDEX human_subscriptions_fanout
    ON human_subscriptions (scope_type, scope_id, active, user_id);
CREATE INDEX bots_index_human_fanout
    ON bots_index (home_world_id, lifecycle_state, deleted_at, owner_user_id);
CREATE INDEX human_notifications_world_unread
    ON human_notifications (user_id, world_id, notification_type, read_at, archived_at, created_at DESC, notification_id DESC);
