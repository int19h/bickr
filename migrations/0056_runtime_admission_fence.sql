-- Retained with the runtime index row. The last consumed admission token is
-- never cleared on release: preserving it prevents a delayed, cancelled claim
-- from becoming valid again after a newer run completes (the ABA problem).
ALTER TABLE bot_runtime_index ADD COLUMN admission_token TEXT;
