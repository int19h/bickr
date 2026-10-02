-- Search indexes are derived data. Insert/update/delete triggers keep them in
-- the same transaction as their source row. Soft deletion removes index entries;
-- hard deletion removes them too. They retain no text after the source is gone.
-- Trigrams preserve substring matching for >=3 Unicode characters. The compact
-- short-token index supports the existing two-character queries and single
-- supplementary-plane characters (two UTF-16 code units in JavaScript).
-- Contentless-delete tables avoid a second stored copy of the source text.

CREATE VIRTUAL TABLE thread_search_trigrams USING fts5(
    search_text, tokenize='trigram', content='', contentless_delete=1
);
CREATE VIRTUAL TABLE thread_search_short USING fts5(
    grams, content='', contentless_delete=1, detail=none
);

-- UTF-8 lead bytes give each character's byte width. BLOB substr uses byte
-- offsets, so this walk is linear; TEXT substr would rescan all preceding
-- Unicode characters for every token. Materialize the lowered source once.
-- This view stores no data. Its rowid predicate selects one source row on writes.
CREATE VIEW thread_search_short_source AS
SELECT rowid, (
    WITH RECURSIVE source(bytes, size) AS MATERIALIZED (
        SELECT CAST(lower(search_text) AS BLOB), length(CAST(search_text AS BLOB))
    ), positions(i, width) AS (
        SELECT 1, CASE WHEN substr(bytes, 1, 1) < x'80' THEN 1 WHEN substr(bytes, 1, 1) < x'E0' THEN 2 WHEN substr(bytes, 1, 1) < x'F0' THEN 3 ELSE 4 END FROM source WHERE size > 0
        UNION ALL
        SELECT i + width, CASE WHEN substr(bytes, i + width, 1) < x'80' THEN 1 WHEN substr(bytes, i + width, 1) < x'E0' THEN 2 WHEN substr(bytes, i + width, 1) < x'F0' THEN 3 ELSE 4 END
        FROM positions, source WHERE i + width <= size
    )
    SELECT coalesce(group_concat(
        'x' || hex(substr(bytes, i, width)) || ' x' ||
        hex(substr(bytes, i, width + (CASE WHEN substr(bytes, i + width, 1) < x'80' THEN 1 WHEN substr(bytes, i + width, 1) < x'E0' THEN 2 WHEN substr(bytes, i + width, 1) < x'F0' THEN 3 ELSE 4 END))), ' '
    ), '') FROM positions, source
) AS grams FROM threads_index WHERE deleted_at IS NULL;

INSERT INTO thread_search_trigrams(rowid, search_text)
    SELECT rowid, lower(search_text) FROM threads_index WHERE deleted_at IS NULL;
INSERT INTO thread_search_short(rowid, grams)
    SELECT rowid, grams FROM thread_search_short_source;

CREATE TRIGGER thread_search_insert AFTER INSERT ON threads_index BEGIN
    INSERT INTO thread_search_trigrams(rowid, search_text)
        SELECT new.rowid, lower(new.search_text) WHERE new.deleted_at IS NULL;
    INSERT INTO thread_search_short(rowid, grams)
        SELECT rowid, grams FROM thread_search_short_source WHERE rowid = new.rowid;
END;
CREATE TRIGGER thread_search_update AFTER UPDATE OF search_text, deleted_at ON threads_index
WHEN new.search_text IS NOT old.search_text OR new.deleted_at IS NOT old.deleted_at BEGIN
    DELETE FROM thread_search_trigrams WHERE rowid = old.rowid;
    DELETE FROM thread_search_short WHERE rowid = old.rowid;
    INSERT INTO thread_search_trigrams(rowid, search_text)
        SELECT new.rowid, lower(new.search_text) WHERE new.deleted_at IS NULL;
    INSERT INTO thread_search_short(rowid, grams)
        SELECT rowid, grams FROM thread_search_short_source WHERE rowid = new.rowid;
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

-- UTF-8 lead bytes give each character's byte width. BLOB substr uses byte
-- offsets, so this walk is linear; TEXT substr would rescan all preceding
-- Unicode characters for every token. Materialize the lowered source once.
-- This view stores no data. Its rowid predicate selects one source row on writes.
CREATE VIEW comment_search_short_source AS
SELECT rowid, (
    WITH RECURSIVE source(bytes, size) AS MATERIALIZED (
        SELECT CAST(lower(search_text) AS BLOB), length(CAST(search_text AS BLOB))
    ), positions(i, width) AS (
        SELECT 1, CASE WHEN substr(bytes, 1, 1) < x'80' THEN 1 WHEN substr(bytes, 1, 1) < x'E0' THEN 2 WHEN substr(bytes, 1, 1) < x'F0' THEN 3 ELSE 4 END FROM source WHERE size > 0
        UNION ALL
        SELECT i + width, CASE WHEN substr(bytes, i + width, 1) < x'80' THEN 1 WHEN substr(bytes, i + width, 1) < x'E0' THEN 2 WHEN substr(bytes, i + width, 1) < x'F0' THEN 3 ELSE 4 END
        FROM positions, source WHERE i + width <= size
    )
    SELECT coalesce(group_concat(
        'x' || hex(substr(bytes, i, width)) || ' x' ||
        hex(substr(bytes, i, width + (CASE WHEN substr(bytes, i + width, 1) < x'80' THEN 1 WHEN substr(bytes, i + width, 1) < x'E0' THEN 2 WHEN substr(bytes, i + width, 1) < x'F0' THEN 3 ELSE 4 END))), ' '
    ), '') FROM positions, source
) AS grams FROM comments_index WHERE deleted_at IS NULL AND is_root = 0;

INSERT INTO comment_search_trigrams(rowid, search_text)
    SELECT rowid, lower(search_text) FROM comments_index WHERE deleted_at IS NULL AND is_root = 0;
INSERT INTO comment_search_short(rowid, grams)
    SELECT rowid, grams FROM comment_search_short_source;

CREATE TRIGGER comment_search_insert AFTER INSERT ON comments_index BEGIN
    INSERT INTO comment_search_trigrams(rowid, search_text)
        SELECT new.rowid, lower(new.search_text) WHERE new.deleted_at IS NULL AND new.is_root = 0;
    INSERT INTO comment_search_short(rowid, grams)
        SELECT rowid, grams FROM comment_search_short_source WHERE rowid = new.rowid;
END;
CREATE TRIGGER comment_search_update AFTER UPDATE OF search_text, deleted_at, is_root ON comments_index
WHEN new.search_text IS NOT old.search_text OR new.deleted_at IS NOT old.deleted_at OR new.is_root IS NOT old.is_root BEGIN
    DELETE FROM comment_search_trigrams WHERE rowid = old.rowid;
    DELETE FROM comment_search_short WHERE rowid = old.rowid;
    INSERT INTO comment_search_trigrams(rowid, search_text)
        SELECT new.rowid, lower(new.search_text) WHERE new.deleted_at IS NULL AND new.is_root = 0;
    INSERT INTO comment_search_short(rowid, grams)
        SELECT rowid, grams FROM comment_search_short_source WHERE rowid = new.rowid;
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
