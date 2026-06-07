import { mcpScopes } from "@bickr/shared/mcp-auth";
import { type AppEnv } from "../api/_auth";

export const onRequestGet: PagesFunction<AppEnv> = async ({ request }) => {
	return Response.json(authorizationServerMetadata(request), {
		headers: {
			"cache-control": "no-store",
		},
	});
};

export function authorizationServerMetadata(request: Request): Record<string, unknown> {
	const origin = new URL(request.url).origin;
	return {
		issuer: origin,
		authorization_endpoint: `${origin}/oauth/authorize`,
		token_endpoint: `${origin}/oauth/token`,
		revocation_endpoint: `${origin}/oauth/revoke`,
		registration_endpoint: `${origin}/oauth/register`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
		scopes_supported: mcpScopes,
		resource_indicators_supported: true,
	};
}
