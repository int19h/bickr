import { isD1UniqueConstraintError } from "./d1-errors";
import { makeId } from "./ids";
import { inferenceConfigurationOwnerQuota } from "./inference-configuration";
import {
	InferenceGraphRepositoryError,
	loadInferenceConfigurationPath,
	type TranslationInferencePointer,
} from "./inference-configuration-repository";
import { RepositoryError } from "./repository";
import type { D1DatabaseLike } from "./storage";

const translationStorageName = "__bickr_translation__";

type TranslationRoleRow = {
	id: string;
	parentId: string;
	revision: number;
};

type TranslationStateRows = TranslationInferencePointer & {
	rootId: string;
	roleId: string | null;
	roleParentId: string | null;
	roleRevision: number | null;
};

export type CanonicalTranslationInferenceState =
	| { enabled: false; rootId: string; pointerRevision: number }
	| { enabled: true; rootId: string; role: TranslationRoleRow; pointerRevision: number };

async function translationStateRows(db: D1DatabaseLike, ownerUserId: string): Promise<TranslationStateRows> {
	const row = await db.prepare(
		`SELECT pointer.owner_user_id AS ownerUserId,
			pointer.configuration_id AS configurationId,
			pointer.selected_kind AS selectedKind,
			pointer.revision, pointer.updated_at AS updatedAt,
			root.configuration_id AS rootId,
			role.configuration_id AS roleId,
			role.parent_id AS roleParentId,
			role.revision AS roleRevision
		 FROM inference_translation_selections AS pointer
		 JOIN inference_configurations AS root
			ON root.owner_user_id = pointer.owner_user_id AND root.kind = 'account_default'
		 LEFT JOIN inference_configurations AS role
			ON role.owner_user_id = pointer.owner_user_id AND role.fixed_role = 'translation'
		 WHERE pointer.owner_user_id = ? LIMIT 1`,
	).bind(ownerUserId).first<TranslationStateRows>();
	if (!row) throw new RepositoryError("not_found", "Inference graph owner not found.", 404);
	return row;
}

/**
 * Reads the post-cutover invariant. The fixed role is the enablement authority;
 * the legacy pointer is retained only as a projection-compatible address and
 * must agree exactly with that role state.
 */
export async function canonicalTranslationInferenceState(
	db: D1DatabaseLike,
	ownerUserId: string,
): Promise<CanonicalTranslationInferenceState> {
	const row = await translationStateRows(db, ownerUserId);
	if (row.roleId === null) {
		if (row.configurationId !== row.rootId || row.selectedKind !== "account_default") corruptTranslationState();
		return { enabled: false, rootId: row.rootId, pointerRevision: row.revision };
	}
	if (!row.roleParentId || !row.roleRevision || row.configurationId !== row.roleId || row.selectedKind !== "custom") {
		corruptTranslationState();
	}
	const selected = (await loadInferenceConfigurationPath(db, ownerUserId, row.roleId))[0];
	if (selected.kind !== "translation") corruptTranslationState();
	return {
		enabled: true,
		rootId: row.rootId,
		role: { id: row.roleId, parentId: row.roleParentId, revision: row.roleRevision },
		pointerRevision: row.revision,
	};
}

type TranslationInferenceLifecycleCapability = Readonly<{
	enable(db: D1DatabaseLike, ownerUserId: string, now?: string): Promise<CanonicalTranslationInferenceState>;
	disable(db: D1DatabaseLike, ownerUserId: string, now?: string): Promise<CanonicalTranslationInferenceState>;
	migrateLegacy(db: D1DatabaseLike, ownerUserId: string, legacyEnabled: boolean, now?: string): Promise<CanonicalTranslationInferenceState>;
}>;

/** Every caller must hold the owner's UserBotsCoordinator operation queue. */
export const translationInferenceLifecycle: TranslationInferenceLifecycleCapability = Object.freeze({
	enable: enableTranslationInference,
	disable: disableTranslationInference,
	migrateLegacy: migrateLegacyTranslationInference,
});

async function enableTranslationInference(
	db: D1DatabaseLike,
	ownerUserId: string,
	now = new Date().toISOString(),
): Promise<CanonicalTranslationInferenceState> {
	const current = await canonicalTranslationInferenceState(db, ownerUserId);
	if (current.enabled) return current;
	await assertTranslationRoleQuota(db, ownerUserId);
	await insertTranslationRole(db, ownerUserId, current.rootId, current.pointerRevision, now);
	return canonicalTranslationInferenceState(db, ownerUserId);
}

async function insertTranslationRole(
	db: D1DatabaseLike,
	ownerUserId: string,
	parentId: string,
	expectedPointerRevision: number,
	now: string,
): Promise<void> {
	const configurationId = makeId("cfg");
	try {
		const results = await db.batch([
			db.prepare(
				`INSERT INTO inference_configurations (
					configuration_id, owner_user_id, kind, fixed_role, parent_id,
					custom_name, custom_name_key, overrides_json, revision, created_at, updated_at
				) SELECT ?, ?, 'custom', 'translation', ?, ?, ?, '{}', 1, ?, ?
				  WHERE EXISTS (
					SELECT 1 FROM inference_translation_selections
					WHERE owner_user_id = ? AND revision = ?
				  )`,
			).bind(
				configurationId, ownerUserId, parentId, translationStorageName,
				translationStorageName, now, now, ownerUserId, expectedPointerRevision,
			),
			db.prepare(
				`UPDATE inference_translation_selections
				 SET configuration_id = ?, selected_kind = 'custom', revision = revision + 1, updated_at = ?
				 WHERE owner_user_id = ? AND revision = ?
					AND NOT EXISTS (SELECT 1 FROM inference_configurations
						WHERE owner_user_id = ? AND fixed_role = 'translation' AND configuration_id != ?)`,
			).bind(configurationId, now, ownerUserId, expectedPointerRevision, ownerUserId, configurationId),
		]);
		if (!results[0]?.meta?.changes || !results[1]?.meta?.changes) staleTranslationState();
	} catch (error) {
		if (error instanceof RepositoryError) throw error;
		if (isD1UniqueConstraintError(error)) {
			throw new InferenceGraphRepositoryError("unexpected_unique_conflict", "Translation inference role already exists.");
		}
		throw error;
	}
}

async function disableTranslationInference(
	db: D1DatabaseLike,
	ownerUserId: string,
	now = new Date().toISOString(),
): Promise<CanonicalTranslationInferenceState> {
	const current = await canonicalTranslationInferenceState(db, ownerUserId);
	if (!current.enabled) return current;
	const role = current.role;
	const guard = `EXISTS (
		SELECT 1 FROM inference_configurations AS role
		JOIN inference_translation_selections AS pointer ON pointer.owner_user_id = role.owner_user_id
		WHERE role.configuration_id = ? AND role.owner_user_id = ?
			AND role.fixed_role = 'translation' AND role.revision = ?
			AND pointer.configuration_id = role.configuration_id
			AND pointer.selected_kind = 'custom' AND pointer.revision = ?
	)`;
	const results = await db.batch([
		db.prepare(
			`UPDATE inference_configurations SET parent_id = ?, revision = revision + 1, updated_at = ?
			 WHERE owner_user_id = ? AND parent_id = ? AND ${guard}`,
		).bind(role.parentId, now, ownerUserId, role.id,
			role.id, ownerUserId, role.revision, current.pointerRevision),
		db.prepare(
			`DELETE FROM inference_configuration_credentials
			 WHERE configuration_id = ? AND owner_user_id = ? AND ${guard}`,
		).bind(role.id, ownerUserId, role.id, ownerUserId, role.revision, current.pointerRevision),
		db.prepare(
			`UPDATE inference_translation_selections
			 SET configuration_id = ?, selected_kind = 'account_default', revision = revision + 1, updated_at = ?
			 WHERE owner_user_id = ? AND configuration_id = ? AND selected_kind = 'custom' AND revision = ?
				AND EXISTS (SELECT 1 FROM inference_configurations
					WHERE configuration_id = ? AND owner_user_id = ?
						AND fixed_role = 'translation' AND revision = ?)`,
		).bind(current.rootId, now, ownerUserId, role.id, current.pointerRevision,
			role.id, ownerUserId, role.revision),
		db.prepare(
			`DELETE FROM inference_configurations
			 WHERE configuration_id = ? AND owner_user_id = ? AND fixed_role = 'translation' AND revision = ?
				AND NOT EXISTS (SELECT 1 FROM inference_configuration_credentials
					WHERE configuration_id = ? AND owner_user_id = ?)
				AND EXISTS (SELECT 1 FROM inference_translation_selections
					WHERE owner_user_id = ? AND configuration_id = ?
						AND selected_kind = 'account_default' AND revision = ?)`,
		).bind(role.id, ownerUserId, role.revision, role.id, ownerUserId,
			ownerUserId, current.rootId, current.pointerRevision + 1),
	]);
	if (!results[2]?.meta?.changes || !results[3]?.meta?.changes) staleTranslationState();
	return canonicalTranslationInferenceState(db, ownerUserId);
}

async function migrateLegacyTranslationInference(
	db: D1DatabaseLike,
	ownerUserId: string,
	legacyEnabled: boolean,
	now = new Date().toISOString(),
): Promise<CanonicalTranslationInferenceState> {
	const raw = await translationStateRows(db, ownerUserId);
	// Role presence proves this owner has already crossed the one-time boundary;
	// stale KV can never reverse a later canonical owner choice.
	if (raw.roleId !== null) return canonicalTranslationInferenceState(db, ownerUserId);
	if (!legacyEnabled) {
		if (raw.configurationId !== raw.rootId || raw.selectedKind !== "account_default") {
			const result = await db.prepare(
				`UPDATE inference_translation_selections
				 SET configuration_id = ?, selected_kind = 'account_default', revision = revision + 1, updated_at = ?
				 WHERE owner_user_id = ? AND revision = ?
					AND NOT EXISTS (SELECT 1 FROM inference_configurations
						WHERE owner_user_id = ? AND fixed_role = 'translation')`,
			).bind(raw.rootId, now, ownerUserId, raw.revision, ownerUserId).run();
			if (!result.meta?.changes) staleTranslationState();
		}
		return canonicalTranslationInferenceState(db, ownerUserId);
	}
	const parent = (await loadInferenceConfigurationPath(db, ownerUserId, raw.configurationId))[0];
	if (parent.kind !== "account_default" && parent.kind !== "custom") corruptTranslationState();
	if (parent.kind === "account_default" && raw.selectedKind !== "account_default" ||
		parent.kind === "custom" && raw.selectedKind !== "custom") corruptTranslationState();
	await assertTranslationRoleQuota(db, ownerUserId);
	await insertTranslationRole(db, ownerUserId, parent.id, raw.revision, now);
	return canonicalTranslationInferenceState(db, ownerUserId);
}

async function assertTranslationRoleQuota(db: D1DatabaseLike, ownerUserId: string): Promise<void> {
	const row = await db.prepare(
		`SELECT COUNT(*) AS count FROM inference_configurations WHERE owner_user_id = ?`,
	).bind(ownerUserId).first<{ count: number }>();
	if ((row?.count ?? 0) >= inferenceConfigurationOwnerQuota) {
		throw new InferenceGraphRepositoryError("quota_exceeded", "Inference configuration quota reached.");
	}
}

function corruptTranslationState(): never {
	throw new InferenceGraphRepositoryError("corrupt_graph", "Translation inference role and compatibility pointer disagree.");
}

function staleTranslationState(): never {
	throw new InferenceGraphRepositoryError("stale_revision", "Translation inference state changed; reload and try again.");
}
