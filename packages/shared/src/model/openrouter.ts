// Explicit extension: reached at runtime from the CLI through Node's ESM
// resolver, which does not add `.ts` for an extensionless relative specifier.
import { generatedOpenRouterImageModelConfigEntries } from "../openrouter-image-model-config.generated.ts";
import type { BotImageGenerationSettings } from "./entities";

export const openRouterImageAspectRatios = [
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
] as const;

export const openRouterExtendedImageAspectRatios = ["1:4", "4:1", "1:8", "8:1"] as const;
export const openRouterGrokImageAspectRatios = ["2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "auto"] as const;

export const openRouterImageSizes = ["1K", "2K", "4K"] as const;
export const openRouterExtendedImageSizes = ["0.5K"] as const;
const openRouterGrokImageAspectRatioModelPrefix = "x-ai/grok-imagine-image";
const openRouterDefaultImageConfig = {
	aspectRatios: openRouterImageAspectRatios,
	imageSizes: openRouterImageSizes,
} as const satisfies OpenRouterImageModelConfig;
const generatedOpenRouterImageModelConfig = new Map<string, OpenRouterImageModelConfig>(
	generatedOpenRouterImageModelConfigEntries.map(([model, config]) => [model, config]),
);

export const defaultAvatarImageGenerationSettings = {
	model: "google/gemini-3.1-flash-image",
	aspectRatio: "1:1",
	imageSize: "1K",
} as const satisfies Pick<BotImageGenerationSettings, "model" | "aspectRatio" | "imageSize">;

export const defaultWorldAvatarImageGenerationSettings = {
	...defaultAvatarImageGenerationSettings,
	aspectRatio: "21:9",
} as const satisfies Pick<BotImageGenerationSettings, "model" | "aspectRatio" | "imageSize">;

export function avatarImageGenerationSettingsWithDefaults(
	settings: BotImageGenerationSettings | undefined,
): BotImageGenerationSettings {
	return imageGenerationSettingsWithDefaults(settings, defaultAvatarImageGenerationSettings);
}

export function worldAvatarImageGenerationSettingsWithDefaults(
	settings: BotImageGenerationSettings | undefined,
): BotImageGenerationSettings {
	return imageGenerationSettingsWithDefaults(settings, defaultWorldAvatarImageGenerationSettings);
}

function imageGenerationSettingsWithDefaults(
	settings: BotImageGenerationSettings | undefined,
	defaults: Pick<BotImageGenerationSettings, "model" | "aspectRatio" | "imageSize">,
): BotImageGenerationSettings {
	const model = settings?.model?.trim() || defaults.model;
	const defaultConfigShape =
		!settings?.model?.trim() ||
		normalizedOpenRouterImageModelId(settings.model) === normalizedOpenRouterImageModelId(defaults.model);
	const aspectRatio = settings?.aspectRatio?.trim() || (defaultConfigShape ? defaults.aspectRatio : undefined);
	const imageSize = settings?.imageSize?.trim() || (defaultConfigShape ? defaults.imageSize : undefined);
	const result: BotImageGenerationSettings = {
		...settings,
		model,
	};
	if (aspectRatio) {
		result.aspectRatio = aspectRatio;
	} else {
		delete result.aspectRatio;
	}
	if (imageSize) {
		result.imageSize = imageSize;
	} else {
		delete result.imageSize;
	}
	return result;
}

export type OpenRouterImageAspectRatio =
	| (typeof openRouterImageAspectRatios)[number]
	| (typeof openRouterExtendedImageAspectRatios)[number]
	| (typeof openRouterGrokImageAspectRatios)[number];

export type OpenRouterImageSize =
	| (typeof openRouterImageSizes)[number]
	| (typeof openRouterExtendedImageSizes)[number];

export type OpenRouterImageModelConfig = {
	aspectRatios: readonly string[];
	imageSizes: readonly string[];
};

export function openRouterImageModelConfig(model: string | undefined): OpenRouterImageModelConfig {
	return generatedOpenRouterImageModelConfig.get(normalizedOpenRouterImageModelId(model)) ?? openRouterDefaultImageConfig;
}

export function openRouterSuggestedImageAspectRatios(model: string | undefined): readonly string[] {
	return openRouterImageModelConfig(model).aspectRatios;
}

export function openRouterSuggestedImageSizes(model: string | undefined): readonly string[] {
	return openRouterImageModelConfig(model).imageSizes;
}

export function isOpenRouterImageAspectRatio(value: string): value is OpenRouterImageAspectRatio {
	return (openRouterImageAspectRatios as readonly string[]).includes(value) ||
		(openRouterExtendedImageAspectRatios as readonly string[]).includes(value) ||
		(openRouterGrokImageAspectRatios as readonly string[]).includes(value);
}

export function isOpenRouterImageSize(value: string): value is OpenRouterImageSize {
	return (openRouterImageSizes as readonly string[]).includes(value) ||
		(openRouterExtendedImageSizes as readonly string[]).includes(value);
}

export function isOpenRouterExtendedImageAspectRatio(value: string): value is (typeof openRouterExtendedImageAspectRatios)[number] {
	return (openRouterExtendedImageAspectRatios as readonly string[]).includes(value);
}

export function isOpenRouterGrokImageAspectRatio(value: string): value is (typeof openRouterGrokImageAspectRatios)[number] {
	return (openRouterGrokImageAspectRatios as readonly string[]).includes(value);
}

export function isOpenRouterExtendedImageSize(value: string): value is (typeof openRouterExtendedImageSizes)[number] {
	return (openRouterExtendedImageSizes as readonly string[]).includes(value);
}

export function supportsOpenRouterExtendedImageConfig(model: string): boolean {
	const config = openRouterImageModelConfig(model);
	return config.aspectRatios.some((ratio) => isOpenRouterExtendedImageAspectRatio(ratio)) ||
		config.imageSizes.some((size) => isOpenRouterExtendedImageSize(size));
}

export function supportsOpenRouterGrokImageAspectRatios(model: string): boolean {
	return normalizedOpenRouterImageModelId(model).startsWith(openRouterGrokImageAspectRatioModelPrefix);
}

function normalizedOpenRouterImageModelId(model: string | undefined): string {
	return model?.trim().toLowerCase().split(":")[0] ?? "";
}
