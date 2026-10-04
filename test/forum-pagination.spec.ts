import { describe, expect, it } from "vitest";
import { authCookie, contextFor, createBotForTest, createForumForTest, createThreadForTest, jsonRequest, seedWorld, testEnv } from "./helpers/index-harness";
import { onRequestGet as listPage } from "../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]/threads";
import { listThreadsWithReadState, recordThreadRead } from "@bickr/shared/social";
import type { ThreadSummary } from "@bickr/shared/model";
import type { ForumThreadPagination } from "@bickr/shared/social";

async function fixture() {
	const cookie = await authCookie();
	await seedWorld(cookie);
	const forum = await createForumForTest(cookie, "pages");
	const bot = await createBotForTest(cookie, "reader");
	const threads = [];
	for (let i = 0; i < 5; i++) threads.push(await createThreadForTest(forum.id, bot.id, `Page ${i}`, "A thread."));
	const now = new Date().toISOString();
	await testEnv.BICKR_D1.prepare("UPDATE threads_index SET created_at = ?, last_activity_at = ? WHERE forum_id = ?").bind(now, now, forum.id).run();
	const page = (query: string) => listPage(contextFor<typeof listPage>(
		jsonRequest(`http://example.com/api/worlds/patch-notes/forums/pages/threads?${query}`, "GET", undefined, cookie),
		{ worldHandle: "patch-notes", forumHandle: "pages" },
	));
	return { cookie, forum, bot, threads, page };
}

describe("forum thread pagination", () => {
	it("walks tied rows, counts hot pages, clamps the last page, and preserves unread threads", async () => {
		const f = await fixture();
		const ids: string[] = [];
		for (let page = 1; page <= 3; page++) {
			const response = await f.page(`sort=recent&limit=2&page=${page}`);
			expect(response.status).toBe(200);
			const data = (await response.json() as { data: { threads: ThreadSummary[]; pagination: ForumThreadPagination } }).data;
			expect(data.pagination).toMatchObject({ currentPage: page, total: 5, pageCount: 3, pageSize: 2, hasMore: page < 3 });
			expect(data.threads.every((thread) => thread.readState?.isNew)).toBe(true);
			ids.push(...data.threads.map((thread) => thread.id));
		}
		expect(ids).toEqual([...f.threads.map((thread) => thread.id)].sort());
		expect(await testEnv.BICKR_D1.prepare("SELECT COUNT(*) AS count FROM user_forum_reads").first()).toMatchObject({ count: 0 });
		await recordThreadRead(testEnv.BICKR_D1, f.forum.createdByUserId, ids[0]!);
		const read = await listThreadsWithReadState(testEnv.BICKR_D1, f.forum.id, f.forum.createdByUserId, "recent", 5);
		expect(read.find((thread) => thread.id === ids[0])?.readState?.isNew).toBe(false);
		expect(read.filter((thread) => thread.id !== ids[0]).every((thread) => thread.readState?.isNew)).toBe(true);
		const last = await f.page("sort=hot&limit=2&page=999");
		expect((await last.json() as {data: {pagination: ForumThreadPagination}}).data.pagination).toMatchObject({ currentPage: 3, pageCount: 3, total: 5 });
		await testEnv.BICKR_D1.prepare("UPDATE threads_index SET last_activity_at = '2000-01-01T00:00:00.000Z' WHERE forum_id = ?").bind(f.forum.id).run();
		const empty = await f.page("sort=hot&page=99");
		expect((await empty.json() as {data: {pagination: ForumThreadPagination; threads: ThreadSummary[]}}).data).toMatchObject({ threads: [], pagination: {total: 0, pageCount: 1, currentPage: 1} });
	});

	it("rejects invalid or conflicting numbered pages", async () => {
		const f = await fixture();
		for (const query of ["page=0", "page=-1", "page=1.5", "page=9007199254740992", "page=2&offset=0"]) {
			expect((await f.page(query)).status).toBe(400);
		}
		for (const query of ["offset=Infinity", "offset=1.5", "offset=1e100"]) expect((await f.page(query)).status).toBe(200);
	});
});
