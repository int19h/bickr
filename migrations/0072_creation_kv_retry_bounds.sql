-- Retry metadata lives with its lifecycle operation. Completed operations use
-- the existing 30-day retention. A blocked creation retains its request,
-- secrets, claims, and participant data until an operator resumes or cancels
-- it. No automatic cleanup deletes a blocked creation.
ALTER TABLE entity_lifecycle_operations ADD COLUMN kv_retry_state TEXT NOT NULL DEFAULT 'none'
	CHECK (kv_retry_state IN ('none', 'retrying', 'blocked'));
-- The counter bounds automatic KV-dependent attempts. It resets on resume.
ALTER TABLE entity_lifecycle_operations ADD COLUMN kv_retry_count INTEGER NOT NULL DEFAULT 0
	CHECK (kv_retry_count >= 0);
-- The deadline starts at the first KV failure. Operator resolution clears it.
-- It has the same retention as the operation and its retry counter.
ALTER TABLE entity_lifecycle_operations ADD COLUMN kv_retry_deadline_at TEXT
	CHECK (kv_retry_state = 'none' OR kv_retry_deadline_at IS NOT NULL)
	CHECK (kv_retry_state != 'blocked' OR (
		phase = 'terminal_failed' AND entity_kind = 'bot' AND action = 'create'
		AND request_json IS NOT NULL AND terminal_cleanup_at IS NULL
	));

-- This bounded operator inventory and account-deletion guard retain no data
-- beyond their operation rows.
CREATE INDEX entity_lifecycle_operations_owner_kv_blocked
	ON entity_lifecycle_operations (owner_user_id, operation_id)
	WHERE kv_retry_state = 'blocked';
