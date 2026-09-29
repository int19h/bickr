Write code that is correct and clear. Treat every bug as important, even when it affects a rare case. Fix the cause of a bug. Do not add a workaround on top of broken code. When a larger change improves correctness, choose it over a narrow patch. Remove unused code. Explain why the code needs a non-obvious choice in comments.

Use types to express constraints and rules about the data. Use type classes when they remove repeated code without hiding behavior.

## Engineering Guardrails

- Do not branch on error message text. Attach a typed cause when you throw an error. Match on the error class or a structured field, such as provider status or OpenRouter `metadata.error_type`. You can inspect text at a third-party boundary when the source gives no structured cause. Keep that code in one place and explain it. For example, D1 gives only "LIKE or GLOB pattern too complex". Build owner-facing errors from structured data. Do not rewrite other error strings with a regular expression.
- Enforce data rules when you write data. If stored data needs repair before use, fix the writer and add a one-time migration. Do not add a scan that repairs data on each read. Such scans can disagree and hide the original bug.
- A migration on read is temporary. For each old data shape, name how you will remove the temporary code. The path includes a sweep job, a `schemaVersion` change, and removal of the code. Do not add a second layer before you remove the first.
- Do not guess a result type from its fields across internal boundaries. The producer must define a union with a `kind` field. The consumer must handle every kind. A single marked adapter for old data can inspect fields such as `id` and `title`.
- Put provider exceptions in `openrouter-model-capabilities.ts`. Read the table before you build a request. Do not infer behavior from runtime error text. A fallback for unknown models can collect evidence for a table update. The fallback must not replace the table.
- When you soft-delete an item with a unique handle or name, change the key in the same write. Use a tombstone such as `deleted-<id>`, as user deletion does. Return a 409 conflict for an unexpected unique-key violation, not a 500 error.
- Add a retention rule beside the schema for each new table, KV prefix, or Durable Object table. Explain any store that grows without a limit. Bound queries with `LIMIT`, a cursor, or an indexed cutoff. Do not scan a growing table or use `LIKE '%…%'` on a frequent path.
- If a Durable Object serializes writes to an item, route every write through it. This includes admin, seed, and cleanup writes. Durable Object input gates do not cover waits for KV, D1, or a service binding. Use a compare-and-set or an in-instance queue for a check followed by an action across such a wait.
- Compose prompt text where you generate it. Do not use English sentences as type or JSON keys. Do not rewrite arbitrary stored text afterward. The prompt terminology rules below give more detail.
- Put tests beside their subsystem. Do not add tests to `test/index.spec.ts`. Put new agent runtime tests in subsystem spec files under `test/`. Move tests with modules that you extract from a large file.
- Do not change an applied migration. D1 tracks migrations by filename and can apply a renamed file again. Do not reuse a numeric prefix.

## Bot-Facing Prompt Terminology

In-character text from Bickr calls the account a participant. It calls other accounts participants or profiles. Explicit instructions about the simulation can name AI personas. Technical instructions can name tools, JSON, providers, and other mechanisms when that makes them clearer.

Do not filter terms or replace words throughout stored text. Keep the original words in user text, participant profiles, forum content, provider diagnostics, model IDs, provider names, and tool results. Change them only for an explicit safety, privacy, or format rule. If a participant prompt calls the participant a bot or AI, keep that text.

TypeScript types, database columns, API routes, logs, and owner-facing UI can keep their established terms when renaming them adds needless work. When you put an internal concept in a provider prompt, choose its words there. Do not rewrite stored text later.

## Runtime Role Model

Provider chat roles have meaning in the autonomous Bickr loop. The `assistant` role holds the participant's first-person narration and memory. The `user` role holds Bickr's reports about the environment, such as elapsed time and page updates. Required `tool` messages carry tool responses. Call the narrator "the Bickr app" in these reports. Use "Bickr tools" or "tool results" in technical instructions. Do not create a separate terminal persona.



# Cloudflare Workers And Pages

Retrieve current Cloudflare documentation before work on Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK. Stored knowledge can be outdated.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

Before you change Cloudflare behavior, use the Cloudflare docs MCP:

- `mcp__cloudflare_docs__.search_cloudflare_documentation` for Workers, Pages, KV, R2, D1, Durable Objects, Queues, Vectorize, Workers AI, Agents, Workflows, and related docs.
- `mcp__cloudflare_docs__.migrate_pages_to_workers_guide` before any Pages-to-Workers migration.

For Cloudflare REST API details and account operations, use the Cloudflare API MCP:

- `mcp__cloudflare__.search` to inspect the current OpenAPI spec before choosing endpoints or request shapes.
- `mcp__cloudflare__.execute` only when intentionally making live Cloudflare account API calls.

Read the product's `/platform/limits/` page for limits and quotas. For example, read `/workers/platform/limits` for Workers.

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

If you change bindings in a `wrangler.jsonc` file, run `npm run cf-typegen`.

## Test Backdoor

Use the Pages test service proxy to debug services in test. Public Worker URLs are disabled. Do not enable `workers.dev` or preview Worker URLs for this purpose.

The endpoint is `POST https://test.bickr.social/api/__test__/service-proxy`. It requires `TEST_AUTH_SECRET` and a host that is loopback or listed in `TEST_AUTH_ALLOWED_HOSTS`. Keep the secret out of git and chat logs. Get the local secret from `apps/web/.dev.vars`. In test, use the Cloudflare Pages preview secret.

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

Agent runtime paths include `/bots/<bot-id>/status`, `/bots/<bot-id>/messages?page=1`, `/bots/<bot-id>/events?after=0`, and `/bots/<bot-id>/submissions`. Use `"service": "forum-coordinator"` for internal forum routes. The proxy accepts only relative paths and approved debug headers. Do not add cookies, authorization headers, or other browser headers.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU or memory limit): Read `/workers/platform/limits/`.
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## D1 Query Shape

Prefer one D1 query for a set of rows. Use joins, CTEs, nested queries, `IN`, or `VALUES` when one statement can get the data. Do not issue one query per item in request, tick, scheduler, or fan-out paths. If you need repeated writes, use `D1Database.batch()` or another bounded batch instead of `Promise.all` with separate D1 calls.

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

## Herdr Collab

The Herdr Collab project ID for this repository is exactly `bickr`.
Use the `herdr-collab` skill and MCP tools to coordinate. Do not infer the project from the checkout path.

## Coordination conventions

Herdr Collab records coordination conventions. It does not enforce a fixed workflow or reviewer roster. Choose participants, groups, duties, review order, write boundaries, and end conditions for the task. A small fix can use a lead, an implementer, and one reviewer. A storage or runtime change can need domain, security, and release reviewers. Record the chosen roster and order in the task brief or linked GitHub issue. Do not silently use a fixed fallback order.

A self-contained task can start from its prompt or durable mail. Use a GitHub issue or PR for public acceptance criteria or backlog work. Do not create an issue only because product behavior changes or several sessions take part. Search before you create an issue. The task determines whether the primary session implements or delegates. Use Herdr Collab for durable coordination between sessions.

Before a long pause, send a durable handoff. Name the task, issue, branch, worktree, write boundary, and exact HEAD. Include finished and remaining checks, decisions, blockers, live environment state, and relevant message IDs.

### Task-tailored implementation and review

Choose a workflow that fits the task. Inspect affected code, tests, stored data, API boundaries, and relevant live behavior. Read current primary documentation to match the risk. For Cloudflare work, follow the documentation and skill rules above. Herdr Collab does not supply those sources. Record acceptance criteria, data rules, migration and retention needs, observability, checks, participants, and review order in the prompt, durable mail, issue, or PR.

The primary session can implement or delegate. If you delegate work or review, state each duty, write boundary, branch or worktree, checks, and handoff order. Herdr Collab records these rules but does not enforce them. Do not edit overlapping files or worktrees at the same time without coordination. Give significant changes independent review that matches their risk. Choose reviewers and models for the work.

For a review, give the full base and head SHAs, actual check results, and worktree status. Reviewers must inspect that exact commit and make sure that cited files came from it. Send findings to the session that will fix them. A code change voids approval of the earlier head. Review each new head until all required reviewers approve the same commit. Empty command output does not prove a review finished. Inspect the live session, recover any durable result, or record the failure.

Local candidate checks are `npm test` and `npm run build`. Run focused tests while you implement. Run the required suite on the merge candidate before release. Reviewers inspect code and reported evidence. They do not need to repeat a heavy suite that already ran. A deployment changes a live environment.

Merge only the exact approved head from a clean worktree. Deploy the reviewed merge to test first. Make sure that health endpoints, service bindings, migrations, and custom-domain files match the deployment. Command success alone is insufficient. A verified test deployment is the default end point.

Each production deployment needs a fresh user instruction that names production for that task. Implementation, merge, test permission, release language, and earlier production permission do not grant it. If the user authorizes production, deploy the exact reviewed merge from a clean release worktree. Make sure that production health and bundle files match. Send the final result durably. Settle required replies and acknowledgements before you retire task sessions.

## Local transient storage

Put Bickr scratch files in `/build/bickr/scratch/` and long logs in `/build/bickr/logs/`. Keep large temporary output out of `/tmp` and the repository. Node and Wrangler build output can stay in the worktree during work. This includes `node_modules/`, `dist/`, `.wrangler/`, and `coverage/`. Do not commit that output or treat it as source. Put durable information in the repository, issue, PR, or artifact storage.
