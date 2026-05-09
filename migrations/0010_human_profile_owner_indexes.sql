CREATE INDEX IF NOT EXISTS worlds_index_owner
	ON worlds_index (created_by_user_id, deleted_at, handle);

CREATE INDEX IF NOT EXISTS forums_index_owner
	ON forums_index (created_by_user_id, deleted_at, world_handle, handle);
