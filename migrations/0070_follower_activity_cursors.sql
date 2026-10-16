-- One reference per published thread/comment, retained for 14 days. The
-- five-minute notification prune uses the expiry index in bounded batches.
-- AUTOINCREMENT must survive even an empty table: follow baselines and issued
-- receipts use this table's sqlite_sequence row, never another table's counter.
CREATE TABLE follower_activity_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence <= 9007199254740991),
    source_ref TEXT NOT NULL UNIQUE CHECK (substr(source_ref, 1, 2) IN ('t/', 'c/')),
    actor_bot_id TEXT NOT NULL,
    world_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    direct_recipient_ids_json TEXT NOT NULL CHECK (json_valid(direct_recipient_ids_json) AND json_type(direct_recipient_ids_json) = 'array')
);
CREATE INDEX follower_activity_actor_sequence ON follower_activity_events(actor_bot_id, sequence);
CREATE INDEX follower_activity_expiry ON follower_activity_events(created_at, sequence);
-- Cursor lifetime equals its follow row. Existing follows start before the new,
-- empty stream; a new follow starts after all previously committed events.
ALTER TABLE follows ADD COLUMN activity_delivered_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (activity_delivered_sequence >= 0 AND activity_delivered_sequence <= 9007199254740991);
-- Keep the separate legacy membership trigger until old follower jobs and old
-- staged mutation plans drain. Its counter belongs to bot_notification_fanouts.
CREATE TRIGGER follows_activity_membership_insert AFTER INSERT ON follows
BEGIN
    UPDATE follows SET activity_delivered_sequence = COALESCE(
        (SELECT seq FROM sqlite_sequence WHERE name = 'follower_activity_events'), 0)
    WHERE follower_bot_id = NEW.follower_bot_id AND followed_bot_id = NEW.followed_bot_id;
END;
