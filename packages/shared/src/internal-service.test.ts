import { afterEach, describe, expect, it, vi } from "vitest";
import {
	internalServiceAuthHeader,
	isTrustedInternalServiceRequest,
} from "./internal-service";

const configuredSecret = "configured-internal-service-secret";

describe("isTrustedInternalServiceRequest", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("trusts internal service requests with the configured secret", () => {
		expect(isTrustedInternalServiceRequest(internalRequest(configuredSecret), configuredSecret)).toBe(true);
	});

	it("rejects internal service requests with a wrong or missing secret", () => {
		expect(isTrustedInternalServiceRequest(internalRequest("wrong-secret"), configuredSecret)).toBe(false);
		expect(isTrustedInternalServiceRequest(internalRequest(undefined), configuredSecret)).toBe(false);
	});

	it("always trusts loopback requests", () => {
		expect(isTrustedInternalServiceRequest(new Request("http://localhost/health"), configuredSecret)).toBe(true);
		expect(isTrustedInternalServiceRequest(new Request("http://127.0.0.1/health"), configuredSecret)).toBe(true);
		expect(isTrustedInternalServiceRequest(new Request("http://[::1]/health"), configuredSecret)).toBe(true);
	});

	it("preserves hostname-only internal trust and warns when no secret is configured", async () => {
		vi.resetModules();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { isTrustedInternalServiceRequest: isTrusted } = await import("./internal-service");

		expect(isTrusted(internalRequest(undefined), undefined)).toBe(true);
		expect(isTrusted(internalRequest(undefined), undefined)).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("INTERNAL_SERVICE_SECRET");
	});
});

function internalRequest(secret: string | undefined): Request {
	const headers = new Headers();
	if (secret !== undefined) {
		headers.set(internalServiceAuthHeader, secret);
	}
	return new Request("https://internal.bickr/health", { headers });
}
