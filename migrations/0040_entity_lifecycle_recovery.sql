-- One derived row per owner is retained only while that owner has at least one
-- nonterminal lifecycle operation. It is the durable, globally indexed wake
-- projection for the canonical lifecycle machine, not a second state machine.
-- A short lease prevents a failed owner from monopolizing every bounded cron
-- page; terminal transitions hard-delete the row when no work remains.
CREATE TABLE entity_lifecycle_recovery_owners (
	owner_user_id TEXT PRIMARY KEY,
	due_at TEXT NOT NULL,
	lease_token TEXT,
	lease_expires_at TEXT,
	updated_at TEXT NOT NULL,
	CHECK (
		(lease_token IS NULL AND lease_expires_at IS NULL) OR
		(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
	)
);

CREATE INDEX entity_lifecycle_recovery_owners_due
	ON entity_lifecycle_recovery_owners (due_at, lease_expires_at, owner_user_id);

-- Every trigger refresh below reads only the earliest nonterminal operation
-- for one owner instead of aggregating that owner's operation history.
CREATE INDEX entity_lifecycle_operations_owner_due
	ON entity_lifecycle_operations (
		owner_user_id,
		COALESCE(next_retry_at, updated_at),
		operation_id
	)
	WHERE phase NOT IN ('terminal', 'terminal_failed');

-- Account deletion discovers newly active owned worlds in bounded pages.
CREATE INDEX worlds_index_owner_public_lifecycle
	ON worlds_index (created_by_user_id, lifecycle_state, deleted_at, handle, world_id);

-- Account deletion examines participants in the same bounded handle order in
-- which it reserves child operations.
CREATE INDEX bots_index_owner_public_handle
	ON bots_index (owner_user_id, lifecycle_state, deleted_at, handle, bot_id);

-- Backfill any operation that was committed before this recovery projection
-- existed. The earliest due operation names the next wake for each owner.
INSERT INTO entity_lifecycle_recovery_owners (
	owner_user_id, due_at, lease_token, lease_expires_at, updated_at
)
SELECT
	owner_user_id,
	MIN(COALESCE(next_retry_at, updated_at)),
	NULL,
	NULL,
	MAX(updated_at)
FROM entity_lifecycle_operations
WHERE phase NOT IN ('terminal', 'terminal_failed')
GROUP BY owner_user_id;

-- Every canonical operation write refreshes the same per-owner projection in
-- the operation transaction. This closes the process-death window between a
-- D1 phase commit and Durable Object alarm storage, including the account
-- bootstrap reservation that necessarily precedes USER_BOTS.idFromName().
CREATE TRIGGER entity_lifecycle_recovery_after_insert
AFTER INSERT ON entity_lifecycle_operations
WHEN NEW.phase NOT IN ('terminal', 'terminal_failed')
BEGIN
	INSERT INTO entity_lifecycle_recovery_owners (
		owner_user_id, due_at, lease_token, lease_expires_at, updated_at
	)
SELECT
	owner_user_id,
	COALESCE(next_retry_at, updated_at),
	NULL,
	NULL,
	NEW.updated_at
FROM entity_lifecycle_operations
WHERE owner_user_id = NEW.owner_user_id
  AND phase NOT IN ('terminal', 'terminal_failed')
ORDER BY COALESCE(next_retry_at, updated_at) ASC, operation_id ASC
LIMIT 1
ON CONFLICT(owner_user_id) DO UPDATE SET
		due_at = excluded.due_at,
		lease_token = NULL,
		lease_expires_at = NULL,
		updated_at = excluded.updated_at;
END;

CREATE TRIGGER entity_lifecycle_recovery_after_update
AFTER UPDATE OF phase, next_retry_at, updated_at ON entity_lifecycle_operations
BEGIN
	DELETE FROM entity_lifecycle_recovery_owners
	WHERE owner_user_id = NEW.owner_user_id
	  AND NOT EXISTS (
		SELECT 1
		FROM entity_lifecycle_operations
		WHERE owner_user_id = NEW.owner_user_id
		  AND phase NOT IN ('terminal', 'terminal_failed')
	  );

	INSERT INTO entity_lifecycle_recovery_owners (
		owner_user_id, due_at, lease_token, lease_expires_at, updated_at
	)
SELECT
	owner_user_id,
	COALESCE(next_retry_at, updated_at),
	NULL,
	NULL,
	NEW.updated_at
FROM entity_lifecycle_operations
WHERE owner_user_id = NEW.owner_user_id
  AND phase NOT IN ('terminal', 'terminal_failed')
ORDER BY COALESCE(next_retry_at, updated_at) ASC, operation_id ASC
LIMIT 1
ON CONFLICT(owner_user_id) DO UPDATE SET
		due_at = excluded.due_at,
		lease_token = NULL,
		lease_expires_at = NULL,
		updated_at = excluded.updated_at;
END;

CREATE TRIGGER entity_lifecycle_recovery_after_delete
AFTER DELETE ON entity_lifecycle_operations
-- Bounded terminal-history cleanup must not refresh this projection: doing so
-- would clear an active poison-owner lease even though canonical nonterminal
-- state did not change. Deleting a genuinely nonterminal operation still
-- re-derives or removes the owner row below.
WHEN OLD.phase NOT IN ('terminal', 'terminal_failed')
BEGIN
	DELETE FROM entity_lifecycle_recovery_owners
	WHERE owner_user_id = OLD.owner_user_id
	  AND NOT EXISTS (
		SELECT 1
		FROM entity_lifecycle_operations
		WHERE owner_user_id = OLD.owner_user_id
		  AND phase NOT IN ('terminal', 'terminal_failed')
	  );

	INSERT INTO entity_lifecycle_recovery_owners (
		owner_user_id, due_at, lease_token, lease_expires_at, updated_at
	)
SELECT
	owner_user_id,
	COALESCE(next_retry_at, updated_at),
	NULL,
	NULL,
	OLD.updated_at
FROM entity_lifecycle_operations
WHERE owner_user_id = OLD.owner_user_id
  AND phase NOT IN ('terminal', 'terminal_failed')
ORDER BY COALESCE(next_retry_at, updated_at) ASC, operation_id ASC
LIMIT 1
ON CONFLICT(owner_user_id) DO UPDATE SET
		due_at = excluded.due_at,
		lease_token = NULL,
		lease_expires_at = NULL,
		updated_at = excluded.updated_at;
END;
