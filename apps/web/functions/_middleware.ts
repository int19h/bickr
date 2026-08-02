import type { AppEnv } from "./api/_auth";
import {
	isRuntimeStopRequest,
	isSafeHttpMethod,
	maintenanceFailureResponse,
	MaintenanceControlUnavailableError,
	MaintenanceModeEnabledError,
	requireMaintenanceDisabled,
} from "@bickr/shared/maintenance";
import { testEntryResponse } from "./_test-entry";

export const strictTransportSecurity = "max-age=31536000; includeSubDomains";
export const contentSecurityPolicy = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	"font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net",
	"img-src 'self' data: blob: https:",
	"connect-src 'self' wss:",
	"worker-src 'self'",
	"manifest-src 'self'",
	"frame-ancestors 'none'",
	"base-uri 'self'",
	"form-action 'self'",
].join("; ");

const stateChangingGetPaths = new Set([
	"/api/auth/github/start",
	"/api/auth/github/callback",
	"/api/auth/google/start",
	"/api/auth/google/callback",
]);

export const onRequest: PagesFunction<AppEnv> = async (context) => {
	const entryResponse = testEntryResponse(context.env, context.request);
	if (entryResponse) {
		return securityHeadersResponse(entryResponse, context.env);
	}
	const maintenanceResponse = await pagesMaintenanceResponse(context.request, context.env.BICKR_D1);
	if (maintenanceResponse) {
		return securityHeadersResponse(maintenanceResponse, context.env);
	}
	return securityHeadersResponse(await context.next(), context.env);
};

async function pagesMaintenanceResponse(request: Request, db: D1Database): Promise<Response | null> {
	const pathname = new URL(request.url).pathname;
	// MCP uses POST for both reads and writes, so its discriminated tool registry
	// enforces the gate after resolving the requested tool. Runtime stop remains
	// available because it only drains work already admitted before the freeze.
	if (pathname === "/mcp" || isRuntimeStopRequest(request)) {
		return null;
	}
	if (isSafeHttpMethod(request.method) && !stateChangingGetPaths.has(pathname)) {
		return null;
	}
	try {
		await requireMaintenanceDisabled(db);
		return null;
	} catch (error) {
		if (!(error instanceof MaintenanceModeEnabledError) && !(error instanceof MaintenanceControlUnavailableError)) {
			throw error;
		}
		console.warn("Pages mutation blocked by maintenance control", {
			controlAvailable: !(error instanceof MaintenanceControlUnavailableError),
			method: request.method,
			pathname,
		});
		return maintenanceFailureResponse(error);
	}
}

export function securityHeadersResponse(
	response: Response,
	env?: Pick<AppEnv, "BICKR_ENVIRONMENT" | "TEST_ENTRY_MODE">,
): Response {
	// WebSocket upgrade responses (the bot loop monitor proxied through
	// /api/me/bots/:botId/runtime/monitor) must pass through untouched:
	// reconstructing a 101 response drops the webSocket and throws in workerd.
	if (response.status === 101 || response.webSocket) {
		return response;
	}
	const headers = new Headers(response.headers);
	headers.set("Strict-Transport-Security", strictTransportSecurity);
	if (env?.BICKR_ENVIRONMENT === "test") {
		headers.set("X-Robots-Tag", "noindex, nofollow");
	}
	if (env?.TEST_ENTRY_MODE === "migration") {
		headers.set("Cache-Control", "no-store");
		appendVary(headers, "Cookie");
	}
	if (isHtmlResponse(headers)) {
		headers.set("Content-Security-Policy", contentSecurityPolicy);
		headers.delete("Access-Control-Allow-Origin");
	}
	return new Response(response.body, {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
}

function appendVary(headers: Headers, field: string): void {
	const fields = headers.get("Vary")?.split(",").map((value) => value.trim().toLowerCase()) ?? [];
	if (!fields.includes(field.toLowerCase())) {
		headers.append("Vary", field);
	}
}

function isHtmlResponse(headers: Headers): boolean {
	return headers.get("content-type")?.toLowerCase().includes("text/html") ?? false;
}
