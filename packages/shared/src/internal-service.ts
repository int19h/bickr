export const internalServiceHost = "internal.bickr";

const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function internalServiceUrl(path: string): string {
	return `https://${internalServiceHost}${path}`;
}

export function isLoopbackHostname(hostname: string): boolean {
	return loopbackHostnames.has(hostname.toLowerCase());
}

export function isTrustedInternalServiceRequest(request: Request): boolean {
	const hostname = new URL(request.url).hostname.toLowerCase();
	return hostname === internalServiceHost || isLoopbackHostname(hostname);
}
