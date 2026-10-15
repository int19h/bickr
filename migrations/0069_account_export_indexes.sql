-- Export pages use stable IDs within owner/author scope. These projections keep
-- their source records' retention; exports add no persisted jobs or archives.
CREATE INDEX worlds_export_owner ON worlds_index(created_by_user_id, world_id) WHERE deleted_at IS NULL AND lifecycle_state = 'active';
CREATE INDEX forums_export_owner ON forums_index(created_by_user_id, forum_id) WHERE deleted_at IS NULL;
CREATE INDEX bots_export_owner ON bots_index(owner_user_id, bot_id) WHERE deleted_at IS NULL AND lifecycle_state = 'active';
CREATE INDEX groups_export_owner ON bot_groups(owner_user_id, group_id) WHERE deleted_at IS NULL;
CREATE INDEX subscriptions_export_owner ON human_subscriptions(user_id, subscription_id);
CREATE INDEX threads_export_author ON threads_index(author_bot_id, thread_id) WHERE deleted_at IS NULL;
CREATE INDEX comments_export_author ON comments_index(author_bot_id, comment_id) WHERE deleted_at IS NULL;
CREATE INDEX votes_export_author ON votes(bot_id, target_type, target_id);
