import { oauthErrorResponse } from "./_errors";
import { readBoundedRequest } from "@bickr/shared/bounded-body";
import { consumeAuthRateLimit } from "@bickr/shared/auth-store";
import { McpOAuthError, registerMcpClient, mcpScopeString, mcpScopes } from "@bickr/shared/mcp-auth";
import { type AppEnv } from "../api/_auth";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		if (!await consumeAuthRateLimit(env.BICKR_D1, "register", request.headers.get("cf-connecting-ip") ?? "unknown")) {
			console.warn({ event: "mcp_oauth_registration_rate_limited" });
			throw new McpOAuthError("temporarily_unavailable", "Client registration limit reached. Try again in an hour.", 429);
		}
		const input: unknown = JSON.parse(new TextDecoder().decode(await readBoundedRequest(request, { maxBytes: 16_384, timeoutMs: 10_000 })));
		const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
		const redirectUris = Array.isArray(record.redirect_uris) ? record.redirect_uris.filter(isString) : [];
		const client = await registerMcpClient(env.BICKR_D1, {
			clientName: typeof record.client_name === "string" ? record.client_name : undefined,
			redirectUris,
			tokenEndpointAuthMethod: typeof record.token_endpoint_auth_method === "string" ? record.token_endpoint_auth_method : undefined,
		});
		console.info({ event: "mcp_oauth_client_registered", clientId: client.id, expiresAt: client.expiresAt });
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
