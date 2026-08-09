import { resolveInferenceConfiguration } from "./inference-configuration";
import { sha256Hex } from "./ids";
import {
	inferenceGraphReadVersion,
	accountDefaultConfigurationId,
	loadInferenceConfigurationPath,
	readTranslationInferencePointer,
} from "./inference-configuration-repository";
import {
	canonicalTranslationInferenceState,
	translationInferenceLifecycle,
} from "./inference-translation-role";
import { RepositoryError } from "./repository";
import type { D1DatabaseLike } from "./storage";

export type TranslationRoleMigrationStatus = {
	ownerUserId: string;
	cutoverVersion: 1;
	legacyEnabled: boolean;
	migrated: boolean;
	roleConfigurationId: string | null;
	roleParentId: string | null;
	pointerConfigurationId: string;
	pointerRevision: number;
	behaviorEquivalent: boolean | null;
};

/**
 * Reads one owner's bounded migration state. The one-time operator sweep is the
 * retirement path for the legacy selection interpretation used while no fixed
 * role exists; after every eligible owner reports migrated, that adapter can be
 * deleted with the old profile provider fields.
 */
export async function translationRoleMigrationStatus(
	db: D1DatabaseLike,
	ownerUserId: string,
	legacyEnabled: boolean,
): Promise<TranslationRoleMigrationStatus> {
	await requireTranslationRoleMigrationEligible(db, ownerUserId);
	const pointer = await readTranslationInferencePointer(db, ownerUserId);
	const rootId = await accountDefaultConfigurationId(ownerUserId);
	const role = await db.prepare(
		`SELECT configuration_id AS id, parent_id AS parentId
		 FROM inference_configurations
		 WHERE owner_user_id = ? AND fixed_role = 'translation' LIMIT 1`,
	).bind(ownerUserId).first<{ id: string; parentId: string }>();
	let behaviorEquivalent: boolean | null = null;
	if (role) {
		await canonicalTranslationInferenceState(db, ownerUserId);
		const [rolePath, parentPath] = await Promise.all([
			loadInferenceConfigurationPath(db, ownerUserId, role.id),
			loadInferenceConfigurationPath(db, ownerUserId, role.parentId),
		]);
		const roleResolution = resolveInferenceConfiguration(rolePath);
		const parentResolution = resolveInferenceConfiguration(parentPath);
		behaviorEquivalent = await behaviorFingerprint(roleResolution) === await behaviorFingerprint(parentResolution);
	}
	return {
		ownerUserId,
		cutoverVersion: 1,
		legacyEnabled,
		migrated: role !== null || !legacyEnabled && pointer.configurationId === rootId && pointer.selectedKind === "account_default",
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
	await requireTranslationRoleMigrationEligible(db, ownerUserId);
	await translationInferenceLifecycle.migrateLegacy(db, ownerUserId, legacyEnabled);
	const state = await canonicalTranslationInferenceState(db, ownerUserId);
	if (state.enabled) {
		const status = await translationRoleMigrationStatus(db, ownerUserId, legacyEnabled);
		if (!status.behaviorEquivalent) {
			throw new RepositoryError("server_error", "Translation role migration changed effective inference behavior.", 500);
		}
		return status;
	}
	return translationRoleMigrationStatus(db, ownerUserId, legacyEnabled);
}

async function requireTranslationRoleMigrationEligible(db: D1DatabaseLike, ownerUserId: string): Promise<void> {
	const version = await inferenceGraphReadVersion(db, ownerUserId);
	if (version.cutoverVersion !== 1) {
		throw new RepositoryError("conflict", "Translation role migration requires inference graph cutover version 1.", 409);
	}
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
