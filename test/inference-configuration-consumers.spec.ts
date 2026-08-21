import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	canonicalBotInference,
	canonicalTranslationInferenceAnnotation,
	translationToolCallStrategy,
} from "@bickr/shared/inference-configuration-consumers";
import {
	inferenceConfigurationMutations,
	insertAccountDefaultConfigurationStatement,
	insertFixedConfigurationStatement,
	insertTranslationInferencePointerStatement,
} from "@bickr/shared/inference-configuration-repository";
import { translationInferenceLifecycle } from "@bickr/shared/inference-translation-role";
import {
	accountDefaultConfigurationId,
	botConfigurationId,
	worldConfigurationId,
} from "@bickr/shared/inference-configuration-repository";
import { localizedText, schemaVersion, type BotDocument, type LanguageTag, type UserDocument, type WorldDocument } from "@bickr/shared/model";
import { userIndexProjectionStatement, worldIndexProjectionStatement } from "@bickr/shared/repository";
import { kvKeys, writeJson, type D1DatabaseLike } from "@bickr/shared/storage";
import {
	effectiveProviderSettingsForAvatarImageGeneration,
	resolveAvatarTarget,
} from "../workers/agent-runtime/src/avatar/target";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";

const now = "2026-08-04T00:00:00.000Z";
const ownerId = "usr_consumer";
const worldId = "wld_consumer";
const botId = "bot_consumer";
const en = "en" as LanguageTag;

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
	await seedClaim("user_handle", "global", "consumer", "account", ownerId);
	await userIndexProjectionStatement(testEnv.BICKR_D1, user()).run();
	await writeJson(testEnv.BICKR_KV, kvKeys.user(ownerId), user());
	await seedClaim("world_handle", "global", "consumer-world", "world", worldId);
	await worldIndexProjectionStatement(testEnv.BICKR_D1, world()).run();
	await writeJson(testEnv.BICKR_KV, kvKeys.world(worldId), world());
	await seedClaim("bot_handle", worldId, "consumer-bot", "bot", botId);
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO bots_index (
			bot_id, home_world_id, home_world_handle, handle, display_name,
			owner_user_id, short_bio, created_at, updated_at, lifecycle_state
		) VALUES (?, ?, 'consumer-world', 'consumer-bot', 'Consumer bot', ?, 'Bio', ?, ?, 'active')`,
	).bind(botId, worldId, ownerId, now, now).run();
	await writeJson(testEnv.BICKR_KV, kvKeys.bot(botId), bot());

	const rootId = await accountDefaultConfigurationId(ownerId);
	await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
		insertAccountDefaultConfigurationStatement(testEnv.BICKR_D1, {
			configurationId: rootId,
			ownerUserId: ownerId,
			now,
			overrides: {
				baseUrl: { kind: "value", value: "https://provider.example/v1" },
				model: { kind: "value", value: "owner/account-model" },
				toolCalls: { kind: "value", value: { kind: "strategy", strategy: "at_will" } },
				compactionReasoning: { kind: "value", value: { kind: "explicit_effort", effort: "high" } },
				imageModel: { kind: "value", value: "owner/account-image" },
			},
		}),
		insertTranslationInferencePointerStatement(testEnv.BICKR_D1, { ownerUserId: ownerId, configurationId: rootId, now }),
		insertFixedConfigurationStatement(testEnv.BICKR_D1, {
			kind: "world",
			configurationId: await worldConfigurationId(worldId),
			ownerUserId: ownerId,
			parentId: rootId,
			worldId,
			now,
			overrides: { imageModel: { kind: "value", value: "owner/world-image" } },
		}),
		insertFixedConfigurationStatement(testEnv.BICKR_D1, {
			kind: "bot",
			configurationId: await botConfigurationId(botId),
			ownerUserId: ownerId,
			parentId: rootId,
			botId,
			now,
			overrides: {
				imageModel: { kind: "value", value: "owner/bot-image" },
				imageAspectRatio: { kind: "explicit_none" },
			},
		}),
	]);
});

describe("canonical inference consumers", () => {
	it("chooses graph reads only from stored cutover version and invalidates translation fingerprints", async () => {
		expect(await canonicalBotInference(testEnv.BICKR_D1, ownerId, botId, {})).toBeNull();
		await enableCutover();
		const canonical = await canonicalBotInference(testEnv.BICKR_D1, ownerId, botId, {});
		expect(canonical?.providerSettings).toMatchObject({
			baseUrl: "https://provider.example/v1",
			model: "owner/account-model",
		});
		expect(translationToolCallStrategy(canonical!.providerSettings.toolCalls)).toBe("railroad");
		expect(canonical?.resolution.effective.compactionReasoning).toMatchObject({
			kind: "selected",
			selection: { kind: "explicit_effort", effort: "high" },
		});
		expect(canonical?.providerSettings.compactionReasoning).toEqual({ kind: "explicit_effort", effort: "high" });

		expect(await canonicalTranslationInferenceAnnotation(testEnv.BICKR_D1, ownerId, {}, false)).toEqual({ enabled: false });
		await translationInferenceLifecycle.enable(testEnv.BICKR_D1, ownerId);
		const first = await canonicalTranslationInferenceAnnotation(testEnv.BICKR_D1, ownerId, {}, false);
		expect(first).toMatchObject({
			enabled: true,
			displayName: "Translation",
			effectiveModel: "owner/account-model",
			credentialAvailable: false,
		});
		if (!first?.enabled || first.migrationPending) throw new Error("Canonical Translation annotation fixture was not enabled");
		const rootId = await accountDefaultConfigurationId(ownerId);
		await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: rootId,
			expectedRevision: 1,
			overrides: { temperature: { kind: "value", value: 0 } },
		});
		const second = await canonicalTranslationInferenceAnnotation(testEnv.BICKR_D1, ownerId, {}, false);
		if (!second?.enabled || second.migrationPending) throw new Error("Canonical Translation annotation unexpectedly unavailable");
		expect(second.effectiveRevisionFingerprint).not.toBe(first.effectiveRevisionFingerprint);
		const parent = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Translation reparent source",
			parentId: rootId,
			overrides: { model: { kind: "value", value: "owner/reparented-translation" } },
		});
		await inferenceConfigurationMutations.reparent(testEnv.BICKR_D1, ownerId, {
			configurationId: first.configurationId,
			parentId: parent.id,
			expectedRevision: 1,
		});
		const reparented = await canonicalTranslationInferenceAnnotation(testEnv.BICKR_D1, ownerId, {}, false);
		if (!reparented?.enabled || reparented.migrationPending) throw new Error("Canonical Translation annotation unexpectedly unavailable after reparent");
		expect(reparented.configurationId).toBe(first.configurationId);
		expect(reparented.effectiveModel).toBe("owner/reparented-translation");
		expect(reparented.effectiveRevisionFingerprint).not.toBe(second.effectiveRevisionFingerprint);
		const credentialA = await canonicalBotInference(testEnv.BICKR_D1, ownerId, botId, { OPENROUTER_API_KEY: "secret-a" });
		const credentialB = await canonicalBotInference(testEnv.BICKR_D1, ownerId, botId, { OPENROUTER_API_KEY: "secret-b" });
		expect(credentialA?.fingerprint).toBe(credentialB?.fingerprint);
	});

	it("uses Account, participant, and world fixed image fields with target-specific defaults", async () => {
		await enableCutover();
		const accountTarget = await resolveAvatarTarget(testEnv, { kind: "user", userId: ownerId }, "generate");
		const botTarget = await resolveAvatarTarget(testEnv, { kind: "bot", userId: ownerId, botId }, "generate");
		const worldTarget = await resolveAvatarTarget(testEnv, { kind: "world", userId: ownerId, worldHandle: "consumer-world" }, "generate");
		expect(effectiveProviderSettingsForAvatarImageGeneration(accountTarget, {})).toEqual(expect.objectContaining({
			model: "owner/account-image",
		}));
		expect(effectiveProviderSettingsForAvatarImageGeneration(accountTarget, {})).not.toHaveProperty("aspectRatio");
		expect(effectiveProviderSettingsForAvatarImageGeneration(botTarget, {})).toEqual(expect.objectContaining({
			model: "owner/bot-image",
		}));
		expect(effectiveProviderSettingsForAvatarImageGeneration(botTarget, {})).not.toHaveProperty("aspectRatio");
		expect(effectiveProviderSettingsForAvatarImageGeneration(worldTarget, {})).toEqual(expect.objectContaining({
			model: "owner/world-image",
		}));
		expect(effectiveProviderSettingsForAvatarImageGeneration(worldTarget, {})).not.toHaveProperty("aspectRatio");
		// A request-carried bundle overlays the resolved fields for this one
		// request. The model it names is owner-selected and this owner supplies
		// a provider, so it is honored; fields the bundle leaves out still
		// resolve through the graph.
		expect(effectiveProviderSettingsForAvatarImageGeneration(accountTarget, {}, {
			model: "owner/request-model",
		})).toMatchObject({ model: "owner/request-model", baseUrl: "https://provider.example/v1" });
		expect(effectiveProviderSettingsForAvatarImageGeneration(botTarget, {}, {
			aspectRatio: "16:9",
			temperature: 0.4,
		})).toMatchObject({ model: "owner/bot-image", aspectRatio: "16:9", temperature: 0.4 });
	});

	it("keeps a Bickr target-default image model available while an owner-stored one still needs an owner provider", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const botConfiguration = await botConfigurationId(botId);
		// Strip the owner provider so only the deployment supplies base URL and key.
		await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: rootId,
			expectedRevision: 1,
			overrides: { baseUrl: { kind: "inherit" }, model: { kind: "inherit" }, imageModel: { kind: "inherit" } },
		}, now);
		await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: botConfiguration,
			expectedRevision: 1,
			overrides: { baseUrl: { kind: "account_default" }, imageModel: { kind: "target_default" } },
		}, now);
		await enableCutover();
		const env = { ...testEnv, OPENROUTER_API_KEY: "deployment-only-secret" };

		const targetDefaultTarget = await resolveAvatarTarget(env, { kind: "bot", userId: ownerId, botId }, "generate");
		const targetDefaultSettings = effectiveProviderSettingsForAvatarImageGeneration(targetDefaultTarget, env);
		// target_default names Bickr's own participant default, so it is not an
		// owner-selected model and the deployment provider may still run it.
		expect(targetDefaultSettings?.model).toBeTruthy();
		expect(targetDefaultSettings?.apiKey).toBe("deployment-only-secret");

		const historicalModel = "google/gemini-3.1-flash-image-preview";
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_configurations
			 SET overrides_json = ?, revision = revision + 1, updated_at = ?
			 WHERE configuration_id = ?`,
		).bind(JSON.stringify({
			baseUrl: { kind: "account_default" },
			imageModel: { kind: "historical_bickr_default", value: historicalModel },
		}), now, botConfiguration).run();
		const historicalTarget = await resolveAvatarTarget(env, { kind: "bot", userId: ownerId, botId }, "generate");
		expect(effectiveProviderSettingsForAvatarImageGeneration(historicalTarget, env)).toMatchObject({
			apiKey: "deployment-only-secret",
			model: historicalModel,
		});

		// The owner-facing value projection is safe to resubmit unchanged; a real
		// value change becomes owner provenance and loses deployment authorization.
		await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: botConfiguration,
			expectedRevision: 3,
			overrides: { imageModel: { kind: "value", value: historicalModel } },
		}, now);
		const preservedTarget = await resolveAvatarTarget(env, { kind: "bot", userId: ownerId, botId }, "generate");
		expect(effectiveProviderSettingsForAvatarImageGeneration(preservedTarget, env)?.apiKey)
			.toBe("deployment-only-secret");

		await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: botConfiguration,
			expectedRevision: 4,
			overrides: { imageModel: { kind: "value", value: `${historicalModel}:free` } },
		}, now);
		const ownerModelTarget = await resolveAvatarTarget(env, { kind: "bot", userId: ownerId, botId }, "generate");
		expect(effectiveProviderSettingsForAvatarImageGeneration(ownerModelTarget, env)).toBeNull();

		// A request-carried model is owner-selected by definition, so the
		// deployment-only provider may not run it; a parameter-only bundle still
		// overlays the deployment-authorized target default.
		expect(effectiveProviderSettingsForAvatarImageGeneration(preservedTarget, env, {
			model: "owner/request-model",
		})).toBeNull();
		expect(effectiveProviderSettingsForAvatarImageGeneration(preservedTarget, env, {
			aspectRatio: "16:9",
		})).toMatchObject({ aspectRatio: "16:9", apiKey: "deployment-only-secret", model: historicalModel });
	});

	it("never forwards the deployment credential through owner provider settings or avatar targets", async () => {
		await enableCutover();
		await translationInferenceLifecycle.enable(testEnv.BICKR_D1, ownerId);
		const env = {
			...testEnv,
			OPENROUTER_API_KEY: "global-only-secret",
		};
		const canonical = await canonicalBotInference(env.BICKR_D1, ownerId, botId, env);
		expect(canonical?.providerSettings).not.toHaveProperty("apiKey");
		expect(canonical?.resolution.effective.credential).toMatchObject({
			kind: "unavailable",
			reason: "deployment_credential_suppressed_for_owner_base_url",
		});
		expect(await canonicalTranslationInferenceAnnotation(env.BICKR_D1, ownerId, env, false))
			.toMatchObject({ credentialAvailable: false });
		const targets = [
			await resolveAvatarTarget(env, { kind: "user", userId: ownerId }, "generate"),
			await resolveAvatarTarget(env, { kind: "bot", userId: ownerId, botId }, "generate"),
			await resolveAvatarTarget(env, { kind: "world", userId: ownerId, worldHandle: "consumer-world" }, "generate"),
		];
		for (const target of targets) {
			expect(effectiveProviderSettingsForAvatarImageGeneration(target, env)).not.toHaveProperty("apiKey");
		}
	});
});

async function enableCutover(): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`UPDATE inference_graph_users
		 SET writer_version = 1, cutover_version = 1, verified_cutover_at = ?, updated_at = ?
		 WHERE owner_user_id = ?`,
	).bind(now, now, ownerId).run();
}

async function seedClaim(
	kind: "user_handle" | "world_handle" | "bot_handle",
	scope: string,
	value: string,
	entityKind: "account" | "world" | "bot",
	entityId: string,
): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO entity_lifecycle_identity_claims (
			key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
			claim_state, operation_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
	).bind(kind, scope, value, entityKind, entityId, ownerId, now, now).run();
}

function user(): UserDocument {
	return {
		id: ownerId,
		type: "user",
		schemaVersion,
		revision: 1,
		handle: "consumer",
		language: en,
		displayName: localizedText("Consumer", en),
		inferenceSettings: { imageGeneration: { model: "legacy/account-image" } },
		createdAt: now,
		updatedAt: now,
	};
}

function world(): WorldDocument {
	return {
		id: worldId,
		type: "world",
		schemaVersion,
		revision: 1,
		handle: "consumer-world",
		language: en,
		name: localizedText("Consumer world", en),
		description: localizedText("Description", en),
		prompt: localizedText("World prompt remains on the world", en),
		recurringPromptEnabled: false,
		recurringPrompt: localizedText("", en),
		imageGeneration: { model: "legacy/world-image", prompt: localizedText("Image prompt remains here", en) },
		initialBotNotification: localizedText("", en),
		createdByUserId: ownerId,
		visibility: "public",
		createdAt: now,
		updatedAt: now,
	};
}

function bot(): BotDocument {
	return {
		id: botId,
		type: "bot",
		schemaVersion,
		revision: 1,
		homeWorldId: worldId,
		homeWorldHandle: "consumer-world",
		ownerUserId: ownerId,
		handle: "consumer-bot",
		language: en,
		includeLanguageInSystemPrompt: false,
		displayName: localizedText("Consumer bot", en),
		shortBio: localizedText("Bio", en),
		prompt: localizedText("Participant prompt remains here", en),
		inferenceSettings: { imageGeneration: { model: "legacy/bot-image" } },
		toolSettings: {},
		tickSettings: { enabled: false, intervalSeconds: 86_400, compactionThreshold: 0.75 },
		createdAt: now,
		updatedAt: now,
	};
}
