import { afterEach, describe, expect, it, vi } from "vitest";

import { api, apiResponseErrorMessage } from "./api";

function mockFetch(response: Response): void {
	vi.stubGlobal("fetch", vi.fn(async () => response));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("api", () => {
	it("returns wrapped API success payloads byte-for-byte", async () => {
		mockFetch(Response.json({ ok: true, data: { value: 42 } }));

		await expect(api<{ value: number }>("/api/test")).resolves.toEqual({
			ok: true,
			data: { value: 42 },
		});
	});

	it("wraps successful JSON responses that do not contain an ok field", async () => {
		mockFetch(Response.json({ value: 42 }));

		await expect(api<{ value: number }>("/api/test")).resolves.toEqual({
			ok: true,
			data: { value: 42 },
		});
	});

	it("returns wrapped API error payloads byte-for-byte", async () => {
		mockFetch(Response.json({ ok: false, error: "forbidden", message: "No access." }, { status: 403 }));

		await expect(api("/api/test")).resolves.toEqual({
			ok: false,
			error: "forbidden",
			message: "No access.",
		});
	});

	it("reports non-JSON success responses as response-format errors", async () => {
		mockFetch(new Response("not json", { status: 200, statusText: "OK" }));

		await expect(api("/api/test")).resolves.toEqual({
			ok: false,
			error: "server_error",
			message: "Response was not JSON.",
		});
	});

	it("reports non-JSON error responses with the response status text", async () => {
		mockFetch(new Response("not json", { status: 502, statusText: "Bad Gateway" }));

		await expect(api("/api/test")).resolves.toEqual({
			ok: false,
			error: "server_error",
			message: "Bad Gateway",
		});
	});

	it("reports fetch failures as network errors", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => {
			throw new Error("offline");
		}));

		await expect(api("/api/test")).resolves.toEqual({
			ok: false,
			error: "network_error",
			message: "Network request failed.",
		});
	});

	it("reports unreadable responses as network errors", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: false,
			statusText: "Bad Gateway",
			text: async () => {
				throw new Error("stream failed");
			},
		} as unknown as Response)));

		await expect(api("/api/test")).resolves.toEqual({
			ok: false,
			error: "network_error",
			message: "Network response could not be read.",
		});
	});
});

describe("apiResponseErrorMessage", () => {
	it("returns API message fields from JSON responses", async () => {
		await expect(apiResponseErrorMessage(Response.json({ message: "No access." }, { status: 403 }))).resolves.toBe("No access.");
	});

	it("returns the response-format error for non-JSON successful responses", async () => {
		await expect(apiResponseErrorMessage(new Response("not json", { status: 200, statusText: "OK" }))).resolves.toBe("Response was not JSON.");
	});

	it("falls back to status text when the response body cannot be read", async () => {
		const response = {
			ok: false,
			statusText: "Bad Gateway",
			text: async () => {
				throw new Error("stream failed");
			},
		} as unknown as Response;

		await expect(apiResponseErrorMessage(response)).resolves.toBe("Bad Gateway");
	});
});
