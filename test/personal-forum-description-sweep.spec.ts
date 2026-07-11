import {
	authCookie,
	createBotForTest,
	describe,
	expect,
	forumCoordinatorWorker,
	it,
	kvKeys,
	listForums,
	localizedTextString,
	lt,
	seedWorld,
	testEnv,
} from "./helpers/index-harness";
import { internalServiceAuthHeader } from "@bickr/shared/internal-service";
import type { ForumDocument } from "@bickr/shared/model";

describe("personal-forum description resync", () => {
	it("requires internal auth and resumes a bounded cursor until stale documents and indexes are current", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bots = await Promise.all([
			createBotForTest(cookie, "resync-alpha"),
			createBotForTest(cookie, "resync-beta"),
			createBotForTest(cookie, "resync-gamma"),
		]);
		const personalForums = (await listForums(testEnv.BICKR_D1, "patch-notes"))
			.filter((forum) => forum.personalBotId && bots.some((bot) => bot.id === forum.personalBotId));
		expect(personalForums).toHaveLength(3);
		const revisions = new Map<string, number>();
		for (const forum of personalForums) {
			const document = await testEnv.BICKR_KV.get<ForumDocument>(kvKeys.forum(forum.id), { type: "json" });
			if (!document) {
				throw new Error(`Personal forum ${forum.id} is missing.`);
			}
			revisions.set(forum.id, document.revision);
			await testEnv.BICKR_KV.put(kvKeys.forum(forum.id), JSON.stringify({
				...document,
				description: lt("Stale personal forum description"),
			}));
			await testEnv.BICKR_D1.prepare(
				`UPDATE forums_index SET description = ?, description_lang = ? WHERE forum_id = ?`,
			)
				.bind("Stale personal forum description", "en", forum.id)
				.run();
		}

		const spoofed = await runSweep({ maxRowsPerRun: 1, maxWritesPerRun: 1 }, false);
		expect(spoofed.status).toBe(404);

		const first = await runSweep({ maxRowsPerRun: 1, maxWritesPerRun: 1 });
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ scanned: 1, rewritten: 1, done: false });
		expect(await testEnv.BICKR_KV.get(kvKeys.personalForumDescriptionSweepCursor, { type: "json" }))
			.toMatchObject({ afterForumId: expect.any(String) });

		const second = await runSweep({ maxRowsPerRun: 10, maxWritesPerRun: 1 });
		expect(await second.json()).toEqual({ scanned: 1, rewritten: 1, done: false });
		const final = await runSweep({ maxRowsPerRun: 10, maxWritesPerRun: 10 });
		expect(await final.json()).toEqual({ scanned: 1, rewritten: 1, done: true });
		expect(await testEnv.BICKR_KV.get(kvKeys.personalForumDescriptionSweepCursor, { type: "json" }))
			.toBeNull();

		for (const forum of personalForums) {
			const bot = bots.find((candidate) => candidate.id === forum.personalBotId);
			if (!bot) {
				throw new Error(`Owner bot for ${forum.id} is missing.`);
			}
			const expectedDescription = lt(`Blog of ${localizedTextString(bot.displayName)} (u/${bot.handle})`);
			const document = await testEnv.BICKR_KV.get<ForumDocument>(kvKeys.forum(forum.id), { type: "json" });
			expect(document).toMatchObject({
				description: expectedDescription,
				revision: (revisions.get(forum.id) ?? 0) + 1,
			});
			const projection = await testEnv.BICKR_D1.prepare(
				`SELECT description, description_lang AS descriptionLang FROM forums_index WHERE forum_id = ?`,
			)
				.bind(forum.id)
				.first<{ description: string; descriptionLang: string | null }>();
			expect(projection).toEqual({
				description: expectedDescription.text,
				descriptionLang: expectedDescription.lang,
			});
			const objectIndex = await testEnv.BICKR_D1.prepare(
				`SELECT revision FROM objects_index WHERE object_id = ? AND object_type = 'forum'`,
			)
				.bind(forum.id)
				.first<{ revision: number }>();
			expect(objectIndex?.revision).toBe(document?.revision);
		}

		const idempotent = await runSweep({ maxRowsPerRun: 10, maxWritesPerRun: 10 });
		expect(await idempotent.json()).toEqual({ scanned: 3, rewritten: 0, done: true });
	});
});

async function runSweep(
	body: { maxRowsPerRun: number; maxWritesPerRun: number },
	authenticated = true,
): Promise<Response> {
	const headers = new Headers({ "content-type": "application/json" });
	if (authenticated) {
		headers.set(internalServiceAuthHeader, "test-internal-service-secret");
	}
	return forumCoordinatorWorker.fetch(
		new Request("https://internal.bickr/maintenance/personal-forum-descriptions", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		}) as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[0],
		{
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		} as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[1],
	);
}
