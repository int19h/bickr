# Storage writers and recovery

Each entity has one coordinator that owns its writes. The account coordinator
owns users and bot profiles. The world coordinator owns world settings and forum
creation. Each forum and thread has its own coordinator. Index repair sends an
entity ID to that writer. It does not send a KV snapshot. The writer reads again
while it holds its queue. A hidden or deleting projection cannot become active
through index repair.

Thread mutations first build a write plan. One Durable Object transaction stores
the canonical thread, the pending projection plan, a retry receipt, and an alarm.
A D1 wake record lets the scheduled recovery find the object if the alarm fails.
Recovery takes the same queue as a new mutation. It finishes the pending plan
before accepting another write. The D1 projection batch includes a unique plan
receipt, so a retry cannot repeat counters or notification inserts.

A retry key identifies the request method, path, actor, and body. Reusing a key
with different input returns 409. Thread receipts retain the result's thread and
comment IDs for 30 days. A retry returns those identities with the current thread.
If the result was deleted, it returns 410 and does not repeat the mutation. Each
request or alarm prunes at most 25 expired receipts. Expiry records name their
receipt generation, so an old record cannot remove a replacement receipt.

Forum creation reserves a durable intent in D1 before it writes KV. Pending
creations have no public forum, search, or object-index row. After KV succeeds,
one D1 batch publishes those three projections and completes the receipt. A
trigger checks that the account and world are still active in that batch. If
account deletion wins, recovery removes the unpublished KV document and records
cancellation. The world queue also serializes recovery with world renames and
deletion. It uses the current world handle when it resumes a pending creation.
Completed creation receipts retain only request/result identities for 30 days.
The recovery pass checks at most 25 pending creations and removes at most 100
expired receipts.

World and forum deletion store a document tombstone and a deletion intent in the
same D1 batch that hides the entity. The intent survives KV failures, missing
Durable Object task state, and alarm failures. The owning coordinator resumes the
bounded child deletion task and removes the intent after the children converge.

Bot notification fanout stores its event with the originating mutation. A
staged thread mutation selects no recipients until that transaction commits.
Immediate writers may publish one bounded page after their event INSERT. The durable job holds one copy of each message variant. Later pages
advance an indexed recipient cursor. Publication and cursor advancement share a
D1 batch. A follow records the last published event sequence. New follows and
re-follows cannot receive older events. Each page visits at most 50 raw candidate
IDs, including ineligible IDs, then checks eligibility in the publication batch.
Deleted sources and inactive recipients fail the visibility checks.
The bot pump checks at most 100 jobs and 500 candidate IDs per run. Small
audiences can use the job budget without increasing the recipient budget.
Human notifications use their own bounded delivery jobs. The scheduled recovery
pumps both queues without holding a content writer for the full audience.
Notification retention runs every five minutes on a separate trigger, one minute
after recovery. Its 8,000-row budget gives it 2,304,000 rows of daily capacity;
the prune reserves capacity for expiry before it processes orphan cleanup.
These are local deployment configuration changes, not a live schedule update.

The recovery pass also refreshes at most 64 due hot-count entries and rebuilds a
bounded search-index page. During a release, the authenticated test service proxy
can call `POST /maintenance/search-index/rebuild` with scheduler authority while
maintenance stays enabled. `GET /maintenance/search-index/status` reports
readiness. The shared route classifier admits only these exact derived-index
operations. Public mutations retain the maintenance gate.

Migrations 0060, 0062, 0065, and 0066 create the deletion, thread recovery, bot
fanout, and forum creation records. Their retention rules are beside each schema.
Thread mutation plans are new in this release. They capture the SQL emitted by
the current projection writers, including the paired search text and token
fields from 0061. A future migration that changes those statements must account
for plans from the previous writer version before it declares a backfill ready.

Failure tests cover lost KV writes, failed D1 batches, failed Durable Object
commits, lost handoff responses, receipt replacement behind an expiry backlog,
account deletion during activation, and retries after a result was deleted.
