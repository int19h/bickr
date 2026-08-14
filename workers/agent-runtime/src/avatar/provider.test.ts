import { describe, expect, it } from "vitest";
import { providerAvatarImageStreamChunk } from "../index";
import { providerAvatarRequestedToolCalls, providerAvatarToolChoice } from "./provider";

describe("provider avatar tool policy", () => {
	it("covers every stored request strategy without losing provider omission intent", () => {
		expect(providerAvatarRequestedToolCalls({ toolCallRequest: { kind: "provider_default" } })).toBe("at_will");
		expect(providerAvatarRequestedToolCalls({ toolCallRequest: { kind: "inherit" }, toolCalls: "railroad" })).toBe("railroad");
		expect(providerAvatarRequestedToolCalls({ toolCallRequest: { kind: "bickr_automatic" }, toolCalls: "railroad" })).toBe("railroad");
		expect(providerAvatarRequestedToolCalls({ toolCallRequest: { kind: "bickr_automatic" }, toolCalls: "require" })).toBe("require");
		for (const [strategy, expected] of [
			["require", "require"],
			["railroad", "railroad"],
			["at_will", "require"],
		] as const) {
			expect(providerAvatarRequestedToolCalls({ toolCallRequest: { kind: "strategy", strategy } })).toBe(expected);
		}
	});

	it("covers every avatar response mode and structured tool strategy", () => {
		const automatic = { toolCallRequest: { kind: "bickr_automatic" as const } };
		const providerDefault = { toolCallRequest: { kind: "provider_default" as const } };
		for (const mode of ["structured_output", "tool_call", "tool_call_cache_friendly"] as const) {
			for (const strategy of ["require", "railroad"] as const) {
				const expected = mode === "structured_output" ? undefined : strategy === "require" ? "required" : undefined;
				expect(providerAvatarToolChoice(mode, automatic, strategy)).toBe(expected);
				expect(providerAvatarToolChoice(mode, providerDefault, strategy)).toBeUndefined();
			}
		}
	});
});

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
