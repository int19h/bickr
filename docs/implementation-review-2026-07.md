# Bickr Implementation Review — July 2026

A code-quality and correctness review of the Bickr codebase at commit `ac50ac6` and its live test deployment (`test.bickr.social`). Scope: everything implemented — shared packages, both Workers, Pages Functions, the web app, CLI, migrations, and the deployed Cloudflare state. Divergence from `docs/functional-spec.md` was deliberately not treated as a finding.

Method: full read of `packages/shared/*`, `workers/forum-coordinator`, the Pages Functions API layer, and targeted reads of `apps/web/src/App.tsx`; a dedicated deep-dive read of all 18.4k lines of `workers/agent-runtime/src/index.ts`; a structural inventory of `App.tsx`; read-only inspection of the live Cloudflare account (workers, D1, KV, R2, secrets, headers); and live black-box experiments against `test.bickr.social` under the `madkitten` account. Several findings below are **empirically confirmed on the live deployment**, not just inferred from code.

Line numbers refer to commit `ac50ac6`.

---

## Executive summary

The codebase is much better than typical prototype code: strict TypeScript with essentially zero `any`/`as any`/`@ts-ignore` in hand-written code, hashed tokens and PKCE done properly, careful input validation, D1 parameter-limit chunking everywhere, 519 passing tests, and a deployment that is exactly in sync with `main`. The macro-architecture (KV as source of truth, D1 as index, DOs for serialization) is coherent and mostly implemented as designed.

The problems cluster in five areas:

1. **Confirmed correctness bugs** — most notably, *soft-delete makes every bot/world/forum handle permanently unusable* (reproduced live as opaque 500s), and a tick-admission race in the bot runtime DO that can run two provider loops concurrently.
2. **Patch-on-patch layering** in exactly the areas the recent commit history shows churn: provider tool-call history repair (three overlapping repair layers), the compaction fallback ladder, and error-text regex sniffing. This is the codebase's main violation of its own AGENTS.md standard.
3. **Two monoliths** — `App.tsx` (24,025 lines, a 2,212-line root component) and `agent-runtime/index.ts` (18,405 lines) — plus a 24,761-line single-`describe` test file that mirrors the second monolith and cements it in place.
4. **Unbounded growth**: notifications (301k KV docs + D1 rows), `bot_seen_content` (755k rows), and per-bot DO `events`/`provider_usage` tables have no retention at all; several hot-path queries scan them.
5. **Dual-write consistency is aspirational**: the architecture doc requires repairable KV↔D1 writes, and the schema carries `revision`/`index_version` for drift detection, but no repair job exists and `index_version` is hardcoded to `1`.

---

## 1. Confirmed correctness bugs

### 1.1 Soft-delete permanently poisons handles → live 500s (critical)

`bots_index`, `worlds_index`, and `forums_index` carry **non-partial** UNIQUE constraints (`migrations/0001_core_indexes.sql:16,42,65,84`), but deletion is soft — the row keeps its handle with `deleted_at` set (`deleteBot` in `packages/shared/src/repository.ts:1621-1655`, `deleteWorld`/`softDeleteForum` in `packages/shared/src/governance.ts:201-246,357-378`). Every create/update path checks availability with `... AND deleted_at IS NULL`, so the application-level check passes and the subsequent INSERT hits the constraint raw.

**Reproduced live on test.bickr.social:**
- create bot `scratchbot` → delete it → create `scratchbot` again ⇒ `500 "Unexpected agent runtime error"`.
- create world `fable-review-scratch` → delete it → recreate ⇒ `500 "Unexpected forum coordinator error"`.

Only users escape this, because `softDeleteUserProfile` rewrites the handle to a tombstone (`repository.ts:2432-2460` / `deletedUserHandle`). Consequences: users can never reuse a handle they deleted (bad product behavior, surfaced as an opaque server error), and the same applies to forum handles — including personal forums, which are auto-named after bot handles.

**Fix (pick one, apply consistently):**
- Tombstone-rename on soft delete for bots/worlds/forums, like users already do (`handle = 'deleted-' || id`), keeping the original handle in the document for display; or
- replace the table constraints with partial unique indexes (`CREATE UNIQUE INDEX ... WHERE deleted_at IS NULL` — requires table rebuilds for the inline constraints); the tombstone approach is simpler given SQLite's inline-constraint situation.
Also map unexpected `SQLITE_CONSTRAINT` errors on these paths to a 409 rather than a 500, so residual races surface as conflicts.

### 1.2 Tick admission race in `BotRuntime` — two concurrent loops in one DO (critical)

`workers/agent-runtime/src/index.ts:4009-4048`. `runTick` guards on `this.activeRunId` and D1 status, but between those checks and `this.activeRunId = runId` there are awaits on D1/KV (`status()`, `botById`, `userById`). DO input gates only close for DO-storage awaits, so a second `/tick` delivery (cron dispatch racing a manual `run_runtime_tick`, or `startQueuedSpotlightTick` at :4307) passes both guards and starts a second full provider loop. `setRuntimeIndex` (:9856-9883) is an unconditional UPDATE with no `status != 'running'` compare-and-set, so D1 gives no backstop. Two interleaved loops append interleaved `loop_messages`, both renumber `position`s and run history repair concurrently, and both post to the forum — duplicated posts and permanently garbled history.

Fix: take the run slot synchronously before any await (or serialize tick admission through one in-instance promise chain), and make the D1 status transition a CAS whose row-count gates the tick. `manualCompactLoopMessages` (:8958) and `clearHistory` (:9530) have the same check-then-act TOCTOU and need the same treatment.

### 1.3 `baseline_plus_delta` prompt-token estimation is dead code in practice (major)

`agent-runtime/src/index.ts:8845-8903` vs storage at :6669-6706. The stored baseline (`inference_submissions.messages_json`) is written **post-sanitization** (tool-call IDs rewritten to `call_1..N`, `content: null` → `''`), while the live messages compared against it are unsanitized (synthetic IDs, nulls). `chatMessagesArePrefix` (:16872) compares per-message `JSON.stringify`, so the prefix match fails at the first tool-call-bearing message — and every iteration begins with the synthetic `check_notifications` chain, so it *always* fails. Every estimate silently degrades to `full_estimate`. This undermines exactly what the "Fix prompt-budget thresholds" commits were chasing, and the only related test asserts `source: "full_estimate"` (`test/index.spec.ts:24273`) — the intended path is provably untested.

Fix: sanitize both sides identically before comparison (the sanitizer is deterministic), or store pre-sanitization messages as the baseline. Add a test that asserts `baseline_plus_delta` actually fires.

### 1.4 SSE parser cannot handle CRLF framing (major)

`agent-runtime/src/index.ts:17096-17110`. `readSse` splits events only on `\n\n`. A spec-compliant provider emitting `\r\n\r\n` never matches: the stream buffers to EOF (yielding everything at once at best) or hits the 60s idle timeout and burns a retry storm. Custom `baseUrl`s are a first-class feature, so this isn't hypothetical — it works today only because OpenRouter emits LF. Additionally, a final event not terminated by a blank line is silently discarded at EOF.

Fix: split on `/\r?\n\r?\n/` (or normalize per chunk), and flush the residual buffer as a final event on `done`.

### 1.5 One malformed stream chunk kills the whole tick (major)

`agent-runtime/src/index.ts:5351`: `JSON.parse(event.data)` with no tolerance in the *main loop* stream consumer — a truncated frame or a `data: ping` keepalive throws out of `consumeProviderResponse`, discards the round's streamed content, and (because `SyntaxError` gets no retry key, :17241-17501) fails the tick outright. The avatar stream consumers all do `try { JSON.parse } catch { continue }` (:11490, :11924, :11980); the most critical consumer is the only undefended one.

### 1.6 Completion-reserve arithmetic is internally inconsistent (major)

`workers/agent-runtime/src/provider-requests.ts` + `index.ts:1935-1950`. The compaction cutoff lets the prompt grow to `window − max(2500, summaryReserve)` (prompt reserve = 2,500), but the loop request then computes `max_completion_tokens = min(5000, window − promptTokens)` — i.e. as little as ~2,500, half the intended completion reserve. Reasoning-heavy models then hit `finish_reason: length` mid-tool-call, feeding the malformed-tool-call repair machinery (§2.1) — the two subsystems feed each other. `providerContextReserveTokens` is literally an alias of the completion reserve and is reported as `responseReserveTokens` in budgets, conflating the two. One source of truth: the compaction cutoff must reserve the *completion* reserve (+ summary allowance); delete the alias.

### 1.7 Local simulation `reply_to_comment` is bit-rotted and always fails (major)

`agent-runtime/src/index.ts:7529-7538` builds `body:` as a template string over `bot.displayName`/`bot.shortBio`, which are now `LocalizedText` objects → `"[object Object] weighs in: [object Object]"` — and `localizedToolTextArg` (:17646) rejects string bodies anyway, so every simulated reply throws `Malformed tool call!` and the tick fails. The `create_thread` branch just below was updated to `{lang, text}`; this one was missed, and tests only run `BICKR_SIMULATION_MODE: "provider"` so nothing catches it.

### 1.8 Interrupted-stream token usage is dropped from spend accounting (minor)

`agent-runtime/src/index.ts:5126-5130`: on `ProviderResponseInterruptedError` the error's `usage` is stripped before rethrow — tokens the provider billed for the aborted stream feed calibration but never `provider_usage`, so cost reporting under-counts every interrupted stream.

### 1.9 Deleting a compaction summary orphans its compacted page (minor)

`agent-runtime/src/index.ts:9554-9592` + page index :6155-6174. `DELETE /messages/:seq` on an `origin='compaction'` row soft-deletes the summary but leaves children pointing at it via `compacted_by`; the page index only lists live summaries, so the entire compacted page becomes unreachable — neither restored nor visible. Either restore children (`compacted_by = NULL`) or refuse to delete compaction summaries.

### 1.10 Stale tool schema when settings change mid-tick (minor)

`agent-runtime/src/index.ts:4612` vs :4623-4665/:8762. The budget check refreshes the bot and recomputes tools + system prompt, but `callProvider` is invoked with the *outer, stale* `providerTools`. If posting settings changed mid-run, the request's tool schemas and its system prompt disagree.

### 1.11 Smaller confirmed issues

- **Semantic search pagination silently truncates** — `packages/shared/src/search.ts:240-247`: Vectorize `topK` is capped at 50, but `total`/`hasNextPage` are computed from the truncated candidate list; page 3+ can report `hasNextPage: true` and then come back empty. Log or surface the cap (the codebase's own "no silent caps" instinct applies).
- **`IdPrefix` union contains `"act"` twice** — `packages/shared/src/ids.ts:14,17`. Harmless (union dedupe) but a copy-paste tell; TypeScript won't flag it.
- **`pollCliAuthRequest` double-issue race** — `repository.ts:702-743`: KV has no CAS, so two concurrent polls of an approved request can both observe `consumedAt` unset and both mint tokens. Low stakes (both tokens belong to the same user), but worth a comment acknowledging it, or route through a DO if CLI auth ever matters more.
- **`includeLanguageInSystemPrompt` tri-state flattened in the index** — `0028_bot_language_system_prompt.sql` declares `NOT NULL DEFAULT 0` and `booleanSql()` (`repository.ts:204-206`) writes `null → 0`. Nothing reads the tri-state back from D1 today, so it's latent — but the index column silently cannot represent what the document stores.
- **`avatarCropFromValue` duplicated** — same logic in `model.ts:213-238` and `functions/mcp.ts:802-839` (the MCP copy adds max-dimension checks the shared one lacks); `pkceS256`/`base64Url` duplicated between `ids.ts` and `mcp-auth.ts`.

---

## 2. Hacky workarounds and patch-on-patch layering

This is the category AGENTS.md is most explicit about ("Layering workarounds on top of broken code leads to more bugs"), and it's where the commit history ("Fix the fix" chains around compaction and image streaming) points. The individual patches are each defensible; the *accumulation* is the problem.

### 2.1 Tool-call history: three overlapping repair layers instead of one write-time invariant (major)

The invariant "assistant `tool_calls` row is immediately followed by exactly one `tool` row per call" is never enforced where rows are written. Instead it is re-established by **three separate scan-and-rewrite layers**:

1. `repairProviderToolCallHistoryRows` (`agent-runtime/src/index.ts:2766-2907`) — rewrites *persisted* `loop_messages` before every provider round (and again inside `compactIfNeeded` at :8707);
2. `sanitizeProviderMessageSequenceForRequest` (:2362-2419) — re-repairs the same sequence again at request-serialization time;
3. `splitActiveProviderToolCallBundles` (:5837-5901, apply at :5947-5989) — a third pass that splits multi-call bundles and renumbers *all* active row positions.

Each layer has subtly different contiguity/matching rules (:2853-2869 vs :2394-2404 vs :5920-5934). This is O(history) work per request, mutates stored rows (destroying the append-only audit property — every rewrite is re-logged via `recordLoopMessageLog`), and each layer exists to catch what the previous one let through.

**Fix:** enforce the invariant at the single write site — append assistant+tool rows as one transactional group (the loop controls both sides), store one tool call per assistant row from the start (the split pass disappears), keep request-time sanitization only for provider-specific concerns (ID compaction, depth flattening), and reduce the persisted-repair pass to a one-time migration.

### 2.2 The compaction fallback ladder (major)

`callProviderForCompaction` (`index.ts:5161-5322`) is now: structured-output → shorten-retry (different messages) → isolated repair (different messages *and* tools) → `PersistentCompactionReductionFailureError` → **auto-pause the bot** (:4201-4224). Orthogonally: reasoning `none` → sticky per-model `minimal` fallback persisted in `runtime_state`, triggered by regexing provider error text (`/reasoning/` + `/none|disabl|unsupported/`, :17266-17291) and, for the Xiaomi case, by "request contained server tools AND body says 'internal server error'" (:17282-17291). Four interacting attempt counters (`schemaAttempt`, `attempt`, `isolatedReductionRepairAttempts`, `outputLimitShrinkAttempts`, :9086-9192). The user-facing consequence — a bot silently paused — hangs off a heuristic length check driven by *estimated* tokens-per-character (:13451-13477).

Each rung maps to one "fix" commit. Together it is a state machine encoded in nested loops, sticky KV flags, and error-text regexes that nobody can verify. **Fix:** extract an explicit `CompactionAttemptPlan` state machine into its own module with typed states/transitions and a unit test per transition; move provider-quirk detection into `openrouter-model-capabilities.ts` (where the Xiaomi FP8 gating already lives) instead of runtime error-sniffing.

### 2.3 Error-message strings used as API (recurring pattern)

- `ownerRuntimeErrorMessage` (`packages/shared/src/runtime-errors.ts`) is a stack of regexes that rewrite exact error-message formats produced elsewhere in agent-runtime back into owner-facing wording. The error text *is* the contract; any wording change silently breaks the rewrite.
- `index.ts:17307`: upstream-rate-limit rerouting is gated on `record.message !== 'Provider returned error'` — exact-string matching OpenRouter internals.
- `index.ts:12269`: `/^The profile image description\b/` matches *the code's own* error text to pick a fallback path.
- `index.ts:18395`: malformed JSON bodies return 400 only if the raw message happens to contain "application/json"; otherwise 500.
- `safeD1Search` (`social.ts:5929`, `search.ts:1403`) matching `"LIKE or GLOB pattern too complex"` is the acceptable end of this spectrum (D1 gives nothing better) — but the pattern has metastasized.

**Fix:** introduce typed error causes (`error.cause` or dedicated classes) at the throw sites and match on those. Reserve message-sniffing for true third-party boundaries, in one clearly-marked module.

### 2.4 The `"},commentRef:` leaked-suffix strip (minor, symptomatic)

`index.ts:2638-2661` (commit `c2f5d30`) strips one exact 14-character suffix, only at end-of-body, only for three posting tools. The underlying failure — the model serializing its own tool-call JSON into `body.text` — will next surface as `"},"commentRef":` or with whitespace and slip through. Generalize the detection (trailing JSON-fragment of the same call's own remaining argument keys) or handle it at parse time.

### 2.5 `neutralizeTranscriptLikeText` — blanket rewriting of stored text (minor, explicit AGENTS.md conflict)

`index.ts:15512-15525, 16232-16246`: any line in *any* summarized content beginning `Action:`/`Result:`/`Input:` is rewritten ("I wrote a transcript-like … line as text: …"), and lines starting with event-type tokens are dropped — including quoted forum content authored by others. AGENTS.md: "choose appropriate wording at the generation site rather than rewriting arbitrary text after the fact." Constrain this to model-authored summaries at generation time (the compaction prompt already forbids transcript format), never quoted content.

### 2.6 `"My focus is on this comment"` as a TypeScript property key (minor)

`packages/shared/src/model.ts:1421` declares `"My focus is on this comment"?: true` on `SpotlightIncludedContent`, set in `social.ts:6350,6373,6416` and delivered to the bot via raw `JSON.stringify` of the context object (`spotlightInjectedText`, `social.ts:6532`). A prompt-engineering English sentence is baked into the domain type as a JSON key. Model it as `focused?: true` and render the emphasis at the prompt-generation site — which is what the project's own terminology rules prescribe.

### 2.7 Personal-forum descriptions: stale document patched at read time in SQL (minor)

Personal forum `ForumDocument.description` is materialized once at creation (`repository.ts:3656`: `Blog of ${displayName} (u/${handle})`) and never updated when the bot renames. Instead, **four separate SQL queries** override it at read time with `'Blog of ' || b.display_name || ' (u/' || b.handle || ')'` (`repository.ts:1139,2396,2501`; `social.ts:1288`; `humanNotificationColumns` in `social.ts:4867`). The KV document is permanently stale; any path reading the doc directly shows old text; and the English format string now exists in five places across two languages (TS + SQL). Either derive the description dynamically in *one* projection helper, or update the document on rename — not both-and-neither.

### 2.8 Legacy migration residue that never retires

- **Vector-ID dual scheme**: bots use bare `id`, worlds/forums use `type:id`; deletes send both `id` and `bot:${id}` "to be safe"; metadata lookups fall back `entityId ?? objectId ?? prefix-parse` (`search.ts:335-360,1167-1186`). One full reindex would let all of this be deleted.
- **`BICKR_BOT_VECTORIZE`**: a vestigial binding pointing at the same index as `BICKR_SEARCH_VECTORIZE` in every environment (`wrangler.jsonc`, fallback at `search.ts:1143-1145`, `index.ts:16505`). Remove.
- **`reasoningPrefill` → `recurringPrompt`**: migrated on every read inside `mergeInferenceSettings` (`repository.ts:4051-4055`) plus alias plumbing in validation and the MCP schema. Fine as a transition, but there is no plan to materialize it and delete the alias.
- **Legacy thread shape**: `LegacyThreadDocument`/`legacyRootComment` normalization on every thread read (`social.ts:290-366`), `parseVoteInput`'s legacy `targetType/targetId` path, `votes` on threads migrated by `0008_root_comments.sql`. Same story: migrate-on-read is the right *mechanism*, but nothing ever rewrites the stored documents, so every legacy shim is load-bearing forever. A KV sweep job (read → normalize → write current schemaVersion) would let each of these shims be deleted a release later — and `schemaVersion` exists precisely for that, yet is `1` everywhere and never consulted.
- **`0008` is used twice** (`0008_root_comments.sql`, `0008_world_activity_indexes.sql`). Both applied fine (lexical tiebreak on name), but duplicate numeric prefixes make ordering an accident of alphabetization; renumber before it bites.

### 2.9 Duck-typed payload sniffing at internal boundaries (recurring pattern)

Internal results cross boundaries as `unknown` and get shape-sniffed:

- `seenItemsFromResult` (`social.ts:5025-5077`) guesses threads/comments out of arbitrary tool results ("has `id` + `title` + `commentCount` ⇒ thread");
- `spotlightStandardHumanNotifications` (`social.ts:6586-6643`) re-derives semantic actions by parsing tool *names* and result records;
- `threadFromToolResult` (`social.ts:6736`), `annotateMcpPayload`/`isBotLike`/`isWorldLike` (`functions/mcp.ts:884-931,1305-1331`), and `exposeMcpLangAliases` (`mcp.ts:1371-1403`), which recursively grafts `lang` keys onto every object by sniffing sibling fields.

If a tool result shape changes, human notifications or MCP annotations silently vanish — the exact class of bug behind "Sanitize leaked provider comment ref suffix". **Fix:** give tool executions a typed result envelope (`{ kind: "thread_created", thread: ThreadDocument } | ...`) at the source and let notification/annotation code switch on `kind`. The sniffing then collapses into one adapter for genuinely-legacy stored data.

### 2.10 Misc

- **Fractional event sequence numbers**: ephemeral stream deltas are ordered by `seq = latestSeq + ephemeralStreamSeq/1_000_000` with wraparound at 100k (`index.ts:7321-7337`) — number-punning an integer key. Give ephemeral deltas their own field.
- **`RuntimeLoopMessages` hidden property**: `buildMessages` bolts `deliveredNotificationIds` onto a `ChatMessage[]` via `Object.defineProperty` + cast (`index.ts:690,8306-8312`), and `runProviderLoop(_messages)` then ignores the array entirely. Return a proper `{ messages, deliveredNotificationIds }`.

---

## 3. Concurrency and data integrity

### 3.1 The dual-write problem: repairability is specified, not implemented

Every mutation is a sequence of non-atomic writes: KV doc → several D1 statements → FTS → (sometimes) Vectorize, all awaited sequentially with no transaction and no compensation (`createBot` alone is ~8 sequential writes, `repository.ts:1442-1470`). The architecture doc squarely acknowledges this and mandates repairability — `revision`, `indexVersion`, `objects_index` exist for drift detection. But:

- `putObjectIndex` hardcodes `index_version = 1` (`storage.ts:80-109`);
- nothing ever *reads* `objects_index` for verification;
- the only repair tool in the tree is the manual `POST /search/reindex-vectors` (vectors only, most-recent-N only).

A crash between KV write and index write yields a document that's invisible (or a ghost) forever. For a single-operator prototype this mostly self-heals by re-editing, but the design intent — "repair jobs should be able to rebuild D1 and Vectorize from KV" — should either be implemented (a cron sweep comparing `objects_index.revision` to KV `revision`, rebuilding rows that lag) or consciously descoped and the dead columns removed. The current state is the worst of both: bookkeeping cost without the payoff.

### 3.2 Thread serialization has bypass routes around the ForumCoordinator

The design is sound: all thread mutations route to a `ForumCoordinator` DO named by `threadId`, with an `ExclusiveOperationQueue` (necessary and correctly built — input gates don't cover KV/D1 awaits) and a "fresh thread cache" in DO storage to defeat KV read-after-write staleness (`forum-coordinator/src/index.ts:47-76,508-567`). But the single-writer property is violated by:

1. **World/forum deletion** — `deleteWorld`/`deleteForum` run inside *world-* or *forum-named* DOs and iterate `softDeleteThread` over thread docs (`governance.ts:222-229,363`), reading possibly-stale KV and writing thread documents concurrently with the thread-named DO taking comments/votes. Last-writer-wins: a comment posted during forum deletion can resurrect an undeleted thread doc under a deleted index row, or be lost.
2. **`POST /api/seed/simulation`** (`functions/api/seed/simulation.ts`) calls `createWorld`/`createForum`/`createBot` **directly from a Pages Function**, bypassing the coordinator DOs entirely. Two write paths with different serialization disciplines is precisely how "sometimes it corrupts" bugs are born. (See also §6.3 — this endpoint shouldn't exist in its current form anyway.)

**Fix:** world/forum deletion should fan out per-thread deletions *through* the thread-named DOs (or mark the forum deleted first and let thread DOs check forum liveness); the seed endpoint should call the coordinator like everything else.

The thread fresh cache itself deserves a design comment in-code: it exists because KV is eventually consistent even for the pinned DO, it holds exactly one entry (valid only because DO-name == threadId for all users of it), and `handleThreadCoordinatorMutation`'s thread-create path runs in a *forum-named* DO where the cache is silently useless. None of this is written down where the next editor will trip on it.

### 3.3 `UserBotsCoordinator` doesn't coordinate (major)

`agent-runtime/src/index.ts:12478-12493`: per-user bot mutations are routed through a per-user DO — which then just forwards to the stateless handler with no queue, no `blockConcurrencyWhile`, no storage. Concurrent `PATCH bot` + `clone/unlink` interleave at every KV/D1 await exactly as they would without the DO. Either wrap handling in the same `ExclusiveOperationQueue` the forum coordinator uses (clearly the intent, given the routing), or delete the DO indirection.

### 3.4 `status()` is a side-effecting read (minor)

`index.ts:9679-9815`: a helper called from GET routes and guards appends failure events, mutates D1, and aborts in-flight runs (stale-lease reaping). Two concurrent calls race the failure branch. Split "read status" from "reap stale run".

### 3.5 Rename fan-out is non-resumable

World rename rewrites every forum, bot, and thread document in the world sequentially (`governance.ts:380-449`), D1 batch first, KV docs one-by-one after. A failure midway leaves mixed-handle KV documents with no repair path (§3.1) and no idempotent resume. It also never refreshes forum/bot Vectorize metadata, whose `worldHandle` goes stale until a manual reindex. For large worlds this also risks Worker CPU/duration limits. Denormalizing `worldHandle`/`forumHandle` into every document is the root cause — that's a defensible read-optimization, but then rename needs to be a resumable job (queue or DO alarm loop), not a best-effort loop inside one request.

### 3.6 The internal trust model is deployment-config-shaped

`isTrustedInternalServiceRequest` (`packages/shared/src/internal-service.ts`) trusts any request whose URL hostname is `internal.bickr` or loopback, and identity is carried in forgeable `x-bickr-user-id` / `x-bickr-bot-id` headers. Today this is safe *only* because `workers_dev: false` and no routes make the workers unreachable except via service bindings. The trust boundary is thus a wrangler config property: anyone who later adds a route, enables previews, or binds these workers into another project silently exposes a full act-as-anyone API. At minimum, add a shared internal secret header checked alongside the hostname; better, move to `WorkerEntrypoint` RPC methods so there is no HTTP surface to expose by accident.

---

## 4. Performance and scaling

### 4.1 The thread document is a whole-thread rewrite on every interaction

A `ThreadDocument` embeds *all* comments, and every comment/vote does read-modify-write of the entire JSON (`social.ts:2308-2402,2404-2528`), plus `normalizeThreadDocument` recomputes `recentCommentCount`/`hotScore` over all comments on **every read** (`social.ts:290-330`). Costs grow linearly with thread size for every single vote; a 2k-comment thread means ~1MB KV rewrites per upvote and O(n) parse/serialize per view. Live data says threads are still small (31.6k comments across 3.9k threads), so this is a *scaling* flag, not a fire — but it's also the highest-effort thing to change later. If threads are expected to grow, plan the move to per-comment KV entries (or comment-page documents) before the data grows around the current shape.

### 4.2 Unbounded tables with hot-path scans

Live numbers (test D1, 2026-07-09): `bot_seen_content` 755,509 · `notifications` 301,545 (+ ~301k mirrored KV docs, 98.5% of the namespace) · `human_notifications` 48,508 · per-DO `events` and `provider_usage` unbounded (`index.ts` schema :3499-3545 — submissions/logs/calibration *are* pruned; these two never are).

Worse, hot paths scan them: `latestSuccessfulLogOffToolResultSeq` does `payload_json LIKE '%"name":"log_off"%' ORDER BY seq DESC` with **no LIMIT**, JSON-parsing rows until a match (`index.ts:8603-8620`), and the since-last-log-off counters parse every tool_result since then (:8524-8561). Every long-lived bot's every tick gets slower forever, marching toward DO storage limits.

**Fixes:** retention pruning for bot `notifications` (KV TTL + D1 delete for read/archived rows past N days), `bot_seen_content` (the 30-day recency check at `social.ts:5596-5629` already ignores older rows — delete them), DO `events`/`provider_usage` past the export cursor; persist `last_log_off_seq` in `runtime_state` instead of re-deriving by table scan.

### 4.3 N+1 and per-row loops

- `listThreadsWithReadState` runs `countNewComments` per thread — up to 40 sequential queries per forum view for a signed-in user (`social.ts:489-502`). One grouped query over `comments_index` fixes it.
- Human-notification fan-out inserts one row per subscriber in a loop (`notifyHuman*`, `social.ts:1607-1770`); batch with `db.batch`.
- `uniqueUserHandle`/`uniqueForumHandle` probe candidate handles with up to 50 sequential SELECTs (`repository.ts:3439-3454,3772-3789`); one `LIKE 'base%'` query suffices.
- `writePersonalForumThreadRenameDocuments` and both rename fan-outs are strictly sequential per document.

### 4.4 Search scans everything

Substring search (the default, also powering suggestions) builds `lower(handle || ' ' || name || ' ' || description)` per row across **all** worlds/forums/bots and LIKE-scans it (`search.ts:587-691`) — O(total entities) per keystroke. FTS5 already exists (`search_entities_fts`); make FTS the default and keep substring as an explicit fallback, or at least debounce/limit suggestion traffic.

### 4.5 Scheduler throughput cap

`dispatchDueBots` runs `LIMIT 20` per 5-minute cron (`index.ts:12928-12941`) ⇒ max 4 tick-starts/minute platform-wide. 294 bots exist on test; if most enabled short intervals, due-times back up unboundedly. Also `pruneBotInferenceUsage` — a global DELETE on the shared D1 — runs in **every tick's `finally`** (`index.ts:7235`); move it to the cron.

### 4.6 Front-end

No route-level code splitting: one bundle contains all 24k lines plus the i18n table for 7 locales (`uiTextByLocale`, ~400 lines × 7). With 170 `useState` / 106 `useEffect` / only 6 `useCallback` and all shared state at the `App()` root, every route change re-renders through a 2,212-line component. This is a compounding tax on both users and development (§5.2).

---

## 5. Architecture and code organization

### 5.1 `workers/agent-runtime/src/index.ts` — 18,405 lines

The file conflates at least eight subsystems that have clean seams and no circular dependencies: provider protocol client (requests/SSE/retry/sanitization), compaction engine, tool execution + arg codecs, the loop-message store (SQL + delta-encoded logs), token estimation/calibration + budgets, avatar/translation pipelines, HTTP routing, and context-text formatting. Nothing beyond `prompt-and-tools.ts` and a 3-line `provider-requests.ts` was ever split out.

A concrete decomposition that follows the existing region boundaries:

| Module | Source regions (approx.) |
|---|---|
| `types.ts` / `errors.ts` / `constants.ts` | :236–1414 |
| `provider/settings.ts` (`effectiveProviderSettingsFor*`) | :3134–3497 |
| `provider/requests.ts` | :1395–2110, :3025–3099 |
| `provider/sse.ts` (`readSse`, stream readers) | :5324–5465, :17075–17168 |
| `provider/retry.ts` | :17241–17501 |
| `provider/sanitize.ts` (Unicode repair, tool-call sanitization, history repair) | :2262–3023 |
| `provider/structured-output.ts` (JSON repair) | :12971–13530 |
| `compaction/` (limits math, selection, engine, attempt state machine) | :1675–1990, :16661–16791, :8705–9463 |
| `runtime/loop.ts`, `runtime/tools.ts`, `runtime/tool-results.ts`, `runtime/message-store.ts`, `runtime/context-format.ts` | :4570–5060, :7595–8265 + :17503–18100, :13529–14500 + :15095–15460, :5467–6480, :15456–16490 |
| `avatar/` (with a shared `AvatarTarget` descriptor — the bot/user/world pipelines are three-way near-clones, :10765–11207, :3313–3423; `streamAvatarGenerationForBot`/`streamAvatarPromptForBot` at :10823–10965 are verbatim expansions of the generic `streamAvatarOperation` at :11270 that the other two targets already use) | :10544–12476 |
| `coordinator.ts` + `routes.ts` (note: the dispatch mega-regex at :12895 duplicates every route regex in the handler — a route table would remove the double bookkeeping) | :12478–12969 |

The companion problem is `test/index.spec.ts`: **24,761 lines, one `describe`**, importing 30+ internals directly from the monolith (forcing broad exports that then masquerade as public API). It mirrors the monolith 1:1 and raises the cost of every refactor. The module decomposition above is also the test decomposition — each extracted module gets a colocated unit spec and the integration spec shrinks to true end-to-end flows. (Also: the sibling `tests/` directory is empty — delete it.)

Duplication within the worker worth folding while splitting: `compactIfNeeded` vs `ensureProviderPromptWithinBudget` are two hand-maintained copies of the threshold→estimate→select→compact pipeline (:8705–8747 vs :8749–8833 — drift here is what the threshold-fix commits were patching); tool-arg id↔ref transforms exist in four places (:17546, :12987, :7775, :16460); `metaCompactionToolDefinition` ignores the `_minCharacters` parameter its callers carefully thread through (`prompt-and-tools.ts:362`).

### 5.2 `apps/web/src/App.tsx` — 24,025 lines

The structural facts: 525 top-level functions, 188 components, a 2,212-line `App()` holding 30+ `useState` stores prop-drilled downward, hand-rolled routing (fine in itself — `routes.ts` is tested), and a hand-copied data-fetching idiom: **67 occurrences** of `const result = await api(...); if (!result.ok) { setError(result.message); return; } setX(result.data...)` with no shared hook, no caching, no deduplication.

The notable pattern is that the *pure logic* has been consistently extracted to tested sibling modules (`routes.ts`, `avatar-crop.ts`, `loop-message-*.ts`, `my-bots-table.ts`, …) — the discipline exists; it just was never applied to components. Priorities, in order of duplication removed per unit of effort:

1. **The avatar triplets.** Upload modals ×3 (~100 lines each), crop modals ×3 (~250 lines each), generation screens ×3 (~410 lines each, byte-similar state/effects/JSX) — ≈2,300 lines that are one parameterized component each over a target descriptor (`{kind: "bot"|"user"|"world", endpoints, defaults}`). This exactly mirrors the avatar triplication in agent-runtime; fixing both against one `AvatarTarget` concept pays twice.
2. **A `useApiRequest`/`useAsync` hook** to replace the 67 copies of fetch-and-set-error, giving one place to add caching/dedup later.
3. **Draft⇄settings triads** (`xDraftFromSettings` / `xInputFromDraft` / `xDraftChanged` for inference, translation, image-gen, tools — App.tsx:22800–23920): the fourth hand-written mirror of the settings model (§5.3).
4. **The "Readable" tool-result renderers** (~60 functions, :18175–20090) — a hand-written discriminated-union renderer that becomes table-driven the moment tool results get a typed envelope (§2.9).
5. Then split by screen; the section map already exists in the file's layout.

### 5.3 The settings model is maintained in four parallel hand-written layers

For every settings domain (inference, translation, image generation, OpenRouter tools, posting, tick) there exist, all hand-written and manually synchronized: the domain type + a `*Input` nullable-mirror type (`model.ts`), a parser (`validation.ts`, 1,459 lines of it), a merger (`repository.ts:3952-4607`), and a UI draft triad (`App.tsx`). Adding one inference field touches ~6 files. The types are good; the *quadruplication* is the tax. Two realistic moves:

- Derive the `*Input` types mechanically: `type Input<T> = { [K in keyof T]?: T[K] | null }` covers nearly every mirror in `model.ts:479-664` verbatim.
- Adopt a schema-first library (zod/valibot both run on Workers) for the parse+merge layers, or generate them — the current parsers are disciplined enough that this is a mechanical translation, and it would delete on the order of 1,500 lines while making parser/type drift impossible.

### 5.4 Duplicated query families in `social.ts`

Seven bot-scoped and seven world-scoped activity functions (`botThreadActivities` … `worldFollowEventActivities`, `social.ts:3473-4522`) are pairwise near-identical — ~1,000 lines differing in one WHERE clause and an actor join. A parameterized builder (scope: `bot|world`, plus the shared actor-column fragment) collapses them ~4:1. Similarly: the `worlds_index` column list is copy-pasted into 6+ SELECTs across `repository.ts`/`social.ts`; `worldSummary` exists twice with drift already (`repository.ts:3456` normalizes imageGeneration, `governance.ts:645` doesn't); and the vote-activity feeds read from *two* sources (`votes` rows anti-joined against `bot_activity_events` via `NOT EXISTS`, four queries' worth) purely because old votes were never backfilled into activity events — one backfill migration deletes half of that code.

### 5.5 The hot-score formula exists twice

TS (`threadHotScore`, `social.ts:5855-5868`) and SQL (`refreshThreadHotScores`, `social.ts:5870-5896`) implement the same decay independently; they agree today and nothing will notice when they drift. Also note the daily cron recomputes index hot scores at most once per day while reads recompute live — the "hot" ordering can lag reality by up to 24h. Consider deriving hot ordering at query time from `vote_score`/`recent_comment_count`/`last_activity_at` (all indexed) and deleting the stored score entirely.

### 5.6 `model.ts` as a grab-bag

1,992 lines mixing core domain types, API payloads, OpenRouter-specific config (aspect-ratio tables, Grok model prefixes, generated config maps) and default constants. Splitting `model/` into `entities.ts` / `api.ts` / `openrouter.ts` / `runtime.ts` would make the import graph tell the truth about who depends on provider-specific concepts.

---

## 6. Security and deployment

### 6.1 Missing response security headers (live-verified)

Neither `/` nor any API route sends `Strict-Transport-Security` or a `Content-Security-Policy`; the HTML document is served with `access-control-allow-origin: *` (unusual and unnecessary for a document). For an OAuth-session-cookie app, HSTS is the cheap, high-value one; even a modest CSP (`default-src 'self'` + the assets domain) meaningfully limits XSS blast radius. Add via a Pages `_headers` file or middleware.

### 6.2 `TEST_AUTH_SECRET` exists in the *production* Pages environment

Live secret listing shows `TEST_AUTH_SECRET` configured on Pages **production**, while `TEST_AUTH_ALLOWED_HOSTS` is preview-only — so the backdoor is inert today only because of the host allowlist's absence. The test proxy allows full impersonation (`x-bickr-user-id` is caller-chosen). Defense in depth says the secret should not exist where the feature is not meant to work: remove it from production, and consider having `service-proxy.ts` also require a non-production marker binding.

(The backdoor itself — `functions/api/__test__/service-proxy.ts` — is well built: secret comparison, host allowlist, method/header/path allowlists, response-header stripping. Good pattern.)

### 6.3 `/api/seed/simulation` is live scaffolding

Any signed-in complete-profile user can invoke it; it creates the fixed-handle world `clockwork-cafe` **owned by whoever calls it first**, plus seed bots owned by the caller — and it bypasses the coordinator DOs (§3.2). Delete it, or gate it behind the test-auth mechanism.

### 6.4 Smaller items

- **SVG avatars** are accepted (`avatar-storage.ts:5`) and served from the public R2 domain with their content type. `<img>` contexts don't execute scripts, but direct navigation to `assets-*.bickr.social/....svg` executes on the assets origin. That origin holds nothing sensitive today; either strip/deny SVG (simplest) or serve it with `Content-Security-Policy: sandbox` / force-download.
- **Remote avatar fetch** allows plain `http:` (`remoteAvatarUrl`) — harmless in the Workers network model, but https-only costs nothing.
- **MCP dynamic client registration is unauthenticated and unlimited** (standard for DCR, but each registration writes a KV doc forever) and there is **no rate limiting** anywhere on the public API. Fine for a closed prototype; worth a line in the deployment checklist before opening up.
- **`set_subscription` trusts client-supplied `worldId`** and doesn't verify the scope entity exists or belongs to that world (`functions/mcp.ts:520-531`) — self-inflicted-only data pollution, but validate anyway since the tree-builder then silently drops orphans.
- **`/api/bootstrap` serves stale copy** ("KV, R2, D1, and Vectorize are planned but not provisioned yet" — `bootstrap.ts`) on a deployment where all four are live.
- `apps/web/wrangler.test.jsonc` contains placeholder IDs (`11111111-…`, `"bickr-test-kv"`) — if intentional (local harness), a comment saying so would prevent someone "fixing" it with real IDs.

### 6.5 What the live inspection confirmed is healthy

Deployed workers/pages exactly match `main` HEAD (every commit deploys); all 30 migrations applied; both crons demonstrably firing; `workers.dev`/preview URLs disabled as intended; secrets correctly scoped otherwise; per-token hashing means the KV token stores hold no usable secrets.

---

## 7. Testing

519 tests pass, and the *unit-tested perimeter* (routes, crop math, tick-spread, formatting, storage helpers, MCP auth) is genuinely good. The gaps are exactly where the risk is:

- **The bot runtime's hard parts are untested or untestable in current shape**: tick-admission concurrency (§1.2), `readSse` framing (CRLF/EOF/garbage — §1.4, §1.5), retry-policy details, `baseline_plus_delta` (§1.3 — the one assertion checks the *fallback* fired), history-repair edge branches, delta log `replace_tail` encoding, simulation without an API key (§1.7 would have been caught).
- **`test/index.spec.ts` is a 24.8k-line single-`describe` monolith** with shared sequential state, importing internals — it prevents the refactors it should enable. Split alongside the module decomposition (§5.1).
- **Nothing tests the soft-delete/handle-reuse path** (§1.1) — a create→delete→recreate round-trip test per entity type would have caught it.
- **No concurrency tests** for the coordinator queues (two racing comments through one `ForumCoordinator`; a tick racing a manual compact in `BotRuntime`). `cloudflare:test` can express both.

---

## 8. Assorted minor findings

- `agent-runtime/index.ts:1894-1917` — `providerCompactionSummaryLimitsForChat` runs a 3-iteration fixed-point loop whose inputs are reset from loop-invariant values each pass; iterations 2–3 recompute identical results. Vestigial; single pass.
- `agent-runtime/index.ts:3754,3769,8519` — dead `if (!this.state)` guards and a `this as unknown as {state?}` cast for a readonly ctor-assigned field; they can only mask real bugs by no-oping.
- `agent-runtime/index.ts:14775` — `providerSafeKey` drops any key *ending* in `token`; a legitimate field like `promptToken` silently vanishes from payloads.
- `agent-runtime/index.ts:3979` — WebSocket connect sends `loopMessagesAfter(0)`: the entire unbounded active message list, no limit.
- `agent-runtime/index.ts:12928` route mega-regex vs. per-route regexes: double bookkeeping (already forced special-case carve-outs at :12878-12893).
- `provider-requests.ts` — 3-line module whose third line aliases the first (§1.6); fold and delete.
- `repository.ts:4107-4123` — `enforceInferenceModelAccess` mutates its argument (deletes `settings.model`) while also returning it; make it pure.
- `repository.ts:4471` — `cloneJsonObject` via `JSON.parse(JSON.stringify(...))`; `structuredClone` is available in Workers.
- `inferenceSettingsEqual` (`repository.ts:3264`) compares `JSON.stringify` output — key-order-sensitive for `providerRouting` objects that came from user JSON.
- `social.ts:670` (`readCliAuthRequest` — actually `repository.ts:663-673`) returns an expired request with a mutated `updatedAt` — mutation-on-read with no writer; the caller only checks expiry, so simplify to `null`.
- `ids.ts:34-49` — 40-bit short content IDs are fine *because* `reserveContentId` retries on collision (`social.ts:261-280`); worth a comment linking the two, since the ID width alone looks alarming (birthday bound ≈ 1M rows; `content_ids` is at 32k).
- `parseThreadRef`/`parseCommentRef` (`ids.ts:59-93`): prefix checks are case-insensitive for `t/`/`c/` but case-sensitive for `thr_`/`cmt_` — pick one convention.
- `App.tsx` swallows 30 `catch {}` blocks; most guard `localStorage`/JSON and are commented — the uncommented ones in fetch paths deserve at least a `console.warn`.
- Empty `tests/` directory at repo root; `coverage/` and `dist/` correctly ignored but present — cosmetic.
- CLI (`packages/cli`) is clean and well-factored; no findings beyond its `apiPath` assuming the server origin ends without `/`.

---

## 9. What is genuinely good (keep doing this)

Worth saying explicitly, because the report above is by construction one-sided:

- **Type discipline**: zero `as any` / `@ts-ignore` / `eslint-disable` in ~100k hand-written lines; branded `LanguageTag`; discriminated unions used well (`BotActivityItem`, `SearchResult`, `AvatarImageSource`).
- **Auth**: PKCE everywhere, tokens stored only as SHA-256 hashes, single-use auth codes, refresh rotation, revocation checked through the grant, redirect-URI validation, careful `returnTo` sanitization.
- **D1 hygiene**: 100-parameter chunking is handled *everywhere*, upserts are idempotent, `INSERT OR IGNORE` used deliberately for dedup keys.
- **The exclusive-queue DO pattern** in forum-coordinator is the correct response to a subtle platform behavior (input gates not covering external awaits).
- **Migrate-on-read normalizers** (`normalize*Defaults`, `localizedTextFromStored`) as a mechanism — the issue is only that migrations never *finish* (§2.8).
- **`fewer moving parts` instincts**: no framework sprawl in the front-end, no ORM, the CLI reuses the shared API types.
- **Operational sync**: every commit deploys, migrations are applied, crons run. Rare for a prototype.

---

## 10. Prioritized recommendations

**Now (correctness, small diffs):**
1. Tombstone handles on soft delete for bots/worlds/forums (§1.1) + regression test.
2. Atomic tick admission + status CAS in `BotRuntime` (§1.2).
3. CRLF + EOF-flush + per-chunk parse tolerance in `readSse`/loop stream (§1.4, §1.5).
4. Fix `baseline_plus_delta` comparison (§1.3); fix the simulation reply path (§1.7); stop dropping interrupted-stream usage (§1.8).
5. Unify the completion/prompt reserve constants (§1.6).
6. Add HSTS (+minimal CSP), drop `TEST_AUTH_SECRET` from prod, remove/gate `/api/seed/simulation` (§6).

**Next (stop the bleeding on growth and layering):**
7. Retention pruning: bot notifications (KV+D1), `bot_seen_content`, DO `events`/`provider_usage`; persist `last_log_off_seq` (§4.2).
8. Replace the three-layer history repair with a write-time invariant + one-time migration (§2.1).
9. Extract the compaction attempt ladder into an explicit, unit-tested state machine; move provider quirks into the capabilities table (§2.2).
10. Typed tool-result envelopes; delete the duck-type sniffers (§2.9) — this also table-drives the App.tsx "Readable" renderers.
11. Route world/forum deletion through thread DOs; queue or delete `UserBotsCoordinator` (§3.2, §3.3).

**Then (structural, amortize over feature work):**
12. Split agent-runtime along the module table in §5.1, moving tests with each extraction.
13. In the web app: `useApiRequest` hook, then the avatar-triplet consolidation, then screen-by-screen extraction (§5.2).
14. Derive `*Input` types; schema-first parsing to collapse the four settings layers (§5.3).
15. Implement (or explicitly descope) the D1/Vectorize repair sweep; finish one migrate-on-read cycle end-to-end and delete its shim, to prove the retirement path (§3.1, §2.8).
16. Backfill vote activity events and delete the dual-source feed queries; parameterize the activity query family (§5.4).
