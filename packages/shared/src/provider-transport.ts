export type ProviderTransportErrorKind = "invalid_url" | "insecure_url" | "embedded_credentials" | "redirect" | "connection";

export class ProviderTransportError extends Error {
	readonly kind: ProviderTransportErrorKind;
	constructor(kind: ProviderTransportErrorKind, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ProviderTransportError";
		this.kind = kind;
	}
}

/** Local inference servers are the only supported cleartext endpoints. */
export function providerUrl(value: string | URL): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ProviderTransportError("invalid_url", "Provider URL must be a valid URL.");
	}
	if (url.username || url.password) {
		throw new ProviderTransportError("embedded_credentials", "Provider URL must not contain credentials.");
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new ProviderTransportError("insecure_url", "Provider URL must use HTTPS, except for a local loopback server.");
	}
	return url;
}

function connectionFailure(error: unknown, signal?: AbortSignal | null): unknown {
	// Abort reasons and existing typed causes belong to the caller.
	if (signal?.aborted || error instanceof ProviderTransportError ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) return error;
	return new ProviderTransportError("connection", error instanceof Error ? error.message : String(error), { cause: error });
}

function providerResponseBody(body: ReadableStream<Uint8Array>, signal?: AbortSignal | null): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch (error) {
				reader.releaseLock();
				controller.error(connectionFailure(error, signal));
				return;
			}
			if (chunk.done) {
				reader.releaseLock();
				controller.close();
			} else controller.enqueue(chunk.value);
		},
		async cancel(reason) {
			try { await reader.cancel(reason); }
			finally { reader.releaseLock(); }
		},
	}, { highWaterMark: 0 });
}

export async function fetchProviderResponse(input: string | URL, init?: RequestInit): Promise<Response> {
	// Workers forward Authorization on cross-origin redirects. Refuse redirects
	// rather than let an endpoint send a provider credential to another origin.
	const url = providerUrl(input);
	let response: Response;
	try {
		response = await fetch(url.href, { ...init, redirect: "manual" });
	} catch (error) {
		throw connectionFailure(error, init?.signal);
	}
	if (response.status >= 300 && response.status < 400) {
		void response.body?.cancel().catch(() => {});
		throw new ProviderTransportError("redirect", "Provider endpoint redirected the request. Configure its final HTTPS URL.");
	}
	// Headers can arrive before the connection fails. Type failures at the source
	// so text, JSON, and streaming consumers receive the same cause.
	return response.body ? new Response(providerResponseBody(response.body, init?.signal), response) : response;
}
