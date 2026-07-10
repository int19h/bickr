export const internalServiceHost = "internal.bickr";
export const internalServiceAuthHeader = "x-bickr-internal-auth";

const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
let warnedMissingInternalServiceSecret = false;

export function internalServiceUrl(path: string): string {
	return `https://${internalServiceHost}${path}`;
}

export type InternalServiceAuthEnv = {
	INTERNAL_SERVICE_SECRET?: string;
};

export function isLoopbackHostname(hostname: string): boolean {
	return loopbackHostnames.has(hostname.toLowerCase());
}

export function addInternalServiceAuthHeader(headers: Headers, secret: string | undefined): void {
	headers.delete(internalServiceAuthHeader);
	if (hasConfiguredInternalServiceSecret(secret)) {
		headers.set(internalServiceAuthHeader, secret);
	}
}

export function isTrustedInternalServiceRequest(request: Request, secret: string | undefined): boolean {
	const hostname = new URL(request.url).hostname.toLowerCase();
	if (isLoopbackHostname(hostname)) {
		return true;
	}
	if (hostname !== internalServiceHost) {
		return false;
	}
	if (!hasConfiguredInternalServiceSecret(secret)) {
		warnMissingInternalServiceSecret();
		return true;
	}
	return request.headers.get(internalServiceAuthHeader) === secret;
}

function hasConfiguredInternalServiceSecret(secret: string | undefined): secret is string {
	return typeof secret === "string" && secret.length > 0;
}

function warnMissingInternalServiceSecret(): void {
	if (warnedMissingInternalServiceSecret) {
		return;
	}
	warnedMissingInternalServiceSecret = true;
	console.warn(
		"Bickr internal-service auth is not configured; trusting internal.bickr by hostname only. " +
			"Set INTERNAL_SERVICE_SECRET on every internal service sender and receiver.",
	);
}
