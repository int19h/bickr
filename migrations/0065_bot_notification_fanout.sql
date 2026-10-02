-- One event per unfinished bot-notification audience. Each pass emits at most
-- 50 recipients, then checkpoints its ID cursor. Finished events are deleted;
-- pending events expire at the same 14-day deadline as their notifications.
CREATE TABLE bot_notification_fanouts (
    event_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    after_bot_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    next_attempt_at TEXT NOT NULL
);
CREATE INDEX bot_notification_fanouts_due ON bot_notification_fanouts(next_attempt_at, event_id);
-- Follower fanout seeks by recipient ID instead of sorting the full audience.
-- This index has exactly the retention of its follows row.
CREATE INDEX follows_recipient_page ON follows(followed_bot_id, follower_bot_id);
