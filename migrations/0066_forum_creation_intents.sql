-- Pending creations retain their document until the owning world coordinator
-- publishes KV and activates all D1 projections atomically. Completed/cancelled
-- receipts retain only request/result identities for 30 days; indexed cleanup
-- removes at most 100 receipts per recovery run. Pending work never expires.
CREATE TABLE forum_creation_intents (
    forum_id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    request_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    document_json TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'cancelled')),
    next_attempt_at TEXT NOT NULL,
    expires_at TEXT,
    UNIQUE(owner_user_id, request_key),
    CHECK ((state = 'pending' AND document_json IS NOT NULL AND expires_at IS NULL)
        OR (state <> 'pending' AND document_json IS NULL AND expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX forum_creation_pending_handle ON forum_creation_intents(world_id, handle) WHERE state = 'pending';
CREATE INDEX forum_creation_due ON forum_creation_intents(next_attempt_at, forum_id) WHERE state = 'pending';
CREATE INDEX forum_creation_expiry ON forum_creation_intents(expires_at, forum_id) WHERE expires_at IS NOT NULL;

-- This check shares the activation batch with every projection and its receipt.
-- An account may start deletion while the world writer awaits KV. That account
-- cannot publish a new forum after its lifecycle visibility fence has committed.
CREATE TRIGGER forum_creation_requires_active_parents
BEFORE INSERT ON forums_index
WHEN EXISTS (SELECT 1 FROM forum_creation_intents WHERE forum_id = NEW.forum_id AND state = 'pending')
AND (NOT EXISTS (SELECT 1 FROM users_index WHERE user_id = NEW.created_by_user_id AND lifecycle_state = 'active' AND deleted_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM worlds_index WHERE world_id = NEW.world_id AND lifecycle_state = 'active' AND deleted_at IS NULL))
BEGIN
    SELECT RAISE(ABORT, 'forum creation requires active parents');
END;
