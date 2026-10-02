import { describe, expect, it } from "vitest";
import { inferenceAttributionForRequest, parseInferenceAttribution } from "./inference-attribution";
import { parseCreateThreadInput, parseCreateCommentInput, parseVoteInput } from "./validation";

const source = { botId: "bot-a", worldHandle: "primary", botHandle: "alice", runId: "run-a", requestSeq: 7 };

describe("inference attribution", () => {
	it("captures effective request controls without prompts, endpoints, credentials, schemas, or server tools", () => {
		const attribution = inferenceAttributionForRequest({ model: "vendor/model", temperature: 0.7, top_p: 0.8, max_completion_tokens: 3000,
			reasoning: { effort: "high", exclude: false, secret: "hidden" },
			provider: { order: ["DeepSeek"], allow_fallbacks: false, byok: { api_key: "hidden" }, max_price: { prompt: 1, api_key: "hidden" }, sort: { by: "price", secret: "hidden" } },
			bickr: { contextWindowTokens: 64000, intervalSeconds: 60, maxGeneratedTokensPerTick: 5000 },
			messages: [{ content: "hidden" }], tools: [{ secret: "hidden" }], apiKey: "hidden", baseUrl: "hidden", response_format: { schema: "hidden" }, session_id: "hidden",
		}, source);
		expect(attribution.parameters).toEqual({ temperature: 0.7, top_p: 0.8, max_completion_tokens: 3000,
			reasoning: { effort: "high", exclude: false }, provider: { order: ["DeepSeek"], allow_fallbacks: false, max_price: { prompt: 1 }, sort: { by: "price" } },
			bickr: { contextWindowTokens: 64000, maxGeneratedTokensPerTick: 5000 },
		});
		expect(JSON.stringify(attribution)).not.toContain("hidden");
		expect(parseInferenceAttribution(attribution, source.botId)).toEqual(attribution);
	});

	it("keeps independent snapshots and rejects a different author", () => {
		const request = { model: "vendor/model", provider: { ignore: ["provider-a"] } };
		const attribution = inferenceAttributionForRequest(request, source);
		request.provider.ignore.push("provider-b");
		expect(attribution.parameters.provider).toEqual({ ignore: ["provider-a"] });
		expect(() => parseInferenceAttribution(attribution, "bot-b")).toThrow("author and request");
	});

	it("discards attribution supplied to public input parsers", () => {
		const inferenceAttribution = inferenceAttributionForRequest({ model: "vendor/model" }, source);
		const text = { text: "Body", lang: "en" };
		expect(parseCreateThreadInput({ title: text, body: text, inferenceAttribution })).not.toHaveProperty("inferenceAttribution");
		expect(parseCreateCommentInput({ body: text, inferenceAttribution })).not.toHaveProperty("inferenceAttribution");
		expect(parseVoteInput({ commentId: "c", value: 1, inferenceAttribution })).not.toHaveProperty("inferenceAttribution");
	});
});
