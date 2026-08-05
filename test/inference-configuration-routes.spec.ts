import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	accountDefaultConfigurationId,
	inferenceConfigurationMutations,
	insertAccountDefaultConfigurationStatement,
	insertFixedConfigurationStatement,
	insertTranslationSelectionStatement,
} from "@bickr/shared/inference-configuration-repository";
import type { D1DatabaseLike } from "@bickr/shared/storage";
import { resetD1Schema } from "./helpers/d1-schema";
import { handleAgentRuntimeRequest } from "../workers/agent-runtime/src/routes";

const ownerId = "usr_route_owner";
const worldId = "wld_route";
const now = "2026-08-05T00:00:00.000Z";

type RouteEnvelope = { ok: boolean; error?: string; data?: Record<string, unknown> };

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
		insertTranslationSelectionStatement(testEnv.BICKR_D1, { configurationId: rootId, ownerUserId: ownerId, now }),
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

async function routePayload(path: string): Promise<{ status: number; body: RouteEnvelope }> {
	const response = await handleAgentRuntimeRequest(
		new Request(`https://agent.internal/users/${ownerId}${path}`, { headers: { "x-bickr-user-id": ownerId } }),
		testEnv as never,
		{ objectId: "route-test-coordinator", ownerUserId: ownerId },
	);
	return { status: response.status, body: await response.json() as RouteEnvelope };
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
