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
import {
	consentCspPolicy,
	contentSecurityPolicy,
	serializeCspPolicy,
} from "./_csp";
import {
	consentPagePolicySource,
	type PagesSecurityData,
} from "./oauth/_consent-csp";

export const strictTransportSecurity = "max-age=31536000; includeSubDomains";
export { contentSecurityPolicy } from "./_csp";

const stateChangingGetPaths = new Set([
	"/api/auth/github/start",
	"/api/auth/github/callback",
	"/api/auth/google/start",
	"/api/auth/google/callback",
]);
const delegatedMaintenancePaths = new Set(["/api/__test__/service-proxy"]);

export const onRequest: PagesFunction<AppEnv, string, PagesSecurityData> = async (context) => {
	const entryResponse = testEntryResponse(context.env, context.request);
	if (entryResponse) {
		return securityHeadersResponse(entryResponse, context.env, context.request);
	}
	const maintenanceResponse = await pagesMaintenanceResponse(context.request, context.env.BICKR_D1);
	if (maintenanceResponse) {
		return securityHeadersResponse(maintenanceResponse, context.env, context.request);
	}
	const response = await context.next();
	// The consent route is downstream, so the opaque request-scoped policy must
	// be read only after next() has returned.
	return securityHeadersResponse(response, context.env, context.request, context.data);
};

async function pagesMaintenanceResponse(request: Request, db: D1Database): Promise<Response | null> {
	const pathname = new URL(request.url).pathname;
	// MCP uses POST for both reads and writes, so its discriminated tool registry
	// enforces the gate after resolving the requested tool. Runtime stop remains
	// available because it only drains work already admitted before the freeze.
	// The authenticated test proxy gates its parsed inner request with the same
	// maintenance policy. Letting it reach that route keeps safe reads and
	// runtime stops available without opening a proxy-shaped mutation side door.
	if (pathname === "/mcp" || delegatedMaintenancePaths.has(pathname) || isRuntimeStopRequest(request)) {
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
	request?: Request,
	data: PagesSecurityData = {},
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
		const callbackSource = consentPagePolicySource(data);
		if (callbackSource && request) {
			headers.set(
				"Content-Security-Policy",
				serializeCspPolicy(consentCspPolicy(callbackSource, new URL(request.url).origin)),
			);
			console.info({
				event: "mcp_oauth_consent_csp_applied",
				callbackOrigin: callbackSource,
			});
		} else {
			headers.set("Content-Security-Policy", contentSecurityPolicy);
		}
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
