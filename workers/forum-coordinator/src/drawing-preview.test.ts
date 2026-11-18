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

	it("screenshots the snapshot page of the origin and allows no other requests", async () => {
		const quickAction = vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }));
		const response = await renderDrawingPreview({ quickAction } as unknown as BrowserRun, { origin: "https://test.bickr.social", fragment: "abc" });
		expect(response.headers.get("content-type")).toBe("image/png");
		const [action, options] = quickAction.mock.calls[0] as unknown as [string, { url: string; viewport: unknown; allowRequestPattern: string[] }];
		expect(action).toBe("screenshot");
		expect(options.url).toBe("https://test.bickr.social/drawing-snapshot#abc");
		expect(options.viewport).toEqual({ width: 1200, height: 630 });
		expect(new RegExp(options.allowRequestPattern[0]!).test("https://test.bickr.social/diagram-assets/x.js")).toBe(true);
		expect(new RegExp(options.allowRequestPattern[0]!).test("https://testxbickr.social/x")).toBe(false);
		expect(new RegExp(options.allowRequestPattern[0]!).test("https://test.bickr.social.evil/x")).toBe(false);
	});

	it("reports a failed render and a missing binding", async () => {
		const quickAction = vi.fn(async () => new Response("no", { status: 422 }));
		await expect(renderDrawingPreview({ quickAction } as unknown as BrowserRun, { origin: "https://bickr.social", fragment: "a" })).rejects.toMatchObject({ status: 502 });
		await expect(renderDrawingPreview(undefined, { origin: "https://bickr.social", fragment: "a" })).rejects.toMatchObject({ status: 503 });
	});
});
