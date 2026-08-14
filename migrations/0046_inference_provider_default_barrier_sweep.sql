-- Version-1 provenance correction state is retained for 30 days after an
-- owner reaches terminal. Pending rows are retained until processed. The
-- owner-coordinator runner corrects the fields this migration proved were
-- manufactured, in bounded stages; this is audit state, not an event store.
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
	-- Fields left holding Provider default because no canonical write could be
	-- ruled out, so the stored value cannot be attributed to migration or to the
	-- owner. These are preserved, never rewritten.
	ambiguous_field_count INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous_field_count >= 0),
	-- Counted in configurations, not fields: migrated configurations whose legacy
	-- provenance source is gone, so no per-field verdict could be reached at all.
	-- A source loss with no candidate field still costs the owner one
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

-- One row per barrier field a migrated configuration still holds at Provider
-- default. Eligibility is decided here, once, and is never re-derived later from
-- the stored value: a Provider default byte-identical to migration output is not
-- evidence of who wrote it, because an owner who selects Provider default in the
-- canonical editor stores exactly the same union.
--
-- migration_revision is the revision migration v1 left the configuration at: 1,
-- or 2 for a linked participant, whose configuration is reparented after
-- insertion. seeded_revision is the revision observed here. They are equal
-- exactly when no canonical owner write has touched the record since migration,
-- which is the only durable evidence that the stored Provider default is
-- migration output. A canonical write advances one revision for the whole
-- record and leaves no per-field trace, so a later revision cannot tell an
-- untouched barrier from an owner who selected Provider default: the field is
-- ambiguous. An unrelated edit therefore conservatively costs an untouched
-- barrier its eligibility rather than risk overwriting an owner's own choice.
CREATE TABLE inference_provider_default_barrier_candidates (
	owner_user_id TEXT NOT NULL,
	configuration_id TEXT NOT NULL,
	field TEXT NOT NULL CHECK (field IN ('reasoning', 'toolCalls', 'compactionMode', 'promptCacheMode')),
	migration_revision INTEGER NOT NULL CHECK (migration_revision IN (1, 2)),
	seeded_revision INTEGER NOT NULL CHECK (seeded_revision >= 1),
	status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'skipped', 'ambiguous')),
	created_at TEXT NOT NULL,
	completed_at TEXT,
	PRIMARY KEY (owner_user_id, configuration_id, field),
	FOREIGN KEY (configuration_id, owner_user_id)
		REFERENCES inference_configurations(configuration_id, owner_user_id) ON DELETE CASCADE,
	CHECK ((status = 'pending') = (completed_at IS NULL)),
	-- Correctness by construction: a field seeded off its migration revision can
	-- only ever be ambiguous. Nothing outside the migration-owned revision is
	-- correctable, at seed time or afterwards.
	CHECK (seeded_revision = migration_revision OR status = 'ambiguous')
);

CREATE INDEX inference_provider_default_barrier_candidates_pending
	ON inference_provider_default_barrier_candidates (owner_user_id, status, configuration_id, field);

-- Seed per-field eligibility for the configurations migration v1 manufactured
-- under the former writer: the Account default, every participant, and the
-- generated legacy-Translation parent this operation recorded. World
-- configurations never carried these fields. Fixed-role rows are excluded
-- because migration v1 did not write them.
--
-- This runs before the sweep rows below, which count the ambiguous fields it
-- seeds. The migration's own terminal timestamp is the seed time: it is the
-- moment the state being audited was created, and it keeps this migration
-- deterministic.
WITH migrated AS (
	SELECT operation.owner_user_id AS owner_user_id,
		operation.terminal_at AS terminal_at,
		configuration.configuration_id AS configuration_id,
		configuration.overrides_json AS overrides_json,
		configuration.revision AS revision,
		CASE WHEN clones.linked = 1 THEN 2 ELSE 1 END AS migration_revision
	FROM inference_graph_migration_operations AS operation
	JOIN inference_configurations AS configuration
		ON configuration.owner_user_id = operation.owner_user_id
	LEFT JOIN bot_clone_sources AS clones ON clones.bot_id = configuration.bot_id
	WHERE operation.migration_version = 1 AND operation.phase = 'terminal'
		AND configuration.fixed_role IS NULL
		AND (
			configuration.kind IN ('account_default', 'bot')
			OR configuration.configuration_id = operation.migrated_translation_configuration_id
		)
),
barrier_field (field) AS (
	VALUES ('reasoning'), ('toolCalls'), ('compactionMode'), ('promptCacheMode')
)
INSERT INTO inference_provider_default_barrier_candidates (
	owner_user_id, configuration_id, field, migration_revision, seeded_revision,
	status, created_at, completed_at
)
SELECT migrated.owner_user_id, migrated.configuration_id, barrier_field.field,
	migrated.migration_revision, migrated.revision,
	CASE WHEN migrated.revision = migrated.migration_revision THEN 'pending' ELSE 'ambiguous' END,
	migrated.terminal_at,
	CASE WHEN migrated.revision = migrated.migration_revision THEN NULL ELSE migrated.terminal_at END
FROM migrated, barrier_field
WHERE json_extract(migrated.overrides_json, '$.' || barrier_field.field || '.kind') = 'value'
	AND json_extract(migrated.overrides_json, '$.' || barrier_field.field || '.value.kind') = 'provider_default';

-- Only owners that completed migration v1 under the former writer need the
-- provenance-aware terminal sweep. Nonterminal operations remain closed to
-- canonical owner edits and are normalized in bounded batches by the migration
-- runner before it advances their existing phase.
INSERT INTO inference_provider_default_barrier_sweeps (
	owner_user_id, phase, stage, ambiguous_field_count, created_at, updated_at
)
SELECT operation.owner_user_id, 'pending', 'account',
	(SELECT COUNT(*) FROM inference_provider_default_barrier_candidates AS candidate
	 WHERE candidate.owner_user_id = operation.owner_user_id AND candidate.status = 'ambiguous'),
	operation.terminal_at, operation.terminal_at
FROM inference_graph_migration_operations AS operation
WHERE operation.migration_version = 1 AND operation.phase = 'terminal';
