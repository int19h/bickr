import {
	authCookie,
	createBotForTest,
	createForumForTest,
	createThreadForTest,
	describe,
	expect,
	forumCoordinatorWorker,
	it,
	kvKeys,
	rawBotById,
	readThread,
	seedWorld,
	testEnv,
} from "./helpers/index-harness";
import { internalServiceAuthHeader } from "@bickr/shared/internal-service";
import { normalizeKvDocuments } from "@bickr/shared/kv-normalization-sweep";
import {
	type BotDocument,
	schemaVersion,
	type LegacyThreadDocument,
	type UserDocument,
	type WorldDocument,
} from "@bickr/shared/model";

describe("KV document normalization sweep", () => {
	it("persists its cursor, resumes, clears the cursor on completion, and is idempotent", async () => {
		const ids = await seedLegacyUsers(3);

		const first = await normalizeKvDocuments(testEnv, "user", { maxRowsPerRun: 1 });
		expect(first).toEqual({ scanned: 1, rewritten: 1, budgetExhausted: true, done: false });
		expect(await normalizationCursor("user")).toEqual({ afterObjectId: ids[0] });

		const second = await normalizeKvDocuments(testEnv, "user", {
			maxRowsPerRun: 10,
			maxWritesPerRun: 1,
		});
		expect(second).toEqual({ scanned: 1, rewritten: 1, budgetExhausted: true, done: false });
		expect(await normalizationCursor("user")).toEqual({ afterObjectId: ids[1] });

		const final = await normalizeKvDocuments(testEnv, "user", { maxRowsPerRun: 10 });
		expect(final).toEqual({ scanned: 1, rewritten: 1, budgetExhausted: false, done: true });
		expect(await normalizationCursor("user")).toBeNull();

		const secondPass = await normalizeKvDocuments(testEnv, "user", { maxRowsPerRun: 10 });
		expect(secondPass).toEqual({ scanned: 3, rewritten: 0, budgetExhausted: false, done: true });
		for (const id of ids) {
			const user = await testEnv.BICKR_KV.get<UserDocument>(kvKeys.user(id), { type: "json" });
			expect(user?.schemaVersion).toBe(schemaVersion);
			expect(user?.displayName).toEqual({ lang: null, text: `Legacy ${id}` });
		}
	});

	it("rewrites the legacy thread shape exactly as the migrate-on-read path does", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "normalize-thread");
		const author = await createBotForTest(cookie, "normalize-thread-author");
		const createdThread = await createThreadForTest(forum.id, author.id, "Legacy sweep", "Legacy body.");
		const thread = await readThread(testEnv.BICKR_KV, createdThread.id);
		const root = thread.comments.find((comment) => comment.id === thread.rootCommentId);
		if (!root) {
			throw new Error("Test thread root comment is missing.");
		}
		const {
			title: _title,
			rootCommentId: _rootCommentId,
			url: _url,
			...withoutCurrentRootFields
		} = thread;
		const legacyThread: LegacyThreadDocument = {
			...withoutCurrentRootFields,
			schemaVersion: 1,
			comments: thread.comments.filter((comment) => comment.id !== root.id),
			rootPost: {
				id: "pst_legacy_sweep",
				threadId: thread.id,
				worldId: thread.worldId,
				worldHandle: thread.worldHandle,
				forumId: thread.forumId,
				forumHandle: thread.forumHandle,
				authorBotId: root.authorBotId,
				authorHandle: root.authorHandle,
				authorDisplayName: root.authorDisplayName,
				title: thread.title,
				body: root.body,
				voteScore: root.voteScore,
				createdAt: "2020-01-01T00:00:00.000Z",
				updatedAt: "2020-01-01T00:00:00.000Z",
			},
		};
		await testEnv.BICKR_KV.put(kvKeys.thread(thread.id), JSON.stringify(legacyThread));
		const migrateOnReadResult = await readThread(testEnv.BICKR_KV, thread.id);

		const result = await normalizeKvDocuments(testEnv, "thread");
		const swept = await testEnv.BICKR_KV.get(kvKeys.thread(thread.id), { type: "json" });
		expect(result).toMatchObject({ rewritten: 1, done: true });
		expect(swept).toEqual(migrateOnReadResult);
		expect(swept).not.toHaveProperty("rootPost");
		expect(swept).toHaveProperty("schemaVersion", schemaVersion);
		expect(await readThread(testEnv.BICKR_KV, thread.id)).toEqual(swept);
		expect((await normalizeKvDocuments(testEnv, "thread")).rewritten).toBe(0);
	});

	it("normalizes legacy reasoningPrefill through the same bot read path", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "normalize-bot");
		const storedBot = await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(bot.id), { type: "json" });
		if (!storedBot) {
			throw new Error("Test bot document is missing.");
		}
		const legacyBot = {
			...storedBot,
			schemaVersion: 1,
			inferenceSettings: {
				...storedBot.inferenceSettings,
				reasoningPrefill: "Remember the migration exactly.  ",
			},
		};
		await testEnv.BICKR_KV.put(kvKeys.bot(bot.id), JSON.stringify(legacyBot));
		const migrateOnReadResult = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);

		const result = await normalizeKvDocuments(testEnv, "bot");
		const swept = await testEnv.BICKR_KV.get(kvKeys.bot(bot.id), { type: "json" });
		expect(result.rewritten).toBe(1);
		expect(swept).toEqual(migrateOnReadResult);
		expect(swept).not.toHaveProperty("inferenceSettings.reasoningPrefill");
		expect(swept).toHaveProperty("inferenceSettings.recurringPrompt", {
			lang: null,
			text: "Remember the migration exactly.  ",
		});
	});

	it("exposes an internal-auth-only endpoint and honors its entity-type filter", async () => {
		const [userId] = await seedLegacyUsers(1);
		if (!userId) {
			throw new Error("Test user document is missing.");
		}
		const worldId = await seedLegacyWorld();
		const body = JSON.stringify({ entityType: "user", maxRowsPerRun: 10, maxWritesPerRun: 10 });
		const spoofed = await forumCoordinatorWorker.fetch(
			new Request("https://forum.example/maintenance/kv-normalize-sweep", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			}) as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[0],
			forumWorkerEnv() as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[1],
		);
		expect(spoofed.status).toBe(404);

		const request = new Request("https://internal.bickr/maintenance/kv-normalize-sweep", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[internalServiceAuthHeader]: "test-internal-service-secret",
			},
			body,
		});
		const response = await forumCoordinatorWorker.fetch(
			request as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[0],
			forumWorkerEnv() as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[1],
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ scanned: 1, rewritten: 1, budgetExhausted: false, done: true });
		expect((await testEnv.BICKR_KV.get<UserDocument>(kvKeys.user(userId), { type: "json" }))?.schemaVersion)
			.toBe(schemaVersion);
		expect((await testEnv.BICKR_KV.get<WorldDocument>(kvKeys.world(worldId), { type: "json" }))?.schemaVersion)
			.toBe(1);
	});
});

async function seedLegacyUsers(count: number): Promise<string[]> {
	const now = "2026-07-11T00:00:00.000Z";
	const ids = Array.from({ length: count }, (_, index) => `usr_normalize_${String(index).padStart(3, "0")}`);
	for (const id of ids) {
		await testEnv.BICKR_KV.put(kvKeys.user(id), JSON.stringify({
			id,
			type: "user",
			schemaVersion: 1,
			revision: 1,
			handle: id,
			language: null,
			displayName: `Legacy ${id}`,
			createdAt: now,
			updatedAt: now,
		}));
		await insertObjectIndex(id, "user", now);
	}
	return ids;
}

async function seedLegacyWorld(): Promise<string> {
	const id = "wld_normalize_filter";
	const now = "2026-07-11T00:00:00.000Z";
	await testEnv.BICKR_KV.put(kvKeys.world(id), JSON.stringify({
		id,
		type: "world",
		schemaVersion: 1,
		revision: 1,
		handle: "normalize-filter",
		language: null,
		name: "Legacy world",
		description: "Legacy description",
		prompt: "Legacy prompt",
		initialBotNotification: "Legacy notification",
		createdByUserId: "usr_normalize_owner",
		visibility: "public",
		createdAt: now,
		updatedAt: now,
	}));
	await insertObjectIndex(id, "world", now);
	return id;
}

async function insertObjectIndex(id: string, type: "user" | "world", now: string): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO objects_index (
			object_id, object_type, world_id, revision, index_version, updated_at, deleted_at
		) VALUES (?, ?, NULL, 1, 1, ?, NULL)`,
	)
		.bind(id, type, now)
		.run();
}

async function normalizationCursor(type: "user"): Promise<{ afterObjectId: string } | null> {
	return testEnv.BICKR_KV.get<{ afterObjectId: string }>(
		kvKeys.kvNormalizationSweepCursor(type),
		{ type: "json" },
	);
}

function forumWorkerEnv() {
	return {
		BICKR_D1: testEnv.BICKR_D1,
		BICKR_KV: testEnv.BICKR_KV,
		INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
	};
}
