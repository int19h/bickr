import { McpOAuthError, revokeMcpToken } from "@bickr/shared/mcp-auth";
import { type AppEnv } from "../api/_auth";
import { oauthErrorResponse } from "./register";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const form = await tokenRequestBody(request);
		const clientId = requiredParam(form, "client_id");
		const resource = form.get("resource")?.trim() || new URL("/mcp", request.url).toString();
		await revokeMcpToken(env.BICKR_KV, {
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

async function tokenRequestBody(request: Request): Promise<URLSearchParams> {
	const contentType = request.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		const body = await request.json() as unknown;
		const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(record)) {
			if (typeof value === "string") {
				params.set(key, value);
			}
		}
		return params;
	}
	return new URLSearchParams(await request.text());
}

function requiredParam(params: URLSearchParams, name: string): string {
	const value = params.get(name)?.trim();
	if (!value) {
		throw new McpOAuthError("invalid_request", `${name} is required.`);
	}
	return value;
}
