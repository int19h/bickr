# Serialized entity lifecycle foundation

Phase 1 of issue #140 makes `UserBotsCoordinator` the serialized writer for account and participant mutations and for every owner-initiated world mutation. World documents, world search materialization, intro forums, world avatars, and bot groups are written by `WorldCoordinator` after a one-way call from the user coordinator. The permitted call order is:

`BotRuntime -> UserBotsCoordinator -> WorldCoordinator`

World lifecycle and owner-mutation requests are dispatched to `WorldCoordinator.idFromName(worldId)`. Handles are data, never coordinator identity.

Repository entity writers are private. `accountBootstrapReservationRepositoryMutations`, `userCoordinatorRepositoryMutations`,
`worldCoordinatorRepositoryMutations`, and `coordinatorGovernanceMutations`
are separate narrow capabilities, and a static import-boundary test limits each
capability to its corresponding coordinator implementation. Pages, MCP, CLI,
tests, runtimes, and repository consumers cannot import individual writers.
The boundary test follows writer authority through local aliases, default and
named exports, namespace/destructuring aliases, `export *` barrels, dynamic
imports, and downstream modules across the supported TypeScript and JavaScript
module extensions. Its fixed expected writer inventory is independent of the
capability objects, so deleting a capability member cannot turn that writer
into an ungoverned export.
Account, world, and participant lifecycle orchestration and persisted-request
parsing live in separate `workers/agent-runtime/src/lifecycle/` modules; the
route module is limited to route composition and pre-existing request handlers.

Account bootstrap has one intentional pre-coordinator D1 capability because a
new provider subject has no user coordinator identity yet. The default Worker
atomically creates or joins the provider-subject claim, stable user ID, and
pending lifecycle operation before calling `USER_BOTS.idFromName(userId)`.
Every concurrent or retried login for that pending subject dispatches the same
stored operation to the same named coordinator. The coordinator validates the
operation ID and a canonical request hash containing only the normalized
provider and subject, then resumes materialization; it cannot allocate or
reserve a new account through its internal route. Provider login, display name,
email, and avatar URL are deliberately excluded from reservation identity. A
retry overlays their latest normalized values while preserving the reserved
user ID, handle, and timestamps, and an already-activated concurrent replay
refreshes its provider-identity projection. Active claims are dispatchable only
when provider identity and the active user projection agree, so a login racing
account deletion receives a typed conflict.

## Lifecycle storage and retention

Migration `0039_entity_lifecycle.sql` adds pending/active/deleting visibility to the legacy entity indexes and one canonical lifecycle machine for accounts, worlds, and participants. An operation records its stable entity id, idempotency key, canonical request hash, revision, typed phase, retry schedule, and typed failure category before external materialization begins.

Migration `0040_entity_lifecycle_recovery.sql` adds a derived, lifetime-bounded
recovery projection with exactly one row per owner that has nonterminal work.
Operation triggers update or remove that row in the same D1 transaction as
every canonical phase write, selecting one owner's earliest operation through
the partial `(owner_user_id, COALESCE(next_retry_at, updated_at), operation_id)`
index with `LIMIT 1`. This is the write-ahead recovery guarantee for a
Worker interruption between a D1 commit and Durable Object alarm storage,
including the provider-subject reservation that exists before a user
coordinator can be named. The five-minute agent-runtime cron atomically leases
at most 25 due owners through the `(due_at, lease_expires_at, owner_user_id)`
index and dispatches each stable owner ID to its `UserBotsCoordinator`. A failed
owner retains its short lease while sibling owners continue, so poison work
cannot permanently occupy the front of every bounded page. A subsequent phase
write clears the lease; process death after claiming is recovered when the
lease expires. Maintenance mode claims and dispatches nothing, while the
coordinator boundary independently rechecks maintenance and internal service
authentication.
Terminal-history cleanup is deliberately excluded from the recovery trigger:
deleting an expired terminal row cannot shorten or clear an active lease for
the same owner's unrelated nonterminal work. Genuine nonterminal changes still
rederive the projection in the same transaction.

Canonical entity state and unique-key reservations live only for the active or incomplete entity lifetime. Successful terminal and terminal-failed operation rows retain secret-free request identity and failure metadata for 30 days. Completed account deletions additionally retain one typed count-only `account_delete_complete` result for those same 30 days, so an idempotent replay returns the exact durable `deleted` summary after `request_json` is erased. That result cannot store profile, provider, credential, world, or participant request data; a table constraint limits it to terminal account-delete rows. The agent-runtime scheduled handler deletes at most 100 expired rows per run through the partial `terminal_cleanup_at` index. No lifecycle query repairs canonical state from KV or index shape.

`entity_lifecycle_identity_claims` is the single D1 uniqueness namespace for
pending and active provider subjects, user handles, world handles, and
world-scoped participant handles. A create reservation acquires a pending
claim. Activation converts it to an active lifetime claim; deletion and
terminal compensation hard-delete it. Active rename/provider-link writers
acquire the replacement claim and update the legacy projection in one D1
batch, so two coordinator instances cannot pass independent availability
checks and steal the same identity. Projection triggers reject writers that do
not hold the matching canonical claim. The trigger also covers
`lifecycle_state` changes: a same-ID tombstone recreation can only be written
as pending with its pending claim, and activation promotes that claim before
exposing the projection as active in the same D1 batch.

Participant create request JSON is credential-free by construction. A supplied
OpenRouter key is held in the typed `entity_lifecycle_secrets` bridge only for
the nonterminal operation, survives materialization retry, and is hard-deleted
in the activation or compensation batch. Phase 3 retires this bridge when the
same lifecycle transition installs the permanent configuration-secret row; it
must not add another lifecycle secret mechanism.

World and participant create requests persist the reservation timestamp beside
their stable entity and deterministic forum IDs. Every retry reuses those
values, so documents, forums, runtime rows, and revisions do not drift. Chirper
avatar imports use a deterministic R2 key; a retry first resumes from that
immutable object and never re-fetches a mutable remote URL after the snapshot
has been stored.

Account deletion may abort a terminal failure only at its initial D1 hide
checkpoint, before any child coordinator or account-storage effect is invoked.
The hide reservation is also an atomic owner-ordering barrier: it refuses to
start while that owner has an earlier nonterminal create or delete operation,
using the existing owner/phase index. It also joins owned worlds to canonical
world-scoped participant claims and refuses the hide while any pending, active,
or deleting foreign-owned participant claim remains. A direct world hide
similarly requires that no participant claim remains in that world. Conversely,
participant and clone reservation atomically require the participant owner,
target world, and target world's owning account to remain active while the
operation and pending claim are inserted. Every delete projection hide is
conditioned on that operation insert in the same D1 batch. The world-scope
claim index and owned-world index make these set-oriented guards bounded by an
indexed existence lookup. Thus whichever reservation wins commits the only
legal ordering: a participant claim keeps account/world deletion uncommitted,
while a committed delete hide prevents any later participant operation or
claim even if its earlier eligibility/world read was stale.
After cascade execution starts, every failure keeps the parent hidden and is
recorded as convergence-required retryable while preserving the originating
typed failure code. Each parent attempt spends one configured fixed budget
across both resumed nonterminal child operations and newly discovered active
bots, external-world forums, or worlds. New discovery is a set-oriented D1
sequence under the shared child budget: participant and world lookups use
dedicated owner/lifecycle/handle indexes, while the external-forum join sees
only a materialized, indexed, limited candidate CTE. It never materializes an
owner-wide list or performs an unbounded first-attempt fan-out. Account-cascade
participant deletes explicitly allow linked clone removal, so a resumed source
deletion does not depend on clone depth or child ID ordering. The prefix lookup
is a bounded range scan on the existing unique `(owner_user_id,
idempotency_key)` index. If any hidden child remains, the parent stays deleting
with the typed `account_delete_children_remaining`
continuation code, schedules its alarm, and returns without replanning active
children or finalizing the account. A later attempt resumes the next bounded
batch, so a child tombstone cannot be skipped merely because public readers
correctly hide it and one Worker request never drains an unbounded backlog.
Account deletion convergence has no retry-exhaustion compensation transition:
after cascade execution begins, an irreversible child side effect may already
exist, so retries remain deleting until they converge and retain the original
typed failure code.

The internal delete route reports `account_delete_pending` with HTTP 202 while
bounded continuation remains, and `account_delete_complete` with HTTP 200 only
after the terminal batch. The pending variant reports only `planned` counts;
only the completed variant labels those counts as `deleted`. Both are
successful typed outcomes. The Pages
adapter clears the session cookie for either outcome and the web client clears
its authenticated state immediately. It reports `Profile deletion accepted.`
for pending convergence and `Deleted profile.` only for the completed result;
scheduled recovery or an owner alarm
continues a pending deletion independently of that browser request.

Legacy rows receive `lifecycle_state = 'active'` in the migration. New rows are inserted as pending and become publicly visible only in the D1 activation batch. A deletion changes visibility to deleting in the same batch that creates the delete operation. Public/authentication/search/runtime readers require active projections.

`worldForUpdateMutation` is a narrowly typed Phase 1 request-routing adapter,
not a public reader or a repair writer. It recognizes only a replay where the
atomic D1 handle claim/projection batch committed but the stable-ID KV write did
not, and routes that same request to the already selected world coordinator.
Its retirement point is the Phase 3 extension of this lifecycle operation row
with a revisioned update action: persist the stable world ID, old/new handles,
and document revision before the D1 claim batch, resume it through the same
global recovery projection, then delete this adapter. Phase 3 must extend the
existing machine rather than add a rename-specific lifecycle machine.

## Phase 3 extension point

`activateLifecycleEntity` and the typed `finalizeLifecycleDeletion` transaction family (including `finalizeAccountLifecycleDeletion`, which also writes the count-only terminal result) are the only activation and deletion transactions. Phase 3 must switch `entity_lifecycle_control.activation_mode` under maintenance and pass an `inference_graph` transition to those existing functions:

- account activation supplies the Account-default insert and default-translation-reference insert;
- world and participant activation supplies the fixed-configuration insert;
- deletion supplies the ordered consumer reset/reparent/configuration cleanup statements.

Those statements join the existing projection/visibility operation in one `D1Database.batch()` transaction. Graph-required mode rejects a legacy transition or a missing/mismatched payload, so an account cannot become active without both Account-default statements after the gate changes. Phase 3 must not wrap this layer in a second lifecycle machine.

The `legacy_compatible` transition is the explicit pre-graph adapter. Its retirement path is the Phase 3 maintenance cutover: switch the stored activation mode only after graph tables and migration writers are ready, update callers to provide the typed graph payloads, then remove the legacy transition in the release that removes legacy inference projections.
