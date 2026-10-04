import { describe, expect, it } from "vitest";
import { authCookie, createWorldForTest, seedWorld, testEnv } from "./helpers/index-harness";
import { listBotGroupsPage, listOwnedWorldsPage, listWorldsPage } from "@bickr/shared/repository";

describe("collection pages", () => {
	it("walks worlds and groups with equal creation times while their names and update times change", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		await createWorldForTest(cookie, "second", "Second");
		await createWorldForTest(cookie, "third", "Third");
		const world = (await testEnv.BICKR_D1.prepare("SELECT world_id AS id, created_by_user_id AS owner FROM worlds_index WHERE handle = 'patch-notes'").first<{id: string; owner: string}>())!;
		await testEnv.BICKR_D1.prepare("UPDATE worlds_index SET created_at = '2026-08-01T00:00:00.000Z'").run();
		for (const owned of [false, true]) {
			const ids: string[] = [];
			let cursor: string | undefined;
			for (let i = 0; i < 4; i++) {
				const page = owned ? await listOwnedWorldsPage(testEnv.BICKR_D1, world.owner, {limit: 1, cursor}) : await listWorldsPage(testEnv.BICKR_D1, {limit: 1, cursor});
				ids.push(...page.worlds.map((w) => w.id));
				cursor = page.nextCursor;
				await testEnv.BICKR_D1.prepare("UPDATE worlds_index SET name = 'Edited', updated_at = '2026-10-03T00:00:00.000Z'").run();
				if (!cursor) break;
			}
			expect(ids).toHaveLength(3);
			expect(new Set(ids).size).toBe(3);
		}
		await testEnv.BICKR_D1.batch([0,1,2].map((i) => testEnv.BICKR_D1.prepare(`INSERT INTO bot_groups
			(group_id, world_id, owner_user_id, language, created_at, updated_at) VALUES (?, ?, ?, 'en', ?, ?)`)
			.bind(`group_${i}`, world.id, world.owner, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z")));
		const groups: string[] = [];
		let cursor: string | undefined;
		for (let i = 0; i < 4; i++) {
			const page = await listBotGroupsPage(testEnv.BICKR_KV, testEnv.BICKR_D1, "patch-notes", world.owner, {limit: 1, cursor});
			groups.push(...page.groups.map((g) => g.id)); cursor = page.nextCursor;
			await testEnv.BICKR_D1.prepare("UPDATE bot_groups SET updated_at = '2026-10-03T00:00:00.000Z'").run();
			if (!cursor) break;
		}
		expect(groups).toEqual(["group_0", "group_1", "group_2"]);
	});
});
