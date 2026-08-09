-- This durable bit distinguishes an owner that still needs the one-time
-- Translation-role sweep from a post-sweep owner whose fixed-role/pointer
-- invariant must fail closed. Version zero is a bounded release-transition
-- state; version one is canonical. Retire the version-zero interpretation once
-- every cutover-1 owner is version one and every cutover-2 rollback window from
-- before that convergence has expired. The column can then remain as inert
-- schema history while the compatibility branch is removed from application
-- code.
ALTER TABLE inference_graph_users
	ADD COLUMN translation_role_state_version INTEGER NOT NULL DEFAULT 0
	CHECK (translation_role_state_version IN (0, 1));
