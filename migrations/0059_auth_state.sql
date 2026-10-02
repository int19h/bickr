-- Authoritative authentication state lives in D1, never in an eventually
-- consistent cache. Every row has an absolute expiry. The scheduled auth sweep
-- deletes at most 500 expired records and rate buckets per pass via these indexes.
-- Refresh-token lineage lasts until its grant's fixed 90-day expiry, including
-- consumed tokens. Clients expire after 30 idle days; authorization renews them
-- for 180 days so a 90-day grant cannot outlive its client.
CREATE TABLE auth_records (
  record_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('session', 'cli_token', 'cli_request',
    'mcp_client', 'mcp_code', 'mcp_grant', 'mcp_access', 'mcp_refresh', 'revoked_legacy')),
  user_id TEXT,
  grant_id TEXT,
  expires_at TEXT NOT NULL,
  consumed_by TEXT,
  revoked_at TEXT,
  document TEXT NOT NULL CHECK (json_valid(document))
);
CREATE INDEX auth_records_expiry ON auth_records(expires_at, record_key);
CREATE INDEX auth_records_user ON auth_records(user_id, kind, record_key);
CREATE INDEX auth_records_grant ON auth_records(grant_id, kind, record_key);

-- Fixed one-hour rate windows retain counters for two hours. Subjects contain
-- a hash of the Cloudflare-provided client address, never the address itself.
CREATE TABLE auth_rate_buckets (
  bucket_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  last_admission TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX auth_rate_buckets_expiry ON auth_rate_buckets(expires_at, bucket_key);

-- One permanent row records the versioned transition. Legacy reads never write.
-- Migration starts a fixed 90-day window; no request can extend that deadline.
-- After the bounded sweep completes, schema version 3 disables the legacy reader.
CREATE TABLE auth_storage_transition (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  legacy_until TEXT NOT NULL
);
INSERT INTO auth_storage_transition(id, schema_version, legacy_until)
VALUES (1, 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+90 days'));

-- At most one row per account. A durable cutoff also revokes legacy credentials
-- that the bounded migration has not visited yet. Retain through account life.
CREATE TABLE auth_user_revocations (
  user_id TEXT PRIMARY KEY,
  revoked_before TEXT NOT NULL
);

-- Eight fixed progress rows exist only during the one-time KV retirement.
-- Schema version 3 removes the reader after all prefixes complete. The next
-- schema migration removes this table and auth_storage_transition altogether.
CREATE TABLE auth_migration_progress (
  prefix TEXT PRIMARY KEY,
  cursor TEXT,
  completed_at TEXT
);
INSERT INTO auth_migration_progress(prefix) VALUES ('session'), ('cli_token'),
  ('mcp_client'), ('cli_request'), ('mcp_code'), ('mcp_access'), ('mcp_refresh'), ('mcp_grant');
