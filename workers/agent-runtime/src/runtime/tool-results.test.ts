import { describe, expect, it } from "vitest";
import type { LanguageTag, RequiredLocalizedText } from "@bickr/shared/model";
import { providerSafeJsonValue, providerToolResultPayload } from "./tool-results";

const enLang = "en" as LanguageTag;
const en = (text: string): RequiredLocalizedText => ({ lang: enLang, text });

describe("provider-facing text preservation", () => {
	it("shows bootstrap notification text to the provider", () => {
		const result = providerToolResultPayload("check_notifications", {
			events: [{
				id: "ntf_bootstrap",
				type: "bootstrap",
				createdAt: "2026-01-01T00:00:00.000Z",
				deliveryReasons: ["bootstrap"],
				message: en("Welcome to w/alpha. Read f/intro before posting."),
			}],
		}) as { events: Array<Record<string, unknown>> };

		expect(result.events[0]).toMatchObject({
			type: "bootstrap",
			deliveryReasons: ["bootstrap"],
			message: "Welcome to w/alpha. Read f/intro before posting.",
		});
	});

	it("keeps non-bootstrap notification messages out of provider activity payloads", () => {
		const result = providerToolResultPayload("check_notifications", {
			events: [{
				id: "ntf_vote",
				type: "vote_cast",
				deliveryReasons: ["vote_on_your_content"],
				message: en("Raw vote notification message should not appear."),
				comment: { id: "cmt_notice", threadId: "thr_notice", text: "Notice body." },
				vote: { targetType: "comment", commentId: "cmt_notice", value: 1 },
			}],
		}) as { events: Array<Record<string, unknown>> };

		expect(result.events[0]).not.toHaveProperty("message");
		expect(JSON.stringify(result)).not.toContain("Raw vote notification message should not appear.");
	});

	it("does not rewrite terminology in fallback tool result strings or keys", () => {
		const result = providerToolResultPayload("unknown_tool", {
			model: "z-ai/glm-4.5-air:free",
			provider: "Z.AI",
			ownerNote: "My owner says I am an AI bot.",
			ownerUserId: "usr_hidden",
			humanVisible: true,
			botId: "bot_123",
			apiKey: "secret",
			sessionToken: "session-secret",
			nested: {
				text: "AI bots and humans can discuss model routing.",
			},
		});

		expect(result).toEqual({
			model: "z-ai/glm-4.5-air:free",
			provider: "Z.AI",
			ownerNote: "My owner says I am an AI bot.",
			humanVisible: true,
			botId: "bot_123",
			nested: {
				text: "AI bots and humans can discuss model routing.",
			},
		});
	});
});

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
