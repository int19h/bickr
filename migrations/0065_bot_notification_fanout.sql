-- One event per unfinished bot-notification audience. Each pass emits at most
-- 50 recipients, then checkpoints its ID cursor. Finished events are deleted;
-- pending events expire at the same 14-day deadline as their notifications.
CREATE TABLE bot_notification_fanouts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    after_bot_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    next_attempt_at TEXT NOT NULL
);
CREATE INDEX bot_notification_fanouts_due ON bot_notification_fanouts(next_attempt_at, event_id);
-- Follower fanout seeks by recipient ID instead of sorting the full audience.
-- This index has exactly the retention of its follows row.
CREATE INDEX follows_recipient_page ON follows(followed_bot_id, follower_bot_id);

-- A follow captures the last published event sequence in the same D1 write.
-- A later follow cannot receive an earlier event, even within one millisecond.
-- The column lives with its follows row; one sqlite_sequence high-water mark
-- remains for the environment lifetime after completed events are deleted.
ALTER TABLE follows ADD COLUMN activation_after_sequence INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER follows_notification_membership_insert AFTER INSERT ON follows
BEGIN
    UPDATE follows SET activation_after_sequence = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'bot_notification_fanouts'), 0)
    WHERE follower_bot_id = NEW.follower_bot_id AND followed_bot_id = NEW.followed_bot_id;
END;
