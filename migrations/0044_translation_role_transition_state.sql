-- This durable bit distinguishes an owner that still needs the one-time
-- Translation-role sweep from a post-sweep owner whose fixed-role/pointer
-- invariant must fail closed. Version zero is a bounded release-transition
-- state; version one is canonical. Retire the version-zero interpretation once
-- every cutover-1 owner is version one and every cutover-2 rollback window from
-- before that convergence has expired. The column can then remain as inert
-- schema history while the compatibility branch is removed from application
-- code.
ALTER TABLE inference_graph_users
	ADD COLUMN translation_role_state_version INTEGER NOT NULL DEFAULT 1
	CHECK (translation_role_state_version IN (0, 1));

-- Rows present when this migration is applied predate the fixed Translation
-- role sweep. Later rows are canonical by construction and retain DEFAULT 1.
UPDATE inference_graph_users
SET translation_role_state_version = 0;
