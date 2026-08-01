import { describe, expect, it } from "vitest";
import { resolveBotProviderSettings } from "./inference-settings";

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
			{ OPENROUTER_MODEL: "deployment/model" },
		);
		expect(defaultResolution.resolved.model).toEqual({ effective: "deployment/model", source: "bickr_default" });
	});
});
