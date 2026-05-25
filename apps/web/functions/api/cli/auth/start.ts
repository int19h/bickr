import { ok, readJsonBody } from "@bickr/shared/api";
import { createCliAuthRequest } from "@bickr/shared/repository";
import { type AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const input = await optionalJsonBody(request);
		const label = input && typeof input === "object" && !Array.isArray(input) ?
			(input as { label?: unknown }).label
		:	undefined;
		const started = await createCliAuthRequest(env.BICKR_KV, {
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
		return pageErrorResponse(error);
	}
};

async function optionalJsonBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type") ?? "";
	return contentType.includes("application/json") ? readJsonBody(request) : undefined;
}
