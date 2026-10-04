-- These indexes use immutable keys. They add no records or retention policy.
CREATE INDEX bots_index_owner_creation_page
    ON bots_index(owner_user_id, created_at DESC, bot_id ASC)
    WHERE deleted_at IS NULL AND lifecycle_state = 'active';
CREATE INDEX bots_index_world_creation_page
    ON bots_index(home_world_id, created_at DESC, bot_id ASC)
    WHERE deleted_at IS NULL AND lifecycle_state = 'active';
CREATE INDEX worlds_index_creation_page
    ON worlds_index(created_at DESC, world_id ASC)
    WHERE deleted_at IS NULL AND lifecycle_state = 'active';
CREATE INDEX worlds_index_owner_creation_page
    ON worlds_index(created_by_user_id, created_at DESC, world_id ASC)
    WHERE deleted_at IS NULL AND lifecycle_state = 'active';
CREATE INDEX bot_groups_creation_page
    ON bot_groups(world_id, owner_user_id, created_at DESC, group_id ASC)
    WHERE deleted_at IS NULL;
