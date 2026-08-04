import { beforeEach, describe, expect, it } from "vitest";
import { runForumThreadDeletionSweep } from "@bickr/shared/governance-deletion-sweep";
import { internalServiceAuthHeader } from "@bickr/shared/internal-service";
import { type ForumDocument, type ThreadDocument } from "@bickr/shared/model";
import {
	authCookie,
	createBotForTest,
	createForumForTest,
	createThreadForTest,
	deferred,
	ExclusiveOperationQueue,
	handleForumCoordinatorRequest,
	forumCoordinatorWorker,
	jsonRequest,
	kvKeys,
	kvWithDelayedFirstPut,
	localizedTextString,
	memoryDurableStorage,
	requiredLt,
	resetD1Schema,
	seedWorld,
	testEnv,
} from "./helpers/index-harness";
import { clearKv } from "./helpers/d1-schema";

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
});

describe("coordinator-routed governance deletion", () => {
	it("routes world/forum lifecycle operations to the same ID-named coordinators as child creation", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "deletion-routing");
		const forumDocument = await requiredForumDocument(forum.id);
		const routed = { forums: [] as string[], worlds: [] as string[] };
		const namespace = (names: string[]) => ({
			idFromName(name: string) {
				names.push(name);
				return name as unknown as DurableObjectId;
			},
			get() {
				return { fetch: async () => Response.json({ ok: true }) } as unknown as Fetcher;
			},
		});
		const env = {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			FORUM_COORDINATOR: namespace(routed.forums),
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
			WORLD_COORDINATOR: namespace(routed.worlds),
		};
		const requests = [
			new Request("https://internal.bickr/worlds/patch-notes/forums/deletion-routing", {
				method: "DELETE",
				headers: { [internalServiceAuthHeader]: "test-internal-service-secret" },
			}),
			new Request("https://internal.bickr/worlds/patch-notes/forums", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[internalServiceAuthHeader]: "test-internal-service-secret",
				},
				body: JSON.stringify({
					handle: "queued-create",
					language: "en",
					description: requiredLt("Queued creation."),
				}),
			}),
			new Request("https://internal.bickr/worlds/patch-notes", {
				method: "DELETE",
				headers: { [internalServiceAuthHeader]: "test-internal-service-secret" },
			}),
		];
		for (const request of requests) {
			const response = await forumCoordinatorWorker.fetch(
				request as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[0],
				env as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[1],
			);
			expect(response.status).toBe(200);
		}
		expect(routed.forums).toEqual([forum.id]);
		expect(routed.worlds).toEqual([forumDocument.worldId, forumDocument.worldId]);
	});

	it("orders a racing comment before thread deletion without resurrecting or mixing the document", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "deletion-race");
		const author = await createBotForTest(cookie, "deletion-race-author");
		const replier = await createBotForTest(cookie, "deletion-race-replier");
		const thread = await createThreadForTest(forum.id, author.id, "Deletion ordering", "Root body.");
		const forumDocument = await requiredForumDocument(forum.id);
		const threadPutStarted = deferred<void>();
		const releaseThreadPut = deferred<void>();
		const routedKv = kvWithDelayedFirstPut(
			testEnv.BICKR_KV,
			kvKeys.thread(thread.id),
			threadPutStarted,
			releaseThreadPut,
		);
		const threadContext = coordinatorContext("thread-deletion-race");

		const commentRequest = jsonRequest(
			`https://internal.bickr/threads/${thread.id}/comments`,
			"POST",
			{ body: requiredLt("The comment that won the queue.") },
		);
		commentRequest.headers.set("x-bickr-bot-id", replier.id);
		const commentResponsePromise = handleForumCoordinatorRequest(
			commentRequest,
			coordinatorEnv(routedKv),
			threadContext,
		);
		await threadPutStarted.promise;

		const deletedAt = "2026-07-11T20:00:00.000Z";
		await softDeleteForumForWorld(forumDocument.worldId, forum.id, deletedAt, routedKv);
		const sweepPromise = runForumThreadDeletionSweep({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			deleteThread: async (input) => {
				const request = internalDeletionRequest(input.threadId, input);
				const response = await handleForumCoordinatorRequest(request, coordinatorEnv(routedKv), threadContext);
				expect(response.status).toBe(200);
			},
		}, { forumId: forum.id, deletedAt });

		releaseThreadPut.resolve();
		const [commentResponse, sweep] = await Promise.all([commentResponsePromise, sweepPromise]);
		expect(commentResponse.status).toBe(201);
		expect(sweep).toEqual({ done: true, processed: 1 });

		const stored = await testEnv.BICKR_KV.get<ThreadDocument>(kvKeys.thread(thread.id), { type: "json" });
		expect(stored?.deletedAt).toBe(deletedAt);
		expect(stored?.comments.map((comment) => localizedTextString(comment.body))).toContain(
			"The comment that won the queue.",
		);
		const index = await testEnv.BICKR_D1.prepare(
			`SELECT deleted_at AS deletedAt FROM threads_index WHERE thread_id = ?`,
		)
			.bind(thread.id)
			.first<{ deletedAt: string | null }>();
		expect(index?.deletedAt).toBe(deletedAt);
	});

	it("persists a per-forum cursor and completes a many-thread deletion across bounded invocations", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "deletion-resume");
		const author = await createBotForTest(cookie, "deletion-resume-author");
		const threads = [];
		for (let index = 0; index < 5; index += 1) {
			threads.push(await createThreadForTest(forum.id, author.id, `Resume ${index}`, `Body ${index}.`));
		}
		const forumDocument = await requiredForumDocument(forum.id);
		const deletedAt = "2026-07-11T21:00:00.000Z";
		await softDeleteForumForWorld(forumDocument.worldId, forum.id, deletedAt);

		const contexts = new Map<string, ReturnType<typeof coordinatorContext>>();
		const run = () => runForumThreadDeletionSweep({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			deleteThread: async (input) => {
				const context = contexts.get(input.threadId) ?? coordinatorContext(input.threadId);
				contexts.set(input.threadId, context);
				const response = await handleForumCoordinatorRequest(
					internalDeletionRequest(input.threadId, input),
					coordinatorEnv(testEnv.BICKR_KV),
					context,
				);
				expect(response.status).toBe(200);
			},
		}, { forumId: forum.id, deletedAt }, { maxRowsPerRun: 2 });
		const sortedIds = threads.map((thread) => thread.id).sort();
		const cursorKey = kvKeys.forumThreadDeletionSweepCursor(forum.id);

		expect(await run()).toEqual({ done: false, processed: 2 });
		expect(await testEnv.BICKR_KV.get(cursorKey, { type: "json" })).toEqual({ afterId: sortedIds[1] });
		expect(await run()).toEqual({ done: false, processed: 2 });
		expect(await testEnv.BICKR_KV.get(cursorKey, { type: "json" })).toEqual({ afterId: sortedIds[3] });
		expect(await run()).toEqual({ done: true, processed: 1 });
		expect(await testEnv.BICKR_KV.get(cursorKey, { type: "json" })).toBeNull();

		for (const thread of threads) {
			const stored = await testEnv.BICKR_KV.get<ThreadDocument>(kvKeys.thread(thread.id), { type: "json" });
			expect(stored?.deletedAt).toBe(deletedAt);
		}
	});

	it("rejects thread creation, replies, and votes once the forum marker is visible", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "deletion-liveness");
		const author = await createBotForTest(cookie, "deletion-liveness-author");
		const thread = await createThreadForTest(forum.id, author.id, "Gone forum", "Root body.");
		const forumDocument = await requiredForumDocument(forum.id);
		await softDeleteForumForWorld(
			forumDocument.worldId,
			forum.id,
			"2026-07-11T22:00:00.000Z",
		);

		const commentRequest = jsonRequest(
			`https://internal.bickr/threads/${thread.id}/comments`,
			"POST",
			{ body: requiredLt("Too late.") },
		);
		commentRequest.headers.set("x-bickr-bot-id", author.id);
		const threadRequest = jsonRequest(
			`https://internal.bickr/forums/${forum.id}/threads`,
			"POST",
			{ title: requiredLt("Too late"), body: requiredLt("The forum is gone.") },
		);
		threadRequest.headers.set("x-bickr-bot-id", author.id);
		const voteRequest = jsonRequest(
			"https://internal.bickr/votes",
			"POST",
			{ threadId: thread.id, value: 1 },
		);
		voteRequest.headers.set("x-bickr-bot-id", author.id);

		for (const request of [commentRequest, threadRequest, voteRequest]) {
			const response = await handleForumCoordinatorRequest(request, coordinatorEnv(testEnv.BICKR_KV));
			expect(response.status).toBe(410);
			expect(await response.json()).toMatchObject({ message: "This forum has been deleted." });
		}
	});
});

function coordinatorEnv(kv: KVNamespace) {
	return {
		BICKR_D1: testEnv.BICKR_D1,
		BICKR_KV: kv,
	};
}

function coordinatorContext(objectId: string) {
	return {
		cache: { entry: null },
		objectId,
		queue: new ExclusiveOperationQueue(),
		storage: memoryDurableStorage().storage,
	};
}

function internalDeletionRequest(threadId: string, body: unknown): Request {
	return new Request(`https://internal.bickr/threads/${threadId}/soft-delete`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			[internalServiceAuthHeader]: "test-internal-service-secret",
		},
		body: JSON.stringify(body),
	});
}

async function softDeleteForumForWorld(
	worldId: string,
	forumId: string,
	deletedAt: string,
	kv: KVNamespace = testEnv.BICKR_KV,
): Promise<void> {
	const request = new Request(`https://internal.bickr/forums/${encodeURIComponent(forumId)}/soft-delete`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			[internalServiceAuthHeader]: "test-internal-service-secret",
		},
		body: JSON.stringify({ worldId, forumId, deletedAt }),
	});
	const response = await handleForumCoordinatorRequest(request, coordinatorEnv(kv), {
		objectId: forumId,
		queue: new ExclusiveOperationQueue(),
		storage: memoryDurableStorage().storage,
	});
	expect(response.status).toBe(200);
}

async function requiredForumDocument(forumId: string): Promise<ForumDocument> {
	const forum = await testEnv.BICKR_KV.get<ForumDocument>(kvKeys.forum(forumId), { type: "json" });
	if (!forum) {
		throw new Error("Expected forum document.");
	}
	return forum;
}
