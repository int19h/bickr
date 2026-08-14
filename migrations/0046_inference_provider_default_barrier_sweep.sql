-- Version-1 provenance correction state is retained for 30 days after an
-- owner reaches terminal. Pending rows are retained until processed. The
-- owner-coordinator runner compares canonical rows with retained legacy KV
-- documents in bounded stages; this is audit state, not an event store.
CREATE TABLE inference_provider_default_barrier_sweeps (
	owner_user_id TEXT PRIMARY KEY,
	sweep_version INTEGER NOT NULL DEFAULT 1 CHECK (sweep_version = 1),
	phase TEXT NOT NULL CHECK (phase IN ('pending', 'terminal')),
	stage TEXT NOT NULL CHECK (stage IN ('account', 'bots', 'translation', 'complete')),
	bot_cursor TEXT,
	-- Counted in candidate fields: one row of
	-- inference_provider_default_barrier_candidates each.
	applied_field_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_field_count >= 0),
	skipped_field_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_field_count >= 0),
	-- Counted in configurations, not fields: migrated configurations whose legacy
	-- provenance source is gone, so no per-field verdict could be reached at all.
	-- A source loss with no barrier fields still costs the owner one
	-- unrepresented configuration and zero skipped fields.
	unrepresented_configuration_count INTEGER NOT NULL DEFAULT 0 CHECK (unrepresented_configuration_count >= 0),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	terminal_cleanup_at TEXT,
	CHECK ((phase = 'terminal') = (stage = 'complete')),
	CHECK ((phase = 'terminal') = (terminal_cleanup_at IS NOT NULL)),
	FOREIGN KEY (owner_user_id) REFERENCES inference_graph_users(owner_user_id) ON DELETE RESTRICT
);

CREATE INDEX inference_provider_default_barrier_sweeps_phase
	ON inference_provider_default_barrier_sweeps (phase, updated_at, owner_user_id);

CREATE INDEX inference_provider_default_barrier_sweeps_cleanup
	ON inference_provider_default_barrier_sweeps (terminal_cleanup_at, owner_user_id)
	WHERE terminal_cleanup_at IS NOT NULL;

-- Fleet scheduling state, owned exclusively by the scheduled fleet driver so it
-- never writes the coordinator-owned sweep row. One row per owner the driver has
-- dispatched to; the driver always picks the least recently attempted pending
-- owners, so a deterministically failing owner is retried without starving the
-- owners behind it. Retention follows the sweep row: terminal cleanup deletes
-- the sweep and cascades these away.
CREATE TABLE inference_provider_default_barrier_fleet_attempts (
	owner_user_id TEXT PRIMARY KEY,
	attempted_at TEXT NOT NULL,
	FOREIGN KEY (owner_user_id)
		REFERENCES inference_provider_default_barrier_sweeps(owner_user_id) ON DELETE CASCADE
);

-- One row records each field whose old migration output differed from the
-- corrected output. The source revision is the migration-owned revision that
-- made the provenance proof possible (linked clones are revision 2 because
-- migration v1 reparents them after insertion).
CREATE TABLE inference_provider_default_barrier_candidates (
	owner_user_id TEXT NOT NULL,
	configuration_id TEXT NOT NULL,
	field TEXT NOT NULL CHECK (field IN ('reasoning', 'toolCalls', 'compactionMode', 'promptCacheMode')),
	source_revision INTEGER NOT NULL CHECK (source_revision IN (1, 2)),
	status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'skipped')),
	created_at TEXT NOT NULL,
	completed_at TEXT,
	PRIMARY KEY (owner_user_id, configuration_id, field),
	FOREIGN KEY (configuration_id, owner_user_id)
		REFERENCES inference_configurations(configuration_id, owner_user_id) ON DELETE CASCADE,
	CHECK ((status = 'pending') = (completed_at IS NULL))
);

CREATE INDEX inference_provider_default_barrier_candidates_pending
	ON inference_provider_default_barrier_candidates (owner_user_id, status, configuration_id, field);

-- Only owners that completed migration v1 under the former writer need the
-- provenance-aware terminal sweep. Nonterminal operations remain closed to
-- canonical owner edits and are normalized in bounded batches by the migration
-- runner before it advances their existing phase.
INSERT INTO inference_provider_default_barrier_sweeps (
	owner_user_id, phase, stage, created_at, updated_at
)
SELECT owner_user_id, 'pending', 'account', terminal_at, terminal_at
FROM inference_graph_migration_operations
WHERE migration_version = 1 AND phase = 'terminal';
