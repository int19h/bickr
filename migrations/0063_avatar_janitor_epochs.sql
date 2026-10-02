-- One control row is retained for the environment lifetime. Epoch data exists
-- only until its sweep or abort cleanup finishes; each invocation deletes at
-- most 1,000 marks and objects. No historical epoch log is retained.
CREATE TABLE avatar_janitor_control (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 epoch TEXT,
 phase TEXT NOT NULL CHECK (phase IN ('idle', 'list', 'mark', 'sweep', 'cleanup')),
 checkpoint_json TEXT,
 lease_token TEXT,
 lease_until TEXT,
 last_run_at TEXT
);
INSERT INTO avatar_janitor_control(id, phase) VALUES (1, 'idle');
CREATE TABLE avatar_janitor_marks (
 epoch TEXT NOT NULL,
 object_key TEXT NOT NULL,
 PRIMARY KEY(epoch, object_key)
) WITHOUT ROWID;
CREATE TABLE avatar_janitor_objects (
 epoch TEXT NOT NULL,
 object_key TEXT NOT NULL,
 PRIMARY KEY(epoch, object_key)
) WITHOUT ROWID;
-- Persist listing cursors so a repeated cursor is detected across invocations.
-- These rows have the same bounded cleanup and lifetime as the epoch above.
CREATE TABLE avatar_janitor_cursors (
 epoch TEXT NOT NULL,
 cursor TEXT NOT NULL,
 PRIMARY KEY(epoch, cursor)
) WITHOUT ROWID;

-- Avatar keys are immutable. Uploads, promotions and clone copies write a new
-- key before publishing it; the epoch's seven-day cutoff protects that window.
-- Index changes also pin both old and new URLs until this epoch ends. This
-- preserves an old inherited reference across a source change or deletion.
-- URL paths are used across public-host changes, as in the janitor's KV marker.
CREATE TRIGGER avatar_janitor_bots_index_insert
AFTER INSERT ON bots_index
BEGIN
 INSERT OR IGNORE INTO avatar_janitor_marks(epoch, object_key)
 SELECT epoch, substr(substr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1), 1, instr(substr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1) || '#', '#') - 1) FROM avatar_janitor_control
 WHERE id = 1 AND phase IN ('list', 'mark', 'sweep')
   AND NEW.avatar_url IS NOT NULL AND instr(NEW.avatar_url, '://') > 0;
END;
CREATE TRIGGER avatar_janitor_bots_index_update
AFTER UPDATE OF avatar_url, deleted_at ON bots_index
BEGIN
 INSERT OR IGNORE INTO avatar_janitor_marks(epoch, object_key)
 SELECT epoch, substr(substr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1), 1, instr(substr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1) || '#', '#') - 1) FROM avatar_janitor_control
 WHERE id = 1 AND phase IN ('list', 'mark', 'sweep')
   AND OLD.avatar_url IS NOT NULL AND instr(OLD.avatar_url, '://') > 0;
 INSERT OR IGNORE INTO avatar_janitor_marks(epoch, object_key)
 SELECT epoch, substr(substr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1), 1, instr(substr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1) || '#', '#') - 1) FROM avatar_janitor_control
 WHERE id = 1 AND phase IN ('list', 'mark', 'sweep')
   AND NEW.avatar_url IS NOT NULL AND instr(NEW.avatar_url, '://') > 0;
END;
CREATE TRIGGER avatar_janitor_bots_index_delete
AFTER DELETE ON bots_index
BEGIN
 INSERT OR IGNORE INTO avatar_janitor_marks(epoch, object_key)
 SELECT epoch, substr(substr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1), 1, instr(substr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1) || '#', '#') - 1) FROM avatar_janitor_control
 WHERE id = 1 AND phase IN ('list', 'mark', 'sweep')
   AND OLD.avatar_url IS NOT NULL AND instr(OLD.avatar_url, '://') > 0;
END;
CREATE TRIGGER avatar_janitor_worlds_index_insert
AFTER INSERT ON worlds_index
BEGIN
 INSERT OR IGNORE INTO avatar_janitor_marks(epoch, object_key)
 SELECT epoch, substr(substr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1), 1, instr(substr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1) || '#', '#') - 1) FROM avatar_janitor_control
 WHERE id = 1 AND phase IN ('list', 'mark', 'sweep')
   AND NEW.avatar_url IS NOT NULL AND instr(NEW.avatar_url, '://') > 0;
END;
CREATE TRIGGER avatar_janitor_worlds_index_update
AFTER UPDATE OF avatar_url, deleted_at ON worlds_index
BEGIN
 INSERT OR IGNORE INTO avatar_janitor_marks(epoch, object_key)
 SELECT epoch, substr(substr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1), 1, instr(substr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1) || '#', '#') - 1) FROM avatar_janitor_control
 WHERE id = 1 AND phase IN ('list', 'mark', 'sweep')
   AND OLD.avatar_url IS NOT NULL AND instr(OLD.avatar_url, '://') > 0;
 INSERT OR IGNORE INTO avatar_janitor_marks(epoch, object_key)
 SELECT epoch, substr(substr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1), 1, instr(substr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1) || '#', '#') - 1) FROM avatar_janitor_control
 WHERE id = 1 AND phase IN ('list', 'mark', 'sweep')
   AND NEW.avatar_url IS NOT NULL AND instr(NEW.avatar_url, '://') > 0;
END;
CREATE TRIGGER avatar_janitor_worlds_index_delete
AFTER DELETE ON worlds_index
BEGIN
 INSERT OR IGNORE INTO avatar_janitor_marks(epoch, object_key)
 SELECT epoch, substr(substr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1), 1, instr(substr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1) || '#', '#') - 1) FROM avatar_janitor_control
 WHERE id = 1 AND phase IN ('list', 'mark', 'sweep')
   AND OLD.avatar_url IS NOT NULL AND instr(OLD.avatar_url, '://') > 0;
END;
CREATE TRIGGER avatar_janitor_users_index_insert
AFTER INSERT ON users_index
BEGIN
 INSERT OR IGNORE INTO avatar_janitor_marks(epoch, object_key)
 SELECT epoch, substr(substr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1), 1, instr(substr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1) || '#', '#') - 1) FROM avatar_janitor_control
 WHERE id = 1 AND phase IN ('list', 'mark', 'sweep')
   AND NEW.avatar_url IS NOT NULL AND instr(NEW.avatar_url, '://') > 0;
END;
CREATE TRIGGER avatar_janitor_users_index_update
AFTER UPDATE OF avatar_url, deleted_at ON users_index
BEGIN
 INSERT OR IGNORE INTO avatar_janitor_marks(epoch, object_key)
 SELECT epoch, substr(substr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1), 1, instr(substr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1) || '#', '#') - 1) FROM avatar_janitor_control
 WHERE id = 1 AND phase IN ('list', 'mark', 'sweep')
   AND OLD.avatar_url IS NOT NULL AND instr(OLD.avatar_url, '://') > 0;
 INSERT OR IGNORE INTO avatar_janitor_marks(epoch, object_key)
 SELECT epoch, substr(substr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1), 1, instr(substr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), instr(substr(NEW.avatar_url, instr(NEW.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1) || '#', '#') - 1) FROM avatar_janitor_control
 WHERE id = 1 AND phase IN ('list', 'mark', 'sweep')
   AND NEW.avatar_url IS NOT NULL AND instr(NEW.avatar_url, '://') > 0;
END;
CREATE TRIGGER avatar_janitor_users_index_delete
AFTER DELETE ON users_index
BEGIN
 INSERT OR IGNORE INTO avatar_janitor_marks(epoch, object_key)
 SELECT epoch, substr(substr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1), 1, instr(substr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1), 1, instr(substr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), instr(substr(OLD.avatar_url, instr(OLD.avatar_url, '://') + 3), '/') + 1) || '?', '?') - 1) || '#', '#') - 1) FROM avatar_janitor_control
 WHERE id = 1 AND phase IN ('list', 'mark', 'sweep')
   AND OLD.avatar_url IS NOT NULL AND instr(OLD.avatar_url, '://') > 0;
END;

CREATE INDEX avatar_janitor_live_bots ON bots_index(bot_id) WHERE deleted_at IS NULL;
CREATE INDEX avatar_janitor_live_worlds ON worlds_index(world_id) WHERE deleted_at IS NULL;
CREATE INDEX avatar_janitor_live_users ON users_index(user_id) WHERE deleted_at IS NULL;
