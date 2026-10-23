# Tool result views

A view is the typed input for one result template.
Each view selects its fields from a typed tool envelope.
The JSON renderer selects each output field from the view.
The renderer does not copy an internal entity record into participant output.
The view pruner preserves the JSON budget order, protected comments, and body cutoffs.
The Markdown renderer will use the same stored facts.

A tool row stores its view in `tool_result_view_json` and its version in `tool_result_view_version`.
Its `message_json` stores the role and call ID without rendered content.
The write uses the rendered result to calculate `token_estimate`.
The view shares the retention of its loop-message row.
Existing log retention also applies to the logs that capture the original output.

Old rows keep their stored JSON text and have no view.
The readers do not convert these rows.
After the active-row census and WI-F forced compaction, advance the view schema version and remove the legacy readers.
Remove the legacy notification adapter after its notification census also reaches zero.

## Render context

`ResultRenderContext` holds the language catalog, participant time configuration, and handle map for a render.
`buildResultRenderContext` builds it from the participant document and the views that the reader will render.
The context and its time data are read-only.
Every renderer requires a context.

Current rows supply their current handles.
Deleted rows supply their deletion handles when those handles exist.
For a missing row or deletion handle, the renderer uses the saved handle and marks the reference as deleted.
The renderer never uses stored language or time configuration as a fallback.

Each provider request builds one context for its active history.
Owner pages, log responses, and monitor backfill each build a separate context for their selected rows.
Compaction and token estimates receive the context from their caller.
Manual compaction includes all active views so that hydration can render any kept view.

The running visit passes its context to the message store for writes and live broadcasts.
New tool results add their current references without changing existing references in that request.
The store adds no D1 queries for broadcasts.
The timeout handler saves terminal state before recovery loads a context and publishes pending results.

New views omit the former `instructionLocale` and `time` fields.
Existing views can still contain these fields, but the renderer ignores them.
`writtenAt` records when the view and its instant data entered history.
The scope and hydration still read facet state and `contextProfiles`.

## Context and hydration

A facet is one named value on an entity.
The scope uses the entity ID and facet as its key.
A fingerprint is a SHA-256 hash of that value.
The scope treats a value as known only when its fingerprint matches.
An edited value appears again.

The six facets are comment body, thread body, thread title, profile display name, profile bio, and forum description.
A view stores each facet once and refers to it by index.
A known body keeps its fingerprint without another copy of its text.
The JSON renderer repeats names, titles, bios, and descriptions as before.
The Markdown renderer will use their recorded scope state.
A skipped synthetic profile stays on the notification or spotlight view that triggered its lookup.
This preserves the JSON call sequence and gives hydration a kept reference.

Hydration restores a value after compaction removes the view that showed it.
It finds the newest kept view with the same entity, facet, and fingerprint.
It changes that facet from known to shown and saves the view.
It also updates the token estimate from the rendered result.
Rows without views retain the old JSON hydration branch until the census and forced compaction remove them.

## Handles and deletion

Each participant or forum reference holds its internal ID and its handle at the time of the write.
Each provider request resolves the current handles from D1.
The lookup uses one query per table and one JSON binding for all IDs in that table.
The renderer changes the references after a rename.
It keeps authored bodies, notes, and arguments unchanged.

Deleted index rows store `handle_at_deletion` beside the tombstone handle.
The delete writers set both handles in the same write.
The renderer uses the deletion handle and the catalog message `result.reference.deleted`.
The request path does not read KV for a deletion handle.
The new catalog message uses English placeholders until translation review.

The internal endpoint `POST /maintenance/tool-result-handles` copies old deletion handles from KV through the owning coordinators.
It requires internal service authentication and the scheduler header.
It processes at most 25 deleted rows per page and stores no cursor.
Call it with `{}` for the first page.
For each later page, send its `nextCursor` as the `cursor` field.
A null `nextCursor` ends the pass.

Keep each page result as migration evidence.
If a page reports missing IDs, resolve those records and repeat the census from the first page.
A pass with missing IDs does not establish complete coverage.
After both index censuses reach zero, advance the view schema version and delete the endpoint and its backfill functions.
Retain the columns and the delete writers.

## Readers of tool rows

The following readers use stored views or their protocol fields.
Each renderer receives an explicit context.
The inference submission stores the rendered request as an audit snapshot.
A later rename does not rewrite that earlier request snapshot.

1. `runtime/message-store.ts` renders owner message pages, message backfill, and the message attached to a log response.
2. `runtime/bot-runtime.ts` renders active history before it builds each provider request.
3. `runtime/bot-runtime.ts` uses that rendered request for inference submission records.
4. `compaction/selection.ts` renders rows for reduced-batch estimates. Protocol grouping and provider normalization read only stored roles and call IDs.
5. `runtime/bot-runtime.ts` renders rows for token estimates, compaction limits, and compaction input.
6. `runtime/bot-runtime.ts` reads facets from views for the context scope and hydration.
7. `runtime/note-newline-migration.ts` retains its existing one-time reader for old JSON content.

The legacy event formatter still projects old event payloads.
The legacy profile reader examines only tool rows without views.
The old JSON builders in the golden test module record the baseline output for comparison.
WI-D removes that module and its golden comparisons when it replaces JSON with Markdown.

## Participant time

The renderer uses WI-A's `formatParticipantTime` function.
A view keeps UTC instants.
The render context supplies the account creation time.
Each provider request supplies the current participant time configuration.
A configuration change re-renders the timestamps in stored views.
Old rows retain their stored text.

## Retirement

A retirement gate is evidence that old data no longer needs a reader.
Keep every adapter below until its gate passes across the full fleet.
Retire rollback releases that write an old shape before accepting its zero count.
A failed, deferred, or incomplete census does not satisfy a gate.
This work item removes none of these adapters.

The view schema version is `toolResultViewSchemaVersion = 1`.
Its next version is 2.
A version change must include an explicit upgrade for surviving views or a reader for their unchanged shape.
Do not change the constant alone because the current reader rejects other stored versions.
The shared document schema version is `schemaVersion = 2`.
Its next version is 3.

The following temporary paths have separate gates:

| Temporary path | Census that must reach zero | Version and removal |
| --- | --- | --- |
| WI-A: `participantTimeSettingsOf` fallback for absent `timeSettings` and old `openRouter.datetime` | Complete `/maintenance/participant-time` passes with no missing time configuration or old datetime fields | Advance document schema 2 to 3, require `timeSettings`, and remove the fallback. Keep the formatter. |
| WI-A: `migrateParticipantTime`, `/maintenance/participant-time`, `/users/:userId/bots/:botId/normalize-time`, the `participant_time` callback in `normalizeKvDocuments`, and `participantTimeSweepCursor` | The same participant time census, with no deferred records and no old writers | Advance document schema 2 to 3 and remove these migration paths together. Delete the stored sweep cursor. Keep rejection of removed datetime inputs. |
| WI-C: The no-view branch in `renderStoredLoopMessage`, including owner pages, provider history, compaction input, and token estimates | `/maintenance/legacy-history/census` reports zero on every page after forced compaction | Advance view schema 1 to 2 and remove active-history JSON branches. Keep archive support until the retained-row census below also reaches zero. |
| WI-C: `legacyResultFacets`, `legacyProfileUsernamesInActiveContext`, old JSON content-scope readers, `compactedCommentBodies`, and `repairDanglingCommentReferencesAfterCompaction` | The same zero active-row census | Advance view schema 1 to 2 and remove the legacy scope and hydration paths. Keep facet hydration for views. |
| WI-C and WI-D: `providerLegacyInputPayload`, `providerLegacyToolResultPayload`, `formatRuntimeEventForContext` and `migrateLegacyLoopMessages`, and old event-to-history formatting | The runtime localization census reports every `legacyHistoryDone`, and the active-row census reports zero | Advance view schema 1 to 2 when removing tool-result history adapters. Advance runtime localization schema 1 to 2 when removing the startup event migration. Keep owner event formatting until its retained-row census passes. |
| WI-C and WI-D: `legacyToolResultEnvelope`, `legacyStoredToolResultEnvelope`, `legacyReadContentFocus`, and old shape readers retained by legacy result formatting | Zero active legacy rows plus zero retained event or tool rows that need those readers | Advance view schema 1 to 2 and remove the adapters and their legacy-only callers. A caller audit must establish that new writers supply typed envelopes. |
| WI-C and WI-D: `legacyNotificationView`, `LegacyNotificationView`, `legacyNotificationEvent`, its type and delivery adapters, `providerLegacyNotificationEvent`, its target adapters, and legacy renderer branches | A bounded notification census reports zero old pending notification payloads, and a stored-view census reports zero legacy notification items | Advance view schema 1 to 2 and remove the notification adapters and renderer branches together. The active no-view census does not cover legacy items inside views. |
| WI-C: `backfillDeletedReferenceHandles`, `backfillOwnedDeletedReferenceHandle`, `deletedReferenceHandle` repair dispatch, and `/maintenance/tool-result-handles` | Both deleted-handle index censuses report zero missing `handle_at_deletion` values | Advance view schema 1 to 2 and remove the backfill and repair branches. Keep the deletion columns, retention rules, and atomic delete writers. |
| WI-C and WI-D: The JSON renderer, old JSON builders in `tool-result-golden-builders.test-support.ts`, and their golden comparisons | A caller census reports zero production callers after the Markdown renderer replaces them | Remove the old builders and comparisons in WI-D. This code-only removal needs no stored schema change. Keep live old-row adapters until their data gates pass. |
| WI-F: `legacyToolRowCount`, `compactLegacyHistory`, legacy-only accounting arguments in compaction methods, and `/maintenance/legacy-history/{census,compact}` | A complete zero active-row census after forced compaction, with no deferred or failed runtimes | Advance view schema 1 to 2 and remove these routes, methods, and `legacy-history-maintenance.ts` together. Keep the shared fleet paging helper and normal automatic compaction. |

The participant time sweep stores its own cursor and reports `done` only after a pass without deferrals.
Retain each pass as evidence.
The deleted-handle route visits missing index values directly.
Complete both participant and forum pages without `missingIds` before accepting its zero count.
An empty pass from the first cursor proves that neither index retains missing handles.

The existing bootstrap census covers composed bootstrap payloads only.
It does not prove that all other notification kinds use the new shape.
Before removing the notification adapters, add a bounded census for those pending payloads and stored legacy notification items.
Keep the adapters while that census remains unavailable.

The active history census excludes compacted and deleted rows.
Owner pages and retained event history can still read those rows.
Before removing the shared legacy reader, run a bounded census of retained no-view tool rows and legacy events.
Wait until retention removes those rows and the count reaches zero.
If that retained-row census is unavailable, keep the archive reader separate from the active provider path.
A zero active count alone does not authorize deletion of archive support.

The removed generic failure narration and unused catalog keys from WI-D need no data migration.
Their removal takes effect for new failures.
Old assistant narration stays until normal compaction or retention removes it.
The participant-facing failure result and the self-correction narration remain.

Keep the saved-handle fallback for a missing entity or deletion handle.
That fallback represents unavailable reference data and does not migrate stored records.
