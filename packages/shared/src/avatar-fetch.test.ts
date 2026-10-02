import { afterEach, describe, expect, it, vi } from "vitest";
import { avatarMaxBytes, fetchRemoteAvatarBytes } from "./avatar-storage";

afterEach(() => vi.useRealTimers());

describe("remote avatar fetch", () => {
	it("times out a stalled body after receiving successful headers", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
		const assertion = expect(fetchRemoteAvatarBytes("https://images.example/avatar", fetcher)).rejects.toThrow("Avatar URL fetch timed out.");
		await vi.advanceTimersByTimeAsync(15_001);
		await assertion;
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("bounds chunked bodies and cancels oversized streams", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(avatarMaxBytes + 1)); }, cancel });
		await expect(fetchRemoteAvatarBytes("https://images.example/avatar", vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))).rejects.toThrow("10 MB");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("follows HTTPS redirects and rejects a cleartext redirect", async () => {
		const fetcher = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/next" } }))
			.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } }));
		await expect(fetchRemoteAvatarBytes("https://images.example/avatar", fetcher)).resolves.toMatchObject({ contentType: "image/jpeg" });
		expect(fetcher).toHaveBeenNthCalledWith(2, "https://images.example/next", expect.objectContaining({ redirect: "manual" }));
		fetcher.mockReset().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://images.example/next" } }));
		await expect(fetchRemoteAvatarBytes("https://images.example/avatar", fetcher)).rejects.toThrow("must use HTTPS");
		expect(fetcher).toHaveBeenCalledOnce();
	});
});
