import {
	authCookie,
	createBotForTest,
	createForumForTest,
	createThreadForTest,
	createWorldForTest,
	describe,
	expect,
	fakeSearchBindings,
	it,
	seedWorld,
	testEnv,
} from "./helpers/index-harness";
import { repairObjectIndexes } from "@bickr/shared/index-repair";
import { entityIndexVersions } from "@bickr/shared/index-versions";

describe("KV-to-index repair sweep", () => {
	it("restores a stale thread projection from its newer KV document", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "repair-thread");
		const author = await createBotForTest(cookie, "repair-thread-author");
		const thread = await createThreadForTest(forum.id, author.id, "Repair title", "Repair body.");
		await testEnv.BICKR_D1.prepare(`UPDATE threads_index SET title = 'corrupt' WHERE thread_id = ?`)
			.bind(thread.id)
			.run();
		await testEnv.BICKR_D1.prepare(`UPDATE objects_index SET revision = 0 WHERE object_id = ?`)
			.bind(thread.id)
			.run();

		const result = await repairObjectIndexes({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});

		const repairedThread = await testEnv.BICKR_D1.prepare(
			`SELECT title FROM threads_index WHERE thread_id = ?`,
		)
			.bind(thread.id)
			.first<{ title: string }>();
		expect(repairedThread?.title).toBe("Repair title");
		expect(result.repaired).toBe(1);
		expect(result.budgetExhausted).toBe(false);
	});

	it("reprojects D1, FTS, and Vectorize when index_version is stale", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const world = await testEnv.BICKR_D1.prepare(
			`SELECT world_id AS id FROM worlds_index WHERE handle = 'patch-notes'`,
		).first<{ id: string }>();
		if (!world) {
			throw new Error("Seeded world was not found.");
		}
		await testEnv.BICKR_D1.prepare(`UPDATE worlds_index SET name = 'corrupt' WHERE world_id = ?`)
			.bind(world.id)
			.run();
		await testEnv.BICKR_D1.prepare(
			`DELETE FROM search_entities_fts WHERE entity_type = 'world' AND entity_id = ?`,
		)
			.bind(world.id)
			.run();
		await testEnv.BICKR_D1.prepare(`UPDATE objects_index SET index_version = 0 WHERE object_id = ?`)
			.bind(world.id)
			.run();
		const search = fakeSearchBindings();

		const result = await repairObjectIndexes({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			...search.env,
		});

		const repairedWorld = await testEnv.BICKR_D1.prepare(
			`SELECT name FROM worlds_index WHERE world_id = ?`,
		)
			.bind(world.id)
			.first<{ name: string }>();
		const repairedFts = await testEnv.BICKR_D1.prepare(
			`SELECT title FROM search_entities_fts WHERE entity_type = 'world' AND entity_id = ?`,
		)
			.bind(world.id)
			.first<{ title: string }>();
		const objectIndex = await testEnv.BICKR_D1.prepare(
			`SELECT index_version AS indexVersion FROM objects_index WHERE object_id = ?`,
		)
			.bind(world.id)
			.first<{ indexVersion: number }>();
		expect(repairedWorld?.name).toBe("Patch Notes");
		expect(repairedFts?.title).toContain("Patch Notes");
		expect(objectIndex?.indexVersion).toBe(entityIndexVersions.world);
		expect(search.upserted.map((vector) => vector.id)).toContain(`world:${world.id}`);
		expect(result.repaired).toBe(1);
	});

	it("respects its row budget and resumes after the persisted cursor", async () => {
		const cookie = await authCookie();
		await createWorldForTest(cookie, "repair-budget-a", "Repair Budget A");
		await createWorldForTest(cookie, "repair-budget-b", "Repair Budget B");
		await testEnv.BICKR_D1.prepare(`UPDATE objects_index SET revision = 0`).run();
		const count = await testEnv.BICKR_D1.prepare(`SELECT count(*) AS count FROM objects_index`)
			.first<{ count: number }>();
		expect(count?.count).toBeGreaterThan(2);

		const first = await repairObjectIndexes({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		}, {
			chunkSize: 1,
			maxRowsPerRun: 2,
		});
		expect(first).toEqual({
			scanned: 2,
			repaired: 2,
			budgetExhausted: true,
		});

		const second = await repairObjectIndexes({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		}, {
			chunkSize: 2,
			maxRowsPerRun: 100,
		});
		expect(second.scanned).toBe((count?.count ?? 0) - 2);
		expect(second.repaired).toBe((count?.count ?? 0) - 2);
		expect(second.budgetExhausted).toBe(false);
	});

	it("does not write any indexes for healthy rows", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const search = fakeSearchBindings();
		const rowsBefore = await objectIndexRows();

		const result = await repairObjectIndexes({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			...search.env,
		});

		expect(result.scanned).toBeGreaterThan(0);
		expect(result.repaired).toBe(0);
		expect(await objectIndexRows()).toEqual(rowsBefore);
		expect(search.upserted).toEqual([]);
		expect(search.deleted).toEqual([]);
	});
});

async function objectIndexRows(): Promise<Array<{ id: string; revision: number; indexVersion: number }>> {
	const result = await testEnv.BICKR_D1.prepare(
		`SELECT object_id AS id, revision, index_version AS indexVersion
		 FROM objects_index
		 ORDER BY object_id ASC`,
	).all<{ id: string; revision: number; indexVersion: number }>();
	return result.results ?? [];
}
