# Forum search and hot-count maintenance

Migration 0061 adds indexes for the existing substring search. It does not change
the result order, reply handling, scope checks, or literal `%`, `_`, and backslash
rules. Both forum and world thread search first select candidate row IDs from the
new indexes, then apply the existing escaped `LIKE` predicate. That last predicate
keeps SQLite's original matching rules even when the full-text tokenizer folds a
character differently.

SQLite FTS5 trigrams cover queries with at least three Unicode characters. The
existing search also accepts two UTF-16 code units, including a single emoji.
A second, contentless FTS5 index stores hexadecimal tokens for one and two Unicode
characters. SQL views generate those short tokens. They walk UTF-8 bytes with
`BLOB` substrings, so they do not rescan the preceding text for each character.
Queries select each view by the source row ID before generating tokens for a write.

Insert, update, and delete triggers maintain both indexes in the source transaction.
An unchanged text projection does not rewrite the indexes. Soft-deleted rows and
root comments have no search entries. Hard deletion also removes entries. The
indexes store derived tokens, with no second copy of the source text. They have
the same retention as their source rows. The views store no data.

The migration builds these indexes once for existing rows. Rehearse its duration
and storage use on a representative copy before a large production migration.
It adds index storage and work to text writes. It removes full text scans from
no-match searches, but a common substring can still produce many candidates to
filter and sort. Result limits alone cannot bound that work.

The same migration adds `thread_hot_refresh`, an indexed queue with at most one
row per thread. Comment writes mark a thread dirty. Each maintenance call selects
at most 64 due threads, recomputes recent comment counts, and schedules each
thread's next comment expiry. A single D1 batch updates the count and the queue.
A concurrent comment write therefore cannot disappear between those steps.
Threads without a future expiry leave the queue. Thread deletion removes the
queue entry. The migration seeds existing live threads once; the regular recovery
cron drains that seed in bounded batches. The queue is not an event history.

`refreshThreadHotScores` returns the number of queue entries processed. A return
of 64 means more work may remain. The five-minute recovery task should call it as
well as daily maintenance. Indexed comment cutoffs limit each count to the hot
window. Application writes also cap replies per thread; this does not assume that
every historical row already meets that cap.

Regression checks use real SQLite query plans and operation counts. No-match long,
two-character, and emoji queries over 100, 1,000, and 10,000 historical threads
evaluate zero source text rows. Refreshing a 1,000-thread historical seed visits
64 queue entries and updates zero unchanged thread rows. A Workers test also
applies the migration and checks insert, search, expiry, soft deletion, and hard
deletion through D1.

Sources: [Cloudflare's indexing guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/),
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
and [SQLite's trigram tokenizer](https://www.sqlite.org/fts5.html#the_trigram_tokenizer).
