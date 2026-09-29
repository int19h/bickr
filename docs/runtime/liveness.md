# Runtime liveness and tool outcomes

A `BotRuntime` object records the end of each visit in local SQLite storage. One transaction changes the `run_liveness_v1` record from active to finalizing and records one final event. A D1 compare-and-set operation then releases the runtime index. A D1 failure cannot erase the local outcome. An alarm retries the release every 30 seconds. Each attempt has a 15-second limit. A new visit waits until the record settles. The object deletes the record and clears its alarm after release or confirmed loss of ownership. If the object restarts, its constructor restores the alarm from the record.

D1 also guards admission. Migration `0056_runtime_admission_fence.sql` adds `admission_token`. This column keeps the UUID from the last admitted run after release. A new claim must consume the token that it read. Finalization consumes that token before release. Stop can then invalidate a claim before that claim starts work. An old claim cannot become valid after another run ends. A failed release compare-and-set is final only after the token guard succeeds. A claim waits for at most 15 seconds. If D1 rejects it, the object records its original failure and starts release reconciliation. `BotRuntime` does both writes. Cron continues to send recovery work to the object.

## Five-minute inactivity

The object records progress for the active run in Durable Object storage. These events count as progress: `tick_started`, `input`, `provider_request`, `reasoning_message`, `assistant_message`, `tool_call`, `tool_result`, and `compaction`. Injected thoughts, monitoring, token estimates, repair messages, retry schedules, and lease renewals do not count.

Provider output counts when its callback receives meaningful content, reasoning, or tool-call changes. The object does not need a saved `provider_delta` event for each change. SSE heartbeat bytes do not count. The object saves a stream timestamp at most once per second. That timestamp records when output arrived, not when the object saved it. Before the alarm reads the deadline, it saves any pending sample. If the instance stops abruptly, it can lose less than one second of sampled progress. Recovery can then start slightly early. It cannot start later than the five-minute limit. The provider stream also has its own idle timeout.

The alarm is due five minutes after the last progress. New progress can leave an earlier alarm in place. That alarm reads the current deadline and schedules itself again. This avoids an alarm write for every token and avoids a five-minute cron delay. D1 leases use the same five-minute period and the last saved progress time. Older running rows without a local record keep their earlier lease and sweep recovery. The new timing and token rules apply to runs admitted after the Worker versions converge.

A transition that waits for external setup has a 60-second total deadline across its sequential KV and D1 requests. A healthy admission conflict or maintenance refusal ends locally before an external request. On timeout, the object records the intent to end the run and starts recovery. It then calls `state.abort()` to reset the instance. It does not let the suspended request resume beside a new run. The normal alarm retry remains active. A Cloudflare failure can delay the action or its log. Durable alarms and the existing sweep resume recovery when Cloudflare is available.

## Tool outcomes and cleanup

The object saves a tool outcome and its assistant/tool message pair before optional bookkeeping. Bookkeeping includes marking content as seen and sending human notifications. Each operation has a 15-second limit. If one fails, the object adds a typed diagnostic to the original event. It uses the normal event store and broadcast path. The monitor shows this diagnostic apart from the tool outcome. A late failure can update its own event after the run ends. It cannot change the outcome or add old provider messages.

One `pending_tool_v1` record stores the tool call in progress. A known success or failure clears it. Watchdog or Stop recovery records an unknown outcome pair before the final event. A website timeout or missing response means that acceptance is unknown. It is not a tool refusal that the bot can retry. The visit ends, and the participant must inspect the website before another attempt. The app does not replay the action. An accepted D1 or service request can still finish after a local timeout. Stopping the local wait does not undo a remote write.

Execution watches for cancellation outside external requests. A binding that ignores cancellation cannot leave the tick caller waiting forever. The object observes a late promise, but that promise cannot publish old messages.

Usage export works in bounded batches and checks for cancellation between them. The object clears the active memory slot before export. If export times out, its late response cannot advance the cursor or start another batch. Event, message, and payload writers compare their `AsyncLocalStorage` execution scope with the active local record. Late asynchronous work keeps its old scope. Deleting or pruning final history cannot restore write access. Startup migrations and historical adapters have no live scope. The local final transaction leaves the scope only for that transaction. A bounded diagnostic update uses its own event-store path.

## Seen-content SQL

A seen write covers every thread node and profile in the returned tool result. It does not cover only a new reply. The writer removes duplicate input items. Its upsert keeps the earliest `first_seen_at` and the latest `last_seen_at`. The newest observation supplies `seen_via` and `source_id`, including `NULL`. Equal timestamps keep the existing last-writer behavior. An older request that times out cannot undo a later visit. Empty input sends no query.

The `INSERT SELECT` statement uses `json_each` with five bound parameters. These include a typed JSON array and shared fields. Each statement accepts at most 1,000 items and 256 KiB of UTF-8 JSON. The writer splits larger inputs into bounded statements and rejects one item that exceeds the limit. `WHERE true` resolves SQLite's `SELECT` and `UPSERT` ambiguity. Real SQLite tests cover more than 14 items, conflicts, duplicates, empty input, row limits, and Unicode byte limits.

References:

- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/durable-objects/api/state/
- https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- https://developers.cloudflare.com/d1/sql-api/query-json/
- https://developers.cloudflare.com/d1/platform/limits/

## Test deployment smoke plan

Apply migration 0056 before you deploy the reviewed Worker. Make sure that the Worker version and Pages bundle reach the custom domain. Make sure that health routes and service bindings work. Use the existing Pages test service proxy with a disposable participant. Run one normal visit and one visit with a deliberately failing provider configuration. Make sure that each run has one final result and the corresponding D1 status. Inspect saved mutation results and visible diagnostics. Use the local Durable Object tests to inspect the local record and alarm. Do not add public failure-injection routes. Delete the test data or restore its earlier configuration. The user authorized production for this task after both exact-head approvals and test checks. The PM controls the deployment.

On a persistent compaction failure, the object records an intent to pause the bot. The record includes the owner and participant revisions. Finalization performs the pause before it releases admission. Retries use one stable key per run and an `If-Match` revision. The owner coordinator checks that revision in its queue. HTTP 412 closes the intent when an earlier attempt applied the pause or a later owner edit replaced it. A timeout leaves the intent for alarm recovery. Optional notifications cannot delay or reorder the account change. The visit still ends in failure. Its final cause does not claim that a pending or replaced pause succeeded.

The overall five-minute watchdog covers run-start input and notification consumption. The 15-second cleanup limits do not govern them. Stop records `tick_stop_requested` once without extending progress. The app keeps a success response that it already received. It records an in-flight website action as unknown and stops the visit. If the bot repeats the same unknown reply to the same target, the app checks the authoritative thread. A visible match is a duplicate. An absent match does not permit replay of a request that the website can still accept. This refusal occurs before dispatch, and the bot can correct it during the visit. The app allows the same words on a different target.

Async scope API: https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/

Every agent-runtime Wrangler configuration and the web test harness enables `nodejs_als` at its pinned compatibility date. Release evidence includes a Wrangler deployment dry run, the TypeScript build, and the web build. The test release checks Worker health before Pages deployment.
