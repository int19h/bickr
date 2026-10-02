import { afterEach, describe, expect, it, vi } from "vitest";
import { BodyReadTimeoutError, BodySizeLimitError } from "./bounded-body";
import { createOpenRouterImageCatalogLoader } from "./openrouter-image-models";
import type { fetchProviderResponse } from "./provider-transport";

afterEach(() => vi.useRealTimers());
const payload = { data: [{ id: "example/image", name: "Image", architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] }, supports_streaming: true }] };

describe("OpenRouter image model catalog", () => {
	it("fetches once for repeated capability lookups and expires after five minutes", async () => {
		let now = 0;
		const fetcher = vi.fn<typeof fetchProviderResponse>().mockImplementation(async () => Response.json(payload));
		const load = createOpenRouterImageCatalogLoader(fetcher, () => now);
		for (let i = 0; i < 1_000; i++) {
			expect((await load()).model("Example/Image:extended")?.supportsStreaming).toBe(true);
		}
		expect(fetcher).toHaveBeenCalledTimes(1);
		now = 300_000;
		await load();
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("limits a catalog body and retries after a failed read", async () => {
		const cancel = vi.fn();
		const fetcher = vi.fn<typeof fetchProviderResponse>()
			.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2_000_001)); }, cancel })))
			.mockResolvedValueOnce(Response.json(payload));
		const load = createOpenRouterImageCatalogLoader(fetcher);
		await expect(load()).rejects.toBeInstanceOf(BodySizeLimitError);
		expect(cancel).toHaveBeenCalledOnce();
		await expect(load()).resolves.toMatchObject({ models: [{ id: "example/image" }] });
	});

	it("bounds both headers and a stalled body", async () => {
		vi.useFakeTimers();
		for (const fetcher of [
			vi.fn<typeof fetchProviderResponse>(() => new Promise(() => {})),
			vi.fn<typeof fetchProviderResponse>().mockResolvedValue(new Response(new ReadableStream())),
		]) {
			const assertion = expect(createOpenRouterImageCatalogLoader(fetcher)()).rejects.toBeInstanceOf(BodyReadTimeoutError);
			await vi.advanceTimersByTimeAsync(10_001);
			await assertion;
		}
	});

	it("honors cancellation even when the catalog is cached", async () => {
		const load = createOpenRouterImageCatalogLoader(async () => Response.json(payload));
		await load();
		const controller = new AbortController();
		const reason = new Error("Stopped");
		controller.abort(reason);
		await expect(load(controller.signal)).rejects.toBe(reason);
	});
});
