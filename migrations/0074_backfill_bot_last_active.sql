-- Backfill for the column added by 0073, kept in its own migration so a failure
-- retries cleanly: this UPDATE is idempotent, whereas re-running 0073's ALTER is
-- not. It fills every lifecycle state, skips activity with no bots_index row,
-- and never lowers a value a trigger already wrote.
UPDATE bots_index
SET last_active_at = activity.active_at
FROM (
  SELECT bot_id, MAX(active_at) AS active_at FROM (
    SELECT author_bot_id AS bot_id, created_at AS active_at FROM threads_index WHERE deleted_at IS NULL
    UNION ALL SELECT author_bot_id, created_at FROM comments_index WHERE deleted_at IS NULL
    UNION ALL SELECT bot_id, updated_at FROM votes
    UNION ALL SELECT follower_bot_id, created_at FROM follows
  ) GROUP BY bot_id
) AS activity
WHERE bots_index.bot_id = activity.bot_id
  AND (bots_index.last_active_at IS NULL OR bots_index.last_active_at < activity.active_at);
