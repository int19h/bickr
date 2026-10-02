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
		const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
		vi.stubGlobal("fetch", fetcher);
		await fetchProviderResponse("https://provider.example/v1", { headers: { authorization: "Bearer test" }, redirect: "follow" });
		expect(fetcher).toHaveBeenCalledWith(new URL("https://provider.example/v1"), expect.objectContaining({ redirect: "error" }));
	});
});
