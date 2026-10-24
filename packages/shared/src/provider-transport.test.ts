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

it('gives a failed connection a typed cause and retains its diagnostic', async () => {
	const diagnostic = new TypeError('Network diagnostic.');
	vi.stubGlobal('fetch', vi.fn().mockRejectedValue(diagnostic));
	await expect(fetchProviderResponse('https://provider.example/v1')).rejects.toMatchObject({ kind: 'connection', message: diagnostic.message, cause: diagnostic });
});

it('preserves cancellation instead of treating it as a connection failure', async () => {
	const error = new DOMException('Cancelled.', 'AbortError');
	vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
	await expect(fetchProviderResponse('https://provider.example/v1')).rejects.toBe(error);
});

it.each(['text', 'json', 'arrayBuffer'] as const)('types a body connection failure through Response.%s', async method => {
	const diagnostic = new TypeError('Body connection failed.');
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
		pull(controller) { controller.error(diagnostic); },
	}))));
	const response = await fetchProviderResponse('https://provider.example/v1');
	await expect(response[method]()).rejects.toMatchObject({ kind: 'connection', cause: diagnostic });
});

it.each(['AbortError', 'TimeoutError', 'aborted signal'] as const)('preserves a body failure with %s', async kind => {
	const controller = new AbortController();
	const error = kind === 'aborted signal' ? new TypeError('Stopped.') : new DOMException('Stopped.', kind);
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
		pull(body) {
			if (kind === 'aborted signal') controller.abort(error);
			body.error(error);
		},
	}))));
	const response = await fetchProviderResponse('https://provider.example/v1', { signal: controller.signal });
	await expect(response.text()).rejects.toBe(error);
});

it('forwards body bytes and cancellation without reading ahead', async () => {
	const cancel = vi.fn();
	const pull = vi.fn(controller => { controller.enqueue(new TextEncoder().encode('part')); });
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
		status: 201, statusText: 'Created', headers: { 'x-request-id': 'request' },
	})));
	const response = await fetchProviderResponse('https://provider.example/v1');
	expect(pull).not.toHaveBeenCalled();
	expect(response.status).toBe(201);
	expect(response.statusText).toBe('Created');
	expect(response.headers.get('x-request-id')).toBe('request');
	const reader = response.body!.getReader();
	expect(new TextDecoder().decode((await reader.read()).value)).toBe('part');
	expect(pull).toHaveBeenCalledOnce();
	await reader.cancel('Stopped.');
	expect(cancel).toHaveBeenCalledWith('Stopped.');
});
