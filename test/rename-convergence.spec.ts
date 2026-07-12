import { beforeEach, describe, expect, it } from "vitest";
import { internalServiceAuthHeader } from "@bickr/shared/internal-service";
import { type BotDocument, type ForumDocument, type ThreadDocument } from "@bickr/shared/model";
import {
	handleAgentRuntimeRequest,
	runPendingUserBotsConvergenceTask,
} from "../workers/agent-runtime/src/index";
import {
	ExclusiveOperationQueue,
	handleForumCoordinatorRequest,
	runPendingObjectIndexConvergenceTask,
} from "../workers/forum-coordinator/src/index";
import {
	authCookie,
	createBotForTest,
	createForumForTest,
	createThreadForTest,
	fakeSearchBindings,
	jsonRequest,
	kvKeys,
	memoryDurableStorage,
	resetD1Schema,
	seedWorld,
	testEnv,
	userIdForHandle,
} from "./helpers/index-harness";
import { clearKv } from "./helpers/d1-schema";

const internalSecret = "rename-convergence-secret";

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
});

describe("rename convergence tasks", () => {
	it("resumes a many-thread world rename by cursor and refreshes every projection", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "rename-many");
		const bot = await createBotForTest(cookie, "rename-many-author");
		const threads = [];
		for (let index = 0; index < 32; index += 1) {
			threads.push(await createThreadForTest(forum.id, bot.id, `Rename ${index}`, `Body ${index}.`));
		}
		const userId = await userIdForHandle("octocat");
		const search = fakeSearchBindings();
		const storage = memoryDurableStorage();
		const env = forumEnv(search.env);
		const request = jsonRequest(
			"https://internal.bickr/worlds/patch-notes",
			"PATCH",
			{ handle: "release-notes" },
			undefined,
			{
				[internalServiceAuthHeader]: internalSecret,
				"x-bickr-user-id": userId,
			},
		);

		const response = await handleForumCoordinatorRequest(request, env, coordinatorContext(storage.storage));
		expect(response.status, await response.clone().text()).toBe(200);
		expect(storage.values.get("object-index-convergence-task")).toMatchObject({
			scope: { kind: "world" },
		});
		expect(storage.values.get("__alarm")).toEqual(expect.any(Number));

		const foregroundThread = await threadDocument(threads[0]!.id);
		expect(foregroundThread.worldHandle).toBe("patch-notes");
		const indexedThread = await testEnv.BICKR_D1.prepare(
			`SELECT world_handle AS worldHandle FROM threads_index WHERE thread_id = ?`,
		)
			.bind(threads[0]!.id)
			.first<{ worldHandle: string }>();
		expect(indexedThread?.worldHandle).toBe("release-notes");

		let invocations = 0;
		while (storage.values.has("object-index-convergence-task")) {
			invocations += 1;
			// A fresh context models eviction between alarm deliveries. Only the
			// durable task and cursor survive.
			await runPendingObjectIndexConvergenceTask(
				env,
				coordinatorContext(storage.storage),
				{ chunkSize: 4, maxRowsPerRun: 7, maxRepairsPerRun: 7 },
			);
		}
		expect(invocations).toBeGreaterThan(4);

		for (const thread of threads) {
			expect((await threadDocument(thread.id)).worldHandle).toBe("release-notes");
		}
		const forumDocument = await testEnv.BICKR_KV.get<ForumDocument>(kvKeys.forum(forum.id), { type: "json" });
		const botDocument = await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(bot.id), { type: "json" });
		expect(forumDocument?.worldHandle).toBe("release-notes");
		expect(botDocument?.homeWorldHandle).toBe("release-notes");

		const stale = await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count
			 FROM objects_index
			 WHERE world_id = ? AND index_version = 0`,
		)
			.bind(forum.worldId)
			.first<{ count: number }>();
		expect(stale?.count).toBe(0);
		const fts = await testEnv.BICKR_D1.prepare(
			`SELECT entity_type AS type, world_handle AS worldHandle
			 FROM search_entities_fts
			 WHERE entity_id IN (?, ?)
			 ORDER BY entity_type`,
		)
			.bind(forum.id, bot.id)
			.all<{ type: string; worldHandle: string }>();
		expect(fts.results).toEqual([
			{ type: "bot", worldHandle: "release-notes" },
			{ type: "forum", worldHandle: "release-notes" },
		]);
		const vectorMetadata = new Map(search.upserted.map((vector) => [vector.id, vector.metadata]));
		expect(vectorMetadata.get(`forum:${forum.id}`)?.worldHandle).toBe("release-notes");
		expect(vectorMetadata.get(bot.id)?.worldHandle).toBe("release-notes");
	});

	it("retries a partially applied world batch without leaving mixed documents", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "rename-failure");
		const bot = await createBotForTest(cookie, "rename-failure-author");
		const threads = [];
		for (let index = 0; index < 6; index += 1) {
			threads.push(await createThreadForTest(forum.id, bot.id, `Failure ${index}`, `Body ${index}.`));
		}
		const storage = memoryDurableStorage();
		const search = fakeSearchBindings();
		const env = forumEnv(search.env);
		const response = await handleForumCoordinatorRequest(
			jsonRequest(
				"https://internal.bickr/worlds/patch-notes",
				"PATCH",
				{ handle: "failure-recovered" },
				undefined,
				{
					[internalServiceAuthHeader]: internalSecret,
					"x-bickr-user-id": await userIdForHandle("octocat"),
				},
			),
			env,
			coordinatorContext(storage.storage),
		);
		expect(response.status).toBe(200);

		let failed = false;
		const failingKv = {
			get: testEnv.BICKR_KV.get.bind(testEnv.BICKR_KV),
			delete: testEnv.BICKR_KV.delete.bind(testEnv.BICKR_KV),
			put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
				if (!failed && key.startsWith("v1:thread:")) {
					failed = true;
					throw new Error("simulated interrupted KV batch");
				}
				await testEnv.BICKR_KV.put(key, value, options);
			},
		} as KVNamespace;
		await expect(runPendingObjectIndexConvergenceTask(
			{ ...env, BICKR_KV: failingKv },
			coordinatorContext(storage.storage),
		)).rejects.toThrow("simulated interrupted KV batch");
		expect(storage.values.has("object-index-convergence-task")).toBe(true);

		await runPendingObjectIndexConvergenceTask(env, coordinatorContext(storage.storage));
		expect(storage.values.has("object-index-convergence-task")).toBe(false);
		for (const thread of threads) {
			expect((await threadDocument(thread.id)).worldHandle).toBe("failure-recovered");
		}
	});

	it("uses the same scoped task for forum and participant personal-forum renames", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "rename-forum");
		const bot = await createBotForTest(cookie, "rename-participant");
		const forumThread = await createThreadForTest(forum.id, bot.id, "Forum rename", "Forum body.");
		const personalForum = await testEnv.BICKR_D1.prepare(
			`SELECT forum_id AS id FROM forums_index WHERE personal_bot_id = ?`,
		)
			.bind(bot.id)
			.first<{ id: string }>();
		if (!personalForum) {
			throw new Error("Expected personal forum.");
		}
		const personalThread = await createThreadForTest(personalForum.id, bot.id, "Participant rename", "Personal body.");
		const userId = await userIdForHandle("octocat");
		const search = fakeSearchBindings();

		const forumStorage = memoryDurableStorage();
		const forumResponse = await handleForumCoordinatorRequest(
			jsonRequest(
				"https://internal.bickr/worlds/patch-notes/forums/rename-forum",
				"PATCH",
				{ handle: "renamed-forum" },
				undefined,
				{
					[internalServiceAuthHeader]: internalSecret,
					"x-bickr-user-id": userId,
				},
			),
			forumEnv(search.env),
			coordinatorContext(forumStorage.storage),
		);
		expect(forumResponse.status).toBe(200);
		expect((await threadDocument(forumThread.id)).forumHandle).toBe("rename-forum");
		await runPendingObjectIndexConvergenceTask(
			forumEnv(search.env),
			coordinatorContext(forumStorage.storage),
		);
		expect((await threadDocument(forumThread.id)).forumHandle).toBe("renamed-forum");

		const botStorage = memoryDurableStorage();
		const botRequest = jsonRequest(
			`https://internal.bickr/users/${userId}/bots/${bot.id}`,
			"PATCH",
			{ handle: "renamed-participant", language: "en", displayName: "Renamed Participant" },
			undefined,
			{ "x-bickr-user-id": userId },
		);
		const agentEnv = {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			...search.env,
		} as Parameters<typeof handleAgentRuntimeRequest>[1];
		const botResponse = await handleAgentRuntimeRequest(botRequest, agentEnv, {
			objectId: userId,
			storage: botStorage.storage,
		});
		expect(botResponse.status, await botResponse.clone().text()).toBe(200);
		expect((await threadDocument(personalThread.id)).forumHandle).toBe("rename-participant");
		await runPendingUserBotsConvergenceTask(agentEnv, {
			objectId: userId,
			storage: botStorage.storage,
		});
		expect((await threadDocument(personalThread.id)).forumHandle).toBe("renamed-participant");
		const storedPersonalForum = await testEnv.BICKR_KV.get<ForumDocument>(kvKeys.forum(personalForum.id), { type: "json" });
		expect(storedPersonalForum).toMatchObject({
			handle: "renamed-participant",
			description: { text: expect.stringContaining("Renamed Participant") },
		});
	});
});

function forumEnv(
	searchEnv: ReturnType<typeof fakeSearchBindings>["env"],
): Parameters<typeof handleForumCoordinatorRequest>[1] {
	return {
		BICKR_D1: testEnv.BICKR_D1,
		BICKR_KV: testEnv.BICKR_KV,
		INTERNAL_SERVICE_SECRET: internalSecret,
		...(searchEnv.AI ? { AI: searchEnv.AI as Ai } : {}),
		...(searchEnv.BICKR_SEARCH_VECTORIZE ? {
			BICKR_SEARCH_VECTORIZE: searchEnv.BICKR_SEARCH_VECTORIZE as Vectorize,
		} : {}),
	};
}

function coordinatorContext(storage: DurableObjectStorage) {
	return {
		objectId: "rename-coordinator",
		queue: new ExclusiveOperationQueue(),
		storage,
	};
}

async function threadDocument(threadId: string): Promise<ThreadDocument> {
	const thread = await testEnv.BICKR_KV.get<ThreadDocument>(kvKeys.thread(threadId), { type: "json" });
	if (!thread) {
		throw new Error(`Expected thread ${threadId}.`);
	}
	return thread;
}
