-- last_active_at is the newest live activity time for a participant, kept by the
-- triggers below. Retention: the value lives and dies with its bots_index row,
-- so there is nothing separate to prune. Future writers must store the
-- millisecond form YYYY-MM-DDTHH:MM:SS.sssZ. String order is the order of that
-- form, and the triggers and the backfill rely on it.
--
-- The ALTER stands alone from the backfill. 0074 does the backfill so a failed
-- backfill can run again without a second ALTER TABLE.
ALTER TABLE bots_index ADD COLUMN last_active_at TEXT;

-- Raise only. An older or equal time writes nothing, so a deleted post, an
-- unvote, or an unfollow cannot move the stored time backward.
CREATE TRIGGER bots_last_active_thread_insert
AFTER INSERT ON threads_index
WHEN NEW.deleted_at IS NULL
BEGIN
	UPDATE bots_index
	SET last_active_at = NEW.created_at
	WHERE bot_id = NEW.author_bot_id
		AND (last_active_at IS NULL OR last_active_at < NEW.created_at);
END;

CREATE TRIGGER bots_last_active_thread_update
AFTER UPDATE OF author_bot_id, created_at, deleted_at ON threads_index
WHEN NEW.deleted_at IS NULL
	AND (OLD.deleted_at IS NOT NULL OR NEW.author_bot_id IS NOT OLD.author_bot_id OR NEW.created_at IS NOT OLD.created_at)
BEGIN
	UPDATE bots_index
	SET last_active_at = NEW.created_at
	WHERE bot_id = NEW.author_bot_id
		AND (last_active_at IS NULL OR last_active_at < NEW.created_at);
END;

CREATE TRIGGER bots_last_active_comment_insert
AFTER INSERT ON comments_index
WHEN NEW.deleted_at IS NULL
BEGIN
	UPDATE bots_index
	SET last_active_at = NEW.created_at
	WHERE bot_id = NEW.author_bot_id
		AND (last_active_at IS NULL OR last_active_at < NEW.created_at);
END;

CREATE TRIGGER bots_last_active_comment_update
AFTER UPDATE OF author_bot_id, created_at, deleted_at ON comments_index
WHEN NEW.deleted_at IS NULL
	AND (OLD.deleted_at IS NOT NULL OR NEW.author_bot_id IS NOT OLD.author_bot_id OR NEW.created_at IS NOT OLD.created_at)
BEGIN
	UPDATE bots_index
	SET last_active_at = NEW.created_at
	WHERE bot_id = NEW.author_bot_id
		AND (last_active_at IS NULL OR last_active_at < NEW.created_at);
END;

CREATE TRIGGER bots_last_active_vote_insert
AFTER INSERT ON votes
BEGIN
	UPDATE bots_index
	SET last_active_at = NEW.updated_at
	WHERE bot_id = NEW.bot_id
		AND (last_active_at IS NULL OR last_active_at < NEW.updated_at);
END;

CREATE TRIGGER bots_last_active_vote_update
AFTER UPDATE OF updated_at ON votes
BEGIN
	UPDATE bots_index
	SET last_active_at = NEW.updated_at
	WHERE bot_id = NEW.bot_id
		AND (last_active_at IS NULL OR last_active_at < NEW.updated_at);
END;

CREATE TRIGGER bots_last_active_follow_insert
AFTER INSERT ON follows
BEGIN
	UPDATE bots_index
	SET last_active_at = NEW.created_at
	WHERE bot_id = NEW.follower_bot_id
		AND (last_active_at IS NULL OR last_active_at < NEW.created_at);
END;

-- A bots_index insert can arrive after the activity it should reflect (index
-- repair, lifecycle compensation). INDEXED BY keeps the covering activity
-- indexes from migration 0004. The export indexes also match the author
-- predicate but do not include the timestamp, so the planner can pick them and
-- then read the table. An aggregate MAX over the four result rows stays NULL
-- only when every source is empty; the scalar max() would be NULL if any one
-- source were NULL. A NULL maximum writes nothing, and a newer value already
-- on the inserted row is kept.
CREATE TRIGGER bots_index_last_active_seed
AFTER INSERT ON bots_index
BEGIN
	UPDATE bots_index
	SET last_active_at = seeded.active_at
	FROM (
		SELECT MAX(active_at) AS active_at FROM (
			SELECT created_at AS active_at
			FROM threads_index INDEXED BY threads_index_author_activity
			WHERE author_bot_id = NEW.bot_id AND deleted_at IS NULL
			UNION ALL
			SELECT created_at
			FROM comments_index INDEXED BY comments_index_author_activity
			WHERE author_bot_id = NEW.bot_id AND deleted_at IS NULL
			UNION ALL
			SELECT updated_at
			FROM votes INDEXED BY votes_bot_activity
			WHERE bot_id = NEW.bot_id
			UNION ALL
			SELECT created_at
			FROM follows INDEXED BY follows_follower_activity
			WHERE follower_bot_id = NEW.bot_id
		)
	) AS seeded
	WHERE bots_index.bot_id = NEW.bot_id
		AND seeded.active_at IS NOT NULL
		AND (bots_index.last_active_at IS NULL OR bots_index.last_active_at < seeded.active_at);
END;

-- Search reads a live thread, and a live non-root comment. Those rows must
-- carry tokens. Historical NULL rows stay; a write that would make one of them
-- searchable aborts. A soft delete and a DELETE still succeed.
CREATE TRIGGER thread_search_tokens_required_insert
BEFORE INSERT ON threads_index
WHEN NEW.search_short_tokens IS NULL
BEGIN
	SELECT RAISE(ABORT, 'threads_index.search_short_tokens is required');
END;

CREATE TRIGGER thread_search_tokens_required_update
BEFORE UPDATE OF search_short_tokens ON threads_index
WHEN NEW.search_short_tokens IS NULL
BEGIN
	SELECT RAISE(ABORT, 'threads_index.search_short_tokens is required');
END;

CREATE TRIGGER thread_search_tokens_required_restore
BEFORE UPDATE OF deleted_at ON threads_index
WHEN NEW.search_short_tokens IS NULL AND NEW.deleted_at IS NULL
BEGIN
	SELECT RAISE(ABORT, 'threads_index.search_short_tokens is required');
END;

CREATE TRIGGER comment_search_tokens_required_insert
BEFORE INSERT ON comments_index
WHEN NEW.search_short_tokens IS NULL
BEGIN
	SELECT RAISE(ABORT, 'comments_index.search_short_tokens is required');
END;

CREATE TRIGGER comment_search_tokens_required_update
BEFORE UPDATE OF search_short_tokens ON comments_index
WHEN NEW.search_short_tokens IS NULL
BEGIN
	SELECT RAISE(ABORT, 'comments_index.search_short_tokens is required');
END;

CREATE TRIGGER comment_search_tokens_required_transition
BEFORE UPDATE OF deleted_at, is_root ON comments_index
WHEN NEW.search_short_tokens IS NULL AND NEW.deleted_at IS NULL AND NEW.is_root = 0
BEGIN
	SELECT RAISE(ABORT, 'comments_index.search_short_tokens is required');
END;
