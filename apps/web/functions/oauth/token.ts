import { oauthRequestParams } from "./_request";
import {
	McpOAuthError,
	exchangeMcpAuthorizationCode,
	mcpScopeString,
	mcpScopes,
	refreshMcpTokenSet,
} from "@bickr/shared/mcp-auth";
import { type AppEnv } from "../api/_auth";
import { oauthErrorResponse } from "./_errors";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const form = await oauthRequestParams(request);
		const grantType = requiredParam(form, "grant_type");
		const clientId = requiredParam(form, "client_id");
		const resource = form.get("resource")?.trim() || new URL("/mcp", request.url).toString();
		const tokens =
			grantType === "authorization_code" ?
				await exchangeMcpAuthorizationCode(env.BICKR_D1, {
					code: requiredParam(form, "code"),
					clientId,
					redirectUri: requiredParam(form, "redirect_uri"),
					codeVerifier: requiredParam(form, "code_verifier"),
					resource,
				})
			: grantType === "refresh_token" ?
				await refreshMcpTokenSet(env.BICKR_D1, {
					refreshToken: requiredParam(form, "refresh_token"),
					clientId,
					resource,
				})
			: (() => {
					throw new McpOAuthError("unsupported_grant_type", "Unsupported MCP OAuth grant type.");
				})();
		return Response.json({
			access_token: tokens.accessToken,
			refresh_token: tokens.refreshToken,
			token_type: tokens.tokenType,
			expires_in: tokens.expiresIn,
			scope: tokens.scope,
		}, {
			headers: { "cache-control": "no-store" },
		});
	} catch (error) {
		return oauthErrorResponse(error);
	}
};

export const onRequestGet: PagesFunction<AppEnv> = async () => {
	return Response.json({
		error: "invalid_request",
		error_description: `Use POST with grant_type. Supported scopes: ${mcpScopeString(mcpScopes)}.`,
	}, {
		status: 405,
		headers: { "cache-control": "no-store", allow: "POST" },
	});
};

function requiredParam(params: URLSearchParams, name: string): string {
	const value = params.get(name)?.trim();
	if (!value) {
		throw new McpOAuthError("invalid_request", `${name} is required.`);
	}
	return value;
}
