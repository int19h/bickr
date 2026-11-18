import {
	authCookie,
	contextFor,
	createBotForTest,
	createCommentForTest,
	createForumForTest,
	createThreadForTest,
	describe,
	expect,
	it,
	kvKeys,
	pageContext,
	seedWorld,
	testEnv,
} from "./helpers/index-harness";
import { onRequest as pageShell } from "../apps/web/functions/[[path]]";
import { onRequestGet as drawingRoute } from "../apps/web/functions/api/drawings/[commentId]/[file]";
import { decodeDrawingSnapshot } from "../apps/web/src/markdown/drawing-snapshot-protocol";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>';
const post = `Intro text.\n\n\`\`\`svg\n${svg}\n\`\`\`\n\n![photo](https://images.example/photo.png)\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\``;

async function setup(body = post) {
	const cookie = await authCookie();
	await seedWorld(cookie);
	const forum = await createForumForTest(cookie, "drawings");
	const bot = await createBotForTest(cookie, "drawer");
	const thread = await createThreadForTest(forum.id, bot.id, "Pictures", body);
	return { bot, thread };
}

async function html(path: string): Promise<string> {
	const response = await pageShell(pageContext(new Request(`https://example.com${path}`)) as Parameters<typeof pageShell>[0]);
	return response.text();
}

function meta(page: string, key: string): string | undefined {
	return new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(page)?.[1]?.replaceAll("&amp;", "&");
}

const waits: Promise<unknown>[] = [];
async function flushWaits(): Promise<void> {
	await Promise.all(waits.splice(0));
}

async function get(commentId: string, index: number, renderer?: Fetcher): Promise<Response> {
	const context = contextFor<typeof drawingRoute>(
		new Request(`https://example.com/api/drawings/${commentId}/${index}.png`),
		{ commentId, file: `${index}.png` },
		{ BICKR_PUBLIC_ORIGIN: "https://public.example", ...(renderer ? { FORUM_COORDINATOR_SERVICE: renderer } : {}) },
	);
	return await drawingRoute({ ...context, waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } } as typeof context);
}

describe("drawing link previews", () => {
	it("uses the first drawing as the card image and hides drawing markup from the description", async () => {
		const { thread } = await setup();
		const page = await html(`/w/patch-notes/f/drawings/t/${thread.id}`);
		expect(meta(page, "og:image")).toBe(`https://example.com/api/drawings/${thread.rootCommentId}/0.png`);
		expect(meta(page, "og:image:width")).toBeUndefined();
		expect(meta(page, "twitter:card")).toBe("summary_large_image");
		const description = meta(page, "og:description") ?? "";
		expect(description).toContain("[SVG drawing]");
		expect(description).not.toContain("<svg");
		expect(description).not.toContain("graph TD");
	});

	it("uses a leading https image when it comes first, and skips plain http images", async () => {
		const plain = await setup("![photo](http://images.example/photo.png)\n\n```mermaid\ngraph TD; A-->B\n```");
		const plainPage = await html(`/w/patch-notes/f/drawings/t/${plain.thread.id}`);
		expect(meta(plainPage, "og:image")).toBe(`https://example.com/api/drawings/${plain.thread.rootCommentId}/0.png`);
	});

	it("uses a leading web image when it comes first", async () => {
		const { thread } = await setup("![photo](https://images.example/photo.png)\n\n```mermaid\ngraph TD; A-->B\n```");
		const page = await html(`/w/patch-notes/f/drawings/t/${thread.id}`);
		expect(meta(page, "og:image")).toBe("https://images.example/photo.png");
		expect(meta(page, "og:image:width")).toBeUndefined();
	});

	it("previews exactly the drawing of a viewer link", async () => {
		const { thread } = await setup();
		const page = await html(`/w/patch-notes/f/drawings/t/${thread.id}?drawing=${thread.rootCommentId}.1`);
		expect(meta(page, "og:image")).toBe(`https://example.com/api/drawings/${thread.rootCommentId}/1.png`);
		expect(meta(page, "og:url")).toBe(`https://example.com/w/patch-notes/f/drawings/t/${thread.id}?drawing=${thread.rootCommentId}.1`);
		expect(meta(page, "og:title")).toContain("Mermaid diagram");
		const missing = await html(`/w/patch-notes/f/drawings/t/${thread.id}?drawing=${thread.rootCommentId}.5`);
		expect(meta(missing, "og:title")).toContain("not found");
	});

	it("renders a drawing once and serves the cached PNG afterwards", async () => {
		const { thread, bot } = await setup();
		const reply = await createCommentForTest(thread.id, bot.id, "```mermaid\ngraph LR; C-->D\n```");
		const renders: unknown[] = [];
		const renderer = {
			fetch: async (request: Request) => {
				expect(new URL(request.url).pathname).toBe("/drawing-previews/render");
				renders.push(await request.json());
				return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
			},
		} as unknown as Fetcher;
		const first = await get(reply.id, 0, renderer);
		expect(first.status).toBe(200);
		expect(first.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
		expect(renders).toHaveLength(1);
		const input = renders[0] as { origin: string; fragment: string };
		// The configured public origin, not the origin of the request.
		expect(input.origin).toBe("https://public.example");
		expect(decodeDrawingSnapshot(input.fragment)).toEqual({ language: "mermaid", source: "graph LR; C-->D" });
		expect((input as { authorBotId?: string }).authorBotId).toBe(bot.id);
		await flushWaits();
		const second = await get(reply.id, 0, renderer);
		expect(second.status).toBe(200);
		expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
		expect(renders).toHaveLength(1);
	});

	it("reads the coordinator when the KV thread document does not have the comment yet", async () => {
		const { thread, bot } = await setup();
		const stale = await testEnv.BICKR_KV.get(kvKeys.thread(thread.id));
		const reply = await createCommentForTest(thread.id, bot.id, "```mermaid\ngraph LR; K-->L\n```");
		const fresh = await testEnv.BICKR_KV.get(kvKeys.thread(thread.id), { type: "json" });
		// An edge cache still serves the document from before the reply.
		await testEnv.BICKR_KV.put(kvKeys.thread(thread.id), stale!);
		const paths: string[] = [];
		const coordinator = {
			fetch: async (request: Request) => {
				const path = new URL(request.url).pathname;
				paths.push(path);
				if (path === `/threads/${thread.id}`) return Response.json({ ok: true, data: { thread: fresh } });
				return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
			},
		} as unknown as Fetcher;
		const response = await get(reply.id, 0, coordinator);
		expect(response.status).toBe(200);
		expect(paths).toEqual([`/threads/${thread.id}`, "/drawing-previews/render"]);
	});

	it("falls back to the author's avatar for a drawing that does not draw, and remembers the failure", async () => {
		const { thread, bot } = await setup();
		const reply = await createCommentForTest(thread.id, bot.id, "```mermaid\nnot a diagram at all\n```");
		await testEnv.BICKR_D1.prepare(`UPDATE bots_index SET avatar_url = ? WHERE bot_id = ?`).bind("https://assets.example/avatar.png", bot.id).run();
		let renders = 0;
		const renderer = { fetch: async () => { renders += 1; return Response.json({ kind: "not_rendered" }, { status: 422 }); } } as unknown as Fetcher;
		const first = await get(reply.id, 0, renderer);
		expect(first.status).toBe(302);
		expect(first.headers.get("location")).toBe("https://assets.example/avatar.png");
		await flushWaits();
		expect((await get(reply.id, 0, renderer)).status).toBe(302);
		expect(renders).toBe(1);
	});

	it("asks the crawler to retry when the render budget is spent, and caches nothing", async () => {
		const { thread, bot } = await setup();
		const reply = await createCommentForTest(thread.id, bot.id, "```mermaid\ngraph LR; E-->F\n```");
		let renders = 0;
		const renderer = { fetch: async () => { renders += 1; return Response.json({ kind: "rate_limited" }, { status: 429 }); } } as unknown as Fetcher;
		const first = await get(reply.id, 0, renderer);
		expect(first.status).toBe(503);
		expect(first.headers.get("retry-after")).toBe("60");
		await flushWaits();
		await get(reply.id, 0, renderer);
		expect(renders).toBe(2);
	});

	it("answers 502 and caches nothing when the renderer service fails", async () => {
		const { thread, bot } = await setup();
		const reply = await createCommentForTest(thread.id, bot.id, "```mermaid\ngraph LR; G-->H\n```");
		let renders = 0;
		const renderer = { fetch: async () => { renders += 1; return Response.json({ ok: false, error: "server_error", message: "Browser Run failed." }, { status: 502 }); } } as unknown as Fetcher;
		expect((await get(reply.id, 0, renderer)).status).toBe(502);
		await flushWaits();
		await get(reply.id, 0, renderer);
		expect(renders).toBe(2);
	});

	it("returns 404 for a missing drawing or a malformed path", async () => {
		const { thread } = await setup();
		expect((await get(thread.rootCommentId, 9)).status).toBe(404);
		const malformed = await drawingRoute(contextFor<typeof drawingRoute>(
			new Request(`https://example.com/api/drawings/${thread.rootCommentId}/0.svg`),
			{ commentId: thread.rootCommentId, file: "0.svg" },
		));
		expect(malformed.status).toBe(404);
		expect((await get("nope", 0)).status).toBe(404);
	});
});
