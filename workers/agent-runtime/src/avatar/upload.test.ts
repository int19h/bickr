import { afterEach, describe, expect, it, vi } from "vitest";
import { InputError } from "@bickr/shared/validation";
import { avatarUploadBytes, avatarUploadMaxBytes, avatarUrlJsonMaxBytes } from "./upload";

const file = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], "avatar.jpg", { type: "image/jpeg" });
const request = (form: FormData) => new Request("https://example.com/upload", { method: "POST", body: form });

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("avatar multipart upload", () => {
	it("rejects a large ignored field before parsing form data", async () => {
		const form = new FormData();
		form.set("file", file());
		form.set("ignored", "x".repeat(avatarUploadMaxBytes));
		await expect(avatarUploadBytes(request(form))).rejects.toThrow("Avatar upload is too large");
	});

	it("rejects duplicate files and unexpected fields", async () => {
		for (const extra of ["file", "ignored"]) {
			const form = new FormData();
			form.append("file", file());
			form.append(extra, file());
			await expect(avatarUploadBytes(request(form))).rejects.toThrow("exactly one file field");
		}
	});

	it("accepts a single valid image", async () => {
		const form = new FormData();
		form.set("file", file());
		await expect(avatarUploadBytes(request(form))).resolves.toMatchObject({ kind: "file", contentType: "image/jpeg", originalFilename: "avatar.jpg" });
	});
});

describe("avatar URL JSON input", () => {
	const jsonRequest = (body: string | ReadableStream<Uint8Array>, signal?: AbortSignal) => new Request("https://example.com/upload", {
		method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body, signal,
	});

	it("rejects an oversized chunked envelope before fetching its URL", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ url: "https://example.com/avatar.jpg", ignored: "x".repeat(avatarUrlJsonMaxBytes) }))); },
			cancel,
		});
		await expect(avatarUploadBytes(jsonRequest(body))).rejects.toMatchObject({ name: "InputError", message: "Avatar URL request must be 16 KiB or smaller." });
		expect(cancel).toHaveBeenCalledOnce();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("cancels a stalled envelope after its read deadline", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const result = avatarUploadBytes(jsonRequest(new ReadableStream({ cancel })));
		const rejected = expect(result).rejects.toMatchObject({ name: "InputError", message: "Avatar URL request timed out." });
		await vi.advanceTimersByTimeAsync(10_000);
		await rejected;
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("preserves request cancellation", async () => {
		const controller = new AbortController();
		const reason = new Error("Client disconnected");
		const cancel = vi.fn();
		const result = avatarUploadBytes(jsonRequest(new ReadableStream({ cancel }), controller.signal));
		const rejected = expect(result).rejects.toBe(reason);
		controller.abort(reason);
		await rejected;
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("returns an input error for malformed JSON", async () => {
		await expect(avatarUploadBytes(jsonRequest("{"))).rejects.toBeInstanceOf(InputError);
	});

	it("accepts a valid URL envelope at the byte limit", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } }));
		vi.stubGlobal("fetch", fetcher);
		const json = JSON.stringify({ url: "https://example.com/avatar.jpg" });
		await expect(avatarUploadBytes(jsonRequest(json.padEnd(avatarUrlJsonMaxBytes)))).resolves.toMatchObject({ kind: "url", sourceUrl: "https://example.com/avatar.jpg", contentType: "image/jpeg" });
		expect(fetcher).toHaveBeenCalledOnce();
	});
});
