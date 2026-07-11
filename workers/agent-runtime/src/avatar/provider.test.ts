import { describe, expect, it } from "vitest";
import { providerAvatarImageStreamChunk } from "../index";

describe("provider avatar image streaming", () => {
	it("extracts streamed assistant text, image URLs, usage, and provider metadata", () => {
		const result = providerAvatarImageStreamChunk({
			id: "gen_123",
			model: "google/gemini-2.5-flash-image",
			usage: {
				prompt_tokens: 11,
				completion_tokens: 7,
				total_tokens: 18,
				cost: 0.0123,
			},
			openrouter_metadata: { provider_name: "Google AI Studio" },
			choices: [{
				delta: {
					content: "Here is the avatar.",
					images: [{
						type: "image_url",
						image_url: { url: "data:image/png;base64,abcd" },
					}],
				},
			}],
		});

		expect(result).toMatchObject({
			content: "Here is the avatar.",
			dataUrls: ["data:image/png;base64,abcd"],
			responseId: "gen_123",
			responseModel: "google/gemini-2.5-flash-image",
			responseProviderName: "Google AI Studio",
		});
		expect(result.usage?.cost).toBe(0.0123);
	});

	it("preserves whitespace in streamed assistant text chunks", () => {
		const result = providerAvatarImageStreamChunk({
			choices: [{
				delta: {
					content: " wide-angle ",
				},
			}],
		});

		expect(result.content).toBe(" wide-angle ");
	});

	it("accepts the imageUrl alias used by some OpenRouter SDK examples", () => {
		const result = providerAvatarImageStreamChunk({
			choices: [{
				delta: {
					images: [{
						type: "image_url",
						imageUrl: { url: "data:image/webp;base64,abcd" },
					}],
				},
			}],
		});

		expect(result.dataUrls).toEqual(["data:image/webp;base64,abcd"]);
	});

	it("throws provider stream errors", () => {
		expect(() => providerAvatarImageStreamChunk({
			error: { code: 429, message: "Rate limited", metadata: { error_type: "rate_limit" } },
		})).toThrow("Rate limited");
	});
});
