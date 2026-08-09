import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	accountDefaultConfigurationId,
	insertAccountDefaultConfigurationStatement,
	insertTranslationInferencePointerStatement,
} from "@bickr/shared/inference-configuration-repository";
import { translationInferenceLifecycle } from "@bickr/shared/inference-translation-role";
import { localizedText, schemaVersion, type LanguageTag, type UserDocument } from "@bickr/shared/model";
import { userIndexProjectionStatement } from "@bickr/shared/repository";
import { kvKeys, writeJson, type D1DatabaseLike } from "@bickr/shared/storage";
import { translateForUser } from "../workers/agent-runtime/src/runtime/bot-runtime";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";

const now = "2026-08-09T00:00:00.000Z";
const ownerId = "usr_translation_runtime";
const en = "en" as LanguageTag;

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO entity_lifecycle_identity_claims (
			key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
			claim_state, operation_id, created_at, updated_at
		) VALUES ('user_handle', 'global', 'translation-runtime', 'account', ?, ?, 'active', NULL, ?, ?)`,
	).bind(ownerId, ownerId, now, now).run();
	await userIndexProjectionStatement(testEnv.BICKR_D1, user(false)).run();
	await writeJson(testEnv.BICKR_KV, kvKeys.user(ownerId), user(false));
	const rootId = await accountDefaultConfigurationId(ownerId);
	await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
		insertAccountDefaultConfigurationStatement(testEnv.BICKR_D1, {
			configurationId: rootId,
			ownerUserId: ownerId,
			now,
			overrides: {
				baseUrl: { kind: "value", value: "https://provider.example/v1" },
				model: { kind: "value", value: "canonical/translation-model" },
			},
		}),
		insertTranslationInferencePointerStatement(testEnv.BICKR_D1, { ownerUserId: ownerId, configurationId: rootId, now }),
	]);
	await testEnv.BICKR_D1.prepare(
		`UPDATE inference_graph_users
		 SET writer_version = 1, cutover_version = 1, verified_cutover_at = ?, updated_at = ?
		 WHERE owner_user_id = ?`,
	).bind(now, now, ownerId).run();
});

describe("translation runtime authority", () => {
	it("uses the fixed role instead of stale KV enablement in both directions", async () => {
		await translationInferenceLifecycle.enable(testEnv.BICKR_D1, ownerId, now);
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(async () => Response.json({
			choices: [{
				message: {
					content: "",
					tool_calls: [{
						id: "call_translation",
						type: "function",
						function: { name: "save_translation", arguments: JSON.stringify({ translation: "Bonjour" }) },
					}],
				},
			}],
		}));
		vi.stubGlobal("fetch", fetchMock);
		try {
			expect(await translateForUser(runtimeEnv(), ownerId, "Hello")).toBe("Bonjour");
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
				model?: string;
				messages?: Array<{ role?: string; content?: string }>;
			};
			expect(body.model).toBe("canonical/translation-model");
			expect(body.messages?.[0]?.content).toContain("Profile-owned translation prompt");

			await translationInferenceLifecycle.disable(testEnv.BICKR_D1, ownerId, now);
			await writeJson(testEnv.BICKR_KV, kvKeys.user(ownerId), user(true));
			fetchMock.mockClear();
			await expect(translateForUser(runtimeEnv(), ownerId, "Hello"))
				.rejects.toThrow("Enable inline translations");
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});
});

function runtimeEnv() {
	return {
		BICKR_D1: testEnv.BICKR_D1,
		BICKR_KV: testEnv.BICKR_KV,
		OPENROUTER_API_KEY: "",
		OPENROUTER_BASE_URL: "https://deployment-provider.example/v1",
		OPENROUTER_MODEL: "deployment/model",
	};
}

function user(enabled: boolean): UserDocument {
	return {
		id: ownerId,
		type: "user",
		schemaVersion,
		revision: 1,
		handle: "translation-runtime",
		language: en,
		displayName: localizedText("Translation runtime", en),
		inferenceSettings: {
			translation: {
				enabled,
				prompt: localizedText("Profile-owned translation prompt", en),
			},
		},
		createdAt: now,
		updatedAt: now,
	};
}
