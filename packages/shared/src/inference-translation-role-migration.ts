import { resolveInferenceConfiguration } from "./inference-configuration";
import { sha256Hex } from "./ids";
import {
	InferenceGraphRepositoryError,
	inferenceGraphReadVersion,
	loadInferenceConfigurationPath,
	readTranslationInferencePointer,
} from "./inference-configuration-repository";
import {
	translationInferenceLifecycle,
	translationInferenceState,
} from "./inference-translation-role";
import { RepositoryError } from "./repository";
import type { D1DatabaseLike } from "./storage";

export type TranslationRoleMigrationStatus = {
	ownerUserId: string;
	cutoverVersion: 0 | 1 | 2;
	legacyEnabled: boolean;
	state: "migration_needed" | "deferred" | "migrated" | "corrupt";
	deferredReason: "pre_cutover" | "compatibility_rollback" | null;
	eligible: boolean;
	migrated: boolean;
	roleConfigurationId: string | null;
	roleParentId: string | null;
	pointerConfigurationId: string;
	pointerRevision: number;
	behaviorEquivalent: boolean | null;
};

/**
 * Reads one owner's bounded migration state. Version-zero interpretation is
 * retired after every cutover-1 owner reports `migrated` and every deferred
 * cutover-2 rollback window created before that convergence has expired.
 */
export async function translationRoleMigrationStatus(
	db: D1DatabaseLike,
	ownerUserId: string,
	legacyEnabled: boolean,
): Promise<TranslationRoleMigrationStatus> {
	const [version, pointer, role] = await Promise.all([
		inferenceGraphReadVersion(db, ownerUserId),
		readTranslationInferencePointer(db, ownerUserId),
		db.prepare(
			`SELECT configuration_id AS id, parent_id AS parentId
			 FROM inference_configurations
			 WHERE owner_user_id = ? AND fixed_role = 'translation' LIMIT 1`,
		).bind(ownerUserId).first<{ id: string; parentId: string }>(),
	]);
	let state: Awaited<ReturnType<typeof translationInferenceState>>;
	try {
		state = await translationInferenceState(db, ownerUserId);
	} catch (error) {
		if (error instanceof InferenceGraphRepositoryError && error.causeKind === "corrupt_graph") {
			return {
				ownerUserId,
				cutoverVersion: version.cutoverVersion,
				legacyEnabled,
				state: "corrupt",
				deferredReason: null,
				eligible: false,
				migrated: false,
				roleConfigurationId: role?.id ?? null,
				roleParentId: role?.parentId ?? null,
				pointerConfigurationId: pointer.configurationId,
				pointerRevision: pointer.revision,
				behaviorEquivalent: null,
			};
		}
		throw error;
	}

	let behaviorEquivalent: boolean | null = null;
	if (role) {
		const [rolePath, parentPath] = await Promise.all([
			loadInferenceConfigurationPath(db, ownerUserId, role.id),
			loadInferenceConfigurationPath(db, ownerUserId, role.parentId),
		]);
		const roleResolution = resolveInferenceConfiguration(rolePath);
		const parentResolution = resolveInferenceConfiguration(parentPath);
		behaviorEquivalent = await behaviorFingerprint(roleResolution) === await behaviorFingerprint(parentResolution);
	}

	const migrationState = state.kind === "canonical"
		? "migrated"
		: version.cutoverVersion === 1
			? "migration_needed"
			: "deferred";
	return {
		ownerUserId,
		cutoverVersion: version.cutoverVersion,
		legacyEnabled,
		state: migrationState,
		deferredReason: migrationState !== "deferred"
			? null
			: version.cutoverVersion === 0 ? "pre_cutover" : "compatibility_rollback",
		eligible: migrationState === "migration_needed",
		migrated: migrationState === "migrated",
		roleConfigurationId: role?.id ?? null,
		roleParentId: role?.parentId ?? null,
		pointerConfigurationId: pointer.configurationId,
		pointerRevision: pointer.revision,
		behaviorEquivalent,
	};
}

export async function migrateTranslationRoleForOwner(
	db: D1DatabaseLike,
	ownerUserId: string,
	legacyEnabled: boolean,
): Promise<TranslationRoleMigrationStatus> {
	const before = await translationRoleMigrationStatus(db, ownerUserId, legacyEnabled);
	if (before.state === "migrated") return before;
	if (before.state === "corrupt") {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Translation inference graph is corrupt and cannot be migrated.");
	}
	if (before.state === "deferred") {
		throw new RepositoryError("conflict", "Translation role migration is deferred until graph cutover version 1.", 409);
	}
	await requireTranslationRoleMigrationOwnerReady(db, ownerUserId);
	await translationInferenceLifecycle.migrateLegacy(db, ownerUserId, legacyEnabled);
	const prepared = await translationRoleMigrationStatus(db, ownerUserId, legacyEnabled);
	if (prepared.state === "corrupt") {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Translation inference graph became corrupt during migration.");
	}
	if (legacyEnabled && prepared.behaviorEquivalent !== true) {
		// The owner remains explicitly migration-pending, so ordinary reads retain
		// legacy enablement instead of treating a failed equivalence check as swept.
		throw new RepositoryError("server_error", "Translation role migration changed effective inference behavior.", 500);
	}
	await translationInferenceLifecycle.completeMigration(db, ownerUserId, legacyEnabled);
	return translationRoleMigrationStatus(db, ownerUserId, legacyEnabled);
}

async function requireTranslationRoleMigrationOwnerReady(db: D1DatabaseLike, ownerUserId: string): Promise<void> {
	const row = await db.prepare(
		`SELECT EXISTS (
			SELECT 1 FROM users_index
			WHERE user_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active'
		) AS active,
		EXISTS (
			SELECT 1 FROM inference_graph_migration_operations
			WHERE owner_user_id = ? AND phase NOT IN ('terminal', 'terminal_failed')
		) AS migrating`,
	).bind(ownerUserId, ownerUserId).first<{ active: number; migrating: number }>();
	if (!row?.active) throw new RepositoryError("not_found", "Active account not found.", 404);
	if (row.migrating) {
		throw new RepositoryError("conflict", "Inference graph migration must finish before Translation role migration.", 409);
	}
}

async function behaviorFingerprint(
	resolution: ReturnType<typeof resolveInferenceConfiguration>,
): Promise<string> {
	// The role deliberately adds one provenance hop. Compare resolved behavior,
	// not source/depth metadata, and represent credentials only by availability
	// and version so plaintext can never enter maintenance output or hashes.
	const effective = resolution.effective;
	const credential = effective.credential;
	return sha256Hex(JSON.stringify({
		baseUrl: effective.baseUrl,
		model: effective.model,
		providerRouting: effective.providerRouting ?? null,
		reasoningEffort: effective.reasoningEffort ?? null,
		compactionReasoning: effective.compactionReasoning,
		toolCalls: effective.toolCalls,
		compactionMode: effective.compactionMode,
		promptCacheMode: effective.promptCacheMode,
		supportsPrefill: effective.supportsPrefill,
		temperature: effective.temperature,
		topK: effective.topK ?? null,
		topP: effective.topP ?? null,
		minP: effective.minP ?? null,
		frequencyPenalty: effective.frequencyPenalty ?? null,
		presencePenalty: effective.presencePenalty ?? null,
		repetitionPenalty: effective.repetitionPenalty ?? null,
		credential: credential.kind === "available"
			? { kind: credential.kind, secretVersion: credential.secretVersion }
			: { kind: credential.kind },
		image: Object.fromEntries(Object.entries(effective.image).map(([field, value]) => [
			field,
			value.state === "value" ? { state: value.state, value: value.value } : { state: value.state },
		])),
	}));
}
