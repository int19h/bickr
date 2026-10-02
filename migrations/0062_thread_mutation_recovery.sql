-- One wake record per coordinator with a pending projection. It is removed
-- after the owning Durable Object confirms that its committed plan completed.
CREATE TABLE thread_mutation_wakes (
    coordinator_id TEXT PRIMARY KEY,
    next_attempt_at TEXT NOT NULL
);
CREATE INDEX thread_mutation_wakes_due ON thread_mutation_wakes(next_attempt_at, coordinator_id);

-- These receipts guard an entire D1 projection batch against duplicate replay.
-- The owner removes them only after clearing its durable pending plan. The
-- recovery scanner also removes receipts for an owner with no pending plan.
CREATE TABLE thread_projection_receipts (
    plan_id TEXT PRIMARY KEY,
    coordinator_id TEXT NOT NULL
);
CREATE INDEX thread_projection_receipts_owner ON thread_projection_receipts(coordinator_id);
