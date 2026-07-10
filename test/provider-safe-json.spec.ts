import { describe, expect, it } from "vitest";
import { providerSafeJsonValue } from "../workers/agent-runtime/src/index";

describe("providerSafeJsonValue", () => {
	it("keeps promptToken-style provider fields while dropping real credential key shapes", () => {
		expect(providerSafeJsonValue({
			promptToken: "visible",
			prompt_tokens: 12,
			token: "hidden",
			apiToken: "hidden",
			access_token: "hidden",
			refreshToken: "hidden",
			authToken: "hidden",
			sessionToken: "hidden",
			idToken: "hidden",
			bearerToken: "hidden",
			openRouterApiKey: "hidden",
			clientSecret: "hidden",
			nested: {
				promptToken: "nested-visible",
				bearer_token: "hidden",
			},
		})).toEqual({
			promptToken: "visible",
			prompt_tokens: 12,
			nested: {
				promptToken: "nested-visible",
			},
		});
	});
});
