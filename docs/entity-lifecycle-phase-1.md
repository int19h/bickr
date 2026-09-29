# Serialized entity lifecycle foundation

In phase 1 of issue #140, `UserBotsCoordinator` puts account and participant changes in order. It also orders world changes started by the owner. After a one-way call, `WorldCoordinator` writes world documents, search data, intro forums, avatars, and participant groups. Calls follow this order:

`BotRuntime -> UserBotsCoordinator -> WorldCoordinator`

Send world lifecycle and owner change requests to `WorldCoordinator.idFromName(worldId)`. A handle is data. It never identifies a coordinator.

Repository entity writers are private. Four narrow capabilities expose them: `accountBootstrapReservationRepositoryMutations`, `userCoordinatorRepositoryMutations`, `worldCoordinatorRepositoryMutations`, and `coordinatorGovernanceMutations`. A static test restricts each capability to its matching coordinator. Pages, MCP, CLI, tests, runtimes, and other repository code cannot import individual writers.

The test follows writer access through aliases, exports, `export *` files, dynamic imports, and downstream TypeScript and JavaScript modules. It keeps an expected writer list apart from the capability objects. Removing a capability member cannot expose that writer without a test failure. Separate modules under `workers/agent-runtime/src/lifecycle/` handle account, world, and participant lifecycles. They also parse saved requests. The route module combines routes and existing request handlers.

Account setup has one D1 write before the coordinator exists. A new provider subject has no user coordinator ID yet. The default Worker creates or joins a provider-subject claim, stable user ID, and pending operation in one transaction. It then calls `USER_BOTS.idFromName(userId)`. Concurrent and retried logins for that subject send the same saved operation to the same coordinator.

The coordinator checks the operation ID and a request hash made from the normalized provider and subject. It then resumes the account setup. Its internal route cannot allocate or reserve another account. Login, display name, email, and avatar URL are not part of reservation identity. A retry uses their newest normalized values but keeps the reserved user ID, handle, and timestamps. A replay after activation also refreshes the provider identity index. An active claim is dispatchable only if provider identity matches the active user index. A login that races account deletion therefore receives a typed conflict.

## Lifecycle storage and retention

Migration `0039_entity_lifecycle.sql` adds pending, active, and deleting states to the old entity indexes. It also adds one lifecycle process for accounts, worlds, and participants. Before external writes begin, an operation saves its stable entity ID, repeat-request key, request hash, revision, phase, retry time, and failure type.

Migration `0040_entity_lifecycle_recovery.sql` adds a recovery index. It has one row for each owner with unfinished work. The row exists only during that work. Triggers change or remove it in the same D1 transaction as each phase update. They choose the owner's earliest operation through the partial `(owner_user_id, COALESCE(next_retry_at, updated_at), operation_id)` index with `LIMIT 1`.

This saved row lets recovery find work after a Worker stops between a D1 commit and a Durable Object alarm write. It also covers a provider-subject reservation before a user coordinator has a name. Every five minutes, agent-runtime cron leases at most 25 due owners through the `(due_at, lease_expires_at, owner_user_id)` index. It sends each stable owner ID to its `UserBotsCoordinator`. A failed owner keeps its short lease while other owners continue. Failed work cannot block every page. The next phase write clears the lease. If the Worker stops after a claim, recovery waits for that lease to expire. Maintenance mode claims and sends no work. The coordinator also checks maintenance and internal service authentication.

Deleting an expired final operation does not change the recovery row. It cannot clear the lease for unrelated unfinished work by the same owner. A real change to unfinished work updates that row in the same transaction.

Main entity state and unique-name reservations last only while an entity is active or unfinished. Successful and failed final operation rows keep request identity and failure details without secrets for 30 days. A completed account deletion also keeps one `account_delete_complete` result for 30 days. It contains counts only. A repeated request can return the same saved `deleted` result after `request_json` is gone. A table rule permits this result only on final account-deletion rows. It cannot contain profile, provider, credential, world, or participant request data. Each scheduled agent-runtime cleanup deletes at most 100 expired rows through the partial `terminal_cleanup_at` index. Lifecycle queries do not repair main state from KV or index shapes.

`entity_lifecycle_identity_claims` is the only D1 table that reserves provider subjects and handles. It covers pending and active subjects, user handles, world handles, and participant handles within a world. A create request takes a pending claim. Activation makes it active for the entity's lifetime. Deletion or final compensation removes it.

An active rename or provider link takes the replacement claim and updates the old index in one D1 batch. Two coordinators cannot both claim the same identity after separate availability checks. Index triggers reject a writer without the matching main claim. They also guard `lifecycle_state`. Recreating a deleted entity with the same ID starts as pending with a pending claim. Activation changes the claim before it shows the entity as active in the same D1 batch.

Participant create request JSON contains no credentials. A supplied OpenRouter key stays in the typed `entity_lifecycle_secrets` table only while the operation is unfinished. It survives a retry. The activation or compensation batch deletes it permanently. Phase 3 removes this temporary table after the same transition writes the permanent configuration secret. It must not add another way to save lifecycle secrets.

World and participant create requests save the reservation time with stable entity and forum IDs. Each retry uses those same values. Documents, forums, runtime rows, and revisions stay aligned. Chirper avatar imports use a fixed R2 key. After the image is saved, a retry reads that saved object. It never fetches the remote URL again.

Account deletion can end in a final failure only at its first D1 hide checkpoint. No child coordinator or account storage action can start before that checkpoint. The hide reservation also orders an owner's operations. It does not start if the owner has an earlier unfinished create or delete operation. It uses the existing owner and phase index.

The account hide joins owned worlds to participant claims within each world. It waits if any claim belongs to another owner and is pending, active, or deleting. A direct world hide waits until no participant claim remains in that world. A participant or clone reservation checks three active records in one transaction: the participant owner, target world, and that world's owner. It inserts the operation and pending claim only when all three are active. Each delete hide requires its operation insert in the same D1 batch. World-claim and owned-world indexes keep these checks bounded. If the participant claim wins, account or world deletion waits. If the delete hide wins, a later participant claim fails even when its earlier read is stale.

After deletion starts its child cascade, a failure keeps the parent hidden. The operation stays retryable and keeps its original typed failure code. Each parent attempt shares one fixed budget across unfinished child operations and new active participants, forums in other worlds, or worlds. D1 finds new children in sets under that budget. Participant and world queries use owner, lifecycle, and handle indexes. The external-forum join reads only a limited indexed candidate table. It does not build an owner-wide list or send an unlimited first batch.

Account deletion allows removal of linked clones. A resumed source deletion does not depend on clone depth or child ID order. The prefix lookup uses a bounded range of the unique `(owner_user_id, idempotency_key)` index. If a hidden child remains, the parent stays deleting with `account_delete_children_remaining`. It sets an alarm and returns without planning active children again or ending the account. A later attempt handles the next limited batch. It does not skip a hidden child because public readers cannot see it. It also does not require one Worker request to finish every child.

The cascade has no failure path that gives up after a set number of retries. Once it starts, a child action can already be permanent. The parent stays deleting until all children converge. It keeps the original typed failure code.

The internal delete route returns `account_delete_pending` with HTTP 202 while child work remains. It returns `account_delete_complete` with HTTP 200 only after the final batch. The pending result shows `planned` counts. Only the complete result calls those counts `deleted`. Both are successful typed results. Pages clears the session cookie for either one. The browser clears its signed-in state at once. It shows `Profile deletion accepted.` while work remains and `Deleted profile.` after completion. Scheduled recovery or an owner alarm continues the deletion after the browser request ends.

The migration marks old rows with `lifecycle_state = 'active'`. New rows start as pending. They become public only in the D1 activation batch. Deletion marks a row as deleting in the batch that creates its operation. Public, sign-in, search, and runtime readers require an active index row.

`worldForUpdateMutation` is a Phase 1 adapter that routes one type of request. It is not a public reader or repair writer. It handles a replay when the D1 handle claim and index batch succeeded but the stable-ID KV write failed. It sends the same request to the selected world coordinator.

Phase 3 removes this adapter after it adds a revisioned update action to the existing lifecycle operation. That action must save the stable world ID, old and new handles, and document revision before the D1 claim batch. Recovery then resumes it through the existing global recovery index. Phase 3 must extend the existing lifecycle process. It must not add a separate process for renames.

## Phase 3 extension point

`activateLifecycleEntity` and the typed `finalizeLifecycleDeletion` functions are the only activation and deletion transactions. This includes `finalizeAccountLifecycleDeletion`, which writes the final count-only result. Under maintenance, Phase 3 must change `entity_lifecycle_control.activation_mode`. It must give those existing functions an `inference_graph` transition:

- Account activation supplies the Account-default insert and default-translation-reference insert.
- World and participant activation supplies the fixed-configuration insert.
- Deletion supplies ordered statements to reset or reparent consumers and clean up configurations.

Those statements join the existing index and visibility change in one `D1Database.batch()` transaction. Graph-required mode rejects an old transition or a missing or wrong payload. After the gate changes, an account cannot become active without both Account-default statements. Phase 3 must not add a second lifecycle process around this one.

The `legacy_compatible` transition is the adapter used before the graph change. Remove it during the Phase 3 maintenance cutover. First, make sure that graph tables and migration writers are ready. Then change the saved activation mode and make callers send typed graph payloads. Remove the old transition in the release that removes old inference projections.
