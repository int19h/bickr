import { beforeEach, describe, expect, it } from "vitest";
import { recoverForumCreations } from "../workers/forum-coordinator/src/index";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";
import { authCookie, ExclusiveOperationQueue, handleForumCoordinatorRequest, jsonRequest, kvKeys, seedWorld, testEnv } from "./helpers/index-harness";

beforeEach(async () => { await resetD1Schema(testEnv.BICKR_D1); await clearKv(testEnv.BICKR_KV); });

async function fixture() {
	const cookie = await authCookie();
	await seedWorld(cookie);
	const world = (await testEnv.BICKR_D1.prepare(`SELECT world_id AS id, created_by_user_id AS owner FROM worlds_index WHERE handle = 'patch-notes'`).first<{ id: string; owner: string }>())!;
	const context = { objectId: world.id, queue: new ExclusiveOperationQueue() };
	const env = { BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV };
	const request = (key = "new-forum") => jsonRequest("https://internal.bickr/worlds/patch-notes/forums", "POST", { handle: "created-once", language: "en", description: "Durable forum" }, undefined, { "x-bickr-user-id": world.owner, "x-bickr-idempotency-key": key });
	return { world, context, env, request };
}

async function visibleCount() {
	return (await testEnv.BICKR_D1.prepare(`SELECT count(*) AS count FROM forums_index WHERE handle = 'created-once'`).first<{ count: number }>())!.count;
}

describe("durable forum creation", () => {
	it("keeps a failed KV publication invisible and recovers through its world owner", async () => {
		const f = await fixture();
		let fail = true;
		const kv = { get: testEnv.BICKR_KV.get.bind(testEnv.BICKR_KV), delete: testEnv.BICKR_KV.delete.bind(testEnv.BICKR_KV), put: async (key: string, value: string) => {
			if (fail && key.startsWith("v1:forum:")) { fail = false; throw new Error("Injected KV failure"); }
			await testEnv.BICKR_KV.put(key, value);
		} } as KVNamespace;
		expect((await handleForumCoordinatorRequest(f.request(), { ...f.env, BICKR_KV: kv }, f.context)).status).toBe(500);
		expect(await visibleCount()).toBe(0);
		const pending = await testEnv.BICKR_D1.prepare(`SELECT forum_id AS id FROM forum_creation_intents WHERE state = 'pending'`).first<{ id: string }>();
		expect(pending).toBeTruthy();
		expect(await testEnv.BICKR_D1.prepare(`SELECT object_id FROM objects_index WHERE object_id = ?`).bind(pending!.id).first()).toBeNull();
		let routed = "";
		const namespace = { idFromName: (id: string) => id, get: (id: string) => ({ fetch: (request: Request) => { routed = id; return handleForumCoordinatorRequest(request, f.env, f.context); } }) };
		await recoverForumCreations({ ...f.env, WORLD_COORDINATOR: namespace } as never, new Date(Date.now() + 1_000).toISOString());
		expect(routed).toBe(f.world.id);
		expect(await visibleCount()).toBe(1);
		expect(await testEnv.BICKR_D1.prepare(`SELECT state, document_json AS document FROM forum_creation_intents WHERE forum_id = ?`).bind(pending!.id).first()).toEqual({ state: "active", document: null });
		expect((await handleForumCoordinatorRequest(f.request(), f.env, f.context)).status).toBe(201);
		expect(await visibleCount()).toBe(1);
	});

	it("atomically publishes every index and the receipt after a failed activation batch", async () => {
		const f = await fixture();
		let fail = true;
		const db = { prepare: testEnv.BICKR_D1.prepare.bind(testEnv.BICKR_D1), batch: async (statements: D1PreparedStatement[]) => {
			if (fail) { fail = false; throw new Error("Injected activation failure"); }
			return testEnv.BICKR_D1.batch(statements);
		} } as D1Database;
		expect((await handleForumCoordinatorRequest(f.request(), { ...f.env, BICKR_D1: db }, f.context)).status).toBe(500);
		expect(await visibleCount()).toBe(0);
		expect((await handleForumCoordinatorRequest(f.request(), f.env, f.context)).status).toBe(201);
		const row = await testEnv.BICKR_D1.prepare(`SELECT f.forum_id AS id FROM forums_index f JOIN objects_index o ON o.object_id = f.forum_id JOIN search_entities_fts s ON s.entity_id = f.forum_id JOIN forum_creation_intents i ON i.forum_id = f.forum_id WHERE f.handle = 'created-once' AND i.state = 'active'`).first<{ id: string }>();
		expect(row).toBeTruthy();
		const document = (await testEnv.BICKR_KV.get(kvKeys.forum(row!.id), { type: "json" })) as Record<string, unknown>;
		await testEnv.BICKR_KV.put(kvKeys.forum(row!.id), JSON.stringify({ ...document, description: { text: "Updated after creation", lang: "en" }, revision: 2 }));
		const retry = await handleForumCoordinatorRequest(f.request(), f.env, f.context);
		expect((await retry.json() as { data: { forum: { description: { text: string } } } }).data.forum.description.text).toBe("Updated after creation");
	});

	it("cancels publication when account deletion starts while KV is awaited", async () => {
		const f = await fixture();
		const kv = { get: testEnv.BICKR_KV.get.bind(testEnv.BICKR_KV), delete: testEnv.BICKR_KV.delete.bind(testEnv.BICKR_KV), put: async (key: string, value: string) => {
			await testEnv.BICKR_KV.put(key, value);
			if (key.startsWith("v1:forum:")) await testEnv.BICKR_D1.prepare(`UPDATE users_index SET lifecycle_state = 'deleting' WHERE user_id = ?`).bind(f.world.owner).run();
		} } as KVNamespace;
		expect((await handleForumCoordinatorRequest(f.request(), { ...f.env, BICKR_KV: kv }, f.context)).status).toBe(403);
		expect(await visibleCount()).toBe(0);
		const row = await testEnv.BICKR_D1.prepare(`SELECT forum_id AS id, state FROM forum_creation_intents WHERE request_key = 'new-forum'`).first<{ id: string; state: string }>();
		expect(row?.state).toBe("cancelled");
		expect(await testEnv.BICKR_KV.get(kvKeys.forum(row!.id))).toBeNull();
		expect(await testEnv.BICKR_D1.prepare(`SELECT entity_id FROM search_entities_fts WHERE entity_id = ?`).bind(row!.id).first()).toBeNull();
		expect(await testEnv.BICKR_D1.prepare(`SELECT object_id FROM objects_index WHERE object_id = ?`).bind(row!.id).first()).toBeNull();
	});
});
