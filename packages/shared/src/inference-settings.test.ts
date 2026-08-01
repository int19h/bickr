import { describe, expect, it } from "vitest";
import { providerEnvironmentSettingsFromBindings, resolveBotProviderSettings } from "./inference-settings";

describe("resolveBotProviderSettings", () => {
	it("inherits the profile model and provider settings when the bot model is unset", () => {
		const resolution = resolveBotProviderSettings(
			{ inferenceSettings: {} },
			{
				inferenceSettings: {
					model: "deepseek/deepseek-v4-flash-0731",
					openRouterApiKeySet: true,
					providerRouting: { only: ["deepseek/fp8"] },
					temperature: 0.4,
				},
			},
		);

		expect(resolution.settings).toMatchObject({
			model: "deepseek/deepseek-v4-flash-0731",
			providerRouting: { only: ["deepseek/fp8"] },
			temperature: 0.4,
		});
		expect(resolution.resolved.model).toEqual({
			effective: "deepseek/deepseek-v4-flash-0731",
			source: "profile",
		});
		expect(resolution.resolved.openRouterApiKeySet).toEqual({ effective: true, source: "profile" });
		expect(resolution.resolved.providerRouting?.source).toBe("profile");
	});

	it("uses a bot model while inheriting only the profile provider connection", () => {
		const resolution = resolveBotProviderSettings(
			{ inferenceSettings: { model: "bot/model" } },
			{
				inferenceSettings: {
					model: "profile/model",
					openRouterApiKey: "profile-key",
					providerRouting: { order: ["anthropic"] },
					temperature: 0.4,
				},
			},
		);

		expect(resolution.settings).toMatchObject({
			apiKey: "profile-key",
			model: "bot/model",
			temperature: 1,
		});
		expect(resolution.settings.providerRouting).toBeUndefined();
		expect(resolution.resolved.model.source).toBe("bot");
		expect(resolution.resolved.temperature.source).toBe("bickr_default");
	});

	it("reports linked-source and Bickr-default provenance without changing resolution", () => {
		const sourceResolution = resolveBotProviderSettings(
			{ inferenceSettings: { baseUrl: "http://localhost:11434/v1", model: "source/model" } },
			{ inferenceSettings: {} },
			{},
			{ botSource: "source_bot" },
		);
		expect(sourceResolution.resolved.model).toEqual({ effective: "source/model", source: "source_bot" });

		const defaultResolution = resolveBotProviderSettings(
			{ inferenceSettings: {} },
			{ inferenceSettings: {} },
			{ model: "deployment/model" },
		);
		expect(defaultResolution.resolved.model).toEqual({ effective: "deployment/model", source: "bickr_default" });
	});

	it("can trust a persisted bot model when its private provider context is unavailable", () => {
		const resolution = resolveBotProviderSettings(
			{ inferenceSettings: { model: "anthropic/claude-opus-4" } },
			{ inferenceSettings: undefined },
			{},
			{ assumeBotProviderAvailable: true },
		);

		expect(resolution.resolved.model).toEqual({ effective: "anthropic/claude-opus-4", source: "bot" });
	});

	it("tracks a linked clone's inference settings as one inherited object", () => {
		const resolution = resolveBotProviderSettings(
			{
				inferenceSettings: {
					baseUrl: "http://localhost:11434/v1",
					model: "source/model",
					temperature: 0.4,
					toolCalls: "at_will",
				},
			},
			{ inferenceSettings: {} },
			{},
			{ botSource: "source_bot" },
		);

		expect(resolution.resolved.model.source).toBe("source_bot");
		expect(resolution.resolved.temperature.source).toBe("source_bot");
		expect(resolution.resolved.toolCalls.source).toBe("source_bot");
	});

	it("identifies values constrained by model capabilities", () => {
		const resolution = resolveBotProviderSettings(
			{
				inferenceSettings: {
					model: "anthropic/claude-3-haiku",
					openRouterApiKeySet: true,
					toolCalls: "require",
				},
			},
			{ inferenceSettings: {} },
		);

		expect(resolution.resolved.toolCalls).toEqual({ effective: "railroad", source: "model_capability" });
	});

	it("redacts the deployment key while preserving its availability", () => {
		expect(providerEnvironmentSettingsFromBindings({
			OPENROUTER_API_KEY: "deployment-secret",
			OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
			OPENROUTER_MODEL: "deployment/model",
		}, { includeApiKey: false })).toEqual({
			apiKeySet: true,
			baseUrl: "https://openrouter.ai/api/v1",
			model: "deployment/model",
		});
	});
});
