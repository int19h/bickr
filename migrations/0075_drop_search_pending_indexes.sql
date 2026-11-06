-- No reader uses thread_search_pending or comment_search_pending after PR #347.
-- The production census of live rows with NULL tokens was 0 on both databases.
DROP INDEX IF EXISTS thread_search_pending;
DROP INDEX IF EXISTS comment_search_pending;
