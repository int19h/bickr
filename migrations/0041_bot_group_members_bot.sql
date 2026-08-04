-- Ordinary participant deletion and lifecycle compensation remove every group
-- membership for one participant. The existing keys lead with group/world, so
-- this child cleanup needs its own by-participant lookup on the growing table.
CREATE INDEX bot_group_members_bot
	ON bot_group_members (bot_id);
