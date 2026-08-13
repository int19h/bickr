import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { RepositoryError, userIndexProjectionStatement, worldIndexProjectionStatement } from "@bickr/shared/repository";
import { kvKeys, writeJson, type D1DatabaseLike, type KVNamespaceLike } from "@bickr/shared/storage";
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
const leakedConfigurationId = "cfg_owner_private_configuration";

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

	// The graph resolver is deliberately expressive for the owner editing it: it
	// names configuration ids in its prose, carries an `inferenceGraphCause` in
	// typed details, and answers 404 for a configuration that is simply not
	// there. A reader who only addressed a public profile learns none of that,
	// so every failure past the addressed participant is one opaque answer.
	it("collapses a corrupt configuration graph to an opaque server error", async () => {
		await seedGraph({ accountModel: "owner/account-model", botModel: "owner/bot-model" });
		const worldConfigId = await worldConfigurationId(worldId);
		// A parent cycle is the corruption the row constraints cannot reject: every
		// CHECK still holds locally, so only the resolver's own depth sentinel
		// catches it, and it reports the cause the owner surface branches on.
		await reparent(worldConfigId, await botConfigurationId(botId));
		try {
			await expectOpaqueResolutionFailure(await runtimeResponse(), ["corrupt_graph", "sentinel"]);
		} finally {
			// A cyclic self-reference also blocks the shared schema reset's table
			// drop, so the cycle is undone here instead of failing the next test.
			await reparent(worldConfigId, await accountDefaultConfigurationId(ownerId));
		}
	});

	it("collapses a missing configuration to an opaque server error rather than a not-found", async () => {
		// The participant is public and present, and its owner is migrated; only
		// the participant's own configuration entry is absent. Answering 404 here
		// would both contradict the profile and tell an anonymous reader which
		// owner rows exist.
		await seedGraph({ accountModel: "owner/account-model", omitBotConfiguration: true });

		await expectOpaqueResolutionFailure(await runtimeResponse(), ["Inference configuration", "not_found"]);
	});

	it("collapses a configuration owned by another account to an opaque server error", async () => {
		await seedGraph({ accountModel: "owner/account-model", botModel: "owner/bot-model" });
		await seedGraph({ accountModel: "visitor/account-model", forUserId: otherUserId });
		// A participant document whose owner has drifted from the graph row's
		// owner. The resolver answers 409 "belongs to another owner", which names
		// an ownership relation the public profile never publishes.
		await writeJson(testEnv.BICKR_KV, kvKeys.bot(botId), { ...bot(), ownerUserId: otherUserId });

		await expectOpaqueResolutionFailure(await runtimeResponse(), ["cross_owner", "another owner", "conflict"]);
	});

	it("collapses an unreadable owner to an opaque server error", async () => {
		await seedGraph({ accountModel: "owner/account-model", botModel: "owner/bot-model" });
		await testEnv.BICKR_KV.delete(kvKeys.user(ownerId));

		await expectOpaqueResolutionFailure(await runtimeResponse(), ["User not found", ownerId]);
	});

	// The response is opaque, so the log is the only account of what broke — and
	// a log is a disclosure too. It carries the participant, which of the two
	// owner-scoped reads failed, and typed values the worker recognizes; it never
	// carries the error itself, so nothing a thrower attaches can ride along.
	it("logs one safe event and none of what an unrecognized failure carried", async () => {
		await seedGraph({ accountModel: "owner/account-model", botModel: "owner/bot-model" });
		// The step this replaces is a platform read, so what it throws is whatever
		// the host or a future dependency decided to throw: untyped, and free to
		// carry credentials in its message, its cause, or fields invented for it.
		const failure = new Error(`OPENROUTER_API_KEY=${ownerSecret} rejected for ${leakedConfigurationId}`, {
			cause: { openRouterApiKey: ownerSecret },
		});
		Object.assign(failure, { metadata: { configurationId: leakedConfigurationId } });

		const { response, logged } = await failedResolution({ BICKR_KV: ownerReadFails(failure) });

		expectOpaqueResolutionFailure(response, ["OPENROUTER_API_KEY", ownerSecret]);
		expect(JSON.parse(logged)).toEqual({
			event: "public_effective_model_failed",
			botId,
			stage: "owner_document",
			errorKind: "error",
		});
		for (const disclosure of [ownerSecret, leakedConfigurationId, "OPENROUTER_API_KEY", "metadata", "cause"]) {
			expect(logged).not.toContain(disclosure);
		}
	});

	it("logs no typed field whose value is not a member of its allowlist", async () => {
		await seedGraph({ accountModel: "owner/account-model", botModel: "owner/bot-model" });
		// A repository error whose own typed fields hold values outside their
		// unions. Nothing in this repository throws that today; it stands in for
		// any future thrower, and it is the case that separates "the log names a
		// safe field" from "the log copies whatever that field happens to hold".
		const failure = new RepositoryError(
			ownerSecret as never,
			`Inference configuration ${leakedConfigurationId} rejected key ${ownerSecret}.`,
			500,
			{ inferenceGraphCause: ownerSecret as never, references: [leakedConfigurationId] },
		);
		Object.assign(failure, {
			cause: new Error(`upstream rejected ${ownerSecret}`),
			metadata: { openRouterApiKey: ownerSecret, configurationId: leakedConfigurationId },
		});

		const { response, logged } = await failedResolution({ BICKR_KV: ownerReadFails(failure) });

		expectOpaqueResolutionFailure(response, ["Inference configuration", ownerSecret]);
		expect(JSON.parse(logged)).toEqual({
			event: "public_effective_model_failed",
			botId,
			stage: "owner_document",
			errorKind: "repository",
			status: 500,
		});
		for (const disclosure of [ownerSecret, leakedConfigurationId, "upstream rejected", "metadata", "cause"]) {
			expect(logged).not.toContain(disclosure);
		}
	});

	it("logs the typed cause of a real graph corruption without its owner-facing prose", async () => {
		await seedGraph({ accountModel: "owner/account-model", botModel: "owner/bot-model" });
		const worldConfigId = await worldConfigurationId(worldId);
		await reparent(worldConfigId, await botConfigurationId(botId));
		try {
			const { logged } = await failedResolution();

			expect(JSON.parse(logged)).toEqual({
				event: "public_effective_model_failed",
				botId,
				stage: "canonical_resolution",
				errorKind: "inference_graph_repository",
				code: "server_error",
				status: 500,
				inferenceGraphCause: "corrupt_graph",
			});
		} finally {
			await reparent(worldConfigId, await accountDefaultConfigurationId(ownerId));
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

async function reparent(configurationId: string, parentId: string): Promise<void> {
	await testEnv.BICKR_D1.prepare(`UPDATE inference_configurations SET parent_id = ? WHERE configuration_id = ?`)
		.bind(parentId, configurationId).run();
}

/**
 * One constant answer for every resolution failure: same status, same body, no
 * error code, id, cause, or wording carried over from what actually broke.
 * `disclosures` are the strings this particular failure would have leaked.
 */
function expectOpaqueResolutionFailure(response: ResponseProbe, disclosures: readonly string[]): void {
	expect(response.status).toBe(500);
	expect(response.body).toEqual({ ok: false, error: "server_error", message: "Effective model is unavailable." });
	for (const disclosure of [...disclosures, "inferenceGraphCause", "details", "cfg_"]) {
		expect(response.text).not.toContain(disclosure);
	}
}

/**
 * Runs one failing public read with `console.error` captured, and asserts the
 * shape of the logging itself: exactly one event, passed as a single JSON
 * string, so no caught value can arrive as positional console data.
 */
async function failedResolution(env?: Record<string, unknown>): Promise<{ response: ResponseProbe; logged: string }> {
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const response = await runtimeResponse(env ? { env } : {});
		expect(response.status).toBe(500);
		expect(consoleError.mock.calls).toHaveLength(1);
		const [logged, ...positional] = consoleError.mock.calls[0] ?? [];
		expect(positional).toEqual([]);
		expect(typeof logged).toBe("string");
		return { response, logged: String(logged) };
	} finally {
		consoleError.mockRestore();
	}
}

/**
 * A KV binding that fails only the owner document read, with `failure`. The
 * participant and world lookups ahead of it still resolve, so the request
 * reaches the owner-scoped step rather than the public 404 before it.
 */
function ownerReadFails(failure: unknown): KVNamespaceLike {
	const kv = testEnv.BICKR_KV as unknown as KVNamespaceLike;
	return {
		get: (key, options) => {
			if (key === kvKeys.user(ownerId)) {
				throw failure;
			}
			return kv.get(key, options);
		},
		put: (key, value, options) => kv.put(key, value, options),
		delete: (key) => kv.delete(key),
	};
}

async function runtimeResponse(options: {
	viewerUserId?: string;
	worldHandle?: string;
	botHandle?: string;
	env?: Record<string, unknown>;
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
	omitBotConfiguration?: boolean;
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
			...(input.omitBotConfiguration ? [] : [
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
