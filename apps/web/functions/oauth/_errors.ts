import { BodySizeLimitError, BodyReadTimeoutError } from "@bickr/shared/bounded-body";
import { AuthRequiredError, ProfileIncompleteError } from "../api/_auth";
import { RepositoryError } from "@bickr/shared/repository";
import { McpOAuthError } from "@bickr/shared/mcp-auth";
import { InputError } from "@bickr/shared/validation";

export function oauthErrorResponse(error: unknown): Response {
	if (error instanceof AuthRequiredError) return oauthErrorResponse(new McpOAuthError("login_required", error.message, 401));
	if (error instanceof ProfileIncompleteError) return oauthErrorResponse(new McpOAuthError("access_denied", error.message, 403));
	if (error instanceof RepositoryError) return oauthErrorResponse(new McpOAuthError("access_denied", error.message, error.status));
	if (error instanceof BodySizeLimitError) return oauthErrorResponse(new McpOAuthError("invalid_request", "The request exceeds 16 KiB.", 413));
	if (error instanceof BodyReadTimeoutError) return oauthErrorResponse(new McpOAuthError("invalid_request", "The request body took too long.", 408));
	if (error instanceof McpOAuthError) {
		return Response.json({ error: error.code, error_description: error.message }, {
			status: error.status,
			headers: { "cache-control": "no-store", ...(error.status === 429 ? { "retry-after": "3600" } : {}) },
		});
	}
	if (error instanceof SyntaxError) {
		return Response.json({ error: "invalid_request", error_description: "Request body must be JSON." }, {
			status: 400,
			headers: { "cache-control": "no-store" },
		});
	}
	if (error instanceof InputError) {
		return Response.json({ error: "invalid_request", error_description: error.message }, {
			status: 400,
			headers: { "cache-control": "no-store" },
		});
	}
	console.error("mcp oauth error", error);
	return Response.json({ error: "server_error", error_description: "Unexpected OAuth error." }, {
		status: 500,
		headers: { "cache-control": "no-store" },
	});
}
