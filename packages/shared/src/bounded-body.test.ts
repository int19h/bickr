import { describe, expect, it, vi } from "vitest";
import { BodyReadTimeoutError, BodySizeLimitError, readBoundedBytes, readBoundedRequest, withBodyDeadline } from "./bounded-body";

describe("bounded body reads", () => {
	it("counts actual bytes without trusting the declared size", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(11)); }, cancel });
		await expect(readBoundedRequest(new Request("https://example.com", {
			method: "POST", body, headers: { "content-length": "1" },
		}), { maxBytes: 10 })).rejects.toBeInstanceOf(BodySizeLimitError);
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it("cancels a stalled read without waiting for cancellation to settle", async () => {
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const body = new ReadableStream<Uint8Array>({ cancel });
		await expect(readBoundedBytes(body, { maxBytes: 10, timeoutMs: 5 })).rejects.toBeInstanceOf(BodyReadTimeoutError);
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it("keeps a single deadline active after headers arrive", async () => {
		const cancel = vi.fn();
		await expect(withBodyDeadline(5, undefined, async (signal) => {
			const response = new Response(new ReadableStream({ cancel }));
			return readBoundedBytes(response.body, { maxBytes: 10, signal });
		})).rejects.toBeInstanceOf(BodyReadTimeoutError);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("preserves caller cancellation and returns an exact-limit body", async () => {
		const controller = new AbortController();
		const result = readBoundedBytes(new ReadableStream(), { maxBytes: 10, signal: controller.signal });
		const reason = new Error("Caller stopped");
		controller.abort(reason);
		await expect(result).rejects.toBe(reason);
		expect(await readBoundedBytes(new Response("0123456789").body, { maxBytes: 10 })).toHaveLength(10);
	});
});
