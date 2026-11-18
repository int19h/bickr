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
	pageContext,
	seedWorld,
	testEnv,
} from "./helpers/index-harness";
import { onRequest as pageShell } from "../apps/web/functions/[[path]]";
import { onRequestGet as drawingRoute } from "../apps/web/functions/api/drawings/[commentId]/[file]";
import { drawingPreviewObjectPrefix } from "@bickr/shared/content-limits";
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

describe("drawing link previews", () => {
	it("uses the first drawing as the card image and hides drawing markup from the description", async () => {
		const { thread } = await setup();
		const page = await html(`/w/patch-notes/f/drawings/t/${thread.id}`);
		expect(meta(page, "og:image")).toBe(`https://example.com/api/drawings/${thread.rootCommentId}/0.png`);
		expect(meta(page, "og:image:width")).toBe("1200");
		expect(meta(page, "twitter:card")).toBe("summary_large_image");
		const description = meta(page, "og:description") ?? "";
		expect(description).toContain("[SVG drawing]");
		expect(description).not.toContain("<svg");
		expect(description).not.toContain("graph TD");
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

	it("renders a drawing once and serves the stored PNG afterwards", async () => {
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
		const get = () => drawingRoute(contextFor<typeof drawingRoute>(
			new Request(`https://example.com/api/drawings/${reply.id}/0.png`),
			{ commentId: reply.id, file: "0.png" },
			{ BICKR_R2: testEnv.BICKR_R2, FORUM_COORDINATOR_SERVICE: renderer },
		));
		const first = await get();
		expect(first.status).toBe(200);
		expect(first.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
		expect(renders).toHaveLength(1);
		const input = renders[0] as { origin: string; fragment: string };
		expect(input.origin).toBe("https://example.com");
		expect(decodeDrawingSnapshot(input.fragment)).toEqual({ language: "mermaid", source: "graph LR; C-->D" });
		const second = await get();
		expect(second.status).toBe(200);
		await second.arrayBuffer();
		expect(renders).toHaveLength(1);
		const listed = await testEnv.BICKR_R2.list({ prefix: drawingPreviewObjectPrefix });
		expect(listed.objects.length).toBeGreaterThan(0);
		for (const object of listed.objects) await testEnv.BICKR_R2.delete(object.key);
	});

	it("returns 404 for a missing drawing or a malformed path", async () => {
		const { thread } = await setup();
		const call = (commentId: string, file: string) => drawingRoute(contextFor<typeof drawingRoute>(
			new Request(`https://example.com/api/drawings/${commentId}/${file}`),
			{ commentId, file },
			{ BICKR_R2: testEnv.BICKR_R2 },
		));
		expect((await call(thread.rootCommentId, "9.png")).status).toBe(404);
		expect((await call(thread.rootCommentId, "0.svg")).status).toBe(404);
		expect((await call("nope", "0.png")).status).toBe(404);
	});
});
