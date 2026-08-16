import { afterEach, describe, expect, it } from "vitest";
import { ApiError, BickrClient } from "./client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function client(): BickrClient {
	return new BickrClient({ host: "https://example.test", token: "tok" });
}

function neverAnswers(): void {
	globalThis.fetch = ((_url: string, init: RequestInit) =>
		new Promise((_resolve, reject) => {
			init.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
		})) as unknown as typeof fetch;
}

/**
 * A request that produced no response failed for one of three reasons, and the
 * caller acts on each differently. The code has to say which; the sentence is
 * for the owner reading it.
 */
describe("CLI client request failures", () => {
	it("reports a request that outlived its deadline as a timeout", async () => {
		neverAnswers();
		const error = await client().request("/session", { timeoutMs: 10 }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).code).toBe("timeout");
		expect((error as ApiError).message).toContain("0s");
	});

	it("holds the deadline over the body, not only the headers", async () => {
		globalThis.fetch = ((_url: string, init: RequestInit) =>
			Promise.resolve(new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"ok":true,'));
						init.signal?.addEventListener("abort", () => controller.error(new Error("This operation was aborted")));
					},
				}),
				{ headers: { "content-type": "application/json" } },
			))) as unknown as typeof fetch;
		const error = await client().request("/session", { timeoutMs: 20 }).catch((caught: unknown) => caught) as ApiError;
		expect(error.code).toBe("timeout");
	});

	it("reports a request the caller cancelled as aborted, not as a timeout", async () => {
		neverAnswers();
		const controller = new AbortController();
		const pending = client().request("/session", { signal: controller.signal, timeoutMs: 60_000 })
			.catch((caught: unknown) => caught);
		controller.abort();
		expect(((await pending) as ApiError).code).toBe("aborted");
	});

	it("reports a refused connection as a network failure", async () => {
		globalThis.fetch = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;
		const error = await client().request("/session").catch((caught: unknown) => caught) as ApiError;
		expect(error.code).toBe("network_error");
		expect(error.message).toContain("ECONNREFUSED");
	});

	it("reports a corrupt body from a successful exchange as a bad response, not a network failure", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(new Response('{"ok":true,"data"', { headers: { "content-type": "application/json" } }))
		) as unknown as typeof fetch;
		const error = await client().request("/session").catch((caught: unknown) => caught) as ApiError;
		expect(error.code).toBe("bad_response");
		expect(error.status).toBe(200);
	});

	it("passes a typed API failure through as an envelope rather than a client failure", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(Response.json({ ok: false, error: "conflict", message: "Reference is ambiguous." }, { status: 409 }))
		) as unknown as typeof fetch;
		const envelope = await client().request("/cli/resolve/bots", { method: "POST", body: { targets: ["u/x"] } });
		expect(envelope).toMatchObject({ ok: false, error: "conflict" });
	});
});
