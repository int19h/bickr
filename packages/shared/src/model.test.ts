import { describe, expect, it } from "vitest";

import {
	avatarImageGenerationSettingsWithDefaults,
	defaultWorldAvatarImageGenerationSettings,
	isOpenRouterGrokImageAspectRatio,
	isOpenRouterImageAspectRatio,
	openRouterGrokImageAspectRatios,
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

	it("uses a widescreen default aspect ratio for world avatars only", () => {
		expect(defaultWorldAvatarImageGenerationSettings.aspectRatio).toBe("21:9");
		expect(worldAvatarImageGenerationSettingsWithDefaults(undefined).aspectRatio).toBe("21:9");
		expect(worldAvatarImageGenerationSettingsWithDefaults({ aspectRatio: "4:3" }).aspectRatio).toBe("4:3");
		expect(avatarImageGenerationSettingsWithDefaults(undefined).aspectRatio).toBe("1:1");
	});
});
