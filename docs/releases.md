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
Its artifact contains the check record and Pages build.
The artifact name includes the full checked commit. A green pull request head
does not prove that a different merge commit passes. Run the checks on the merge candidate.
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

Pending migrations stop the release. Review their effect on the currently running
code and data. If they are safe to apply before the code update, add
`--apply-migrations` to the release command. The script applies them to the selected
database, reads the migration history again, and deploys code only if none remain
pending. A remote migration missing from the source tree blocks a rollback.
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
check record. Its build hashes must match the local Pages build. Copy records to
the task's artifact storage before removing a release worktree. After that copy, delete the local records. CI candidate artifacts expire after 14 days.

If a step fails, examine the record and live metadata before you continue.
A failed upload can leave changes in Cloudflare. The script never retries a write or
rolls a Worker back on its own. An atomic operation completes all its changes together.
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
