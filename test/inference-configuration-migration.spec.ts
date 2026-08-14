import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	activateInferenceGraphLifecycle,
	beginInferenceGraphCompatibilityWrite,
	completeInferenceGraphCompatibilityWrite,
	cleanupInferenceGraphTerminalState,
	inferenceGraphMigrationStatus,
	listInferenceGraphFleetStatus,
	listInferenceProviderDefaultBarrierSweepFleetStatus,
	markInferenceGraphCompatibilitySourceWritten,
	pendingInferenceGraphCompatibilityWrite,
	reactivateInferenceGraphCutover,
	rollbackInferenceGraphCutover,
	runInferenceGraphMigrationStep,
	runInferenceProviderDefaultBarrierSweepStep,
	worldImageInferenceSettingsForRawParity,
} from "@bickr/shared/inference-configuration-migration";
import {
	canonicalAccountInference,
	canonicalAvatarImageSettings,
	canonicalBotInference,
	canonicalTranslationInferenceAnnotation,
	canonicalWorldInference,
} from "@bickr/shared/inference-configuration-consumers";
import { providerEnvironmentSettingsFromBindings, resolveBotProviderSettings } from "@bickr/shared/inference-settings";
import {
	inferenceConfigurationMutations,
	inferenceGraphReadVersion,
} from "@bickr/shared/inference-configuration-repository";
import {
	canonicalTranslationInferenceState,
} from "@bickr/shared/inference-translation-role";
import {
	migrateTranslationRoleForOwner,
	translationRoleMigrationStatus,
} from "@bickr/shared/inference-translation-role-migration";
import {
	accountDefaultConfigurationId,
	botConfigurationId,
	worldConfigurationId,
} from "@bickr/shared/inference-configuration-repository";
import {
	localizedText,
	schemaVersion,
	type BotDocument,
	type BotImageGenerationSettings,
	type LanguageTag,
	type UserDocument,
	type WorldDocument,
} from "@bickr/shared/model";
import { userIndexProjectionStatement, worldIndexProjectionStatement } from "@bickr/shared/repository";
import { kvKeys, readJson, writeJson } from "@bickr/shared/storage";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";
import { handleAgentRuntimeRequest } from "../workers/agent-runtime/src/routes";

const now = "2026-08-04T00:00:00.000Z";
const ownerId = "usr_migration";
const worldId = "wld_migration";
const en = "en" as LanguageTag;

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
	await testEnv.BICKR_D1.prepare(
		`UPDATE maintenance_control SET enabled = 1, activated_at = ?, updated_at = ? WHERE id = 1`,
	).bind(now, now).run();
	await seedActiveClaim("user_handle", "global", "migration-owner", "account", ownerId, ownerId);
	await userIndexProjectionStatement(testEnv.BICKR_D1, migrationUser()).run();
	await writeJson(testEnv.BICKR_KV, kvKeys.user(ownerId), migrationUser());
	await seedActiveClaim("world_handle", "global", "migration-world", "world", worldId, ownerId);
	await worldIndexProjectionStatement(testEnv.BICKR_D1, migrationWorld()).run();
	await writeJson(testEnv.BICKR_KV, kvKeys.world(worldId), migrationWorld());
});

describe("restartable inference graph migration", () => {
	it("reattributes only provenance-recorded legacy provider-default barriers and mirrors rollback projection", async () => {
		const bot = migrationBot("bot_sweep_projection", "sweep-projection", { model: "legacy/model" });
		await seedBot(bot);
		await migrateToCutover(deploymentEnv);
		const configurationId = await botConfigurationId(bot.id);
		const migrated = JSON.parse((await configuration(configurationId))!.overridesJson);
		const overrides = {
			...migrated,
			reasoning: { kind: "value", value: { kind: "provider_default" } },
			toolCalls: { kind: "value", value: { kind: "provider_default" } },
			compactionMode: { kind: "value", value: { kind: "provider_default" } },
			promptCacheMode: { kind: "value", value: { kind: "provider_default" } },
			supportsPrefill: { kind: "explicit_none" },
		};
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_configurations SET overrides_json = ?, revision = 1, updated_at = ?
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(JSON.stringify(overrides), now, ownerId, configurationId).run();
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_graph_legacy_projection_entries
			 SET overrides_json = ?, configuration_revision = 1
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(JSON.stringify(overrides), ownerId, configurationId).run();
		const translationSelection = await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id AS configurationId
			 FROM inference_translation_selections WHERE owner_user_id = ? LIMIT 1`,
		).bind(ownerId).first<{ configurationId: string }>();
		const translationConfiguration = (await configuration(translationSelection!.configurationId))!;
		const translationOverrides = JSON.parse(translationConfiguration.overridesJson);
		translationOverrides.reasoning = { kind: "value", value: { kind: "provider_default" } };
		translationOverrides.toolCalls = { kind: "value", value: { kind: "provider_default" } };
		const translationLegacyJson = JSON.stringify(translationOverrides);
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_configurations SET overrides_json = ?, revision = 1, updated_at = ?
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(translationLegacyJson, now, ownerId, translationSelection!.configurationId).run();
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_graph_legacy_projection_entries
			 SET overrides_json = ?, configuration_revision = 1
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(translationLegacyJson, ownerId, translationSelection!.configurationId).run();
		const accountConfigurationId = await accountDefaultConfigurationId(ownerId);
		const accountOverrides = JSON.parse((await configuration(accountConfigurationId))!.overridesJson);
		accountOverrides.compactionMode = { kind: "value", value: { kind: "provider_default" } };
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_configurations SET overrides_json = ?, revision = revision + 1, updated_at = ?
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(JSON.stringify(accountOverrides), now, ownerId, accountConfigurationId).run();
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO inference_provider_default_barrier_sweeps
			 (owner_user_id, phase, stage, created_at, updated_at)
			 VALUES (?, 'pending', 'account', ?, ?)`,
		).bind(ownerId, now, now).run();

		expect(await runInferenceProviderDefaultBarrierSweepStep(testEnv, ownerId, now))
			.toMatchObject({ phase: "pending", processedConfigurations: 1, appliedCount: 0, skippedCount: 0 });
		expect(await runInferenceProviderDefaultBarrierSweepStep(testEnv, ownerId, now))
			.toMatchObject({ phase: "pending", processedConfigurations: 1, appliedCount: 4, skippedCount: 0 });
		const result = await runInferenceProviderDefaultBarrierSweepStep(testEnv, ownerId, now);
		expect(result).toMatchObject({ phase: "terminal", processedConfigurations: 1, appliedCount: 6, skippedCount: 0 });
		const canonical = JSON.parse((await configuration(configurationId))!.overridesJson);
		expect(canonical.reasoning.value).toEqual({ kind: "bickr_automatic" });
		expect(canonical.toolCalls.value).toEqual({ kind: "bickr_automatic" });
		expect(canonical.compactionMode.value).toEqual({ kind: "bickr_automatic" });
		expect(canonical.promptCacheMode.value).toEqual({ kind: "bickr_automatic" });
		expect(JSON.parse((await configuration(accountConfigurationId))!.overridesJson).compactionMode.value)
			.toEqual({ kind: "provider_default" });
		const correctedTranslation = JSON.parse((await configuration(translationSelection!.configurationId))!.overridesJson);
		expect(correctedTranslation.reasoning.value).toEqual({ kind: "bickr_automatic" });
		expect(correctedTranslation.toolCalls.value).toEqual({ kind: "bickr_automatic" });
		const translationProjection = await testEnv.BICKR_D1.prepare(
			`SELECT overrides_json AS overridesJson FROM inference_graph_legacy_projection_entries
			 WHERE owner_user_id = ? AND configuration_id = ? LIMIT 1`,
		).bind(ownerId, translationSelection!.configurationId).first<{ overridesJson: string }>();
		expect(JSON.parse(translationProjection!.overridesJson)).toEqual(correctedTranslation);
		const projection = await testEnv.BICKR_D1.prepare(
			`SELECT overrides_json AS overridesJson FROM inference_graph_legacy_projection_entries
			 WHERE owner_user_id = ? AND configuration_id = ? LIMIT 1`,
		).bind(ownerId, configurationId).first<{ overridesJson: string }>();
		expect(JSON.parse(projection!.overridesJson)).toEqual(canonical);
		await rollbackInferenceGraphCutover(testEnv.BICKR_D1, ownerId, "2026-08-04T00:00:01.000Z");
		expect((await inferenceGraphReadVersion(testEnv.BICKR_D1, ownerId)).cutoverVersion).toBe(2);
		await reactivateInferenceGraphCutover(testEnv.BICKR_D1, ownerId, "2026-08-04T00:00:02.000Z");
		expect((await inferenceGraphReadVersion(testEnv.BICKR_D1, ownerId)).cutoverVersion).toBe(1);
		expect(await runInferenceProviderDefaultBarrierSweepStep(testEnv, ownerId, now))
			.toMatchObject({ phase: "terminal", processedConfigurations: 0, appliedCount: 6 });
		expect(await cleanupInferenceGraphTerminalState(testEnv.BICKR_D1, "2026-09-04T00:00:00.000Z", 10))
			.toMatchObject({ providerDefaultBarrierCandidates: 6, providerDefaultBarrierSweeps: 1 });
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT owner_user_id FROM inference_provider_default_barrier_sweeps WHERE owner_user_id = ?`,
		).bind(ownerId).first()).toBeNull();
	});

	it("uses retained migration provenance after an expired rollback projection is gone", async () => {
		const bot = migrationBot("bot_sweep_retained", "sweep-retained", { model: "legacy/model" });
		await seedBot(bot);
		await migrateToCutover(deploymentEnv);
		const configurationId = await botConfigurationId(bot.id);
		const migrated = JSON.parse((await configuration(configurationId))!.overridesJson);
		const legacy = {
			...migrated,
			reasoning: { kind: "value", value: { kind: "provider_default" } },
			toolCalls: { kind: "value", value: { kind: "provider_default" } },
			compactionMode: { kind: "value", value: { kind: "provider_default" } },
			promptCacheMode: { kind: "value", value: { kind: "provider_default" } },
			supportsPrefill: { kind: "explicit_none" },
		};
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_configurations SET overrides_json = ?, revision = 1, updated_at = ?
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(JSON.stringify(legacy), now, ownerId, configurationId).run();
		await testEnv.BICKR_D1.prepare(
			`DELETE FROM inference_graph_legacy_projections WHERE owner_user_id = ?`,
		).bind(ownerId).run();
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO inference_provider_default_barrier_sweeps
			 (owner_user_id, phase, stage, created_at, updated_at)
			 VALUES (?, 'pending', 'bots', ?, ?)`,
		).bind(ownerId, now, now).run();

		expect(await runInferenceProviderDefaultBarrierSweepStep(testEnv, ownerId, now))
			.toMatchObject({ phase: "pending", processedConfigurations: 1, appliedCount: 4, skippedCount: 0 });
		expect(await runInferenceProviderDefaultBarrierSweepStep(testEnv, ownerId, now))
			.toMatchObject({ phase: "terminal", processedConfigurations: 1, appliedCount: 4, skippedCount: 0 });
		const canonical = JSON.parse((await configuration(configurationId))!.overridesJson);
		expect(canonical.reasoning.value).toEqual({ kind: "bickr_automatic" });
		expect(canonical.toolCalls.value).toEqual({ kind: "bickr_automatic" });
		expect(canonical.compactionMode.value).toEqual({ kind: "bickr_automatic" });
		expect(canonical.promptCacheMode.value).toEqual({ kind: "bickr_automatic" });
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id FROM inference_graph_legacy_projection_entries
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(ownerId, configurationId).first()).toBeNull();
	});

	it("patches stale canonical and projection barriers independently after a post-cutover override", async () => {
		const bot = migrationBot("bot_sweep_edited", "sweep-edited", { model: "legacy/model" });
		await seedBot(bot);
		await migrateToCutover(deploymentEnv);
		const configurationId = await botConfigurationId(bot.id);
		const current = (await configuration(configurationId))!;
		const legacy = JSON.parse(current.overridesJson);
		for (const field of ["reasoning", "toolCalls", "compactionMode", "promptCacheMode"]) {
			legacy[field] = { kind: "value", value: { kind: "provider_default" } };
		}
		const legacyJson = JSON.stringify(legacy);
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare(
				`UPDATE inference_configurations SET overrides_json = ?, updated_at = ?
				 WHERE owner_user_id = ? AND configuration_id = ?`,
			).bind(legacyJson, now, ownerId, configurationId),
			testEnv.BICKR_D1.prepare(
				`UPDATE inference_graph_legacy_projection_entries
				 SET overrides_json = ?
				 WHERE owner_user_id = ? AND configuration_id = ?`,
			).bind(legacyJson, ownerId, configurationId),
		]);
		const edited = await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId,
			expectedRevision: current.revision,
			overrides: { temperature: { kind: "value", value: 0.91 } },
		}, now);
		const staleProjection = await testEnv.BICKR_D1.prepare(
			`SELECT overrides_json AS overridesJson, configuration_revision AS revision
			 FROM inference_graph_legacy_projection_entries
			 WHERE owner_user_id = ? AND configuration_id = ? LIMIT 1`,
		).bind(ownerId, configurationId).first<{ overridesJson: string; revision: number }>();
		expect(edited.revision).toBe(current.revision + 1);
		expect(staleProjection).toEqual({ overridesJson: legacyJson, revision: current.revision });
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO inference_provider_default_barrier_sweeps
			 (owner_user_id, phase, stage, created_at, updated_at)
			 VALUES (?, 'pending', 'bots', ?, ?)`,
		).bind(ownerId, now, now).run();

		const result = await runInferenceProviderDefaultBarrierSweepStep(testEnv, ownerId, now);

		expect(result).toMatchObject({ phase: "pending", appliedCount: 4, skippedCount: 0 });
		const corrected = (await configuration(configurationId))!;
		const overrides = JSON.parse(corrected.overridesJson);
		expect(corrected.revision).toBe(edited.revision + 1);
		expect(overrides.temperature).toEqual({ kind: "value", value: 0.91 });
		for (const field of ["reasoning", "toolCalls", "compactionMode", "promptCacheMode"]) {
			expect(overrides[field].value).toEqual({ kind: "bickr_automatic" });
		}
		const projection = await testEnv.BICKR_D1.prepare(
			`SELECT overrides_json AS overridesJson, configuration_revision AS revision
			 FROM inference_graph_legacy_projection_entries
			 WHERE owner_user_id = ? AND configuration_id = ? LIMIT 1`,
		).bind(ownerId, configurationId).first<{ overridesJson: string; revision: number }>();
		const projectionOverrides = JSON.parse(projection!.overridesJson);
		expect(projection!.revision).toBe(current.revision + 1);
		expect(projectionOverrides.temperature).toEqual(legacy.temperature);
		expect(projectionOverrides.temperature).not.toEqual(overrides.temperature);
		for (const field of ["reasoning", "toolCalls", "compactionMode", "promptCacheMode"]) {
			expect(projectionOverrides[field].value).toEqual({ kind: "bickr_automatic" });
		}
	});

	it("terminates and audits a barrier candidate whose participant source is gone", async () => {
		const bot = migrationBot("bot_sweep_source_gone", "sweep-source-gone", { model: "legacy/model" });
		await seedBot(bot);
		await migrateToCutover(deploymentEnv);
		const configurationId = await botConfigurationId(bot.id);
		const current = (await configuration(configurationId))!;
		const overrides = JSON.parse(current.overridesJson);
		overrides.reasoning = { kind: "value", value: { kind: "provider_default" } };
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_configurations SET overrides_json = ?, updated_at = ?
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(JSON.stringify(overrides), now, ownerId, configurationId).run();
		await testEnv.BICKR_KV.delete(kvKeys.bot(bot.id));
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO inference_provider_default_barrier_sweeps
			 (owner_user_id, phase, stage, created_at, updated_at)
			 VALUES (?, 'pending', 'bots', ?, ?)`,
		).bind(ownerId, now, now).run();

		let result = await runInferenceProviderDefaultBarrierSweepStep(testEnv, ownerId, now);
		result = await runInferenceProviderDefaultBarrierSweepStep(testEnv, ownerId, now);

		expect(result.phase).toBe("terminal");
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT status FROM inference_provider_default_barrier_candidates
			 WHERE owner_user_id = ? AND configuration_id = ? AND field = 'reasoning' LIMIT 1`,
		).bind(ownerId, configurationId).first()).toMatchObject({ status: "skipped" });
		expect((await inferenceGraphMigrationStatus(testEnv.BICKR_D1, ownerId))?.audit
			.providerDefaultBarrierSourceLosses).toMatchObject([{
				kind: "participant_unavailable",
				configurationId,
				participantId: bot.id,
				skippedFields: ["reasoning"],
			}]);
	});

	it("terminates and audits a deleted migrated Translation custom configuration", async () => {
		await migrateToCutover(deploymentEnv);
		const operation = await testEnv.BICKR_D1.prepare(
			`SELECT migrated_translation_configuration_id AS configurationId
			 FROM inference_graph_migration_operations WHERE owner_user_id = ? LIMIT 1`,
		).bind(ownerId).first<{ configurationId: string }>();
		const migratedTranslation = (await configuration(operation!.configurationId))!;
		await inferenceConfigurationMutations.deleteCustom(testEnv.BICKR_D1, ownerId, {
			configurationId: operation!.configurationId,
			expectedRevision: migratedTranslation.revision,
		}, now);
		await testEnv.BICKR_D1.prepare(
			`DELETE FROM inference_graph_legacy_projection_entries
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(ownerId, operation!.configurationId).run();
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO inference_provider_default_barrier_sweeps
			 (owner_user_id, phase, stage, created_at, updated_at)
			 VALUES (?, 'pending', 'translation', ?, ?)`,
		).bind(ownerId, now, now).run();

		const result = await runInferenceProviderDefaultBarrierSweepStep(testEnv, ownerId, now);

		expect(result).toMatchObject({ phase: "terminal", appliedCount: 0, skippedCount: 1 });
		expect((await inferenceGraphMigrationStatus(testEnv.BICKR_D1, ownerId))?.audit
			.providerDefaultBarrierSourceLosses).toMatchObject([{
				kind: "translation_configuration_unavailable",
				configurationId: operation!.configurationId,
				skippedFields: [],
			}]);
		await cleanupInferenceGraphTerminalState(testEnv.BICKR_D1, "2026-09-04T00:00:00.000Z", 10);
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT owner_user_id FROM inference_provider_default_barrier_sweeps WHERE owner_user_id = ?`,
		).bind(ownerId).first()).toBeNull();
	});

	it("keeps a pending sweep visible for a non-active owner until deletion is terminal", async () => {
		await testEnv.BICKR_D1.prepare(
			`UPDATE users_index SET lifecycle_state = 'deleting' WHERE user_id = ? AND deleted_at IS NULL`,
		).bind(ownerId).run();
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO inference_provider_default_barrier_sweeps
			 (owner_user_id, phase, stage, created_at, updated_at)
			 VALUES (?, 'pending', 'account', ?, ?)`,
		).bind(ownerId, now, now).run();

		const page = await listInferenceProviderDefaultBarrierSweepFleetStatus(testEnv.BICKR_D1, {
			phase: "pending",
			limit: 10,
		});
		expect(page.items).toMatchObject([{ ownerUserId: ownerId, phase: "pending", stage: "account" }]);
	});

	it("matches the v1 bot prefill barrier while removing only the four misattributed defaults", async () => {
		const user = migrationUser();
		user.inferenceSettings = { ...user.inferenceSettings, supportsPrefill: true };
		await writeJson(testEnv.BICKR_KV, kvKeys.user(ownerId), user);
		const bot = migrationBot("bot_v1_barriers", "v1-barriers", { model: "legacy/model" });
		await seedBot(bot);
		await migrateToCutover(deploymentEnv);
		const configurationId = await botConfigurationId(bot.id);
		const legacy = JSON.parse((await configuration(configurationId))!.overridesJson);
		for (const field of ["reasoning", "toolCalls", "compactionMode", "promptCacheMode"]) {
			legacy[field] = { kind: "value", value: { kind: "provider_default" } };
		}
		legacy.supportsPrefill = { kind: "explicit_none" };
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_configurations SET overrides_json = ?, revision = 1, updated_at = ?
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(JSON.stringify(legacy), now, ownerId, configurationId).run();
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO inference_provider_default_barrier_sweeps
			 (owner_user_id, phase, stage, created_at, updated_at)
			 VALUES (?, 'pending', 'bots', ?, ?)`,
		).bind(ownerId, now, now).run();

		let result = await runInferenceProviderDefaultBarrierSweepStep(testEnv, ownerId, now);
		for (let attempt = 0; attempt < 4 && result.phase !== "terminal"; attempt += 1) {
			result = await runInferenceProviderDefaultBarrierSweepStep(testEnv, ownerId, now);
		}
		expect(result).toMatchObject({ phase: "terminal", appliedCount: 4 });
		const corrected = JSON.parse((await configuration(configurationId))!.overridesJson);
		for (const field of ["reasoning", "toolCalls", "compactionMode", "promptCacheMode"]) {
			expect(corrected[field].value).toEqual({ kind: "bickr_automatic" });
		}
		expect(corrected.supportsPrefill).toEqual({ kind: "explicit_none" });
		const canonical = await canonicalBotInference(testEnv.BICKR_D1, ownerId, bot.id, deploymentEnv);
		expect(canonical?.resolution.effective.supportsPrefill).toBe(false);
		expect(canonical?.providerSettings.supportsPrefill).toBe(false);
	});

	it("normalizes a bounded legacy barrier batch and mirrors an in-flight cutover projection", async () => {
		const bot = migrationBot("bot_in_flight", "in-flight", { model: "legacy/model" });
		await seedBot(bot);
		const migrationEnv = { ...deploymentEnv, BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV } as never;
		let result = await runInferenceGraphMigrationStep(migrationEnv, ownerId, now);
		for (let attempt = 0; attempt < 12 && result.phase !== "cutover"; attempt += 1) {
			result = await runInferenceGraphMigrationStep(migrationEnv, ownerId, now);
		}
		expect(result.phase).toBe("cutover");
		const configurationId = await botConfigurationId(bot.id);
		const before = (await configuration(configurationId))!;
		const overrides = JSON.parse(before.overridesJson);
		for (const field of ["reasoning", "toolCalls", "compactionMode", "promptCacheMode"]) {
			overrides[field] = { kind: "value", value: { kind: "provider_default" } };
		}
		const legacyJson = JSON.stringify(overrides);
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_configurations SET overrides_json = ?, revision = ?, updated_at = ?
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(legacyJson, before.revision, now, ownerId, configurationId).run();
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_graph_legacy_projection_entries
			 SET overrides_json = ?, configuration_revision = ?
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(legacyJson, before.revision, ownerId, configurationId).run();
		const legacyProjection = await testEnv.BICKR_D1.prepare(
			`SELECT overrides_json AS overridesJson, configuration_revision AS revision
			 FROM inference_graph_legacy_projection_entries
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(ownerId, configurationId).first<{ overridesJson: string; revision: number }>();
		expect(legacyProjection).toEqual({ overridesJson: legacyJson, revision: before.revision });
		const translationSelection = await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id AS configurationId
			 FROM inference_translation_selections WHERE owner_user_id = ? LIMIT 1`,
		).bind(ownerId).first<{ configurationId: string }>();
		const translationBefore = (await configuration(translationSelection!.configurationId))!;
		const translationOverrides = JSON.parse(translationBefore.overridesJson);
		translationOverrides.reasoning = { kind: "value", value: { kind: "provider_default" } };
		translationOverrides.toolCalls = { kind: "value", value: { kind: "provider_default" } };
		const translationLegacyJson = JSON.stringify(translationOverrides);
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_configurations SET overrides_json = ?, updated_at = ?
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(translationLegacyJson, now, ownerId, translationSelection!.configurationId).run();
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_graph_legacy_projection_entries SET overrides_json = ?
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(translationLegacyJson, ownerId, translationSelection!.configurationId).run();

		const normalized = await runInferenceGraphMigrationStep(migrationEnv, ownerId, now);
		expect(normalized.phase).toBe("cutover");
		const canonical = JSON.parse((await configuration(configurationId))!.overridesJson);
		for (const field of ["reasoning", "toolCalls", "compactionMode", "promptCacheMode"]) {
			expect(canonical[field].value).toEqual({ kind: "bickr_automatic" });
		}
		const projection = await testEnv.BICKR_D1.prepare(
			`SELECT overrides_json AS overridesJson, configuration_revision AS revision
			 FROM inference_graph_legacy_projection_entries
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(ownerId, configurationId).first<{ overridesJson: string; revision: number }>();
		expect(JSON.parse(projection!.overridesJson)).toEqual(canonical);
		expect(projection!.revision).toBe(before.revision + 1);
		expect((await configuration(configurationId))!.revision).toBe(before.revision + 1);
		const normalizedTranslation = JSON.parse((await configuration(translationSelection!.configurationId))!.overridesJson);
		expect(normalizedTranslation.reasoning.value).toEqual({ kind: "bickr_automatic" });
		expect(normalizedTranslation.toolCalls.value).toEqual({ kind: "bickr_automatic" });
		const normalizedTranslationProjection = await testEnv.BICKR_D1.prepare(
			`SELECT overrides_json AS overridesJson FROM inference_graph_legacy_projection_entries
			 WHERE owner_user_id = ? AND configuration_id = ? LIMIT 1`,
		).bind(ownerId, translationSelection!.configurationId).first<{ overridesJson: string }>();
		expect(JSON.parse(normalizedTranslationProjection!.overridesJson)).toEqual(normalizedTranslation);
		expect((await runInferenceGraphMigrationStep(migrationEnv, ownerId, now)).phase).toBe("terminal");
	});

	it("projects every non-prompt world image field for raw parity without mutation", () => {
		const inferenceSettings = {
			model: "owner/image-model",
			providerRouting: { order: ["preferred-provider"] },
			aspectRatio: "4:3",
			imageSize: "2K",
			temperature: 0.4,
			topK: 16,
			topP: 0.8,
			minP: 0.05,
			frequencyPenalty: 0.1,
			presencePenalty: 0.2,
			repetitionPenalty: 1.1,
		} satisfies Required<Omit<BotImageGenerationSettings, "prompt">>;
		const settings = {
			...inferenceSettings,
			prompt: localizedText("KV-owned prompt", en),
		} satisfies BotImageGenerationSettings;
		const before = structuredClone(settings);

		const projected = worldImageInferenceSettingsForRawParity(settings);

		expectTypeOf(projected).toEqualTypeOf<Omit<BotImageGenerationSettings, "prompt">>();
		expect(projected).toEqual(inferenceSettings);
		expect(settings).toEqual(before);
		expect(projected).not.toBe(settings);
	});

	it.each([
		{ name: "D1 prompt absent and KV prompt present", d1Prompt: null, kvPrompt: "K".repeat(6_034) },
		{ name: "D1 prompt stale and KV prompt present", d1Prompt: "stale D1 prompt", kvPrompt: "K".repeat(2_042) },
		{ name: "D1 prompt present and KV prompt absent", d1Prompt: "stale D1 prompt", kvPrompt: null },
	])("ignores $name while preserving the authoritative KV document byte-for-byte", async ({ d1Prompt, kvPrompt }) => {
		const baseWorld = migrationWorld();
		const imageSettings = baseWorld.imageGeneration!;
		const d1World = {
			...baseWorld,
			imageGeneration: d1Prompt === null
				? { ...imageSettings }
				: { ...imageSettings, prompt: localizedText(d1Prompt, en) },
		};
		const kvWorld = {
			...baseWorld,
			imageGeneration: kvPrompt === null
				? { ...imageSettings }
				: { ...imageSettings, prompt: localizedText(kvPrompt, en) },
		};
		await worldIndexProjectionStatement(testEnv.BICKR_D1, d1World).run();
		await writeJson(testEnv.BICKR_KV, kvKeys.world(worldId), kvWorld);
		const before = await testEnv.BICKR_KV.get(kvKeys.world(worldId));

		await migrateToCutover(deploymentEnv);

		expect(await testEnv.BICKR_KV.get(kvKeys.world(worldId))).toBe(before);
	});

	it("returns a typed conflict for non-prompt world image drift even when the prompt also differs", async () => {
		const baseWorld = migrationWorld();
		const imageSettings = baseWorld.imageGeneration!;
		await worldIndexProjectionStatement(testEnv.BICKR_D1, {
			...baseWorld,
			imageGeneration: {
				...imageSettings,
				aspectRatio: "16:9",
				prompt: localizedText("stale D1 prompt", en),
			},
		}).run();
		await writeJson(testEnv.BICKR_KV, kvKeys.world(worldId), {
			...baseWorld,
			imageGeneration: {
				...imageSettings,
				prompt: localizedText("authoritative KV prompt", en),
			},
		});
		const before = await testEnv.BICKR_KV.get(kvKeys.world(worldId));
		const migrationEnv = { ...deploymentEnv, BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV } as never;
		let result = await runInferenceGraphMigrationStep(migrationEnv, ownerId, now);
		for (let attempt = 0; attempt < 15 && !(result.phase === "parity" && result.parityStage === "worlds"); attempt += 1) {
			result = await runInferenceGraphMigrationStep(
				migrationEnv,
				ownerId,
				new Date(Date.parse(now) + attempt + 1).toISOString(),
			);
		}
		expect(result).toMatchObject({ phase: "parity", parityStage: "worlds" });

		await expect(runInferenceGraphMigrationStep(
			migrationEnv,
			ownerId,
			"2026-08-04T00:01:00.000Z",
		)).rejects.toMatchObject({ code: "conflict", status: 409 });
		expect(await testEnv.BICKR_KV.get(kvKeys.world(worldId))).toBe(before);
	});

	it("migrates the legacy translation selection into a behavior-preserving fixed role", async () => {
		await migrateToCutover(deploymentEnv);
		const pointerBefore = await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id AS configurationId, revision
			 FROM inference_translation_selections WHERE owner_user_id = ?`,
		).bind(ownerId).first<{ configurationId: string; revision: number }>();
		expect(pointerBefore).not.toBeNull();
		expect(await translationRoleMigrationStatus(testEnv.BICKR_D1, ownerId, true)).toMatchObject({
			state: "migration_needed",
			migrated: false,
			roleConfigurationId: null,
			pointerConfigurationId: pointerBefore!.configurationId,
		});

		const migrated = await migrateTranslationRoleForOwner(testEnv.BICKR_D1, ownerId, true);
		expect(migrated).toMatchObject({
			state: "migrated",
			migrated: true,
			roleParentId: pointerBefore!.configurationId,
			behaviorEquivalent: true,
		});
		expect(migrated.roleConfigurationId).not.toBe(pointerBefore!.configurationId);
		expect(await configuration(pointerBefore!.configurationId)).not.toBeNull();
		expect(await migrateTranslationRoleForOwner(testEnv.BICKR_D1, ownerId, true)).toEqual(migrated);
		const annotation = await canonicalTranslationInferenceAnnotation(testEnv.BICKR_D1, ownerId, {}, false);
		expect(annotation?.enabled && annotation.effectiveModel).toBe("translator/model");
	});

	it("preserves cutover-1 behavior before sweep while normalizing only obsolete KV inference fields", async () => {
		await migrateToCutover(deploymentEnv);
		const before = await translationRoleMigrationStatus(testEnv.BICKR_D1, ownerId, true);
		expect(before).toMatchObject({
			cutoverVersion: 1,
			state: "migration_needed",
			eligible: true,
			migrated: false,
			roleConfigurationId: null,
		});
		const annotation = await canonicalTranslationInferenceAnnotation(testEnv.BICKR_D1, ownerId, {}, true);
		expect(annotation).toMatchObject({
			enabled: true,
			migrationPending: true,
			effectiveModel: "translator/model",
		});
		const annotationResponse = await handleAgentRuntimeRequest(new Request(
			`https://agent.internal/users/${ownerId}/inference-translation/annotation`,
			{ headers: { "x-bickr-user-id": ownerId } },
		), testEnv, { objectId: "user-coordinator-test", ownerUserId: ownerId });
		expect(annotationResponse.status, await annotationResponse.clone().text()).toBe(200);
		expect(await annotationResponse.json()).toMatchObject({
			data: { annotation: { enabled: true, migrationPending: true, effectiveModel: "translator/model" } },
		});

		await leaveMaintenance();
		const response = await handleAgentRuntimeRequest(new Request(`https://agent.internal/users/${ownerId}/profile`, {
			method: "PATCH",
			headers: { "content-type": "application/json", "x-bickr-user-id": ownerId },
			body: JSON.stringify({ language: en, inferenceSettings: { translation: {
				prompt: localizedText("Preserve the authored transition prompt", en),
				model: "obsolete/legacy-model",
			} } }),
		}), testEnv, { objectId: "user-coordinator-test", ownerUserId: ownerId });
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { profile: { translationInference: { enabled: true, migrationPending: true } } },
		});
		expect((await readJson<UserDocument>(testEnv.BICKR_KV, kvKeys.user(ownerId)))?.inferenceSettings?.translation)
			.toEqual({
				enabled: true,
				prompt: localizedText("Preserve the authored transition prompt", en),
			});
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT translation_role_state_version AS stateVersion
			 FROM inference_graph_users WHERE owner_user_id = ?`,
		).bind(ownerId).first()).toEqual({ stateVersion: 0 });
	});

	it("reports unswept cutover-2 owners as deferred without mutating them", async () => {
		await migrateToCutover(deploymentEnv);
		await rollbackInferenceGraphCutover(testEnv.BICKR_D1, ownerId, "2026-08-04T00:05:00.000Z");
		const before = await testEnv.BICKR_D1.prepare(
			`SELECT pointer.configuration_id AS configurationId, pointer.revision,
				graph.translation_role_state_version AS stateVersion
			 FROM inference_translation_selections AS pointer
			 JOIN inference_graph_users AS graph ON graph.owner_user_id = pointer.owner_user_id
			 WHERE pointer.owner_user_id = ?`,
		).bind(ownerId).first();
		expect(await translationRoleMigrationStatus(testEnv.BICKR_D1, ownerId, true)).toMatchObject({
			cutoverVersion: 2,
			state: "deferred",
			deferredReason: "compatibility_rollback",
			eligible: false,
		});
		await expect(migrateTranslationRoleForOwner(testEnv.BICKR_D1, ownerId, true))
			.rejects.toMatchObject({ code: "conflict", status: 409 });
		expect(await canonicalTranslationInferenceAnnotation(testEnv.BICKR_D1, ownerId, {}, true))
			.toMatchObject({ enabled: true, migrationPending: true, effectiveModel: "translator/model" });
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT pointer.configuration_id AS configurationId, pointer.revision,
				graph.translation_role_state_version AS stateVersion
			 FROM inference_translation_selections AS pointer
			 JOIN inference_graph_users AS graph ON graph.owner_user_id = pointer.owner_user_id
			 WHERE pointer.owner_user_id = ?`,
		).bind(ownerId).first()).toEqual(before);
	});

	it("reports post-sweep invariant disagreement as corruption rather than migration work", async () => {
		await migrateToCutover(deploymentEnv);
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_graph_users SET translation_role_state_version = 1 WHERE owner_user_id = ?`,
		).bind(ownerId).run();
		expect(await translationRoleMigrationStatus(testEnv.BICKR_D1, ownerId, true)).toMatchObject({
			state: "corrupt",
			eligible: false,
			migrated: false,
		});
	});

	it("resets a disabled legacy pointer without changing its former custom entry", async () => {
		await migrateToCutover(deploymentEnv);
		const pointerBefore = await testEnv.BICKR_D1.prepare(
			`SELECT pointer.configuration_id AS configurationId, configuration.revision
			 FROM inference_translation_selections AS pointer
			 JOIN inference_configurations AS configuration
				ON configuration.configuration_id = pointer.configuration_id
			 WHERE pointer.owner_user_id = ? AND configuration.kind = 'custom'`,
		).bind(ownerId).first<{ configurationId: string; revision: number }>();
		expect(pointerBefore).not.toBeNull();
		expect(await translationRoleMigrationStatus(testEnv.BICKR_D1, ownerId, false))
			.toMatchObject({ state: "migration_needed", migrated: false, roleConfigurationId: null });

		const migrated = await migrateTranslationRoleForOwner(testEnv.BICKR_D1, ownerId, false);
		expect(migrated).toMatchObject({
			migrated: true,
			roleConfigurationId: null,
			pointerConfigurationId: await accountDefaultConfigurationId(ownerId),
			behaviorEquivalent: null,
		});
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id AS configurationId, revision
			 FROM inference_configurations WHERE configuration_id = ?`,
		).bind(pointerBefore!.configurationId).first()).toEqual(pointerBefore);
		expect(await migrateTranslationRoleForOwner(testEnv.BICKR_D1, ownerId, false)).toEqual(migrated);
	});

	it("makes profile enablement canonical before mirroring it to KV", async () => {
		await migrateToCutover(deploymentEnv);
		const migrated = await migrateTranslationRoleForOwner(testEnv.BICKR_D1, ownerId, true);
		await leaveMaintenance();
		const patch = (body: unknown) => handleAgentRuntimeRequest(new Request(`https://agent.internal/users/${ownerId}/profile`, {
			method: "PATCH",
			headers: { "content-type": "application/json", "x-bickr-user-id": ownerId },
			body: JSON.stringify(body),
		}), testEnv, { objectId: "user-coordinator-test", ownerUserId: ownerId });

		const disabled = await patch({ inferenceSettings: { translation: { enabled: false } } });
		expect(disabled.status, await disabled.clone().text()).toBe(200);
		expect(await disabled.json()).toMatchObject({ data: { profile: { translationInference: { enabled: false } } } });
		expect(await canonicalTranslationInferenceState(testEnv.BICKR_D1, ownerId)).toMatchObject({ enabled: false });
		expect((await readJson<UserDocument>(testEnv.BICKR_KV, kvKeys.user(ownerId)))?.inferenceSettings?.translation)
			.toMatchObject({ enabled: false });
		const legacyRowsBefore = await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id AS configurationId, revision
			 FROM inference_configurations
			 WHERE owner_user_id = ? AND kind = 'custom' AND fixed_role IS NULL
			 ORDER BY configuration_id`,
		).bind(ownerId).all<{ configurationId: string; revision: number }>();

		const enabled = await patch({ inferenceSettings: { translation: {
			enabled: true,
			model: "must-not-recreate-legacy/model",
			providerRouting: { order: ["must-not-move-pointer"] },
		} } });
		expect(enabled.status, await enabled.clone().text()).toBe(200);
		const enabledPayload = await enabled.json() as { data?: { profile?: { translationInference?: { enabled?: boolean; configurationId?: string } } } };
		expect(enabledPayload.data?.profile?.translationInference?.enabled).toBe(true);
		expect(enabledPayload.data?.profile?.translationInference?.configurationId).not.toBe(migrated.roleConfigurationId);
		const mirroredTranslation = (await readJson<UserDocument>(testEnv.BICKR_KV, kvKeys.user(ownerId)))
			?.inferenceSettings?.translation;
		expect(mirroredTranslation).toEqual({
			enabled: true,
			prompt: localizedText("Translate exactly", en),
		});
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id AS configurationId, revision
			 FROM inference_configurations
			 WHERE owner_user_id = ? AND kind = 'custom' AND fixed_role IS NULL
			 ORDER BY configuration_id`,
		).bind(ownerId).all<{ configurationId: string; revision: number }>()).results).toEqual(legacyRowsBefore.results);
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT pointer.configuration_id AS configurationId, role.parent_id AS parentId
			 FROM inference_translation_selections AS pointer
			 JOIN inference_configurations AS role ON role.configuration_id = pointer.configuration_id
			 WHERE pointer.owner_user_id = ? AND role.fixed_role = 'translation'`,
		).bind(ownerId).first()).toEqual({
			configurationId: enabledPayload.data?.profile?.translationInference?.configurationId,
			parentId: await accountDefaultConfigurationId(ownerId),
		});
		const cleared = await patch({ inferenceSettings: { translation: null } });
		expect(cleared.status, await cleared.clone().text()).toBe(200);
		expect(await cleared.json()).toMatchObject({ data: { profile: { translationInference: { enabled: false } } } });
		expect((await readJson<UserDocument>(testEnv.BICKR_KV, kvKeys.user(ownerId)))?.inferenceSettings?.translation)
			.toEqual({ enabled: false });
	});

	it("migrates fixed entries, clone parentage, secrets, translation, parity, projection, and cutover last", async () => {
		const source = migrationBot("bot_z_source", "source", {
			model: "owner/source-model",
			openRouterApiKey: "source-secret",
			providerRouting: { order: ["source-provider"] },
			reasoningEffort: "high",
			topK: 41.5,
			imageGeneration: { model: "source/image-model", topK: 23.5 },
		});
		const clone = migrationBot("bot_a_clone", "clone", { temperature: 0 }, source);
		const localModelClone = migrationBot("bot_b_local_clone", "local-clone", {
			model: "owner/local-clone-model",
			temperature: 0.25,
		}, source);
		await seedBot(source);
		await seedBot(clone);
		await seedBot(localModelClone);
		await seedLinkedClone(clone, source);
		await seedLinkedClone(localModelClone, source);

		let result = await runInferenceGraphMigrationStep(testEnv, ownerId, now);
		expect(result.cutoverVersion).toBe(0);
		for (let attempt = 0; attempt < 12 && !result.complete; attempt += 1) {
			result = await runInferenceGraphMigrationStep(testEnv, ownerId, new Date(Date.parse(now) + attempt + 1).toISOString());
			if (result.phase !== "terminal") expect(result.cutoverVersion).toBe(0);
		}
		expect(result).toMatchObject({ complete: true, phase: "terminal", writerVersion: 1, cutoverVersion: 1 });

		const rootId = await accountDefaultConfigurationId(ownerId);
		const sourceConfigurationId = await botConfigurationId(source.id);
		expect(await configuration(await worldConfigurationId(worldId))).toMatchObject({ kind: "world", parentId: rootId });
		expect(await configuration(sourceConfigurationId)).toMatchObject({ kind: "bot", parentId: rootId });
		expect(await configuration(await botConfigurationId(clone.id))).toMatchObject({
			kind: "bot",
			parentId: sourceConfigurationId,
		});
		expect(JSON.parse((await configuration(await botConfigurationId(clone.id)))!.overridesJson)).toEqual({});
		const localCloneConfigurationId = await botConfigurationId(localModelClone.id);
		const localCloneConfiguration = await configuration(localCloneConfigurationId);
		expect(localCloneConfiguration).toMatchObject({ kind: "bot", parentId: sourceConfigurationId });
		expect(JSON.parse(localCloneConfiguration!.overridesJson)).toMatchObject({
			model: { kind: "value", value: "owner/local-clone-model" },
			baseUrl: { kind: "account_default" },
			providerRouting: { kind: "explicit_none" },
			reasoning: { kind: "value", value: { kind: "bickr_automatic" } },
			topK: { kind: "explicit_none" },
			imageModel: { kind: "target_default" },
		});
		expect(JSON.parse(localCloneConfiguration!.overridesJson).supportsPrefill).toEqual({ kind: "explicit_none" });
		expect(await credential(localCloneConfigurationId)).toEqual({
			mode: "account_default",
			secretValue: null,
			secretVersion: 0,
		});
		expect(await credential(sourceConfigurationId)).toEqual({ mode: "value", secretValue: "source-secret", secretVersion: 1 });

		const selector = await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id AS configurationId, selected_kind AS selectedKind
			 FROM inference_translation_selections WHERE owner_user_id = ?`,
		).bind(ownerId).first<{ configurationId: string; selectedKind: string }>();
		expect(selector?.selectedKind).toBe("custom");
		const translation = await configuration(selector!.configurationId);
		expect(translation).toMatchObject({ kind: "custom", parentId: rootId });
		expect(JSON.parse(translation!.overridesJson)).toMatchObject({
			model: { kind: "value", value: "translator/model" },
			reasoning: { kind: "value", value: { kind: "bickr_automatic" } },
			toolCalls: { kind: "value", value: { kind: "bickr_automatic" } },
			temperature: { kind: "value", value: 0 },
			providerRouting: { kind: "explicit_none" },
		});
		expect((await inferenceGraphReadVersion(testEnv.BICKR_D1, ownerId)).cutoverVersion).toBe(1);
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT graph_revision FROM inference_graph_legacy_projections WHERE owner_user_id = ?`,
		).bind(ownerId).first()).not.toBeNull();
		expect(JSON.stringify(await inferenceGraphMigrationStatus(testEnv.BICKR_D1, ownerId))).not.toContain("secret");
		expect(await inferenceGraphMigrationStatus(testEnv.BICKR_D1, ownerId)).toMatchObject({
			audit: { hadDormantCloneInference: true },
		});
	});

	it("preserves an empty participant routing object as a barrier to Account routing", async () => {
		const user = migrationUser();
		const accountRouting = { order: ["account-provider"] };
		user.inferenceSettings = { ...user.inferenceSettings, providerRouting: accountRouting };
		await writeJson(testEnv.BICKR_KV, kvKeys.user(ownerId), user);
		const bot = migrationBot("bot_empty_routing", "empty-routing", { providerRouting: {} });
		await seedBot(bot);

		await migrateToCutover(deploymentEnv);

		const rootId = await accountDefaultConfigurationId(ownerId);
		expect(await configurationOverrides(rootId)).toMatchObject({
			providerRouting: { kind: "value", value: accountRouting },
		});
		expect(await configurationOverrides(await botConfigurationId(bot.id))).toEqual({
			providerRouting: { kind: "explicit_none" },
		});
		expect((await inferenceGraphReadVersion(testEnv.BICKR_D1, ownerId)).cutoverVersion).toBe(1);
		const canonical = await canonicalBotInference(testEnv.BICKR_D1, ownerId, bot.id, deploymentEnv);
		expect(canonical).not.toBeNull();
		expect(canonical?.resolution.effective.providerRouting).toBeUndefined();
		expect(canonical?.providerSettings.providerRouting).toBeUndefined();
	});

	it("uses Account-default credential intent for linked local models without copying a deployment secret", async () => {
		const user = migrationUser();
		delete user.inferenceSettings?.openRouterApiKey;
		await writeJson(testEnv.BICKR_KV, kvKeys.user(ownerId), user);
		const source = migrationBot("bot_global_source", "global-source", {
			model: "owner/source-model",
			openRouterApiKey: "source-secret",
		});
		const clone = migrationBot("bot_global_clone", "global-clone", {
			model: "owner/local-model",
		}, source);
		await seedBot(source);
		await seedBot(clone);
		await seedLinkedClone(clone, source);
		const migrationEnv = { ...testEnv, OPENROUTER_API_KEY: "deployment-secret" };
		let result = await runInferenceGraphMigrationStep(migrationEnv, ownerId, now);
		for (let attempt = 0; attempt < 15 && !result.complete; attempt += 1) {
			result = await runInferenceGraphMigrationStep(
				migrationEnv,
				ownerId,
				new Date(Date.parse(now) + attempt + 1).toISOString(),
			);
		}
		expect(result).toMatchObject({ complete: true, phase: "terminal" });
		const cloneConfigurationId = await botConfigurationId(clone.id);
		expect(await credential(cloneConfigurationId)).toEqual({
			mode: "account_default",
			secretValue: null,
			secretVersion: 0,
		});
		expect(JSON.stringify(await inferenceGraphMigrationStatus(testEnv.BICKR_D1, ownerId)))
			.not.toContain("deployment-secret");
	});

	it.each([
		{
			name: "current",
			model: "google/gemini-3.1-flash-image",
			expectedOverride: { kind: "target_default" },
		},
		{
			name: "historical",
			model: "google/gemini-3.1-flash-image-preview",
			expectedOverride: {
				kind: "historical_bickr_default",
				value: "google/gemini-3.1-flash-image-preview",
			},
		},
	] as const)("migrates an explicit $name Bickr image default without suppressing a deployment-only credential", async ({ model, expectedOverride }) => {
		const deploymentOnlyEnv = { OPENROUTER_API_KEY: "deployment-only-secret" };
		const participantDefaults = {
			model,
			aspectRatio: "1:1",
			imageSize: "1K",
		};
		const worldDefaults = { ...participantDefaults, aspectRatio: "21:9" };
		const user = { ...migrationUser(), inferenceSettings: { imageGeneration: participantDefaults } };
		await writeJson(testEnv.BICKR_KV, kvKeys.user(ownerId), user);
		const world = { ...migrationWorld(), imageGeneration: worldDefaults };
		await worldIndexProjectionStatement(testEnv.BICKR_D1, world).run();
		await writeJson(testEnv.BICKR_KV, kvKeys.world(worldId), world);
		const source = migrationBot("bot_default_source", "default-source", {
			imageGeneration: participantDefaults,
		});
		const clone = migrationBot("bot_default_clone", "default-clone", {}, source);
		await seedBot(source);
		await seedBot(clone);
		await seedLinkedClone(clone, source);

		await migrateToCutover(deploymentOnlyEnv);

		const rootId = await accountDefaultConfigurationId(ownerId);
		const sourceId = await botConfigurationId(source.id);
		expect(await configurationOverrides(rootId)).toMatchObject({
			imageModel: expectedOverride,
			imageAspectRatio: { kind: "value", value: "1:1" },
			imageSize: { kind: "value", value: "1K" },
		});
		expect(await configurationOverrides(await worldConfigurationId(worldId))).toMatchObject({
			imageModel: expectedOverride,
			imageAspectRatio: { kind: "value", value: "21:9" },
			imageSize: { kind: "value", value: "1K" },
		});
		expect(await configurationOverrides(sourceId)).toMatchObject({
			imageModel: expectedOverride,
			imageAspectRatio: { kind: "value", value: "1:1" },
			imageSize: { kind: "value", value: "1K" },
		});
		expect(await configurationOverrides(await botConfigurationId(clone.id))).toEqual({});

		const canonicalTargets = [
			{
				consumer: await canonicalAccountInference(testEnv.BICKR_D1, ownerId, deploymentOnlyEnv),
				target: "participant" as const,
				aspectRatio: "1:1",
			},
			{
				consumer: await canonicalWorldInference(testEnv.BICKR_D1, ownerId, worldId, deploymentOnlyEnv),
				target: "world" as const,
				aspectRatio: "21:9",
			},
			{
				consumer: await canonicalBotInference(testEnv.BICKR_D1, ownerId, source.id, deploymentOnlyEnv),
				target: "participant" as const,
				aspectRatio: "1:1",
			},
			{
				consumer: await canonicalBotInference(testEnv.BICKR_D1, ownerId, clone.id, deploymentOnlyEnv),
				target: "participant" as const,
				aspectRatio: "1:1",
			},
		];
		for (const { consumer, target, aspectRatio } of canonicalTargets) {
			expect(consumer).not.toBeNull();
			expect(canonicalAvatarImageSettings(consumer!, target)).toMatchObject({
				apiKey: "deployment-only-secret",
				model,
				aspectRatio,
				imageSize: "1K",
			});
		}
		const terminalRetry = await runInferenceGraphMigrationStep(
			{ ...testEnv, ...deploymentOnlyEnv },
			ownerId,
			"2026-08-04T00:01:00.000Z",
		);
		expect(terminalRetry).toMatchObject({ complete: true, phase: "terminal", cutoverVersion: 1 });
		expect((await configurationOverrides(rootId)).imageModel).toEqual(expectedOverride);
	});

	it("preserves model-gated provider bundles and whole-object image inheritance for every bot shape", async () => {
		const user = migrationUser();
		user.inferenceSettings = {
			...user.inferenceSettings,
			providerRouting: { order: ["profile-provider"] },
			temperature: 0.61,
			topK: 70.5,
			topP: 0.82,
			imageGeneration: {
				model: "owner/account-image",
				providerRouting: { order: ["profile-image-provider"] },
				aspectRatio: "4:3",
				temperature: 0.62,
				topK: 20.5,
			},
		};
		await writeJson(testEnv.BICKR_KV, kvKeys.user(ownerId), user);

		const partialWorld = { ...migrationWorld(), imageGeneration: { temperature: 0.44 } };
		await worldIndexProjectionStatement(testEnv.BICKR_D1, partialWorld).run();
		await writeJson(testEnv.BICKR_KV, kvKeys.world(worldId), partialWorld);

		const source = migrationBot("bot_bundle_source", "bundle-source", {
			model: "owner/source-model",
			topK: 50.5,
			imageGeneration: { model: "owner/source-image", topK: 40.5 },
		});
		const ordinaryPartialImage = migrationBot("bot_ordinary_partial_image", "ordinary-partial-image", {
			imageGeneration: { temperature: 0.25 },
		});
		const ordinaryLocalModel = migrationBot("bot_ordinary_local_model", "ordinary-local-model", {
			model: "owner/ordinary-local-model",
		});
		const dormantLinked = migrationBot("bot_linked_dormant", "linked-dormant", {
			topK: 99.5,
			imageGeneration: { model: "owner/dormant-image", temperature: 0.99 },
		}, source);
		const linkedLocalImage = migrationBot("bot_linked_local_image", "linked-local-image", {
			model: "owner/linked-local-image-model",
			imageGeneration: { temperature: 0.33 },
		}, source);
		const linkedOwnerImage = migrationBot("bot_linked_owner_image", "linked-owner-image", {
			model: "owner/linked-owner-image-model",
		}, source);
		for (const bot of [
			source,
			ordinaryPartialImage,
			ordinaryLocalModel,
			dormantLinked,
			linkedLocalImage,
			linkedOwnerImage,
		]) {
			await seedBot(bot);
		}
		await seedLinkedClone(dormantLinked, source);
		await seedLinkedClone(linkedLocalImage, source);
		await seedLinkedClone(linkedOwnerImage, source);

		let result = await runInferenceGraphMigrationStep(testEnv, ownerId, now);
		for (let attempt = 0; attempt < 20 && !result.complete; attempt += 1) {
			result = await runInferenceGraphMigrationStep(
				testEnv,
				ownerId,
				new Date(Date.parse(now) + attempt + 1).toISOString(),
			);
		}
		expect(result).toMatchObject({ complete: true, phase: "terminal" });

		const worldOverrides = await configurationOverrides(await worldConfigurationId(worldId));
		expect(worldOverrides).toMatchObject({
			imageModel: { kind: "target_default" },
			imageAspectRatio: { kind: "target_default" },
			imageSize: { kind: "target_default" },
			imageTemperature: { kind: "value", value: 0.44 },
			imageTopK: { kind: "explicit_none" },
		});

		const partialImageOverrides = await configurationOverrides(await botConfigurationId(ordinaryPartialImage.id));
		expect(partialImageOverrides).toMatchObject({
			imageModel: { kind: "target_default" },
			imageAspectRatio: { kind: "target_default" },
			imageSize: { kind: "target_default" },
			imageTemperature: { kind: "value", value: 0.25 },
			imageTopK: { kind: "explicit_none" },
		});

		const ordinaryLocalOverrides = await configurationOverrides(await botConfigurationId(ordinaryLocalModel.id));
		expect(ordinaryLocalOverrides).toMatchObject({
			model: { kind: "value", value: "owner/ordinary-local-model" },
			providerRouting: { kind: "explicit_none" },
			temperature: { kind: "value", value: 1 },
			topK: { kind: "explicit_none" },
			topP: { kind: "explicit_none" },
		});
		expect(ordinaryLocalOverrides).not.toHaveProperty("imageModel");
		expect(ordinaryLocalOverrides).not.toHaveProperty("imageTemperature");
		expect(ordinaryLocalOverrides.supportsPrefill).toEqual({ kind: "explicit_none" });

		expect(await configurationOverrides(await botConfigurationId(dormantLinked.id))).toEqual({});

		const linkedLocalImageOverrides = await configurationOverrides(await botConfigurationId(linkedLocalImage.id));
		expect(linkedLocalImageOverrides).toMatchObject({
			imageModel: { kind: "target_default" },
			imageAspectRatio: { kind: "target_default" },
			imageSize: { kind: "target_default" },
			imageTemperature: { kind: "value", value: 0.33 },
			imageTopK: { kind: "explicit_none" },
		});

		const linkedOwnerImageOverrides = await configurationOverrides(await botConfigurationId(linkedOwnerImage.id));
		expect(linkedOwnerImageOverrides).toMatchObject({
			imageModel: { kind: "value", value: "owner/account-image" },
			imageProviderRouting: { kind: "value", value: { order: ["profile-image-provider"] } },
			imageAspectRatio: { kind: "value", value: "4:3" },
			imageSize: { kind: "target_default" },
			imageTemperature: { kind: "value", value: 0.62 },
			imageTopK: { kind: "value", value: 20.5 },
		});
	});

	it("selects Account default when no explicit translation model and never changes prompt or enabled state", async () => {
		const user = migrationUser();
		user.inferenceSettings = {
			...user.inferenceSettings,
			cacheFriendlyCompaction: true,
			recurringPromptEnabled: true,
			recurringPrompt: localizedText("Keep recurring prompt", en),
			translation: {
				enabled: false,
				prompt: localizedText("Preserve this exactly", en),
				temperature: 0.7,
			},
		};
		await writeJson(testEnv.BICKR_KV, kvKeys.user(ownerId), user);
		let result = await runInferenceGraphMigrationStep(testEnv, ownerId, now);
		for (let attempt = 0; attempt < 12 && !result.complete; attempt += 1) {
			result = await runInferenceGraphMigrationStep(testEnv, ownerId, new Date(Date.parse(now) + attempt + 1).toISOString());
		}
		const rootId = await accountDefaultConfigurationId(ownerId);
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id AS configurationId, selected_kind AS selectedKind
			 FROM inference_translation_selections WHERE owner_user_id = ?`,
		).bind(ownerId).first()).toEqual({ configurationId: rootId, selectedKind: "account_default" });
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count FROM inference_configurations WHERE owner_user_id = ? AND kind = 'custom'`,
		).bind(ownerId).first()).toEqual({ count: 0 });
		const stored = await testEnv.BICKR_KV.get<UserDocument>(kvKeys.user(ownerId), { type: "json" });
		expect(stored?.inferenceSettings?.translation).toEqual(user.inferenceSettings.translation);
		expect(stored?.inferenceSettings?.recurringPrompt).toEqual(user.inferenceSettings.recurringPrompt);
		expect(await inferenceGraphMigrationStatus(testEnv.BICKR_D1, ownerId)).toMatchObject({
			audit: {
				hadCacheFriendlyCompaction: true,
				hadDormantTranslationFields: true,
				hadRecurringPromptFields: true,
			},
		});
		const root = await configuration(rootId);
		expect(JSON.parse(root!.overridesJson)).not.toHaveProperty("compactionReasoning");
	});

	it("uses one deterministic collision-safe translation entry across retries", async () => {
		await runInferenceGraphMigrationStep(testEnv, ownerId, now);
		await runInferenceGraphMigrationStep(testEnv, ownerId, "2026-08-04T00:00:00.001Z");
		const rootId = await accountDefaultConfigurationId(ownerId);
		await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Migrated translation settings",
			parentId: rootId,
		});
		let result = await runInferenceGraphMigrationStep(testEnv, ownerId, "2026-08-04T00:00:00.002Z");
		for (let attempt = 0; attempt < 12 && !result.complete; attempt += 1) {
			result = await runInferenceGraphMigrationStep(testEnv, ownerId, new Date(Date.parse(now) + attempt + 3).toISOString());
		}
		expect(result.complete).toBe(true);
		const custom = await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id AS id, custom_name AS name
			 FROM inference_configurations WHERE owner_user_id = ? AND kind = 'custom' ORDER BY configuration_id`,
		).bind(ownerId).all<{ id: string; name: string }>();
		expect(custom.results).toHaveLength(2);
		expect(custom.results?.filter((row) => row.name.startsWith("Migrated translation settings"))).toHaveLength(2);
		await runInferenceGraphMigrationStep(testEnv, ownerId, "2026-08-04T00:00:01.000Z");
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count FROM inference_configurations WHERE owner_user_id = ? AND kind = 'custom'`,
		).bind(ownerId).first<{ count: number }>())?.count).toBe(2);
	});

	it("tracks compatibility convergence, bounded fleet readiness, activation, and 30-day cleanup", async () => {
		let result = await runInferenceGraphMigrationStep(testEnv, ownerId, now);
		for (let attempt = 0; attempt < 12 && !result.complete; attempt += 1) {
			result = await runInferenceGraphMigrationStep(testEnv, ownerId, new Date(Date.parse(now) + attempt + 1).toISOString());
		}
		const fleet = await listInferenceGraphFleetStatus(testEnv.BICKR_D1, { limit: 1 });
		expect(fleet.items).toHaveLength(1);
		expect(fleet.items[0]).toMatchObject({ ownerUserId: ownerId, ready: true });

		await beginInferenceGraphCompatibilityWrite(testEnv.BICKR_D1, {
			ownerUserId: ownerId,
			kind: "account",
			entityId: ownerId,
			sourceRevision: 2,
			fieldMask: { fields: ["temperature"], translationFields: [], credential: false },
			now: "2026-08-04T00:01:00.000Z",
		});
		expect(await pendingInferenceGraphCompatibilityWrite(testEnv.BICKR_D1, ownerId)).toMatchObject({
			phase: "pending_kv",
			sourceRevision: 2,
		});
		await markInferenceGraphCompatibilitySourceWritten(testEnv.BICKR_D1, ownerId, 2, "2026-08-04T00:01:01.000Z");
		expect(await pendingInferenceGraphCompatibilityWrite(testEnv.BICKR_D1, ownerId)).toMatchObject({ phase: "pending_d1" });
		const rootId = await accountDefaultConfigurationId(ownerId);
		const root = await configuration(rootId);
		await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: rootId,
			expectedRevision: root!.revision,
			overrides: { temperature: { kind: "value", value: 0.3 } },
		}, "2026-08-04T00:01:02.000Z");
		await completeInferenceGraphCompatibilityWrite(testEnv.BICKR_D1, ownerId, "2026-08-04T00:01:02.000Z");
		expect(await pendingInferenceGraphCompatibilityWrite(testEnv.BICKR_D1, ownerId)).toBeNull();

		expect(await activateInferenceGraphLifecycle(testEnv.BICKR_D1, "2026-08-04T00:02:00.000Z"))
			.toEqual({ activationMode: "inference_graph_required" });
		expect(await cleanupInferenceGraphTerminalState(testEnv.BICKR_D1, "2026-09-04T00:00:00.000Z", 1))
			.toEqual({
				operations: 1,
				projections: 1,
				convergence: 1,
				providerDefaultBarrierCandidates: 0,
				providerDefaultBarrierSweeps: 0,
			});
		expect((await inferenceGraphReadVersion(testEnv.BICKR_D1, ownerId)).cutoverVersion).toBe(1);
		await expect(runInferenceGraphMigrationStep(testEnv, ownerId, "2026-09-04T00:00:01.000Z"))
			.rejects.toMatchObject({ code: "conflict", status: 409 });
	});

	it("dual-projects a legacy coordinator write and keeps rollback current", async () => {
		const compatibilityBot = migrationBot("bot_compatibility", "compatibility", {});
		await seedBot(compatibilityBot);
		let result = await runInferenceGraphMigrationStep(testEnv, ownerId, now);
		for (let attempt = 0; attempt < 12 && !result.complete; attempt += 1) {
			result = await runInferenceGraphMigrationStep(testEnv, ownerId, new Date(Date.parse(now) + attempt + 1).toISOString());
		}
		const rootId = await accountDefaultConfigurationId(ownerId);
		const beforeGraphOnly = await configuration(rootId);
		await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: rootId,
			expectedRevision: beforeGraphOnly!.revision,
			overrides: {
				compactionReasoning: { kind: "value", value: { kind: "explicit_effort", effort: "high" } },
			},
		});
		const userSelected = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "User selected translation",
			parentId: rootId,
			overrides: { model: { kind: "value", value: "user/selected-translation" } },
		});
		const selectionBefore = await testEnv.BICKR_D1.prepare(
			`SELECT revision FROM inference_translation_selections WHERE owner_user_id = ?`,
		).bind(ownerId).first<{ revision: number }>();
		await inferenceConfigurationMutations.updateLegacyTranslationPointer(testEnv.BICKR_D1, ownerId, {
			configurationId: userSelected.id,
			expectedRevision: selectionBefore!.revision,
		});
		await migrateTranslationRoleForOwner(testEnv.BICKR_D1, ownerId, true);
		await testEnv.BICKR_D1.prepare(
			`UPDATE maintenance_control SET enabled = 0, activated_at = NULL, updated_at = ? WHERE id = 1`,
		).bind("2026-08-04T00:03:00.000Z").run();
		const graphBeforePromptOnlyWrites = await inferenceGraphReadVersion(testEnv.BICKR_D1, ownerId);
		const promptOnlyRequests = [
			new Request(`https://agent.internal/users/${ownerId}/profile`, {
				method: "PATCH",
				headers: { "content-type": "application/json", "x-bickr-user-id": ownerId },
				body: JSON.stringify({ inferenceSettings: { recurringPromptEnabled: true } }),
			}),
			new Request(`https://agent.internal/users/${ownerId}/bots/${compatibilityBot.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json", "x-bickr-user-id": ownerId },
				body: JSON.stringify({ inferenceSettings: { recurringPromptEnabled: true } }),
			}),
		];
		const promptOnlyResponses: Response[] = [];
		for (const request of promptOnlyRequests) {
			promptOnlyResponses.push(await handleAgentRuntimeRequest(
				request,
				testEnv,
				{ objectId: "user-coordinator-test", ownerUserId: ownerId },
			));
		}
		expect(promptOnlyResponses.map((response) => response.status)).toEqual([200, 200]);
		expect(await inferenceGraphReadVersion(testEnv.BICKR_D1, ownerId)).toEqual(graphBeforePromptOnlyWrites);
		expect(await pendingInferenceGraphCompatibilityWrite(testEnv.BICKR_D1, ownerId)).toBeNull();
		const response = await handleAgentRuntimeRequest(new Request(`https://agent.internal/users/${ownerId}/profile`, {
			method: "PATCH",
			headers: { "content-type": "application/json", "x-bickr-user-id": ownerId },
			body: JSON.stringify({ inferenceSettings: { temperature: 0.2 } }),
		}), testEnv, { objectId: "user-coordinator-test", ownerUserId: ownerId });
		expect(response.status).toBe(200);
		const root = await configuration(rootId);
		expect(JSON.parse(root!.overridesJson)).toMatchObject({ temperature: { kind: "value", value: 0.2 } });
		expect(JSON.parse(root!.overridesJson)).toMatchObject({
			compactionReasoning: { kind: "value", value: { kind: "explicit_effort", effort: "high" } },
		});
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT pointer.configuration_id AS configurationId, role.parent_id AS parentId
			 FROM inference_translation_selections AS pointer
			 JOIN inference_configurations AS role ON role.configuration_id = pointer.configuration_id
			 WHERE pointer.owner_user_id = ? AND role.fixed_role = 'translation'`,
		).bind(ownerId).first()).toMatchObject({ parentId: userSelected.id });
		expect(await pendingInferenceGraphCompatibilityWrite(testEnv.BICKR_D1, ownerId)).toBeNull();
		const convergence = await testEnv.BICKR_D1.prepare(
			`SELECT phase, d1_revision AS d1Revision, kv_revision AS kvRevision
			 FROM inference_graph_convergence WHERE owner_user_id = ?`,
		).bind(ownerId).first<{ phase: string; d1Revision: number; kvRevision: number }>();
		expect(convergence).toMatchObject({ phase: "terminal" });
		expect(convergence?.d1Revision).toBe(convergence?.kvRevision);

		await rollbackInferenceGraphCutover(testEnv.BICKR_D1, ownerId, "2026-08-04T00:04:00.000Z");
		expect((await inferenceGraphReadVersion(testEnv.BICKR_D1, ownerId)).cutoverVersion).toBe(2);
		const translation = await canonicalTranslationInferenceAnnotation(testEnv.BICKR_D1, ownerId, {}, false);
		expect(translation?.enabled && translation.effectiveModel).toBe("user/selected-translation");
		const rejectedToggle = await handleAgentRuntimeRequest(new Request(`https://agent.internal/users/${ownerId}/profile`, {
			method: "PATCH",
			headers: { "content-type": "application/json", "x-bickr-user-id": ownerId },
			body: JSON.stringify({ inferenceSettings: { translation: { enabled: false } } }),
		}), testEnv, { objectId: "user-coordinator-test", ownerUserId: ownerId });
		expect(rejectedToggle.status).toBe(409);
		const promptOnly = await handleAgentRuntimeRequest(new Request(`https://agent.internal/users/${ownerId}/profile`, {
			method: "PATCH",
			headers: { "content-type": "application/json", "x-bickr-user-id": ownerId },
			body: JSON.stringify({ language: en, inferenceSettings: { translation: { prompt: localizedText("Rollback prompt", en) } } }),
		}), testEnv, { objectId: "user-coordinator-test", ownerUserId: ownerId });
		expect(promptOnly.status, await promptOnly.clone().text()).toBe(200);
		expect(await cleanupInferenceGraphTerminalState(testEnv.BICKR_D1, "2026-09-04T00:00:00.000Z", 10))
			.toEqual({
				operations: 0,
				projections: 0,
				convergence: 0,
				providerDefaultBarrierCandidates: 0,
				providerDefaultBarrierSweeps: 0,
			});
		await expect(reactivateInferenceGraphCutover(
			testEnv.BICKR_D1,
			ownerId,
			"2026-09-04T00:00:00.500Z",
		)).rejects.toMatchObject({ code: "conflict", status: 409 });
		await testEnv.BICKR_D1.prepare(
			`UPDATE maintenance_control SET enabled = 1, activated_at = ?, updated_at = ? WHERE id = 1`,
		).bind("2026-09-04T00:00:01.000Z", "2026-09-04T00:00:01.000Z").run();
		await reactivateInferenceGraphCutover(testEnv.BICKR_D1, ownerId, "2026-09-04T00:00:02.000Z");
		expect((await inferenceGraphReadVersion(testEnv.BICKR_D1, ownerId)).cutoverVersion).toBe(1);
		expect(await cleanupInferenceGraphTerminalState(testEnv.BICKR_D1, "2026-09-04T00:00:03.000Z", 10))
			.toEqual({
				operations: 1,
				projections: 1,
				convergence: 1,
				providerDefaultBarrierCandidates: 0,
				providerDefaultBarrierSweeps: 0,
			});
	});

	it("persists bounded parity cursors and resumes a 51-participant sweep", async () => {
		for (let index = 0; index < 51; index += 1) {
			await seedBot(migrationBot(
				`bot_parity_${index.toString().padStart(3, "0")}`,
				`parity-${index.toString().padStart(3, "0")}`,
				{ temperature: 0.4 },
			));
		}
		let result = await runInferenceGraphMigrationStep(testEnv, ownerId, now);
		for (let attempt = 0; attempt < 20 && !(result.phase === "parity" && result.parityStage === "bots"); attempt += 1) {
			result = await runInferenceGraphMigrationStep(
				testEnv,
				ownerId,
				new Date(Date.parse(now) + attempt + 1).toISOString(),
			);
		}
		expect(result).toMatchObject({ phase: "parity", parityStage: "bots", parityBotCount: 0 });
		const firstBatch = await runInferenceGraphMigrationStep(testEnv, ownerId, "2026-08-04T00:01:00.000Z");
		expect(firstBatch).toMatchObject({ phase: "parity", parityStage: "bots", parityBotCount: 50 });
		expect(firstBatch.parityCursor).toBe("bot_parity_049");
		const resumed = await runInferenceGraphMigrationStep(testEnv, ownerId, "2026-08-04T00:01:01.000Z");
		expect(resumed).toMatchObject({ phase: "parity", parityStage: "translation", parityBotCount: 51 });
		const verified = await runInferenceGraphMigrationStep(testEnv, ownerId, "2026-08-04T00:01:02.000Z");
		expect(verified.phase).toBe("projection");
		expect(verified.parityFingerprint).toMatch(/^[a-f0-9]{64}$/);
	});

	it("keeps owner graph APIs closed while only the compatibility writer is ready", async () => {
		let result = await runInferenceGraphMigrationStep(testEnv, ownerId, now);
		for (let attempt = 0; attempt < 15 && result.phase !== "cutover"; attempt += 1) {
			result = await runInferenceGraphMigrationStep(
				testEnv,
				ownerId,
				new Date(Date.parse(now) + attempt + 1).toISOString(),
			);
		}
		expect(result).toMatchObject({ phase: "cutover", writerVersion: 1, cutoverVersion: 0 });
		const before = await handleAgentRuntimeRequest(new Request(
			`https://agent.internal/users/${ownerId}/inference-configurations`,
			{ headers: { "x-bickr-user-id": ownerId } },
		), testEnv, { objectId: "user-coordinator-test", ownerUserId: ownerId });
		expect(before.status).toBe(409);
		await runInferenceGraphMigrationStep(testEnv, ownerId, "2026-08-04T00:01:00.000Z");
		const after = await handleAgentRuntimeRequest(new Request(
			`https://agent.internal/users/${ownerId}/inference-configurations`,
			{ headers: { "x-bickr-user-id": ownerId } },
		), testEnv, { objectId: "user-coordinator-test", ownerUserId: ownerId });
		expect(after.status).toBe(200);
	});

	it("rejects rollback when equal convergence counters are stale for the current graph revision", async () => {
		let result = await runInferenceGraphMigrationStep(testEnv, ownerId, now);
		for (let attempt = 0; attempt < 15 && !result.complete; attempt += 1) {
			result = await runInferenceGraphMigrationStep(
				testEnv,
				ownerId,
				new Date(Date.parse(now) + attempt + 1).toISOString(),
			);
		}
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_graph_convergence SET d1_revision = 0, kv_revision = 0 WHERE owner_user_id = ?`,
		).bind(ownerId).run();
		await expect(rollbackInferenceGraphCutover(
			testEnv.BICKR_D1,
			ownerId,
			"2026-08-04T00:01:00.000Z",
		)).rejects.toMatchObject({ code: "conflict", status: 409 });
		expect((await inferenceGraphReadVersion(testEnv.BICKR_D1, ownerId)).cutoverVersion).toBe(1);
	});

	it("resumes a linked local-model clone at Account default without copying a secret", async () => {
		// The source has a custom base and key, the account has neither, and only
		// the deployment supplies a base/key/model. Legacy resolution for a clone
		// with its own model never consulted the source, and its own
		// hasBotOrInheritedProvider gate excluded the deployment key, so the
		// stored clone model fell back to the deployment model while still using
		// the deployment key. The graph must reproduce both facts at cutover.
		await seedOwnerInferenceSettings({ model: "owner/account-model" });
		await seedWorldWithoutImageSettings();
		const source = migrationBot("bot_m_source", "matrix-source", {
			model: "source/model",
			baseUrl: "https://source.example/v1",
			openRouterApiKey: "source-only-secret",
		});
		const clone = migrationBot("bot_m_clone", "matrix-clone", { model: "clone/local-model" }, source);
		await seedBot(source);
		await seedBot(clone);
		await seedLinkedClone(clone, source);

		await migrateToCutover(deploymentEnv);

		const cloneConfigurationId = await botConfigurationId(clone.id);
		expect(await configurationOverrides(cloneConfigurationId)).toMatchObject({
			model: { kind: "value", value: "clone/local-model" },
			baseUrl: { kind: "account_default" },
		});
		expect(await credential(cloneConfigurationId)).toEqual({
			mode: "account_default",
			secretValue: null,
			secretVersion: 0,
		});
		const secrets = await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id AS id FROM inference_configuration_credentials
			 WHERE owner_user_id = ? AND secret_value IS NOT NULL`,
		).bind(ownerId).all<{ id: string }>();
		expect(secrets.results?.map((row) => row.id)).toEqual([await botConfigurationId(source.id)]);

		const canonical = await canonicalBotInference(testEnv.BICKR_D1, ownerId, clone.id, deploymentEnv);
		const legacy = resolveBotProviderSettings(
			{ inferenceSettings: clone.inferenceSettings },
			{ inferenceSettings: (await ownerDocument()).inferenceSettings },
			providerEnvironmentSettingsFromBindings(deploymentEnv),
		).settings;
		// Deployment provenance survives the jump, so the deployment key is not
		// suppressed and the owner-selected model is still not authorized by it.
		expect(canonical?.resolution.raw.baseUrl.provenance).toEqual({
			kind: "configured",
			source: { kind: "bickr_default" },
		});
		expect(canonical?.resolution.effective.credential).toMatchObject({
			kind: "available",
			source: { kind: "bickr_default" },
		});
		expect(canonical?.resolution.providerAuthorizationAdjustment).toMatchObject({
			kind: "model_fell_back",
			requestedModel: "clone/local-model",
			reason: "owner_provider_unavailable",
		});
		expect(canonical?.providerSettings.model).toBe(legacy.model);
		expect(canonical?.providerSettings.model).toBe("deployment/model");
		expect(canonical?.providerSettings.baseUrl).toBe(legacy.baseUrl);
		expect(Boolean(canonical?.providerSettings.apiKey)).toBe(Boolean(legacy.apiKey));
		expect(canonical?.providerSettings.apiKey).toBe("deployment-secret");
	});

	const cloneProviderScenarios = [
		{
			name: "Account key with deployment base",
			owner: { openRouterApiKey: "account-secret" },
			clone: { model: "clone/local-model" },
			baseUrlOverride: { kind: "account_default" },
			credentialMode: "account_default",
			expectedBaseUrl: "https://openrouter.ai/api/v1/chat/completions",
			expectedModel: "clone/local-model",
			expectedCredentialAvailable: true,
		},
		{
			name: "Account custom base without an Account key",
			owner: { baseUrl: "https://account.example/v1" },
			clone: { model: "clone/local-model" },
			baseUrlOverride: { kind: "account_default" },
			credentialMode: "account_default",
			expectedBaseUrl: "https://account.example/v1",
			expectedModel: "clone/local-model",
			expectedCredentialAvailable: false,
		},
		{
			name: "Account custom base with an Account key",
			owner: { baseUrl: "https://account.example/v1", openRouterApiKey: "account-secret" },
			clone: { model: "clone/local-model" },
			baseUrlOverride: { kind: "account_default" },
			credentialMode: "account_default",
			expectedBaseUrl: "https://account.example/v1",
			expectedModel: "clone/local-model",
			expectedCredentialAvailable: true,
		},
		{
			name: "explicit clone base and key",
			owner: {},
			clone: { model: "clone/local-model", baseUrl: "https://clone.example/v1", openRouterApiKey: "clone-secret" },
			baseUrlOverride: { kind: "value", value: "https://clone.example/v1" },
			credentialMode: "value",
			expectedBaseUrl: "https://clone.example/v1",
			expectedModel: "clone/local-model",
			expectedCredentialAvailable: true,
		},
	] as const;

	for (const scenario of cloneProviderScenarios) {
		it(`matches legacy linked local-model clone resolution for ${scenario.name}`, async () => {
			await seedOwnerInferenceSettings(scenario.owner);
			await seedWorldWithoutImageSettings();
			const source = migrationBot("bot_m_source", "matrix-source", {
				model: "source/model",
				baseUrl: "https://source.example/v1",
				openRouterApiKey: "source-only-secret",
			});
			const clone = migrationBot("bot_m_clone", "matrix-clone", { ...scenario.clone }, source);
			await seedBot(source);
			await seedBot(clone);
			await seedLinkedClone(clone, source);

			await migrateToCutover(deploymentEnv);

			const cloneConfigurationId = await botConfigurationId(clone.id);
			expect(await configurationOverrides(cloneConfigurationId)).toMatchObject({ baseUrl: scenario.baseUrlOverride });
			expect((await credential(cloneConfigurationId))?.mode).toBe(scenario.credentialMode);
			const canonical = await canonicalBotInference(testEnv.BICKR_D1, ownerId, clone.id, deploymentEnv);
			const legacy = resolveBotProviderSettings(
				{ inferenceSettings: clone.inferenceSettings },
				{ inferenceSettings: (await ownerDocument()).inferenceSettings },
				providerEnvironmentSettingsFromBindings(deploymentEnv),
			).settings;
			expect(canonical?.providerSettings.baseUrl).toBe(scenario.expectedBaseUrl);
			expect(canonical?.providerSettings.baseUrl).toBe(legacy.baseUrl);
			expect(canonical?.providerSettings.model).toBe(scenario.expectedModel);
			expect(canonical?.providerSettings.model).toBe(legacy.model);
			expect(canonical?.resolution.effective.credential.kind === "available")
				.toBe(scenario.expectedCredentialAvailable);
			expect(Boolean(canonical?.providerSettings.apiKey)).toBe(Boolean(legacy.apiKey));
			// The source secret is never reachable from the clone, whatever the
			// account or clone supplied.
			expect(canonical?.providerSettings.apiKey).not.toBe("source-only-secret");
		});
	}

	const cloneActivationWrites = [
		{ name: "a model-only legacy write", settings: { model: "clone/written-model" } },
		{ name: "a legacy write that also clears the base URL", settings: { model: "clone/written-model", baseUrl: null } },
	] as const;

	for (const activation of cloneActivationWrites) {
		it(`couples both linked-clone barriers for ${activation.name}`, async () => {
			await seedOwnerInferenceSettings({ openRouterApiKey: "account-secret" });
			await seedWorldWithoutImageSettings();
			const source = migrationBot("bot_w_source", "writer-source", {
				model: "source/model",
				baseUrl: "https://source.example/v1",
				openRouterApiKey: "source-only-secret",
			});
			const clone = migrationBot("bot_w_clone", "writer-clone", {}, source);
			await seedBot(source);
			await seedBot(clone);
			await seedLinkedClone(clone, source);
			await migrateToCutover(deploymentEnv);

			const cloneConfigurationId = await botConfigurationId(clone.id);
			expect(await configurationOverrides(cloneConfigurationId)).toEqual({});
			await leaveMaintenance();
			expect(await patchBotInferenceSettings(clone.id, activation.settings)).toBe(200);

			// The local model made the whole local bundle live, so neither barrier
			// may still route through the source even though the legacy request
			// named no URL and no key.
			expect(await configurationOverrides(cloneConfigurationId)).toMatchObject({
				model: { kind: "value", value: "clone/written-model" },
				baseUrl: { kind: "account_default" },
			});
			expect(await credential(cloneConfigurationId)).toEqual({
				mode: "account_default",
				secretValue: null,
				secretVersion: 0,
			});

			const canonical = await canonicalBotInference(testEnv.BICKR_D1, ownerId, clone.id, deploymentEnv);
			const legacy = await legacyProviderSettings(await storedBotInferenceSettings(clone.id));
			expect(canonical?.providerSettings.baseUrl).toBe(legacy.baseUrl);
			expect(canonical?.providerSettings.model).toBe(legacy.model);
			expect(canonical?.providerSettings.model).toBe("clone/written-model");
			expect(canonical?.providerSettings.apiKey).toBe(legacy.apiKey);
			expect(canonical?.providerSettings.apiKey).toBe("account-secret");
			// The source base URL and key stay unreachable from the clone.
			expect(canonical?.providerSettings.baseUrl).not.toBe("https://source.example/v1");
			expect(canonical?.providerSettings.apiKey).not.toBe("source-only-secret");
		});
	}

	it("returns both linked-clone barriers to the source when a legacy write clears the local model", async () => {
		await seedOwnerInferenceSettings({ openRouterApiKey: "account-secret" });
		await seedWorldWithoutImageSettings();
		const source = migrationBot("bot_w_source", "writer-source", {
			model: "source/model",
			baseUrl: "https://source.example/v1",
			openRouterApiKey: "source-only-secret",
		});
		// The clone holds a local key as well as a local model, so the transition
		// has a secret to mishandle: its own key is another state that skips the
		// source, and a dormant clone never consulted it.
		const clone = migrationBot("bot_w_clone", "writer-clone", {
			model: "clone/local-model",
			openRouterApiKey: "clone-secret",
		}, source);
		await seedBot(source);
		await seedBot(clone);
		await seedLinkedClone(clone, source);
		await migrateToCutover(deploymentEnv);

		const cloneConfigurationId = await botConfigurationId(clone.id);
		expect(await configurationOverrides(cloneConfigurationId)).toMatchObject({ baseUrl: { kind: "account_default" } });
		expect((await credential(cloneConfigurationId))?.mode).toBe("value");
		await leaveMaintenance();
		expect(await patchBotInferenceSettings(clone.id, { model: null })).toBe(200);
		expect(await storedBotInferenceSettings(clone.id)).toMatchObject({ openRouterApiKey: "clone-secret" });

		// The clone is dormant again, so none of the states that bypassed the
		// source may survive the transition that ended the local bundle — including
		// the retained local key. An inherited field is stored as an absent key.
		const dormantOverrides = await configurationOverrides(cloneConfigurationId);
		expect(dormantOverrides).not.toHaveProperty("model");
		expect(dormantOverrides).not.toHaveProperty("baseUrl");
		expect(await credential(cloneConfigurationId)).toEqual({
			mode: "inherit",
			secretValue: null,
			secretVersion: 0,
		});

		const canonical = await canonicalBotInference(testEnv.BICKR_D1, ownerId, clone.id, deploymentEnv);
		// A dormant linked clone read its source's whole bundle, so the source
		// document is what legacy resolution saw through the clone.
		const legacy = await legacyProviderSettings(source.inferenceSettings);
		expect(canonical?.providerSettings.baseUrl).toBe(legacy.baseUrl);
		expect(canonical?.providerSettings.baseUrl).toBe("https://source.example/v1");
		expect(canonical?.providerSettings.model).toBe(legacy.model);
		expect(canonical?.providerSettings.apiKey).toBe(legacy.apiKey);
		expect(canonical?.providerSettings.apiKey).toBe("source-only-secret");
	});

	it("keeps a linked clone's own key when a model-only legacy write activates it", async () => {
		await seedOwnerInferenceSettings({ openRouterApiKey: "account-secret" });
		await seedWorldWithoutImageSettings();
		const source = migrationBot("bot_w_source", "writer-source", {
			model: "source/model",
			baseUrl: "https://source.example/v1",
			openRouterApiKey: "source-only-secret",
		});
		const clone = migrationBot("bot_w_clone", "writer-clone", { openRouterApiKey: "clone-secret" }, source);
		await seedBot(source);
		await seedBot(clone);
		await seedLinkedClone(clone, source);
		await migrateToCutover(deploymentEnv);

		const cloneConfigurationId = await botConfigurationId(clone.id);
		// While dormant the clone read its source's whole bundle, so migration must
		// not pin it to its own unused key either. Parity cannot see this on its
		// own: providerParityEnvelope compares only credentialAvailable, and both
		// sides have some key.
		expect((await credential(cloneConfigurationId))?.mode).toBe("inherit");
		expect((await canonicalBotInference(testEnv.BICKR_D1, ownerId, clone.id, deploymentEnv))?.providerSettings.apiKey)
			.toBe("source-only-secret");
		await leaveMaintenance();
		expect(await patchBotInferenceSettings(clone.id, { model: "clone/written-model" })).toBe(200);

		// Coupling the credential barrier must not discard a local key the legacy
		// request never mentioned.
		expect(await configurationOverrides(cloneConfigurationId)).toMatchObject({ baseUrl: { kind: "account_default" } });
		expect(await credential(cloneConfigurationId)).toMatchObject({ mode: "value", secretValue: "clone-secret" });
		const canonical = await canonicalBotInference(testEnv.BICKR_D1, ownerId, clone.id, deploymentEnv);
		const legacy = await legacyProviderSettings(await storedBotInferenceSettings(clone.id));
		expect(canonical?.providerSettings.apiKey).toBe(legacy.apiKey);
		expect(canonical?.providerSettings.apiKey).toBe("clone-secret");
	});

	it("leaves both linked-clone barriers alone on a legacy write that omits the model", async () => {
		await seedOwnerInferenceSettings({ openRouterApiKey: "account-secret" });
		await seedWorldWithoutImageSettings();
		const source = migrationBot("bot_w_source", "writer-source", {
			model: "source/model",
			baseUrl: "https://source.example/v1",
			openRouterApiKey: "source-only-secret",
		});
		const clone = migrationBot("bot_w_clone", "writer-clone", {}, source);
		await seedBot(source);
		await seedBot(clone);
		await seedLinkedClone(clone, source);
		await migrateToCutover(deploymentEnv);

		const cloneConfigurationId = await botConfigurationId(clone.id);
		await leaveMaintenance();
		expect(await patchBotInferenceSettings(clone.id, { temperature: 0.25 })).toBe(200);

		expect(await configurationOverrides(cloneConfigurationId)).toEqual({ temperature: { kind: "value", value: 0.25 } });
		expect((await credential(cloneConfigurationId))?.mode).toBe("inherit");
	});

	it("refuses to start outside explicit maintenance", async () => {
		await testEnv.BICKR_D1.prepare(
			`UPDATE maintenance_control SET enabled = 0, activated_at = NULL, updated_at = ? WHERE id = 1`,
		).bind(now).run();
		await expect(runInferenceGraphMigrationStep(testEnv, ownerId, now)).rejects.toMatchObject({ code: "conflict", status: 409 });
		expect(await inferenceGraphMigrationStatus(testEnv.BICKR_D1, ownerId)).toBeNull();
	});
});

const deploymentEnv = {
	OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1/chat/completions",
	OPENROUTER_MODEL: "deployment/model",
	OPENROUTER_API_KEY: "deployment-secret",
} as const;

async function migrateToCutover(env: Record<string, unknown>): Promise<void> {
	const migrationEnv = { ...env, BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV } as never;
	let result = await runInferenceGraphMigrationStep(migrationEnv, ownerId, now);
	for (let attempt = 0; attempt < 15 && !result.complete; attempt += 1) {
		result = await runInferenceGraphMigrationStep(
			migrationEnv,
			ownerId,
			new Date(Date.parse(now) + attempt + 1).toISOString(),
		);
	}
	expect(result).toMatchObject({ complete: true, phase: "terminal", writerVersion: 1, cutoverVersion: 1 });
}

async function leaveMaintenance(): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`UPDATE maintenance_control SET enabled = 0, activated_at = NULL, updated_at = ? WHERE id = 1`,
	).bind("2026-08-04T00:03:00.000Z").run();
}

async function patchBotInferenceSettings(botId: string, inferenceSettings: Record<string, unknown>): Promise<number> {
	const response = await handleAgentRuntimeRequest(new Request(
		`https://agent.internal/users/${ownerId}/bots/${botId}`,
		{
			method: "PATCH",
			headers: { "content-type": "application/json", "x-bickr-user-id": ownerId },
			body: JSON.stringify({ inferenceSettings }),
		},
	), testEnv, { objectId: "user-coordinator-test", ownerUserId: ownerId });
	return response.status;
}

async function storedBotInferenceSettings(botId: string): Promise<BotDocument["inferenceSettings"]> {
	const bot = await readJson<BotDocument>(testEnv.BICKR_KV, kvKeys.bot(botId));
	if (!bot) throw new Error(`Expected a stored participant document for ${botId}.`);
	return bot.inferenceSettings;
}

async function legacyProviderSettings(settings: BotDocument["inferenceSettings"]) {
	return resolveBotProviderSettings(
		{ inferenceSettings: settings },
		{ inferenceSettings: (await ownerDocument()).inferenceSettings },
		providerEnvironmentSettingsFromBindings(deploymentEnv),
	).settings;
}

async function ownerDocument(): Promise<UserDocument> {
	const user = await readJson<UserDocument>(testEnv.BICKR_KV, kvKeys.user(ownerId));
	if (!user) throw new Error("Expected a seeded migration owner document.");
	return user;
}

async function seedOwnerInferenceSettings(inferenceSettings: UserDocument["inferenceSettings"]): Promise<void> {
	await writeJson(testEnv.BICKR_KV, kvKeys.user(ownerId), { ...migrationUser(), inferenceSettings });
}

/**
 * The matrix isolates base-URL and credential provenance, so its world carries
 * no image settings; owner-selected image models have their own authorization
 * rule that is exercised by the main migration fixture.
 */
async function seedWorldWithoutImageSettings(): Promise<void> {
	const { imageGeneration: _imageGeneration, ...world } = migrationWorld();
	await worldIndexProjectionStatement(testEnv.BICKR_D1, world).run();
	await writeJson(testEnv.BICKR_KV, kvKeys.world(worldId), world);
}

async function seedBot(bot: BotDocument): Promise<void> {
	await seedActiveClaim("bot_handle", worldId, bot.handle, "bot", bot.id, ownerId);
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO bots_index (
			bot_id, home_world_id, home_world_handle, handle, display_name,
			owner_user_id, short_bio, created_at, updated_at, lifecycle_state
		) VALUES (?, ?, 'migration-world', ?, ?, ?, ?, ?, ?, 'active')`,
	).bind(bot.id, worldId, bot.handle, bot.displayName.text, ownerId, bot.shortBio.text, now, now).run();
	await writeJson(testEnv.BICKR_KV, kvKeys.bot(bot.id), bot);
}

async function seedLinkedClone(clone: BotDocument, source: BotDocument): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO bot_clone_sources (
			bot_id, source_bot_id, source_world_id, source_world_handle,
			source_handle, cloned_at, linked
		) VALUES (?, ?, ?, 'migration-world', ?, ?, 1)`,
	).bind(clone.id, source.id, worldId, source.handle, now).run();
}

async function seedActiveClaim(
	kind: "user_handle" | "world_handle" | "bot_handle",
	scope: string,
	value: string,
	entityKind: "account" | "world" | "bot",
	entityId: string,
	ownerUserId: string,
): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO entity_lifecycle_identity_claims (
			key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
			claim_state, operation_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
	).bind(kind, scope, value, entityKind, entityId, ownerUserId, now, now).run();
}

function migrationUser(): UserDocument {
	return {
		id: ownerId,
		type: "user",
		schemaVersion,
		revision: 1,
		handle: "migration-owner",
		language: en,
		displayName: localizedText("Migration Owner", en),
		inferenceSettings: {
			baseUrl: "https://openrouter.ai/api/v1",
			model: "owner/default-model",
			openRouterApiKey: "account-secret",
			translation: {
				enabled: true,
				model: "translator/model",
				prompt: localizedText("Translate exactly", en),
			},
		},
		createdAt: now,
		updatedAt: now,
	};
}

function migrationWorld(): WorldDocument {
	return {
		id: worldId,
		type: "world",
		schemaVersion,
		revision: 1,
		handle: "migration-world",
		language: en,
		name: localizedText("Migration World", en),
		description: localizedText("A migration test world", en),
		prompt: localizedText("Preserve world prompt", en),
		recurringPromptEnabled: false,
		recurringPrompt: localizedText("", en),
		imageGeneration: { model: "image/model", aspectRatio: "21:9", temperature: 0 },
		initialBotNotification: localizedText("", en),
		createdByUserId: ownerId,
		visibility: "public",
		createdAt: now,
		updatedAt: now,
	};
}

function migrationBot(
	id: string,
	handle: string,
	inferenceSettings: BotDocument["inferenceSettings"],
	cloneSource?: BotDocument,
): BotDocument {
	return {
		id,
		type: "bot",
		schemaVersion,
		revision: 1,
		homeWorldId: worldId,
		homeWorldHandle: "migration-world",
		ownerUserId: ownerId,
		handle,
		language: en,
		includeLanguageInSystemPrompt: false,
		displayName: localizedText(handle, en),
		shortBio: localizedText("Migration bot", en),
		prompt: localizedText("Preserve participant prompt", en),
		inferenceSettings,
		toolSettings: {},
		tickSettings: { enabled: false, intervalSeconds: 86_400, compactionThreshold: 0.75 },
		...(cloneSource ? {
			cloneSource: {
				sourceBotId: cloneSource.id,
				sourceWorldId: cloneSource.homeWorldId,
				sourceWorldHandle: cloneSource.homeWorldHandle,
				sourceHandle: cloneSource.handle,
				clonedAt: now,
				linked: true,
			},
		} : {}),
		createdAt: now,
		updatedAt: now,
	};
}

async function configuration(id: string) {
	return testEnv.BICKR_D1.prepare(
		`SELECT kind, parent_id AS parentId, overrides_json AS overridesJson, revision
		 FROM inference_configurations WHERE configuration_id = ?`,
	).bind(id).first<{ kind: string; parentId: string | null; overridesJson: string; revision: number }>();
}

async function configurationOverrides(id: string): Promise<Record<string, unknown>> {
	const row = await configuration(id);
	if (!row) throw new Error(`Expected inference configuration ${id}.`);
	return JSON.parse(row.overridesJson) as Record<string, unknown>;
}

async function credential(id: string) {
	return testEnv.BICKR_D1.prepare(
		`SELECT mode, secret_value AS secretValue, secret_version AS secretVersion
		 FROM inference_configuration_credentials WHERE configuration_id = ?`,
	).bind(id).first<{ mode: string; secretValue: string | null; secretVersion: number }>();
}
