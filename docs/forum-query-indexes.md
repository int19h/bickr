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
all use these writers. New writers must use `substringIndexFields`. It returns the paired search text and tokens. The sweep uses the same tokenizer for stored source text.

SQL insert/update/delete triggers update both FTS indexes in the same source
transaction. Unchanged text and tokens do not rewrite indexes. Soft deletion and
hard deletion remove entries. The indexes exclude root comments. The derived column and
indexes have the same retention as their source rows.

Tokens add storage and work to writes. A common substring can still yield many candidates to filter and sort.
Result limits alone cannot bound that work.

The migration leaves old token columns NULL. Its SQL schema statements do not tokenize old text.
Partial indexes select pending rows.

`rebuildForumSearchIndexes` processes at
most 64 candidate rows and 256 KiB of source text per table per call. It permits
one larger historical row so the cursor can progress. The sweep updates tokens only if the source text still matches.
This condition prevents the sweep from overwriting a concurrent projection update.

The five-minute recovery cron runs this bounded sweep. Pending live rows cause
search to return HTTP 503 with an explicit rebuilding message, so missing index
entries cannot silently omit results. The readiness query uses an index to find pending rows.
Search reads never rebuild rows or scan all rows as an alternative.

Retire the old projection writers before the final sweep.
After every deployed database drains the NULL markers, remove the migration sweep. Record that removal
with the next search schema version. A future version must not stack another
fallback on the current migration. Existing applied migrations remain immutable.

## Test release warmup

Use the existing Pages `POST /api/__test__/service-proxy` endpoint in test.
Its JSON body selects the service, relative path, method, and scheduler header.
The requests below use service `forum-coordinator` and header `x-bickr-scheduler: 1`.
Keep `TEST_AUTH_SECRET` in an environment variable, outside command logs.
Direct public Worker URLs remain disabled.

Each rebuild request performs one bounded batch and returns `processed` and `remaining`.
The scheduled sweep also makes progress every five minutes.
To prepare search after deployment, follow these steps:

1. Deploy the reviewed candidate to test with migration 0061.
2. If old Worker versions can still write projections, do not run the migration sweep.
3. Read `GET /maintenance/search-index/status` through the authenticated test service proxy.
4. If `ready` is false, send `POST /maintenance/search-index/rebuild` through that proxy with the same service and header.
5. If `remaining` is true, repeat the rebuild request.
6. Read status again.
7. Use both two-character and longer searches on `test.bickr.social`.
8. Make sure that edits, replies, soft deletion, and projection repair produce the expected results.
9. Record readiness beside migration, version, health, and bundle evidence.

Production needs separate authorization and its own warmup plan.
These test proxy instructions do not apply there.

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
Backfill tests cover row/byte budgets and concurrent edits. Workerd tests apply
the actual migration and exercise readiness, search, expiry, and deletion.

Sources: [Cloudflare indexing](https://developers.cloudflare.com/d1/best-practices/use-indexes/),
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
and [SQLite trigrams](https://www.sqlite.org/fts5.html#the_trigram_tokenizer).
