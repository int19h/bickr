import type { AppEnv } from "./api/_auth";

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

export const onRequest: PagesFunction<AppEnv> = async (context) => {
	return securityHeadersResponse(await context.next());
};

export function securityHeadersResponse(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Strict-Transport-Security", strictTransportSecurity);
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

function isHtmlResponse(headers: Headers): boolean {
	return headers.get("content-type")?.toLowerCase().includes("text/html") ?? false;
}
