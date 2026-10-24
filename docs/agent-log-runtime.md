# Agent log storage

The runtime stores each inference attempt before it sends the request. Each attempt holds the exact outgoing body after provider sanitization. A request groups transport retries and retries after invalid output. The details endpoint reads stored bodies. It never builds them from current history. Each writer rejects stopped visits and erased storage. Finalization settles pending requests and sessions before it releases the visit.

## Tables and retention

`inference_requests` holds request identity, state, purpose, and references to history. `inference_attempts` holds attempt times, outcomes, and the partial response. `inference_body_chunks` holds the encoded bodies and chunks for responses and partial text. The encoding saves the common prefix from the previous attempt. Before retention removes a base, the runtime writes each surviving dependent as a full body.

These three tables stay for the newest three pages. Beyond those pages, the retention alarm removes records after seven days. The same rule applies to raw logs and their chunks. Pending requests stay until completion or recovery. On restart, the runtime marks interrupted requests as failed.

`compaction_sessions` holds the trigger, starting position, and outcome. Successful sessions stay while their summary rows exist. Failed sessions stay on the newest three pages. Beyond those pages, failed sessions expire after 14 days. Request records and bodies follow the separate seven-day rule.

The `author_json`, `request_id`, and `session_id` columns belong to `loop_messages`. Each column follows its row's retention. New synthetic assistant rows require an explicit source. Retention keeps compacted ordinary rows on the newest three pages. Outside those pages, compacted ordinary rows expire after 14 days, summaries after 180 days, and deleted rows after 14 days.

The runtime stages batch changes until every compaction batch succeeds. A failed session creates no page. Provider attempts and their errors remain available after failure. Deleting an archived summary moves its children into the parent archive. It does not restore them to the model context.

## Migrations and removal

`agent_log_request_store_v1` moves exact `provider_request` and `compaction_request` logs into the new store. It preserves their stored bodies and removes the old copies. The migration does not copy messages from `inference_submissions`. The old table receives no new writes. The retirement sweep removes its rows after seven days.

`agent_log_authors_v1` assigns authors from stored origins and roles. Stored tool calls prove a synthetic call source. Other old synthetic assistant rows receive `legacy_synthetic`. The runtime never infers a source from message text. A temporary read adapter labels rows that await the bounded migration. It never writes data during a read.

Startup and the existing retention sweep each process at most 100 author rows and 100 exact logs per visit. The status endpoint returns `agentLogMigrations`. Use the existing fleet retention job to visit participants that no longer run. Continue the sweep until every participant reports no pending migration and no old submissions.

After that census reaches zero, advance the agent log `schemaVersion` from 1 to 2. Remove both migration adapters, their status fields, and the old submission schema and readers. Keep the generic legacy author until its separate census reaches zero through retention or deletion. Then advance the schema version again and remove that author and its display support. Active legacy rows can keep this second census above zero until the owner deletes them.

## API and page behavior

The messages response includes typed `entries` beside the existing `messages` field. Each entry has a `kind`: `message`, `live`, or `notice`. Message entries carry their stored author, request reference, session reference, and attempt summary. Live entries carry the request ID. Notices describe errors, failed requests, dropped output, and compaction sessions.

`GET /bots/<id>/requests/<request-id>` returns a stored request with its attempts. Each attempt exposes its body and outcome. The main details view selects the successful attempt. Failed attempts expose their own bodies. Older entries without an exact body say that the request is not retained.

`GET /bots/<id>/compaction-sessions/<session-id>` returns a session and its retained requests. `GET /bots/<id>/submissions` reads the new request store. Page summaries identify the newest page and its starting session. Delete responses include `changedContext`.

The web page keeps its current message rows and page controls. It handles all entry kinds and shows a plain notice for unknown kinds. The new visual design remains a separate task.
