# Authentication storage and cutover

Authentication records use D1 as their authority. Use the primary D1 binding for these operations. Do not put these reads in a replica session or cache their answers in KV. Account authentication also checks the active `users_index` row after reading the profile from KV.

A conditional update and all successor writes run in one `D1Database.batch()` transaction. A random claim identifies the one request that consumed an OAuth code, refresh token, or CLI approval. Each successor insert requires that claim. A failed batch rolls back consumption. Refresh tokens keep their consumed state until their grant expires. Reuse of a consumed code or refresh token revokes its grant and all access and refresh tokens in that family. Clients must serialize refreshes; a second concurrent refresh is treated as replay.

The browser consent endpoints require a browser session cookie and same-origin request evidence. A bearer token cannot approve either MCP or CLI access. An explicit `Origin` must match the request origin. When supplied, `Sec-Fetch-Site` must be `same-origin`. With no `Origin`, `Sec-Fetch-Site: same-origin` is required. Both forms have a GET for display and a POST for approval.

The OAuth POST response loads a fixed same-origin script that starts a fresh top-level navigation to the registered callback. It also provides a fallback link. This keeps the ordinary `form-action 'self'` policy and avoids browser differences when that directive checks a cross-origin redirect after a form submission. The page has `Referrer-Policy: no-referrer`. Callback URIs use HTTPS or HTTP on `localhost`, `127.0.0.1`, or `[::1]`. They cannot contain user information or a fragment. Exact registered URI matching still applies.

## Retention and admission

Migration `0059_auth_state.sql` defines the tables and their retention rules. `cleanupAuthRecords(db, now?)` deletes at most 500 expired auth records and 500 expired rate buckets per call, using expiry indexes. Schedule it in the maintenance path, including ticks that skip bot dispatch. Repeat bounded maintenance calls when a backlog exists.

| Record | Absolute lifetime |
| --- | --- |
| Browser session | 30 days |
| CLI token | 90 days |
| CLI approval or OAuth code | 10 minutes |
| MCP grant and its refresh lineage | 90 days from initial exchange |
| MCP access token | At most one hour and never after grant expiry |
| Unused MCP client | 30 days |
| MCP client after authorization | 180 days from authorization |
| Legacy token revocation marker | 90 days after revocation |
| Rate bucket | Two hours from the start of its hour window |

Refresh does not extend the grant lifetime. Expiry is enforced during reads and writes, so cleanup delay cannot restore authority. An account revocation cutoff has one row per account and stays for that account's lifetime. It also covers legacy credentials that the migration has not yet indexed.

Unauthenticated registration and CLI login initiation each permit 20 attempts per Cloudflare client address and 200 attempts globally per fixed hour. A rejected address does not spend the remaining global allowance. After the global allowance is spent, requests cannot create more address rows. Stored subjects are SHA-256 hashes, not raw addresses. Auth request bodies have a 16 KiB limit and a ten-second read deadline. Registration events and admission failures produce structured logs without bearer tokens. The fixed quotas trade availability under shared-address or global abuse for bounded storage; tune them explicitly when real usage requires it.

## One-time KV migration

New writers only write D1. The temporary schema-version-2 reader preserves valid existing browser sessions and CLI tokens. It never writes or repairs a record. It checks primary D1 revocation state before accepting a legacy token. Migration application fixes a deadline 90 days later; no request extends it. Schema version 3 disables the legacy reader sooner when the sweep finishes.

Existing MCP access and refresh tokens must be authorized again at cutover. The old records lack reliable refresh-family lineage, so importing them cannot provide replay detection. Existing OAuth codes and CLI approval requests are retired too. Restart those short-lived flows. Registered client metadata is preserved by the explicit sweep. Until client migration completes, an existing client may receive `invalid_client`; it must retry after cutover or register again.

Use the exported maintenance functions through the protected internal maintenance route. They require `BICKR_KV` and `BICKR_D1`; no new binding is needed. The route must require internal service authentication and scheduler authorization. Do not expose it as a public OAuth action.

1. Apply migration 0059 before deploying the D1 writers. Stop old writers for the cutover. Use the site's maintenance control and account for in-flight requests and KV propagation before marking any prefix complete. KV listing is eventually consistent. The sweep cannot prove that a still-running old writer has stopped.
2. Deploy the new writers. Keep ordinary auth traffic closed while client metadata migrates. Use `migrateLegacyAuthPage(kv, db, { prefix, dryRun: true, cursor? })` to inspect pages. Dry runs change neither D1 nor KV and do not advance progress. Continue with the returned cursor until `done` is true.
3. For each prefix, call `migrateLegacyAuthPage(kv, db, { prefix, dryRun: false })` until `done` is true. The function reads at most 50 keys. Real runs use their D1 progress cursor. Do not supply a caller cursor. The eight prefixes are `session`, `cli_token`, `mcp_client`, `cli_request`, `mcp_code`, `mcp_access`, `mcp_refresh`, and `mcp_grant`.
4. Each page commits the D1 imports before deleting its KV keys. Retry a failed call. Imports do not replace an existing record or a legacy revocation marker. The page result reports scanned, eligible-for-copy, retired, and invalid counts; `copied` means eligible imports, including rows already present on retry.
5. Call `finishLegacyAuthMigration(db)`. It returns true when all eight prefixes have completed and schema version 3 is set. Do not force this version manually. Verify that migrated browser and CLI credentials work, old MCP families fail, fresh authorization works, and all prefixes are empty after propagation. Then reopen auth traffic.
6. Remove the temporary legacy reader and migration module in the next schema release after the completed sweep and verification. That release must also remove the two transition/progress tables. Keep permanent revocation behavior. The fixed 90-day cutoff fails closed if operational completion is delayed.

The sweep retains no plaintext bearer token. It imports existing hashed keys and documents. OAuth provider sign-in state (`v1:oauth-return:`) still uses its separate short TTL and is outside this migration.

## Credential inventory and revocation

`GET /api/me/auth/credentials?after=<cursor>` returns at most 100 browser sessions, CLI tokens, or MCP grants and a `nextCursor`. IDs are record identifiers, not bearer tokens. It also reports `legacyMigrationComplete`. Before the sweep finishes, legacy browser/CLI credentials can be missing from the list.

`DELETE /api/me/auth/credentials` requires cookie authentication and the same browser origin checks as consent. Its JSON body is either `{"kind":"credential","id":"<inventory ID>"}` or `{"kind":"all"}`. The body limit is 1 KiB. A single-ID action only revokes a credential belonging to the signed-in account. Revoking an MCP grant revokes its entire family. The all action also revokes pending approvals and not-yet-migrated legacy credentials. It logs out the browser that issued it. Credential management has reusable storage hooks for a future account UI; this change supplies the API.

## Sources

Cloudflare documents [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), [read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/), and [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/). [RFC 9700 section 4.14](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14) describes refresh-token rotation and family revocation after replay.
