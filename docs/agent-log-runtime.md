# Agent log storage

The runtime stores each inference attempt before it sends the request. Each attempt holds the exact outgoing body after provider sanitization. Live partial text stays in memory and flushes after one second or 4 KB of new text. Settlement flushes the remaining text. A request groups transport retries and retries after invalid output. The details endpoint reads stored bodies. It never builds them from current history. Each writer rejects stopped visits and erased storage. Finalization settles pending requests and sessions before it releases the visit.

## Live reasoning

`AgentLogStreamDelta` defines content, reasoning, and tool-call deltas. Plain provider reasoning uses `kind: reasoning`, `source: plain`, and `text`. A detail uses `kind: reasoning`, `source: detail`, and `part`. Readable parts contain `kind: readable`, the provider type, and text. Readable deltas also carry top-level `text` for older clients. Only `reasoning.text` and `reasoning.summary` permit text.

Other types produce `kind: opaque` markers with no text or data. Each detail retains its provider `index` and `id` when present. Unknown or absent types remain opaque.

`AgentLogStreamPayload` adds the existing request, attempt, stream, and revision fields. The runtime builds each delta from an explicit field list. Opaque markers with the same type and identity share one partial part. An index takes precedence over an ID. Without either identity, each opaque item counts as a separate part.

The JSON string in `partialResponse` follows `AgentLogPartialResponse`. Its `reasoningParts` array preserves typed parts. Consecutive readable chunks with the same type and identity join in place. The compatibility field `reasoning` contains plain text and readable details in arrival order. Opaque details never enter this field or the text of a completed or interrupted response.

Partial responses share the existing memory cache, flush limits, and retention rule. Exact provider details remain in the existing response store for the details modal. This change adds no table or column.

## Settled reasoning

New stored messages carry `reasoning_format: "readable_v1"` when their text comes from the shared extractor.
Their `reasoning` field contains plain provider text and readable detail parts in arrival order.
Only `reasoning.text` and `reasoning.summary` contribute detail text.

The marker also certifies an empty string when all details are opaque.
The Loop API selects this marker explicitly for `message.reasoning_format`.

The settled extractor uses the same mirror rule as the live formatter.
It joins consecutive plain chunks and consecutive readable chunks with the same identity.
Readable identity uses the type and index, then the ID when no index exists.
Without an index or ID, consecutive chunks of the same readable type share an identity.
A nonempty plain run is a mirror only when an adjacent readable run has exactly the same complete text.
The extractor removes that plain run and keeps the readable detail.

Each readable run can match one plain run, with the following detail preferred over the preceding detail.
Opaque parts block adjacency, and repeated opaque markers with the same identity add no new barrier.
The extractor does not trim text, match substrings, or remove non-adjacent repeats.
Distinct plain reasoning stays even when details exist.
After mirror removal, consecutive runs with the same identity join again.
A blank line separates the remaining readable runs, including runs across opaque barriers.
The runtime and web formatter share this rule in `packages/shared/src/reasoning-formatting.ts`.
The web also normalizes line breaks for display.
The runtime preserves those characters so that provider replay stays unchanged.
Exact provider details and provider replay remain unchanged.
The response size limit bounds the retained stream parts, and mirror extraction runs once at settlement.

No deployed release used the earlier `readable_v1` text, so this fix needs no data migration.
An absent or unknown marker means legacy text.
Readers do not infer a marker from dates, text, or available details.
Recovery preserves the marker from the stored outcome and never certifies an older outcome.
Existing records need no migration and remain unchanged on read.
The marker follows the retention and deletion rules of its message.

Provider replay keeps its existing representation.
When details exist, replay sends those exact details without the combined display text.
Without details, replay sends the original nonempty plain reasoning.
Replay never sends the local marker.

Token estimates also exclude the local marker and display-only reasoning.
This keeps assistant-message replay unchanged while the owner sees all readable text.
It follows the [OpenRouter rule for preserving reasoning details](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning).

The readable compaction view also retains plain reasoning that older versions omitted.

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

`agent_log_partial_reasoning_v1` replaces old flattened partial reasoning with an opaque marker. The old text has no proven readable source. A temporary reader projects the same marker without writing data. The migration changes only partial chunks. It keeps exact response chunks unchanged.

Startup and the fleet retention sweep each visit at most 100 attempts in ID order. A cursor in one `runtime_state` record resumes the next batch. Repeated batches are safe. The cursor record remains until migration retirement.

The status field `partialReasoningPending` reports unfinished work. First retire rollback writers that store flattened partial reasoning. Then use the existing fleet retention job until every participant reports false. At agent log schema version 2, remove this migration, its cursor record, its status field, and the legacy partial reader.

After all migration censuses reach zero, advance the agent log `schemaVersion` from 1 to 2. Remove all migration adapters, their status fields, and the old submission schema and readers. Remove support for pending-tool journals without request references in the same version change. Keep the generic legacy author until its separate census reaches zero through retention or deletion. Then advance the schema version again and remove that author and its display support. Active legacy rows can keep this second census above zero until the owner deletes them.

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
