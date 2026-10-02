import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProviderResponse, providerUrl, ProviderTransportError } from "./provider-transport";

afterEach(() => vi.unstubAllGlobals());

describe("provider transport policy", () => {
	it.each(["http://provider.example/v1", "http://localhost.example/v1", "file:///provider", "https://name:secret@example.com/v1"])("rejects %s", (url) => {
		expect(() => providerUrl(url)).toThrow(ProviderTransportError);
	});
	it.each(["https://provider.example/v1", "http://localhost:8080/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8080/v1"])("accepts %s", (url) => {
		expect(providerUrl(url).href).toBe(url);
	});
	it("always refuses redirects for credential-bearing requests", async () => {
		const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			// Workerd accepts only manual/follow. Constructing a native Request
			// keeps mocks from hiding an unsupported redirect mode.
			new Request(input, init);
			return new Response("{}");
		});
		vi.stubGlobal("fetch", fetcher);
		await fetchProviderResponse("https://provider.example/v1", { headers: { authorization: "Bearer test" }, redirect: "follow" });
		expect(fetcher).toHaveBeenCalledWith("https://provider.example/v1", expect.objectContaining({ redirect: "manual" }));
	});
	it("rejects redirects before credentials can leave the configured endpoint", async () => {
		const cancel = vi.fn();
		const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), {
			status: 302, headers: { location: "https://other.example/v1" },
		}));
		vi.stubGlobal("fetch", fetcher);
		await expect(fetchProviderResponse("https://provider.example/v1", { headers: { authorization: "Bearer test" } })).rejects.toMatchObject({ kind: "redirect" });
		expect(fetcher).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
	});
});
