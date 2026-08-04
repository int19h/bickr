# Serialized entity lifecycle foundation

Phase 1 of issue #140 makes `UserBotsCoordinator` the serialized writer for account and participant mutations and for every owner-initiated world mutation. World documents, world search materialization, intro forums, world avatars, and bot groups are written by `WorldCoordinator` after a one-way call from the user coordinator. The permitted call order is:

`BotRuntime -> UserBotsCoordinator -> WorldCoordinator`

World lifecycle and owner-mutation requests are dispatched to `WorldCoordinator.idFromName(worldId)`. Handles are data, never coordinator identity.

Repository entity writers are private. `userCoordinatorRepositoryMutations`,
`worldCoordinatorRepositoryMutations`, and `coordinatorGovernanceMutations`
are separate narrow capabilities, and a static import-boundary test limits each
capability to its corresponding coordinator implementation. Pages, MCP, CLI,
tests, runtimes, and repository consumers cannot import individual writers.
Account, world, and participant lifecycle orchestration and persisted-request
parsing live in separate `workers/agent-runtime/src/lifecycle/` modules; the
route module is limited to route composition and pre-existing request handlers.

## Lifecycle storage and retention

Migration `0039_entity_lifecycle.sql` adds pending/active/deleting visibility to the legacy entity indexes and one canonical lifecycle machine for accounts, worlds, and participants. An operation records its stable entity id, idempotency key, canonical request hash, revision, typed phase, retry schedule, and typed failure category before external materialization begins.

Canonical entity state and unique-key reservations live only for the active or incomplete entity lifetime. Successful terminal and terminal-failed operation rows retain secret-free request identity and failure metadata for 30 days. The agent-runtime scheduled handler deletes at most 100 expired rows per run through the partial `terminal_cleanup_at` index. No lifecycle query repairs canonical state from KV or index shape.

`entity_lifecycle_identity_claims` is the single D1 uniqueness namespace for
pending and active provider subjects, user handles, world handles, and
world-scoped participant handles. A create reservation acquires a pending
claim. Activation converts it to an active lifetime claim; deletion and
terminal compensation hard-delete it. Active rename/provider-link writers
acquire the replacement claim and update the legacy projection in one D1
batch, so two coordinator instances cannot pass independent availability
checks and steal the same identity. Projection triggers reject writers that do
not hold the matching canonical claim.

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

Legacy rows receive `lifecycle_state = 'active'` in the migration. New rows are inserted as pending and become publicly visible only in the D1 activation batch. A deletion changes visibility to deleting in the same batch that creates the delete operation. Public/authentication/search/runtime readers require active projections.

## Phase 3 extension point

`activateLifecycleEntity` and `finalizeLifecycleDeletion` are the only activation and deletion transactions. Phase 3 must switch `entity_lifecycle_control.activation_mode` under maintenance and pass an `inference_graph` transition to those existing functions:

- account activation supplies the Account-default insert and default-translation-reference insert;
- world and participant activation supplies the fixed-configuration insert;
- deletion supplies the ordered consumer reset/reparent/configuration cleanup statements.

Those statements join the existing projection/visibility operation in one `D1Database.batch()` transaction. Graph-required mode rejects a legacy transition or a missing/mismatched payload, so an account cannot become active without both Account-default statements after the gate changes. Phase 3 must not wrap this layer in a second lifecycle machine.

The `legacy_compatible` transition is the explicit pre-graph adapter. Its retirement path is the Phase 3 maintenance cutover: switch the stored activation mode only after graph tables and migration writers are ready, update callers to provide the typed graph payloads, then remove the legacy transition in the release that removes legacy inference projections.
