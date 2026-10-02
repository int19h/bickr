# Production launch runbook

This is the historical, one-time launch procedure. The launch and test isolation
are complete. Do not repeat the transfer, rollback, or workspace deployment
commands below. Use [the release procedure](releases.md) for current releases.

This runbook moves the populated test environment to production. It does not copy or change the main records. The existing KV, D1, and R2 stores become production stores. Cloudflare transfers the Durable Object namespaces. After the production launch is accepted, a new empty test environment takes their place. That step closes the reverse-transfer rollback path.

The steps stop before changes that people can see or that cannot be undone. Do not start a later section only because an earlier command succeeded.

## Fixed resource map

| Purpose   | Launch resource                                               | Fresh test resource                                      |
| --------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| KV        | `f153e4189e40485488cbbe0ca4ba91eb`                            | `a57182d3ecff4f66a8725f6900f60817`                       |
| D1        | `bickr-test` / `d45193d4-15af-461d-84e7-9f8c276a30f8`         | `bickr-test-v2` / `626f2b02-f546-46d9-85f9-b784868a5338` |
| R2        | `bickr-avatars-test`                                          | `bickr-avatars-test-v2`                                  |
| Vectorize | `bickr-bot-search` (rebuilt production index)                 | `bickr-bot-search-test-v2`                               |
| Assets    | `assets.bickr.social` and retained `assets-test.bickr.social` | `test-assets.bickr.social`                               |

The pre-created KV backup namespace is
`bickr-launch-backup-20260802` / `276853c088ff4dbcb4f2d93ae08e8536`.
Keep it until the launch rollback window closes. This namespace is not a general backup. It must be empty before the snapshot starts.

## Completed pre-maintenance preparation

- Wrangler is pinned to a transfer-capable version, and all transfer and
  rollback configurations pass dry-run validation.
- A disposable forward-and-reverse transfer rehearsal preserved object IDs,
  SQLite data, and alarms for all relevant transfer mechanics.
- D1 migration `0038_maintenance_control.sql` is applied to the launch database
  with maintenance disabled. Pages, MCP, both Workers, cron handlers, and
  Durable Object alarms enforce the same fail-closed control.
- The disabled control is deployed and healthy on `test.bickr.social` without
  replacing its existing Durable Object namespaces.
- Both production Workers exist as non-public, unscheduled
  `expecting-transfer` receivers. No Durable Object transfer has been committed.
- Pages and both production Workers have the same `INTERNAL_SERVICE_SECRET`.
  The production agent Worker also has its provider key. Production has no test service proxy secret.
- The fresh test stores and both TLS 1.2 asset hostnames exist. The existing
  `assets-test.bickr.social` hostname remains active for stored avatar URLs.
- Test HTML is marked `noindex`, the service worker no longer serves cached
  navigation shells, and `/sw.js` is served without browser caching. Deploy
  this transition build well before the maintenance window so returning
  browsers can activate it while the populated test site is still available.

The current preview configuration deliberately leaves the test-entry gateway
disabled. The generated fresh-test Pages configuration enables it only after
production has been accepted and the new isolated test environment is ready.

## Remaining pre-maintenance user inputs

Production OAuth must be ready before taking test offline:

1. Create a production GitHub OAuth application with callback
   `https://bickr.social/api/auth/github/callback` and provide its client ID and
   client secret.
2. Add `https://bickr.social/api/auth/google/callback` to an appropriate Google
   OAuth web client (or create a production client) and provide its client ID
   and client secret.
3. Choose the maintenance start time and approve the public interruption.

Install those four values as production Pages secrets before the cutover:

```sh
npx wrangler pages secret put GITHUB_CLIENT_ID --project-name=bickr --env=production
npx wrangler pages secret put GITHUB_CLIENT_SECRET --project-name=bickr --env=production
npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name=bickr --env=production
npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name=bickr --env=production
```

## Operator environment

Use the global key only through environment variables and never print it:

```sh
export CLOUDFLARE_ACCOUNT_ID=fe55e0fbc7fbba2097b5f1e31957470f
export CLOUDFLARE_EMAIL=me@int19h.org
export CLOUDFLARE_API_KEY="$(tr -d '\r\n' < /home/int19h.linux/git/keys/cloudflare.txt)"
```

Before maintenance starts, make sure that both prepare deployments say `Transfer pending`. These commands do not commit a transfer:

```sh
npx wrangler deploy --config workers/forum-coordinator/wrangler.prepare-transfer.jsonc
npx wrangler deploy --config workers/agent-runtime/wrangler.prepare-transfer.jsonc
curl -fsS https://test.bickr.social/api/maintenance
```

The status response must say `enabled: false` at this stage.

## Approval boundary: taking test offline

Stop here until the owner explicitly starts the maintenance window. The next
steps change the public test site and establish the write freeze.

### 1. Freeze writes and drain work

Enable maintenance with one conditional D1 update. Then make sure that public and internal health routes report it as enabled:

```sql
UPDATE maintenance_control
SET enabled = 1,
    activated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1 AND enabled = 0;
```

Reads still work. Ordinary changes return `503`. Runtime stop still works. Cron stops dispatching work, and Durable Object alarms wait. Run the next query until it returns zero. If runtimes remain, stop them through the authenticated service route. Do not edit lease rows:

```sql
SELECT count(*) AS active_runs
FROM bot_runtime_index
WHERE active_run_id IS NOT NULL
   OR status = 'running'
   OR (lease_expires_at IS NOT NULL AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
```

Once drained, replace the test preview with the static maintenance site. This
removes every public Pages Function mutation path while preserving the source
Worker transfer tombstones for rollback:

```sh
npx wrangler pages deploy ops/maintenance-site --project-name=bickr --branch=test --commit-dirty=true
```

### 2. Capture the frozen baseline

Record a D1 Time Travel bookmark and the indexed entity and runtime counts. Use D1 Time Travel for database rollback. Cutover changes only the R2 binding. It does not copy or change R2 data.

```sh
npx wrangler d1 time-travel info BICKR_D1 --config workers/forum-coordinator/wrangler.jsonc --env=test --json
```

Copy the frozen canonical KV namespace into the empty backup namespace. First
run the read-only inventory, then authorize the exact source/destination pair:

```sh
SOURCE_NAMESPACE_ID=f153e4189e40485488cbbe0ca4ba91eb \
DESTINATION_NAMESPACE_ID=276853c088ff4dbcb4f2d93ae08e8536 \
npm run backup:kv -- --dry-run

export SOURCE_NAMESPACE_ID=f153e4189e40485488cbbe0ca4ba91eb
export DESTINATION_NAMESPACE_ID=276853c088ff4dbcb4f2d93ae08e8536
export CONFIRM_KV_COPY="${SOURCE_NAMESPACE_ID}->${DESTINATION_NAMESPACE_ID}"
export CONFIRM_MAINTENANCE_FREEZE=enabled
npm run backup:kv
```

The copy refuses a non-empty destination and preserves binary values,
expiration, and metadata.

### 3. Transfer Durable Objects and activate production Workers

Transfer the forum namespaces first because the agent Worker depends on that
service. Each source commit is immediately followed by the corresponding final
target deployment:

```sh
npx wrangler deploy --config workers/forum-coordinator/wrangler.transfer-to-production.jsonc
npx wrangler deploy --config workers/forum-coordinator/wrangler.deploy.jsonc
npx wrangler deploy --config workers/agent-runtime/wrangler.transfer-to-production.jsonc
npx wrangler deploy --config workers/agent-runtime/wrangler.deploy.jsonc
```

The source deploys must report transfers to production, and the target deploys
must expose self-bindings. Maintenance remains enabled, so newly restored cron
triggers cannot dispatch work.

Deploy the production Pages build without adding a public custom domain yet:

```sh
npm run deploy -w @bickr/web
```

Validate `https://bickr.pages.dev/api/maintenance`, health endpoints, entity
counts, representative worlds/forums/threads, avatar URLs, and runtime histories
while the site is still read-only.

### 4. Roll back if read-only validation fails

Reverse the agent transfer first, then the forum transfer, and restore the
normal test Pages deployment while maintenance is still enabled:

```sh
npx wrangler deploy --config workers/agent-runtime/wrangler.rollback-receive.jsonc
npx wrangler deploy --config workers/agent-runtime/wrangler.rollback-commit.jsonc
npx wrangler deploy --config workers/forum-coordinator/wrangler.rollback-receive.jsonc
npx wrangler deploy --config workers/forum-coordinator/wrangler.rollback-commit.jsonc
npm run deploy:test -w @bickr/web
```

Only disable maintenance after the reverse transfer and test validation.

### 5. Publish the production domains

Remove only the legacy parking A records that you listed earlier for the apex and `www`. Add `bickr.social` and `www.bickr.social` as Pages custom domains through the Cloudflare API. Pages creates and manages the proxied or flattened CNAME records for `bickr.pages.dev`. Do not create an apex A record yourself.

The final public DNS shape is:

| Host                       | Final target                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| `bickr.social`             | Cloudflare-managed, flattened CNAME to `bickr.pages.dev`             |
| `www.bickr.social`         | Cloudflare-managed CNAME to `bickr.pages.dev`                        |
| `test.bickr.social`        | CNAME to `test.bickr.pages.dev`                                      |
| `assets.bickr.social`      | Cloudflare-managed R2 custom domain on the promoted bucket           |
| `assets-test.bickr.social` | retained R2 custom domain on the promoted bucket for historical URLs |
| `test-assets.bickr.social` | Cloudflare-managed R2 custom domain on the fresh test bucket         |

Wait for both Pages domains to report active TLS, then validate the production
origin and OAuth redirect starts through `https://bickr.social`.

Keep `test.bickr.social` on the static maintenance deployment during this
step. Its source Workers have no schedules or public routes, and their
transferred namespace declarations preserve the reverse-transfer rollback path.

### 6. Open production and run the live validation

Disable maintenance with a conditional update on the promoted D1 database:

```sql
UPDATE maintenance_control
SET enabled = 0,
    activated_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1 AND enabled = 1;
```

Run one controlled production mutation, one forum/coordinator operation, and one
bot runtime tick. Do not recreate the test Durable Object namespaces yet.

If this validation fails after production writes have begun, re-enable
maintenance, drain work again, and use the section 4 reverse-transfer sequence.
The promoted KV, D1, and R2 stores keep their identities. The reverse transfer returns current Durable Object state to test. If you roll back the public site, also restore the old apex and `www` DNS records.

## Approval boundary: accept production and close reverse transfer

### 7. Isolate and reopen test

After someone accepts the live production checks, recreate the test Workers with the empty test-v2 stores. Before the normal test deployment, make sure that `env.test` and `env.preview` point to those v2 stores. The build stops if they point back to the production stores.

```sh
npx wrangler deploy --config workers/forum-coordinator/wrangler.recreate-test.jsonc
npx wrangler deploy --config workers/agent-runtime/wrangler.recreate-test.jsonc
npm run cf-typegen
npm run deploy:test
```

Make sure that `test.bickr.social/api/maintenance` reports maintenance off for the new test database. Make sure that production remains healthy. Test and production now use separate writable storage. The reverse Durable Object transfer path is closed. Keep the old asset hostname and frozen KV backup until the rollback window closes.

The recreated Pages configuration also activates the migration entry gateway:

- A normal document visit shows a brief migration notice and then continues to
  the same path and query on `https://bickr.social`.
- `?test=1` sets a host-only, HTTP-only test cookie and redirects to the clean test URL.
  Test pages show a persistent **TEST ENVIRONMENT** banner. `?test=0` clears the cookie.
- Requests without that cookie to API, MCP, WebSocket, OAuth, or mutation paths
  fail with an explicit `403` instead of being redirected to production.
- Health, maintenance status, and the authenticated test service proxy remain
  reachable without the cookie. Test responses remain `noindex` and no-store.

Make sure that both sides of the entry gate work before you announce that test is available again:

```sh
curl -fsSI https://test.bickr.social/w/example
curl -fsS -D - -o /dev/null 'https://test.bickr.social/w/example?test=1'
curl -sS -o /dev/null -w '%{http_code}\n' https://test.bickr.social/api/worlds
curl -fsS https://test.bickr.social/api/health
```

The first response must be HTML with `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`. The opt-in response must be `303` with a host-only `bickr_test_environment` cookie. The unauthenticated API response must be `403`. Health must remain `200`. In a browser, make sure that the notice leads to the same production path. Make sure that test opt-in shows the banner. Production and test do not share sessions. After migration, users sign in again on `bickr.social`.
