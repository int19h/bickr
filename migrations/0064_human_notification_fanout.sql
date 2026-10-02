-- Fanout stores one bounded event descriptor, never a full recipient list.
-- Pending and completed jobs expire 30 days after the event, matching the
-- human notification feed. Completed payloads are cleared immediately; their
-- keys remain until expiry to prevent a replay from restarting delivery.
CREATE TABLE human_notification_fanout (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
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
CREATE INDEX human_notifications_world_unread
    ON human_notifications (user_id, world_id, notification_type, read_at, archived_at, created_at DESC, notification_id DESC);

-- The AUTOINCREMENT high-water mark persists after expiry in one sqlite_sequence
-- row for the environment lifetime. Activation captures it in the same D1 write.
-- A later event has a strictly greater sequence, even within one millisecond.
-- Existing active preferences/memberships precede every event from this release.
-- The new columns share their source row's existing retention rules.
ALTER TABLE human_subscriptions ADD COLUMN activation_after_sequence INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER human_subscriptions_activation_insert AFTER INSERT ON human_subscriptions
BEGIN
    UPDATE human_subscriptions SET activation_after_sequence = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'human_notification_fanout'), 0)
    WHERE subscription_id = NEW.subscription_id;
END;
CREATE TRIGGER human_subscriptions_activation_update AFTER UPDATE OF active ON human_subscriptions
WHEN OLD.active != 1 AND NEW.active = 1
BEGIN
    UPDATE human_subscriptions SET activation_after_sequence = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'human_notification_fanout'), 0)
    WHERE subscription_id = NEW.subscription_id;
END;

-- World-settings audiences use the same publication boundary for membership.
-- A new/activated participant cannot subscribe its owner to an older event.
ALTER TABLE bots_index ADD COLUMN membership_after_sequence INTEGER NOT NULL DEFAULT 0;
-- Owner pages seek past all participants of each owner. Delivery then checks
-- that exact owner's eligible membership range without scanning newer members.
CREATE INDEX bots_index_human_fanout
    ON bots_index (home_world_id, lifecycle_state, deleted_at, owner_user_id, membership_after_sequence);
CREATE TRIGGER bots_index_human_membership_insert AFTER INSERT ON bots_index
BEGIN
    UPDATE bots_index SET membership_after_sequence = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'human_notification_fanout'), 0)
    WHERE bot_id = NEW.bot_id;
END;
CREATE TRIGGER bots_index_human_membership_update AFTER UPDATE OF lifecycle_state, home_world_id, owner_user_id ON bots_index
WHEN (OLD.lifecycle_state != 'active' AND NEW.lifecycle_state = 'active')
    OR OLD.home_world_id != NEW.home_world_id OR OLD.owner_user_id != NEW.owner_user_id
BEGIN
    UPDATE bots_index SET membership_after_sequence = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'human_notification_fanout'), 0)
    WHERE bot_id = NEW.bot_id;
END;

-- Revisions order world changes even when two updates share a millisecond or
-- delivery jobs run out of order. Older rows have no revision and use timestamp
-- ordering until the first new world change coalesces onto them.
ALTER TABLE human_notifications ADD COLUMN world_settings_revision INTEGER;
