import {
	clearCookieHeader,
	cookieHeader,
	cookieValue,
	type AppEnv,
} from "./api/_auth";

export const testEnvironmentCookieName = "bickr_test_environment";

const testEnvironmentCookieValue = "1";
const testEnvironmentCookieMaxAgeSeconds = 365 * 24 * 60 * 60;
const testEntryQueryParameter = "test";
const operationalPaths = new Set([
	"/api/health",
	"/api/maintenance",
	"/api/runtime/health",
	"/api/__test__/service-proxy",
]);

export function testEntryResponse(env: AppEnv, request: Request): Response | null {
	if (env.TEST_ENTRY_MODE !== "migration") {
		return null;
	}

	const requestUrl = new URL(request.url);
	if (operationalPaths.has(requestUrl.pathname)) {
		return null;
	}

	const productionOrigin = configuredProductionOrigin(env.BICKR_PRODUCTION_ORIGIN);
	if (!productionOrigin) {
		console.error("Test entry gateway is enabled without a valid production origin.");
		return gatewayJsonResponse({
			error: "test_entry_configuration_error",
			message: "The test environment entry gateway is unavailable.",
		}, 503);
	}

	if (isDocumentRequest(request, requestUrl)) {
		const requestedMode = requestUrl.searchParams.get(testEntryQueryParameter);
		if (requestedMode === "1") {
			return entryCookieRedirect(request, false);
		}
		if (requestedMode === "0") {
			return entryCookieRedirect(request, true);
		}
	}

	if (cookieValue(request, testEnvironmentCookieName) === testEnvironmentCookieValue) {
		return null;
	}

	const productionUrl = productionUrlForRequest(requestUrl, productionOrigin);
	if (isDocumentRequest(request, requestUrl)) {
		return migrationNoticeResponse(request, productionUrl, testEnvironmentModeUrl(requestUrl, "1"));
	}

	return gatewayJsonResponse({
		error: "test_environment_opt_in_required",
		message: "This test endpoint requires an explicit test-environment opt-in cookie.",
		optInUrl: testEnvironmentModeUrl(new URL("/", requestUrl), "1"),
		productionUrl,
	}, 403);
}

export function testEnvironmentExitUrl(request: Request): string {
	return testEnvironmentModeUrl(new URL(request.url), "0");
}

function configuredProductionOrigin(value: string | undefined): URL | null {
	if (!value) {
		return null;
	}
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		) {
			return null;
		}
		return url;
	} catch {
		return null;
	}
}

function isDocumentRequest(request: Request, url: URL): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return false;
	}
	if (isProtocolPath(url.pathname)) {
		return false;
	}

	const destination = request.headers.get("sec-fetch-dest")?.toLowerCase();
	if (destination) {
		return destination === "document" || destination === "iframe";
	}
	if (request.headers.get("accept")?.toLowerCase().includes("text/html")) {
		return true;
	}
	return !url.pathname.includes(".") || url.pathname.endsWith("/");
}

function isProtocolPath(pathname: string): boolean {
	return ["/api", "/mcp", "/oauth", "/.well-known"].some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

function entryCookieRedirect(request: Request, clear: boolean): Response {
	const cleanUrl = new URL(request.url);
	cleanUrl.searchParams.delete(testEntryQueryParameter);
	const headers = gatewayHeaders({ location: cleanUrl.toString() });
	headers.set(
		"set-cookie",
		clear ?
			clearCookieHeader(request, testEnvironmentCookieName)
		:	cookieHeader(request, testEnvironmentCookieName, testEnvironmentCookieValue, {
				httpOnly: true,
				maxAge: testEnvironmentCookieMaxAgeSeconds,
			}),
	);
	return new Response(null, { headers, status: 303 });
}

function migrationNoticeResponse(request: Request, productionUrl: string, optInUrl: string): Response {
	const body = request.method === "HEAD" ? null : migrationNoticeHtml(productionUrl, optInUrl);
	return new Response(body, {
		headers: gatewayHeaders({ "content-type": "text/html; charset=utf-8" }),
		status: 200,
	});
}

function migrationNoticeHtml(productionUrl: string, optInUrl: string): string {
	const safeProductionUrl = escapeHtml(productionUrl);
	const safeOptInUrl = escapeHtml(optInUrl);
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="robots" content="noindex,nofollow" />
		<meta http-equiv="refresh" content="5;url=${safeProductionUrl}" />
		<title>Bickr has moved</title>
		<style>
			:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
			body { align-items: center; background: #f7f4ee; color: #1a1814; display: flex; margin: 0; min-height: 100vh; }
			main { margin: auto; max-width: 42rem; padding: 2rem; }
			h1 { font-size: clamp(2rem, 7vw, 4rem); letter-spacing: -0.04em; margin: 0 0 1rem; }
			p { font-size: 1.1rem; line-height: 1.6; }
			.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.5rem; }
			a { border: 1px solid currentColor; border-radius: 0.4rem; color: inherit; padding: 0.7rem 1rem; text-decoration: none; }
			a.primary { background: #1a1814; color: #f7f4ee; }
			.note { color: #6b6557; font-size: 0.95rem; }
			@media (prefers-color-scheme: dark) {
				body { background: #16140f; color: #f7f4ee; }
				a.primary { background: #f7f4ee; color: #16140f; }
				.note { color: #b8b09c; }
			}
		</style>
	</head>
	<body>
		<main>
			<h1>Bickr has moved</h1>
			<p>The existing Bickr community is now at <strong>bickr.social</strong>. You will need to sign in there once because test and production do not share login cookies.</p>
			<p>You will be redirected in five seconds.</p>
			<div class="actions">
				<a class="primary" href="${safeProductionUrl}">Continue to bickr.social</a>
				<a href="${safeOptInUrl}">Enter the new test environment</a>
			</div>
			<p class="note">The test environment is separate and may be reset without notice.</p>
		</main>
	</body>
</html>`;
}

function productionUrlForRequest(requestUrl: URL, productionOrigin: URL): string {
	const target = new URL(productionOrigin);
	// Assign path and query separately: constructing a URL from a pathname that
	// begins with // would interpret it as a new authority and create an open
	// redirect away from the configured production origin.
	target.pathname = requestUrl.pathname;
	target.search = requestUrl.search;
	target.searchParams.delete(testEntryQueryParameter);
	return target.toString();
}

function testEnvironmentModeUrl(requestUrl: URL, mode: "0" | "1"): string {
	const target = new URL(requestUrl);
	target.searchParams.set(testEntryQueryParameter, mode);
	return target.toString();
}

function gatewayJsonResponse(
	payload: { error: string; message: string; optInUrl?: string; productionUrl?: string },
	status: number,
): Response {
	return Response.json({ ok: false, ...payload }, {
		headers: gatewayHeaders(),
		status,
	});
}

function gatewayHeaders(initial?: HeadersInit): Headers {
	const headers = new Headers(initial);
	headers.set("cache-control", "no-store");
	headers.set("vary", "Cookie");
	return headers;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
