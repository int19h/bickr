import {
	authCookie,
	contextFor,
	createBotForTest,
	createCommentForTest,
	createForumForTest,
	createThreadForTest,
	describe,
	expect,
	forums,
	handleForumCoordinatorRequest,
	it,
	jsonRequest,
	kvKeys,
	listForums,
	patchBot,
	patchForum,
	requiredLt,
	seedWorld,
	setVote,
	testEnv,
	toolDefinitions,
} from "./helpers/index-harness";
import type { TestForum } from "./helpers/index-harness";
import { normalizeKvDocuments } from "@bickr/shared/kv-normalization-sweep";
import { repairObjectIndexes } from "@bickr/shared/index-repair";
import { createThread } from "@bickr/shared/social";
import type { ApiErrorPayload, ForumDocument, ForumSummary } from "@bickr/shared/model";
import type { D1DatabaseLike, D1PreparedStatementLike } from "@bickr/shared/storage";

type ForumPayload = { data: { forum: ForumSummary } };

async function patchForumForTest(
	cookie: string,
	forumHandle: string,
	body: Record<string, unknown>,
	worldHandle = "patch-notes",
): Promise<ForumSummary> {
	const response = await patchForum(
		contextFor<typeof patchForum>(
			jsonRequest(
				`http://example.com/api/worlds/${worldHandle}/forums/${forumHandle}`,
				"PATCH",
				body,
				cookie,
			),
			{ worldHandle, forumHandle },
		),
	);
	expect(response.status, await response.clone().text()).toBe(200);
	return ((await response.json()) as ForumPayload).data.forum;
}

async function storedReadOnly(forumId: string): Promise<number | undefined> {
	const row = await testEnv.BICKR_D1
		.prepare(`SELECT read_only AS readOnly FROM forums_index WHERE forum_id = ?`)
		.bind(forumId)
		.first<{ readOnly: number }>();
	return row?.readOnly;
}

async function storedForumDocument(forumId: string): Promise<ForumDocument | null> {
	return testEnv.BICKR_KV.get<ForumDocument>(kvKeys.forum(forumId), { type: "json" });
}

async function contentCounts(forumId: string): Promise<Record<string, number>> {
	const row = await testEnv.BICKR_D1
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM content_ids) AS contentIds,
				(SELECT COUNT(*) FROM threads_index WHERE forum_id = ?) AS threads,
				(SELECT COUNT(*) FROM comments_index WHERE forum_id = ?) AS comments,
				(SELECT COUNT(*) FROM objects_index WHERE object_type = 'thread') AS threadObjects`,
		)
		.bind(forumId, forumId)
		.first<Record<string, number>>();
	if (!row) {
		throw new Error("Content counts are unavailable.");
	}
	return row;
}

async function threadKvKeyCount(): Promise<number> {
	const listed = await testEnv.BICKR_KV.list({ prefix: "thread:" });
	return listed.keys.length;
}

async function createThreadResponse(forumId: string, botId: string, title: string): Promise<Response> {
	const request = jsonRequest(`http://example.com/forums/${forumId}/threads`, "POST", {
		title: requiredLt(title),
		body: requiredLt(`${title} body.`),
	});
	request.headers.set("x-bickr-bot-id", botId);
	return handleForumCoordinatorRequest(request, {
		BICKR_D1: testEnv.BICKR_D1,
		BICKR_KV: testEnv.BICKR_KV,
	});
}

async function createCommentResponse(threadId: string, botId: string, body: string): Promise<Response> {
	const request = jsonRequest(`http://example.com/threads/${threadId}/comments`, "POST", {
		body: requiredLt(body),
	});
	request.headers.set("x-bickr-bot-id", botId);
	return handleForumCoordinatorRequest(request, {
		BICKR_D1: testEnv.BICKR_D1,
		BICKR_KV: testEnv.BICKR_KV,
	});
}

async function forumsPayload(worldHandle = "patch-notes"): Promise<ForumSummary[]> {
	const response = await forums(
		contextFor<typeof forums>(
			new Request(`http://example.com/api/worlds/${worldHandle}/forums`),
			{ worldHandle },
		),
	);
	const payload = (await response.json()) as { data: { forums: ForumSummary[] } };
	return payload.data.forums;
}

async function seedForumWithContent(handle: string): Promise<{
	cookie: string;
	forum: TestForum;
	botId: string;
	threadId: string;
}> {
	const cookie = await authCookie();
	await seedWorld(cookie);
	const forum = await createForumForTest(cookie, handle);
	const bot = await createBotForTest(cookie, `${handle}-author`);
	const thread = await createThreadForTest(forum.id, bot.id, "Existing thread", "Existing body.");
	await createCommentForTest(thread.id, bot.id, "Existing comment.");
	return { cookie, forum, botId: bot.id, threadId: thread.id };
}

describe("read-only forums", () => {
	it("defaults to writable and round-trips both states through D1, KV, and every listing", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "round-trip");

		expect(await storedReadOnly(forum.id)).toBe(0);
		expect((await storedForumDocument(forum.id))?.readOnly).toBe(false);
		expect((await listForums(testEnv.BICKR_D1, "patch-notes")).find((item) => item.id === forum.id)?.readOnly)
			.toBe(false);

		const closed = await patchForumForTest(cookie, "round-trip", { readOnly: true });
		expect(closed.readOnly).toBe(true);
		expect(await storedReadOnly(forum.id)).toBe(1);
		expect((await storedForumDocument(forum.id))?.readOnly).toBe(true);
		expect((await listForums(testEnv.BICKR_D1, "patch-notes")).find((item) => item.id === forum.id)?.readOnly)
			.toBe(true);
		expect((await forumsPayload()).find((item) => item.id === forum.id)?.readOnly).toBe(true);

		const reopened = await patchForumForTest(cookie, "round-trip", { readOnly: false });
		expect(reopened.readOnly).toBe(false);
		expect(await storedReadOnly(forum.id)).toBe(0);
		expect((await storedForumDocument(forum.id))?.readOnly).toBe(false);
		expect((await forumsPayload()).find((item) => item.id === forum.id)?.readOnly).toBe(false);
	});

	it("preserves read-only through description-only, rename, and personal-forum rename projections", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "preserved");
		await patchForumForTest(cookie, "preserved", { readOnly: true });

		const described = await patchForumForTest(cookie, "preserved", {
			language: "en",
			description: { lang: "en", text: "Still closed." },
		});
		expect(described.readOnly).toBe(true);
		expect(await storedReadOnly(forum.id)).toBe(1);

		const renamed = await patchForumForTest(cookie, "preserved", { handle: "preserved-archive" });
		expect(renamed.readOnly).toBe(true);
		expect(await storedReadOnly(forum.id)).toBe(1);

		// A participant rename rewrites its personal forum's handle and description
		// through a targeted UPDATE; that statement must not clear read_only.
		const bot = await createBotForTest(cookie, "renamed-author");
		const personal = await testEnv.BICKR_D1
			.prepare(`SELECT forum_id AS id FROM forums_index WHERE personal_bot_id = ?`)
			.bind(bot.id)
			.first<{ id: string }>();
		if (!personal) {
			throw new Error("Personal forum was not created.");
		}
		const personalHandle = await testEnv.BICKR_D1
			.prepare(`SELECT handle FROM forums_index WHERE forum_id = ?`)
			.bind(personal.id)
			.first<{ handle: string }>();
		await patchForumForTest(cookie, personalHandle?.handle ?? "", { readOnly: true });
		const patchedBot = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${bot.id}`,
					"PATCH",
					{ handle: "renamed-author-2" },
					cookie,
				),
				{ botId: bot.id },
			),
		);
		expect(patchedBot.status, await patchedBot.clone().text()).toBe(200);
		expect(await storedReadOnly(personal.id)).toBe(1);
	});

	it("rejects new threads with a typed conflict and writes nothing", async () => {
		const { cookie, forum, botId } = await seedForumWithContent("closed-threads");
		await patchForumForTest(cookie, "closed-threads", { readOnly: true });
		const before = await contentCounts(forum.id);
		const beforeThreadKeys = await threadKvKeyCount();

		const response = await createThreadResponse(forum.id, botId, "Blocked thread");
		const payload = (await response.json()) as ApiErrorPayload;

		expect(response.status).toBe(409);
		expect(payload.error).toBe("conflict");
		expect(payload.details?.forumWriteCause).toBe("forum_read_only");
		expect(await contentCounts(forum.id)).toEqual(before);
		expect(await threadKvKeyCount()).toBe(beforeThreadKeys);
	});

	it("rejects replies with a typed conflict and writes nothing", async () => {
		const { cookie, forum, botId, threadId } = await seedForumWithContent("closed-replies");
		await patchForumForTest(cookie, "closed-replies", { readOnly: true });
		const before = await contentCounts(forum.id);
		const beforeThread = await testEnv.BICKR_KV.get(kvKeys.thread(threadId));

		const response = await createCommentResponse(threadId, botId, "Blocked reply.");
		const payload = (await response.json()) as ApiErrorPayload;

		expect(response.status).toBe(409);
		expect(payload.error).toBe("conflict");
		expect(payload.details?.forumWriteCause).toBe("forum_read_only");
		expect(await contentCounts(forum.id)).toEqual(before);
		expect(await testEnv.BICKR_KV.get(kvKeys.thread(threadId))).toBe(beforeThread);
	});

	it("keeps voting available and restores creation when read-only is turned off", async () => {
		const { cookie, forum, botId, threadId } = await seedForumWithContent("reopened");
		const voter = await createBotForTest(cookie, "reopened-voter");
		const thread = await testEnv.BICKR_KV.get<{ rootCommentId: string }>(kvKeys.thread(threadId), { type: "json" });
		if (!thread) {
			throw new Error("Seeded thread document is missing.");
		}
		await patchForumForTest(cookie, "reopened", { readOnly: true });

		const voted = await setVote(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			botId: voter.id,
			targetType: "comment",
			targetId: thread.rootCommentId,
			value: 1,
		});
		expect(voted.voteScore).toBe(1);

		await patchForumForTest(cookie, "reopened", { readOnly: false });
		const created = await createThreadResponse(forum.id, botId, "Reopened thread");
		expect(created.status, await created.clone().text()).toBe(201);
		const reply = await createCommentResponse(threadId, botId, "Reopened reply.");
		expect(reply.status, await reply.clone().text()).toBe(201);
	});

	it("fails closed when the read-only projection cannot be read", async () => {
		const { forum, botId } = await seedForumWithContent("d1-failure");
		const before = await contentCounts(forum.id);
		const failingDb: D1DatabaseLike = {
			prepare: (query: string): D1PreparedStatementLike => {
				if (query.includes("read_only AS readOnly")) {
					throw new Error("D1_ERROR: network failure");
				}
				return testEnv.BICKR_D1.prepare(query);
			},
			batch: (statements) => testEnv.BICKR_D1.batch(statements as never) as never,
		};

		await expect(createThread(testEnv.BICKR_KV, failingDb, {
			forumId: forum.id,
			authorBotId: botId,
			title: requiredLt("Unreadable state"),
			body: requiredLt("Unreadable state body."),
		})).rejects.toThrow("D1_ERROR: network failure");
		expect(await contentCounts(forum.id)).toEqual(before);
	});

	it("normalizes legacy forum documents to writable and persists the field through the sweep", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "legacy-shape");
		const stored = await storedForumDocument(forum.id);
		if (!stored) {
			throw new Error("Forum document is missing.");
		}
		const { readOnly: _omitted, ...legacy } = stored;
		await testEnv.BICKR_KV.put(kvKeys.forum(forum.id), JSON.stringify({
			...legacy,
			updatedAt: "2020-01-01T00:00:00.000Z",
		}));

		// Reads treat the missing key as writable rather than repairing storage.
		expect((await listForums(testEnv.BICKR_D1, "patch-notes")).find((item) => item.id === forum.id)?.readOnly)
			.toBe(false);

		const sweep = await normalizeKvDocuments(testEnv, "forum");

		expect(sweep).toMatchObject({ rewritten: 1, done: true });
		const swept = await storedForumDocument(forum.id);
		expect(swept).toHaveProperty("readOnly", false);
		expect(await normalizeKvDocuments(testEnv, "forum")).toMatchObject({ rewritten: 0, done: true });
	});

	it("converges a drifted read-only projection back to its KV document", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "converge");
		await patchForumForTest(cookie, "converge", { readOnly: true });
		await testEnv.BICKR_D1.prepare(`UPDATE forums_index SET read_only = 0 WHERE forum_id = ?`)
			.bind(forum.id)
			.run();
		await testEnv.BICKR_D1.prepare(`UPDATE objects_index SET revision = 0 WHERE object_id = ?`)
			.bind(forum.id)
			.run();

		const result = await repairObjectIndexes({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});

		expect(result.repaired).toBeGreaterThanOrEqual(1);
		expect(await storedReadOnly(forum.id)).toBe(1);
	});

	it("tells the participant which forums accept new threads", () => {
		const listTool = toolDefinitions.find((tool) => tool.function.name === "list_accessible_forums");
		const description = listTool?.function.description ?? "";

		expect(description).toContain("readOnly");
		expect(description).toContain("votes");
		expect(description).not.toMatch(/\b(bot|agent|AI|assistant)\b/i);
	});
});
