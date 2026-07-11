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
	readThread,
	seedWorld,
	testEnv,
} from "./helpers/index-harness";
import { internalServiceAuthHeader } from "@bickr/shared/internal-service";
import { normalizeKvDocuments } from "@bickr/shared/kv-normalization-sweep";
import {
	type BotDocument,
	schemaVersion,
	type ThreadDocument,
	type UserDocument,
	type WorldDocument,
} from "@bickr/shared/model";
import { type KVNamespaceLike } from "@bickr/shared/storage";

describe("KV document normalization sweep", () => {
	it("persists its cursor, resumes, clears the cursor on completion, and is idempotent", async () => {
		const ids = await seedLegacyUsers(3);

		const first = await normalizeKvDocuments(testEnv, "user", { maxRowsPerRun: 1 });
		expect(first).toEqual(sweepResult({ scanned: 1, rewritten: 1, budgetExhausted: true, done: false }));
		expect(await normalizationCursor("user")).toEqual({ afterObjectId: ids[0] });

		const second = await normalizeKvDocuments(testEnv, "user", {
			maxRowsPerRun: 10,
			maxWritesPerRun: 1,
		});
		expect(second).toEqual(sweepResult({ scanned: 1, rewritten: 1, budgetExhausted: true, done: false }));
		expect(await normalizationCursor("user")).toEqual({ afterObjectId: ids[1] });

		const final = await normalizeKvDocuments(testEnv, "user", { maxRowsPerRun: 10 });
		expect(final).toEqual(sweepResult({ scanned: 1, rewritten: 1, budgetExhausted: false, done: true }));
		expect(await normalizationCursor("user")).toBeNull();

		const secondPass = await normalizeKvDocuments(testEnv, "user", { maxRowsPerRun: 10 });
		expect(secondPass).toEqual(sweepResult({ scanned: 3, rewritten: 0, budgetExhausted: false, done: true }));
		for (const id of ids) {
			const user = await testEnv.BICKR_KV.get<UserDocument>(kvKeys.user(id), { type: "json" });
			expect(user?.schemaVersion).toBe(schemaVersion);
			expect(user?.displayName).toEqual({ lang: null, text: `Legacy ${id}` });
		}
	});

	it("skips recently updated documents and reports that the pass is not done", async () => {
		const updatedAt = "2026-07-11T06:00:00.000Z";
		const [id] = await seedLegacyUsers(1, updatedAt);
		if (!id) {
			throw new Error("Test user document is missing.");
		}

		const result = await normalizeKvDocuments(testEnv, "user", {
			now: "2026-07-11T07:00:00.000Z",
		});

		expect(result).toEqual(sweepResult({
			scanned: 1,
			rewritten: 0,
			skippedRecentlyUpdated: 1,
			budgetExhausted: false,
			done: false,
		}));
		expect((await testEnv.BICKR_KV.get<UserDocument>(kvKeys.user(id), { type: "json" }))?.schemaVersion)
			.toBe(1);
	});

	it("preserves an update interleaved between the initial read and pre-write recheck", async () => {
		const [id] = await seedLegacyUsers(1);
		if (!id) {
			throw new Error("Test user document is missing.");
		}
		const key = kvKeys.user(id);
		const interleaved = {
			...(await testEnv.BICKR_KV.get<UserDocument>(key, { type: "json" })),
			revision: 2,
			updatedAt: "2020-01-02T00:00:00.000Z",
			displayName: "Interleaved update survives",
		};
		let documentReads = 0;
		const interleavingKv: KVNamespaceLike = {
			get: async (readKey, options) => {
				const value = await testEnv.BICKR_KV.get(readKey, options);
				if (readKey === key) {
					documentReads += 1;
					if (documentReads === 2) {
						await testEnv.BICKR_KV.put(key, JSON.stringify(interleaved));
						return interleaved;
					}
				}
				return value;
			},
			put: testEnv.BICKR_KV.put.bind(testEnv.BICKR_KV),
			delete: testEnv.BICKR_KV.delete.bind(testEnv.BICKR_KV),
		};

		const result = await normalizeKvDocuments({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: interleavingKv,
		}, "user");

		expect(result).toEqual(sweepResult({
			scanned: 1,
			rewritten: 0,
			skippedChangedDuringSweep: 1,
			budgetExhausted: false,
			done: false,
		}));
		expect(await testEnv.BICKR_KV.get(key, { type: "json" })).toEqual(interleaved);
	});

	it("round-trips current thread documents identically after retiring stored hotScore stripping", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "normalize-thread");
		const author = await createBotForTest(cookie, "normalize-thread-author");
		const createdThread = await createThreadForTest(forum.id, author.id, "Current sweep", "Current body.");
		const stored = await testEnv.BICKR_KV.get<ThreadDocument>(kvKeys.thread(createdThread.id), { type: "json" });
		expect(stored).not.toBeNull();
		expect(stored).not.toHaveProperty("hotScore");
		expect(await readThread(testEnv.BICKR_KV, createdThread.id)).toEqual(stored);

		const result = await normalizeKvDocuments({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			normalizeThread: async () => {
				throw new Error("Current-format thread unexpectedly required a rewrite.");
			},
		}, "thread");
		expect(result).toMatchObject({ rewritten: 0, done: true });
		expect(await testEnv.BICKR_KV.get<ThreadDocument>(kvKeys.thread(createdThread.id), { type: "json" }))
			.toEqual(stored);
	});

	it("round-trips current-format recurringPrompt settings identically with the alias gone", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "normalize-bot");
		const storedBot = await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(bot.id), { type: "json" });
		if (!storedBot) {
			throw new Error("Test bot document is missing.");
		}
		const currentBot: BotDocument = {
			...storedBot,
			inferenceSettings: {
				...storedBot.inferenceSettings,
				recurringPrompt: { lang: null, text: "Remember the current format exactly.  " },
			},
		};
		await testEnv.BICKR_KV.put(kvKeys.bot(bot.id), JSON.stringify(currentBot));

		const result = await normalizeKvDocuments(testEnv, "bot");
		const swept = await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(bot.id), { type: "json" });
		expect(result).toMatchObject({ rewritten: 0, done: true });
		expect(swept).toEqual(currentBot);
		expect(swept).toHaveProperty("inferenceSettings.recurringPrompt", {
			lang: null,
			text: "Remember the current format exactly.  ",
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
		expect(await response.json()).toEqual(sweepResult({
			scanned: 1,
			rewritten: 1,
			budgetExhausted: false,
			done: true,
		}));
		expect((await testEnv.BICKR_KV.get<UserDocument>(kvKeys.user(userId), { type: "json" }))?.schemaVersion)
			.toBe(schemaVersion);
		expect((await testEnv.BICKR_KV.get<WorldDocument>(kvKeys.world(worldId), { type: "json" }))?.schemaVersion)
			.toBe(1);
	});
});

async function seedLegacyUsers(count: number, now = "2020-01-01T00:00:00.000Z"): Promise<string[]> {
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
	const now = "2020-01-01T00:00:00.000Z";
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

function sweepResult(overrides: Partial<{
	scanned: number;
	rewritten: number;
	skippedRecentlyUpdated: number;
	skippedChangedDuringSweep: number;
	budgetExhausted: boolean;
	done: boolean;
}>) {
	return {
		scanned: 0,
		rewritten: 0,
		skippedRecentlyUpdated: 0,
		skippedChangedDuringSweep: 0,
		budgetExhausted: false,
		done: false,
		...overrides,
	};
}
