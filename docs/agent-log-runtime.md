# Agent log storage

The runtime stores each inference attempt before it sends the request. Each attempt holds the exact outgoing body after provider sanitization. Live partial text stays in memory and flushes after one second or 4 KB of new text. Settlement flushes the remaining text. A request groups transport retries and retries after invalid output. The details endpoint reads stored bodies. It never builds them from current history. Each writer rejects stopped visits and erased storage. Finalization settles pending requests and sessions before it releases the visit.

## Tables and retention

`inference_requests` holds request identity, state, purpose, and references to history. `inference_attempts` holds attempt times, outcomes, and the partial response. `inference_body_chunks` holds the encoded bodies and chunks for responses and partial text. The encoding saves the common prefix from the previous attempt. A full body starts a new chain after 16 delta links. Text cuts keep surrogate pairs together. Before retention removes a base, the runtime writes each surviving dependent as a full body.

These three tables stay for the newest three pages. Beyond those pages, the retention alarm removes records after seven days. The same rule applies to raw logs and their chunks.

Raw logs also start a full record after 16 delta links. Pending requests stay until completion or recovery. On restart, the runtime marks interrupted requests as failed.

`compaction_sessions` holds the trigger, starting position, and outcome. Successful and partly successful sessions stay while their summary rows exist. Failed sessions stay on the newest three pages. Beyond those pages, failed sessions expire after 14 days. Request records and bodies follow the separate seven-day rule.

The `author_json`, `request_id`, and `session_id` columns belong to `loop_messages`. Each column follows its row's retention. New synthetic assistant rows require an explicit source. Retention keeps compacted ordinary rows on the newest three pages. Outside those pages, compacted ordinary rows expire after 14 days, summaries after 180 days, and deleted rows after 14 days.

Each successful compaction batch commits its summary at once. If a later batch fails, the session records partial success, its summary rows, the failed batch count, and the typed error. A fully failed session creates no page. Provider attempts and their errors remain available after failure. Deleting an archived summary moves its children into the parent archive. It does not restore them to the model context.

## Migrations and removal

`agent_log_request_store_v1` moves exact `provider_request` and `compaction_request` logs into the new store. It preserves their stored bodies and removes the old copies. The migration does not copy messages from `inference_submissions`. The old table receives no new writes. The retirement sweep removes its rows after seven days.

`agent_log_authors_v1` assigns authors from stored origins and roles. Stored tool calls prove a synthetic call source. Other old synthetic assistant rows receive `legacy_synthetic`. The runtime never infers a source from message text. A temporary read adapter labels rows that await the bounded migration. It never writes data during a read.

Startup and the existing retention sweep each process at most 100 author rows and 100 exact logs per visit. The status endpoint returns `agentLogMigrations`. Use the existing fleet retention job to visit participants that no longer run. Continue the sweep until every participant reports no pending migration and no old submissions.

During the fleet sweep, call `POST /bots/<id>/recover-stale-run` to settle old pending-tool journals. `legacyPendingRequestsRemain` reports journals without request references. New journals carry the request ID and event sequence into recovery.

After that census reaches zero, advance the agent log `schemaVersion` from 1 to 2. Remove both migration adapters, their status fields, and the old submission schema and readers. Remove support for pending-tool journals without request references in the same version change. Keep the generic legacy author until its separate census reaches zero through retention or deletion. Then advance the schema version again and remove that author and its display support. Active legacy rows can keep this second census above zero until the owner deletes them.

## API and page behavior

Page reads load authors, references, and attempt summaries in batches.

The messages response includes typed `entries` beside the existing `messages` field. Each entry has a `kind`: `message`, `live`, or `notice`. Message entries carry their stored author, request reference, session reference, and attempt summary.

Live entries carry the request ID. During an active visit, a completed response stays live until its first tool result creates the response row. That live entry carries the full response in `response`. Notices describe errors, failed requests, dropped output, and compaction sessions.

`GET /bots/<id>/requests/<request-id>` returns a stored request with its attempts. Each attempt exposes its body and outcome. The main details view selects the successful attempt. Failed attempts expose their own bodies. Older entries without an exact body say that the request is not retained.

`GET /bots/<id>/compaction-sessions/<session-id>` returns a session and its retained requests. `GET /bots/<id>/submissions` reads the new request store. Page summaries identify the newest page and its starting session. Delete responses include `changedContext`.

The web page keeps its current message rows and page controls. It handles all entry kinds and shows a plain notice for unknown kinds. An unknown stored author becomes an explicit `unknown` author for that entry. Other entries remain visible. Request and session details contain unsupported failure outcomes. Other unsupported metadata still returns a bounded error. The new visual design remains a separate task.

## Response publication

The runtime stores one unfinished response reference in `runtime_state` under `pending_response_v1`. The same transaction settles its request and records its pending calls. This reference points to the stored response chunks. It does not copy the response body. History writes retire each call and link the assistant row in the same transaction. Recovery creates interrupted results for all remaining calls.

The runtime removes the reference after publication, recovery, or history deletion. It retains at most one reference per participant.

Live entries and stream events carry an attempt ID and a delta revision. The revision counts updates within that attempt. A page snapshot replaces older live entries. The client adds only updates that arrive after the snapshot request starts and exceed its revision. Terminal run events remove the live entry.

## Attempt details

The nullable `usage_id` and `attribution_json` columns share the retention of their attempt. The runtime writes attribution when it receives a response or settles a failure. It writes the exact usage reference and final request state in the same transaction that inserts that usage row. A usage row belongs to at most one attempt. Reads load usage for all attempts in a request together.

Old attempts keep null references. The runtime does not infer ownership from an event sequence or repair references on read. If a usage row expires, its attempt returns null usage and no cache chips. Attribution stays with its attempt until request retention removes it.

The attempt API returns usage, attribution, and request messages from this store. Each message has its provider position and an optional cache status. The modal uses these attempt fields. It does not read request messages, usage, or attribution from raw logs. The exact body stays unchanged.

The runtime stores response usage before any lookup for a provider name. That lookup updates only the provider name on the same usage row. It cannot delay usage or change the usage returned for a final request. The store rejects new usage links after request completion.

## Failure causes

Persistent compaction reduction failures retain the `non_reducing_compaction` validation issue and the error message. Other typed validation, timeout, and interruption errors keep their matching failure kinds. Local failures use `runtime_error`. Only provider request errors use `provider_error`. Existing stored outcomes keep their original values.

## Rollback

Version `1f1bf34d` cannot read stored `runtime_error` outcomes. Test ran that version, which rejects these outcomes with HTTP 409. One such outcome can block the history page in that version.

Production must receive the agent log runtime, the web redesign, and this change in one release. This keeps every production reader able to read `runtime_error`.

Readers from this change on return an explicit `unknown` failure for unsupported or invalid stored outcomes. Other attempts, sessions, and history entries remain readable. The client shows “Unknown failure”. Writers still reject unknown or invalid outcomes. Reads do not rewrite stored data.

## Manual compaction

Manual compaction returns HTTP 422 with a typed `compactionFailure` for known validation failures. The response for `non_reducing_compaction` says that compaction cannot produce a shorter summary. It does not claim that the participant is paused. A failed batch can retain earlier summaries, but the POST still returns an error. Timeouts return HTTP 408, interruptions return HTTP 409, and upstream provider failures return HTTP 502.

A manual request with no active history or only one previous summary returns a zero count without a provider call or a new session. New history after a summary remains eligible. Automatic context admission can still shorten a summary when the context budget requires it. A batch run that produces no summary returns an error.

Owner messages use structured failure kinds, validation issues, and HTTP statuses. Session logs keep diagnostic text. Connection failures and refused redirects carry typed upstream causes. A missing summary keeps `missing_compaction_summary` in both the session and the HTTP response.

Connection failures during response body reads keep the same typed cause as failures before the headers arrive. This rule covers JSON and streaming responses. Body readers retain their timeout and stop causes before they cancel the underlying stream.
