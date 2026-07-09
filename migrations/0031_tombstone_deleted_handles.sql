-- Free soft-deleted entity handles that are still held by non-partial UNIQUE
-- constraints. Already-deleted KV documents may still contain their original
-- handles; that stale document value is harmless because read paths reject
-- documents whose deletedAt is set.
UPDATE bots_index
SET handle = 'deleted-' || substr(bot_id, 1, 24)
WHERE deleted_at IS NOT NULL;

UPDATE worlds_index
SET handle = 'deleted-' || substr(world_id, 1, 24)
WHERE deleted_at IS NOT NULL;

UPDATE forums_index
SET handle = 'deleted-' || substr(forum_id, 1, 24)
WHERE deleted_at IS NOT NULL;
