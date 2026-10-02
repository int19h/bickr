import { oauthRequestParams } from "./_request";
import { McpOAuthError, revokeMcpToken } from "@bickr/shared/mcp-auth";
import { type AppEnv } from "../api/_auth";
import { oauthErrorResponse } from "./_errors";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const form = await oauthRequestParams(request);
		const clientId = requiredParam(form, "client_id");
		const resource = form.get("resource")?.trim() || new URL("/mcp", request.url).toString();
		await revokeMcpToken(env.BICKR_D1, {
			token: requiredParam(form, "token"),
			clientId,
			resource,
		});
		return Response.json({}, {
			headers: { "cache-control": "no-store" },
		});
	} catch (error) {
		return oauthErrorResponse(error);
	}
};

export const onRequestGet: PagesFunction<AppEnv> = async () => {
	return Response.json({
		error: "invalid_request",
		error_description: "Use POST with token and client_id.",
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
