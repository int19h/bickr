import { describe, expect, it } from "vitest";

import {
	avatarImageGenerationSettingsWithDefaults,
	defaultAvatarImageGenerationSettings,
	defaultWorldAvatarImageGenerationSettings,
	isOpenRouterGrokImageAspectRatio,
	isOpenRouterImageAspectRatio,
	openRouterGrokImageAspectRatios,
	openRouterSuggestedImageAspectRatios,
	openRouterSuggestedImageSizes,
	supportsOpenRouterExtendedImageConfig,
	supportsOpenRouterGrokImageAspectRatios,
	worldAvatarImageGenerationSettingsWithDefaults,
} from "./model";

describe("OpenRouter image aspect ratios", () => {
	it("recognizes Grok-specific aspect ratios as supported choices", () => {
		expect(openRouterGrokImageAspectRatios).toEqual(["2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "auto"]);
		for (const ratio of openRouterGrokImageAspectRatios) {
			expect(isOpenRouterImageAspectRatio(ratio)).toBe(true);
			expect(isOpenRouterGrokImageAspectRatio(ratio)).toBe(true);
		}
	});

	it("limits Grok-specific aspect ratios to Grok Imagine image model IDs", () => {
		expect(supportsOpenRouterGrokImageAspectRatios("x-ai/grok-imagine-image-quality")).toBe(true);
		expect(supportsOpenRouterGrokImageAspectRatios("x-ai/grok-imagine-image-quality:free")).toBe(true);
		expect(supportsOpenRouterGrokImageAspectRatios("google/gemini-3.1-flash-image-preview")).toBe(false);
		expect(supportsOpenRouterGrokImageAspectRatios("x-ai/grok-4.3")).toBe(false);
	});

	it("defaults image generation to the released Nano Banana 2 model", () => {
		expect(defaultAvatarImageGenerationSettings.model).toBe("google/gemini-3.1-flash-image");
		expect(avatarImageGenerationSettingsWithDefaults(undefined).model).toBe("google/gemini-3.1-flash-image");
		expect(supportsOpenRouterExtendedImageConfig("google/gemini-3.1-flash-image")).toBe(false);
		expect(supportsOpenRouterExtendedImageConfig("google/gemini-3.1-flash-image-preview")).toBe(true);
	});

	it("provides model-specific image config suggestions without making them hard validation choices", () => {
		expect(openRouterSuggestedImageAspectRatios("google/gemini-3.1-flash-image")).toEqual([
			"1:1",
			"2:3",
			"3:2",
			"3:4",
			"4:3",
			"4:5",
			"5:4",
			"9:16",
			"16:9",
			"21:9",
		]);
		expect(openRouterSuggestedImageSizes("google/gemini-3.1-flash-image")).toEqual(["1K", "2K"]);
		expect(openRouterSuggestedImageAspectRatios("google/gemini-3.1-flash-image-preview")).toEqual([
			"1:1",
			"2:3",
			"3:2",
			"3:4",
			"4:3",
			"4:5",
			"5:4",
			"9:16",
			"16:9",
			"21:9",
			"1:4",
			"4:1",
			"1:8",
			"8:1",
		]);
		expect(openRouterSuggestedImageSizes("google/gemini-3.1-flash-image-preview")).toEqual(["0.5K", "1K", "2K", "4K"]);
		expect(openRouterSuggestedImageAspectRatios("microsoft/mai-image-2.5")).toEqual(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "9:16", "16:9", "21:9"]);
		expect(openRouterSuggestedImageSizes("microsoft/mai-image-2.5")).toEqual(["1K", "4K", "1024x1024"]);
		expect(openRouterSuggestedImageAspectRatios("x-ai/grok-imagine-image-quality")).toContain("auto");
		expect(openRouterSuggestedImageAspectRatios("x-ai/grok-imagine-image-quality")).not.toContain("4:5");
		expect(openRouterSuggestedImageAspectRatios("x-ai/grok-imagine-image-quality")).not.toContain("21:9");
		expect(openRouterSuggestedImageSizes("x-ai/grok-imagine-image-quality")).toEqual(["1K", "2K"]);
		expect(openRouterSuggestedImageAspectRatios("recraft/recraft-v4.1")).not.toContain("21:9");
		expect(openRouterSuggestedImageSizes("sourceful/riverflow-v2-fast")).toEqual(["1K", "2K", "1024x1024"]);
		expect(openRouterSuggestedImageSizes("sourceful/riverflow-v2-pro")).toEqual(["1K", "2K", "4K"]);
		expect(openRouterSuggestedImageAspectRatios("openai/gpt-image-2")).toEqual([]);
		expect(openRouterSuggestedImageSizes("openai/gpt-image-2")).toEqual(["1024x1024", "1024x1536", "1536x1024", "2560x1440", "3840x2160"]);
		expect(openRouterSuggestedImageAspectRatios("openai/gpt-image-1-mini")).toEqual([]);
		expect(openRouterSuggestedImageSizes("openai/gpt-image-1-mini")).toEqual(["1024x1024", "1024x1536", "1536x1024"]);
	});

	it("uses a widescreen default aspect ratio for world avatars only", () => {
		expect(defaultWorldAvatarImageGenerationSettings.aspectRatio).toBe("21:9");
		expect(worldAvatarImageGenerationSettingsWithDefaults(undefined).aspectRatio).toBe("21:9");
		expect(worldAvatarImageGenerationSettingsWithDefaults({ aspectRatio: "4:3" }).aspectRatio).toBe("4:3");
		expect(avatarImageGenerationSettingsWithDefaults({ aspectRatio: "12:78", imageSize: "custom-size" })).toMatchObject({
			aspectRatio: "12:78",
			imageSize: "custom-size",
		});
		expect(avatarImageGenerationSettingsWithDefaults(undefined).aspectRatio).toBe("1:1");
	});
});
