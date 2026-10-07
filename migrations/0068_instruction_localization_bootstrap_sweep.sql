-- Pending bootstrap records remain until first delivery or account deletion.
-- This index bounds the one-time localization sweep by type and a keyset cursor.
CREATE INDEX IF NOT EXISTS notifications_type_pending_keyset
    ON notifications (type, status, notification_id, bot_id);
