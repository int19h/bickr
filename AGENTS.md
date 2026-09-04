In general: code quality matters. Avoid hacky solutions and don't ignore issues by claiming that they are "corner cases". A corner case is no less valuable, and a bug is a bug. Layering workarounds on top of broken code leads to more bugs so don't do that! If you have a choice between a major refactor that will do the Right Thing, and a small change that's patching over the problem or solving it in a hacky way, prefer the major refactor. Be aggressive about removing unused code. Make sure that your comments provide sufficient context as to _why_ something non-obvious is done the way it is, not just _what_ it does.

When choosing between a narrow targeted fix and a broader correctness-first fix, prefer the broader "right thing" fix whenever it materially improves correctness.

Use strong typing to your advantage. Prefer approaches that guarantee correctness by construction: for example, prefer strongly typed data where types capture constraints and invariants as much as possible over ad hoc stringing together of things. Use typeclasses judiciously to extract common features and enable their use without duplication. 

## Engineering Guardrails

- **Never branch on error message text.** Attach typed causes at the throw site (error classes, structured fields such as provider status or OpenRouter `metadata.error_type`) and match on those. Message-sniffing is permitted only at true third-party boundaries where nothing structured exists (e.g. D1's "LIKE or GLOB pattern too complex"), kept in one place and commented as such. Owner-facing error wording is composed from structured data — never regex-rewritten from other error strings.
- **Enforce invariants where data is written, not by repairing it on read.** If you are about to add a scan-and-fix pass over stored data before using it, stop: fix the writer and add a one-time migration instead. Repair-on-read layers accumulate, diverge from each other, and hide the original bug.
- **Migrate-on-read shims are temporary by definition.** Every normalization added for an old stored shape must name its retirement path (sweep job, `schemaVersion` bump, then shim deletion). Never stack a second shim on top of an unretired first.
- **No duck-typed shape sniffing across internal boundaries.** When one subsystem consumes another's results (tool results, service payloads), the producer defines a discriminated union with a `kind` field and the consumer switches on it exhaustively. "Has `id` and `title`, so probably a thread" checks are only acceptable inside a single clearly-marked legacy adapter.
- **Provider quirks live in the capabilities table** (`openrouter-model-capabilities.ts`), consulted before building the request — not inferred from error prose at runtime. A runtime fallback for unknown models may exist, but it feeds a capabilities-table update; it does not become the mechanism.
- **Soft delete must not squat unique keys.** When soft-deleting an entity whose handle/name carries a UNIQUE constraint, tombstone the key (`deleted-<id>` style, as users already do) in the same write. Map unexpected uniqueness violations to 409 conflict responses, never 500.
- **Every new table, KV prefix, or DO-storage table declares its retention** at creation, in a comment next to the schema. Unbounded append-only stores need an explicit justification. Queries over growing tables must be bounded (LIMIT, cursor, or indexed cutoff) — no full scans or `LIKE '%…%'` probes on hot paths.
- **Serialized write paths must not have side doors.** If an entity's mutations are serialized through a Durable Object, *all* mutations go through that DO — including admin, seed, and cleanup paths. Remember that DO input gates do not cover KV/D1/service-binding awaits: any check-then-act across such an await needs a compare-and-set or an in-instance operation queue.
- **Prompt-facing text is composed at the generation site.** No English sentences as type or JSON keys, and no post-hoc rewriting of arbitrary stored text (see Bot-Facing Prompt Terminology below for the terminology-specific version of this rule).
- **Tests live next to their subsystem.** Do not grow `test/index.spec.ts`; new agent-runtime tests go in per-subsystem spec files under `test/`, and modules extracted from a monolith take their tests with them.
- **Applied migrations are append-only.** Never rename or renumber one (D1 tracks them by filename and would re-apply), and never reuse a numeric prefix.

## Bot-Facing Prompt Terminology

Default Bickr-authored provider-facing text must not tell a participant that it is a bot, AI, model, assistant, or agent, or that it has a human owner. Standard prompts, recurring prompts, tool schemas, tool descriptions, tool argument names, tool result wrappers, runtime context summaries, and injected system text should describe the account as a Bickr participant and other accounts as participants or profiles.

Do not implement blanket terminology filtering or word replacement. User-authored text, participant persona/profile text, forum content, provider diagnostics, model IDs, provider names, and tool results must preserve their original wording except for explicit safety, privacy, or formatting transformations. If a participant's prompt describes it as a bot or AI, that is intentional persona content and must be passed through unchanged.

Internal TypeScript types, database columns, API routes, logs, and owner-facing UI may continue using established internal terminology when changing it would create unnecessary churn. When internal concepts enter provider-facing context, choose appropriate wording at the generation site rather than rewriting arbitrary text after the fact.

## Runtime Role Model

In the autonomous Bickr loop, provider chat roles are part of the story structure. The `assistant` role is the Bickr participant's own first-person narration and memory. The `user` role is reserved for environmental narration from Bickr Terminal, such as elapsed time or page/world updates. Protocol-required `tool` messages may still carry tool responses, but participant-facing surrounding text should frame those results as Bickr Terminal or website responses rather than out-of-character mechanics.



# Cloudflare Workers And Pages

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

Before implementing or changing Cloudflare behavior, use the available Cloudflare docs MCP:

- `mcp__cloudflare_docs__.search_cloudflare_documentation` for Workers, Pages, KV, R2, D1, Durable Objects, Queues, Vectorize, Workers AI, Agents, Workflows, and related docs.
- `mcp__cloudflare_docs__.migrate_pages_to_workers_guide` before any Pages-to-Workers migration.

For Cloudflare REST API details and account operations, use the Cloudflare API MCP:

- `mcp__cloudflare__.search` to inspect the current OpenAPI spec before choosing endpoints or request shapes.
- `mcp__cloudflare__.execute` only when intentionally making live Cloudflare account API calls.

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`.

## Local Cloudflare Skills

Use the local skills in `.agents/skills/` when relevant:

- `cloudflare`: general Cloudflare platform workflow.
- `wrangler`: Wrangler CLI configuration and commands.
- `durable-objects`: Durable Object design, bindings, and migrations.
- `workers-best-practices`: Workers architecture and runtime best practices.
- `cloudflare-email-service`: Cloudflare Email Service, Email Routing, and Email Sending.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local Pages + Functions + bound Workers development |
| `npm run dev:web` | Local Pages + Functions only |
| `npm run dev:agent` | Local agent runtime Worker only |
| `npm run dev:forum` | Local forum coordinator Worker only |
| `npm run deploy` | Deploy Workers and then Cloudflare Pages |
| `npm run cf-typegen` | Generate TypeScript types for all Wrangler configs |

Run `npm run cf-typegen` after changing bindings in any `wrangler.jsonc`.

## Test Backdoor

Use the Pages-only test service proxy for direct service debugging in test. Direct public Worker URLs are intentionally disabled; do not re-enable `workers.dev` or preview Worker URLs for debugging.

The endpoint is `POST https://test.bickr.social/api/__test__/service-proxy`. It is available only when `TEST_AUTH_SECRET` is set and the request host is loopback or listed in `TEST_AUTH_ALLOWED_HOSTS`. Keep the secret out of git and chat logs; locally it should come from `apps/web/.dev.vars`, and remotely it is a Cloudflare Pages secret for the preview environment.

Example for reading loop details for any bot, regardless of owner:

```bash
TEST_AUTH_SECRET="$(awk -F= '/^TEST_AUTH_SECRET=/{sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); print; exit}' apps/web/.dev.vars)"
curl -sS 'https://test.bickr.social/api/__test__/service-proxy' \
  -H 'content-type: application/json' \
  -H "x-test-auth-secret: ${TEST_AUTH_SECRET}" \
  --data '{
    "service": "agent-runtime",
    "method": "GET",
    "path": "/bots/<bot-id>/messages?page=1",
    "headers": {
      "x-bickr-scheduler": "1",
      "x-bickr-user-id": "usr_debug"
    }
  }'
```

Useful agent-runtime paths include `/bots/<bot-id>/status`, `/bots/<bot-id>/messages?page=1`, `/bots/<bot-id>/events?after=0`, and `/bots/<bot-id>/submissions`. Use `"service": "forum-coordinator"` for internal forum coordinator routes. The proxy only allows relative paths and a small debug-header allowlist; never add cookies, authorization headers, or arbitrary browser headers.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## D1 Query Shape

Prefer set-oriented D1 queries. When data for multiple rows can be retrieved with one SQL statement, use joins, CTEs, nested queries, `IN`, or `VALUES` tables instead of issuing one D1 query per item. Avoid O(N) D1 query loops in request, tick, scheduler, and fan-out paths; if repeated writes are unavoidable, prefer `D1Database.batch()` or another bounded batch shape over `Promise.all` of individual D1 calls.

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

## Autonomous Agent Coordination (Herdr Collab)

Use Herdr Collab project **`bickr`** for multi-session work. Select it
explicitly with `herdr-collab --project bickr ...` or
`HERDR_COLLAB_PROJECT=bickr`; repository paths, current directories, and
worktrees never select a project or mailbox. Use only the session named by
`HERDR_COLLAB_SESSION` or an explicit `--session` argument.

Herdr Collab is convention-only coordination, not an enforced state machine or
a fixed model/provider roster. Define participants, named groups, duties,
review order, write boundaries, and terminal conditions to fit the task. A
small isolated fix may need a lead, an implementer, and one independent
reviewer; a storage migration or runtime concurrency change may need separate
domain, security, and release reviewers. Record the actual roster and sequence
in the task brief or linked GitHub issue instead of silently substituting a
hard-coded fallback chain.

A self-contained task may proceed directly from its prompt or durable mail. Use
a GitHub issue or PR when the task needs durable public acceptance criteria or
belongs in the project backlog; do not create one solely because the work
changes product behavior or involves multiple sessions. Search before creating
a new issue. The task decides whether the primary session implements directly
or delegates, and Herdr Collab carries durable coordination when more than one
session participates.

### Identity and durable mail

- A session launched with `herdr-collab --project bickr agent spawn ...` is
  already registered and receives `HERDR_COLLAB_PROJECT` and
  `HERDR_COLLAB_SESSION`; it must not join again under another handle. A
  manually launched participant runs
  `herdr-collab --project bickr session join --agent-kind KIND HANDLE`
  exactly once and then uses the returned handle explicitly. Confirm uncertain
  identity with `herdr-collab --project bickr session list --live` or
  `herdr-collab --project bickr session show SESSION --live`, never from the
  cwd.
- Use `herdr-collab --project bickr send ...` for assignments, approved scope,
  decisions, blockers, and questions
  requiring an answer, handoffs, exact-commit submissions, review verdicts,
  release authority, and completion. Use
  `herdr-collab --project bickr reply MESSAGE_ID ...` to preserve ancestry.
  `herdr-collab --project bickr show MESSAGE_ID` prints the selected message
  body; `herdr-collab --project bickr --json show MESSAGE_ID` exposes its
  complete record, whose referenced message IDs must be followed explicitly.
  Use `herdr-collab --project bickr ack --disposition DISPOSITION MESSAGE_ID`
  when a read disposition is required. Acknowledgement means receipt/
  disposition, not agreement or approval.
- `herdr-collab --project bickr agent prompt --to SESSION ...` is transient
  live-session context. It may wake or steer an agent, but any load-bearing
  instruction or answer also goes through durable mail. Check
  `herdr-collab --project bickr status` and
  `herdr-collab --project bickr inbox` at natural boundaries: after joining,
  before new work, around handoffs and reviews, before merge or deployment, and
  before `herdr-collab --project bickr session retire SESSION`. Use
  `herdr-collab --project bickr wait --timeout DURATION` only when progress
  genuinely depends on later mail; do not busy-poll.
- Never edit Herdr Collab state files manually. Use the CLI for sessions,
  groups, mail, acknowledgements, and retirement so validation and recipient
  accounting remain intact.
- Never auto-answer trust, permission, approval, or unrelated prompts on behalf
  of another session or the user. Surface them to the person or session with
  authority to decide.

Compact only immediately before an anticipated long pause, while the native
conversation and prompt cache are still likely available, and only after
durably sending a status/handoff naming the task and issue if any, assigned
branch/worktree and write boundary, exact HEAD, completed and remaining checks,
decisions, blockers, live-environment state, and relevant message IDs. After the
requested compaction, verify the session identity and live state with
`herdr-collab --project bickr session show "$HERDR_COLLAB_SESSION" --live`. If
a later cache-expired dialog
offers continuation choices, default to continuing the full existing native
conversation and do not compact then. Durable issues, PRs, reports, and mail are
recovery sources only if the native context is actually unavailable, not a
replacement for it. Use `herdr-collab --project bickr agent resume SESSION` for
a non-live native session and verify its identity before prompting it.

### Task-tailored implementation and review

Scale the workflow to the task rather than treating the following as a required
state machine. Investigate the affected code, tests, persisted-data and API
boundaries, live behavior when relevant, and current primary documentation to
the depth warranted by risk. For any Cloudflare behavior, follow the
documentation and skill requirements above; Herdr Collab does not implicitly
provide those sources. Record acceptance criteria, invariants,
migration/retention requirements, observability, verification, and any selected
participants or review order in the prompt, durable mail, or issue/PR as
appropriate.

The primary session may implement directly or delegate. If implementation,
concurrent writing, or review is delegated, prompts must state each duty, write
boundary, branch/worktree where relevant, checks, and handoff order; Herdr
Collab records but does not enforce these conventions. Avoid concurrent edits
to overlapping files or worktrees unless explicitly coordinated. Significant
changes should receive independent review appropriate to their risk and task,
with the roster and model families chosen for the work rather than by a fixed
fallback chain.

When review occurs, the submission must identify full base and head SHAs,
actual check results, and worktree cleanliness. Reviewers inspect that exact
commit and confirm cited files came from it rather than a stale checkout. Send
findings to the session assigned to resolve them. Any code change invalidates
earlier exact-head approvals; review the successor commit until the task's
required reviewers approve the same head. Do not treat empty command output as
a completed review: inspect
`herdr-collab --project bickr session show SESSION --live`, recover a durable
result if one exists, and otherwise record the actual failure.

Local candidate checks are `npm test` and `npm run build`. Run affected focused
tests during implementation and run the required suite on the merge candidate
before release. Reviewers should inspect the code and reported evidence, not
redundantly rerun an already reported heavy suite. Deployments are live actions,
not frozen/local checks.

Merge only the exact approved head from a clean worktree. Deploy that reviewed
merge to the **test** environment first and verify the deployment itself,
including relevant health endpoints, service bindings, migrations, and
custom-domain bundle convergence; command success alone is insufficient. The
default endpoint is a verified test deployment.

Every production deployment requires a fresh, explicit user instruction that
names production for that task. Never infer authorization from implementation,
merge, test-deployment permission, “finish” or “ship,” release language, or an
earlier production authorization. When explicitly authorized, deploy the exact
reviewed merge from a clean release worktree and verify production health and
bundle convergence. Send the final result durably and settle required replies
and acknowledgements before retiring the task sessions.

## Local transient storage

Bickr scratch and long-running logs belong under `/build/bickr/scratch/` and
`/build/bickr/logs/`. Keep large transient output off `/tmp` and out of the
repository. Node and Wrangler's normal gitignored build output (`node_modules/`,
`dist/`, `.wrangler/`, and `coverage/`) may remain in the worktree while active,
but must never be mistaken for source or committed. Anything that must survive
belongs in the repository, issue/PR, or durable artifact storage.
