The avatar cleanup job is called the janitor. It saves each cleanup pass, called an epoch. The daily cron starts an epoch when the last successful pass is at least seven days old. The five-minute cron resumes an active epoch. An idle resume call reads one D1 control row and does no R2 or KV work.

An epoch has four phases: list, mark, sweep, and cleanup. Each invocation performs at most four phase steps. A list step reads at most 1,000 R2 objects. A mark records an avatar reference that prevents deletion. A mark step reads at most ten live entity rows, their KV documents, and linked sources. Linked sources have an existing depth limit of sixteen.

A sweep step examines at most 100 listed objects. An invocation deletes at most 100 objects. Each cleanup step deletes at most 1,000 rows from each temporary table. A cursor records where a scan continues. Work resumes from the stored cursor.

Listing must finish before marking starts. The janitor saves object keys only when their upload time is at least seven days before the epoch started. An upload during a long pass cannot become eligible as that pass gets older. The janitor saves listing cursors. A missing or repeated cursor aborts the pass before any deletion.

Marking retains references from both live index rows and their KV documents. A live row has a null deleted_at value. This includes pending and deleting entities. The index and document provide independent evidence because an interrupted write can leave either one behind. Marking also retains stored local avatar overrides.

A tombstone marks a deleted entity whose document remains stored. The janitor resolves linked avatar sources from raw KV, including tombstoned source documents. A missing document, missing source, cycle, or chain past the depth limit aborts the pass. No partial mark set can authorize a sweep.

Index triggers retain both old and new avatar URL paths during listing, marking, and sweeping. This preserves references that change between invocations. It includes an inherited avatar whose source changes before its own mark page. The triggers run in the transaction that changes the entity index. They use URL paths so a public asset host change does not lose the object key.

This proof also relies on the avatar writers. Normal uploads, generated-image promotion, and clone copies create fresh R2 keys before publishing them. They do not restore an old unreferenced key. The epoch's upload cutoff protects the interval before the new key reaches an index.

Resumable imports reuse a deterministic lifecycle-import key. The janitor retains all three possible import keys while their participant is pending or deleting. This rule also covers imports older than the grace period. A new writer that publishes an old key must preserve these rules or add a coordinated publication protocol. An independent mark lookup followed by publication is insufficient.

A lease gives one request temporary control of cleanup. A D1 compare-and-set update requires the expected current value. This update prevents overlapping cron requests from advancing the same checkpoint, which records cleanup progress. A lease lasts fifteen minutes. Each durable page write requires the same token. A delayed request cannot replace a newer request's cursor.

Only a completed mark phase permits sweeping. Before each deletion batch, the janitor makes sure that its lease remains valid. It also reads the current marks again. Referenced objects remain in R2.

Candidate images have no durable profile reference until promotion. Their retention period remains the seven-day grace period. Promotion copies the candidate to a fresh published key.

R2 can safely repeat a deletion after an interruption. Avatar keys never serve a different object. A transient read or delete error leaves the phase resumable. A known incomplete mark or invalid listing moves the epoch to cleanup without sweeping.

D1 retains the control row for the environment lifetime. The marks, listed objects, and used cursors belong only to the active epoch. Cleanup removes them in bounded batches after success or refusal. The janitor retains no history of epochs.

A successful cleanup writes `last_run_at` in the same guarded D1 update that completes the epoch. That update requires the same lease token. An aborted epoch does not advance the timestamp. After a request claims an idle lease, it makes sure that its resume-only mode and the weekly interval permit cleanup. Checkpoints use version 1. An unknown version stops cleanup rather than guessing or repairing stored state.

Tests use real SQLite for phase transitions, trigger behavior, and lease races. The Worker D1 fixture exercises integration. Tests cover fleets above the former 2,000-entity ceiling and bounded deletion batches above the former total-delete ceiling. They also cover reference changes before and after marking, old interrupted imports, and missing documents. Other cases cover tombstoned clone sources, invalid clone chains, invalid listing cursors, and expired leases.

Before the first successful epoch, the scheduler can read the old KV weekly marker. It never writes that marker. After `last_run_at` is set, D1 is the only scheduling authority. This temporary compatibility path uses version 1. Reads never repair per-entity data.

To retire that path, complete these steps:

1. Make sure that an epoch succeeds in each environment.
2. Delete each environment's old `v1:maintenance:avatar-janitor-last-run` KV marker.
3. Remove the fallback with checkpoint version 2.
