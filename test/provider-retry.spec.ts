import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRequestError, ProviderRequestTimeoutError } from "../workers/agent-runtime/src/errors";
import {
	providerIgnoreRetryReason,
	providerRetryDelayMsForAttempt,
	providerRetryKey,
	providerRetryKeyForAttempt,
	providerRoutingWithIgnoredProvider,
	providerUpstreamRateLimitRetry,
} from "../workers/agent-runtime/src/provider/retry";

describe("provider retry policy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("requires consecutive retries to have the same key", () => {
		const firstError = new ProviderRequestError(502, "model", "endpoint", "first failure");
		const repeatedError = new ProviderRequestError(502, "model", "endpoint", "first failure");
		const differentError = new ProviderRequestError(503, "model", "endpoint", "second failure");
		const firstKey = providerRetryKeyForAttempt(firstError, null);

		expect(firstKey).toBe("502:first failure");
		expect(providerRetryKeyForAttempt(repeatedError, firstKey)).toBe(firstKey);
		expect(providerRetryKeyForAttempt(differentError, firstKey)).toBeNull();
	});

	it("classifies retryable request and timeout errors", () => {
		expect(providerRetryKey(new ProviderRequestError(429, "model", "endpoint", "limited"))).toBe("429:limited");
		expect(providerRetryKey(new ProviderRequestTimeoutError(60_000))).toBe("Inference request did not respond within 60 seconds.");
		expect(providerRetryKey(new ProviderRequestError(400, "model", "endpoint", "invalid"))).toBeNull();
	});

	it("grows exponential backoff by a factor of three", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);

		expect(providerRetryDelayMsForAttempt(2)).toBe(3_000);
		expect(providerRetryDelayMsForAttempt(3)).toBe(9_000);
		expect(providerRetryDelayMsForAttempt(4)).toBe(27_000);
	});

	it("keeps retry jitter within one third of the base delay", () => {
		const random = vi.spyOn(Math, "random");
		random.mockReturnValueOnce(0).mockReturnValueOnce(1);

		expect(providerRetryDelayMsForAttempt(2)).toBe(2_000);
		expect(providerRetryDelayMsForAttempt(2)).toBe(4_000);
	});

	it("classifies structured upstream provider rate limits", () => {
		const error = new ProviderRequestError(502, "model", "endpoint", "upstream limited", {
			providerError: {
				kind: "provider_error",
				status: 429,
				providerName: "DeepInfra",
			},
		});

		expect(providerUpstreamRateLimitRetry(error)).toEqual({
			providerName: "DeepInfra",
			retryKey: "502:upstream limited",
		});
	});

	it("composes provider routing ignores without dropping other routing fields", () => {
		const first = providerRoutingWithIgnoredProvider(
			{ order: ["openrouter/fallback"], ignore: ["A"] },
			" DeepInfra ",
		);
		const repeated = providerRoutingWithIgnoredProvider(first.providerRouting, "deepinfra");

		expect(first).toEqual({
			providerRouting: { order: ["openrouter/fallback"], ignore: ["A", "DeepInfra"] },
			changed: true,
		});
		expect(repeated).toEqual({
			providerRouting: { order: ["openrouter/fallback"], ignore: ["A", "DeepInfra"] },
			changed: false,
		});
		expect(providerIgnoreRetryReason({ providerName: "DeepInfra", retryKey: "429:limited" })).toBe(
			"429:limited; ignoring upstream provider DeepInfra",
		);
	});
});
