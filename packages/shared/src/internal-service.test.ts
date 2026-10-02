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

	it("rejects internal requests and warns once when no secret is configured", async () => {
		vi.resetModules();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { isTrustedInternalServiceRequest: isTrusted } = await import("./internal-service");

		expect(isTrusted(internalRequest(undefined), undefined)).toBe(false);
		expect(isTrusted(internalRequest(configuredSecret), undefined)).toBe(false);
		expect(isTrusted(internalRequest(""), "")).toBe(false);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("INTERNAL_SERVICE_SECRET");
	});

	it("does not trust an unrelated hostname even with the correct secret", () => {
		const request = new Request("https://example.com/health", {
			headers: { [internalServiceAuthHeader]: configuredSecret },
		});
		expect(isTrustedInternalServiceRequest(request, configuredSecret)).toBe(false);
	});
});

function internalRequest(secret: string | undefined): Request {
	const headers = new Headers();
	if (secret !== undefined) {
		headers.set(internalServiceAuthHeader, secret);
	}
	return new Request("https://internal.bickr/health", { headers });
}
