In general: code quality matters. Avoid hacky solutions and don't ignore issues by claiming that they are "corner cases". A corner case is no less valuable, and a bug is a bug. Layering workarounds on top of broken code leads to more bugs so don't do that! If you have a choice between a major refactor that will do the Right Thing, and a small change that's patching over the problem or solving it in a hacky way, prefer the major refactor. Be aggressive about removing unused code. Make sure that your comments provide sufficient context as to _why_ something non-obvious is done the way it is, not just _what_ it does.

Default to doing all work on `main`. Never automatically switch to a `codex/` branch unless the user specifically asks you to use one.

When choosing between a narrow targeted fix and a broader correctness-first fix, prefer the broader "right thing" fix whenever it materially improves correctness.

Use strong typing to your advantage. Prefer approaches that guarantee correctness by construction: for example, prefer strongly typed data where types capture constraints and invariants as much as possible over ad hoc stringing together of things. Use typeclasses judiciously to extract common features and enable their use without duplication. 

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
