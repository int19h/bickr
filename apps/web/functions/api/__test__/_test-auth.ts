import { fail } from "@bickr/shared/api";
import { isLoopbackHostname } from "@bickr/shared/internal-service";
import { type AppEnv } from "../_auth";

export async function testAuthFailureResponse(env: Pick<AppEnv, "TEST_AUTH_ALLOWED_HOSTS" | "TEST_AUTH_SECRET">, request: Request): Promise<Response | null> {
	const configuredSecret = env.TEST_AUTH_SECRET?.trim();
	if (!configuredSecret || !isTestAuthAllowedRequest(env, request)) {
		return fail("not_found", "Not found.", 404);
	}

	const suppliedSecret = request.headers.get("x-test-auth-secret") ?? "";
	if (!(await timingSafeEqual(configuredSecret, suppliedSecret))) {
		return fail("unauthorized", "Test auth secret is invalid.", 401);
	}

	return null;
}

export function isTestAuthAllowedRequest(env: Pick<AppEnv, "TEST_AUTH_ALLOWED_HOSTS">, request: Request): boolean {
	const hostname = new URL(request.url).hostname.toLowerCase();
	return isLoopbackHostname(hostname) || allowedTestAuthHosts(env).has(hostname);
}

function allowedTestAuthHosts(env: Pick<AppEnv, "TEST_AUTH_ALLOWED_HOSTS">): Set<string> {
	return new Set(
		(env.TEST_AUTH_ALLOWED_HOSTS ?? "")
			.split(",")
			.map((host) => host.trim().toLowerCase())
			.filter(Boolean),
	);
}

async function timingSafeEqual(expected: string, actual: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [expectedDigest, actualDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
		crypto.subtle.digest("SHA-256", encoder.encode(actual)),
	]);
	const expectedBytes = new Uint8Array(expectedDigest);
	const actualBytes = new Uint8Array(actualDigest);
	let difference = expectedBytes.length ^ actualBytes.length;
	for (let index = 0; index < expectedBytes.length; index += 1) {
		difference |= expectedBytes[index]! ^ actualBytes[index]!;
	}
	return difference === 0;
}
