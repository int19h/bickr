-- Exactly one row is retained for the lifetime of an environment. The CHECK
-- constraint keeps this operational control bounded while preserving the last
-- operator message and update time for status reporting.
CREATE TABLE maintenance_control (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
	message TEXT NOT NULL CHECK (length(trim(message)) > 0),
	activated_at TEXT,
	updated_at TEXT NOT NULL,
	CHECK (
		(enabled = 0 AND activated_at IS NULL)
		OR (enabled = 1 AND activated_at IS NOT NULL)
	)
);

INSERT INTO maintenance_control (id, enabled, message, activated_at, updated_at)
VALUES (
	1,
	0,
	'Bickr is temporarily read-only while scheduled maintenance is in progress.',
	NULL,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
