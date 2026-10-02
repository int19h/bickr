-- Derived substring tokens have the same retention as their source projection.
-- Application projection writers generate short tokens in one linear pass. This
-- migration does not tokenize historical text: an indexed, bounded sweep fills
-- NULL markers after deployment. Search is unavailable until that sweep finishes.
ALTER TABLE threads_index ADD COLUMN search_short_tokens TEXT;
ALTER TABLE comments_index ADD COLUMN search_short_tokens TEXT;
CREATE INDEX thread_search_pending ON threads_index(thread_id) WHERE search_short_tokens IS NULL AND deleted_at IS NULL;
CREATE INDEX comment_search_pending ON comments_index(comment_id) WHERE search_short_tokens IS NULL AND deleted_at IS NULL AND is_root = 0;

CREATE VIRTUAL TABLE thread_search_trigrams USING fts5(
    search_text, tokenize='trigram', content='', contentless_delete=1
);
CREATE VIRTUAL TABLE thread_search_short USING fts5(
    grams, content='', contentless_delete=1, detail=none
);
CREATE TRIGGER thread_search_insert AFTER INSERT ON threads_index BEGIN
    INSERT INTO thread_search_trigrams(rowid, search_text)
        SELECT new.rowid, lower(new.search_text) WHERE new.deleted_at IS NULL AND new.search_short_tokens IS NOT NULL;
    INSERT INTO thread_search_short(rowid, grams)
        SELECT new.rowid, new.search_short_tokens WHERE new.deleted_at IS NULL AND new.search_short_tokens IS NOT NULL;
END;
CREATE TRIGGER thread_search_update AFTER UPDATE OF search_text, search_short_tokens, deleted_at ON threads_index
WHEN new.search_text IS NOT old.search_text OR new.search_short_tokens IS NOT old.search_short_tokens OR new.deleted_at IS NOT old.deleted_at BEGIN
    DELETE FROM thread_search_trigrams WHERE rowid = old.rowid;
    DELETE FROM thread_search_short WHERE rowid = old.rowid;
    INSERT INTO thread_search_trigrams(rowid, search_text)
        SELECT new.rowid, lower(new.search_text) WHERE new.deleted_at IS NULL AND new.search_short_tokens IS NOT NULL;
    INSERT INTO thread_search_short(rowid, grams)
        SELECT new.rowid, new.search_short_tokens WHERE new.deleted_at IS NULL AND new.search_short_tokens IS NOT NULL;
END;
CREATE TRIGGER thread_search_delete AFTER DELETE ON threads_index BEGIN
    DELETE FROM thread_search_trigrams WHERE rowid = old.rowid;
    DELETE FROM thread_search_short WHERE rowid = old.rowid;
END;

CREATE VIRTUAL TABLE comment_search_trigrams USING fts5(
    search_text, tokenize='trigram', content='', contentless_delete=1
);
CREATE VIRTUAL TABLE comment_search_short USING fts5(
    grams, content='', contentless_delete=1, detail=none
);
CREATE TRIGGER comment_search_insert AFTER INSERT ON comments_index BEGIN
    INSERT INTO comment_search_trigrams(rowid, search_text)
        SELECT new.rowid, lower(new.search_text) WHERE new.deleted_at IS NULL AND new.is_root = 0 AND new.search_short_tokens IS NOT NULL;
    INSERT INTO comment_search_short(rowid, grams)
        SELECT new.rowid, new.search_short_tokens WHERE new.deleted_at IS NULL AND new.is_root = 0 AND new.search_short_tokens IS NOT NULL;
END;
CREATE TRIGGER comment_search_update AFTER UPDATE OF search_text, search_short_tokens, deleted_at, is_root ON comments_index
WHEN new.search_text IS NOT old.search_text OR new.search_short_tokens IS NOT old.search_short_tokens OR new.deleted_at IS NOT old.deleted_at OR new.is_root IS NOT old.is_root BEGIN
    DELETE FROM comment_search_trigrams WHERE rowid = old.rowid;
    DELETE FROM comment_search_short WHERE rowid = old.rowid;
    INSERT INTO comment_search_trigrams(rowid, search_text)
        SELECT new.rowid, lower(new.search_text) WHERE new.deleted_at IS NULL AND new.is_root = 0 AND new.search_short_tokens IS NOT NULL;
    INSERT INTO comment_search_short(rowid, grams)
        SELECT new.rowid, new.search_short_tokens WHERE new.deleted_at IS NULL AND new.is_root = 0 AND new.search_short_tokens IS NOT NULL;
END;
CREATE TRIGGER comment_search_delete AFTER DELETE ON comments_index BEGIN
    DELETE FROM comment_search_trigrams WHERE rowid = old.rowid;
    DELETE FROM comment_search_short WHERE rowid = old.rowid;
END;

-- At most one refresh entry per thread. A refresh deletes an entry once no
-- live comment can age out; deleting the thread deletes its entry immediately.
-- This queue is not an event history. Due rows are consumed in indexed batches.
CREATE TABLE thread_hot_refresh (
    thread_id TEXT PRIMARY KEY,
    next_refresh_at TEXT NOT NULL
);
CREATE INDEX thread_hot_refresh_due ON thread_hot_refresh(next_refresh_at, thread_id);

-- One-time seed: old rows are visited in bounded batches after deployment.
INSERT INTO thread_hot_refresh(thread_id, next_refresh_at)
    SELECT thread_id, '0000-01-01T00:00:00.000Z' FROM threads_index WHERE deleted_at IS NULL;

CREATE TRIGGER thread_hot_insert AFTER INSERT ON threads_index
WHEN new.deleted_at IS NULL BEGIN
    INSERT INTO thread_hot_refresh(thread_id, next_refresh_at)
    VALUES (new.thread_id, '0000-01-01T00:00:00.000Z')
    ON CONFLICT(thread_id) DO UPDATE SET next_refresh_at = excluded.next_refresh_at;
END;
CREATE TRIGGER thread_hot_update AFTER UPDATE OF recent_comment_count, deleted_at ON threads_index
WHEN new.recent_comment_count IS NOT old.recent_comment_count OR new.deleted_at IS NOT old.deleted_at BEGIN
    DELETE FROM thread_hot_refresh WHERE thread_id = new.thread_id AND new.deleted_at IS NOT NULL;
    INSERT INTO thread_hot_refresh(thread_id, next_refresh_at)
    SELECT new.thread_id, '0000-01-01T00:00:00.000Z' WHERE new.deleted_at IS NULL
    ON CONFLICT(thread_id) DO UPDATE SET next_refresh_at = excluded.next_refresh_at;
END;
CREATE TRIGGER thread_hot_delete AFTER DELETE ON threads_index BEGIN
    DELETE FROM thread_hot_refresh WHERE thread_id = old.thread_id;
END;
CREATE TRIGGER comment_hot_insert AFTER INSERT ON comments_index BEGIN
    INSERT INTO thread_hot_refresh(thread_id, next_refresh_at)
    VALUES (new.thread_id, '0000-01-01T00:00:00.000Z')
    ON CONFLICT(thread_id) DO UPDATE SET next_refresh_at = excluded.next_refresh_at;
END;
CREATE TRIGGER comment_hot_update AFTER UPDATE OF thread_id, created_at, deleted_at ON comments_index
WHEN new.thread_id IS NOT old.thread_id OR new.created_at IS NOT old.created_at OR new.deleted_at IS NOT old.deleted_at BEGIN
    INSERT INTO thread_hot_refresh(thread_id, next_refresh_at)
    VALUES (old.thread_id, '0000-01-01T00:00:00.000Z'), (new.thread_id, '0000-01-01T00:00:00.000Z')
    ON CONFLICT(thread_id) DO UPDATE SET next_refresh_at = excluded.next_refresh_at;
END;
CREATE TRIGGER comment_hot_delete AFTER DELETE ON comments_index BEGIN
    INSERT INTO thread_hot_refresh(thread_id, next_refresh_at)
    VALUES (old.thread_id, '0000-01-01T00:00:00.000Z')
    ON CONFLICT(thread_id) DO UPDATE SET next_refresh_at = excluded.next_refresh_at;
END;
