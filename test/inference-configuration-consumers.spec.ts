import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	canonicalBotInference,
	canonicalTranslationInferenceAnnotation,
	translationToolCallStrategy,
} from "@bickr/shared/inference-configuration-consumers";
import {
	accountDefaultConfigurationId,
	botConfigurationId,
	inferenceConfigurationMutations,
	insertAccountDefaultConfigurationStatement,
	insertFixedConfigurationStatement,
	insertTranslationSelectionStatement,
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
		insertTranslationSelectionStatement(testEnv.BICKR_D1, { ownerUserId: ownerId, configurationId: rootId, now }),
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
		expect(canonical?.resolution.effective.compactionReasoning.kind).toBe("refused");
		expect(canonical?.providerSettings.compactionReasoning).toEqual({ kind: "explicit_effort", effort: "high" });

		const first = await canonicalTranslationInferenceAnnotation(testEnv.BICKR_D1, ownerId, {});
		expect(first).toMatchObject({
			selectedConfigurationId: await accountDefaultConfigurationId(ownerId),
			selectedDisplayName: "Account default",
			effectiveModel: "owner/account-model",
			credentialAvailable: false,
		});
		const rootId = await accountDefaultConfigurationId(ownerId);
		await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: rootId,
			expectedRevision: 1,
			overrides: { temperature: { kind: "value", value: 0 } },
		});
		const second = await canonicalTranslationInferenceAnnotation(testEnv.BICKR_D1, ownerId, {});
		expect(second?.effectiveRevisionFingerprint).not.toBe(first?.effectiveRevisionFingerprint);
		const credentialA = await canonicalBotInference(testEnv.BICKR_D1, ownerId, botId, { OPENROUTER_API_KEY: "secret-a" });
		const credentialB = await canonicalBotInference(testEnv.BICKR_D1, ownerId, botId, { OPENROUTER_API_KEY: "secret-b" });
		expect(credentialA?.fingerprint).toBe(credentialB?.fingerprint);
	});

	it("uses Account, participant, and world fixed image fields with target-specific defaults", async () => {
		await enableCutover();
		const accountTarget = await resolveAvatarTarget(testEnv, { kind: "user", userId: ownerId }, "generate");
		const botTarget = await resolveAvatarTarget(testEnv, { kind: "bot", userId: ownerId, botId }, "generate");
		const worldTarget = await resolveAvatarTarget(testEnv, { kind: "world", userId: ownerId, worldHandle: "consumer-world" }, "generate");
		expect(effectiveProviderSettingsForAvatarImageGeneration(accountTarget, {})).toMatchObject({
			model: "owner/account-image",
			aspectRatio: "1:1",
		});
		expect(effectiveProviderSettingsForAvatarImageGeneration(botTarget, {})).toEqual(expect.objectContaining({
			model: "owner/bot-image",
		}));
		expect(effectiveProviderSettingsForAvatarImageGeneration(botTarget, {})).not.toHaveProperty("aspectRatio");
		expect(effectiveProviderSettingsForAvatarImageGeneration(worldTarget, {})).toMatchObject({
			model: "owner/world-image",
			aspectRatio: "21:9",
		});
		expect(effectiveProviderSettingsForAvatarImageGeneration(accountTarget, {}, {
			model: "legacy/request-bypass",
		})).toMatchObject({ model: "owner/account-image" });
	});

	it("does not authorize an owner image model through only the global credential", async () => {
		await enableCutover();
		const rootId = await accountDefaultConfigurationId(ownerId);
		await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: rootId,
			expectedRevision: 1,
			overrides: { baseUrl: { kind: "inherit" } },
			credential: { mode: "none" },
		});
		const accountTarget = await resolveAvatarTarget({
			...testEnv,
			OPENROUTER_API_KEY: "global-only-secret",
		}, { kind: "user", userId: ownerId }, "generate");
		expect(effectiveProviderSettingsForAvatarImageGeneration(accountTarget, {})).toBeNull();
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
