# Release an approved commit

A worktree is a separate checkout of the repository.
Use a clean release worktree at the full commit that reviewers approved. A review
of an earlier commit does not cover later changes. Production needs a fresh user
instruction that names production for this task. A release command does not grant
that permission.

Run the candidate checks once. This installs the lockfile, runs all tests with two
workers, builds the app, and records the commit and file hashes:

```sh
npm run check:release -- --commit <full-commit-sha>
```

GitHub Actions runs the same command for the exact pull request head and each
commit pushed to main. A build artifact holds generated files.
This artifact contains the check record and Pages build.
Its name includes the full checked commit.

A green pull request head does not prove that a different merge commit passes. Run the checks on the merge candidate.
These checks do not use Cloudflare credentials or deploy anything.

Show the selected targets without contacting Cloudflare:

```sh
npm run deploy -- --environment test --commit <full-commit-sha> --plan
```

After review and release authorization, deploy to test:

```sh
npm run deploy -- --environment test --commit <full-commit-sha>
```

The release script rejects a dirty tree, a different commit, a changed lockfile,
and build files that differ from the check record. It selects the account,
Workers, database, and Pages branch explicitly. It reads Worker secret names and
the D1 migration history before writes. Set the same `INTERNAL_SERVICE_SECRET`
on Pages and both Workers before release. A missing receiver secret rejects
internal requests. Local loopback requests remain available for development.

Pending migrations stop the release. Review their effect on the currently running code and data.

If they are safe to apply before the code update, add
`--apply-migrations` to the release command. The script applies them to the selected database and reads the migration history again.
It deploys code only if no migrations remain pending.

A remote migration missing from the source tree blocks a rollback.
This check compares filenames. D1 does not record migration content hashes. Never edit
an applied migration. Use a new migration for any repair.

Workers receive the full source SHA as their version tag and message. Pages uses
the explicit `test` or `main` branch, the full source SHA, and a clean-tree marker.
The script then compares active Worker version IDs, Pages source, and the environment with the release record.
It makes sure that the public runtime health endpoint succeeds.

It also compares the source marker in the custom domain HTML and the entry asset hashes with the build record. The check build injects the source marker
before Vite generates the service worker. The test release sends the test
environment opt-in cookie so the migration gateway serves the app.
A successful upload alone does not set the release status to `verified`.

For an authorized production release, use `--environment production` with the same
reviewed commit. First make sure that its test release passes the release checks. Keep the record as evidence of the
test result. Production uses the same checks and migration rules as test.

Each attempt creates a new JSON record and Wrangler operation file in
`.wrangler/release/`. Use `--record /build/bickr/logs/<task>/release.json` to keep
long-lived local evidence outside the worktree. Use `--checks <path>` for a saved
check record. Its build hashes must match the local Pages build.

Copy records to the task's artifact storage before removing a release worktree. After that copy, delete the local records. CI candidate artifacts expire after 14 days.

## Release from GitHub Actions

Two manual workflows run the same check and release scripts in GitHub Actions.
Nothing starts them automatically. In the repository's Actions tab, select a
workflow, select Run workflow, and choose a branch.

- `Deploy to test` deploys the head commit of the branch that you select.
- `Deploy to production` deploys the head commit of `main`. It fails for any other branch.
- The `apply-migrations` option adds `--apply-migrations`. Review pending migrations before you select it.

Each run checks out the commit, runs `check:release`, and then runs the release
script. The shared job is in `.github/workflows/release.yml`. It uses the GitHub
environment `test` or `production`. Each environment needs the secret
`CLOUDFLARE_API_TOKEN`. The token must be an account API token for the Bickr
account with these permissions: Workers Scripts Edit, D1 Edit, and Cloudflare
Pages Edit. The account ID comes from `scripts/release-support.mjs`.

Only one release runs at a time for each environment. A later run waits, and a
running release is never cancelled. Each run uploads `.wrangler/release/` as an
artifact, also after a failure, and keeps it for 90 days.

The workflows do not replace release authorization. A production run still needs
a fresh user instruction that names production for the task. To enforce a second
person, add required reviewers to the `production` environment in GitHub.

If a step fails, examine the record and live metadata before you continue.
A failed upload can leave changes in Cloudflare. The script never retries a write or
rolls a Worker back on its own.

An atomic operation completes all its changes together.
Cloudflare does not make a release of multiple services atomic. Keep schema changes compatible with the old code during the update.
Agree on a release window to prevent concurrent deployments.

The dependency lock passed the npm advisory check on 2026-10-02. Miniflare
currently pins older `sharp` and `undici` versions in the latest Workers test
runner. Root overrides select patched versions within their current minor or major
version ranges. When that runner pins patched versions, remove the overrides.
Then run `npm audit` and the candidate checks again.

References: [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/),
[Pages commands](https://developers.cloudflare.com/workers/wrangler/commands/pages/),
[Wrangler operation records](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/),
and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

## Markdown tool results

A legacy row is an active tool result without a stored view.
A census counts these rows without changing them.
Forced compaction summarizes the oldest history through the complete protocol group that contains the last legacy result.
That range includes stored views between legacy results or beside the final legacy result.
Rows after that group stay in active history.
The operation uses each participant's inference configuration and can incur provider charges.

Complete this procedure in test before production.
Keep the page responses and the release record as evidence.
Production requires separate authorization for this task.
The test service proxy does not exist in production.
For production, send the same internal requests through the approved operator service channel.

Use the clean release worktree at the reviewed commit.
Keep the approved test proxy secret in `TEST_AUTH_SECRET` without printing its value.
Use a host that `TEST_AUTH_ALLOWED_HOSTS` permits.
The requests below send that secret only in the proxy header.
The proxy supplies internal service authentication.

1. Apply D1 migration `0071_deleted_reference_handles.sql` before the deployment.
   Use the release command below after approval to apply pending migrations before it deploys code.
   Review all pending migrations because the command applies every pending migration.
   D1 migrations do not use the service proxy.
2. Deploy the reviewed commit to test:

   ```sh
   npm run deploy -- --environment test --commit <full-commit-sha> --apply-migrations
   ```

   Make sure that the release record reports `verified` before the sweeps.
3. Complete the participant time sweep:

   ```sh
   curl --fail-with-body -sS 'https://test.bickr.social/api/__test__/service-proxy' \
     -H 'content-type: application/json' \
     -H "x-test-auth-secret: ${TEST_AUTH_SECRET}" \
     --data '{"service":"agent-runtime","method":"POST","path":"/maintenance/participant-time","headers":{"x-bickr-scheduler":"1"},"body":{}}'
   ```

   Repeat this exact request until `data.sweep.done` is true.
   The sweep stores its own cursor.
   If recent edits defer records, wait until the six-hour quiet period passes.
   Do not accept a pass with skipped records as migration evidence.
4. Complete the deleted reference handle backfill:

   ```sh
   curl --fail-with-body -sS 'https://test.bickr.social/api/__test__/service-proxy' \
     -H 'content-type: application/json' \
     -H "x-test-auth-secret: ${TEST_AUTH_SECRET}" \
     --data '{"service":"agent-runtime","method":"POST","path":"/maintenance/tool-result-handles","headers":{"x-bickr-scheduler":"1"},"body":{}}'
   ```

   For each later page, set `body.cursor` to the exact object in `data.page.nextCursor`.
   For example, the forum page starts with `"body":{"cursor":{"kind":"forum","afterId":""}}`.
   Continue until `data.page.nextCursor` is null.
   If any page lists `missingIds`, resolve those records before repeating the pass from the first page.
   A pass with missing IDs does not prove completion.
5. Census legacy history, compact it, and census it again:

   ```sh
   curl --fail-with-body -sS 'https://test.bickr.social/api/__test__/service-proxy' \
     -H 'content-type: application/json' \
     -H "x-test-auth-secret: ${TEST_AUTH_SECRET}" \
     --data '{"service":"agent-runtime","method":"POST","path":"/maintenance/legacy-history/census","headers":{"x-bickr-scheduler":"1"},"body":{}}'
   ```

   For each later page, send `"body":{"cursor":"<data.page.nextCursor>"}`.
   Continue until `data.page.done` is true.
   Each page visits at most 25 runtimes through the existing fleet cursor.
   `legacyRuntimes` lists the nonzero counts.
   `results` also includes zero counts and failures.
   `done` means that the cursor reached the end, not that every runtime succeeded.

   Run forced compaction from the first page:

   ```sh
   curl --fail-with-body -sS 'https://test.bickr.social/api/__test__/service-proxy' \
     -H 'content-type: application/json' \
     -H "x-test-auth-secret: ${TEST_AUTH_SECRET}" \
     --data '{"service":"agent-runtime","method":"POST","path":"/maintenance/legacy-history/compact","headers":{"x-bickr-scheduler":"1"},"body":{"limit":5}}'
   ```

   Follow `data.page.nextCursor` until `data.page.done` is true.
   Copy each cursor verbatim into `body.cursor`.
   Compaction defaults to five runtimes per page.
   Set `body.limit` to an integer from one through five to reduce the page size.
   Each page compacts one runtime at a time.
   Send only one page request at a time.
   Keep the connection open until each request finishes.
   Between pages, wait for `data.page.pauseMs` milliseconds, with a minimum pause of 60 seconds.
   If no pause value appears, wait at least 60 seconds.

   If `stoppedForRateLimit` is true, the page stopped at a provider rate limit.
   That runtime reports `kind: deferred` and `reason: rate_limit`.
   The page reports `retryAfterMs` when the provider supplies a delay.
   `pauseMs` uses the longer of that delay and 60 seconds.
   The retry cursor is an object, such as `{"retryBotId":"bot-id"}`.
   After the pause, send that exact object as `body.cursor` to retry the deferred runtime.
   The route does not advance past that runtime or contact later runtimes in that page.
   Each runtime reports `providerCalls`, `promptTokens`, `completionTokens`, `totalTokens`, and `usageMissingCalls`.
   If `usageMissingCalls` is positive, the reported token totals omit unknown provider usage.
   These counters cover compaction inference calls, not account billing requests.

   A `deferred` result preserves the running tick or maintenance operation.
   Retry deferred runtimes in a later pass from the first cursor.
   A `failed` result reports `errorKind` and stops that runtime for this request.
   Fix missing credentials or provider failures before a later pass.
   Transport errors and rate limits stop that runtime without retries.
   After an output-limit failure, normal compaction can split the batch into smaller groups.
   The cost counters include the failed request and the smaller requests.

   Repeat the entire census from the first cursor after compaction.
   Accept completion only when every page succeeds and every `legacyToolRows` count is zero.
   Repeat compaction and the census until that condition holds.
   A repeated successful compaction performs no provider calls.

For one runtime, inspect its count through the existing status route:

```sh
curl --fail-with-body -sS 'https://test.bickr.social/api/__test__/service-proxy' \
  -H 'content-type: application/json' \
  -H "x-test-auth-secret: ${TEST_AUTH_SECRET}" \
  --data '{"service":"agent-runtime","method":"GET","path":"/bots/<bot-id>/status","headers":{"x-bickr-scheduler":"1"}}'
```

Read `data.status.legacyToolRows`.
To retry that runtime after deferral or repair, use its internal compaction route:

```sh
curl --fail-with-body -sS 'https://test.bickr.social/api/__test__/service-proxy' \
  -H 'content-type: application/json' \
  -H "x-test-auth-secret: ${TEST_AUTH_SECRET}" \
  --data '{"service":"agent-runtime","method":"POST","path":"/bots/<bot-id>/maintenance/legacy-history/compact","headers":{"x-bickr-scheduler":"1"},"body":{}}'
```

Retire the compatibility code only under the gates in [Tool result views](tool-result-views.md#retirement).
The active census does not count compacted or deleted rows that owner history pages can still read.
Keep archive readers until their separate retention census also reaches zero.

## Context budget minimum

The `context-budget-minimum-v1` migration raises explicit participant budgets below `contextWindowTokensMin` to that minimum.
The shared constant is in `packages/shared/src/model/runtime.ts`.
The default is `defaultTickSettings.contextWindowTokens` in `packages/shared/src/repository.ts`.
API validation, CLI flags, UI limits, drafts, probes, and compaction use these values.
The editor help text derives both numbers from those sources.

Participant documents in KV store the current configurable override.
The `bot_runtime_index.context_window_tokens` projection stores that override or `NULL`.
Pending creation requests also store an executable budget in `entity_lifecycle_operations.request_json`.
The migration raises that saved budget before recovery executes it.
It preserves the original request hash, which identifies the submitted request.

Inference configurations, account defaults, worlds, and linked clone sources do not supply this setting.
A linked clone uses its own override or the shared default.
Changing the default affects every participant without an explicit override, including disabled participants and linked clones.
An explicit valid budget stays unchanged, even when it equals the former default.

Historical usage rows, inference attribution, and retained request bodies record earlier requests.
They are evidence, so the migration does not change them.
Provider context limits can also reduce a request budget independently of the participant minimum.
The probe cache stores prompt token counts, rather than the effective budget.
The runtime calculates the budget from current settings when it reads those counts.
No default cache needs a data rewrite.

Global maintenance mode is not needed for this migration.
After deployment, every configuration writer rejects budgets below the minimum.
Each migration write uses the owner's `UserBotsCoordinator` queue, which also serializes owner edits.
The `context-budget-minimum-v1` execution safeguard runs in `runBotCreateOperation` before a saved request executes.
It applies the same migration writer within that queue step and preserves the original request hash.

The safeguard covers ordinary creation, clone creation, retries, and lifecycle recovery.
It migrates both the saved request and any existing participant document before materialization.
Migration errors escape before creation cleanup can delete the participant.
Compensating cleanup only deletes data and does not execute or validate the saved budget.
Terminal operations do not replay the saved request.
This safeguard changes executable state at its writer, rather than repairing data on reads.

Complete these steps in test before an authorized production release:

1. Deploy the reviewed commit.
   Keep normal site writes and visits enabled.
2. Run the first full sweep through the test proxy.
   Send the first page:

   ```sh
   curl --fail-with-body -sS 'https://test.bickr.social/api/__test__/service-proxy' \
     -H 'content-type: application/json' \
     -H "x-test-auth-secret: ${TEST_AUTH_SECRET}" \
     --data '{"service":"agent-runtime","method":"POST","path":"/maintenance/context-budget","headers":{"x-bickr-scheduler":"1"},"body":{"cursor":""}}'
   ```

   Each page includes at most 25 participants.
   It includes pending and deleted participants and retained runtime index rows.
   The `indexed` pass also includes canonical lifecycle records before index creation.
   The `creations` pass reads saved creation requests, including requests without a KV document yet.
   The `documents` pass lists KV participant keys, including documents without any index or lifecycle row.

   Each write runs through the participant owner's `UserBotsCoordinator` queue.
   The queue serializes the document and projection writes with other configuration writes.

   Save each page response and resume with `body.cursor` set to the complete object in `data.page.nextCursor`.
   Keep its `kind` and position fields unchanged when moving between passes.
   Continue until `data.page.done` is true and `data.page.nextCursor` is `null`.
   A `missing` result stops the cursor before that participant.
   Resolve the missing document before resuming that cursor.

   A matching pending creation can lack KV before materialization.
   A matching compensating creation can lack KV after cleanup deletes it.
   The sweep accepts these lifecycle states without restoring a document.

   If a request fails or its response is lost, repeat the same input cursor.
   A replay finishes pending projection writes without raising a document revision twice.
3. Wait at least 60 seconds after the final write in the first full sweep.
   KV can return cached values during [propagation](https://developers.cloudflare.com/kv/api/list-keys/).
   If an operator set a longer KV cache lifetime, wait for that lifetime too.
4. Run the second full sweep through all three passes from the empty cursor.
   This sweep also catches old values from workers that finished during deployment.
   Require `data.page.changes.documents`, `indexes`, and `creationRequests` to be zero on every page.
   Require every result to be `unchanged`, with no missing documents, including pending creations.
   If any counter is nonzero, repeat the wait and all three passes.
   Keep both passes and the release record as evidence.

For production, complete the same steps through the approved operator service channel after separate production authorization.
Send `POST /maintenance/context-budget` to the production agent runtime binding.
Send `x-bickr-scheduler: 1`, internal service authentication, and the JSON body `{"cursor":""}`.
Use the same cursor protocol and completion rules as test.
The test proxy does not exist in production.
Do not write KV or the runtime index directly.

The migration adds no table, column, KV key, or retained sweep state.
The operator owns the resumable cursor and saves page evidence in release artifact storage.
Existing document, index, and historical data retention rules stay in force.
After both environments complete a second pass with no changes, retire rollback writers that accept the old minimum.
Then advance the document `schemaVersion` past 2.
Remove `context-budget-migration.ts`, both migration routes, their maintenance exemptions, and the execution safeguard together.
Remove these operator steps in the same change.
Keep the permanent writer validation and shared constants.
