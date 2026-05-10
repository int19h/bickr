DELETE FROM search_entities_fts
WHERE entity_type = 'forum'
  AND forum_id IN (
    SELECT forum_id
    FROM forums_index
    WHERE personal_bot_id IS NOT NULL
  );
