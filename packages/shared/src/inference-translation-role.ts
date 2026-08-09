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

/**
 * This physical-custom identity adapts the fixed role to 0042's three-kind
 * CHECK/FK schema. Remove the adapter after every owner is transition version
 * one, pre-convergence rollback windows have expired, and 0042 is no longer a
 * supported rollback target.
 */
const translationStorageName = "__bickr_translation__";

export type TranslationRoleRow = {
	id: string;
	parentId: string;
	revision: number;
};

type TranslationStateRows = TranslationInferencePointer & {
	rootId: string;
	roleId: string | null;
	roleParentId: string | null;
	roleRevision: number | null;
	cutoverVersion: 0 | 1 | 2;
	stateVersion: 0 | 1;
};

export type CanonicalTranslationInferenceState =
	| { kind: "canonical"; enabled: false; rootId: string; cutoverVersion: 0 | 1 | 2; pointerRevision: number }
	| { kind: "canonical"; enabled: true; rootId: string; cutoverVersion: 0 | 1 | 2; role: TranslationRoleRow; pointerRevision: number };

export type PendingTranslationInferenceState = {
	kind: "migration_pending";
	rootId: string;
	cutoverVersion: 0 | 1 | 2;
	selection: {
		configurationId: string;
		selectedKind: "account_default" | "custom";
	};
	role: TranslationRoleRow | null;
	pointerRevision: number;
};

export type TranslationInferenceState = CanonicalTranslationInferenceState | PendingTranslationInferenceState;

async function translationStateRows(db: D1DatabaseLike, ownerUserId: string): Promise<TranslationStateRows> {
	const row = await db.prepare(
		`SELECT pointer.owner_user_id AS ownerUserId,
			pointer.configuration_id AS configurationId,
			pointer.selected_kind AS selectedKind,
			pointer.revision, pointer.updated_at AS updatedAt,
			root.configuration_id AS rootId,
			role.configuration_id AS roleId,
			role.parent_id AS roleParentId,
			role.revision AS roleRevision,
			graph.cutover_version AS cutoverVersion,
			graph.translation_role_state_version AS stateVersion
		 FROM inference_translation_selections AS pointer
		 JOIN inference_graph_users AS graph ON graph.owner_user_id = pointer.owner_user_id
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
 * Reads both the bounded pre-sweep compatibility state and the permanent
 * canonical state. Version zero is retired after the cutover-1 fleet has
 * converged and every pre-convergence cutover-2 rollback window has expired.
 */
export async function translationInferenceState(
	db: D1DatabaseLike,
	ownerUserId: string,
): Promise<TranslationInferenceState> {
	const row = await translationStateRows(db, ownerUserId);
	if (row.stateVersion === 0) return pendingStateFromRows(db, ownerUserId, row);
	return canonicalStateFromRows(db, ownerUserId, row);
}

/** Reads the post-sweep invariant and rejects use before the owner is swept. */
export async function canonicalTranslationInferenceState(
	db: D1DatabaseLike,
	ownerUserId: string,
): Promise<CanonicalTranslationInferenceState> {
	const state = await translationInferenceState(db, ownerUserId);
	if (state.kind === "migration_pending") {
		throw new RepositoryError("conflict", "Translation inference state still requires the one-time role migration.", 409);
	}
	return state;
}

async function pendingStateFromRows(
	db: D1DatabaseLike,
	ownerUserId: string,
	row: TranslationStateRows,
): Promise<PendingTranslationInferenceState> {
	let role: TranslationRoleRow | null = null;
	if (row.roleId !== null) {
		role = await roleFromCanonicalRows(db, ownerUserId, row);
	} else {
		const selected = (await loadInferenceConfigurationPath(db, ownerUserId, row.configurationId))[0];
		if (selected.kind !== "account_default" && selected.kind !== "custom") corruptTranslationState();
		if (selected.kind !== row.selectedKind) corruptTranslationState();
	}
	return {
		kind: "migration_pending",
		rootId: row.rootId,
		cutoverVersion: row.cutoverVersion,
		selection: { configurationId: row.configurationId, selectedKind: row.selectedKind },
		role,
		pointerRevision: row.revision,
	};
}

async function canonicalStateFromRows(
	db: D1DatabaseLike,
	ownerUserId: string,
	row: TranslationStateRows,
): Promise<CanonicalTranslationInferenceState> {
	if (row.roleId === null) {
		if (row.configurationId !== row.rootId || row.selectedKind !== "account_default") corruptTranslationState();
		return {
			kind: "canonical",
			enabled: false,
			rootId: row.rootId,
			cutoverVersion: row.cutoverVersion,
			pointerRevision: row.revision,
		};
	}
	return {
		kind: "canonical",
		enabled: true,
		rootId: row.rootId,
		cutoverVersion: row.cutoverVersion,
		role: await roleFromCanonicalRows(db, ownerUserId, row),
		pointerRevision: row.revision,
	};
}

async function roleFromCanonicalRows(
	db: D1DatabaseLike,
	ownerUserId: string,
	row: TranslationStateRows,
): Promise<TranslationRoleRow> {
	if (row.roleId === null || row.roleParentId === null || row.roleRevision === null ||
		row.configurationId !== row.roleId || row.selectedKind !== "custom") {
		corruptTranslationState();
	}
	const selected = (await loadInferenceConfigurationPath(db, ownerUserId, row.roleId))[0];
	if (selected.kind !== "translation") corruptTranslationState();
	return { id: row.roleId, parentId: row.roleParentId, revision: row.roleRevision };
}

type TranslationInferenceLifecycleCapability = Readonly<{
	enable(db: D1DatabaseLike, ownerUserId: string, now?: string): Promise<CanonicalTranslationInferenceState>;
	disable(db: D1DatabaseLike, ownerUserId: string, now?: string): Promise<CanonicalTranslationInferenceState>;
	migrateLegacy(db: D1DatabaseLike, ownerUserId: string, legacyEnabled: boolean, now?: string): Promise<TranslationInferenceState>;
	completeMigration(db: D1DatabaseLike, ownerUserId: string, legacyEnabled: boolean, now?: string): Promise<CanonicalTranslationInferenceState>;
}>;

/** Every caller must hold the owner's UserBotsCoordinator operation queue. */
export const translationInferenceLifecycle: TranslationInferenceLifecycleCapability = Object.freeze({
	enable: enableTranslationInference,
	disable: disableTranslationInference,
	migrateLegacy: migrateLegacyTranslationInference,
	completeMigration: completeTranslationInferenceMigration,
});

async function enableTranslationInference(
	db: D1DatabaseLike,
	ownerUserId: string,
	now = new Date().toISOString(),
): Promise<CanonicalTranslationInferenceState> {
	const current = await translationInferenceState(db, ownerUserId);
	if (current.kind === "migration_pending") {
		requireWritablePendingState(current);
		if (current.role) {
			await markTranslationInferenceCanonical(db, ownerUserId, true, current.pointerRevision, now);
		} else {
			await assertTranslationRoleQuota(db, ownerUserId);
			await insertTranslationRole(
				db, ownerUserId, current.rootId, current.pointerRevision, now, true,
			);
		}
		return canonicalTranslationInferenceState(db, ownerUserId);
	}
	requireWritableCanonicalState(current);
	if (current.enabled) return current;
	await assertTranslationRoleQuota(db, ownerUserId);
	await insertTranslationRole(db, ownerUserId, current.rootId, current.pointerRevision, now, false);
	return canonicalTranslationInferenceState(db, ownerUserId);
}

async function insertTranslationRole(
	db: D1DatabaseLike,
	ownerUserId: string,
	parentId: string,
	expectedPointerRevision: number,
	now: string,
	completeTransition: boolean,
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
			...(completeTransition ? [translationStateVersionStatement(
				db, ownerUserId, true, expectedPointerRevision + 1, now,
			)] : []),
		]);
		if (!results[0]?.meta?.changes || !results[1]?.meta?.changes ||
			completeTransition && !results[2]?.meta?.changes) staleTranslationState();
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
	const current = await translationInferenceState(db, ownerUserId);
	if (current.kind === "migration_pending") {
		requireWritablePendingState(current);
		const role = current.role;
		if (role) {
			await disableTranslationRole(db, ownerUserId, { ...current, role }, now, true);
		} else {
			await resetPendingTranslationToRoot(db, ownerUserId, current, now, true);
		}
		return canonicalTranslationInferenceState(db, ownerUserId);
	}
	requireWritableCanonicalState(current);
	if (!current.enabled) return current;
	await disableTranslationRole(db, ownerUserId, current, now, false);
	return canonicalTranslationInferenceState(db, ownerUserId);
}

async function disableTranslationRole(
	db: D1DatabaseLike,
	ownerUserId: string,
	current: { rootId: string; role: TranslationRoleRow; pointerRevision: number },
	now: string,
	completeTransition: boolean,
): Promise<void> {
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
		...(completeTransition ? [translationStateVersionStatement(
			db, ownerUserId, false, current.pointerRevision + 1, now,
		)] : []),
	]);
	if (!results[2]?.meta?.changes || !results[3]?.meta?.changes ||
		completeTransition && !results[4]?.meta?.changes) staleTranslationState();
}

async function migrateLegacyTranslationInference(
	db: D1DatabaseLike,
	ownerUserId: string,
	legacyEnabled: boolean,
	now = new Date().toISOString(),
): Promise<TranslationInferenceState> {
	const current = await translationInferenceState(db, ownerUserId);
	if (current.kind === "canonical") return current;
	requireWritablePendingState(current);
	if (!legacyEnabled) {
		const role = current.role;
		if (role) {
			await disableTranslationRole(db, ownerUserId, { ...current, role }, now, false);
		} else if (current.selection.configurationId !== current.rootId || current.selection.selectedKind !== "account_default") {
			await resetPendingTranslationToRoot(db, ownerUserId, current, now, false);
		}
		return translationInferenceState(db, ownerUserId);
	}
	if (current.role) return current;
	await assertTranslationRoleQuota(db, ownerUserId);
	await insertTranslationRole(
		db, ownerUserId, current.selection.configurationId, current.pointerRevision, now, false,
	);
	return translationInferenceState(db, ownerUserId);
}

async function resetPendingTranslationToRoot(
	db: D1DatabaseLike,
	ownerUserId: string,
	current: PendingTranslationInferenceState,
	now: string,
	completeTransition: boolean,
): Promise<void> {
	const statements = [];
	if (current.selection.configurationId !== current.rootId || current.selection.selectedKind !== "account_default") {
		statements.push(db.prepare(
			`UPDATE inference_translation_selections
			 SET configuration_id = ?, selected_kind = 'account_default', revision = revision + 1, updated_at = ?
			 WHERE owner_user_id = ? AND revision = ?
				AND NOT EXISTS (SELECT 1 FROM inference_configurations
					WHERE owner_user_id = ? AND fixed_role = 'translation')`,
		).bind(current.rootId, now, ownerUserId, current.pointerRevision, ownerUserId));
	}
	const nextPointerRevision = current.pointerRevision + (statements.length ? 1 : 0);
	if (completeTransition) {
		statements.push(translationStateVersionStatement(db, ownerUserId, false, nextPointerRevision, now));
	}
	if (!statements.length) return;
	const results = await db.batch(statements);
	if (results.some((result) => !result.meta?.changes)) staleTranslationState();
}

async function completeTranslationInferenceMigration(
	db: D1DatabaseLike,
	ownerUserId: string,
	legacyEnabled: boolean,
	now = new Date().toISOString(),
): Promise<CanonicalTranslationInferenceState> {
	const current = await translationInferenceState(db, ownerUserId);
	if (current.kind === "canonical") return current;
	requireWritablePendingState(current);
	if (legacyEnabled !== Boolean(current.role)) corruptTranslationState();
	if (!legacyEnabled &&
		(current.selection.configurationId !== current.rootId || current.selection.selectedKind !== "account_default")) {
		corruptTranslationState();
	}
	await markTranslationInferenceCanonical(db, ownerUserId, legacyEnabled, current.pointerRevision, now);
	return canonicalTranslationInferenceState(db, ownerUserId);
}

async function markTranslationInferenceCanonical(
	db: D1DatabaseLike,
	ownerUserId: string,
	enabled: boolean,
	expectedPointerRevision: number,
	now: string,
): Promise<void> {
	const result = await translationStateVersionStatement(
		db, ownerUserId, enabled, expectedPointerRevision, now,
	).run();
	if (!result.meta?.changes) staleTranslationState();
}

function translationStateVersionStatement(
	db: D1DatabaseLike,
	ownerUserId: string,
	enabled: boolean,
	expectedPointerRevision: number,
	now: string,
) {
	const shape = enabled
		? `EXISTS (
			SELECT 1 FROM inference_translation_selections AS pointer
			JOIN inference_configurations AS role
				ON role.configuration_id = pointer.configuration_id AND role.owner_user_id = pointer.owner_user_id
			WHERE pointer.owner_user_id = inference_graph_users.owner_user_id
				AND pointer.selected_kind = 'custom' AND pointer.revision = ?
				AND role.fixed_role = 'translation'
		)`
		: `EXISTS (
			SELECT 1 FROM inference_translation_selections AS pointer
			JOIN inference_configurations AS root
				ON root.configuration_id = pointer.configuration_id AND root.owner_user_id = pointer.owner_user_id
			WHERE pointer.owner_user_id = inference_graph_users.owner_user_id
				AND pointer.selected_kind = 'account_default' AND pointer.revision = ?
				AND root.kind = 'account_default'
		) AND NOT EXISTS (
			SELECT 1 FROM inference_configurations AS role
			WHERE role.owner_user_id = inference_graph_users.owner_user_id AND role.fixed_role = 'translation'
		)`;
	return db.prepare(
		`UPDATE inference_graph_users
		 SET translation_role_state_version = 1, updated_at = ?
		 WHERE owner_user_id = ? AND cutover_version = 1
			AND translation_role_state_version = 0 AND ${shape}`,
	).bind(now, ownerUserId, expectedPointerRevision);
}

function requireWritablePendingState(state: PendingTranslationInferenceState): void {
	if (state.cutoverVersion !== 1) {
		throw new RepositoryError("conflict", "Translation role migration is deferred outside graph cutover version 1.", 409);
	}
}

function requireWritableCanonicalState(state: CanonicalTranslationInferenceState): void {
	if (state.cutoverVersion !== 1) {
		throw new RepositoryError("conflict", "Translation inference lifecycle is unavailable during graph compatibility rollback.", 409);
	}
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
