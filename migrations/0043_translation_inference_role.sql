ALTER TABLE inference_configurations
	ADD COLUMN fixed_role TEXT CHECK (fixed_role IS NULL OR fixed_role = 'translation');

-- The physical-custom name below is a compatibility adapter for 0042's
-- three-kind CHECK/FK shape. Retire its application-code interpretation only
-- after the 0044 version-zero fleet has converged, all pre-convergence
-- cutover-2 rollback windows have expired, and the old three-kind schema is no
-- longer a supported rollback target.

ALTER TABLE inference_graph_legacy_projection_entries
	ADD COLUMN fixed_role TEXT CHECK (fixed_role IS NULL OR fixed_role = 'translation');

DROP INDEX inference_configurations_custom_name;

CREATE UNIQUE INDEX inference_configurations_custom_name
	ON inference_configurations (owner_user_id, custom_name_key)
	WHERE kind = 'custom' AND fixed_role IS NULL;

CREATE UNIQUE INDEX inference_configurations_fixed_role
	ON inference_configurations (owner_user_id, fixed_role)
	WHERE fixed_role = 'translation';

-- Translation is physically custom to preserve the original table shape, but
-- its typed role and internal storage name are immutable. Public code maps the
-- role to the fixed display identity instead of exposing these storage values.
CREATE TRIGGER inference_configuration_translation_role_insert
BEFORE INSERT ON inference_configurations
WHEN NEW.fixed_role = 'translation' AND (
	NEW.kind IS NOT 'custom' OR NEW.parent_id IS NULL OR
	NEW.world_id IS NOT NULL OR NEW.bot_id IS NOT NULL OR
	NEW.custom_name IS NOT '__bickr_translation__' OR
	NEW.custom_name_key IS NOT '__bickr_translation__'
)
BEGIN
	SELECT RAISE(ABORT, 'invalid fixed translation inference configuration');
END;

CREATE TRIGGER inference_configuration_translation_role_shape_update
BEFORE UPDATE OF kind, parent_id, world_id, bot_id, custom_name, custom_name_key
	ON inference_configurations
WHEN NEW.fixed_role = 'translation' AND (
	NEW.kind IS NOT 'custom' OR NEW.parent_id IS NULL OR
	NEW.world_id IS NOT NULL OR NEW.bot_id IS NOT NULL OR
	NEW.custom_name IS NOT '__bickr_translation__' OR
	NEW.custom_name_key IS NOT '__bickr_translation__'
)
BEGIN
	SELECT RAISE(ABORT, 'invalid fixed translation inference configuration');
END;

CREATE TRIGGER inference_configuration_fixed_role_immutable
BEFORE UPDATE OF fixed_role, custom_name, custom_name_key ON inference_configurations
WHEN NEW.fixed_role IS NOT OLD.fixed_role OR (
	OLD.fixed_role = 'translation' AND (
		NEW.custom_name IS NOT OLD.custom_name OR
		NEW.custom_name_key IS NOT OLD.custom_name_key
	)
)
BEGIN
	SELECT RAISE(ABORT, 'fixed inference configuration identity is immutable');
END;

DROP TRIGGER inference_graph_projection_after_credential_insert;

CREATE TRIGGER inference_graph_projection_after_credential_insert
AFTER INSERT ON inference_configuration_credentials
WHEN EXISTS (
	SELECT 1 FROM inference_graph_legacy_projections WHERE owner_user_id = NEW.owner_user_id
)
BEGIN
	INSERT INTO inference_graph_legacy_projection_entries (
		owner_user_id, configuration_id, kind, fixed_role, parent_id, world_id, bot_id,
		custom_name, custom_name_key, overrides_json, configuration_revision,
		credential_mode, credential_secret_version
	)
	SELECT configuration.owner_user_id, configuration.configuration_id,
		configuration.kind, configuration.fixed_role, configuration.parent_id,
		configuration.world_id, configuration.bot_id, configuration.custom_name,
		configuration.custom_name_key, configuration.overrides_json,
		configuration.revision, NEW.mode, NEW.secret_version
	FROM inference_configurations AS configuration
	WHERE configuration.configuration_id = NEW.configuration_id
		AND configuration.owner_user_id = NEW.owner_user_id;
END;

DROP TRIGGER inference_graph_projection_after_configuration_update;

CREATE TRIGGER inference_graph_projection_after_configuration_update
AFTER UPDATE ON inference_configurations
BEGIN
	UPDATE inference_graph_legacy_projection_entries
	SET fixed_role = NEW.fixed_role, parent_id = NEW.parent_id,
		custom_name = NEW.custom_name, custom_name_key = NEW.custom_name_key,
		overrides_json = NEW.overrides_json, configuration_revision = NEW.revision
	WHERE owner_user_id = NEW.owner_user_id AND configuration_id = NEW.configuration_id;
END;
