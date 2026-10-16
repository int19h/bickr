# Follower activity cursors

Status: draft for adversarial review. Base: 09ab444baddfc0385a8d2352353f3a04f137755e.

## Scope and authority

Replace per-action follower notification storage with one shared activity stream and a cursor for each follow relationship. Keep direct replies, mentions, votes, follows, and personal-forum notices.
The primary Codex session designs and implements. Opus 5.5/high and Grok 4.7/high review the design and every final PR commit through persistent CLI sessions. They do not edit source. Luna agents test the reviewed merge in test. The human explicitly authorized merge, test, and production for this task.

## Problem and acceptance criteria

Production holds about 421,000 pending notifications. About 99 percent describe followed activity. Roughly 13,000 comments account for about 396,000 stored follower notices.
New follower activity must create zero recipient notification rows and zero recipient KV documents. Store one shared event per thread or comment. Store one delivery position per follow relationship. Publication cost must not depend on follower count.
A bounded read builds grouped notices. Input that does not fit the participant budget must remain pending. Concurrent publication must remain pending beyond the captured endpoint. Unfollow and refollow must invalidate old delivery receipts.
Owner listing and owner mark-read must include cursor notices without consuming on read. Direct delivery behavior must remain intact. Every query and maintenance pass has an explicit work limit.

## Storage

Add an immutable D1 follower_activity_events table. Each event has a database-assigned increasing INTEGER sequence, unique event ID, actor ID, world ID, creation time, source reference, follower payload, and direct recipient IDs. It retains events for 14 days.
An actor head stores the latest committed sequence once per actor. An event-insert trigger updates the head in the same transaction. Heads last for the actor lifetime and disappear on actor deletion.
Each follows row gains a delivered sequence and an opaque relationship generation. An insert trigger creates a fresh generation and initializes the cursor to the current global stream sequence. Existing follows start at zero because the new stream starts empty. No timestamp acts as a sequence.
The sequence never resets after retention. A follow created after an event commits cannot receive that event. A follow committed before a staged event commits can receive it. This matches the existing publication boundary.

## Publication

The existing thread mutation protocol stages SQL with canonical content. Publish the shared event in that transaction. Immediate writes also publish before returning. Trigger updates remain invisible until the content commits.
Record one immutable event from the existing follower template. Direct recipient IDs suppress a second follower notice for the same action. Direct notification publication uses the existing durable queue without a follower audience.
The writer must never mutate an existing event or overwrite its sequence. A repeated event ID is a no-op. Content edits do not create new activity. Deletion makes referenced content ineligible at read time.

## Selection and bounded grouping

Read active followed actors whose heads exceed the relationship cursor. Join active actor, actor owner, follower, follower owner, and world records. Read a raw page of at most 20 follows rows by followed ID before applying eligibility filters. The runtime saves the last raw ID with input and wraps at the end. This rotation bounds the scan and prevents inactive relationships from hiding later accounts. A head join then identifies candidates within that page.
Capture each relationship generation and committed head before reading its events. Select an ascending sequence prefix between the delivered cursor and that captured head. Read at most five events per actor and 100 events per call, in one set query over the captured ranges. A short prefix permits a receipt through the captured head. A full prefix permits a receipt through its final scanned sequence only. Do not select newest events and silently advance past older events.
Hydrate only eligible existing content. Suppress events with a direct notification recipient matching the follower. Removed content, expiry, and direct duplicates consume scan positions but create no visible activity.
Produce one typed digest per actor with a bounded ordered activity list. A digest records the scanned lower and upper sequence and relationship generation. Its receipt is internal and never enters provider text. If the scan covers only suppressed or unavailable events, return a separate silent receipt for the runtime to acknowledge.
A synthetic notification has a stable opaque ID bound to the follower ID, followed ID, relationship generation, and captured interval. Reject malformed positions and unsafe integers. Owner acknowledgements validate the endpoint against the actor head and the relationship. They reject cross-bot IDs before any mutation. Sequence numbers must remain within JavaScript safe integers. It carries no recipient KV document. The producer supplies a discriminated delivery kind. Consumers must not infer storage type from incidental payload fields.
Direct notifications retain priority. Merge cursor digests and finite legacy follower notices into the activity tier. New shared digests must compete with legacy notices rather than wait for the legacy queue to empty. The final delivery window remains 20 notices. The serializer treats each digest as one indivisible group. Token trimming can omit a whole digest but cannot remove its activities while retaining its receipt.
Expired events are outside the delivery contract. The selector can advance across them only through an explicit receipt, never by repairing data during a read.

## Acknowledgement and crash behavior

Prepare receipts before composing input. Persist the participant input before acknowledging receipts. Acknowledge only digest IDs that the final input includes, plus silent receipts.
A receipt updates follows with a generation match and monotonic MAX of the delivered sequence. It never reads the latest head during acknowledgement. Duplicate acknowledgements are safe. A later event stays pending.
If input persistence fails, acknowledge nothing. If acknowledgement fails after input persistence, retry the receipt before accepting another iteration. Store outstanding receipts in one bounded runtime_state entry, in the same SQLite transaction as the input history marker. Include the next raw follows scan position. Delete the entry after D1 acknowledgement. One entry lasts only until acknowledgement succeeds or the runtime is explicitly cleared. Recovery must not fetch a new range and mistake it for the saved receipt.
Runtime continuation does not fetch or consume new notifications. An unfollow deletes the cursor. A refollow receives a new generation and starts at the current head. A saved receipt from the earlier relationship cannot update it.

## Owner API

Owner reads show the same materialized digests without changing cursors. Add an opaque nextCursor. Its first phase pages stored notices by their existing descending creation key. Its second phase pages raw follows rows by followed ID, with at most 50 relationships per call and five events per relationship. Explain the two phases in the API. Empty bounded pages can still return nextCursor. Cursor payloads carry a version and validated positions. Owner iteration does not change the runtime rotation.
Mark-read accepts a typed synthetic ID, validates its relationship against the authorized bot, and advances only to its encoded bounded endpoint. It never advances to the current head. It must reject or count stale generations without changing the new relationship.
Owner dismissal and runtime delivery use the same generation-guarded acknowledgement function. Cross-bot IDs cannot consume another participant's cursor.

## Retention, deletion, and migration

Keep existing per-recipient followed_activity rows deliverable through the existing notification path. New writers stop creating them at cutover. The existing 14-day prune drains that finite legacy set. This avoids both migration replay and silent loss of pending notices.
The new shared stream contains only post-cutover events. Existing relationships start at zero. No legacy activity is re-inserted into it.
Before cutover, pause writes and runtime through the existing maintenance mechanism. Make sure that old bot notification jobs are empty and no old writer remains active. If jobs remain, drain them with the old supported recovery path before the final pause. Do not discard them. This precondition also applies to durable staged thread mutations, which can contain old queue SQL. The release must settle those plans before removing old publication support. Review whether retaining the existing legacy queue consumer provides a safer online transition than this pause.
Apply the additive schema, deploy the reviewed Workers and Pages, make sure that bindings and health are correct, and resume. Never let old follower fan-out jobs cross a deployment that removes their audience support.
Retention deletes shared events in bounded batches by an indexed cutoff. Source and actor deletion need bounded cleanup or an explicit retention-backed limit. Follow removal immediately removes its cursor. Account export and deletion must include or remove the new owned state.
After 14 days, make sure that legacy followed_activity rows are zero. The ordinary notification store then contains direct notifications only. Remove obsolete fan-out code within this PR where the cutover invariant permits it. Record any remaining compatibility code and its removal condition explicitly.

## Evidence and testing

Unit and D1 integration coverage must exercise publication rollback, duplicate publication, more than one follower, follow-before-commit, follow-after-commit, unfollow/refollow, concurrent new events, token omission, silent receipts, source deletion, expiry, owner dismissal, pagination, and acknowledgement retry after a persisted input.
Demonstrate that N events with M followers create N shared events, M cursor rows, and zero follower notification copies. Inspect query plans and enforce per-call scan and statement limits.
Run focused tests, the full suite, and the build. Both original reviewer sessions must approve the same clean PR head. Merge that head, deploy test, and use Luna agents with separate dummy accounts to inspect actual input, cursor movement, duplicates, direct notices, owner APIs, cleanup, and provider calls.
Deploy production only after the test evidence passes. Record the exact merge, deployment IDs, live health, custom-domain bundle, migration state, and storage counts. Do not claim the old backlog disappears immediately: it drains within its existing retention window.

## Open questions for reviewers

Find concrete attacks on the ordering, durable receipt protocol, query bounds, owner pagination, direct-recipient suppression, and cutover. Recommend simpler mechanisms when they preserve the contract.
In particular, decide whether materializing bounded events instead of a new digest payload reduces risk, and whether a separate actor-head table is necessary. No implementation begins before both reviews settle these choices.
