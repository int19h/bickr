import { readBoundedRequest, BodyReadTimeoutError, BodySizeLimitError } from "@bickr/shared/bounded-body";
import { McpOAuthError } from "@bickr/shared/mcp-auth";

export async function oauthRequestParams(request: Request): Promise<URLSearchParams> {
	const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	try {
		const bytes = await readBoundedRequest(request, { maxBytes: 16_384, timeoutMs: 10_000 });
		const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		if (type === "application/x-www-form-urlencoded") return new URLSearchParams(body);
		if (type === "application/json") {
			const record: unknown = JSON.parse(body);
			if (!record || typeof record !== "object" || Array.isArray(record)) throw new McpOAuthError("invalid_request", "The request must contain an object.");
			const result = new URLSearchParams();
			for (const [key, value] of Object.entries(record)) if (typeof value === "string") result.append(key, value);
			return result;
		}
		throw new McpOAuthError("invalid_request", "Use a URL-encoded form or JSON request.", 415);
	} catch (error) {
		if (error instanceof BodySizeLimitError) throw new McpOAuthError("invalid_request", "The request exceeds 16 KiB.", 413);
		if (error instanceof BodyReadTimeoutError) throw new McpOAuthError("invalid_request", "The request body took too long.", 408);
		if (error instanceof SyntaxError || error instanceof TypeError) throw new McpOAuthError("invalid_request", "The request body is malformed.");
		throw error;
	}
}
