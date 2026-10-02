import { consumeAuthRateLimit } from "@bickr/shared/auth-store";
import { readBoundedRequest } from "@bickr/shared/bounded-body";
import { oauthErrorResponse } from "../../../oauth/_errors";
import { McpOAuthError } from "@bickr/shared/mcp-auth";
import { ok } from "@bickr/shared/api";
import { createCliAuthRequest } from "@bickr/shared/repository";
import { type AppEnv } from "../../_auth";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		if (!await consumeAuthRateLimit(env.BICKR_D1, "cli_start", request.headers.get("cf-connecting-ip") ?? "unknown")) {
			throw new McpOAuthError("temporarily_unavailable", "CLI login limit reached. Try again in an hour.", 429);
		}
		const input = await optionalJsonBody(request);
		const label = input && typeof input === "object" && !Array.isArray(input) ?
			(input as { label?: unknown }).label
		:	undefined;
		const started = await createCliAuthRequest(env.BICKR_D1, {
			label: typeof label === "string" ? label : undefined,
		});
		const approveUrl = new URL("/api/cli/auth/approve", request.url);
		approveUrl.searchParams.set("code", started.deviceCode);
		return ok({
			deviceCode: started.deviceCode,
			approveUrl: approveUrl.toString(),
			expiresAt: started.request.expiresAt,
			pollIntervalSeconds: 2,
		});
	} catch (error) {
		return oauthErrorResponse(error);
	}
};

async function optionalJsonBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type") ?? "";
	return contentType.includes("application/json") ? JSON.parse(new TextDecoder().decode(await readBoundedRequest(request, { maxBytes: 16_384, timeoutMs: 10_000 }))) : undefined;
}
