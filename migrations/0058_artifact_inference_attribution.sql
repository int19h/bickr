-- Attribution follows the retention of its artifact. Historical/manual rows remain NULL.
-- No new independently growing store is introduced; deleted follows/votes lose their state
-- snapshot, while existing activity retention keeps the snapshot of each visible action.
ALTER TABLE threads_index ADD COLUMN inference_attribution_json TEXT;
ALTER TABLE comments_index ADD COLUMN inference_attribution_json TEXT;
ALTER TABLE votes ADD COLUMN inference_attribution_json TEXT;
ALTER TABLE follows ADD COLUMN inference_attribution_json TEXT;
ALTER TABLE bot_activity_events ADD COLUMN inference_attribution_json TEXT;
