# Authentication storage and cutover

D1 holds the authoritative authentication records. These operations use the primary D1 binding. Do not move these reads into a replica session or a KV cache. Authentication reads the profile from KV, then makes sure that D1 marks the account as active.

A conditional update and all successor writes run in one `D1Database.batch()` transaction. A random claim identifies the request that consumed an OAuth code, refresh token, or CLI approval. Each successor insert requires that claim. If the batch fails, D1 rolls back consumption.

Consumed refresh tokens stay until their grant expires. Reuse of a consumed code or refresh token revokes its grant and every token in that family. Clients must serialize refresh requests. A second concurrent refresh counts as replay.

## Browser consent and callbacks

MCP and CLI consent require a browser session cookie and evidence of the same origin. Bearer tokens cannot approve access. An explicit `Origin` must match the request origin. If present, `Sec-Fetch-Site` must be `same-origin`. Without `Origin`, the request must include `Sec-Fetch-Site: same-origin`. GET displays each form. POST approves access.

The OAuth POST response loads a fixed script from the same origin. The script starts a new navigation to the registered callback. A link provides a fallback when scripts are disabled. This preserves the ordinary `form-action 'self'` policy. It also avoids browser differences in policy enforcement during redirects after form submission.

The response sets `Referrer-Policy: no-referrer`. Callback URIs use HTTPS. HTTP is permitted only for `localhost`, `127.0.0.1`, or `[::1]`. Callback URIs cannot contain user information or a fragment. The callback must exactly match a registered URI.

## Retention and admission

Migration `0059_auth_state.sql` defines the tables and retention rules. `cleanupAuthRecords(db, now?)` deletes at most 500 expired auth records and 500 expired rate buckets per call. Both queries use expiry indexes. Scheduled maintenance calls this function even when it skips bot dispatch. Repeated bounded calls clear a backlog.

| Record | Absolute lifetime |
| --- | --- |
| Browser session | 30 days |
| CLI token | 90 days |
| CLI approval or OAuth code | 10 minutes |
| MCP grant and refresh lineage | 90 days from initial exchange |
| MCP access token | One hour, capped by grant expiry |
| Unused MCP client | 30 days |
| MCP client after authorization | 180 days from authorization |
| Legacy revocation marker | Until the proven legacy credential expires |
| Rate bucket | Two hours from its hour window start |

Refresh does not extend the grant lifetime. Reads and writes enforce expiry. A cleanup delay cannot restore access. Each account has at most one revocation cutoff row. This row stays for the account's lifetime. It covers legacy credentials that the migration has not indexed.

Registration and CLI login initiation each have separate hourly limits. Each Cloudflare client address gets 20 attempts. The global limit is 200 attempts. An address refusal does not spend the global allowance. After the global limit, requests cannot create more address rows. The database stores address hashes, not raw addresses.

Auth request bodies have a 16 KiB limit and a ten-second read deadline. Structured logs record registration and admission failures without bearer tokens. Fixed quotas bound storage growth, but shared addresses and global abuse can reduce availability. Change the quotas explicitly when measured usage requires it.

## One-time KV migration

New writers use D1 only. The temporary reader uses storage version 2. It preserves valid browser sessions and CLI tokens without writing or repairing records. It reads primary D1 revocation state before accepting legacy credentials.

Migration application fixes a deadline 90 days later. Requests cannot extend it. Storage version 3 disables the legacy reader after the sweep completes. The deadline denies legacy access if operational completion is delayed.

Existing MCP access and refresh tokens require new authorization at cutover. Their old records lack reliable family lineage for replay detection. Existing OAuth codes and CLI approvals are retired. Restart those short flows.

The sweep preserves registered client metadata. Before client migration completes, existing clients can receive `invalid_client`. They must retry after cutover or register again.

The protected `POST /auth/maintenance` route calls the exported migration functions. The functions need `BICKR_KV` and `BICKR_D1`, with no new bindings. The route requires internal service authentication and scheduler authorization. Public OAuth routes cannot invoke it.

The route accepts a JSON object with a `kind` field. Its body limit is 8 KiB, with a ten-second read deadline.

| Action | Request | Effect |
| --- | --- | --- |
| Inspect progress | `{"kind":"status"}` | Read the version and eight prefix cursors. |
| Preview a page | `{"kind":"dry_run","prefix":"session"}` | Read up to 50 keys without changing progress. |
| Import a page | `{"kind":"migrate","prefix":"session"}` | Use the saved cursor and commit one page. |
| Complete the sweep | `{"kind":"finish"}` | Set version 3 after every prefix completes. |
| Remove expired records | `{"kind":"cleanup"}` | Run bounded authentication retention. |

Only a dry run accepts an optional `cursor`. Import and completion require site maintenance. Inspection, previews, and retention remain available outside maintenance.

In test, use the Pages service proxy at `https://test.bickr.social/api/__test__/service-proxy`. Read the test secret from the local `.dev.vars` file without printing it. Send the secret in `x-test-auth-secret` and use this JSON body:

```json
{
  "service": "agent-runtime",
  "method": "POST",
  "path": "/auth/maintenance",
  "headers": { "x-bickr-scheduler": "1" },
  "body": { "kind": "status" }
}
```

The proxy adds internal service authentication. Keep public Worker URLs disabled. Production needs a separately authorized internal maintenance path.

### Prepare the cutover

1. Enable the site maintenance control.
2. Apply migration 0059 before deploying the D1 writers.
3. Stop old auth writers.
4. Wait for outstanding requests and KV propagation to finish.
5. Deploy the new writers.
6. Keep ordinary auth traffic closed during client migration.

KV listing is eventually consistent. A completed scan cannot prove that an old writer stopped. Complete the drain before marking any prefix complete.

### Inspect the data

The dry-run call is `migrateLegacyAuthPage(kv, db, { prefix, dryRun: true, cursor? })`. It reads at most 50 keys. It changes neither D1 nor KV. It does not advance saved progress.

1. Run a dry-run page for each prefix below.
2. Continue each prefix with its returned cursor until `done` is true.
3. Review the counts before migration.

The prefixes are `session`, `cli_token`, `mcp_client`, `cli_request`, `mcp_code`, `mcp_access`, `mcp_refresh`, and `mcp_grant`.

### Migrate the data

The real call is `migrateLegacyAuthPage(kv, db, { prefix, dryRun: false })`. It uses the saved D1 cursor. A real call does not accept a caller-selected cursor.

Each page commits D1 imports before deleting KV keys. Repeated imports never replace existing records or legacy revocation markers. The result includes `scanned`, `copied`, `retired`, `invalid`, `cursor`, and `done`. The `copied` count includes eligible imports that already exist after a retry.

1. Run real migration pages for each prefix until `done` is true.
2. Retry a failed page.
3. Call `finishLegacyAuthMigration(db)`.
4. Make sure that it returns true.
5. Wait for KV propagation to finish.
6. Make sure that all eight prefixes are empty.
7. Make sure that migrated browser and CLI credentials work.
8. Make sure that old MCP families fail.
9. Make sure that fresh OAuth and CLI authorization work.
10. Reopen auth traffic.

Completion sets storage version 3 only when all eight prefixes have finished. Do not force this version manually. The sweep retains no plaintext bearer tokens. It imports existing hashed keys and documents.

The next schema release removes the legacy reader, migration module, and two transition tables. Remove them only after the completed sweep passes the tests above. Permanent revocation behavior remains.

Provider sign-in state under `v1:oauth-return:` keeps its separate short lifetime. It is outside this migration.

## Credential inventory and revocation

`GET /api/me/auth/credentials?after=<cursor>` returns at most 100 browser sessions, CLI tokens, or MCP grants. It returns `nextCursor` and `legacyMigrationComplete`. Record IDs are not bearer tokens. Until migration completes, the list can omit legacy browser and CLI credentials.

`DELETE /api/me/auth/credentials` requires cookie authentication and the browser origin rules above. Its body limit is 1 KiB. The body selects one credential with `{"kind":"credential","id":"<inventory ID>"}`, or all credentials with `{"kind":"all"}`.

A single-credential action only accepts records owned by the signed-in account. Revoking an MCP grant revokes its whole family. The all action also revokes pending approvals and legacy credentials that migration has not visited. It logs out the requesting browser.

The profile screen lists credentials through this API. It provides single-credential and all-credential revocation. The list reports incomplete legacy migration and loads at most one page at a time.

Successful all-credential revocation clears the browser cookie and local session state. The browser does not send a second logout request. A failed revocation leaves the session visible and reports the error.

## Sources

Cloudflare documents [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), [read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/), and [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/). [RFC 9700 section 4.14](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14) describes refresh rotation and family revocation after replay.
