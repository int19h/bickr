import { mcpScopeString, mcpScopes } from "@bickr/shared/mcp-auth";
import { type AppEnv } from "../api/_auth";

export const onRequestGet: PagesFunction<AppEnv> = async ({ request }) => {
	return protectedResourceMetadataResponse(request);
};

export function protectedResourceMetadataResponse(request: Request): Response {
	const origin = new URL(request.url).origin;
	return Response.json({
		resource: `${origin}/mcp`,
		authorization_servers: [origin],
		scopes_supported: mcpScopes,
		bearer_methods_supported: ["header"],
		resource_documentation: origin,
	}, {
		headers: {
			"cache-control": "no-store",
		},
	});
}

export function mcpAuthenticateHeader(request: Request): string {
	const origin = new URL(request.url).origin;
	const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
	return `Bearer resource_metadata="${metadataUrl}", scope="${mcpScopeString(mcpScopes)}"`;
}
