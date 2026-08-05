-- Inference configurations and their credential rows live for the active
-- configuration lifetime. World, bot, and custom rows are hard-deleted after
-- their immediate children are reparented; Account default is removed only as
-- the final graph row during account deletion. No history is retained here.
CREATE UNIQUE INDEX worlds_index_id_owner
	ON worlds_index (world_id, created_by_user_id);

CREATE UNIQUE INDEX bots_index_id_owner
	ON bots_index (bot_id, owner_user_id);

CREATE TABLE inference_configurations (
	configuration_id TEXT PRIMARY KEY,
	owner_user_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('account_default', 'world', 'bot', 'custom')),
	parent_id TEXT,
	world_id TEXT,
	bot_id TEXT,
	custom_name TEXT,
	custom_name_key TEXT,
	overrides_json TEXT NOT NULL DEFAULT '{}'
		CHECK (json_valid(overrides_json) AND json_type(overrides_json) = 'object'),
	revision INTEGER NOT NULL CHECK (revision > 0),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (configuration_id, owner_user_id),
	UNIQUE (configuration_id, owner_user_id, kind),
	FOREIGN KEY (owner_user_id) REFERENCES users_index(user_id) ON DELETE RESTRICT,
	FOREIGN KEY (parent_id, owner_user_id)
		REFERENCES inference_configurations(configuration_id, owner_user_id)
		ON DELETE RESTRICT,
	FOREIGN KEY (world_id, owner_user_id)
		REFERENCES worlds_index(world_id, created_by_user_id)
		ON DELETE RESTRICT,
	FOREIGN KEY (bot_id, owner_user_id)
		REFERENCES bots_index(bot_id, owner_user_id)
		ON DELETE RESTRICT,
	CHECK (parent_id IS NULL OR parent_id != configuration_id),
	CHECK (
		(kind = 'account_default' AND parent_id IS NULL
			AND world_id IS NULL AND bot_id IS NULL
			AND custom_name IS NULL AND custom_name_key IS NULL) OR
		(kind = 'world' AND parent_id IS NOT NULL
			AND world_id IS NOT NULL AND bot_id IS NULL
			AND custom_name IS NULL AND custom_name_key IS NULL) OR
		(kind = 'bot' AND parent_id IS NOT NULL
			AND world_id IS NULL AND bot_id IS NOT NULL
			AND custom_name IS NULL AND custom_name_key IS NULL) OR
		(kind = 'custom' AND parent_id IS NOT NULL
			AND world_id IS NULL AND bot_id IS NULL
			AND custom_name IS NOT NULL AND length(trim(custom_name)) > 0
			AND custom_name_key IS NOT NULL AND length(custom_name_key) > 0)
	)
);

CREATE UNIQUE INDEX inference_configurations_account_default
	ON inference_configurations (owner_user_id)
	WHERE kind = 'account_default';

CREATE UNIQUE INDEX inference_configurations_world
	ON inference_configurations (world_id)
	WHERE kind = 'world';

CREATE UNIQUE INDEX inference_configurations_bot
	ON inference_configurations (bot_id)
	WHERE kind = 'bot';

CREATE UNIQUE INDEX inference_configurations_custom_name
	ON inference_configurations (owner_user_id, custom_name_key)
	WHERE kind = 'custom';

CREATE INDEX inference_configurations_owner_kind_name
	ON inference_configurations (owner_user_id, kind, custom_name_key, configuration_id);

CREATE INDEX inference_configurations_owner_parent
	ON inference_configurations (owner_user_id, parent_id, configuration_id);

CREATE INDEX inference_configurations_owner_updated
	ON inference_configurations (owner_user_id, updated_at, configuration_id);

-- The 10,000-row owner quota bounds recursive path and owner-snapshot work.
-- The serialized writer performs the typed preflight; this trigger is the
-- declarative backstop against migration/admin side doors.
CREATE TRIGGER inference_configurations_owner_quota
BEFORE INSERT ON inference_configurations
WHEN (SELECT COUNT(*) FROM inference_configurations WHERE owner_user_id = NEW.owner_user_id) >= 10000
BEGIN
	SELECT RAISE(ABORT, 'inference configuration owner quota exceeded');
END;

-- Credential intent and plaintext are deliberately absent from the ordinary
-- configuration row. This table lives for exactly the configuration lifetime
-- and must be deleted first in the graph deletion transaction. Public queries
-- select only mode/version; only the internal loader selects secret_value.
CREATE TABLE inference_configuration_credentials (
	configuration_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	mode TEXT NOT NULL CHECK (mode IN ('inherit', 'account_default', 'value', 'none')),
	secret_value TEXT,
	secret_version INTEGER NOT NULL DEFAULT 0 CHECK (secret_version >= 0),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (configuration_id),
	FOREIGN KEY (configuration_id, owner_user_id)
		REFERENCES inference_configurations(configuration_id, owner_user_id)
		ON DELETE RESTRICT,
	CHECK (
		(mode = 'value' AND secret_value IS NOT NULL AND length(secret_value) > 0 AND secret_version > 0) OR
		(mode IN ('inherit', 'account_default', 'none') AND secret_value IS NULL AND secret_version = 0)
	)
);

CREATE INDEX inference_configuration_credentials_owner
	ON inference_configuration_credentials (owner_user_id, configuration_id);

-- Non-root entries may deliberately skip intervening parents and resume
-- credential resolution at Account default. Account default itself can never
-- store that mode, which would otherwise be recursive/ambiguous.
CREATE TRIGGER inference_configuration_account_default_credential_insert
BEFORE INSERT ON inference_configuration_credentials
WHEN NEW.mode = 'account_default' AND EXISTS (
	SELECT 1 FROM inference_configurations
	WHERE configuration_id = NEW.configuration_id
		AND owner_user_id = NEW.owner_user_id AND kind = 'account_default'
)
BEGIN
	SELECT RAISE(ABORT, 'account default cannot use account-default credential mode');
END;

CREATE TRIGGER inference_configuration_account_default_credential_update
BEFORE UPDATE OF mode ON inference_configuration_credentials
WHEN NEW.mode = 'account_default' AND EXISTS (
	SELECT 1 FROM inference_configurations
	WHERE configuration_id = NEW.configuration_id
		AND owner_user_id = NEW.owner_user_id AND kind = 'account_default'
)
BEGIN
	SELECT RAISE(ABORT, 'account default cannot use account-default credential mode');
END;

-- The base URL has the same Account-default resume state, stored in the
-- overrides document rather than the credential row. Account default cannot
-- hold it for the same reason, so it gets the same declarative backstop.
CREATE TRIGGER inference_configurations_account_default_base_url_insert
BEFORE INSERT ON inference_configurations
WHEN NEW.kind = 'account_default'
	AND json_extract(NEW.overrides_json, '$.baseUrl.kind') = 'account_default'
BEGIN
	SELECT RAISE(ABORT, 'account default cannot use account-default base url state');
END;

CREATE TRIGGER inference_configurations_account_default_base_url_update
BEFORE UPDATE OF overrides_json, kind ON inference_configurations
WHEN NEW.kind = 'account_default'
	AND json_extract(NEW.overrides_json, '$.baseUrl.kind') = 'account_default'
BEGIN
	SELECT RAISE(ABORT, 'account default cannot use account-default base url state');
END;

-- A fixed bot insert atomically transfers the Phase-1 nonterminal key bridge
-- into its permanent configuration row. The lifecycle batch deletes the
-- bridge only after this trigger has copied it, so a crash cannot lose the key.
-- Other entry kinds begin with explicit inherited credential intent.
CREATE TRIGGER inference_configuration_credential_after_insert
AFTER INSERT ON inference_configurations
BEGIN
	INSERT INTO inference_configuration_credentials (
		configuration_id, owner_user_id, mode, secret_value, secret_version,
		created_at, updated_at
	)
	SELECT
		NEW.configuration_id,
		NEW.owner_user_id,
		CASE WHEN lifecycle_secret.secret_value IS NULL THEN 'inherit' ELSE 'value' END,
		lifecycle_secret.secret_value,
		CASE WHEN lifecycle_secret.secret_value IS NULL THEN 0 ELSE 1 END,
		NEW.created_at,
		NEW.updated_at
	FROM (SELECT 1) AS seed
	LEFT JOIN (
		SELECT secrets.secret_value
		FROM entity_lifecycle_operations AS operations
		JOIN entity_lifecycle_secrets AS secrets
			ON secrets.operation_id = operations.operation_id
			AND secrets.secret_kind = 'bot_openrouter_api_key'
		WHERE NEW.kind = 'bot'
			AND operations.entity_kind = 'bot'
			AND operations.entity_id = NEW.bot_id
			AND operations.owner_user_id = NEW.owner_user_id
			AND operations.action = 'create'
			AND operations.phase IN ('pending', 'materializing')
		ORDER BY operations.created_at DESC, operations.operation_id DESC
		LIMIT 1
	) AS lifecycle_secret;
END;

-- The translation selector lives with the graph. The selected_kind column and
-- composite FK make world/bot selections unrepresentable, and same-owner is
-- enforced without an application-only shape check. It lives for the account
-- lifetime and is hard-deleted during account cleanup.
CREATE TABLE inference_translation_selections (
	owner_user_id TEXT PRIMARY KEY,
	configuration_id TEXT NOT NULL,
	selected_kind TEXT NOT NULL CHECK (selected_kind IN ('account_default', 'custom')),
	revision INTEGER NOT NULL CHECK (revision > 0),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (owner_user_id) REFERENCES users_index(user_id) ON DELETE RESTRICT,
	FOREIGN KEY (configuration_id, owner_user_id, selected_kind)
		REFERENCES inference_configurations(configuration_id, owner_user_id, kind)
		ON DELETE RESTRICT
);

CREATE INDEX inference_translation_selections_configuration
	ON inference_translation_selections (configuration_id, owner_user_id);

-- This permanent, one-row-per-owner control selects legacy versus graph reads.
-- Row presence is never the signal: cutover_version remains zero until parity
-- and invariant gates pass, then changes in the final migration transaction.
CREATE TABLE inference_graph_users (
	owner_user_id TEXT PRIMARY KEY,
	schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
	writer_version INTEGER NOT NULL DEFAULT 0 CHECK (writer_version IN (0, 1)),
	-- 0 reads legacy entity bundles, 1 reads the canonical graph, and 2 reads
	-- the revision-matched compatibility projection during bounded rollback.
	cutover_version INTEGER NOT NULL DEFAULT 0 CHECK (cutover_version IN (0, 1, 2)),
	graph_revision INTEGER NOT NULL DEFAULT 0 CHECK (graph_revision >= 0),
	legacy_projection_revision INTEGER NOT NULL DEFAULT 0 CHECK (legacy_projection_revision >= 0),
	compatibility_translation_configuration_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	verified_cutover_at TEXT,
	CHECK ((cutover_version = 0 AND verified_cutover_at IS NULL) OR
		(cutover_version IN (1, 2) AND writer_version = 1 AND verified_cutover_at IS NOT NULL)),
	FOREIGN KEY (owner_user_id) REFERENCES users_index(user_id) ON DELETE RESTRICT,
	FOREIGN KEY (compatibility_translation_configuration_id)
		REFERENCES inference_configurations(configuration_id) ON DELETE SET NULL
);

-- One versioned operation per owner is resumable until terminal. Terminal
-- migration/audit state is retained for 30 days after verified cutover and is
-- then removed through the indexed, bounded cleanup query in Phase 3 tooling.
CREATE TABLE inference_graph_migration_operations (
	owner_user_id TEXT NOT NULL,
	migration_version INTEGER NOT NULL CHECK (migration_version = 1),
	phase TEXT NOT NULL CHECK (phase IN (
		'pending', 'account_default', 'worlds', 'bots', 'translation',
		'parity', 'projection', 'cutover', 'terminal', 'terminal_failed'
	)),
	revision INTEGER NOT NULL CHECK (revision > 0),
	world_cursor TEXT,
	bot_cursor TEXT,
	parity_stage TEXT NOT NULL DEFAULT 'account'
		CHECK (parity_stage IN ('account', 'worlds', 'bots', 'translation', 'complete')),
	parity_cursor TEXT,
	parity_accumulator TEXT NOT NULL DEFAULT '',
	parity_world_count INTEGER NOT NULL DEFAULT 0 CHECK (parity_world_count >= 0),
	parity_bot_count INTEGER NOT NULL DEFAULT 0 CHECK (parity_bot_count >= 0),
	migrated_translation_configuration_id TEXT,
	audit_json TEXT NOT NULL DEFAULT '{}'
		CHECK (json_valid(audit_json) AND json_type(audit_json) = 'object'),
	parity_fingerprint TEXT,
	failure_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	terminal_at TEXT,
	terminal_cleanup_at TEXT,
	PRIMARY KEY (owner_user_id, migration_version),
	FOREIGN KEY (owner_user_id) REFERENCES inference_graph_users(owner_user_id) ON DELETE RESTRICT,
	CHECK (
		(phase IN ('terminal', 'terminal_failed') AND terminal_at IS NOT NULL AND terminal_cleanup_at IS NOT NULL) OR
		(phase NOT IN ('terminal', 'terminal_failed') AND terminal_at IS NULL AND terminal_cleanup_at IS NULL)
	)
);

CREATE INDEX inference_graph_migration_phase
	ON inference_graph_migration_operations (phase, updated_at, owner_user_id);

CREATE INDEX inference_graph_migration_cleanup
	ON inference_graph_migration_operations (terminal_cleanup_at, owner_user_id)
	WHERE terminal_cleanup_at IS NOT NULL;

-- The graph-aware legacy projection is non-authoritative and secret-free. It
-- exists only for the bounded rollback window, is revisioned with its source
-- graph, and is removed 30 days after verified cutover by indexed cleanup.
CREATE TABLE inference_graph_legacy_projections (
	owner_user_id TEXT PRIMARY KEY,
	graph_revision INTEGER NOT NULL CHECK (graph_revision >= 0),
	translation_configuration_id TEXT NOT NULL,
	translation_selection_revision INTEGER NOT NULL CHECK (translation_selection_revision > 0),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	cleanup_at TEXT NOT NULL,
	FOREIGN KEY (owner_user_id) REFERENCES inference_graph_users(owner_user_id) ON DELETE RESTRICT
);

-- Projection entries live only while their owner metadata row is inside the
-- 30-day rollback window. One row per configuration avoids an owner-sized JSON
-- blob and keeps compatibility path reads indexed and corruption-bounded.
CREATE TABLE inference_graph_legacy_projection_entries (
	owner_user_id TEXT NOT NULL,
	configuration_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('account_default', 'world', 'bot', 'custom')),
	parent_id TEXT,
	world_id TEXT,
	bot_id TEXT,
	custom_name TEXT,
	custom_name_key TEXT,
	overrides_json TEXT NOT NULL CHECK (json_valid(overrides_json) AND json_type(overrides_json) = 'object'),
	configuration_revision INTEGER NOT NULL CHECK (configuration_revision > 0),
	credential_mode TEXT NOT NULL CHECK (credential_mode IN ('inherit', 'account_default', 'value', 'none')),
	credential_secret_version INTEGER NOT NULL CHECK (credential_secret_version >= 0),
	PRIMARY KEY (owner_user_id, configuration_id),
	FOREIGN KEY (owner_user_id) REFERENCES inference_graph_legacy_projections(owner_user_id) ON DELETE CASCADE,
	FOREIGN KEY (parent_id, owner_user_id)
		REFERENCES inference_graph_legacy_projection_entries(configuration_id, owner_user_id)
		ON DELETE CASCADE,
	CHECK (parent_id IS NULL OR parent_id != configuration_id),
	CHECK (kind != 'account_default' OR credential_mode != 'account_default')
);

CREATE INDEX inference_graph_legacy_projection_parent
	ON inference_graph_legacy_projection_entries (owner_user_id, parent_id, configuration_id);

-- Projection rows mirror canonical raw graph state incrementally. They are
-- resolved/flattened only by the compatibility reader, so an ancestor change
-- never requires an owner-wide rewrite on the mutation hot path.
CREATE TRIGGER inference_graph_projection_after_credential_insert
AFTER INSERT ON inference_configuration_credentials
WHEN EXISTS (
	SELECT 1 FROM inference_graph_legacy_projections WHERE owner_user_id = NEW.owner_user_id
)
BEGIN
	INSERT INTO inference_graph_legacy_projection_entries (
		owner_user_id, configuration_id, kind, parent_id, world_id, bot_id,
		custom_name, custom_name_key, overrides_json, configuration_revision,
		credential_mode, credential_secret_version
	)
	SELECT configuration.owner_user_id, configuration.configuration_id,
		configuration.kind, configuration.parent_id, configuration.world_id,
		configuration.bot_id, configuration.custom_name, configuration.custom_name_key,
		configuration.overrides_json, configuration.revision, NEW.mode, NEW.secret_version
	FROM inference_configurations AS configuration
	WHERE configuration.configuration_id = NEW.configuration_id
		AND configuration.owner_user_id = NEW.owner_user_id;
END;

CREATE TRIGGER inference_graph_projection_after_configuration_update
AFTER UPDATE ON inference_configurations
BEGIN
	UPDATE inference_graph_legacy_projection_entries
	SET parent_id = NEW.parent_id, custom_name = NEW.custom_name,
		custom_name_key = NEW.custom_name_key, overrides_json = NEW.overrides_json,
		configuration_revision = NEW.revision
	WHERE owner_user_id = NEW.owner_user_id AND configuration_id = NEW.configuration_id;
END;

CREATE TRIGGER inference_graph_projection_after_configuration_delete
AFTER DELETE ON inference_configurations
BEGIN
	DELETE FROM inference_graph_legacy_projection_entries
	WHERE owner_user_id = OLD.owner_user_id AND configuration_id = OLD.configuration_id;
END;

CREATE TRIGGER inference_graph_projection_after_credential_update
AFTER UPDATE ON inference_configuration_credentials
BEGIN
	UPDATE inference_graph_legacy_projection_entries
	SET credential_mode = NEW.mode, credential_secret_version = NEW.secret_version
	WHERE owner_user_id = NEW.owner_user_id AND configuration_id = NEW.configuration_id;
END;

CREATE TRIGGER inference_graph_projection_after_translation_update
AFTER UPDATE ON inference_translation_selections
BEGIN
	UPDATE inference_graph_legacy_projections
	SET translation_configuration_id = NEW.configuration_id,
		translation_selection_revision = NEW.revision, updated_at = NEW.updated_at
	WHERE owner_user_id = NEW.owner_user_id;
END;

CREATE INDEX inference_graph_legacy_projection_cleanup
	ON inference_graph_legacy_projections (cleanup_at, owner_user_id);

-- A single owner convergence row records a D1/KV compatibility write that has
-- not yet reached the same revision on both stores. Nonterminal rows remain
-- until resumed; terminal rows retain no payload and expire after 30 days.
CREATE TABLE inference_graph_convergence (
	owner_user_id TEXT PRIMARY KEY,
	phase TEXT NOT NULL CHECK (phase IN ('pending_d1', 'pending_kv', 'terminal')),
	d1_revision INTEGER NOT NULL CHECK (d1_revision >= 0),
	kv_revision INTEGER NOT NULL CHECK (kv_revision >= 0),
	operation_json TEXT
		CHECK (operation_json IS NULL OR (json_valid(operation_json) AND json_type(operation_json) = 'object')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	terminal_cleanup_at TEXT,
	CHECK ((phase = 'terminal' AND operation_json IS NULL AND terminal_cleanup_at IS NOT NULL) OR
		(phase != 'terminal' AND operation_json IS NOT NULL AND terminal_cleanup_at IS NULL)),
	FOREIGN KEY (owner_user_id) REFERENCES inference_graph_users(owner_user_id) ON DELETE RESTRICT
);

CREATE INDEX inference_graph_convergence_phase
	ON inference_graph_convergence (phase, updated_at, owner_user_id);

CREATE INDEX inference_graph_convergence_cleanup
	ON inference_graph_convergence (terminal_cleanup_at, owner_user_id)
	WHERE terminal_cleanup_at IS NOT NULL;

-- New accounts created after graph-required lifecycle activation begin on the
-- graph writer/read version immediately. Maintenance inserts for existing
-- accounts have no nonterminal account-create operation and remain explicitly
-- pre-cutover. Row presence is therefore never the read-mode signal.
CREATE TRIGGER inference_graph_user_after_account_default
AFTER INSERT ON inference_configurations
WHEN NEW.kind = 'account_default'
BEGIN
	INSERT OR IGNORE INTO inference_graph_users (
		owner_user_id, writer_version, cutover_version, graph_revision,
		created_at, updated_at, verified_cutover_at
	) VALUES (
		NEW.owner_user_id,
		CASE WHEN EXISTS (
			SELECT 1 FROM entity_lifecycle_operations
			WHERE entity_kind = 'account' AND entity_id = NEW.owner_user_id
				AND owner_user_id = NEW.owner_user_id AND action = 'create'
				AND phase IN ('pending', 'materializing')
		) THEN 1 ELSE 0 END,
		CASE WHEN EXISTS (
			SELECT 1 FROM entity_lifecycle_operations
			WHERE entity_kind = 'account' AND entity_id = NEW.owner_user_id
				AND owner_user_id = NEW.owner_user_id AND action = 'create'
				AND phase IN ('pending', 'materializing')
		) THEN 1 ELSE 0 END,
		1,
		NEW.created_at,
		NEW.updated_at,
		CASE WHEN EXISTS (
			SELECT 1 FROM entity_lifecycle_operations
			WHERE entity_kind = 'account' AND entity_id = NEW.owner_user_id
				AND owner_user_id = NEW.owner_user_id AND action = 'create'
				AND phase IN ('pending', 'materializing')
		) THEN NEW.updated_at ELSE NULL END
	);
END;

-- Graph revisions are invalidation tokens, not event history. They advance at
-- every canonical write, including lifecycle and migration writes, so there is
-- no untracked writer that can leave cached annotations current by accident.
CREATE TRIGGER inference_graph_revision_after_configuration_insert
AFTER INSERT ON inference_configurations
WHEN NEW.kind != 'account_default'
BEGIN
	UPDATE inference_graph_users
	SET graph_revision = graph_revision + 1, updated_at = NEW.updated_at
	WHERE owner_user_id = NEW.owner_user_id;
	UPDATE inference_graph_legacy_projections
	SET graph_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = NEW.owner_user_id),
		updated_at = NEW.updated_at
	WHERE owner_user_id = NEW.owner_user_id;
	UPDATE inference_graph_convergence
	SET d1_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = NEW.owner_user_id),
		kv_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = NEW.owner_user_id),
		updated_at = NEW.updated_at
	WHERE owner_user_id = NEW.owner_user_id AND phase = 'terminal';
END;

CREATE TRIGGER inference_graph_revision_after_configuration_update
AFTER UPDATE ON inference_configurations
BEGIN
	UPDATE inference_graph_users
	SET graph_revision = graph_revision + 1, updated_at = NEW.updated_at
	WHERE owner_user_id = NEW.owner_user_id;
	UPDATE inference_graph_legacy_projections
	SET graph_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = NEW.owner_user_id),
		updated_at = NEW.updated_at
	WHERE owner_user_id = NEW.owner_user_id;
	UPDATE inference_graph_convergence
	SET d1_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = NEW.owner_user_id),
		kv_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = NEW.owner_user_id),
		updated_at = NEW.updated_at
	WHERE owner_user_id = NEW.owner_user_id AND phase = 'terminal';
END;

CREATE TRIGGER inference_graph_revision_after_configuration_delete
AFTER DELETE ON inference_configurations
WHEN OLD.kind != 'account_default'
BEGIN
	UPDATE inference_graph_users
	SET graph_revision = graph_revision + 1, updated_at = OLD.updated_at
	WHERE owner_user_id = OLD.owner_user_id;
	UPDATE inference_graph_legacy_projections
	SET graph_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = OLD.owner_user_id),
		updated_at = OLD.updated_at
	WHERE owner_user_id = OLD.owner_user_id;
	UPDATE inference_graph_convergence
	SET d1_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = OLD.owner_user_id),
		kv_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = OLD.owner_user_id),
		updated_at = OLD.updated_at
	WHERE owner_user_id = OLD.owner_user_id AND phase = 'terminal';
END;

CREATE TRIGGER inference_graph_revision_after_credential_update
AFTER UPDATE ON inference_configuration_credentials
BEGIN
	UPDATE inference_graph_users
	SET graph_revision = graph_revision + 1, updated_at = NEW.updated_at
	WHERE owner_user_id = NEW.owner_user_id;
	UPDATE inference_graph_legacy_projections
	SET graph_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = NEW.owner_user_id),
		updated_at = NEW.updated_at
	WHERE owner_user_id = NEW.owner_user_id;
	UPDATE inference_graph_convergence
	SET d1_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = NEW.owner_user_id),
		kv_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = NEW.owner_user_id),
		updated_at = NEW.updated_at
	WHERE owner_user_id = NEW.owner_user_id AND phase = 'terminal';
END;

CREATE TRIGGER inference_graph_revision_after_translation_update
AFTER UPDATE ON inference_translation_selections
BEGIN
	UPDATE inference_graph_users
	SET graph_revision = graph_revision + 1, updated_at = NEW.updated_at
	WHERE owner_user_id = NEW.owner_user_id;
	UPDATE inference_graph_legacy_projections
	SET graph_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = NEW.owner_user_id),
		updated_at = NEW.updated_at
	WHERE owner_user_id = NEW.owner_user_id;
	UPDATE inference_graph_convergence
	SET d1_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = NEW.owner_user_id),
		kv_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = NEW.owner_user_id),
		updated_at = NEW.updated_at
	WHERE owner_user_id = NEW.owner_user_id AND phase = 'terminal';
END;
