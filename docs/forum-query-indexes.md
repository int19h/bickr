# Forum search and hot-count maintenance

Migration 0061 adds indexes for the existing substring search. Result order,
reply handling, scope checks, and literal `%`, `_`, and backslash rules stay the
same. Forum and world search select candidate row IDs from the indexes, then
apply the existing escaped `LIKE` predicate. That predicate preserves SQLite's
matching rules when the full-text tokenizer folds a character differently.

FTS5 trigrams cover queries with at least three Unicode characters. The existing
search also accepts two UTF-16 code units, including a single emoji. A second
contentless FTS5 index stores hexadecimal tokens for one and two Unicode
characters. `shortSubstringTokens` generates unique tokens in one linear pass.
`upsertThreadIndex` and `upsertCommentIndex` write these derived tokens alongside
the source text. Normal mutations, durable mutation plans, and projection repair
all use these writers. New writers must use `substringIndexFields`, which returns the paired search text
and tokens. The sweep uses the same tokenizer for stored source text.

SQL insert/update/delete triggers update both FTS indexes in the same source
transaction. Unchanged text and tokens do not rewrite indexes. Soft deletion and
hard deletion remove entries. Root comments are excluded. The derived column and
indexes have the same retention as their source rows. Tokens add storage and work
to writes. A common substring can still yield many candidates to filter and sort.
Result limits alone cannot bound that work.

The migration leaves old token columns NULL. It does not tokenize old text inside
DDL. Partial indexes select pending rows. `rebuildForumSearchIndexes` processes at
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

1. Deploy the reviewed candidate to test with migration 0061. Do not run the
   backfill while old Worker versions can still write projections.
2. Read `GET /maintenance/search-index/status` through the authenticated test
   service proxy, with service `forum-coordinator` and header
   `x-bickr-scheduler: 1`.
3. If `ready` is false, send `POST /maintenance/search-index/rebuild` through that
   proxy with the same service/header. Each request performs one bounded batch
   and returns `processed` and `remaining`. Repeat while `remaining` is true.
   Keep `TEST_AUTH_SECRET` in an environment variable, outside command logs.
   The scheduled sweep also makes progress every five minutes.
4. Read status again, then use both two-character and longer searches on
   `test.bickr.social`. Make sure that edits, replies, soft deletion, and projection repair produce the expected results.
   Record readiness beside migration, version, health, and bundle evidence.

The endpoint is the existing Pages `POST /api/__test__/service-proxy`. Its JSON
body selects the service, relative path, method, and scheduler header. Direct
public Worker URLs remain disabled. Production needs separate authorization and
its own warmup plan. These test proxy instructions do not apply there.

## Hot counts

`thread_hot_refresh` holds at most one row per thread. Comment writes mark a
thread dirty. A maintenance call selects at most 64 due rows, recomputes counts,
and schedules each next comment expiry. One atomic D1 batch updates the count
and queue. Threads without a future expiry leave the queue. Thread deletion
removes its entry. The migration puts old live threads in the queue once. The queue is not an
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
