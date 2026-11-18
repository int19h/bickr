import { describe, expect, it, vi } from "vitest";
import { parseDrawingPreviewInput, renderDrawingPreview } from "./drawing-preview";

describe("drawing preview rendering", () => {
	it("accepts only an https origin and a base64url fragment", () => {
		expect(parseDrawingPreviewInput({ origin: "https://bickr.social", fragment: "eyJh_-" })).toEqual({ origin: "https://bickr.social", fragment: "eyJh_-" });
		for (const input of [
			{ origin: "http://bickr.social", fragment: "a" },
			{ origin: "https://bickr.social/path", fragment: "a" },
			{ origin: "javascript:alert(1)", fragment: "a" },
			{ origin: "https://bickr.social", fragment: "a#b" },
			{ origin: "https://bickr.social", fragment: "" },
			{ origin: "https://bickr.social", fragment: "a".repeat(200_001) },
			{ origin: "https://bickr.social" },
			null,
		]) expect(() => parseDrawingPreviewInput(input)).toThrow();
	});

	const limiter = (success = true) => ({ limit: vi.fn(async () => ({ success })) }) as unknown as RateLimit;
	const png = () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } });

	it("screenshots the snapshot page of the origin, waits for a drawn page, and allows no other requests", async () => {
		const quickAction = vi.fn(async () => png());
		const response = await renderDrawingPreview({ BROWSER: { quickAction } as unknown as BrowserRun, DRAWING_PREVIEW_LIMITER: limiter() }, { origin: "https://test.bickr.social", fragment: "abc" });
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

	it("names each failure kind", async () => {
		const input = { origin: "https://bickr.social", fragment: "a" };
		const outcome = async (response: Response) => (await response.json()) as { kind: string };
		const failed = await renderDrawingPreview({ BROWSER: { quickAction: async () => new Response("no", { status: 422 }) } as unknown as BrowserRun, DRAWING_PREVIEW_LIMITER: limiter() }, input);
		expect(failed.status).toBe(422);
		expect(await outcome(failed)).toEqual({ kind: "not_rendered" });
		const busy = await renderDrawingPreview({ BROWSER: { quickAction: async () => new Response("busy", { status: 429 }) } as unknown as BrowserRun, DRAWING_PREVIEW_LIMITER: limiter() }, input);
		expect(await outcome(busy)).toEqual({ kind: "rate_limited" });
		const quickAction = vi.fn(async () => png());
		const limited = await renderDrawingPreview({ BROWSER: { quickAction } as unknown as BrowserRun, DRAWING_PREVIEW_LIMITER: limiter(false) }, input);
		expect(limited.status).toBe(429);
		expect(quickAction).not.toHaveBeenCalled();
		const unconfigured = await renderDrawingPreview({}, input);
		expect(await outcome(unconfigured)).toEqual({ kind: "rate_limited" });
	});
});
