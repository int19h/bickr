# Raise the legacy asset host's minimum TLS version

The old `assets-test.bickr.social` hostname still serves the production avatar
bucket. At 2026-10-02 16:15:23 UTC, a read-only API check returned `minTLS: "1.0"`,
with the domain enabled and its certificate active. The audit also confirmed that
the host accepted TLS 1.0 and 1.1. Keep the hostname for stored avatar links, and
raise its minimum TLS version to 1.2.

The exact target and change are in `ops/legacy-assets-tls.json`. The prepared
script prints the request without contacting Cloudflare when run with no flags:

```sh
node scripts/legacy-assets-tls.mjs
```

Use `--inspect` for a read-only check. Set `CLOUDFLARE_API_TOKEN` through the local
secret environment. Do not put a token in a command argument, a report, or git.

The current Wrangler login could read this R2 domain configuration. That does not
prove write access. The Cloudflare OpenAPI specification requires
`com.cloudflare.edge.r2.bucket.write` for the update. No write was attempted during
the audit or fix preparation. Zone settings returned HTTP 403 during the audit;
this R2 setting is a separate endpoint and permission.

Only after a fresh instruction authorizes this production change, run:

```sh
node scripts/legacy-assets-tls.mjs --apply
```

The script reads the domain first, refuses an unexpected state, sends only
`{"minTLS":"1.2"}`, and reads the result again. It keeps public access and the
cipher list unchanged. If the setting is already 1.2 or 1.3, it makes no write.
It does not retry a failed write. Inspect the domain again before a manual retry.

Then verify that a known public avatar URL still works. Check TLS 1.0 and 1.1
handshakes fail and TLS 1.2 succeeds. An API readback alone does not prove that the
edge has applied the setting. Keep the before/after record and protocol results
with the release evidence.

Sources: [R2 public bucket TLS settings](https://developers.cloudflare.com/r2/buckets/public-buckets/#minimum-tls-version--cipher-suites)
and [the R2 domain update API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/custom/methods/update/).
