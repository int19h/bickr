# October 2026 audit remediation

This work repairs the defects and design problems in the October 2 audit.
The starting commit is `45537d2ceb896ebda7147eb0fee4e90b47a7e0ee`.
The audit report records the evidence and the earlier deployment snapshots.

The primary agent integrates changes on `codex/audit-remediation`.
Each implementation group uses a separate worktree and branch.
The primary agent assigns independent review after each group supplies commits and test results.
All reviewers inspect the same final commit before release.

## Scope and acceptance

Every defect needs a regression test that exercises its failure condition.
Performance tests count work when possible, rather than depend on elapsed time.
Storage changes need tests for failures between durable writes and external effects.
New stores need explicit retention rules, bounded queries, and a migration plan.

The work also addresses these design problems:

- Define one authority for each mutation and repair operation.
- Separate durable mutation intent from resumable index and notification work.
- Share account-state rules across authenticated interfaces.
- Centralize provider request limits, deadlines, redirects, and credential handling.
- Bind browser drafts and requests to a stable resource identity.
- Bound caches, search work, maintenance work, and avatar cleanup.
- Remove obsolete successful writes after inference configuration cutover.
- Extract modules around storage ownership and stable interfaces.
- Attach tests and build results to commits through repository automation.
- Record release identity, migration state, deployed components, and health results.

## Implementation groups

| Group | Agent | Branch | Assigned defects |
| --- | --- | --- | --- |
| Authentication | auth_security | codex/audit-fix-auth | A1–A3, issues 245–247 |
| Storage and forums | storage_forum | codex/audit-fix-storage | S1–S3, issues 248–250 |
| Runtime | runtime_audit | codex/audit-fix-runtime | R1–R7, issues 251–257 |
| External requests | external_data | codex/audit-fix-external | E1–E4, issues 258–261 |
| Browser and CLI | frontend_cli | codex/audit-fix-ui | F1–F7 and D1–D2, issues 263–271 |
| Release and dependencies | deployment_audit | codex/audit-fix-infra | Release, health, dependency, and internal-service hardening |
| Integration and inference | Primary agent | codex/audit-remediation | E5, issue 262, linked clones, and obsolete inference writes |

The authentication group owns the authentication region of `repository.ts` and the MCP authentication boundary.
The storage group owns social mutations, coordinator persistence, repair routing, notification delivery, and search maintenance.
The primary agent owns inference graph resolution and the linked-clone region of `repository.ts`.
Agents coordinate changes to shared export files before integration.

The runtime and external-request groups agree on a shared transport interface before either group changes its consumers.
The release group alone owns dependency versions and the lockfile.
The browser group coordinates font dependency changes with the release group.

Migration prefix `0059` belongs to authentication.
Prefix `0060` belongs to storage for deletion recovery.
Prefix `0061` belongs to the release group for indexed search and score maintenance.
Prefix `0062` belongs to storage for thread projection recovery and receipts.
Prefix `0063` belongs to external requests for resumable avatar cleanup.
Prefix `0064` belongs to the browser group for human notification delivery and retention.
Prefix `0065` belongs to storage for participant notification delivery.
Prefix `0066` belongs to storage for durable forum creation.
Other migrations require a new allocation in this document before creation.
Applied migration files remain unchanged.

## Additional tracked repairs

| Problem | Responsible group | Completion evidence |
| --- | --- | --- |
| OAuth consent, registration, callbacks, and credential retention | Authentication | Tests and references to issues 134–136 |
| Linked clone after source deletion | Primary agent | Regression coverage for issue 192 |
| Legacy inference writes after cutover | Primary agent | Explicit rejection or canonical translation for issue 218 |
| Notification publication and expired backlog progress | Storage | Bounded durable delivery and cleanup tests |
| Daily score updates across historical threads | Storage | Bounded incremental work and query evidence |
| Substring search across every retained row | Storage | Indexed matching with preserved semantics |
| Repeated full translation cache serialization | Browser | Bounded persistence and one in-memory index |
| Full prompt reads for submission summaries | Runtime | Summary projection without unused message bodies |
| Test-only runtime branches | Runtime | Explicit dependencies used by production and tests |
| World avatar queries and repeated model catalogs | External requests | Bounded projections and catalog reuse |
| Avatar cleanup limits | External requests | Resumable bounded cleanup with deletion safeguards |
| Existing readable CLI credential files | Browser and CLI | Atomic private replacement tests |
| Provider redirects and insecure endpoints | External requests | Explicit transport policy and credential tests |
| Missing internal service secret | Release | Fail-closed authorization and test configuration |
| Math worker network isolation | Browser | Worker response policy and bundle compatibility |
| Dependency advisories | Release | Current advisory inventory and reachable-code assessment |
| Legacy asset TLS policy | Release | Exact configuration change prepared for production authorization |

## Review and release

Implementers run focused tests with at most two test workers on the shared VM.
The primary agent runs the complete suite and build on the integrated candidate.
Independent reviewers inspect authorization, storage recovery, runtime progress, browser behavior, and release configuration.
A changed commit invalidates the previous approval.

After review and required tests pass, the primary agent prepares the pull request and test release.
The test release needs matching service bindings, applied migrations, healthy APIs, and the expected custom-domain bundle.
Production changes need a separate user instruction that names production.
The current task does not authorize production deployment, live cleanup, or a production TLS change.

The Herdr identity probe returned `unverifiable` for this host.
No agent assumes another session identity.
Built-in agent messages and this repository record preserve coordination until native identity is available.

## Progress

Implementation started from the clean base commit.
All seven groups are active.
Each group will record its commits, tests, remaining work, and review result here before delivery.
