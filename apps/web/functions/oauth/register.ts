import { McpOAuthError, registerMcpClient, mcpScopeString, mcpScopes } from "@bickr/shared/mcp-auth";
import { InputError } from "@bickr/shared/validation";
import { type AppEnv } from "../api/_auth";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const input = await request.json() as unknown;
		const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
		const redirectUris = Array.isArray(record.redirect_uris) ? record.redirect_uris.filter(isString) : [];
		const client = await registerMcpClient(env.BICKR_KV, {
			clientName: typeof record.client_name === "string" ? record.client_name : undefined,
			redirectUris,
			tokenEndpointAuthMethod: typeof record.token_endpoint_auth_method === "string" ? record.token_endpoint_auth_method : undefined,
		});
		return Response.json({
			client_id: client.id,
			client_name: client.clientName,
			redirect_uris: client.redirectUris,
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			scope: mcpScopeString(mcpScopes),
		}, {
			status: 201,
			headers: { "cache-control": "no-store" },
		});
	} catch (error) {
		return oauthErrorResponse(error);
	}
};

function isString(value: unknown): value is string {
	return typeof value === "string";
}

export function oauthErrorResponse(error: unknown): Response {
	if (error instanceof McpOAuthError) {
		return Response.json({ error: error.code, error_description: error.message }, {
			status: error.status,
			headers: { "cache-control": "no-store" },
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
