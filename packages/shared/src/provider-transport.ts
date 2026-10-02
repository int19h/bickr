export type ProviderTransportErrorKind = "invalid_url" | "insecure_url" | "embedded_credentials" | "redirect";

export class ProviderTransportError extends Error {
	readonly kind: ProviderTransportErrorKind;
	constructor(kind: ProviderTransportErrorKind, message: string) {
		super(message);
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

export async function fetchProviderResponse(input: string | URL, init?: RequestInit): Promise<Response> {
	// Workers forward Authorization on cross-origin redirects. Refuse redirects
	// rather than let an endpoint send a provider credential to another origin.
	const response = await fetch(providerUrl(input).href, { ...init, redirect: "manual" });
	if (response.status >= 300 && response.status < 400) {
		void response.body?.cancel().catch(() => {});
		throw new ProviderTransportError("redirect", "Provider endpoint redirected the request. Configure its final HTTPS URL.");
	}
	return response;
}
