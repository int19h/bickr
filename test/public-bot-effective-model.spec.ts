import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	accountDefaultConfigurationId,
	botConfigurationId,
	configurationCredentialValueStatement,
	insertAccountDefaultConfigurationStatement,
	insertFixedConfigurationStatement,
	insertTranslationInferencePointerStatement,
	worldConfigurationId,
} from "@bickr/shared/inference-configuration-repository";
import { internalServiceUrl } from "@bickr/shared/internal-service";
import {
	defaultProviderModel,
	localizedText,
	schemaVersion,
	type BotDocument,
	type BotInferenceSettings,
	type LanguageTag,
	type UserDocument,
	type WorldDocument,
} from "@bickr/shared/model";
import { userIndexProjectionStatement, worldIndexProjectionStatement } from "@bickr/shared/repository";
import { kvKeys, writeJson, type D1DatabaseLike } from "@bickr/shared/storage";
import { onRequestGet as publicEffectiveModelRoute } from "../apps/web/functions/api/worlds/[worldHandle]/bots/[botHandle]/effective-model";
import type { AppEnv } from "../apps/web/functions/api/_auth";
import { handleAgentRuntimeRequest, handleAgentRuntimeWorkerRequest } from "../workers/agent-runtime/src/routes";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";

/**
 * The public participant model boundary.
 *
 * Every viewer reads one server-resolved string. These tests pin the three
 * things that makes true — the resolution is the runtime's own, the viewer is
 * never an input, and the answer carries nothing but the model — plus the
 * not-found behavior the rest of the public profile already has and the
 * owner-only routes this boundary must not weaken.
 */

const now = "2026-08-12T00:00:00.000Z";
const ownerId = "usr_model_owner";
const otherUserId = "usr_model_visitor";
const worldId = "wld_model";
const botId = "bot_model";
const worldHandle = "model-world";
const botHandle = "model-bot";
const en = "en" as LanguageTag;
const internalSecret = "test-internal-service-secret";
const ownerSecret = "sk-owner-provider-credential";

type ModelEnvelope = {
	ok: boolean;
	error?: string;
	message?: string;
	data?: { model?: { botId?: string; effectiveModel?: string } };
};

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
	await seedClaim("user_handle", "global", "model-owner", "account", ownerId);
	await userIndexProjectionStatement(testEnv.BICKR_D1, user()).run();
	await writeJson(testEnv.BICKR_KV, kvKeys.user(ownerId), user());
	await seedClaim("user_handle", "global", "model-visitor", "account", otherUserId);
	await userIndexProjectionStatement(testEnv.BICKR_D1, user({ id: otherUserId, handle: "model-visitor" })).run();
	await writeJson(testEnv.BICKR_KV, kvKeys.user(otherUserId), user({ id: otherUserId, handle: "model-visitor" }));
	await seedClaim("world_handle", "global", worldHandle, "world", worldId);
	await worldIndexProjectionStatement(testEnv.BICKR_D1, world()).run();
	await writeJson(testEnv.BICKR_KV, kvKeys.world(worldId), world());
	await seedClaim("bot_handle", worldId, botHandle, "bot", botId);
	await seedBotIndexRow();
	await writeJson(testEnv.BICKR_KV, kvKeys.bot(botId), bot());
});

describe("public participant effective model", () => {
	it("answers with the model the participant's own configuration sets", async () => {
		await seedGraph({ accountModel: "owner/account-model", worldModel: "owner/world-model", botModel: "owner/bot-model" });

		await expect(effectiveModel()).resolves.toBe("owner/bot-model");
	});

	it("answers with a model inherited from the nearest ancestor that sets one", async () => {
		await seedGraph({ accountModel: "owner/account-model", worldModel: "owner/world-model" });

		await expect(effectiveModel()).resolves.toBe("owner/world-model");
	});

	it("answers with the account default when no closer configuration sets a model", async () => {
		await seedGraph({ accountModel: "owner/account-model" });

		await expect(effectiveModel()).resolves.toBe("owner/account-model");
	});

	// Cutover 0 keeps the legacy resolution the runtime still uses for an
	// unmigrated account, so the public row stays correct across the migration
	// rather than only after it.
	it("answers with the Bickr default when no owner configuration supplies a model", async () => {
		await expect(effectiveModel()).resolves.toBe(defaultProviderModel);
		await expect(effectiveModel({ OPENROUTER_MODEL: "deployment/default-model" }))
			.resolves.toBe("deployment/default-model");
	});

	it("answers with the legacy participant model an unmigrated account still runs on", async () => {
		await writeJson(testEnv.BICKR_KV, kvKeys.bot(botId), bot({ model: "legacy/bot-model" }));
		await writeJson(testEnv.BICKR_KV, kvKeys.user(ownerId), user({ inferenceSettings: { openRouterApiKey: ownerSecret } }));

		await expect(effectiveModel()).resolves.toBe("legacy/bot-model");
	});

	it("resolves for the participant's owner, never for the viewer", async () => {
		await seedGraph({ accountModel: "owner/account-model", botModel: "owner/bot-model" });
		// The other account deliberately has a graph of its own with a different
		// model, so a resolver that read the caller instead of the participant
		// would answer differently rather than merely failing.
		await seedGraph({ accountModel: "visitor/account-model", forUserId: otherUserId });

		const anonymous = await runtimeResponse();
		const asOwner = await runtimeResponse({ viewerUserId: ownerId });
		const asOtherUser = await runtimeResponse({ viewerUserId: otherUserId });

		expect(anonymous.body).toEqual({ ok: true, data: { model: { botId, effectiveModel: "owner/bot-model" } } });
		expect(asOwner.body).toEqual(anonymous.body);
		expect(asOtherUser.body).toEqual(anonymous.body);
		expect([anonymous.status, asOwner.status, asOtherUser.status]).toEqual([200, 200, 200]);
	});

	it("publishes the model and nothing else about the configuration behind it", async () => {
		await seedGraph({
			accountModel: "owner/account-model",
			botModel: "owner/bot-model",
			baseUrl: "https://owner-provider.example/v1",
		});

		const response = await runtimeResponse();

		expect(response.body).toEqual({ ok: true, data: { model: { botId, effectiveModel: "owner/bot-model" } } });
		for (const secret of [
			ownerSecret,
			"owner-provider.example",
			"credential",
			"baseUrl",
			"providerRouting",
			"configurationId",
			"source",
			"revision",
			"coordinator",
		]) {
			expect(response.text).not.toContain(secret);
		}
	});

	it("keeps the public profile's not-found behavior for unknown and removed participants", async () => {
		await expect(runtimeResponse({ worldHandle: "no-such-world" })).resolves.toMatchObject({
			status: 404,
			body: { ok: false, error: "not_found" },
		});
		await expect(runtimeResponse({ botHandle: "no-such-bot" })).resolves.toMatchObject({
			status: 404,
			body: { ok: false, error: "not_found" },
		});

		await testEnv.BICKR_D1.prepare(`UPDATE bots_index SET lifecycle_state = 'deleting' WHERE bot_id = ?`)
			.bind(botId).run();
		await expect(runtimeResponse()).resolves.toMatchObject({ status: 404, body: { ok: false, error: "not_found" } });

		await testEnv.BICKR_D1.prepare(`UPDATE bots_index SET deleted_at = ?, lifecycle_state = 'active' WHERE bot_id = ?`)
			.bind(now, botId).run();
		await expect(runtimeResponse()).resolves.toMatchObject({ status: 404, body: { ok: false, error: "not_found" } });
	});

	it("proxies from Pages without a viewer identity, signed in or not", async () => {
		await seedGraph({ accountModel: "owner/account-model", botModel: "owner/bot-model" });
		const forwarded: Request[] = [];

		const anonymous = await pagesResponse(forwarded);
		const signedIn = await pagesResponse(forwarded, { cookie: "bickr_session=a-session-token" });

		expect(anonymous.status).toBe(200);
		expect(anonymous.body).toEqual({ ok: true, data: { model: { botId, effectiveModel: "owner/bot-model" } } });
		expect(signedIn.body).toEqual(anonymous.body);
		expect(forwarded).toHaveLength(2);
		for (const request of forwarded) {
			expect(request.url).toBe(internalServiceUrl(`/worlds/${worldHandle}/bots/${botHandle}/effective-model`));
			expect(request.headers.get("x-bickr-user-id")).toBeNull();
			expect(request.headers.get("cookie")).toBeNull();
			expect(request.headers.get("authorization")).toBeNull();
		}
	});

	it("returns the public profile's not-found through the Pages proxy", async () => {
		await expect(pagesResponse([], { botHandle: "no-such-bot" })).resolves.toMatchObject({
			status: 404,
			body: { ok: false, error: "not_found" },
		});
	});

	// Reading a public model must not become a way into the owner surface.
	it("leaves the owner-only configuration routes authenticated", async () => {
		await seedGraph({ accountModel: "owner/account-model", botModel: "owner/bot-model" });
		const ownerPath = `/users/${ownerId}/inference-configurations`;

		await expect(ownerRouteStatus(`${ownerPath}/effective-models?botIds=${botId}`)).resolves.toBe(401);
		await expect(ownerRouteStatus(`${ownerPath}/effective-models?botIds=${botId}`, otherUserId)).resolves.toBe(401);
		await expect(ownerRouteStatus(`${ownerPath}/fixed/bot/${botId}`)).resolves.toBe(401);
		await expect(ownerRouteStatus(`${ownerPath}/fixed/bot/${botId}`, otherUserId)).resolves.toBe(401);
		await expect(ownerRouteStatus(`${ownerPath}/effective-models?botIds=${botId}`, ownerId)).resolves.toBe(200);
	});
});

type ResponseProbe = { status: number; text: string; body: ModelEnvelope };

async function runtimeResponse(options: {
	viewerUserId?: string;
	worldHandle?: string;
	botHandle?: string;
	env?: Record<string, string>;
} = {}): Promise<ResponseProbe> {
	const path = `/worlds/${encodeURIComponent(options.worldHandle ?? worldHandle)}`
		+ `/bots/${encodeURIComponent(options.botHandle ?? botHandle)}/effective-model`;
	const response = await handleAgentRuntimeRequest(
		new Request(internalServiceUrl(path), {
			headers: options.viewerUserId ? { "x-bickr-user-id": options.viewerUserId } : {},
		}),
		{ ...testEnv, ...options.env } as never,
	);
	const text = await response.text();
	return { status: response.status, text, body: JSON.parse(text) as ModelEnvelope };
}

async function effectiveModel(env?: Record<string, string>): Promise<string | undefined> {
	const response = await runtimeResponse(env ? { env } : {});
	expect(response.status, response.text).toBe(200);
	return response.body.data?.model?.effectiveModel;
}

async function ownerRouteStatus(path: string, viewerUserId?: string): Promise<number> {
	const response = await handleAgentRuntimeRequest(
		new Request(internalServiceUrl(path), {
			headers: viewerUserId ? { "x-bickr-user-id": viewerUserId } : {},
		}),
		testEnv as never,
		{ objectId: "public-model-test-coordinator", ownerUserId: ownerId },
	);
	return response.status;
}

async function pagesResponse(
	forwarded: Request[],
	options: { cookie?: string; botHandle?: string } = {},
): Promise<ResponseProbe> {
	const requestedBotHandle = options.botHandle ?? botHandle;
	const request = new Request(
		`https://bickr.social/api/worlds/${worldHandle}/bots/${requestedBotHandle}/effective-model`,
		{ headers: options.cookie ? { cookie: options.cookie } : {} },
	);
	const env = {
		...testEnv,
		INTERNAL_SERVICE_SECRET: internalSecret,
		AGENT_RUNTIME: {
			fetch: (serviceRequest: Request) => {
				forwarded.push(serviceRequest.clone());
				return handleAgentRuntimeWorkerRequest(
					serviceRequest,
					{ ...testEnv, INTERNAL_SERVICE_SECRET: internalSecret } as never,
				);
			},
		},
	} as unknown as AppEnv;
	const response = await publicEffectiveModelRoute({
		data: {},
		env,
		functionPath: new URL(request.url).pathname,
		next: async () => new Response("Not Found", { status: 404 }),
		params: { worldHandle, botHandle: requestedBotHandle },
		passThroughOnException: () => {},
		request,
		waitUntil: () => {},
	} as unknown as Parameters<typeof publicEffectiveModelRoute>[0]);
	const text = await response.text();
	return { status: response.status, text, body: JSON.parse(text) as ModelEnvelope };
}

/**
 * Builds the canonical chain account default -> world -> participant, so a test
 * can place a model at any depth and see which one the public row reports.
 *
 * The account default carries an owner-sourced credential because that is what
 * authorizes an owner-defined model at all: with only a deployment credential
 * the resolver deliberately falls the model back to the Bickr default, and
 * that rule is shared with runtime rather than restated here.
 */
async function seedGraph(input: {
	accountModel?: string;
	worldModel?: string;
	botModel?: string;
	baseUrl?: string;
	forUserId?: string;
}): Promise<void> {
	const owner = input.forUserId ?? ownerId;
	const rootId = await accountDefaultConfigurationId(owner);
	const worldConfigId = await worldConfigurationId(worldId);
	const modelOverride = (model: string | undefined) =>
		model ? { overrides: { model: { kind: "value" as const, value: model } } } : {};
	await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
		insertAccountDefaultConfigurationStatement(testEnv.BICKR_D1, {
			configurationId: rootId,
			ownerUserId: owner,
			now,
			overrides: {
				...(input.accountModel ? { model: { kind: "value" as const, value: input.accountModel } } : {}),
				...(input.baseUrl ? { baseUrl: { kind: "value" as const, value: input.baseUrl } } : {}),
			},
		}),
		configurationCredentialValueStatement(testEnv.BICKR_D1, {
			configurationId: rootId,
			ownerUserId: owner,
			secret: ownerSecret,
			now,
		}),
		insertTranslationInferencePointerStatement(testEnv.BICKR_D1, { ownerUserId: owner, configurationId: rootId, now }),
		// The other account owns neither the world nor the participant, so its
		// graph stops at its own Account default.
		...(input.forUserId ? [] : [
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "world",
				configurationId: worldConfigId,
				ownerUserId: owner,
				parentId: rootId,
				worldId,
				now,
				...modelOverride(input.worldModel),
			}),
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "bot",
				configurationId: await botConfigurationId(botId),
				ownerUserId: owner,
				parentId: worldConfigId,
				botId,
				now,
				...modelOverride(input.botModel),
			}),
		]),
	]);
	await testEnv.BICKR_D1.prepare(
		`UPDATE inference_graph_users
		 SET writer_version = 1, cutover_version = 1, verified_cutover_at = ?, updated_at = ?
		 WHERE owner_user_id = ?`,
	).bind(now, now, owner).run();
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

async function seedBotIndexRow(): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO bots_index (
			bot_id, home_world_id, home_world_handle, handle, display_name,
			owner_user_id, short_bio, created_at, updated_at, lifecycle_state
		) VALUES (?, ?, ?, ?, 'Model bot', ?, 'Bio', ?, ?, 'active')`,
	).bind(botId, worldId, worldHandle, botHandle, ownerId, now, now).run();
}

function user(overrides: Partial<UserDocument> = {}): UserDocument {
	return {
		id: ownerId,
		type: "user",
		schemaVersion,
		revision: 1,
		handle: "model-owner",
		language: en,
		displayName: localizedText("Model Owner", en),
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function world(): WorldDocument {
	return {
		id: worldId,
		type: "world",
		schemaVersion,
		revision: 1,
		handle: worldHandle,
		language: en,
		name: localizedText("Model world", en),
		description: localizedText("Description", en),
		prompt: localizedText("World prompt", en),
		recurringPromptEnabled: false,
		recurringPrompt: localizedText("", en),
		initialBotNotification: localizedText("", en),
		createdByUserId: ownerId,
		visibility: "public",
		createdAt: now,
		updatedAt: now,
	};
}

function bot(inferenceSettings: BotInferenceSettings = {}): BotDocument {
	return {
		id: botId,
		type: "bot",
		schemaVersion,
		revision: 1,
		homeWorldId: worldId,
		homeWorldHandle: worldHandle,
		ownerUserId: ownerId,
		handle: botHandle,
		language: en,
		includeLanguageInSystemPrompt: false,
		displayName: localizedText("Model bot", en),
		shortBio: localizedText("Bio", en),
		prompt: localizedText("Participant prompt", en),
		inferenceSettings,
		toolSettings: {},
		tickSettings: { enabled: false, intervalSeconds: 86_400, compactionThreshold: 0.75 },
		createdAt: now,
		updatedAt: now,
	};
}
