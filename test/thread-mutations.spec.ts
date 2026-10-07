import forumCoordinatorWorker from "../workers/forum-coordinator/src/index";
import { commitThreadMutation, pruneThreadMutationReceipts, replayThreadMutationReceipt } from "../workers/forum-coordinator/src/thread-mutations";
import { beforeEach, describe, expect, it } from "vitest";
import { readThread } from "@bickr/shared/social";
import { botServiceIssueManifest, isCommittedBotServiceIssue } from "@bickr/shared/bot-service-issues";
import { parseInstructionIssue } from "@bickr/shared/instruction-issues";
import { type ForumDocument } from "@bickr/shared/model";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";
import { authCookie, createBotForTest, createCommentForTest, createForumForTest, createThreadForTest, ExclusiveOperationQueue, handleForumCoordinatorRequest, jsonRequest, kvKeys, memoryDurableStorage, requiredLt, seedWorld, testEnv } from "./helpers/index-harness";

beforeEach(async () => { await resetD1Schema(testEnv.BICKR_D1); await clearKv(testEnv.BICKR_KV); });

async function fixture() {
	const cookie = await authCookie();
	await seedWorld(cookie);
	const forum = await createForumForTest(cookie, "durable-mutation");
	const bot = await createBotForTest(cookie, "durable-author");
	const thread = await createThreadForTest(forum.id, bot.id, "Durable thread", "Root.");
	const forumDoc = await testEnv.BICKR_KV.get<ForumDocument>(kvKeys.forum(forum.id), { type: "json" });
	const durable = memoryDurableStorage();
	const context = () => ({ objectId: thread.id, storage: durable.storage, cache: { entry: null }, queue: new ExclusiveOperationQueue() });
	const env = { BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV };
	const post = (key: string, body = "One new reply") => {
		const request = jsonRequest(`https://internal.bickr/threads/${thread.id}/comments`, "POST", { body: requiredLt(body) });
		request.headers.set("x-bickr-bot-id", bot.id);
		request.headers.set("x-bickr-idempotency-key", key);
		return request;
	};
	return { forum, bot, thread, owner: forumDoc!.createdByUserId, durable, context, env, post };
}

async function expectCommittedResultUnavailable(response: Response): Promise<void> {
	expect(response.status).toBe(503);
	const body = await response.json() as { details: { botIssue: unknown } };
	const issue = parseInstructionIssue(botServiceIssueManifest, body.details.botIssue);
	expect(issue).not.toBeNull();
	expect(issue && isCommittedBotServiceIssue(issue)).toBe(true);
}

describe("durable thread mutations", () => {
	it("retains a replacement receipt when an old expiry entry survives the cleanup budget", async () => {
		const durable = memoryDurableStorage();
		const oldTime = Date.now() - 31 * 24 * 60 * 60_000;
		for (let index = 0; index < 26; index += 1) {
			await commitThreadMutation(durable.storage, testEnv.BICKR_D1, "receipt-owner", {
				id: String(index), createdAt: oldTime + index, requestHash: "same", receiptKey: `thread-mutation/receipt/${index}`,
				response: { status: 200, headers: [], body: "{}" }, thread: null, kv: [], sql: [],
			});
		}
		await pruneThreadMutationReceipts(durable.storage);
		const identity = { requestHash: "same", receiptKey: "thread-mutation/receipt/25" };
		await commitThreadMutation(durable.storage, testEnv.BICKR_D1, "receipt-owner", {
			id: "replacement", createdAt: Date.now(), ...identity,
			response: { status: 201, headers: [], body: "fresh" }, thread: null, kv: [], sql: [],
		});
		await pruneThreadMutationReceipts(durable.storage);
		expect(await replayThreadMutationReceipt(durable.storage, identity)).toEqual({ kind: "response", response: { status: 201, headers: [], body: "fresh" } });
	});

	it("preserves vote retry identity through the Worker router and stores compact receipts", async () => {
		const f = await fixture();
		const cookie = await authCookie();
		const voter = await createBotForTest(cookie, "durable-voter");
		const owner = f.context();
		const namespace = {
			idFromName: (id: string) => id as unknown as DurableObjectId,
			get: () => ({ fetch: (request: Request) => handleForumCoordinatorRequest(request, f.env, owner) }),
		} as unknown as DurableObjectNamespace;
		const env = { ...f.env, FORUM_COORDINATOR: namespace, WORLD_COORDINATOR: namespace, INTERNAL_SERVICE_SECRET: "test-secret" } as Parameters<typeof forumCoordinatorWorker.fetch>[1];
		const vote = (key: string, value: number) => forumCoordinatorWorker.fetch(jsonRequest("https://internal.bickr/votes", "POST", { commentId: f.thread.rootCommentId, value }, undefined, {
			"x-bickr-bot-id": voter.id, "x-bickr-idempotency-key": key, "x-bickr-internal-auth": "test-secret",
		}) as never, env);
		expect((await vote("up", 1)).status).toBe(200);
		expect((await vote("down", -1)).status).toBe(200);
		expect((await vote("up", 1)).status).toBe(200);
		expect((await vote("up", -1)).status).toBe(409);
		expect(await testEnv.BICKR_D1.prepare(`SELECT value FROM votes WHERE target_type = 'comment' AND target_id = ? AND bot_id = ?`).bind(f.thread.rootCommentId, voter.id).first()).toEqual({ value: -1 });
		const receiptChunks = [...f.durable.values.entries()].filter(([key, value]) => key.startsWith("thread-mutation/receipt/") && typeof value === "string");
		expect(receiptChunks).toHaveLength(2);
		for (const [, chunk] of receiptChunks) {
			expect(String(chunk).length).toBeLessThan(1024);
			expect(String(chunk)).not.toContain("Root.");
		}
	});

	it("replays a comment identity against the current thread and never recreates a deleted result", async () => {
		const f = await fixture();
		const response = await handleForumCoordinatorRequest(f.post("post-reply"), f.env, f.context());
		const payload = await response.json() as { data: { comment: { id: string } } };
		await handleForumCoordinatorRequest(f.post("post-later", "Later reply"), f.env, f.context());
		const retry = await handleForumCoordinatorRequest(f.post("post-reply"), f.env, f.context());
		const replayed = await retry.json() as { data: { comment: { id: string }; thread: { comments: unknown[] } } };
		expect(replayed.data.comment.id).toBe(payload.data.comment.id);
		expect(replayed.data.thread.comments).toHaveLength(3);
		await handleForumCoordinatorRequest(new Request(`https://internal.bickr/forums/${f.forum.id}/threads/${f.thread.id}/comments/${payload.data.comment.id}`, { method: "DELETE", headers: { "x-bickr-user-id": f.owner } }), f.env, f.context());
		expect((await handleForumCoordinatorRequest(f.post("post-reply"), f.env, f.context())).status).toBe(410);
		expect((await readThread(testEnv.BICKR_KV, f.thread.id)).comments).toHaveLength(2);
	});

	it("recovers creation after the thread writer commits but its handoff response is lost", async () => {
		const f = await fixture();
		const owners = new Map<string, ReturnType<typeof f.context>>();
		let loseResponse = true;
		const namespace = {
			idFromName: (id: string) => id as unknown as DurableObjectId,
			get: (id: DurableObjectId) => ({ fetch: async (request: Request) => {
				const key = String(id);
				if (!owners.has(key)) owners.set(key, { ...f.context(), objectId: key, storage: memoryDurableStorage().storage });
				const response = await handleForumCoordinatorRequest(request, f.env, owners.get(key)!);
				if (loseResponse) { loseResponse = false; throw new Error("Lost handoff response"); }
				return response;
			} }),
		} as unknown as DurableObjectNamespace;
		const request = () => jsonRequest(`https://internal.bickr/forums/${f.forum.id}/threads`, "POST", { title: requiredLt("Created once"), body: requiredLt("Root body") }, undefined, { "x-bickr-bot-id": f.bot.id, "x-bickr-idempotency-key": "creation-retry" });
		const creator = { ...f.context(), objectId: f.forum.id };
		const env = { ...f.env, FORUM_COORDINATOR: namespace };
		await expectCommittedResultUnavailable(await handleForumCoordinatorRequest(request(), env, creator));
		expect((await handleForumCoordinatorRequest(request(), env, creator)).status).toBe(201);
		expect(await testEnv.BICKR_D1.prepare(`SELECT count(*) AS count FROM threads_index WHERE forum_id = ? AND title = ?`).bind(f.forum.id, "Created once").first()).toEqual({ count: 1 });
	});

	it("replays a failed D1 projection before the next deletion without resurrecting a comment", async () => {
		const f = await fixture();
		const first = await createCommentForTest(f.thread.id, f.bot.id, "First reply");
		const second = await createCommentForTest(f.thread.id, f.bot.id, "Second reply");
		let batches = 0;
		const db = { prepare: testEnv.BICKR_D1.prepare.bind(testEnv.BICKR_D1), batch: async (statements: D1PreparedStatement[]) => {
			batches += 1;
			if (batches === 2) throw new Error("Injected projection failure");
			return testEnv.BICKR_D1.batch(statements);
		} } as D1Database;
		const remove = (id: string) => {
			const request = new Request(`https://internal.bickr/forums/${f.forum.id}/threads/${f.thread.id}/comments/${id}`, { method: "DELETE", headers: { "x-bickr-user-id": f.owner } });
			return request;
		};
		await expectCommittedResultUnavailable(await handleForumCoordinatorRequest(remove(first.id), { ...f.env, BICKR_D1: db }, f.context()));
		expect((await handleForumCoordinatorRequest(remove(second.id), f.env, f.context())).status).toBe(200);
		expect((await readThread(testEnv.BICKR_KV, f.thread.id)).comments.map((comment) => comment.id)).toEqual([f.thread.rootCommentId]);
	});

	it("returns the original post receipt after projection commit but before pending-plan cleanup", async () => {
		const f = await fixture();
		const transaction = f.durable.storage.transaction.bind(f.durable.storage);
		let calls = 0;
		f.durable.storage.transaction = async (closure) => {
			calls += 1;
			if (calls === 2) throw new Error("Injected cleanup failure");
			return transaction(closure);
		};
		await expectCommittedResultUnavailable(await handleForumCoordinatorRequest(f.post("same-post"), f.env, f.context()));
		const retried = await handleForumCoordinatorRequest(f.post("same-post"), f.env, f.context());
		expect(retried.status).toBe(201);
		expect((await readThread(testEnv.BICKR_KV, f.thread.id)).comments).toHaveLength(2);
		expect((await handleForumCoordinatorRequest(f.post("same-post", "Different payload"), f.env, f.context())).status).toBe(409);
		expect(await testEnv.BICKR_D1.prepare(`SELECT coordinator_id FROM thread_mutation_wakes WHERE coordinator_id = ?`).bind(f.thread.id).first()).toBeNull();
	});

	it("does not publish a document when its canonical storage transaction fails", async () => {
		const f = await fixture();
		const put = f.durable.storage.put.bind(f.durable.storage);
		f.durable.storage.put = (async (key: string, value: unknown) => {
			if (key.startsWith("thread-mutation/canonical")) throw new Error("Injected canonical commit failure");
			return put(key, value);
		}) as DurableObjectStorage["put"];
		expect((await handleForumCoordinatorRequest(f.post("failed-commit"), f.env, f.context())).status).toBe(500);
		expect((await readThread(testEnv.BICKR_KV, f.thread.id)).comments).toHaveLength(1);
		expect(await testEnv.BICKR_D1.prepare(`SELECT count(*) AS count FROM comments_index WHERE thread_id = ?`).bind(f.thread.id).first()).toEqual({ count: 1 });
	});
});
