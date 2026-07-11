-- Activity events have treated a thread vote as a vote on its root comment since
-- the root-comment migration, so historical thread rows must use that same target.
WITH normalized_votes AS (
	SELECT
		v.world_id,
		v.bot_id,
		v.value,
		v.updated_at,
		CASE v.target_type
			WHEN 'thread' THEN t.root_comment_id
			WHEN 'comment' THEN v.target_id
		END AS comment_id
	FROM votes v
	LEFT JOIN threads_index t
		ON v.target_type = 'thread'
		AND t.thread_id = v.target_id
)
INSERT OR IGNORE INTO bot_activity_events (
	activity_id,
	world_id,
	bot_id,
	activity_type,
	target_type,
	target_id,
	value,
	reason,
	reason_lang,
	created_at
)
SELECT
	'vote:' || bot_id || ':comment:' || comment_id,
	world_id,
	bot_id,
	'vote',
	'comment',
	comment_id,
	value,
	NULL,
	NULL,
	updated_at
FROM normalized_votes
WHERE comment_id IS NOT NULL;
