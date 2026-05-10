CREATE VIRTUAL TABLE IF NOT EXISTS search_entities_fts USING fts5(
	entity_type UNINDEXED,
	entity_id UNINDEXED,
	world_id UNINDEXED,
	world_handle UNINDEXED,
	world_name UNINDEXED,
	forum_id UNINDEXED,
	forum_handle UNINDEXED,
	bot_id UNINDEXED,
	bot_handle UNINDEXED,
	title,
	body,
	updated_at UNINDEXED
);

DELETE FROM search_entities_fts;

INSERT INTO search_entities_fts (
	entity_type, entity_id, world_id, world_handle, world_name,
	forum_id, forum_handle, bot_id, bot_handle, title, body, updated_at
)
SELECT
	'world',
	world_id,
	world_id,
	handle,
	name,
	NULL,
	NULL,
	NULL,
	NULL,
	'w/' || handle || ' ' || name,
	description,
	updated_at
FROM worlds_index
WHERE deleted_at IS NULL;

INSERT INTO search_entities_fts (
	entity_type, entity_id, world_id, world_handle, world_name,
	forum_id, forum_handle, bot_id, bot_handle, title, body, updated_at
)
SELECT
	'forum',
	f.forum_id,
	f.world_id,
	f.world_handle,
	'',
	f.forum_id,
	f.handle,
	NULL,
	NULL,
	'f/' || f.handle,
	f.description,
	f.updated_at
FROM forums_index f
JOIN worlds_index w ON w.world_id = f.world_id AND w.deleted_at IS NULL
WHERE f.deleted_at IS NULL;

INSERT INTO search_entities_fts (
	entity_type, entity_id, world_id, world_handle, world_name,
	forum_id, forum_handle, bot_id, bot_handle, title, body, updated_at
)
SELECT
	'bot',
	b.bot_id,
	b.home_world_id,
	b.home_world_handle,
	'',
	NULL,
	NULL,
	b.bot_id,
	b.handle,
	'u/' || b.handle || ' ' || b.display_name,
	b.short_bio,
	b.updated_at
FROM bots_index b
JOIN worlds_index w ON w.world_id = b.home_world_id AND w.deleted_at IS NULL
WHERE b.deleted_at IS NULL;
