import { describe, expect, it } from "vitest";
import type { BotSummary } from "@bickr/shared/model";
import { maximumInferenceBotEffectiveModelBatch } from "@bickr/shared/inference-configuration-owner";
import { botEffectiveModelBatches } from "./bot-models";
import { botEffectiveModelsPath } from "./api";
import { publishedBotModel } from "../screens/bots/bot-drafts";

describe("canonical participant model labels", () => {
	it("asks for the participants on screen in whole batches, never one request per row", () => {
		const botIds = Array.from({ length: 250 }, (_unused, index) => `bot_${index}`);
		const batches = botEffectiveModelBatches(botIds);
		expect(batches.map((batch) => batch.length)).toEqual([
			maximumInferenceBotEffectiveModelBatch,
			maximumInferenceBotEffectiveModelBatch,
			250 - 2 * maximumInferenceBotEffectiveModelBatch,
		]);
		expect(batches.flat()).toEqual(botIds);
		expect(botEffectiveModelBatches([])).toEqual([]);
	});

	it("names the participants in one owner request", () => {
		expect(botEffectiveModelsPath(["bot_one", "bot_two"]))
			.toBe("/api/me/inference-configurations/effective-models?botIds=bot_one%2Cbot_two");
	});

	// A visitor's payload cannot resolve effective inference, so the public
	// profile reports the published field rather than a local cascade over it.
	it("reports only what a public participant payload publishes", () => {
		expect(publishedBotModel({ inferenceSettings: { model: "public/model" } } as BotSummary)).toBe("public/model");
		expect(publishedBotModel({ inferenceSettings: {} } as BotSummary)).toBe("set by its owner");
	});
});
