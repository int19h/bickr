# Forum search and hot-count maintenance

Migration 0061 adds indexes for the existing substring search. Result order,
reply handling, scope checks, and literal `%`, `_`, and backslash rules stay the
same. Forum and world search select candidate row IDs from the indexes, then
apply the existing escaped `LIKE` predicate. That predicate preserves SQLite's
matching rules when the full-text tokenizer folds a character differently.

A trigram contains three consecutive characters. FTS5 trigrams cover queries with at least three Unicode characters. The existing
search also accepts two UTF-16 code units, including a single emoji. A second
contentless FTS5 index stores hexadecimal tokens for one and two Unicode
characters. `shortSubstringTokens` generates unique tokens in one linear pass.

`upsertThreadIndex` and `upsertCommentIndex` write these derived tokens alongside
the source text. Normal mutations, durable mutation plans, and projection repair
all use these writers. New writers must use `substringIndexFields`. It returns the paired search text and tokens. The removed sweep used the same tokenizer for stored source text.

SQL insert/update/delete triggers update both FTS indexes in the same source
transaction. Unchanged text and tokens do not rewrite indexes. Soft deletion and
hard deletion remove entries. The indexes exclude root comments. The derived column and
indexes have the same retention as their source rows.

Tokens add storage and work to writes. A common substring can still yield many candidates to filter and sort.
Result limits alone cannot bound that work.

Migration 0061 left old token columns NULL. Its SQL schema statements did not tokenize old text.
Migration 0075 drops `thread_search_pending` and `comment_search_pending`. No reader uses those indexes. The production census found 0 live rows with NULL tokens on both databases.

`BEFORE` triggers reject a NULL token write. They also reject a state change that makes a NULL-token row searchable. Historical NULL rows that search does not read stay as they are. A soft delete and a `DELETE` of those rows still succeed. Search does not check readiness and does not return a rebuilding response.

The one-time sweep and the maintenance routes `GET /maintenance/search-index/status` and `POST /maintenance/search-index/rebuild` are removed. The recovery cron no longer rebuilds tokens.

## Restore

After a restore or import from a point before the 0061 sweep drained, run this census before the service resumes:

```sql
SELECT
  (SELECT COUNT(*) FROM threads_index
     WHERE search_short_tokens IS NULL AND deleted_at IS NULL) AS threads,
  (SELECT COUNT(*) FROM comments_index
     WHERE search_short_tokens IS NULL AND deleted_at IS NULL AND is_root = 0) AS comments;
```

For a one-time operator check after a restore, this census scans `threads_index` and `comments_index`.

If either count is not 0, stop. Then tokenize those rows with an operator script that uses `substringIndexFields`, or deploy the sweep again from the commit before its removal. This release does not include that script or that sweep.

A restore to a point before migrations 0073 and 0074 also drops the token guards and `bots_index.last_active_at`. Reapplying those two migrations restores the guards. The backfill recomputes `last_active_at`. Run the census after those migrations.

The 0073 release used this census as its deploy gate. It ran the census immediately before 0073 on each database. A count other than 0 stopped that release.

## Hot counts

`thread_hot_refresh` holds at most one row per thread. Comment writes mark a
thread dirty. A maintenance call selects at most 64 due rows, recomputes counts,
and schedules each next comment expiry. One atomic D1 batch updates the count
and queue. Threads without a future expiry leave the queue. Thread deletion
removes its entry.

The migration puts old live threads in the queue once. The queue is not an
event history. `refreshThreadHotScores` returns processed entries, not changed
counts. A result of 64 means that more work can remain. Recovery calls it every five minutes.

Regression checks use real SQLite plans and operation counts. No-match long,
two-character, and emoji searches over 100, 1,000, and 10,000 historical threads
evaluate zero source text rows. Token generation encodes at most three times the
input character count. SQL lower() runs once for 4K through 32K Unicode writes.
Workerd tests apply the actual migration and exercise search, expiry, deletion,
and the NULL-token guards.

Sources: [Cloudflare indexing](https://developers.cloudflare.com/d1/best-practices/use-indexes/),
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
and [SQLite trigrams](https://www.sqlite.org/fts5.html#the_trigram_tokenizer).
