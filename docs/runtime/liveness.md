# Runtime liveness and tool outcomes

A BotRuntime object owns local run completion. Its synchronous SQLite transaction
changes the single `run_liveness_v1` record from active to finalizing and records
one terminal event. The D1 run-ID CAS subsequently releases the runtime index;
a D1 failure cannot suppress the local terminal outcome. An independent alarm
retries the release every 30 seconds, with a 15-second bound per attempt. New
admission waits for this journal to settle. The journal is deleted after release
or confirmed loss of ownership, and its alarm is cleared. Constructor recovery
rearms the alarm from the journal after object eviction.

Admission is also fenced in D1. Migration `0056_runtime_admission_fence.sql` adds
`admission_token`, which retains the last consumed run UUID after release. A
claim must consume its previously read token. Finalization consumes the same
token before releasing the run, so Stop can invalidate a claim that has not yet
executed. The old claim cannot become valid after another run finishes. A false
release CAS is conclusive only after that token fence has succeeded. Claim waits are bounded to 15 seconds; a rejection immediately journals its
original failure and runs the same token-fenced release reconciliation. Both writes
run inside BotRuntime; cron continues to dispatch recovery to the object.

## Five-minute inactivity

Progress is scoped to the active run and recorded in DO storage. The explicit
allowlist is tick_started, input, provider_request,
reasoning_message, assistant_message, tool_call, tool_result and compaction.
Injected thoughts (including other Spotlights), monitoring, token estimates,
repair diagnostics, retry scheduling and lease renewal do not count.

Meaningful ephemeral provider content, reasoning and tool-call deltas count
through their callback rather than an appended provider_delta event; SSE heartbeat
bytes do not reach this callback. Stream timestamp writes are coalesced to at
most one per second, storing the time output arrived rather than the flush time.
The alarm flushes any pending sample before reading its durable deadline. An
abrupt instance loss can lose less than one second of coalesced stream progress;
this can make recovery slightly earlier, never later than the five-minute limit.
Provider stream idle timeout remains independently enforced.

The alarm targets last progress plus five minutes. Progress can leave an earlier
alarm armed; that alarm reads the current deadline and reschedules itself. This
avoids racing per-token alarm writes and does not add a five-minute cron polling
delay. D1 leases use the same five-minute duration and the last recorded run
progress. Legacy running rows with no journal retain their pre-upgrade lease and
existing sweep recovery; the new timing/fence contract applies to newly admitted
runs after Worker version convergence.

A transition waiting on external work has a 60-second aggregate deadline across
its sequential KV/D1 setup awaits. A healthy active-run admission collision and
maintenance refusal take a local path before any external wait. The timeout
records terminal intent and arms recovery before `state.abort()` resets the
instance. It does not unlock the queue and allow its suspended closure to resume
alongside a successor. The default alarm retry behavior is retained. Cloudflare
platform failure can prevent immediate execution/logging; durable alarms and the
existing sweep provide recovery when the platform is available again.

## Tool outcomes and cleanup

Tool success and its assistant/tool protocol pair are recorded synchronously
before optional seen-content or human-notification bookkeeping. Each bookkeeping
operation is bounded to 15 seconds, and a failure amends the original event with
a typed diagnostic through the normal event-store accounting and broadcast path.
The monitor displays these diagnostics separately from the successful outcome.
A late bookkeeping failure can amend its own event after completion, but cannot
change its outcome or append stale provider messages.

One `pending_tool_v1` record retains the in-flight tool call. Success/failure
pairing clears it; watchdog or Stop recovery instead records an explicit unknown
outcome pair before publishing the terminal event. A website timeout or missing
response is acceptance-unknown, not a retryable tool refusal. The visit ends and
the participant is told to check the website before repeating the action. No
mutation is automatically replayed. Already-dispatched D1/service requests may
still commit; aborting a wait does not roll back an accepted remote write.

Execution observes cancellation independently of its external awaits, so a binding that ignores cancellation cannot strand the tick caller. Its late promise remains observed and publication remains fenced.

Usage export is bounded and receives cancellation between batches. The active
in-memory slot is cleared before export. A timed-out exporter cannot advance its
cursor or start another batch when its suspended request returns. Ordinary event,
message and payload publishers check an AsyncLocalStorage execution scope
against the current active journal. Late async descendants retain this scope,
so erasing terminal history or pruning it never restores write authority.
Startup migrations and historical adapters have no live execution scope; local
terminal settlement exits it explicitly for only its synchronous transaction. Intentional
bounded diagnostic amendments use their own event-store path.

## Seen-content SQL

Seen writes retain the whole-envelope semantics: all returned thread nodes and
profiles are marked, not only a newly created reply. Input items are deduplicated.
The upsert keeps the earliest first_seen_at and latest last_seen_at. Provenance
(seen_via and source_id, including NULL) follows the newest observation; equal
timestamps retain the existing last-writer behavior. This prevents a timed-out
older write from rolling back a successor visit. Empty input performs no query.

The fixed INSERT SELECT uses json_each with five bound parameters, including a
typed JSON item array and shared fields. Statements are bounded to 1,000 items
and 256 KiB of UTF-8 JSON. Large inputs split into bounded statements, and an
oversized individual item is rejected. SQLite's SELECT/UPSERT ambiguity is
avoided with WHERE true. Real SQLite tests cover more than 14 items, conflicts,
deduplication, empty input, row limits and Unicode byte limits.

Current references consulted:
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/durable-objects/api/state/
- https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- https://developers.cloudflare.com/d1/sql-api/query-json/
- https://developers.cloudflare.com/d1/platform/limits/

## Test deployment smoke plan

Apply migration 0056 before deploying the reviewed Worker. Verify Worker version,
Pages custom-domain bundle convergence and normal health/service-binding checks.
Through the existing Pages test service proxy, use a disposable test participant
to run a normal visit and a deliberately failing provider configuration. Confirm
one terminal result, corresponding D1 status, preserved mutation results and
visible diagnostics. Inspect journal/alarm behavior through the real local DO
integration tests; do not add public failure-injection endpoints. Delete or
restore the disposable test data/configuration. Production is explicitly
authorized for this task after both exact-head approvals and successful test verification; PM retains deployment authority.

Persistent compaction failure journals its required pause intent (owner and
participant revision) alongside terminal failure. Finalization performs this
pause before releasing admission. Retries use a stable per-run idempotency key
and an `If-Match` revision checked under the owner coordinator queue. HTTP 412
settles the intent because a prior attempt applied or a newer owner edit
superseded it; a timeout retains it for alarm recovery. Optional notifications
cannot delay or reorder this account mutation. The visit result remains failed;
the terminal cause does not assert that a pending or superseded pause applied.

Run-start input construction and notification consumption remain bounded by the
overall five-minute watchdog, not individual 15-second cleanup timers. Immediate
Stop records tick_stop_requested once without extending progress. Already
received success is preserved; an in-flight website action is recorded unknown
while the visit stays stopped. A repeated identical unknown reply to the same
target checks the authoritative thread; a visible match is a duplicate, and absence does not grant
permission to replay an accepted-but-unconfirmed request. This pre-dispatch
refusal is self-correctable and does not end the visit. Identical wording to a
different target is not refused.

Async scope API: https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/

All agent-runtime Wrangler configurations and the web test harness explicitly
enable `nodejs_als` for AsyncLocalStorage at their pinned compatibility date.
Release evidence includes a Wrangler deploy dry-run bundle in addition to the
TypeScript/web build; test release verifies Worker health before Pages.
