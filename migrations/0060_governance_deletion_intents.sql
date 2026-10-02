-- One durable intent per deleted world or forum. The coordinator removes the
-- row only after its document projection and every descendant deletion finish.
-- Failed work remains discoverable even if Durable Object storage or alarms
-- fail. Completed tombstones do not retain an intent.
CREATE TABLE governance_deletion_intents (
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('world', 'forum')),
    scope_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    document_json TEXT,
    next_attempt_at TEXT NOT NULL,
    PRIMARY KEY (scope_kind, scope_id)
);
CREATE INDEX governance_deletion_intents_due
    ON governance_deletion_intents (next_attempt_at, scope_kind, scope_id);

-- Recover cascades that older writers could lose after committing a tombstone.
-- NULL documents use the existing KV tombstone once, under the owning writer.
INSERT INTO governance_deletion_intents
    SELECT 'world', world_id, deleted_at, NULL, deleted_at
    FROM worlds_index WHERE deleted_at IS NOT NULL;
INSERT INTO governance_deletion_intents
    SELECT 'forum', forum_id, deleted_at, NULL, deleted_at
    FROM forums_index WHERE deleted_at IS NOT NULL;
