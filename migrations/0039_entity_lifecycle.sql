-- Existing rows predate the lifecycle writer and are active by definition.
-- New managed entities are inserted as pending and become visible only in the
-- same D1 activation batch that completes their lifecycle operation.
ALTER TABLE users_index
	ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
	CHECK (lifecycle_state IN ('pending', 'active', 'deleting'));

ALTER TABLE worlds_index
	ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
	CHECK (lifecycle_state IN ('pending', 'active', 'deleting'));

ALTER TABLE bots_index
	ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
	CHECK (lifecycle_state IN ('pending', 'active', 'deleting'));

CREATE INDEX users_index_public_lifecycle
	ON users_index (lifecycle_state, deleted_at, updated_at);

CREATE INDEX worlds_index_public_lifecycle
	ON worlds_index (lifecycle_state, deleted_at, updated_at);

CREATE INDEX bots_index_owner_lifecycle
	ON bots_index (owner_user_id, lifecycle_state, deleted_at, updated_at);

CREATE INDEX bots_index_world_lifecycle
	ON bots_index (home_world_id, lifecycle_state, deleted_at, handle);

-- Exactly one bounded control row is retained for the environment lifetime.
-- Phase 3 changes activation_mode only while maintenance is enabled, then
-- supplies fixed-configuration statements to the existing activation batches.
CREATE TABLE entity_lifecycle_control (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	activation_mode TEXT NOT NULL
		CHECK (activation_mode IN ('legacy_compatible', 'inference_graph_required')),
	updated_at TEXT NOT NULL
);

INSERT INTO entity_lifecycle_control (id, activation_mode, updated_at)
VALUES (1, 'legacy_compatible', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- One row lives for a managed entity's active lifetime and is hard-deleted
-- after successful deletion or terminal create compensation. It is canonical
-- lifecycle state, not an audit log; no reader repairs it from index shape.
CREATE TABLE entity_lifecycle_entities (
	entity_kind TEXT NOT NULL CHECK (entity_kind IN ('account', 'world', 'bot')),
	entity_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	phase TEXT NOT NULL CHECK (
		phase IN ('pending', 'materializing', 'active', 'deleting', 'compensating', 'terminal_failed')
	),
	revision INTEGER NOT NULL CHECK (revision > 0),
	active_operation_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (entity_kind, entity_id)
);

CREATE INDEX entity_lifecycle_entities_owner_phase
	ON entity_lifecycle_entities (owner_user_id, phase, updated_at, entity_kind, entity_id);

-- Nonterminal operations are retained until they converge. Terminal and
-- terminal-failed rows retain only secret-free request identity/failure data
-- for 30 days, then bounded cleanup deletes them through terminal_cleanup_at.
-- request_json is cleared before either terminal state is committed.
CREATE TABLE entity_lifecycle_operations (
	operation_id TEXT PRIMARY KEY,
	owner_user_id TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	request_json TEXT,
	entity_kind TEXT NOT NULL CHECK (entity_kind IN ('account', 'world', 'bot')),
	entity_id TEXT NOT NULL,
	action TEXT NOT NULL CHECK (action IN ('create', 'delete')),
	phase TEXT NOT NULL CHECK (
		phase IN ('pending', 'materializing', 'active', 'deleting', 'compensating', 'terminal', 'terminal_failed')
	),
	revision INTEGER NOT NULL CHECK (revision > 0),
	retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
	next_retry_at TEXT,
	failure_category TEXT CHECK (
		failure_category IS NULL OR failure_category IN (
			'validation', 'conflict', 'forbidden', 'not_found',
			'external_retryable', 'external_terminal', 'retry_exhausted', 'internal'
		)
	),
	failure_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	terminal_at TEXT,
	terminal_cleanup_at TEXT,
	UNIQUE (owner_user_id, idempotency_key)
);

CREATE INDEX entity_lifecycle_operations_owner_phase
	ON entity_lifecycle_operations (owner_user_id, phase, next_retry_at, updated_at, operation_id);

CREATE INDEX entity_lifecycle_operations_terminal_cleanup
	ON entity_lifecycle_operations (terminal_cleanup_at, operation_id)
	WHERE terminal_cleanup_at IS NOT NULL;

CREATE INDEX entity_lifecycle_operations_entity
	ON entity_lifecycle_operations (entity_kind, entity_id, created_at, operation_id);

-- Credential material used only while a create is being materialized is kept
-- out of request_json. These rows exist only for a nonterminal operation and
-- are hard-deleted in the same activation/compensation batch that terminates
-- that operation. Phase 3 replaces this bridge with configuration secrets;
-- it must not add another lifecycle-owned credential store.
CREATE TABLE entity_lifecycle_secrets (
	operation_id TEXT NOT NULL,
	secret_kind TEXT NOT NULL CHECK (secret_kind IN ('bot_openrouter_api_key')),
	secret_value TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY (operation_id) REFERENCES entity_lifecycle_operations(operation_id) ON DELETE CASCADE,
	PRIMARY KEY (operation_id, secret_kind)
);

-- Pending reservations and active identities share this one uniqueness
-- namespace. Claims live for an active entity's lifetime and are hard-deleted
-- on entity deletion; pending claims live only until activation/compensation.
-- There is no retained claim history.
CREATE TABLE entity_lifecycle_identity_claims (
	key_kind TEXT NOT NULL CHECK (key_kind IN ('provider_subject', 'user_handle', 'world_handle', 'bot_handle')),
	key_scope TEXT NOT NULL,
	key_value TEXT NOT NULL,
	entity_kind TEXT NOT NULL CHECK (entity_kind IN ('account', 'world', 'bot')),
	entity_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	claim_state TEXT NOT NULL CHECK (claim_state IN ('pending', 'active')),
	operation_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (operation_id) REFERENCES entity_lifecycle_operations(operation_id) ON DELETE CASCADE,
	CHECK (
		(claim_state = 'pending' AND operation_id IS NOT NULL) OR
		(claim_state = 'active' AND operation_id IS NULL)
	),
	PRIMARY KEY (key_kind, key_scope, key_value)
);

CREATE INDEX entity_lifecycle_identity_claims_entity
	ON entity_lifecycle_identity_claims (entity_kind, entity_id, key_kind);

INSERT INTO entity_lifecycle_identity_claims (
	key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
	claim_state, operation_id, created_at, updated_at
)
SELECT 'user_handle', 'global', handle, 'account', user_id, user_id,
	'active', NULL, created_at, updated_at
FROM users_index
WHERE deleted_at IS NULL;

INSERT INTO entity_lifecycle_identity_claims (
	key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
	claim_state, operation_id, created_at, updated_at
)
SELECT 'world_handle', 'global', handle, 'world', world_id, created_by_user_id,
	'active', NULL, created_at, updated_at
FROM worlds_index
WHERE deleted_at IS NULL;

INSERT INTO entity_lifecycle_identity_claims (
	key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
	claim_state, operation_id, created_at, updated_at
)
SELECT 'bot_handle', home_world_id, handle, 'bot', bot_id, owner_user_id,
	'active', NULL, created_at, updated_at
FROM bots_index
WHERE deleted_at IS NULL;

INSERT INTO entity_lifecycle_identity_claims (
	key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
	claim_state, operation_id, created_at, updated_at
)
SELECT 'provider_subject', provider, provider_subject, 'account', user_id, user_id,
	'active', NULL, created_at, updated_at
FROM provider_identities;

-- These guards make the claim table authoritative even if a future internal
-- writer bypasses the typed coordinator capability. Normal writers create the
-- matching claim in the same D1 batch before changing the projection.
CREATE TRIGGER users_index_requires_identity_claim_insert
BEFORE INSERT ON users_index
WHEN NEW.deleted_at IS NULL
AND NOT EXISTS (
	SELECT 1 FROM entity_lifecycle_identity_claims
	WHERE key_kind = 'user_handle' AND key_scope = 'global'
	  AND key_value = NEW.handle AND entity_kind = 'account' AND entity_id = NEW.user_id
	  AND claim_state = CASE NEW.lifecycle_state WHEN 'pending' THEN 'pending' ELSE 'active' END
)
BEGIN
	SELECT RAISE(ABORT, 'canonical user handle claim required');
END;

CREATE TRIGGER users_index_requires_identity_claim_update
BEFORE UPDATE OF handle, deleted_at, lifecycle_state ON users_index
WHEN NEW.deleted_at IS NULL AND NOT EXISTS (
	SELECT 1 FROM entity_lifecycle_identity_claims
	WHERE key_kind = 'user_handle' AND key_scope = 'global'
	  AND key_value = NEW.handle AND entity_kind = 'account' AND entity_id = NEW.user_id
	  AND claim_state = CASE NEW.lifecycle_state WHEN 'pending' THEN 'pending' ELSE 'active' END
)
BEGIN
	SELECT RAISE(ABORT, 'canonical user handle claim required');
END;

CREATE TRIGGER worlds_index_requires_identity_claim_insert
BEFORE INSERT ON worlds_index
WHEN NEW.deleted_at IS NULL
AND NOT EXISTS (
	SELECT 1 FROM entity_lifecycle_identity_claims
	WHERE key_kind = 'world_handle' AND key_scope = 'global'
	  AND key_value = NEW.handle AND entity_kind = 'world' AND entity_id = NEW.world_id
	  AND claim_state = CASE NEW.lifecycle_state WHEN 'pending' THEN 'pending' ELSE 'active' END
)
BEGIN
	SELECT RAISE(ABORT, 'canonical world handle claim required');
END;

CREATE TRIGGER worlds_index_requires_identity_claim_update
BEFORE UPDATE OF handle, deleted_at, lifecycle_state ON worlds_index
WHEN NEW.deleted_at IS NULL AND NOT EXISTS (
	SELECT 1 FROM entity_lifecycle_identity_claims
	WHERE key_kind = 'world_handle' AND key_scope = 'global'
	  AND key_value = NEW.handle AND entity_kind = 'world' AND entity_id = NEW.world_id
	  AND claim_state = CASE NEW.lifecycle_state WHEN 'pending' THEN 'pending' ELSE 'active' END
)
BEGIN
	SELECT RAISE(ABORT, 'canonical world handle claim required');
END;

CREATE TRIGGER bots_index_requires_identity_claim_insert
BEFORE INSERT ON bots_index
WHEN NEW.deleted_at IS NULL
AND NOT EXISTS (
	SELECT 1 FROM entity_lifecycle_identity_claims
	WHERE key_kind = 'bot_handle' AND key_scope = NEW.home_world_id
	  AND key_value = NEW.handle AND entity_kind = 'bot' AND entity_id = NEW.bot_id
	  AND claim_state = CASE NEW.lifecycle_state WHEN 'pending' THEN 'pending' ELSE 'active' END
)
BEGIN
	SELECT RAISE(ABORT, 'canonical bot handle claim required');
END;

CREATE TRIGGER bots_index_requires_identity_claim_update
BEFORE UPDATE OF handle, home_world_id, deleted_at, lifecycle_state ON bots_index
WHEN NEW.deleted_at IS NULL AND NOT EXISTS (
	SELECT 1 FROM entity_lifecycle_identity_claims
	WHERE key_kind = 'bot_handle' AND key_scope = NEW.home_world_id
	  AND key_value = NEW.handle AND entity_kind = 'bot' AND entity_id = NEW.bot_id
	  AND claim_state = CASE NEW.lifecycle_state WHEN 'pending' THEN 'pending' ELSE 'active' END
)
BEGIN
	SELECT RAISE(ABORT, 'canonical bot handle claim required');
END;

CREATE TRIGGER provider_identities_requires_identity_claim_insert
BEFORE INSERT ON provider_identities
WHEN NOT EXISTS (
	SELECT 1 FROM entity_lifecycle_identity_claims
	WHERE key_kind = 'provider_subject' AND key_scope = NEW.provider
	  AND key_value = NEW.provider_subject AND entity_kind = 'account' AND entity_id = NEW.user_id
)
BEGIN
	SELECT RAISE(ABORT, 'canonical provider subject claim required');
END;

CREATE TRIGGER provider_identities_requires_identity_claim_update
BEFORE UPDATE OF provider, provider_subject, user_id ON provider_identities
WHEN NOT EXISTS (
	SELECT 1 FROM entity_lifecycle_identity_claims
	WHERE key_kind = 'provider_subject' AND key_scope = NEW.provider
	  AND key_value = NEW.provider_subject AND entity_kind = 'account' AND entity_id = NEW.user_id
)
BEGIN
	SELECT RAISE(ABORT, 'canonical provider subject claim required');
END;

CREATE TRIGGER identity_claim_key_is_immutable
BEFORE UPDATE OF key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id
ON entity_lifecycle_identity_claims
BEGIN
	SELECT RAISE(ABORT, 'canonical identity claim key is immutable');
END;

CREATE TRIGGER live_identity_claim_cannot_be_released
BEFORE DELETE ON entity_lifecycle_identity_claims
WHEN OLD.claim_state = 'active' AND (
	(OLD.key_kind = 'user_handle' AND EXISTS (
		SELECT 1 FROM users_index
		WHERE user_id = OLD.entity_id AND handle = OLD.key_value AND deleted_at IS NULL
	)) OR
	(OLD.key_kind = 'world_handle' AND EXISTS (
		SELECT 1 FROM worlds_index
		WHERE world_id = OLD.entity_id AND handle = OLD.key_value AND deleted_at IS NULL
	)) OR
	(OLD.key_kind = 'bot_handle' AND EXISTS (
		SELECT 1 FROM bots_index
		WHERE bot_id = OLD.entity_id AND home_world_id = OLD.key_scope
		  AND handle = OLD.key_value AND deleted_at IS NULL
	)) OR
	(OLD.key_kind = 'provider_subject' AND EXISTS (
		SELECT 1 FROM provider_identities
		WHERE user_id = OLD.entity_id AND provider = OLD.key_scope
		  AND provider_subject = OLD.key_value
	))
)
BEGIN
	SELECT RAISE(ABORT, 'live canonical identity claim cannot be released');
END;
