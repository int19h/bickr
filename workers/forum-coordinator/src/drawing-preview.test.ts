import { describe, expect, it, vi } from "vitest";
import { parseDrawingPreviewInput, renderDrawingPreview } from "./drawing-preview";

describe("drawing preview rendering", () => {
	it("accepts only an https origin and a base64url fragment", () => {
		expect(parseDrawingPreviewInput({ origin: "https://bickr.social", fragment: "eyJh_-", authorBotId: "bot_1" })).toEqual({ origin: "https://bickr.social", fragment: "eyJh_-", authorBotId: "bot_1" });
		for (const input of [
			{ origin: "http://bickr.social", fragment: "a", authorBotId: "b" },
			{ origin: "https://bickr.social/path", fragment: "a" },
			{ origin: "javascript:alert(1)", fragment: "a" },
			{ origin: "https://bickr.social", fragment: "a#b" },
			{ origin: "https://bickr.social", fragment: "" },
			{ origin: "https://bickr.social", fragment: "a".repeat(200_001) },
			{ origin: "https://bickr.social" },
			{ origin: "https://bickr.social", fragment: "a" },
			{ origin: "https://bickr.social", fragment: "a", authorBotId: "a/b" },
			null,
		]) expect(() => parseDrawingPreviewInput(input)).toThrow();
	});

	const limiter = (success = true) => ({ limit: vi.fn(async () => ({ success })) }) as unknown as RateLimit;
	const png = () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } });

	it("screenshots the snapshot page of the origin, waits for a drawn page, and allows no other requests", async () => {
		const quickAction = vi.fn(async () => png());
		const response = await renderDrawingPreview({ BROWSER: { quickAction } as unknown as BrowserRun, DRAWING_PREVIEW_LIMITER: limiter(), DRAWING_PREVIEW_AUTHOR_LIMITER: limiter() }, { origin: "https://test.bickr.social", fragment: "abc", authorBotId: "bot_1" });
		expect(response.headers.get("content-type")).toBe("image/png");
		const [action, options] = quickAction.mock.calls[0] as unknown as [string, { url: string; viewport: unknown; allowRequestPattern: string[]; waitForSelector: { selector: string } }];
		expect(action).toBe("screenshot");
		expect(options.url).toBe("https://test.bickr.social/drawing-snapshot#abc");
		expect(options.viewport).toEqual({ width: 1200, height: 630 });
		// "error" must not satisfy the wait, or a failed drawing becomes a blank card.
		expect(options.waitForSelector.selector).toBe('html[data-snapshot="ready"]');
		const pattern = new RegExp(options.allowRequestPattern[0]!);
		expect(pattern.test("https://test.bickr.social/diagram-assets/x.js")).toBe(true);
		expect(pattern.test("https://testxbickr.social/x")).toBe(false);
		expect(pattern.test("https://test.bickr.social.evil/x")).toBe(false);
	});

	it("names each failure kind and treats service failures as errors", async () => {
		const input = { origin: "https://bickr.social", fragment: "a", authorBotId: "bot_1" };
		const env = (quickAction: () => Promise<Response>, shared = limiter(), author = limiter()) => ({ BROWSER: { quickAction } as unknown as BrowserRun, DRAWING_PREVIEW_LIMITER: shared, DRAWING_PREVIEW_AUTHOR_LIMITER: author });
		const outcome = async (response: Response) => (await response.json()) as { kind: string };
		const failed = await renderDrawingPreview(env(async () => new Response("no", { status: 422 })), input);
		expect(failed.status).toBe(422);
		expect(await outcome(failed)).toEqual({ kind: "not_rendered" });
		expect(await outcome(await renderDrawingPreview(env(async () => new Response("busy", { status: 429 })), input))).toEqual({ kind: "rate_limited" });
		for (const status of [400, 403, 500]) {
			await expect(renderDrawingPreview(env(async () => new Response("down", { status })), input)).rejects.toMatchObject({ status: 502 });
		}
		await expect(renderDrawingPreview(env(async () => Response.json({ error: "x" })), input)).rejects.toMatchObject({ status: 502 });
		const quickAction = vi.fn(async () => png());
		const shared = limiter();
		const byAuthor = await renderDrawingPreview(env(quickAction, shared, limiter(false)), input);
		expect(byAuthor.status).toBe(429);
		// The author limit runs first, so a busy author spends none of the shared budget.
		expect((shared as unknown as { limit: ReturnType<typeof vi.fn> }).limit).not.toHaveBeenCalled();
		expect((await renderDrawingPreview(env(quickAction, limiter(false)), input)).status).toBe(429);
		expect(quickAction).not.toHaveBeenCalled();
		await expect(renderDrawingPreview({}, input)).rejects.toMatchObject({ status: 503 });
	});
});
