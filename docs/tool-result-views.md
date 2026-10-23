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

The following readers render a stored view before they consume a tool row.
The inference submission stores the rendered request as an audit snapshot.
A later rename does not rewrite that earlier request snapshot.

1. `runtime/message-store.ts` renders owner message pages, message backfill, and the message attached to a log response.
2. `runtime/bot-runtime.ts` renders active history before it builds each provider request.
3. `runtime/bot-runtime.ts` uses that rendered request for inference submission records.
4. `compaction/selection.ts` reads view-backed rows for message grouping and provider protocol rules.
5. `runtime/bot-runtime.ts` renders rows for token estimates, compaction limits, and compaction input.
6. `runtime/bot-runtime.ts` reads facets from views for the context scope and hydration.
7. `runtime/note-newline-migration.ts` retains its existing one-time reader for old JSON content.

The legacy event formatter still projects old event payloads.
The legacy profile reader examines only tool rows without views.
The old JSON builders in the golden test module record the baseline output for comparison.
WI-D removes that module and its golden comparisons when it replaces JSON with Markdown.

## Time dependency

The integration branch does not yet contain WI-A.
The interim renderer keeps UTC instants and the time of the write.
Its marked formatter preserves the existing relative phrases and gives stable output.
After WI-A merges into the integration branch, merge that branch here and use its participant time formatter.
The participant time configuration remains open until that merge.
