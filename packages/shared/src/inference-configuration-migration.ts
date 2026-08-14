import {
	inferenceOverridesFromLegacyImageSettings,
	inferenceOverridesFromLegacySettings,
	inferenceOverridesFromLegacyTranslationSettings,
	parseLegacyInferenceCompatibilityFieldMask,
	type LegacyInferenceCompatibilityFieldMask,
} from "./inference-configuration-legacy";
import {
	inferenceConfigurationCorruptionSentinel,
	isHistoricalBickrDefaultImageModel,
	parseStoredInferenceConfigurationOverrides,
	type InferenceConfigurationOverrides,
} from "./inference-configuration";
import { resolveInferenceConfiguration, type AvatarInferenceTarget, type InferenceConfigurationNode, type InferenceResolution } from "./inference-configuration";
import {
	bickrInferenceDefaultsFromEnvironment,
	canonicalAvatarImageSettings,
	providerSettingsFromResolution,
	translationToolCallStrategy,
} from "./inference-configuration-consumers";
import {
	inferenceGraphReadVersion,
	inferenceConfigurationPathFromSnapshot,
	insertAccountDefaultConfigurationStatement,
	insertFixedConfigurationStatement,
	loadInternalInferenceConfigurationAncestors,
} from "./inference-configuration-repository";
import {
	accountDefaultConfigurationId,
	botConfigurationId,
	worldConfigurationId,
} from "./inference-configuration-repository";
import { sha256Hex } from "./ids";
import { readMaintenanceState } from "./maintenance";
import {
	avatarImageGenerationSettingsWithDefaults,
	defaultAvatarImageGenerationSettings,
	defaultTextGenerationTemperature,
	defaultWorldAvatarImageGenerationSettings,
	worldAvatarImageGenerationSettingsWithDefaults,
	type BotDocument,
	type BotImageGenerationSettings,
	type BotInferenceSettings,
	type UserDocument,
	type WorldDocument,
} from "./model";
import {
	isOpenRouterProviderBaseUrl,
	providerEnvironmentSettingsFromBindings,
	resolveBotProviderSettings,
	resolveLegacyTranslationProviderSettings,
	type ProviderEnvironmentBindings,
	type ProviderSettings,
} from "./inference-settings";
import { RepositoryError } from "./repository";
import { kvKeys, readJson, type D1DatabaseLike, type D1PreparedStatementLike, type KVNamespaceLike } from "./storage";

export const inferenceGraphMigrationVersion = 1;
export const inferenceGraphTerminalRetentionDays = 30;
export const inferenceGraphMigrationBatchLimit = 50;
export const inferenceProviderDefaultBarrierSweepBatchLimit = 25;

export type InferenceProviderDefaultBarrierSweepResult = {
	kind: "inference_provider_default_barrier_sweep";
	ownerUserId: string;
	phase: "not_needed" | "pending" | "terminal";
	processedConfigurations: number;
	appliedCount: number;
	skippedCount: number;
};

export type InferenceProviderDefaultBarrierSweepFleetStatus = {
	ownerUserId: string;
	phase: "pending" | "terminal";
	stage: "account" | "bots" | "translation" | "complete";
	botCursor: string | null;
	appliedCount: number;
	skippedCount: number;
};

export type InferenceProviderDefaultBarrierSweepFleetStatusPage = {
	items: InferenceProviderDefaultBarrierSweepFleetStatus[];
	nextCursor?: string;
};

export type InferenceGraphMigrationPhase =
	| "pending"
	| "account_default"
	| "worlds"
	| "bots"
	| "translation"
	| "parity"
	| "projection"
	| "cutover"
	| "terminal"
	| "terminal_failed";

type MigrationOperation = {
	ownerUserId: string;
	phase: InferenceGraphMigrationPhase;
	revision: number;
	worldCursor: string | null;
	botCursor: string | null;
	parityStage: "account" | "worlds" | "bots" | "translation" | "complete";
	parityCursor: string | null;
	parityAccumulator: string;
	parityWorldCount: number;
	parityBotCount: number;
	migratedTranslationConfigurationId: string | null;
	auditJson: string;
	parityFingerprint: string | null;
	failureCode: string | null;
	createdAt: string;
	updatedAt: string;
	terminalAt: string | null;
	terminalCleanupAt: string | null;
};

export type InferenceGraphMigrationResult = {
	kind: "inference_graph_migration";
	ownerUserId: string;
	phase: InferenceGraphMigrationPhase;
	revision: number;
	complete: boolean;
	worldCursor: string | null;
	botCursor: string | null;
	parityStage: MigrationOperation["parityStage"];
	parityCursor: string | null;
	parityWorldCount: number;
	parityBotCount: number;
	cutoverVersion: 0 | 1 | 2;
	writerVersion: 0 | 1;
	graphRevision: number;
	parityFingerprint: string | null;
	failureCode: string | null;
	audit: InferenceGraphMigrationAudit;
};

export type InferenceGraphMigrationAudit = {
	hadCacheFriendlyCompaction: boolean;
	hadDormantCloneInference: boolean;
	hadDormantTranslationFields: boolean;
	hadLegacyTranslationModel: boolean;
	hadRecurringPromptFields: boolean;
	hadTranslationModelStrippedByAuthorization: boolean;
	hadUnrecoverableEqualityCollapsedIntent: boolean;
};

export type InferenceGraphFleetStatus = {
	ownerUserId: string;
	writerVersion: 0 | 1;
	cutoverVersion: 0 | 1 | 2;
	graphRevision: number;
	migrationPhase: InferenceGraphMigrationPhase | null;
	migrationRevision: number | null;
	parityFingerprint: string | null;
	failureCode: string | null;
	convergencePhase: "pending_d1" | "pending_kv" | "terminal" | null;
	invariants: {
		accountDefaultCount: number;
		translationSelectionCount: number;
		activeWorldCount: number;
		worldConfigurationCount: number;
		activeBotCount: number;
		botConfigurationCount: number;
	};
	ready: boolean;
};

export type InferenceGraphFleetStatusPage = {
	items: InferenceGraphFleetStatus[];
	nextCursor?: string;
};

export type InferenceGraphMigrationEnv = ProviderEnvironmentBindings & {
	BICKR_D1: D1DatabaseLike;
	BICKR_KV: KVNamespaceLike;
};

type ProviderDefaultBarrierCandidateRow = {
	configurationId: string;
	kind: "account_default" | "bot" | "custom";
	fixedRole: "translation" | null;
	botId: string | null;
	overridesJson: string;
	revision: number;
	sourceBotId: string | null;
};

const providerDefaultBarrierFields = ["reasoning", "toolCalls", "compactionMode", "promptCacheMode"] as const;
type ProviderDefaultBarrierField = typeof providerDefaultBarrierFields[number];

type ProviderDefaultBarrierSweepRow = {
	phase: "pending" | "terminal";
	stage: "account" | "bots" | "translation" | "complete";
	botCursor: string | null;
	appliedCount: number;
	skippedCount: number;
	migratedTranslationConfigurationId: string | null;
	auditJson: string;
};

/**
 * Reattributes only barriers whose migration provenance was durably seeded by
 * migration 0046. This is owner-scoped so every write remains serialized by
 * the same UserBotsCoordinator used by ordinary inference graph mutations.
 */
export async function runInferenceProviderDefaultBarrierSweepStep(
	env: Pick<InferenceGraphMigrationEnv, "BICKR_D1" | "BICKR_KV">,
	ownerUserId: string,
	now = new Date().toISOString(),
): Promise<InferenceProviderDefaultBarrierSweepResult> {
	const maintenance = await readMaintenanceState(env.BICKR_D1);
	if (!maintenance.enabled) {
		throw new RepositoryError("conflict", "Inference provider-default barrier migration requires maintenance mode.", 409);
	}
	const sweep = await env.BICKR_D1.prepare(
		`SELECT sweep.phase, sweep.stage, sweep.bot_cursor AS botCursor,
			sweep.applied_count AS appliedCount, sweep.skipped_count AS skippedCount,
			migration.migrated_translation_configuration_id AS migratedTranslationConfigurationId,
			migration.audit_json AS auditJson
		 FROM inference_provider_default_barrier_sweeps AS sweep
		 LEFT JOIN inference_graph_migration_operations AS migration
			ON migration.owner_user_id = sweep.owner_user_id AND migration.migration_version = 1
		 WHERE sweep.owner_user_id = ? LIMIT 1`,
	).bind(ownerUserId).first<ProviderDefaultBarrierSweepRow>();
	if (!sweep) {
		return { kind: "inference_provider_default_barrier_sweep", ownerUserId, phase: "not_needed", processedConfigurations: 0, appliedCount: 0, skippedCount: 0 };
	}
	if (sweep.phase === "terminal") {
		return { kind: "inference_provider_default_barrier_sweep", ownerUserId, phase: "terminal", processedConfigurations: 0, appliedCount: sweep.appliedCount, skippedCount: sweep.skippedCount };
	}
	if (typeof sweep.auditJson !== "string") {
		throw new RepositoryError("server_error", "Inference provider-default barrier migration provenance is missing.", 500);
	}
	parsedMigrationAudit(sweep.auditJson);

	const user = await requiredMigrationUser(env, ownerUserId);
	let rows: ProviderDefaultBarrierCandidateRow[] = [];
	let nextStage: ProviderDefaultBarrierSweepRow["stage"] = sweep.stage;
	let nextBotCursor = sweep.botCursor;
	switch (sweep.stage) {
		case "account": {
			const configurationId = await accountDefaultConfigurationId(ownerUserId);
			const row = await providerDefaultBarrierConfiguration(env.BICKR_D1, ownerUserId, configurationId);
			if (!row || row.kind !== "account_default") {
				throw new RepositoryError("server_error", "Migrated Account default provenance is missing.", 500);
			}
			rows = [row];
			nextStage = "bots";
			break;
		}
		case "bots": {
			rows = (await env.BICKR_D1.prepare(
				`SELECT configuration.configuration_id AS configurationId, configuration.kind,
					configuration.fixed_role AS fixedRole, configuration.bot_id AS botId,
					configuration.overrides_json AS overridesJson, configuration.revision,
					CASE WHEN clones.linked = 1 THEN clones.source_bot_id ELSE NULL END AS sourceBotId
				 FROM inference_configurations AS configuration
				 LEFT JOIN bot_clone_sources AS clones ON clones.bot_id = configuration.bot_id
				 WHERE configuration.owner_user_id = ? AND configuration.kind = 'bot'
					AND configuration.bot_id > ?
				 ORDER BY configuration.bot_id LIMIT ?`,
			).bind(ownerUserId, sweep.botCursor ?? "", inferenceProviderDefaultBarrierSweepBatchLimit)
				.all<ProviderDefaultBarrierCandidateRow>()).results ?? [];
			nextBotCursor = rows.at(-1)?.botId ?? sweep.botCursor;
			if (rows.length < inferenceProviderDefaultBarrierSweepBatchLimit) nextStage = "translation";
			break;
		}
		case "translation": {
			if (sweep.migratedTranslationConfigurationId) {
				const row = await providerDefaultBarrierConfiguration(
					env.BICKR_D1, ownerUserId, sweep.migratedTranslationConfigurationId,
				);
				// Migration v1 records the generated custom parent. The later fixed
				// Translation role inherits from it without replacing this durable ID.
				if (!row || row.kind !== "custom" || row.fixedRole !== null) {
					throw new RepositoryError("server_error", "Migrated translation configuration provenance is missing.", 500);
				}
				rows = [row];
			}
			nextStage = "complete";
			break;
		}
		case "complete":
			throw new RepositoryError("server_error", "Pending provider-default barrier sweep is already complete.", 500);
	}

	const statements: D1PreparedStatementLike[] = [];
	for (const row of rows) {
		const expected = await expectedProviderDefaultBarrierMigrationOverrides(
			env.BICKR_KV, ownerUserId, user, row,
		);
		appendProviderDefaultBarrierCandidateStatements(
			env.BICKR_D1, statements, ownerUserId, row, expected.corrected, expected.legacy,
			expected.sourceRevision, expected.fields, now,
		);
	}
	const terminal = nextStage === "complete";
	statements.push(env.BICKR_D1.prepare(
		`UPDATE inference_provider_default_barrier_sweeps
		 SET phase = ?, stage = ?, bot_cursor = ?,
			applied_count = (SELECT COUNT(*) FROM inference_provider_default_barrier_candidates WHERE owner_user_id = ? AND status = 'applied'),
			skipped_count = (SELECT COUNT(*) FROM inference_provider_default_barrier_candidates WHERE owner_user_id = ? AND status = 'skipped'),
			updated_at = ?, terminal_cleanup_at = ?
		 WHERE owner_user_id = ? AND phase = 'pending' AND stage = ?`,
	).bind(
		terminal ? "terminal" : "pending", nextStage, nextBotCursor,
		ownerUserId, ownerUserId, now, terminal ? terminalCleanupAt(now) : null,
		ownerUserId, sweep.stage,
	));
	await env.BICKR_D1.batch(statements);
	const updated = await env.BICKR_D1.prepare(
		`SELECT phase, applied_count AS appliedCount, skipped_count AS skippedCount
		 FROM inference_provider_default_barrier_sweeps WHERE owner_user_id = ? LIMIT 1`,
	).bind(ownerUserId).first<{ phase: "pending" | "terminal"; appliedCount: number; skippedCount: number }>();
	if (!updated) throw new RepositoryError("server_error", "Inference provider-default barrier sweep state disappeared.", 500);
	return {
		kind: "inference_provider_default_barrier_sweep",
		ownerUserId,
		phase: updated.phase,
		processedConfigurations: rows.length,
		appliedCount: updated.appliedCount,
		skippedCount: updated.skippedCount,
	};
}

async function providerDefaultBarrierConfiguration(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationId: string,
): Promise<ProviderDefaultBarrierCandidateRow | null> {
	return db.prepare(
		`SELECT configuration_id AS configurationId, kind, fixed_role AS fixedRole,
			bot_id AS botId, overrides_json AS overridesJson, revision, NULL AS sourceBotId
		 FROM inference_configurations
		 WHERE owner_user_id = ? AND configuration_id = ? LIMIT 1`,
	).bind(ownerUserId, configurationId).first<ProviderDefaultBarrierCandidateRow>();
}

async function expectedProviderDefaultBarrierMigrationOverrides(
	kv: KVNamespaceLike,
	ownerUserId: string,
	user: UserDocument,
	row: ProviderDefaultBarrierCandidateRow,
): Promise<{
	corrected: InferenceConfigurationOverrides;
	legacy: InferenceConfigurationOverrides;
	fields: ProviderDefaultBarrierField[];
	sourceRevision: 1 | 2;
}> {
	let corrected: InferenceConfigurationOverrides;
	let sourceRevision: 1 | 2 = 1;
	switch (row.kind) {
		case "account_default":
			corrected = inferenceOverridesForLegacySettingsMigration(user.inferenceSettings);
			break;
		case "bot": {
			if (!row.botId) throw new RepositoryError("server_error", "Migrated participant provenance is invalid.", 500);
			const bot = await readJson<BotDocument>(kv, kvKeys.bot(row.botId));
			if (!bot || bot.deletedAt || bot.ownerUserId !== ownerUserId) {
				throw new RepositoryError("conflict", "Migrated participant legacy document is unavailable.", 409);
			}
			const linked = row.sourceBotId !== null;
			corrected = inferenceOverridesForLegacyBotMigration(
				bot.inferenceSettings, user.inferenceSettings, linked,
			);
			sourceRevision = linked ? 2 : 1;
			break;
		}
		case "custom": {
			if (row.fixedRole !== null || !user.inferenceSettings?.translation?.model?.trim()) {
				throw new RepositoryError("conflict", "Migrated translation legacy document is unavailable.", 409);
			}
			corrected = inferenceOverridesFromLegacyTranslationSettings(user.inferenceSettings.translation);
			break;
		}
	}
	const legacy = legacyProviderDefaultBarrierOverrides(corrected);
	return { corrected, legacy: legacy.overrides, fields: legacy.fields, sourceRevision };
}

function legacyProviderDefaultBarrierOverrides(corrected: InferenceConfigurationOverrides): {
	overrides: InferenceConfigurationOverrides;
	fields: ProviderDefaultBarrierField[];
} {
	const overrides = { ...corrected };
	const fields = providerDefaultBarrierFields.filter((field) => {
		const override = corrected[field];
		return override?.kind === "value" && override.value.kind === "bickr_automatic";
	});
	for (const field of fields) {
		const providerDefault = { kind: "value", value: { kind: "provider_default" } } as const;
		switch (field) {
			case "reasoning": overrides.reasoning = providerDefault; break;
			case "toolCalls": overrides.toolCalls = providerDefault; break;
			case "compactionMode": overrides.compactionMode = providerDefault; break;
			case "promptCacheMode": overrides.promptCacheMode = providerDefault; break;
		}
	}
	return { overrides, fields };
}

function appendProviderDefaultBarrierCandidateStatements(
	db: D1DatabaseLike,
	statements: D1PreparedStatementLike[],
	ownerUserId: string,
	row: ProviderDefaultBarrierCandidateRow,
	corrected: InferenceConfigurationOverrides,
	legacy: InferenceConfigurationOverrides,
	sourceRevision: 1 | 2,
	fields: readonly ProviderDefaultBarrierField[],
	now: string,
	): void {
	if (fields.length === 0) return;
	const placeholders = fields.map(() => "?").join(", ");
	const current = parseStoredInferenceConfigurationOverrides(row.overridesJson);
	const proven = row.revision === sourceRevision && parityJson(current) === parityJson(legacy);
	for (const field of fields) {
		statements.push(db.prepare(
			`INSERT INTO inference_provider_default_barrier_candidates (
				owner_user_id, configuration_id, field, source_revision, status, created_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(owner_user_id, configuration_id, field) DO NOTHING`,
		).bind(
			ownerUserId, row.configurationId, field, sourceRevision,
			proven ? "pending" : "skipped", now, proven ? null : now,
		));
	}
	if (!proven) return;
	const correctedJson = JSON.stringify(corrected);
	statements.push(db.prepare(
		`UPDATE inference_configurations
		 SET overrides_json = ?, revision = revision + 1, updated_at = ?
		 WHERE owner_user_id = ? AND configuration_id = ? AND revision = ? AND overrides_json = ?
			AND (
				NOT EXISTS (
					SELECT 1 FROM inference_graph_legacy_projection_entries AS projection
					WHERE projection.owner_user_id = inference_configurations.owner_user_id
						AND projection.configuration_id = inference_configurations.configuration_id
				) OR EXISTS (
					SELECT 1 FROM inference_graph_legacy_projection_entries AS projection
					WHERE projection.owner_user_id = inference_configurations.owner_user_id
						AND projection.configuration_id = inference_configurations.configuration_id
						AND projection.configuration_revision = ? AND projection.overrides_json = ?
				)
			)`,
	).bind(
		correctedJson, now, ownerUserId, row.configurationId, sourceRevision, row.overridesJson,
		sourceRevision, row.overridesJson,
	));
	// Rollback is a revision-matched materialized view. Correct it in the same
	// D1 batch as canonical state; otherwise a later cutover_version=2 reader
	// would resurrect the manufactured barrier even though the canonical sweep
	// reported success.
	statements.push(db.prepare(
		`UPDATE inference_graph_legacy_projection_entries
		 SET overrides_json = ?, configuration_revision = configuration_revision + 1
		 WHERE owner_user_id = ? AND configuration_id = ?
			AND configuration_revision = ? AND overrides_json = ?
			AND EXISTS (
				SELECT 1 FROM inference_configurations AS configuration
				WHERE configuration.owner_user_id = inference_graph_legacy_projection_entries.owner_user_id
					AND configuration.configuration_id = inference_graph_legacy_projection_entries.configuration_id
					AND configuration.revision = ? AND configuration.overrides_json = ?
			)`,
	).bind(
		correctedJson, ownerUserId, row.configurationId, sourceRevision, row.overridesJson,
		sourceRevision + 1, correctedJson,
	));
	statements.push(db.prepare(
		`UPDATE inference_provider_default_barrier_candidates SET status = 'applied', completed_at = ?
		 WHERE owner_user_id = ? AND configuration_id = ? AND status = 'pending' AND field IN (${placeholders})
			AND EXISTS (
				SELECT 1 FROM inference_configurations AS configuration
				WHERE configuration.owner_user_id = inference_provider_default_barrier_candidates.owner_user_id
					AND configuration.configuration_id = inference_provider_default_barrier_candidates.configuration_id
					AND configuration.revision = ? AND configuration.overrides_json = ?
			)
			AND (
				NOT EXISTS (
					SELECT 1 FROM inference_graph_legacy_projection_entries AS projection
					WHERE projection.owner_user_id = inference_provider_default_barrier_candidates.owner_user_id
						AND projection.configuration_id = inference_provider_default_barrier_candidates.configuration_id
				) OR EXISTS (
					SELECT 1 FROM inference_graph_legacy_projection_entries AS projection
					WHERE projection.owner_user_id = inference_provider_default_barrier_candidates.owner_user_id
						AND projection.configuration_id = inference_provider_default_barrier_candidates.configuration_id
						AND projection.configuration_revision = ? AND projection.overrides_json = ?
				)
			)`,
	).bind(
		now, ownerUserId, row.configurationId, ...fields,
		sourceRevision + 1, correctedJson, sourceRevision + 1, correctedJson,
	));
	statements.push(db.prepare(
		`UPDATE inference_provider_default_barrier_candidates SET status = 'skipped', completed_at = ?
		 WHERE owner_user_id = ? AND configuration_id = ? AND status = 'pending' AND field IN (${placeholders})`,
	).bind(now, ownerUserId, row.configurationId, ...fields));
}

export async function runInferenceGraphMigrationStep(
	env: InferenceGraphMigrationEnv,
	ownerUserId: string,
	now = new Date().toISOString(),
): Promise<InferenceGraphMigrationResult> {
	const maintenance = await readMaintenanceState(env.BICKR_D1);
	if (!maintenance.enabled) {
		throw new RepositoryError("conflict", "Inference graph migration requires maintenance mode.", 409);
	}
	await requireActiveMigrationOwner(env.BICKR_D1, ownerUserId);
	let operation = await migrationOperation(env.BICKR_D1, ownerUserId);
	if (!operation) {
		const existingVersion = await inferenceGraphReadVersion(env.BICKR_D1, ownerUserId);
		if (existingVersion.cutoverVersion !== 0) {
			throw new RepositoryError("conflict", "Completed inference graph migration cannot be restarted after terminal cleanup.", 409);
		}
		await env.BICKR_D1.batch([
			env.BICKR_D1.prepare(
				`INSERT INTO inference_graph_users (
					owner_user_id, writer_version, cutover_version, graph_revision,
					translation_role_state_version,
					created_at, updated_at
				) VALUES (?, 0, 0, 0, 0, ?, ?)
				ON CONFLICT(owner_user_id) DO NOTHING`,
			).bind(ownerUserId, now, now),
			env.BICKR_D1.prepare(
				`INSERT INTO inference_graph_migration_operations (
					owner_user_id, migration_version, phase, revision, created_at, updated_at
				) VALUES (?, ?, 'pending', 1, ?, ?)
				ON CONFLICT(owner_user_id, migration_version) DO NOTHING`,
			).bind(ownerUserId, inferenceGraphMigrationVersion, now, now),
		]);
		operation = await requiredMigrationOperation(env.BICKR_D1, ownerUserId);
	}
	if (operation.phase === "terminal" || operation.phase === "terminal_failed") {
		return migrationResult(env.BICKR_D1, operation);
	}
	// Migration 0046 proves these rows came from a still-closed v1 operation:
	// canonical owner writes are unavailable until cutover. Normalize at most one
	// bounded batch before advancing the operation so a deployment that catches
	// migration v1 in any phase cannot compare old barriers with new parity rules.
	if (await normalizeInFlightProviderDefaultBarriers(env.BICKR_D1, ownerUserId, now) > 0) {
		return migrationResult(env.BICKR_D1, await requiredMigrationOperation(env.BICKR_D1, ownerUserId));
	}
	try {
		switch (operation.phase) {
			case "pending":
				await advanceMigrationPhase(env.BICKR_D1, ownerUserId, "pending", "account_default", now);
				break;
			case "account_default":
				await migrateAccountDefault(env, ownerUserId, now);
				break;
			case "worlds":
				await migrateWorldBatch(env, operation, now);
				break;
			case "bots":
				await migrateBotBatch(env, operation, now);
				break;
			case "translation":
				await migrateTranslation(env, ownerUserId, now);
				break;
			case "parity":
				await verifyMigrationParityBatch(env, operation, now);
				break;
			case "projection":
				await createRollbackProjection(env.BICKR_D1, ownerUserId, now);
				break;
			case "cutover":
				await commitMigrationCutover(env.BICKR_D1, ownerUserId, now);
				break;
		}
	} catch (error) {
		await recordMigrationFailure(env.BICKR_D1, ownerUserId, structuredMigrationFailureCode(error), now);
		throw error;
	}
	return migrationResult(env.BICKR_D1, await requiredMigrationOperation(env.BICKR_D1, ownerUserId));
}

async function normalizeInFlightProviderDefaultBarriers(
	db: D1DatabaseLike,
	ownerUserId: string,
	now: string,
): Promise<number> {
	const rows = (await db.prepare(
		`SELECT configuration.configuration_id AS configurationId,
			configuration.overrides_json AS overridesJson,
			configuration.revision,
			projection.configuration_id AS projectionConfigurationId,
			projection.overrides_json AS projectionOverridesJson,
			projection.configuration_revision AS projectionRevision
		 FROM inference_configurations AS configuration
			JOIN inference_graph_migration_operations AS migration
				ON migration.owner_user_id = configuration.owner_user_id AND migration.migration_version = 1
			LEFT JOIN inference_graph_legacy_projection_entries AS projection
				ON projection.owner_user_id = configuration.owner_user_id
					AND projection.configuration_id = configuration.configuration_id
			WHERE configuration.owner_user_id = ?
				AND migration.phase NOT IN ('terminal', 'terminal_failed')
				AND (
					json_extract(configuration.overrides_json, '$.reasoning.value.kind') = 'provider_default'
					OR json_extract(configuration.overrides_json, '$.toolCalls.value.kind') = 'provider_default'
					OR json_extract(configuration.overrides_json, '$.compactionMode.value.kind') = 'provider_default'
					OR json_extract(configuration.overrides_json, '$.promptCacheMode.value.kind') = 'provider_default'
				)
		 ORDER BY configuration.configuration_id LIMIT ?`,
	).bind(ownerUserId, inferenceProviderDefaultBarrierSweepBatchLimit).all<{
		configurationId: string;
		overridesJson: string;
		revision: number;
		projectionConfigurationId: string | null;
		projectionOverridesJson: string | null;
		projectionRevision: number | null;
	}>()).results ?? [];
	if (rows.length === 0) return 0;

	const statements: D1PreparedStatementLike[] = [];
	for (const row of rows) {
		if (row.projectionConfigurationId !== null && (
			row.projectionRevision !== row.revision || row.projectionOverridesJson !== row.overridesJson
		)) {
			throw new RepositoryError(
				"conflict",
				"In-flight inference graph rollback projection diverged before provider-default normalization.",
				409,
			);
		}
		const correctedJson = JSON.stringify(normalizedInFlightProviderDefaultBarrierOverrides(row.overridesJson));
		const correctedRevision = row.revision + 1;
		if (row.projectionConfigurationId !== null) {
			statements.push(db.prepare(
				`UPDATE inference_graph_legacy_projection_entries
				 SET overrides_json = ?, configuration_revision = ?
				 WHERE owner_user_id = ? AND configuration_id = ?
					AND configuration_revision = ? AND overrides_json = ?
					AND EXISTS (
						SELECT 1 FROM inference_configurations AS configuration
						WHERE configuration.owner_user_id = ? AND configuration.configuration_id = ?
							AND configuration.revision = ? AND configuration.overrides_json = ?
					)`,
			).bind(
				correctedJson, correctedRevision, ownerUserId, row.configurationId,
				row.revision, row.overridesJson,
				ownerUserId, row.configurationId, row.revision, row.overridesJson,
			));
		}
		statements.push(db.prepare(
			`UPDATE inference_configurations
			 SET overrides_json = ?, revision = ?, updated_at = ?
			 WHERE owner_user_id = ? AND configuration_id = ?
				AND revision = ? AND overrides_json = ?
				AND ${row.projectionConfigurationId === null
					? `NOT EXISTS (
						SELECT 1 FROM inference_graph_legacy_projection_entries AS projection
						WHERE projection.owner_user_id = inference_configurations.owner_user_id
							AND projection.configuration_id = inference_configurations.configuration_id
					)`
					: `EXISTS (
						SELECT 1 FROM inference_graph_legacy_projection_entries AS projection
						WHERE projection.owner_user_id = inference_configurations.owner_user_id
							AND projection.configuration_id = inference_configurations.configuration_id
							AND projection.configuration_revision = ? AND projection.overrides_json = ?
					)`}`,
		).bind(
			correctedJson, correctedRevision, now, ownerUserId, row.configurationId,
			row.revision, row.overridesJson,
			...(row.projectionConfigurationId === null ? [] : [correctedRevision, correctedJson]),
		));
	}
	// D1 executes a batch sequentially and atomically. Projection entries move
	// first under an exact old-revision/JSON CAS; canonical rows then move only
	// after observing that exact corrected projection (or confirmed absence).
	const results = await db.batch(statements);
	if (results.length !== statements.length || results.some((result) => !result.meta?.changes)) {
		throw new RepositoryError("conflict", "In-flight provider-default normalization changed concurrently.", 409);
	}
	return rows.length;
}

function normalizedInFlightProviderDefaultBarrierOverrides(value: string): InferenceConfigurationOverrides {
	const overrides = { ...parseStoredInferenceConfigurationOverrides(value) };
	for (const field of providerDefaultBarrierFields) {
		const override = overrides[field];
		if (override?.kind !== "value" || override.value.kind !== "provider_default") continue;
		const automatic = { kind: "value", value: { kind: "bickr_automatic" } } as const;
		switch (field) {
			case "reasoning": overrides.reasoning = automatic; break;
			case "toolCalls": overrides.toolCalls = automatic; break;
			case "compactionMode": overrides.compactionMode = automatic; break;
			case "promptCacheMode": overrides.promptCacheMode = automatic; break;
		}
	}
	return overrides;
}

async function migrateAccountDefault(env: InferenceGraphMigrationEnv, ownerUserId: string, now: string): Promise<void> {
	const user = await readJson<UserDocument>(env.BICKR_KV, kvKeys.user(ownerUserId));
	if (!user || user.deletedAt) throw new RepositoryError("not_found", "Active migration owner document not found.", 404);
	const configurationId = await accountDefaultConfigurationId(ownerUserId);
	const statements: D1PreparedStatementLike[] = [
		insertAccountDefaultConfigurationStatement(env.BICKR_D1, {
			configurationId,
			ownerUserId,
			now,
			overrides: inferenceOverridesForLegacySettingsMigration(user.inferenceSettings),
		}),
	];
	const secret = user.inferenceSettings?.openRouterApiKey?.trim();
	if (secret) statements.push(valueCredentialStatement(env.BICKR_D1, configurationId, ownerUserId, secret, now));
	statements.push(advanceMigrationPhaseStatement(env.BICKR_D1, ownerUserId, "account_default", "worlds", now));
	await env.BICKR_D1.batch(statements);
}

type WorldMigrationRow = { worldId: string; imageGenerationJson: string | null };

/**
 * World prompts remain KV-owned and are audited separately. Rest destructuring
 * deliberately keeps every current and future non-prompt inference field in
 * raw parity without mutating the stored or authoritative settings object.
 */
export function worldImageInferenceSettingsForRawParity(
	settings: BotImageGenerationSettings,
): Omit<BotImageGenerationSettings, "prompt"> {
	const { prompt: _prompt, ...inferenceSettings } = settings;
	return inferenceSettings;
}

function worldImageInferenceParityValue(
	settings: BotImageGenerationSettings | null | undefined,
): Omit<BotImageGenerationSettings, "prompt"> | null | undefined {
	return settings == null ? settings : worldImageInferenceSettingsForRawParity(settings);
}

async function migrateWorldBatch(env: InferenceGraphMigrationEnv, operation: MigrationOperation, now: string): Promise<void> {
	const result = await env.BICKR_D1.prepare(
		`SELECT world_id AS worldId, image_generation AS imageGenerationJson
		 FROM worlds_index
		 WHERE created_by_user_id = ? AND lifecycle_state = 'active' AND deleted_at IS NULL
			AND world_id > ?
		 ORDER BY world_id ASC LIMIT ?`,
	).bind(operation.ownerUserId, operation.worldCursor ?? "", inferenceGraphMigrationBatchLimit).all<WorldMigrationRow>();
	const rows = result.results ?? [];
	const rootId = await accountDefaultConfigurationId(operation.ownerUserId);
	const statements: D1PreparedStatementLike[] = [];
	for (const row of rows) {
		const storedImage = parsedStoredObject(row.imageGenerationJson) as BotImageGenerationSettings | undefined;
		statements.push(insertFixedConfigurationStatement(env.BICKR_D1, {
			kind: "world",
			configurationId: await worldConfigurationId(row.worldId),
			ownerUserId: operation.ownerUserId,
			parentId: rootId,
			worldId: row.worldId,
			now,
			overrides: legacyImageMigrationOverrides(storedImage, { target: "world" }),
		}));
	}
	const cursor = rows.at(-1)?.worldId ?? operation.worldCursor;
	statements.push(rows.length < inferenceGraphMigrationBatchLimit
		? advanceMigrationPhaseStatement(env.BICKR_D1, operation.ownerUserId, "worlds", "bots", now, { worldCursor: cursor })
		: updateMigrationCursorStatement(env.BICKR_D1, operation.ownerUserId, "worlds", "world_cursor", cursor, now));
	await env.BICKR_D1.batch(statements);
}

type BotMigrationRow = { botId: string; sourceBotId: string | null };

async function migrateBotBatch(env: InferenceGraphMigrationEnv, operation: MigrationOperation, now: string): Promise<void> {
	const result = await env.BICKR_D1.prepare(
		`SELECT bots.bot_id AS botId,
			CASE WHEN clones.linked = 1 THEN clones.source_bot_id ELSE NULL END AS sourceBotId
		 FROM bots_index AS bots
		 LEFT JOIN bot_clone_sources AS clones ON clones.bot_id = bots.bot_id
		 WHERE bots.owner_user_id = ? AND bots.lifecycle_state = 'active' AND bots.deleted_at IS NULL
			AND bots.bot_id > ?
		 ORDER BY bots.bot_id ASC LIMIT ?`,
	).bind(operation.ownerUserId, operation.botCursor ?? "", inferenceGraphMigrationBatchLimit).all<BotMigrationRow>();
	const rows = result.results ?? [];
	const documents = await Promise.all(rows.map((row) => readJson<BotDocument>(env.BICKR_KV, kvKeys.bot(row.botId))));
	const user = await requiredMigrationUser(env, operation.ownerUserId);
	const rootId = await accountDefaultConfigurationId(operation.ownerUserId);
	const statements: D1PreparedStatementLike[] = [];
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index]!;
		const bot = documents[index];
		if (!bot || bot.deletedAt || bot.ownerUserId !== operation.ownerUserId) {
			throw new RepositoryError("conflict", "Bot migration projection does not match its active document.", 409);
		}
		const configurationId = await botConfigurationId(row.botId);
		statements.push(insertFixedConfigurationStatement(env.BICKR_D1, {
			kind: "bot",
			configurationId,
			ownerUserId: operation.ownerUserId,
			// Source rows are not guaranteed to sort before clones. Insert every
			// fixed row against the already-present root, then perform one set-based
			// linked-clone reparent after the final batch has inserted all sources.
			parentId: rootId,
			botId: row.botId,
			now,
			overrides: inferenceOverridesForLegacyBotMigration(
				bot.inferenceSettings,
				user.inferenceSettings,
				Boolean(row.sourceBotId),
			),
		}));
		const credential = legacyBotMigrationCredential(
			bot.inferenceSettings,
			Boolean(row.sourceBotId),
		);
		if (credential.mode === "value") {
			statements.push(valueCredentialStatement(
				env.BICKR_D1, configurationId, operation.ownerUserId, credential.secret, now,
			));
		} else if (credential.mode === "account_default") {
			statements.push(accountDefaultCredentialStatement(env.BICKR_D1, configurationId, operation.ownerUserId, now));
		}
	}
	const cursor = rows.at(-1)?.botId ?? operation.botCursor;
	if (rows.length < inferenceGraphMigrationBatchLimit) {
		statements.push(env.BICKR_D1.prepare(
			`UPDATE inference_configurations AS clone_configuration
			 SET parent_id = (
				SELECT source_configuration.configuration_id
				FROM bot_clone_sources AS clones
				JOIN inference_configurations AS source_configuration
					ON source_configuration.bot_id = clones.source_bot_id
					AND source_configuration.owner_user_id = clone_configuration.owner_user_id
				WHERE clones.bot_id = clone_configuration.bot_id AND clones.linked = 1
			 ), revision = revision + 1, updated_at = ?
			 WHERE clone_configuration.owner_user_id = ? AND clone_configuration.kind = 'bot'
				AND EXISTS (
					SELECT 1 FROM bot_clone_sources AS clones
					WHERE clones.bot_id = clone_configuration.bot_id AND clones.linked = 1
				)`,
		).bind(now, operation.ownerUserId));
		statements.push(advanceMigrationPhaseStatement(env.BICKR_D1, operation.ownerUserId, "bots", "translation", now, { botCursor: cursor }));
	} else {
		statements.push(updateMigrationCursorStatement(env.BICKR_D1, operation.ownerUserId, "bots", "bot_cursor", cursor, now));
	}
	await env.BICKR_D1.batch(statements);
}

type LegacyBotMigrationCredential =
	| { mode: "inherit" }
	| { mode: "account_default" }
	| { mode: "value"; secret: string };

/**
 * Legacy provider settings were model-gated whole bundles for every bot. Once a
 * bot supplied a model, missing provider fields stopped inheriting from the
 * profile. A linked clone adds one more distinction: without a local model its
 * entire local bundle was dormant, while with a local model its fallbacks came
 * from the owner rather than its source. The graph retains the source parent
 * edge, so that second case also materializes owner-level provider fallbacks.
 *
 * Image settings had their own whole-object selection and were not model-gated.
 * Keep that decision separate so an ordinary bot with no image object can still
 * inherit Account default and a linked local-model clone cannot inherit image
 * fields from its source. Whole-object barriers store target_default or
 * explicit_none intent; they never store participant/world-expanded values.
 */
function inferenceOverridesForLegacyBotMigration(
	settings: BotInferenceSettings,
	ownerSettings: BotInferenceSettings | undefined,
	linkedClone: boolean,
): InferenceConfigurationOverrides {
	if (linkedClone && !settings.model?.trim()) return {};
	if (!settings.model?.trim()) return inferenceOverridesForLegacySettingsMigration(settings);

	const overrides = inferenceOverridesFromLegacySettings(settings);
	if (linkedClone) {
		// Legacy fell back to the owner profile, never the source bot, once the
		// clone had its own model. Storing the resolved Account/deployment URL as
		// an owner value would re-attribute a hidden deployment default and then
		// suppress its credential, so the barrier is the typed resume state.
		const localBaseUrl = settings.baseUrl?.trim();
		overrides.baseUrl = localBaseUrl ? { kind: "value", value: localBaseUrl } : { kind: "account_default" };
	}

	// These requests reproduce the raw input that the capability layer received
	// after legacy model gating. They must not be replaced with capability output.
	overrides.reasoning ??= { kind: "value", value: { kind: "bickr_automatic" } };
	overrides.toolCalls ??= { kind: "value", value: { kind: "bickr_automatic" } };
	overrides.compactionMode ??= { kind: "value", value: { kind: "bickr_automatic" } };
	overrides.promptCacheMode ??= { kind: "value", value: { kind: "bickr_automatic" } };
	overrides.providerRouting ??= { kind: "explicit_none" };
	// The local-model explicit-none prefill barrier is deliberately retained for
	// legacy parity: missing prefill was Off inside the whole provider bundle,
	// while inheritance could turn it On from Account or a linked source.
	overrides.supportsPrefill ??= { kind: "explicit_none" };
	overrides.temperature ??= { kind: "value", value: defaultTextGenerationTemperature };
	for (const field of [
		"topK", "topP", "minP", "frequencyPenalty", "presencePenalty", "repetitionPenalty",
	] as const) {
		overrides[field] ??= { kind: "explicit_none" };
	}

	if (linkedClone) {
		Object.assign(overrides, legacyImageMigrationOverrides(
			settings.imageGeneration ?? ownerSettings?.imageGeneration,
			{ target: "participant", materializeWholeObject: true },
		));
	} else if (settings.imageGeneration) {
		Object.assign(overrides, legacyImageMigrationOverrides(settings.imageGeneration, { target: "participant" }));
	}
	return overrides;
}

function inferenceOverridesForLegacySettingsMigration(
	settings: BotInferenceSettings | undefined,
): InferenceConfigurationOverrides {
	const overrides = inferenceOverridesFromLegacySettings(settings);
	if (settings?.imageGeneration) {
		Object.assign(overrides, legacyImageMigrationOverrides(settings.imageGeneration, { target: "participant" }));
	}
	return overrides;
}

function legacyImageMigrationOverrides(
	settings: BotImageGenerationSettings | undefined,
	options: { target: AvatarInferenceTarget; materializeWholeObject?: boolean },
): InferenceConfigurationOverrides {
	if (!settings && !options.materializeWholeObject) return {};
	const overrides = inferenceOverridesFromLegacyImageSettings(settings);
	const targetDefaults = options.target === "world"
		? defaultWorldAvatarImageGenerationSettings
		: defaultAvatarImageGenerationSettings;
	// The legacy document did not distinguish a stored copy of Bickr's model
	// default from selecting that model independently. Preserve its effective
	// provenance: the deployment credential may authorize Bickr's default, while
	// genuinely owner-selected models still require an owner provider.
	if (settings?.model?.trim() === targetDefaults.model) {
		overrides.imageModel = { kind: "target_default" };
	} else if (isHistoricalBickrDefaultImageModel(settings?.model)) {
		// Preserve the exact former default and its Bickr provenance. This is an
		// internal migration state: ordinary owner input can store the same string
		// only as a normal value and therefore cannot manufacture authorization.
		overrides.imageModel = { kind: "historical_bickr_default", value: settings.model };
	}
	for (const field of ["imageModel", "imageAspectRatio", "imageSize"] as const) {
		overrides[field] ??= { kind: "target_default" };
	}
	for (const field of [
		"imageProviderRouting", "imageTemperature", "imageTopK", "imageTopP", "imageMinP",
		"imageFrequencyPenalty", "imagePresencePenalty", "imageRepetitionPenalty",
	] as const) {
		overrides[field] ??= { kind: "explicit_none" };
	}
	return overrides;
}

function legacyBotMigrationCredential(
	settings: BotInferenceSettings,
	linkedClone: boolean,
): LegacyBotMigrationCredential {
	// Dormancy is decided before the local key, because a linked clone without a
	// local model read its source's whole bundle and never consulted its own key.
	// Storing that key would bypass the source credential, and provider parity
	// cannot catch it: the envelope compares only credential availability, which
	// both sides satisfy.
	if (linkedClone && !settings.model?.trim()) return { mode: "inherit" };
	const ownSecret = settings.openRouterApiKey?.trim();
	if (ownSecret) return { mode: "value", secret: ownSecret };
	if (!linkedClone) return { mode: "inherit" };
	// Legacy local-model clones skipped their source's credential fallback. The
	// typed jump preserves that behavior without copying an account/deployment key.
	return { mode: "account_default" };
}

async function migrateTranslation(env: InferenceGraphMigrationEnv, ownerUserId: string, now: string): Promise<void> {
	const user = await readJson<UserDocument>(env.BICKR_KV, kvKeys.user(ownerUserId));
	if (!user || user.deletedAt) throw new RepositoryError("not_found", "Active migration owner document not found.", 404);
	const rootId = await accountDefaultConfigurationId(ownerUserId);
	const translation = user.inferenceSettings?.translation;
	let selectedId = rootId;
	let selectedKind: "account_default" | "custom" = "account_default";
	const statements: D1PreparedStatementLike[] = [];
	if (translation?.model?.trim()) {
		selectedId = await deterministicTranslationConfigurationId(ownerUserId);
		selectedKind = "custom";
		const name = await collisionSafeTranslationName(env.BICKR_D1, ownerUserId, selectedId);
		const normalizedName = name.normalize("NFKC").trim();
		statements.push(env.BICKR_D1.prepare(
			`INSERT INTO inference_configurations (
				configuration_id, owner_user_id, kind, parent_id, custom_name,
				custom_name_key, overrides_json, revision, created_at, updated_at
			) VALUES (?, ?, 'custom', ?, ?, ?, ?, 1, ?, ?)`,
		).bind(
			selectedId,
			ownerUserId,
			rootId,
			normalizedName,
			normalizedName.toLocaleLowerCase("en-US"),
			JSON.stringify(inferenceOverridesFromLegacyTranslationSettings(translation)),
			now,
			now,
		));
		statements.push(env.BICKR_D1.prepare(
			`UPDATE inference_graph_users SET compatibility_translation_configuration_id = ?, updated_at = ?
			 WHERE owner_user_id = ?`,
		).bind(selectedId, now, ownerUserId));
	}
	const audit = migrationAudit(user.inferenceSettings);
	statements.push(env.BICKR_D1.prepare(
		`INSERT INTO inference_translation_selections (
			owner_user_id, configuration_id, selected_kind, revision, created_at, updated_at
		) VALUES (?, ?, ?, 1, ?, ?)`,
	).bind(ownerUserId, selectedId, selectedKind, now, now));
	statements.push(env.BICKR_D1.prepare(
		`UPDATE inference_graph_migration_operations
		 SET phase = 'parity', revision = revision + 1,
			migrated_translation_configuration_id = ?, audit_json = ?, updated_at = ?
		 WHERE owner_user_id = ? AND migration_version = ? AND phase = 'translation'`,
	).bind(selectedKind === "custom" ? selectedId : null, JSON.stringify(audit), now, ownerUserId, inferenceGraphMigrationVersion));
	await env.BICKR_D1.batch(statements);
}

async function verifyMigrationParityBatch(
	env: InferenceGraphMigrationEnv,
	operation: MigrationOperation,
	now: string,
): Promise<void> {
	switch (operation.parityStage) {
		case "account": return verifyAccountParity(env, operation, now);
		case "worlds": return verifyWorldParityBatch(env, operation, now);
		case "bots": return verifyBotParityBatch(env, operation, now);
		case "translation": return verifyTranslationParity(env, operation, now);
		case "complete":
			throw new RepositoryError("server_error", "Completed inference parity did not advance migration phase.", 500);
	}
}

async function verifyAccountParity(env: InferenceGraphMigrationEnv, operation: MigrationOperation, now: string): Promise<void> {
	const user = await requiredMigrationUser(env, operation.ownerUserId);
	const rootId = await accountDefaultConfigurationId(operation.ownerUserId);
	const snapshot = await loadInternalInferenceConfigurationAncestors(env.BICKR_D1, operation.ownerUserId, [rootId]);
	const root = snapshot.find((node) => node.id === rootId);
	if (!root || root.kind !== "account_default") migrationParityFailure();
	assertSameOverrides(root, inferenceOverridesForLegacySettingsMigration(user.inferenceSettings));
	assertCredentialParity(root, user.inferenceSettings?.openRouterApiKey);
	const defaults = await bickrInferenceDefaultsFromEnvironment(env);
	const resolution = resolveInferenceConfiguration(inferenceConfigurationPathFromSnapshot(root, snapshot), { defaults });
	const legacy = resolveBotProviderSettings({ inferenceSettings: {} }, user, providerEnvironmentSettingsFromBindings(env)).settings;
	const canonical = providerSettingsFromResolution(resolution);
	assertProviderParity(legacy, canonical);
	const legacyImage = legacyImageEnvelope(user.inferenceSettings?.imageGeneration, legacy, "participant");
	const canonicalImage = canonicalImageEnvelope(resolution, canonical, "participant");
	assertParityEqual(legacyImage, canonicalImage);
	await updateParityProgress(env.BICKR_D1, operation, {
		stage: "worlds",
		cursor: null,
		accumulator: await extendParityAccumulator(operation.parityAccumulator, "account", [{
			id: rootId,
			provider: providerParityEnvelope(canonical),
			image: canonicalImage,
		}]),
		now,
	});
}

async function verifyWorldParityBatch(env: InferenceGraphMigrationEnv, operation: MigrationOperation, now: string): Promise<void> {
	const result = await env.BICKR_D1.prepare(
		`SELECT world_id AS worldId, image_generation AS imageGenerationJson
		 FROM worlds_index
		 WHERE created_by_user_id = ? AND lifecycle_state = 'active' AND deleted_at IS NULL AND world_id > ?
		 ORDER BY world_id ASC LIMIT ?`,
	).bind(operation.ownerUserId, operation.parityCursor ?? "", inferenceGraphMigrationBatchLimit).all<WorldMigrationRow>();
	const rows = result.results ?? [];
	const ids = await Promise.all(rows.map((row) => worldConfigurationId(row.worldId)));
	const snapshot = await loadInternalInferenceConfigurationAncestors(env.BICKR_D1, operation.ownerUserId, ids);
	const byId = new Map(snapshot.map((node) => [node.id, node]));
	const rootId = await accountDefaultConfigurationId(operation.ownerUserId);
	const user = await requiredMigrationUser(env, operation.ownerUserId);
	const documents = await Promise.all(rows.map((row) => readJson<WorldDocument>(env.BICKR_KV, kvKeys.world(row.worldId))));
	const defaults = await bickrInferenceDefaultsFromEnvironment(env);
	const accountProvider = resolveBotProviderSettings(
		{ inferenceSettings: {} }, user, providerEnvironmentSettingsFromBindings(env),
	).settings;
	const records: unknown[] = [];
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index]!;
		const world = documents[index];
		const node = byId.get(ids[index]!);
		if (!world || world.deletedAt || world.createdByUserId !== operation.ownerUserId ||
			!node || node.kind !== "world" || node.worldId !== row.worldId || node.parentId !== rootId) migrationParityFailure();
		const storedImage = parsedStoredObject(row.imageGenerationJson);
		assertSameOverrides(node, legacyImageMigrationOverrides(
			storedImage as BotImageGenerationSettings | undefined,
			{ target: "world" },
		));
		assertCredentialParity(node, undefined);
		if (parityJson(worldImageInferenceParityValue(storedImage as BotImageGenerationSettings | undefined)) !==
			parityJson(worldImageInferenceParityValue(world.imageGeneration))) migrationParityFailure();
		const resolution = resolveInferenceConfiguration(inferenceConfigurationPathFromSnapshot(node, snapshot), { defaults });
		const canonicalProvider = providerSettingsFromResolution(resolution);
		const legacyImage = legacyImageEnvelope(
			world.imageGeneration ?? user.inferenceSettings?.imageGeneration,
			accountProvider,
			"world",
		);
		const canonicalImage = canonicalImageEnvelope(resolution, canonicalProvider, "world");
		assertParityEqual(legacyImage, canonicalImage);
		records.push({ id: row.worldId, image: canonicalImage, prompt: await sha256Hex(parityJson(world.imageGeneration?.prompt ?? null)) });
	}
	await updateParityProgress(env.BICKR_D1, operation, {
		stage: rows.length < inferenceGraphMigrationBatchLimit ? "bots" : "worlds",
		cursor: rows.length < inferenceGraphMigrationBatchLimit ? null : rows.at(-1)!.worldId,
		accumulator: await extendParityAccumulator(operation.parityAccumulator, "worlds", records),
		worldCount: operation.parityWorldCount + rows.length,
		now,
	});
}

type LegacyCloneInferenceSnapshot = {
	documents: Map<string, BotDocument>;
	sourceByBotId: Map<string, string>;
};

async function loadLegacyCloneInferenceSnapshot(
	env: InferenceGraphMigrationEnv,
	ownerUserId: string,
	seedBotIds: readonly string[],
): Promise<LegacyCloneInferenceSnapshot> {
	const result = await env.BICKR_D1.prepare(
		`WITH RECURSIVE clone_path(seed_bot_id, bot_id, depth, visited) AS (
			SELECT CAST(value AS TEXT), CAST(value AS TEXT), 0, '|' || CAST(value AS TEXT) || '|'
			FROM json_each(?)
			UNION ALL
			SELECT path.seed_bot_id, clones.source_bot_id, path.depth + 1,
				path.visited || clones.source_bot_id || '|'
			FROM clone_path AS path
			JOIN bot_clone_sources AS clones ON clones.bot_id = path.bot_id AND clones.linked = 1
			JOIN bots_index AS source ON source.bot_id = clones.source_bot_id
				AND source.owner_user_id = ? AND source.lifecycle_state = 'active' AND source.deleted_at IS NULL
			WHERE path.depth < 17 AND instr(path.visited, '|' || clones.source_bot_id || '|') = 0
		)
		SELECT path.bot_id AS botId,
			CASE WHEN clones.linked = 1 THEN clones.source_bot_id ELSE NULL END AS sourceBotId,
			MAX(path.depth) AS depth
		FROM clone_path AS path
		LEFT JOIN bot_clone_sources AS clones ON clones.bot_id = path.bot_id
		GROUP BY path.bot_id, sourceBotId
		ORDER BY path.bot_id
		LIMIT ?`,
	).bind(JSON.stringify(seedBotIds), ownerUserId, inferenceConfigurationCorruptionSentinel).all<{
		botId: string;
		sourceBotId: string | null;
		depth: number;
	}>();
	const rows = result.results ?? [];
	if (rows.length >= inferenceConfigurationCorruptionSentinel || rows.some((row) => row.depth > 16)) {
		throw new RepositoryError("conflict", "Legacy clone inference path is too deep or corrupt.", 409);
	}
	const loaded = await Promise.all(rows.map(async (row) => ({
		row,
		document: await readJson<BotDocument>(env.BICKR_KV, kvKeys.bot(row.botId)),
	})));
	const documents = new Map<string, BotDocument>();
	const sourceByBotId = new Map<string, string>();
	for (const { row, document } of loaded) {
		if (!document || document.deletedAt || document.ownerUserId !== ownerUserId) migrationParityFailure();
		documents.set(row.botId, document);
		if (row.sourceBotId) sourceByBotId.set(row.botId, row.sourceBotId);
	}
	for (const seedBotId of seedBotIds) {
		if (!documents.has(seedBotId)) migrationParityFailure();
	}
	return { documents, sourceByBotId };
}

function effectiveLegacyCloneInferenceSettings(
	botId: string,
	snapshot: LegacyCloneInferenceSnapshot,
	visiting = new Set<string>(),
	depth = 0,
): BotInferenceSettings {
	if (depth > 16) migrationParityFailure();
	if (visiting.has(botId)) migrationParityFailure();
	const bot = snapshot.documents.get(botId);
	if (!bot) migrationParityFailure();
	const sourceBotId = snapshot.sourceByBotId.get(botId);
	if (!sourceBotId || bot.inferenceSettings.model?.trim()) return bot.inferenceSettings;
	visiting.add(botId);
	try {
		return effectiveLegacyCloneInferenceSettings(sourceBotId, snapshot, visiting, depth + 1);
	} finally {
		visiting.delete(botId);
	}
}

async function verifyBotParityBatch(env: InferenceGraphMigrationEnv, operation: MigrationOperation, now: string): Promise<void> {
	const result = await env.BICKR_D1.prepare(
		`SELECT bots.bot_id AS botId,
			CASE WHEN clones.linked = 1 THEN clones.source_bot_id ELSE NULL END AS sourceBotId
		 FROM bots_index AS bots
		 LEFT JOIN bot_clone_sources AS clones ON clones.bot_id = bots.bot_id
		 WHERE bots.owner_user_id = ? AND bots.lifecycle_state = 'active' AND bots.deleted_at IS NULL AND bots.bot_id > ?
		 ORDER BY bots.bot_id ASC LIMIT ?`,
	).bind(operation.ownerUserId, operation.parityCursor ?? "", inferenceGraphMigrationBatchLimit).all<BotMigrationRow>();
	const rows = result.results ?? [];
	const ids = await Promise.all(rows.map((row) => botConfigurationId(row.botId)));
	const snapshot = await loadInternalInferenceConfigurationAncestors(env.BICKR_D1, operation.ownerUserId, ids);
	const byId = new Map(snapshot.map((node) => [node.id, node]));
	const rootId = await accountDefaultConfigurationId(operation.ownerUserId);
	const user = await requiredMigrationUser(env, operation.ownerUserId);
	const legacyClones = await loadLegacyCloneInferenceSnapshot(env, operation.ownerUserId, rows.map((row) => row.botId));
	const defaults = await bickrInferenceDefaultsFromEnvironment(env);
	const environment = providerEnvironmentSettingsFromBindings(env);
	const records: unknown[] = [];
	let dormantClone = false;
	let equalityCollapsed = false;
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index]!;
		const bot = legacyClones.documents.get(row.botId);
		const node = byId.get(ids[index]!);
		const expectedParentId = row.sourceBotId ? await botConfigurationId(row.sourceBotId) : rootId;
		if (!bot || bot.deletedAt || bot.ownerUserId !== operation.ownerUserId ||
			!node || node.kind !== "bot" || node.botId !== row.botId || node.parentId !== expectedParentId) migrationParityFailure();
		const expectedOverrides = inferenceOverridesForLegacyBotMigration(
			bot.inferenceSettings,
			user.inferenceSettings,
			Boolean(row.sourceBotId),
		);
		assertSameOverrides(node, expectedOverrides);
		assertMigrationCredentialParity(node, legacyBotMigrationCredential(
			bot.inferenceSettings,
			Boolean(row.sourceBotId),
		));
		const effectiveLegacySettings = effectiveLegacyCloneInferenceSettings(row.botId, legacyClones);
		const legacy = resolveBotProviderSettings({ inferenceSettings: effectiveLegacySettings }, user, environment).settings;
		const resolution = resolveInferenceConfiguration(inferenceConfigurationPathFromSnapshot(node, snapshot), { defaults });
		const canonical = providerSettingsFromResolution(resolution);
		assertProviderParity(legacy, canonical);
		const legacyImage = legacyImageEnvelope(
			effectiveLegacySettings.imageGeneration ?? user.inferenceSettings?.imageGeneration,
			legacy,
			"participant",
		);
		const canonicalImage = canonicalImageEnvelope(resolution, canonical, "participant");
		if (parityJson(legacyImage) !== parityJson(canonicalImage)) {
			throw new RepositoryError("conflict", `Inference graph image parity failed for participant ${row.botId}.`, 409);
		}
		dormantClone ||= Boolean(
			row.sourceBotId && !bot.inferenceSettings.model?.trim() &&
			Object.keys(inferenceOverridesFromLegacySettings(bot.inferenceSettings)).length > 0,
		);
		equalityCollapsed ||= legacyCouldContainCollapsedEquality(bot.inferenceSettings, user.inferenceSettings);
		records.push({
			id: row.botId,
			provider: providerParityEnvelope(canonical),
			image: canonicalImage,
			...(row.sourceBotId ? { retiredLinkedCloneSource: row.sourceBotId } : {}),
		});
	}
	await updateParityProgress(env.BICKR_D1, operation, {
		stage: rows.length < inferenceGraphMigrationBatchLimit ? "translation" : "bots",
		cursor: rows.length < inferenceGraphMigrationBatchLimit ? null : rows.at(-1)!.botId,
		accumulator: await extendParityAccumulator(operation.parityAccumulator, "bots", records),
		botCount: operation.parityBotCount + rows.length,
		audit: { dormantClone, equalityCollapsed },
		now,
	});
}

async function verifyTranslationParity(env: InferenceGraphMigrationEnv, operation: MigrationOperation, now: string): Promise<void> {
	const user = await requiredMigrationUser(env, operation.ownerUserId);
	const rootId = await accountDefaultConfigurationId(operation.ownerUserId);
	const selection = await env.BICKR_D1.prepare(
		`SELECT configuration_id AS configurationId, selected_kind AS selectedKind
		 FROM inference_translation_selections WHERE owner_user_id = ? LIMIT 1`,
	).bind(operation.ownerUserId).first<{ configurationId: string; selectedKind: "account_default" | "custom" }>();
	if (!selection) migrationParityFailure();
	const snapshot = await loadInternalInferenceConfigurationAncestors(
		env.BICKR_D1, operation.ownerUserId, [selection.configurationId],
	);
	const selected = snapshot.find((node) => node.id === selection.configurationId);
	if (!selected) migrationParityFailure();
	const translation = user.inferenceSettings?.translation;
	if (translation?.model?.trim()) {
		if (selection.selectedKind !== "custom" || selected.kind !== "custom" || selected.parentId !== rootId) migrationParityFailure();
		assertSameOverrides(selected, inferenceOverridesFromLegacyTranslationSettings(translation));
	} else if (selection.selectedKind !== "account_default" || selection.configurationId !== rootId) {
		migrationParityFailure();
	}
	const resolution = resolveInferenceConfiguration(
		inferenceConfigurationPathFromSnapshot(selected, snapshot),
		{ defaults: await bickrInferenceDefaultsFromEnvironment(env) },
	);
	const canonical = providerSettingsFromResolution(resolution);
	const legacy = resolveLegacyTranslationProviderSettings(user, providerEnvironmentSettingsFromBindings(env));
	if (legacy) assertParityEqual(translationParityEnvelope(legacy), translationParityEnvelope(canonical));
	const invariants = await migrationInvariantCounts(env.BICKR_D1, operation.ownerUserId);
	if (invariants.graphCount >= inferenceConfigurationCorruptionSentinel ||
		invariants.graphCount !== invariants.reachableCount ||
		invariants.worldCount !== invariants.graphWorldCount || invariants.worldCount !== operation.parityWorldCount ||
		invariants.botCount !== invariants.graphBotCount || invariants.botCount !== operation.parityBotCount ||
		invariants.translationCount !== 1 || invariants.credentialCount !== invariants.graphCount) {
		throw new RepositoryError("conflict", "Inference graph invariant or count parity failed.", 409);
	}
	const parityFingerprint = await extendParityAccumulator(operation.parityAccumulator, "translation", [{
		selection,
		provider: legacy ? translationParityEnvelope(canonical) : null,
		enabled: translation?.enabled === true,
		prompt: await sha256Hex(parityJson(translation?.prompt ?? null)),
		invariants,
	}]);
	await env.BICKR_D1.prepare(
		`UPDATE inference_graph_migration_operations
		 SET phase = 'projection', parity_stage = 'complete', revision = revision + 1,
			parity_accumulator = ?, parity_fingerprint = ?, failure_code = NULL, updated_at = ?
		 WHERE owner_user_id = ? AND migration_version = ? AND phase = 'parity' AND parity_stage = 'translation'`,
	).bind(parityFingerprint, parityFingerprint, now, operation.ownerUserId, inferenceGraphMigrationVersion).run();
}

async function requiredMigrationUser(
	env: Pick<InferenceGraphMigrationEnv, "BICKR_KV">,
	ownerUserId: string,
): Promise<UserDocument> {
	const user = await readJson<UserDocument>(env.BICKR_KV, kvKeys.user(ownerUserId));
	if (!user || user.deletedAt) throw new RepositoryError("not_found", "Active migration owner document not found.", 404);
	return user;
}

async function extendParityAccumulator(previous: string, stage: string, records: readonly unknown[]): Promise<string> {
	return sha256Hex(parityJson({ version: 1, previous, stage, records }));
}

async function updateParityProgress(
	db: D1DatabaseLike,
	operation: MigrationOperation,
	input: {
		stage: MigrationOperation["parityStage"];
		cursor: string | null;
		accumulator: string;
		worldCount?: number;
		botCount?: number;
		audit?: { dormantClone: boolean; equalityCollapsed: boolean };
		now: string;
	},
): Promise<void> {
	const audit = parsedMigrationAudit(operation.auditJson);
	const nextAudit: InferenceGraphMigrationAudit = {
		...audit,
		hadDormantCloneInference: audit.hadDormantCloneInference || input.audit?.dormantClone === true,
		hadUnrecoverableEqualityCollapsedIntent:
			audit.hadUnrecoverableEqualityCollapsedIntent || input.audit?.equalityCollapsed === true,
	};
	const result = await db.prepare(
		`UPDATE inference_graph_migration_operations
		 SET parity_stage = ?, parity_cursor = ?, parity_accumulator = ?,
			parity_world_count = ?, parity_bot_count = ?, audit_json = ?,
			revision = revision + 1, failure_code = NULL, updated_at = ?
		 WHERE owner_user_id = ? AND migration_version = ? AND phase = 'parity'
			AND parity_stage = ? AND revision = ?`,
	).bind(
		input.stage,
		input.cursor,
		input.accumulator,
		input.worldCount ?? operation.parityWorldCount,
		input.botCount ?? operation.parityBotCount,
		JSON.stringify(nextAudit),
		input.now,
		operation.ownerUserId,
		inferenceGraphMigrationVersion,
		operation.parityStage,
		operation.revision,
	).run();
	if (!result.meta?.changes) {
		throw new RepositoryError("conflict", "Inference graph parity progress changed concurrently.", 409);
	}
}

function providerParityEnvelope(settings: ProviderSettings): Record<string, unknown> {
	return {
		credentialAvailable: Boolean(settings.apiKey),
		baseUrl: settings.baseUrl,
		model: settings.model,
		providerRouting: settings.providerRouting ?? null,
		reasoningEffort: settings.reasoningEffort ?? null,
		toolCalls: settings.toolCalls ?? null,
		compactionMode: settings.compactionMode ?? null,
		promptCacheMode: settings.promptCacheMode ?? "off",
		supportsPrefill: settings.supportsPrefill ?? false,
		temperature: settings.temperature,
		topK: settings.topK ?? null,
		topP: settings.topP ?? null,
		minP: settings.minP ?? null,
		frequencyPenalty: settings.frequencyPenalty ?? null,
		presencePenalty: settings.presencePenalty ?? null,
		repetitionPenalty: settings.repetitionPenalty ?? null,
	};
}

function translationParityEnvelope(settings: ProviderSettings): Record<string, unknown> {
	return {
		credentialAvailable: Boolean(settings.apiKey),
		baseUrl: settings.baseUrl,
		model: settings.model,
		providerRouting: settings.providerRouting ?? null,
		reasoningEffort: settings.reasoningEffort ?? null,
		toolCalls: translationToolCallStrategy(settings.toolCalls),
		temperature: settings.temperature,
		topK: settings.topK ?? null,
		topP: settings.topP ?? null,
		minP: settings.minP ?? null,
		frequencyPenalty: settings.frequencyPenalty ?? null,
		presencePenalty: settings.presencePenalty ?? null,
		repetitionPenalty: settings.repetitionPenalty ?? null,
	};
}

function canonicalImageEnvelope(
	resolution: InferenceResolution,
	providerSettings: ProviderSettings,
	target: AvatarInferenceTarget,
): Record<string, unknown> | null {
	const settings = canonicalAvatarImageSettings({
		consumer: target === "world" ? "world" : "account",
		resolution,
		providerSettings,
		fingerprint: "parity-only",
	}, target);
	return settings ? redactedImageEnvelope(settings) : null;
}

function legacyImageEnvelope(
	settings: BotImageGenerationSettings | undefined,
	providerSettings: ProviderSettings,
	target: AvatarInferenceTarget,
): Record<string, unknown> {
	const effective = target === "world"
		? worldAvatarImageGenerationSettingsWithDefaults(settings)
		: avatarImageGenerationSettingsWithDefaults(settings);
	if (!effective.model) migrationParityFailure();
	return redactedImageEnvelope({
		...effective,
		model: effective.model,
		baseUrl: providerSettings.baseUrl,
		...(providerSettings.apiKey ? { apiKey: providerSettings.apiKey } : {}),
		...(effective.providerRouting && isOpenRouterProviderBaseUrl(providerSettings.baseUrl)
			? { providerRouting: effective.providerRouting }
			: {}),
	});
}

function redactedImageEnvelope(settings: {
	apiKey?: string;
	baseUrl: string;
	model: string;
	providerRouting?: unknown;
	aspectRatio?: string;
	imageSize?: string;
	temperature?: number;
	topK?: number;
	topP?: number;
	minP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
}): Record<string, unknown> {
	return {
		credentialAvailable: Boolean(settings.apiKey),
		baseUrl: settings.baseUrl,
		model: settings.model,
		providerRouting: settings.providerRouting ?? null,
		aspectRatio: settings.aspectRatio ?? null,
		imageSize: settings.imageSize ?? null,
		temperature: settings.temperature ?? null,
		topK: settings.topK ?? null,
		topP: settings.topP ?? null,
		minP: settings.minP ?? null,
		frequencyPenalty: settings.frequencyPenalty ?? null,
		presencePenalty: settings.presencePenalty ?? null,
		repetitionPenalty: settings.repetitionPenalty ?? null,
	};
}

function assertParityEqual(legacy: unknown, canonical: unknown): void {
	if (parityJson(legacy) !== parityJson(canonical)) migrationParityFailure();
}

function legacyCouldContainCollapsedEquality(
	bot: BotInferenceSettings,
	owner: BotInferenceSettings | undefined,
): boolean {
	if (!owner) return false;
	const botOverrides = inferenceOverridesFromLegacySettings(bot);
	const ownerOverrides = inferenceOverridesFromLegacySettings(owner);
	return Object.keys(ownerOverrides).some((field) => !(field in botOverrides));
}

async function migrationInvariantCounts(db: D1DatabaseLike, ownerUserId: string): Promise<{
	graphCount: number;
	reachableCount: number;
	worldCount: number;
	graphWorldCount: number;
	botCount: number;
	graphBotCount: number;
	translationCount: number;
	credentialCount: number;
}> {
	const row = await db.prepare(
		`WITH RECURSIVE reachable(id) AS (
			SELECT configuration_id FROM inference_configurations
			WHERE owner_user_id = ? AND kind = 'account_default'
			UNION
			SELECT child.configuration_id FROM inference_configurations AS child
			JOIN reachable ON child.parent_id = reachable.id
			WHERE child.owner_user_id = ?
			LIMIT ?
		)
		SELECT
			(SELECT COUNT(*) FROM inference_configurations WHERE owner_user_id = ?) AS graphCount,
			(SELECT COUNT(*) FROM reachable) AS reachableCount,
			(SELECT COUNT(*) FROM worlds_index WHERE created_by_user_id = ? AND lifecycle_state = 'active' AND deleted_at IS NULL) AS worldCount,
			(SELECT COUNT(*) FROM inference_configurations WHERE owner_user_id = ? AND kind = 'world') AS graphWorldCount,
			(SELECT COUNT(*) FROM bots_index WHERE owner_user_id = ? AND lifecycle_state = 'active' AND deleted_at IS NULL) AS botCount,
			(SELECT COUNT(*) FROM inference_configurations WHERE owner_user_id = ? AND kind = 'bot') AS graphBotCount,
			(SELECT COUNT(*) FROM inference_translation_selections WHERE owner_user_id = ?) AS translationCount,
			(SELECT COUNT(*) FROM inference_configuration_credentials AS credentials
			 JOIN inference_configurations AS configuration ON configuration.configuration_id = credentials.configuration_id
			 WHERE configuration.owner_user_id = ?) AS credentialCount`,
	).bind(
		ownerUserId, ownerUserId, inferenceConfigurationCorruptionSentinel,
		ownerUserId, ownerUserId, ownerUserId, ownerUserId, ownerUserId, ownerUserId, ownerUserId,
	).first<{
		graphCount: number; reachableCount: number; worldCount: number; graphWorldCount: number;
		botCount: number; graphBotCount: number; translationCount: number; credentialCount: number;
	}>();
	if (!row) migrationParityFailure();
	return row;
}

function assertSameOverrides(node: InferenceConfigurationNode, expected: ReturnType<typeof inferenceOverridesFromLegacySettings>): void {
	if (parityJson(node.overrides) !== parityJson(expected)) migrationParityFailure();
}

function assertCredentialParity(node: InferenceConfigurationNode, legacySecret: string | undefined): void {
	const secret = legacySecret?.trim();
	if (secret) {
		if (node.credential.mode !== "value" || node.credential.secret !== secret || node.credential.secretVersion < 1) migrationParityFailure();
	} else if (node.credential.mode !== "inherit") {
		migrationParityFailure();
	}
}

function assertMigrationCredentialParity(
	node: InferenceConfigurationNode,
	expected: LegacyBotMigrationCredential,
): void {
	switch (expected.mode) {
		case "inherit":
			if (node.credential.mode !== "inherit") migrationParityFailure();
			return;
		case "account_default":
			if (node.credential.mode !== "account_default") migrationParityFailure();
			return;
		case "value":
			if (node.credential.mode !== "value" || node.credential.secret !== expected.secret || node.credential.secretVersion < 1) {
				migrationParityFailure();
			}
			return;
	}
}

/**
 * Credential presence is compared directly. Legacy resolution already drops the
 * deployment key whenever an owner base URL is in play, which is the same rule
 * the graph expresses as deployment_credential_suppressed_for_owner_base_url,
 * so a disagreement here is a real migration defect rather than a policy gap
 * that parity may mask.
 */
function assertProviderParity(
	legacy: ProviderSettings,
	canonical: ProviderSettings,
): void {
	assertParityEqual(providerParityEnvelope(legacy), providerParityEnvelope(canonical));
}

function migrationParityFailure(): never {
	throw new RepositoryError("conflict", "Inference graph raw or effective parity failed.", 409);
}

function parityJson(value: unknown): string {
	return JSON.stringify(parityJsonValue(value));
}

function parityJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(parityJsonValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => [key, parityJsonValue(entry)]));
}

async function createRollbackProjection(db: D1DatabaseLike, ownerUserId: string, now: string): Promise<void> {
	const version = await inferenceGraphReadVersion(db, ownerUserId);
	const cleanupAt = terminalCleanupAt(now);
	await db.batch([
		db.prepare(
			`INSERT INTO inference_graph_legacy_projections (
				owner_user_id, graph_revision, translation_configuration_id,
				translation_selection_revision, created_at, updated_at, cleanup_at
			) SELECT ?, ?, selection.configuration_id, selection.revision, ?, ?, ?
			  FROM inference_translation_selections AS selection WHERE selection.owner_user_id = ?
			ON CONFLICT(owner_user_id) DO UPDATE SET
				graph_revision = excluded.graph_revision,
				translation_configuration_id = excluded.translation_configuration_id,
				translation_selection_revision = excluded.translation_selection_revision,
				updated_at = excluded.updated_at,
				cleanup_at = excluded.cleanup_at`,
		).bind(ownerUserId, version.graphRevision, now, now, cleanupAt, ownerUserId),
		db.prepare(`DELETE FROM inference_graph_legacy_projection_entries WHERE owner_user_id = ?`).bind(ownerUserId),
		projectionEntryInsertStatement(db, ownerUserId),
		db.prepare(
			`INSERT INTO inference_graph_convergence (
				owner_user_id, phase, d1_revision, kv_revision, operation_json,
				created_at, updated_at, terminal_cleanup_at
			) VALUES (?, 'terminal', ?, ?, NULL, ?, ?, ?)
			ON CONFLICT(owner_user_id) DO UPDATE SET
				phase = 'terminal', d1_revision = excluded.d1_revision,
				kv_revision = excluded.kv_revision, operation_json = NULL,
				updated_at = excluded.updated_at,
				terminal_cleanup_at = excluded.terminal_cleanup_at`,
		).bind(ownerUserId, version.graphRevision, version.graphRevision, now, now, cleanupAt),
		db.prepare(
			`UPDATE inference_graph_users SET writer_version = 1, updated_at = ? WHERE owner_user_id = ? AND cutover_version = 0`,
		).bind(now, ownerUserId),
		advanceMigrationPhaseStatement(db, ownerUserId, "projection", "cutover", now),
	]);
}

function projectionEntryInsertStatement(db: D1DatabaseLike, ownerUserId: string): D1PreparedStatementLike {
	return db.prepare(
		`INSERT INTO inference_graph_legacy_projection_entries (
			owner_user_id, configuration_id, kind, fixed_role, parent_id, world_id, bot_id,
			custom_name, custom_name_key, overrides_json, configuration_revision,
			credential_mode, credential_secret_version
		)
		SELECT configuration.owner_user_id, configuration.configuration_id,
			configuration.kind, configuration.fixed_role, configuration.parent_id, configuration.world_id,
			configuration.bot_id, configuration.custom_name, configuration.custom_name_key,
			configuration.overrides_json, configuration.revision,
			credentials.mode, credentials.secret_version
		FROM inference_configurations AS configuration
		JOIN inference_configuration_credentials AS credentials
			ON credentials.configuration_id = configuration.configuration_id
			AND credentials.owner_user_id = configuration.owner_user_id
		WHERE configuration.owner_user_id = ?`,
	).bind(ownerUserId);
}

async function commitMigrationCutover(db: D1DatabaseLike, ownerUserId: string, now: string): Promise<void> {
	const cleanupAt = terminalCleanupAt(now);
	const results = await db.batch([
		db.prepare(
			`UPDATE inference_graph_users
			 SET cutover_version = 1, verified_cutover_at = ?, updated_at = ?
			 WHERE owner_user_id = ? AND writer_version = 1 AND cutover_version = 0
				AND EXISTS (
					SELECT 1 FROM inference_graph_legacy_projections
					WHERE owner_user_id = ? AND graph_revision = inference_graph_users.graph_revision
				)
				AND (SELECT COUNT(*) FROM inference_graph_legacy_projection_entries WHERE owner_user_id = ?) =
					(SELECT COUNT(*) FROM inference_configurations WHERE owner_user_id = ?)
				AND EXISTS (
					SELECT 1 FROM inference_graph_convergence
					WHERE owner_user_id = ? AND phase = 'terminal'
						AND d1_revision = inference_graph_users.graph_revision
						AND kv_revision = inference_graph_users.graph_revision
				)`,
		).bind(now, now, ownerUserId, ownerUserId, ownerUserId, ownerUserId, ownerUserId),
		db.prepare(
			`UPDATE inference_graph_migration_operations
			 SET phase = 'terminal', revision = revision + 1, failure_code = NULL,
				updated_at = ?, terminal_at = ?, terminal_cleanup_at = ?
			 WHERE owner_user_id = ? AND migration_version = ? AND phase = 'cutover'`,
		).bind(now, now, cleanupAt, ownerUserId, inferenceGraphMigrationVersion),
	]);
	if (!results[0]?.meta?.changes || !results[1]?.meta?.changes) {
		throw new RepositoryError("conflict", "Inference graph cutover gates did not pass.", 409);
	}
}

export async function rollbackInferenceGraphCutover(
	db: D1DatabaseLike,
	ownerUserId: string,
	now = new Date().toISOString(),
): Promise<void> {
	const version = await inferenceGraphReadVersion(db, ownerUserId);
	const projection = await rollbackProjectionInvariant(db, ownerUserId);
	if (version.cutoverVersion !== 1 || !projection || projection.graphRevision !== version.graphRevision ||
		projection.cleanupAt <= now || projection.convergencePhase !== "terminal" ||
		projection.d1Revision !== version.graphRevision || projection.kvRevision !== version.graphRevision ||
		projection.projectionCount !== projection.graphCount) {
		throw new RepositoryError("conflict", "A current rollback projection is not available.", 409);
	}
	await db.prepare(
		`UPDATE inference_graph_users SET cutover_version = 2, updated_at = ?
		 WHERE owner_user_id = ? AND cutover_version = 1 AND graph_revision = ?`,
	).bind(now, ownerUserId, version.graphRevision).run();
}

/**
 * Returns a rollback reader to canonical graph mode after the corrected release
 * is installed. The operation is maintenance-gated and uses the same exact
 * graph/projection/convergence revision checks as rollback, so recovery never
 * relies on manual SQL or a stale projection.
 */
export async function reactivateInferenceGraphCutover(
	db: D1DatabaseLike,
	ownerUserId: string,
	now = new Date().toISOString(),
): Promise<void> {
	const maintenance = await readMaintenanceState(db);
	if (!maintenance.enabled) {
		throw new RepositoryError("conflict", "Inference graph reactivation requires maintenance mode.", 409);
	}
	const version = await inferenceGraphReadVersion(db, ownerUserId);
	const projection = await rollbackProjectionInvariant(db, ownerUserId);
	if (version.writerVersion !== 1 || version.cutoverVersion !== 2 || !projection ||
		projection.graphRevision !== version.graphRevision || projection.convergencePhase !== "terminal" ||
		projection.d1Revision !== version.graphRevision || projection.kvRevision !== version.graphRevision ||
		projection.projectionCount !== projection.graphCount) {
		throw new RepositoryError("conflict", "Inference graph reactivation gates did not pass.", 409);
	}
	const result = await db.prepare(
		`UPDATE inference_graph_users SET cutover_version = 1, updated_at = ?
		 WHERE owner_user_id = ? AND writer_version = 1 AND cutover_version = 2 AND graph_revision = ?`,
	).bind(now, ownerUserId, version.graphRevision).run();
	if (!result.meta?.changes) {
		throw new RepositoryError("conflict", "Inference graph reactivation changed concurrently.", 409);
	}
}

type RollbackProjectionInvariant = {
	graphRevision: number;
	cleanupAt: string;
	convergencePhase: "pending_d1" | "pending_kv" | "terminal" | null;
	d1Revision: number | null;
	kvRevision: number | null;
	projectionCount: number;
	graphCount: number;
};

async function rollbackProjectionInvariant(
	db: D1DatabaseLike,
	ownerUserId: string,
): Promise<RollbackProjectionInvariant | null> {
	return db.prepare(
		`SELECT projection.graph_revision AS graphRevision, projection.cleanup_at AS cleanupAt,
			convergence.phase AS convergencePhase,
			convergence.d1_revision AS d1Revision, convergence.kv_revision AS kvRevision,
			(SELECT COUNT(*) FROM inference_graph_legacy_projection_entries WHERE owner_user_id = ?) AS projectionCount,
			(SELECT COUNT(*) FROM inference_configurations WHERE owner_user_id = ?) AS graphCount
		 FROM inference_graph_legacy_projections AS projection
		 LEFT JOIN inference_graph_convergence AS convergence ON convergence.owner_user_id = projection.owner_user_id
		 WHERE projection.owner_user_id = ? LIMIT 1`,
	).bind(ownerUserId, ownerUserId, ownerUserId).first<RollbackProjectionInvariant>();
}

export async function beginInferenceGraphCompatibilityWrite(
	db: D1DatabaseLike,
	input: {
		ownerUserId: string;
		kind: "account" | "bot" | "world";
		entityId: string;
		sourceRevision: number;
		fieldMask: LegacyInferenceCompatibilityFieldMask;
		now: string;
	},
): Promise<void> {
	const version = await inferenceGraphReadVersion(db, input.ownerUserId);
	if (version.writerVersion !== 1) return;
	const projectionExists = await db.prepare(
		`SELECT owner_user_id AS id FROM inference_graph_legacy_projections WHERE owner_user_id = ? LIMIT 1`,
	).bind(input.ownerUserId).first<{ id: string }>();
	if (!projectionExists) return;
	await db.prepare(
		`INSERT INTO inference_graph_convergence (
			owner_user_id, phase, d1_revision, kv_revision, operation_json,
			created_at, updated_at, terminal_cleanup_at
		) VALUES (?, 'pending_kv', ?, ?, ?, ?, ?, NULL)
		ON CONFLICT(owner_user_id) DO UPDATE SET
			phase = 'pending_kv', d1_revision = excluded.d1_revision,
			kv_revision = excluded.kv_revision, operation_json = excluded.operation_json,
			updated_at = excluded.updated_at, terminal_cleanup_at = NULL`,
	).bind(
		input.ownerUserId,
		version.graphRevision,
		input.sourceRevision,
		JSON.stringify({
			kind: input.kind,
			entityId: input.entityId,
			sourceRevision: input.sourceRevision,
			fieldMask: input.fieldMask,
		}),
		input.now,
		input.now,
	).run();
}

export type PendingInferenceGraphCompatibilityWrite = {
	phase: "pending_kv" | "pending_d1";
	kind: "account" | "bot" | "world";
	entityId: string;
	sourceRevision: number;
	fieldMask: LegacyInferenceCompatibilityFieldMask;
};

export async function pendingInferenceGraphCompatibilityWrite(
	db: D1DatabaseLike,
	ownerUserId: string,
): Promise<PendingInferenceGraphCompatibilityWrite | null> {
	const row = await db.prepare(
		`SELECT phase, operation_json AS operationJson
		 FROM inference_graph_convergence
		 WHERE owner_user_id = ? AND phase IN ('pending_kv', 'pending_d1') LIMIT 1`,
	).bind(ownerUserId).first<{ phase: "pending_kv" | "pending_d1"; operationJson: string }>();
	if (!row) return null;
	const parsed = JSON.parse(row.operationJson) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new RepositoryError("server_error", "Inference graph convergence operation is invalid.", 500);
	}
	const operation = parsed as Record<string, unknown>;
	if ((operation.kind !== "account" && operation.kind !== "bot" && operation.kind !== "world") ||
		typeof operation.entityId !== "string" || !operation.entityId ||
		typeof operation.sourceRevision !== "number" || !Number.isSafeInteger(operation.sourceRevision) || operation.sourceRevision < 1) {
		throw new RepositoryError("server_error", "Inference graph convergence operation is invalid.", 500);
	}
	let fieldMask: LegacyInferenceCompatibilityFieldMask;
	try {
		fieldMask = parseLegacyInferenceCompatibilityFieldMask(operation.fieldMask);
	} catch {
		throw new RepositoryError("server_error", "Inference graph convergence operation is invalid.", 500);
	}
	return {
		phase: row.phase,
		kind: operation.kind,
		entityId: operation.entityId,
		sourceRevision: operation.sourceRevision,
		fieldMask,
	};
}

export async function markInferenceGraphCompatibilitySourceWritten(
	db: D1DatabaseLike,
	ownerUserId: string,
	sourceRevision: number,
	now = new Date().toISOString(),
): Promise<void> {
	const pending = await pendingInferenceGraphCompatibilityWrite(db, ownerUserId);
	if (!pending) {
		const projection = await db.prepare(
			`SELECT owner_user_id AS id FROM inference_graph_legacy_projections WHERE owner_user_id = ? LIMIT 1`,
		).bind(ownerUserId).first<{ id: string }>();
		if (!projection) return;
		throw new RepositoryError("conflict", "Inference graph compatibility convergence state is missing.", 409);
	}
	const result = await db.prepare(
		`UPDATE inference_graph_convergence
		 SET phase = 'pending_d1', kv_revision = ?, updated_at = ?
		 WHERE owner_user_id = ? AND phase IN ('pending_kv', 'pending_d1')
			AND CAST(json_extract(operation_json, '$.sourceRevision') AS INTEGER) <= ?`,
	).bind(sourceRevision, now, ownerUserId, sourceRevision).run();
	if (!result.meta?.changes) {
		throw new RepositoryError("conflict", "Inference graph compatibility convergence revision does not match the legacy write.", 409);
	}
}

export async function completeInferenceGraphCompatibilityWrite(
	db: D1DatabaseLike,
	ownerUserId: string,
	now = new Date().toISOString(),
): Promise<void> {
	await db.prepare(
		`UPDATE inference_graph_convergence
		 SET phase = 'terminal',
			d1_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = ?),
			kv_revision = (SELECT graph_revision FROM inference_graph_users WHERE owner_user_id = ?),
			operation_json = NULL, updated_at = ?,
			terminal_cleanup_at = (SELECT cleanup_at FROM inference_graph_legacy_projections WHERE owner_user_id = ?)
		 WHERE owner_user_id = ? AND phase = 'pending_d1'
			AND EXISTS (
				SELECT 1 FROM inference_graph_legacy_projections AS projection
				JOIN inference_graph_users AS graph ON graph.owner_user_id = projection.owner_user_id
				WHERE projection.owner_user_id = ? AND projection.graph_revision = graph.graph_revision
			)`,
	).bind(ownerUserId, ownerUserId, now, ownerUserId, ownerUserId, ownerUserId).run();
	const terminal = await db.prepare(
		`SELECT convergence.owner_user_id AS id
		 FROM inference_graph_convergence AS convergence
		 JOIN inference_graph_users AS graph ON graph.owner_user_id = convergence.owner_user_id
		 JOIN inference_graph_legacy_projections AS projection ON projection.owner_user_id = convergence.owner_user_id
		 WHERE convergence.owner_user_id = ? AND convergence.phase = 'terminal'
			AND convergence.d1_revision = graph.graph_revision
			AND convergence.kv_revision = graph.graph_revision
			AND projection.graph_revision = graph.graph_revision LIMIT 1`,
	).bind(ownerUserId).first<{ id: string }>();
	if (!terminal) {
		throw new RepositoryError("conflict", "Inference graph compatibility write has not converged.", 409);
	}
}

export async function cleanupInferenceGraphTerminalState(
	db: D1DatabaseLike,
	now: string,
	limit = 100,
): Promise<{
	operations: number;
	projections: number;
	convergence: number;
	providerDefaultBarrierCandidates: number;
	providerDefaultBarrierSweeps: number;
}> {
	const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
	const [barrierCandidates, barrierSweeps] = await db.batch([
		db.prepare(
			`DELETE FROM inference_provider_default_barrier_candidates WHERE rowid IN (
				SELECT candidate.rowid FROM inference_provider_default_barrier_candidates AS candidate
				JOIN inference_provider_default_barrier_sweeps AS sweep
					ON sweep.owner_user_id = candidate.owner_user_id
				WHERE sweep.phase = 'terminal' AND sweep.terminal_cleanup_at <= ?
				ORDER BY sweep.terminal_cleanup_at, candidate.owner_user_id,
					candidate.configuration_id, candidate.field LIMIT ?
			) RETURNING owner_user_id`,
		).bind(now, boundedLimit),
		db.prepare(
			`DELETE FROM inference_provider_default_barrier_sweeps WHERE rowid IN (
				SELECT sweep.rowid FROM inference_provider_default_barrier_sweeps AS sweep
				WHERE sweep.phase = 'terminal' AND sweep.terminal_cleanup_at <= ?
					AND NOT EXISTS (
						SELECT 1 FROM inference_provider_default_barrier_candidates AS candidate
						WHERE candidate.owner_user_id = sweep.owner_user_id
					)
				ORDER BY sweep.terminal_cleanup_at, sweep.owner_user_id LIMIT ?
			) RETURNING owner_user_id`,
		).bind(now, boundedLimit),
	]);
	const [operations, projections, convergence] = await db.batch([
		db.prepare(
			`DELETE FROM inference_graph_migration_operations WHERE rowid IN (
				SELECT operation.rowid FROM inference_graph_migration_operations AS operation
				JOIN inference_graph_users AS graph ON graph.owner_user_id = operation.owner_user_id
				WHERE operation.terminal_cleanup_at <= ? AND graph.cutover_version != 2
					AND NOT EXISTS (
						SELECT 1 FROM inference_provider_default_barrier_sweeps AS sweep
						WHERE sweep.owner_user_id = operation.owner_user_id AND sweep.phase = 'pending'
					)
				ORDER BY operation.terminal_cleanup_at, operation.owner_user_id LIMIT ?
			) RETURNING owner_user_id`,
		).bind(now, boundedLimit),
		db.prepare(
			`DELETE FROM inference_graph_legacy_projections WHERE rowid IN (
				SELECT projection.rowid FROM inference_graph_legacy_projections AS projection
				JOIN inference_graph_users AS graph ON graph.owner_user_id = projection.owner_user_id
				WHERE projection.cleanup_at <= ? AND graph.cutover_version != 2
				ORDER BY projection.cleanup_at, projection.owner_user_id LIMIT ?
			) RETURNING owner_user_id`,
		).bind(now, boundedLimit),
		db.prepare(
			`DELETE FROM inference_graph_convergence WHERE rowid IN (
				SELECT convergence.rowid FROM inference_graph_convergence AS convergence
				JOIN inference_graph_users AS graph ON graph.owner_user_id = convergence.owner_user_id
				WHERE convergence.terminal_cleanup_at <= ? AND graph.cutover_version != 2
				ORDER BY convergence.terminal_cleanup_at, convergence.owner_user_id LIMIT ?
			) RETURNING owner_user_id`,
		).bind(now, boundedLimit),
	]);
	return {
		operations: operations.results?.length ?? 0,
		projections: projections.results?.length ?? 0,
		convergence: convergence.results?.length ?? 0,
		providerDefaultBarrierCandidates: barrierCandidates.results?.length ?? 0,
		providerDefaultBarrierSweeps: barrierSweeps.results?.length ?? 0,
	};
}

export async function inferenceGraphMigrationStatus(
	db: D1DatabaseLike,
	ownerUserId: string,
): Promise<InferenceGraphMigrationResult | null> {
	const operation = await migrationOperation(db, ownerUserId);
	return operation ? migrationResult(db, operation) : null;
}

/**
 * Bounded, secret-free progress for the provenance-aware barrier sweep. The
 * optional phase filter lets the fleet driver select only unfinished owners
 * without scanning or mutating owner data outside their coordinators.
 */
export async function listInferenceProviderDefaultBarrierSweepFleetStatus(
	db: D1DatabaseLike,
	input: { cursor?: string; limit?: number; phase?: "pending" | "terminal" } = {},
): Promise<InferenceProviderDefaultBarrierSweepFleetStatusPage> {
	const limit = boundedDiagnosticLimit(input.limit);
	const cursor = input.cursor ? decodeURIComponent(input.cursor) : "";
	const phase = input.phase ?? null;
	const result = await db.prepare(
		`SELECT sweep.owner_user_id AS ownerUserId, sweep.phase, sweep.stage,
			sweep.bot_cursor AS botCursor, sweep.applied_count AS appliedCount,
			sweep.skipped_count AS skippedCount
		 FROM inference_provider_default_barrier_sweeps AS sweep
		 JOIN users_index AS users ON users.user_id = sweep.owner_user_id
		 -- A lifecycle state may hide normal work without ending ownership. Only
		 -- terminal deletion removes sweep state, so every nondeleted owner remains
		 -- eligible and cannot strand migration cleanup indefinitely.
		 WHERE users.deleted_at IS NULL
			AND sweep.owner_user_id > ? AND (? IS NULL OR sweep.phase = ?)
		 ORDER BY sweep.owner_user_id ASC LIMIT ?`,
	).bind(cursor, phase, phase, limit + 1).all<InferenceProviderDefaultBarrierSweepFleetStatus>();
	const rows = result.results ?? [];
	const page = rows.slice(0, limit);
	return {
		items: page,
		...(rows.length > limit && page.length > 0
			? { nextCursor: encodeURIComponent(page[page.length - 1]!.ownerUserId) }
			: {}),
	};
}

/** Bounded, secret-free fleet status and invariant evidence for cutover. */
export async function listInferenceGraphFleetStatus(
	db: D1DatabaseLike,
	input: { cursor?: string; limit?: number } = {},
): Promise<InferenceGraphFleetStatusPage> {
	const limit = boundedDiagnosticLimit(input.limit);
	const cursor = input.cursor ? decodeURIComponent(input.cursor) : "";
	const result = await db.prepare(
		`SELECT users.user_id AS ownerUserId,
			COALESCE(graph.writer_version, 0) AS writerVersion,
			COALESCE(graph.cutover_version, 0) AS cutoverVersion,
			COALESCE(graph.graph_revision, 0) AS graphRevision,
			migration.phase AS migrationPhase, migration.revision AS migrationRevision,
			migration.parity_fingerprint AS parityFingerprint,
			migration.failure_code AS failureCode,
			convergence.phase AS convergencePhase,
			(SELECT COUNT(*) FROM inference_configurations AS configuration
			 WHERE configuration.owner_user_id = users.user_id AND configuration.kind = 'account_default') AS accountDefaultCount,
			(SELECT COUNT(*) FROM inference_translation_selections AS selection
			 WHERE selection.owner_user_id = users.user_id) AS translationSelectionCount,
			(SELECT COUNT(*) FROM worlds_index AS world
			 WHERE world.created_by_user_id = users.user_id AND world.lifecycle_state = 'active' AND world.deleted_at IS NULL) AS activeWorldCount,
			(SELECT COUNT(*) FROM inference_configurations AS configuration
			 WHERE configuration.owner_user_id = users.user_id AND configuration.kind = 'world') AS worldConfigurationCount,
			(SELECT COUNT(*) FROM bots_index AS bot
			 WHERE bot.owner_user_id = users.user_id AND bot.lifecycle_state = 'active' AND bot.deleted_at IS NULL) AS activeBotCount,
			(SELECT COUNT(*) FROM inference_configurations AS configuration
			 WHERE configuration.owner_user_id = users.user_id AND configuration.kind = 'bot') AS botConfigurationCount
		 FROM users_index AS users
		 LEFT JOIN inference_graph_users AS graph ON graph.owner_user_id = users.user_id
		 LEFT JOIN inference_graph_migration_operations AS migration
			ON migration.owner_user_id = users.user_id AND migration.migration_version = ?
		 LEFT JOIN inference_graph_convergence AS convergence ON convergence.owner_user_id = users.user_id
		 WHERE users.lifecycle_state = 'active' AND users.deleted_at IS NULL AND users.user_id > ?
		 ORDER BY users.user_id ASC LIMIT ?`,
	).bind(inferenceGraphMigrationVersion, cursor, limit + 1).all<{
		ownerUserId: string;
		writerVersion: 0 | 1;
		cutoverVersion: 0 | 1;
		graphRevision: number;
		migrationPhase: InferenceGraphMigrationPhase | null;
		migrationRevision: number | null;
		parityFingerprint: string | null;
		failureCode: string | null;
		convergencePhase: "pending_d1" | "pending_kv" | "terminal" | null;
		accountDefaultCount: number;
		translationSelectionCount: number;
		activeWorldCount: number;
		worldConfigurationCount: number;
		activeBotCount: number;
		botConfigurationCount: number;
	}>();
	const rows = result.results ?? [];
	const page = rows.slice(0, limit);
	return {
		items: page.map((row) => {
			const invariants = {
				accountDefaultCount: row.accountDefaultCount,
				translationSelectionCount: row.translationSelectionCount,
				activeWorldCount: row.activeWorldCount,
				worldConfigurationCount: row.worldConfigurationCount,
				activeBotCount: row.activeBotCount,
				botConfigurationCount: row.botConfigurationCount,
			};
			return {
				ownerUserId: row.ownerUserId,
				writerVersion: row.writerVersion,
				cutoverVersion: row.cutoverVersion,
				graphRevision: row.graphRevision,
				migrationPhase: row.migrationPhase,
				migrationRevision: row.migrationRevision,
				parityFingerprint: row.parityFingerprint,
				failureCode: row.failureCode,
				convergencePhase: row.convergencePhase,
				invariants,
				ready: row.writerVersion === 1 && row.cutoverVersion === 1 &&
					((row.migrationPhase === "terminal" && row.convergencePhase === "terminal") ||
						(row.migrationPhase === null && row.convergencePhase === null)) &&
					row.accountDefaultCount === 1 &&
					row.translationSelectionCount === 1 &&
					row.activeWorldCount === row.worldConfigurationCount &&
					row.activeBotCount === row.botConfigurationCount,
			};
		}),
		...(rows.length > limit && page.length > 0
			? { nextCursor: encodeURIComponent(page[page.length - 1]!.ownerUserId) }
			: {}),
	};
}

/**
 * Enables graph-required lifecycle extensions only after every active owner has
 * terminal, converged graph state. This is a one-way environment cutover.
 */
export async function activateInferenceGraphLifecycle(
	db: D1DatabaseLike,
	now = new Date().toISOString(),
): Promise<{ activationMode: "inference_graph_required" }> {
	const maintenance = await readMaintenanceState(db);
	if (!maintenance.enabled) {
		throw new RepositoryError("conflict", "Inference graph lifecycle activation requires maintenance mode.", 409);
	}
	const result = await db.prepare(
		`UPDATE entity_lifecycle_control
		 SET activation_mode = 'inference_graph_required', updated_at = ?
		 WHERE id = 1 AND activation_mode = 'legacy_compatible'
			AND NOT EXISTS (
				SELECT 1 FROM users_index AS users
				LEFT JOIN inference_graph_users AS graph ON graph.owner_user_id = users.user_id
				LEFT JOIN inference_graph_migration_operations AS migration
					ON migration.owner_user_id = users.user_id AND migration.migration_version = ?
				LEFT JOIN inference_graph_convergence AS convergence ON convergence.owner_user_id = users.user_id
				WHERE users.lifecycle_state = 'active' AND users.deleted_at IS NULL
					AND (graph.writer_version IS NOT 1 OR graph.cutover_version IS NOT 1
						OR migration.phase IS NOT 'terminal' OR convergence.phase IS NOT 'terminal')
			)
			AND NOT EXISTS (
				SELECT 1 FROM entity_lifecycle_entities WHERE phase != 'active' LIMIT 1
			)`,
	).bind(now, inferenceGraphMigrationVersion).run();
	if (!result.meta?.changes) {
		const current = await db.prepare(
			`SELECT activation_mode AS mode FROM entity_lifecycle_control WHERE id = 1 LIMIT 1`,
		).first<{ mode: "legacy_compatible" | "inference_graph_required" }>();
		if (current?.mode !== "inference_graph_required") {
			throw new RepositoryError("conflict", "Inference graph lifecycle activation gates did not pass.", 409);
		}
	}
	return { activationMode: "inference_graph_required" };
}

async function requireActiveMigrationOwner(db: D1DatabaseLike, ownerUserId: string): Promise<void> {
	const row = await db.prepare(
		`SELECT user_id AS id FROM users_index
		 WHERE user_id = ? AND lifecycle_state = 'active' AND deleted_at IS NULL LIMIT 1`,
	).bind(ownerUserId).first<{ id: string }>();
	if (!row) throw new RepositoryError("not_found", "Active migration owner not found.", 404);
}

async function migrationOperation(db: D1DatabaseLike, ownerUserId: string): Promise<MigrationOperation | null> {
	return db.prepare(
		`SELECT owner_user_id AS ownerUserId, phase, revision,
			world_cursor AS worldCursor, bot_cursor AS botCursor,
			parity_stage AS parityStage, parity_cursor AS parityCursor,
			parity_accumulator AS parityAccumulator,
			parity_world_count AS parityWorldCount, parity_bot_count AS parityBotCount,
			migrated_translation_configuration_id AS migratedTranslationConfigurationId,
			audit_json AS auditJson, parity_fingerprint AS parityFingerprint,
			failure_code AS failureCode, created_at AS createdAt, updated_at AS updatedAt,
			terminal_at AS terminalAt, terminal_cleanup_at AS terminalCleanupAt
		 FROM inference_graph_migration_operations
		 WHERE owner_user_id = ? AND migration_version = ? LIMIT 1`,
	).bind(ownerUserId, inferenceGraphMigrationVersion).first<MigrationOperation>();
}

async function requiredMigrationOperation(db: D1DatabaseLike, ownerUserId: string): Promise<MigrationOperation> {
	const operation = await migrationOperation(db, ownerUserId);
	if (!operation) throw new RepositoryError("server_error", "Inference graph migration operation is missing.", 500);
	return operation;
}

async function advanceMigrationPhase(
	db: D1DatabaseLike,
	ownerUserId: string,
	from: InferenceGraphMigrationPhase,
	to: InferenceGraphMigrationPhase,
	now: string,
): Promise<void> {
	await advanceMigrationPhaseStatement(db, ownerUserId, from, to, now).run();
}

function advanceMigrationPhaseStatement(
	db: D1DatabaseLike,
	ownerUserId: string,
	from: InferenceGraphMigrationPhase,
	to: InferenceGraphMigrationPhase,
	now: string,
	cursors: { worldCursor?: string | null; botCursor?: string | null } = {},
): D1PreparedStatementLike {
	return db.prepare(
		`UPDATE inference_graph_migration_operations
		 SET phase = ?, revision = revision + 1,
			world_cursor = COALESCE(?, world_cursor), bot_cursor = COALESCE(?, bot_cursor),
			failure_code = NULL, updated_at = ?
		 WHERE owner_user_id = ? AND migration_version = ? AND phase = ?`,
	).bind(to, cursors.worldCursor ?? null, cursors.botCursor ?? null, now, ownerUserId, inferenceGraphMigrationVersion, from);
}

function updateMigrationCursorStatement(
	db: D1DatabaseLike,
	ownerUserId: string,
	phase: "worlds" | "bots",
	column: "world_cursor" | "bot_cursor",
	cursor: string | null,
	now: string,
): D1PreparedStatementLike {
	return db.prepare(
		`UPDATE inference_graph_migration_operations SET ${column} = ?, revision = revision + 1,
			failure_code = NULL, updated_at = ?
		 WHERE owner_user_id = ? AND migration_version = ? AND phase = ?`,
	).bind(cursor, now, ownerUserId, inferenceGraphMigrationVersion, phase);
}

function valueCredentialStatement(
	db: D1DatabaseLike,
	configurationId: string,
	ownerUserId: string,
	secret: string,
	now: string,
): D1PreparedStatementLike {
	return db.prepare(
		`UPDATE inference_configuration_credentials
		 SET mode = 'value', secret_value = ?, secret_version = 1, updated_at = ?
		 WHERE configuration_id = ? AND owner_user_id = ?`,
	).bind(secret, now, configurationId, ownerUserId);
}

function accountDefaultCredentialStatement(
	db: D1DatabaseLike,
	configurationId: string,
	ownerUserId: string,
	now: string,
): D1PreparedStatementLike {
	return db.prepare(
		`UPDATE inference_configuration_credentials
		 SET mode = 'account_default', secret_value = NULL, secret_version = 0, updated_at = ?
		 WHERE configuration_id = ? AND owner_user_id = ?`,
	).bind(now, configurationId, ownerUserId);
}

async function deterministicTranslationConfigurationId(ownerUserId: string): Promise<string> {
	const digest = await sha256Hex(`inference:translation:${ownerUserId}`);
	return `cfg_${digest.slice(0, 32)}`;
}

async function collisionSafeTranslationName(db: D1DatabaseLike, ownerUserId: string, configurationId: string): Promise<string> {
	const base = "Migrated translation settings";
	const candidate = await db.prepare(
		`WITH RECURSIVE names(suffix, name, name_key) AS (
			VALUES (0, ?, ?)
			UNION ALL
			SELECT suffix + 1,
				CASE WHEN suffix = 0 THEN ? || ' (' || substr(?, -8) || ')'
					ELSE ? || ' (' || substr(?, -8) || '-' || CAST(suffix + 1 AS TEXT) || ')' END,
				CASE WHEN suffix = 0 THEN ? || ' (' || lower(substr(?, -8)) || ')'
					ELSE ? || ' (' || lower(substr(?, -8)) || '-' || CAST(suffix + 1 AS TEXT) || ')' END
			FROM names
			WHERE suffix < ? AND EXISTS (
				SELECT 1 FROM inference_configurations
				WHERE owner_user_id = ? AND kind = 'custom' AND fixed_role IS NULL
					AND custom_name_key = names.name_key
					AND configuration_id != ?
			)
		)
		SELECT name FROM names
		WHERE NOT EXISTS (
			SELECT 1 FROM inference_configurations
			WHERE owner_user_id = ? AND kind = 'custom' AND fixed_role IS NULL
				AND custom_name_key = names.name_key
				AND configuration_id != ?
		)
		ORDER BY suffix ASC LIMIT 1`,
	).bind(
		base,
		base.toLocaleLowerCase("en-US"),
		base,
		configurationId,
		base,
		configurationId,
		base.toLocaleLowerCase("en-US"),
		configurationId,
		base.toLocaleLowerCase("en-US"),
		configurationId,
		inferenceConfigurationCorruptionSentinel,
		ownerUserId,
		configurationId,
		ownerUserId,
		configurationId,
	).first<{ name: string }>();
	if (!candidate) throw new RepositoryError("conflict", "No collision-safe migrated translation name is available.", 409);
	return candidate.name;
}

function migrationAudit(settings: BotInferenceSettings | undefined): Record<string, boolean> {
	const dormantTranslation = Boolean(settings?.translation && !settings.translation.model);
	return {
		hadCacheFriendlyCompaction: settings?.cacheFriendlyCompaction !== undefined,
		hadDormantCloneInference: false,
		hadDormantTranslationFields: dormantTranslation,
		hadLegacyTranslationModel: Boolean(settings?.translation?.model),
		hadRecurringPromptFields: settings?.recurringPrompt !== undefined || settings?.recurringPromptEnabled !== undefined,
		// Legacy authorization removed the model in-place. Surviving translation
		// fields prove the loss boundary but cannot recover the deleted model id.
		hadTranslationModelStrippedByAuthorization: dormantTranslation && Boolean(
			settings?.translation?.providerRouting || settings?.translation?.reasoningEffort ||
			settings?.translation?.toolCalls || settings?.translation?.temperature !== undefined,
		),
		hadUnrecoverableEqualityCollapsedIntent: false,
	};
}

function parsedStoredObject(value: string | null): Record<string, unknown> | undefined {
	if (!value) return undefined;
	const parsed = JSON.parse(value) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new RepositoryError("server_error", "Stored world image settings are invalid.", 500);
	}
	return parsed as Record<string, unknown>;
}

async function recordMigrationFailure(db: D1DatabaseLike, ownerUserId: string, code: string, now: string): Promise<void> {
	await db.prepare(
		`UPDATE inference_graph_migration_operations
		 SET failure_code = ?, revision = revision + 1, updated_at = ?
		 WHERE owner_user_id = ? AND migration_version = ? AND phase NOT IN ('terminal', 'terminal_failed')`,
	).bind(code, now, ownerUserId, inferenceGraphMigrationVersion).run();
}

function structuredMigrationFailureCode(error: unknown): string {
	if (error instanceof RepositoryError) return error.code;
	return "unexpected_migration_failure";
}

async function migrationResult(db: D1DatabaseLike, operation: MigrationOperation): Promise<InferenceGraphMigrationResult> {
	const version = await inferenceGraphReadVersion(db, operation.ownerUserId);
	return {
		kind: "inference_graph_migration",
		ownerUserId: operation.ownerUserId,
		phase: operation.phase,
		revision: operation.revision,
		complete: operation.phase === "terminal",
		worldCursor: operation.worldCursor,
		botCursor: operation.botCursor,
		parityStage: operation.parityStage,
		parityCursor: operation.parityCursor,
		parityWorldCount: operation.parityWorldCount,
		parityBotCount: operation.parityBotCount,
		parityFingerprint: operation.parityFingerprint,
		failureCode: operation.failureCode,
		audit: parsedMigrationAudit(operation.auditJson),
		...version,
	};
}

function parsedMigrationAudit(value: string): InferenceGraphMigrationAudit {
	const parsed = JSON.parse(value) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new RepositoryError("server_error", "Inference graph migration audit is invalid.", 500);
	}
	const record = parsed as Record<string, unknown>;
	return {
		hadCacheFriendlyCompaction: record.hadCacheFriendlyCompaction === true,
		hadDormantCloneInference: record.hadDormantCloneInference === true,
		hadDormantTranslationFields: record.hadDormantTranslationFields === true,
		hadLegacyTranslationModel: record.hadLegacyTranslationModel === true,
		hadRecurringPromptFields: record.hadRecurringPromptFields === true,
		hadTranslationModelStrippedByAuthorization: record.hadTranslationModelStrippedByAuthorization === true,
		hadUnrecoverableEqualityCollapsedIntent: record.hadUnrecoverableEqualityCollapsedIntent === true,
	};
}

function boundedDiagnosticLimit(value: number | undefined): number {
	if (value === undefined) return 100;
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RepositoryError("bad_request", "Diagnostic page limit must be a positive integer.", 400);
	}
	return Math.min(value, 500);
}

function terminalCleanupAt(now: string): string {
	return new Date(Date.parse(now) + inferenceGraphTerminalRetentionDays * 24 * 60 * 60 * 1000).toISOString();
}
