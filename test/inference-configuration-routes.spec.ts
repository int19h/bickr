import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
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
import type { D1DatabaseLike } from "@bickr/shared/storage";
import { resetD1Schema } from "./helpers/d1-schema";
import { handleAgentRuntimeRequest } from "../workers/agent-runtime/src/routes";

const ownerId = "usr_route_owner";
const worldId = "wld_route";
const now = "2026-08-05T00:00:00.000Z";

type RouteEnvelope = { ok: boolean; error?: string; details?: Record<string, unknown>; data?: Record<string, unknown> };

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await testEnv.BICKR_D1.batch([
		testEnv.BICKR_D1.prepare(
			`INSERT INTO entity_lifecycle_identity_claims (
				key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
				claim_state, operation_id, created_at, updated_at
			) VALUES ('user_handle', 'global', 'route-owner', 'account', ?, ?, 'active', NULL, ?, ?)`,
		).bind(ownerId, ownerId, now, now),
		testEnv.BICKR_D1.prepare(
			`INSERT INTO users_index (user_id, handle, display_name, created_at, updated_at, lifecycle_state)
			 VALUES (?, 'route-owner', 'Route Owner', ?, ?, 'active')`,
		).bind(ownerId, now, now),
	]);
	const rootId = await accountDefaultConfigurationId(ownerId);
	await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
		insertAccountDefaultConfigurationStatement(testEnv.BICKR_D1, { configurationId: rootId, ownerUserId: ownerId, now }),
		insertTranslationInferencePointerStatement(testEnv.BICKR_D1, { configurationId: rootId, ownerUserId: ownerId, now }),
	]);
	// The owner graph endpoints are gated on a completed cutover; the graph row
	// itself is created by the Account default insert.
	await testEnv.BICKR_D1.prepare(
		`UPDATE inference_graph_users
		 SET writer_version = 1, cutover_version = 1, verified_cutover_at = ?, updated_at = ?
		 WHERE owner_user_id = ?`,
	).bind(now, now, ownerId).run();
});

describe("inference configuration runtime routes", () => {
	it("selects validated library sections and carries participant grouping through the route", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, { name: "Route custom", parentId: rootId }, now);
		await seedWorld(worldId, "route-world");
		await seedBot("bot_route_a", worldId, "route-world", "route-alpha");
		await seedBot("bot_route_b", worldId, "route-world", "route-beta");
		await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "world", configurationId: "cfg_route_world", ownerUserId: ownerId, parentId: rootId, worldId, now,
			}),
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "bot", configurationId: "cfg_route_bot_a", ownerUserId: ownerId, parentId: rootId, botId: "bot_route_a", now,
			}),
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "bot", configurationId: "cfg_route_bot_b", ownerUserId: ownerId, parentId: rootId, botId: "bot_route_b", now,
			}),
		]);

		const bots = await routePayload("/inference-configurations?section=bot&limit=1");
		expect(bots.status).toBe(200);
		const firstBotPage = configurationsPage(bots.body);
		expect(firstBotPage.section).toBe("bot");
		expect(firstBotPage.items).toHaveLength(1);
		expect(firstBotPage.items[0]).toMatchObject({
			displayName: "u/route-alpha",
			immediateChildCount: 0,
			credentialAvailability: { kind: "unavailable" },
		});
		expect(firstBotPage.groups).toEqual([
			{ homeWorldId: worldId, homeWorldHandle: "route-world", displayName: "w/route-world", botConfigurationCount: 2 },
		]);
		expect(firstBotPage.nextCursor).toBeTruthy();

		const second = await routePayload(
			`/inference-configurations?section=bot&limit=1&cursor=${encodeURIComponent(String(firstBotPage.nextCursor))}`,
		);
		expect(second.status).toBe(200);
		expect(configurationsPage(second.body).items[0]).toMatchObject({ displayName: "u/route-beta" });

		const customs = await routePayload("/inference-configurations?kind=custom");
		expect(customs.status).toBe(200);
		expect(configurationsPage(customs.body).items.map((item) => item.displayName)).toEqual(["Route custom"]);

		const searched = await routePayload("/inference-configurations?section=bot&q=route-world");
		expect(configurationsPage(searched.body).items).toHaveLength(2);
	});

	it("returns typed 400 errors for unknown sections, unknown kinds, and conflicting selections", async () => {
		const unknownSection = await routePayload("/inference-configurations?section=participants");
		expect(unknownSection.status).toBe(400);
		expect(unknownSection.body.error).toBe("bad_request");
		const unknownKind = await routePayload("/inference-configurations?kind=participant");
		expect(unknownKind.status).toBe(400);
		expect(unknownKind.body.error).toBe("bad_request");
		const both = await routePayload("/inference-configurations?section=bot&kind=custom");
		expect(both.status).toBe(400);
		const badCursor = await routePayload("/inference-configurations?cursor=not-a-cursor");
		expect(badCursor.status).toBe(400);
	});

	it("returns a typed 400 when an owner PATCH stores the Account-default state on Account default", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const path = `/inference-configurations/${encodeURIComponent(rootId)}`;
		const baseUrlMisuse = await routePayload(path, {
			method: "PATCH",
			body: { expectedRevision: 1, overrides: { baseUrl: { kind: "account_default" } } },
		});
		expect(baseUrlMisuse.status).toBe(400);
		expect(baseUrlMisuse.body.error).toBe("bad_request");
		// The sibling credential misuse already answered 400; both now agree.
		const credentialMisuse = await routePayload(path, {
			method: "PATCH",
			body: { expectedRevision: 1, credential: { mode: "account_default" } },
		});
		expect(credentialMisuse.status).toBe(400);
		expect(credentialMisuse.body.error).toBe("bad_request");
		const provenanceMisuse = await routePayload(path, {
			method: "PATCH",
			body: { expectedRevision: 1, overrides: {
				imageModel: {
					kind: "historical_bickr_default",
					value: "google/gemini-3.1-flash-image-preview",
				},
			} },
		});
		expect(provenanceMisuse.status).toBe(400);
		expect(provenanceMisuse.body.error).toBe("bad_request");
		// Both rejections were atomic, so the entry is still at its first revision
		// and an allowed patch against that revision succeeds.
		const accepted = await routePayload(path, {
			method: "PATCH",
			body: { expectedRevision: 1, overrides: { baseUrl: { kind: "value", value: "https://account.example/v1" } } },
		});
		expect(accepted.status).toBe(200);
	});

	it("echoes the typed graph cause in error details so clients never read the message", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const custom = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, { name: "Shared sampling", parentId: rootId }, now);

		const stale = await routePayload(`/inference-configurations/${encodeURIComponent(custom.id)}`, {
			method: "PATCH",
			body: { expectedRevision: custom.revision + 5, overrides: { temperature: { kind: "value", value: 0 } } },
		});
		expect(stale.status).toBe(409);
		expect(stale.body.error).toBe("conflict");
		expect(stale.body.details).toEqual({ inferenceGraphCause: "stale_revision" });

		const duplicate = await routePayload("/inference-configurations", {
			method: "POST",
			body: { name: "shared SAMPLING", parentId: rootId },
		});
		expect(duplicate.status).toBe(409);
		expect(duplicate.body.details).toEqual({ inferenceGraphCause: "duplicate_name" });

		const descendant = await routePayload(`/inference-configurations/${encodeURIComponent(rootId)}/reparent`, {
			method: "POST",
			body: { parentId: custom.id, expectedRevision: 1 },
		});
		expect(descendant.body.details).toEqual({ inferenceGraphCause: "account_default_required" });
	});

	it("returns named ancestry so an owner client can label provenance without walking the graph", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		await seedWorld(worldId, "route-world");
		await seedBot("bot_named", worldId, "route-world", "route-named");
		await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "bot", configurationId: "cfg_named_bot", ownerUserId: ownerId, parentId: rootId, botId: "bot_named", now,
			}),
		]);
		const child = await inferenceConfigurationMutations.createCustom(
			testEnv.BICKR_D1,
			ownerId,
			{ name: "Child of participant", parentId: "cfg_named_bot" },
			now,
		);

		const response = await routePayload(`/inference-configurations/${encodeURIComponent(child.id)}`);
		expect(response.status).toBe(200);
		const configuration = response.body.data?.configuration as {
			path: { id: string; displayName: string; kind: string }[];
		};
		expect(configuration.path.map((entry) => entry.displayName)).toEqual([
			"Child of participant",
			"u/route-named",
			"Account default",
		]);
		expect(configuration.path.map((entry) => entry.kind)).toEqual(["custom", "bot", "account_default"]);
		expect(configuration.path[0]?.id).toBe(child.id);
	});

	it("resolves a fixed entry only for an entity the caller owns", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		await seedWorld(worldId, "route-world");
		await seedBot("bot_owned", worldId, "route-world", "route-owned");
		// Fixed entries live at the lifecycle-assigned address, which the route
		// resolves for the caller.
		const worldConfiguration = await worldConfigurationId(worldId);
		const botConfiguration = await botConfigurationId("bot_owned");
		await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "world", configurationId: worldConfiguration, ownerUserId: ownerId, parentId: rootId, worldId, now,
			}),
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "bot", configurationId: botConfiguration, ownerUserId: ownerId, parentId: rootId, botId: "bot_owned", now,
			}),
		]);

		const account = await routePayload("/inference-configurations/fixed/account_default");
		expect(account.status).toBe(200);
		expect(account.body.data?.configuration).toMatchObject({ id: rootId, kind: "account_default", displayName: "Account default" });

		const world = await routePayload(`/inference-configurations/fixed/world/${encodeURIComponent(worldId)}`);
		expect(world.status).toBe(200);
		expect(world.body.data?.configuration).toMatchObject({ id: worldConfiguration, kind: "world", displayName: "w/route-world" });

		const bot = await routePayload("/inference-configurations/fixed/bot/bot_owned");
		expect(bot.status).toBe(200);
		expect(bot.body.data?.configuration).toMatchObject({ id: botConfiguration, kind: "bot", displayName: "u/route-owned" });
	});

	/**
	 * Owner screens label a participant's current model from this one
	 * set-oriented answer instead of reconstructing it from stored legacy
	 * settings. Its path sits beside the single-configuration route, so the
	 * ordering of the two patterns is part of the contract.
	 */
	it("answers canonical participant models for a set without colliding with a configuration id", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		await seedWorld(worldId, "route-world");
		await seedBot("bot_models_a", worldId, "route-world", "route-model-a");
		await seedBot("bot_models_b", worldId, "route-world", "route-model-b");
		await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "bot", configurationId: "cfg_models_a", ownerUserId: ownerId, parentId: rootId, botId: "bot_models_a", now,
			}),
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "bot", configurationId: "cfg_models_b", ownerUserId: ownerId, parentId: rootId, botId: "bot_models_b", now,
			}),
		]);
		await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: rootId,
			expectedRevision: 1,
			credential: { mode: "value", secret: "route-owner-key" },
		}, now);
		await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: "cfg_models_a",
			expectedRevision: 1,
			overrides: { model: { kind: "value", value: "route/alpha-model" } },
		}, now);

		const resolved = await routePayload("/inference-configurations/effective-models?botIds=bot_models_a,bot_models_b");
		expect(resolved.status).toBe(200);
		const models = (resolved.body.data?.effectiveModels as { models: { botId: string; effectiveModel: string }[] }).models;
		expect(models.find((entry) => entry.botId === "bot_models_a")?.effectiveModel).toBe("route/alpha-model");
		expect(models.find((entry) => entry.botId === "bot_models_b")?.effectiveModel).toBeTruthy();
		// Resolved model labels only: no credential state, base URL, or overrides.
		expect(JSON.stringify(resolved.body)).not.toContain("route-owner-key");
		expect(Object.keys(models[0] ?? {})).toEqual(["botId", "effectiveModel"]);

		// The single-configuration route still answers for a real id, and an
		// unknown participant is absent rather than an error.
		const single = await routePayload(`/inference-configurations/${encodeURIComponent("cfg_models_a")}`);
		expect(single.status).toBe(200);
		expect(single.body.data?.configuration).toMatchObject({ id: "cfg_models_a", kind: "bot" });
		const unknown = await routePayload("/inference-configurations/effective-models?botIds=bot_missing");
		expect(unknown.status).toBe(200);
		expect((unknown.body.data?.effectiveModels as { models: unknown[] }).models).toEqual([]);
	});

	it("refuses a fixed entry for an unknown, foreign, or invalid entity", async () => {
		// A world and a participant owned by somebody else, plus their fixed
		// entries, are indistinguishable from entities that do not exist.
		const foreignOwner = "usr_route_foreign";
		const foreignRoot = await accountDefaultConfigurationId(foreignOwner);
		await testEnv.BICKR_D1.batch([
			claim("user_handle", "global", "route-foreign", "account", foreignOwner, foreignOwner),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO users_index (user_id, handle, display_name, created_at, updated_at, lifecycle_state)
				 VALUES (?, 'route-foreign', 'Route Foreign', ?, ?, 'active')`,
			).bind(foreignOwner, now, now),
			claim("world_handle", "global", "foreign-world", "world", "wld_foreign", foreignOwner),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO worlds_index (
					world_id, handle, name, description, created_by_user_id, visibility,
					created_at, updated_at, lifecycle_state
				) VALUES ('wld_foreign', 'foreign-world', 'foreign-world', '', ?, 'public', ?, ?, 'active')`,
			).bind(foreignOwner, now, now),
			claim("bot_handle", "wld_foreign", "foreign-bot", "bot", "bot_foreign", foreignOwner),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO bots_index (
					bot_id, home_world_id, home_world_handle, handle, display_name,
					owner_user_id, short_bio, created_at, updated_at, lifecycle_state
				) VALUES ('bot_foreign', 'wld_foreign', 'foreign-world', 'foreign-bot', 'foreign-bot', ?, '', ?, ?, 'active')`,
			).bind(foreignOwner, now, now),
		]);
		const foreignBotConfiguration = await botConfigurationId("bot_foreign");
		await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
			insertAccountDefaultConfigurationStatement(testEnv.BICKR_D1, { configurationId: foreignRoot, ownerUserId: foreignOwner, now }),
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "bot", configurationId: foreignBotConfiguration, ownerUserId: foreignOwner, parentId: foreignRoot, botId: "bot_foreign", now,
			}),
		]);

		for (const path of [
			"/inference-configurations/fixed/bot/bot_foreign",
			"/inference-configurations/fixed/world/wld_foreign",
			"/inference-configurations/fixed/bot/bot_missing",
			"/inference-configurations/fixed/world/wld_missing",
		]) {
			const response = await routePayload(path);
			expect(response.status).toBe(404);
			expect(response.body.error).toBe("not_found");
			// The refusal never discloses that the entity or its configuration exists.
			expect(JSON.stringify(response.body)).not.toContain(foreignBotConfiguration);
			expect(JSON.stringify(response.body)).not.toContain("another owner");
		}

		const invalidKind = await routePayload("/inference-configurations/fixed/custom/cfg_one");
		expect(invalidKind.status).toBe(400);
		expect(invalidKind.body.error).toBe("bad_request");
	});

	it("exposes Translation only as a fixed role and retires selector routes", async () => {
		expect((await routePayload("/inference-translation")).status).toBe(404);
		expect((await routePayload("/inference-translation/candidates")).status).toBe(404);
		expect((await routePayload("/inference-configurations/fixed/translation")).status).toBe(404);

		await translationInferenceLifecycle.enable(testEnv.BICKR_D1, ownerId, now);
		const fixed = await routePayload("/inference-configurations/fixed/translation");
		expect(fixed.status).toBe(200);
		expect(fixed.body.data?.configuration).toMatchObject({
			kind: "translation",
			displayName: "Translation",
			identity: { kind: "translation" },
		});
		const annotation = await routePayload("/inference-translation/annotation");
		expect(annotation.body.data?.annotation).toMatchObject({
			enabled: true,
			displayName: "Translation",
		});
	});

	it("wires q through parent candidates and children, and reports the unfiltered child total", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const alpha = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, { name: "Alpha parent", parentId: rootId }, now);
		await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, { name: "Beta parent", parentId: rootId }, now);
		const selected = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, { name: "Selected", parentId: rootId }, now);
		for (const name of ["Child alpha", "Child beta", "Unrelated"]) {
			await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, { name, parentId: selected.id }, now);
		}

		const candidates = await routePayload(
			`/inference-configurations/${encodeURIComponent(selected.id)}/parent-candidates?q=Alpha`,
		);
		expect(candidates.status).toBe(200);
		const candidatePage = candidates.body.data?.candidates as { items: { id: string }[] };
		expect(candidatePage.items.map((item) => item.id)).toEqual([alpha.id]);

		const children = await routePayload(
			`/inference-configurations/${encodeURIComponent(selected.id)}/children?q=Child&limit=1`,
		);
		expect(children.status).toBe(200);
		const childPage = children.body.data?.children as {
			items: { displayName: string }[];
			nextCursor?: string;
			totalImmediateChildren: number;
		};
		expect(childPage.items).toHaveLength(1);
		expect(childPage.totalImmediateChildren).toBe(3);
		expect(childPage.nextCursor).toBeTruthy();
		const nextChildren = await routePayload(
			`/inference-configurations/${encodeURIComponent(selected.id)}/children?q=Child&limit=1&cursor=${encodeURIComponent(String(childPage.nextCursor))}`,
		);
		const nextChildPage = nextChildren.body.data?.children as { items: { displayName: string }[]; totalImmediateChildren: number };
		expect(nextChildPage.items).toHaveLength(1);
		expect(nextChildPage.totalImmediateChildren).toBe(3);
		expect([...childPage.items, ...nextChildPage.items].map((item) => item.displayName).sort())
			.toEqual(["Child alpha", "Child beta"]);
	});
});

type ConfigurationsPage = {
	items: { displayName: string; immediateChildCount: number; credentialAvailability: { kind: string } }[];
	groups?: unknown[];
	section?: string;
	nextCursor?: string;
};

function configurationsPage(body: RouteEnvelope): ConfigurationsPage {
	const page = body.data?.configurations;
	if (!page || typeof page !== "object") throw new Error("Expected an inference configuration page.");
	return page as ConfigurationsPage;
}

async function routePayload(
	path: string,
	init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: RouteEnvelope }> {
	const response = await handleAgentRuntimeRequest(
		new Request(`https://agent.internal/users/${ownerId}${path}`, {
			...(init.method ? { method: init.method } : {}),
			headers: {
				"x-bickr-user-id": ownerId,
				...(init.body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		}),
		testEnv as never,
		{ objectId: "route-test-coordinator", ownerUserId: ownerId },
	);
	return { status: response.status, body: await response.json() as RouteEnvelope };
}

function claim(
	keyKind: string,
	keyScope: string,
	keyValue: string,
	entityKind: string,
	entityId: string,
	owner: string,
) {
	return testEnv.BICKR_D1.prepare(
		`INSERT INTO entity_lifecycle_identity_claims (
			key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
			claim_state, operation_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
	).bind(keyKind, keyScope, keyValue, entityKind, entityId, owner, now, now);
}

async function seedWorld(id: string, handle: string): Promise<void> {
	await testEnv.BICKR_D1.batch([
		testEnv.BICKR_D1.prepare(
			`INSERT INTO entity_lifecycle_identity_claims (
				key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
				claim_state, operation_id, created_at, updated_at
			) VALUES ('world_handle', 'global', ?, 'world', ?, ?, 'active', NULL, ?, ?)`,
		).bind(handle, id, ownerId, now, now),
		testEnv.BICKR_D1.prepare(
			`INSERT INTO worlds_index (
				world_id, handle, name, description, created_by_user_id, visibility,
				created_at, updated_at, lifecycle_state
			) VALUES (?, ?, ?, '', ?, 'public', ?, ?, 'active')`,
		).bind(id, handle, handle, ownerId, now, now),
	]);
}

async function seedBot(id: string, homeWorldId: string, homeWorldHandle: string, handle: string): Promise<void> {
	await testEnv.BICKR_D1.batch([
		testEnv.BICKR_D1.prepare(
			`INSERT INTO entity_lifecycle_identity_claims (
				key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
				claim_state, operation_id, created_at, updated_at
			) VALUES ('bot_handle', ?, ?, 'bot', ?, ?, 'active', NULL, ?, ?)`,
		).bind(homeWorldId, handle, id, ownerId, now, now),
		testEnv.BICKR_D1.prepare(
			`INSERT INTO bots_index (
				bot_id, home_world_id, home_world_handle, handle, display_name,
				owner_user_id, short_bio, created_at, updated_at, lifecycle_state
			) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 'active')`,
		).bind(id, homeWorldId, homeWorldHandle, handle, handle, ownerId, now, now),
	]);
}
