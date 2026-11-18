import {
	authCookie,
	authCookieFor,
	contextFor,
	createBotForTest,
	createCommentForTest,
	createForumForTest,
	createThreadForTest,
	describe,
	expect,
	it,
	jsonRequest,
	kvKeys,
	patchCommentRoute,
	patchForum,
	seedWorld,
	setVote,
	testEnv,
} from "./helpers/index-harness";
import type { ThreadDocument } from "@bickr/shared/model";

const worldHandle = "patch-notes";

async function setup() {
	const worldOwnerCookie = await authCookie();
	const botOwnerCookie = await authCookieFor({ subject: "222", login: "edit-owner", displayName: "Edit Owner" });
	await seedWorld(worldOwnerCookie);
	const forum = await createForumForTest(worldOwnerCookie, "edits");
	const author = await createBotForTest(botOwnerCookie, "edit-author");
	await createBotForTest(worldOwnerCookie, "edit-mentioned");
	const thread = await createThreadForTest(forum.id, author.id, "Edit me", "The original post.");
	const comment = await createCommentForTest(thread.id, author.id, "The original reply.");
	return { worldOwnerCookie, botOwnerCookie, forum, author, thread, comment };
}

async function storedThread(threadId: string): Promise<ThreadDocument> {
	const thread = await testEnv.BICKR_KV.get<ThreadDocument>(kvKeys.thread(threadId), { type: "json" });
	if (!thread) throw new Error("Thread is missing.");
	return thread;
}

async function edit(cookie: string, threadId: string, commentId: string, body: unknown): Promise<Response> {
	return patchCommentRoute(
		contextFor<typeof patchCommentRoute>(
			jsonRequest(`http://example.com/api/worlds/${worldHandle}/forums/edits/threads/${threadId}/comments/${commentId}`, "PATCH", body, cookie),
			{ worldHandle, forumHandle: "edits", threadId, commentId },
		),
	);
}

async function storedBody(threadId: string, commentId: string): Promise<string> {
	return (await storedThread(threadId)).comments.find((item) => item.id === commentId)!.body.text;
}

describe("owner comment edits", () => {
	it("lets the owner of the author replace the body and updates every projection", async () => {
		const { botOwnerCookie, thread, comment } = await setup();
		const before = await storedThread(thread.id);
		const expectedBody = await storedBody(thread.id, comment.id);
		const response = await edit(botOwnerCookie, thread.id, comment.id, { body: "An **edited** reply for @edit-mentioned.", expectedBody });
		expect(response.status).toBe(200);
		const payload = await response.json<{ data: { thread: ThreadDocument } }>();
		const returned = payload.data.thread.comments.find((item) => item.id === comment.id)!;
		// Mentions are canonicalized as at creation, and the language tag stays.
		expect(returned.body.text).toBe("An **edited** reply for u/edit-mentioned.");
		expect(returned.body.lang).toBe(before.comments.find((item) => item.id === comment.id)!.body.lang);
		expect(returned.editedAt).toBeTruthy();
		const stored = await storedThread(thread.id);
		expect(stored.revision).toBe(before.revision + 1);
		// An edit is not new activity.
		expect(stored.lastActivityAt).toBe(before.lastActivityAt);
		const index = await testEnv.BICKR_D1.prepare(`SELECT body_preview AS preview FROM comments_index WHERE comment_id = ?`).bind(comment.id).first<{ preview: string }>();
		expect(index?.preview).toContain("edited");
		const notifications = await testEnv.BICKR_D1.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE source_object_id LIKE ?`).bind(`%${comment.id.slice(-8)}%`).first<{ count: number }>();
		expect(notifications?.count).toBe(0);
	});

	it("updates the thread preview when the post is edited", async () => {
		const { botOwnerCookie, thread } = await setup();
		const response = await edit(botOwnerCookie, thread.id, thread.rootCommentId, { body: "A rewritten post.", expectedBody: await storedBody(thread.id, thread.rootCommentId) });
		expect(response.status).toBe(200);
		const row = await testEnv.BICKR_D1.prepare(`SELECT body_preview AS preview FROM threads_index WHERE thread_id = ?`).bind(thread.id).first<{ preview: string }>();
		expect(row?.preview).toBe("A rewritten post.");
	});

	it("refuses forum moderators and other users", async () => {
		const { worldOwnerCookie, thread, comment } = await setup();
		const outsiderCookie = await authCookieFor({ subject: "333", login: "outsider", displayName: "Out Sider" });
		const expectedBody = await storedBody(thread.id, comment.id);
		for (const cookie of [worldOwnerCookie, outsiderCookie]) {
			const response = await edit(cookie, thread.id, comment.id, { body: "Not yours.", expectedBody });
			expect(response.status).toBe(403);
		}
		expect((await storedThread(thread.id)).comments.find((item) => item.id === comment.id)!.body.text).toBe("The original reply.");
	});

	it("accepts an edit after a vote changed the comment but not its text", async () => {
		const { botOwnerCookie, worldOwnerCookie, thread, comment } = await setup();
		const expectedBody = await storedBody(thread.id, comment.id);
		const before = (await storedThread(thread.id)).comments.find((item) => item.id === comment.id)!.updatedAt;
		const voter = await createBotForTest(worldOwnerCookie, "edit-voter");
		await new Promise((resolve) => setTimeout(resolve, 5));
		await setVote(testEnv.BICKR_KV, testEnv.BICKR_D1, { botId: voter.id, targetType: "comment", targetId: comment.id, value: 1 });
		expect((await storedThread(thread.id)).comments.find((item) => item.id === comment.id)!.updatedAt).not.toBe(before);
		expect((await edit(botOwnerCookie, thread.id, comment.id, { body: "Edited after a vote.", expectedBody })).status).toBe(200);
	});

	it("rejects a stale edit with a conflict", async () => {
		const { botOwnerCookie, thread, comment } = await setup();
		const expectedBody = await storedBody(thread.id, comment.id);
		expect((await edit(botOwnerCookie, thread.id, comment.id, { body: "First edit.", expectedBody })).status).toBe(200);
		const stale = await edit(botOwnerCookie, thread.id, comment.id, { body: "Second edit.", expectedBody });
		expect(stale.status).toBe(409);
		expect((await storedThread(thread.id)).comments.find((item) => item.id === comment.id)!.body.text).toBe("First edit.");
	});

	it("applies the posting limit of the comment and rejects an empty body", async () => {
		const { botOwnerCookie, thread, comment } = await setup();
		const expectedBody = await storedBody(thread.id, comment.id);
		expect((await edit(botOwnerCookie, thread.id, comment.id, { body: "x".repeat(20_000), expectedBody })).status).toBe(400);
		expect((await edit(botOwnerCookie, thread.id, comment.id, { body: "   ", expectedBody })).status).toBe(400);
	});

	it("rejects an edit in a read-only forum", async () => {
		const { worldOwnerCookie, botOwnerCookie, thread, comment } = await setup();
		const closed = await patchForum(
			contextFor<typeof patchForum>(
				jsonRequest(`http://example.com/api/worlds/${worldHandle}/forums/edits`, "PATCH", { readOnly: true }, worldOwnerCookie),
				{ worldHandle, forumHandle: "edits" },
			),
		);
		expect(closed.status).toBe(200);
		const response = await edit(botOwnerCookie, thread.id, comment.id, { body: "Too late.", expectedBody: await storedBody(thread.id, comment.id) });
		expect(response.status).toBe(409);
	});
});
