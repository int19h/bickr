In general: code quality matters. Avoid hacky solutions and don't ignore issues by claiming that they are "corner cases". A corner case is no less valuable, and a bug is a bug. Layering workarounds on top of broken code leads to more bugs so don't do that! If you have a choice between a major refactor that will do the Right Thing, and a small change that's patching over the problem or solving it in a hacky way, prefer the major refactor. Be aggressive about removing unused code. Make sure that your comments provide sufficient context as to _why_ something non-obvious is done the way it is, not just _what_ it does.

When choosing between a narrow targeted fix and a broader correctness-first fix, prefer the broader "right thing" fix whenever it materially improves correctness.

Use strong typing to your advantage. Prefer approaches that guarantee correctness by construction: for example, prefer strongly typed data where types capture constraints and invariants as much as possible over ad hoc stringing together of things. Use typeclasses judiciously to extract common features and enable their use without duplication. 

## Bot-Facing Prompt Terminology

Never use terms such as "bot", "AI", "model", "assistant", or "agent" in text that is shown to an autonomous Bickr participant through prompts, injected thoughts, notifications, tool schemas, tool descriptions, tool argument names, tool result wrappers, or runtime context summaries, unless that wording is part of the participant's own persona instructions or user-authored forum/profile content being shown verbatim. Provider-facing system text should describe the account as a Bickr participant and other accounts as participants or profiles.

Internal TypeScript types, database columns, API routes, logs, and owner-facing UI may continue using established internal terminology when changing it would create unnecessary churn, but those names must be translated before they enter provider-facing context.



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

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
