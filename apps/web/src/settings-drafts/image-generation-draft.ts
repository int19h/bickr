import type {
	BotImageGenerationSettingsInput,
	BotInferenceSettings,
	LanguageTag,
} from "@bickr/shared/model";
import {
	defaultSettingsDraftLanguage,
	localizedOptionalDraft,
	nullableNumberInput,
	nullableTextInput,
	numericDraftValue,
	providerRoutingDraftChanged,
	providerRoutingDraftValue,
	providerRoutingInputFromDraft,
	textValue,
} from "./common";
import {
	draftChangedByFieldDescriptors,
	draftFromFieldDescriptors,
	inputFromFieldDescriptors,
	type DraftFieldDescriptor,
} from "./field-descriptors";
import type { ImageGenerationDraft } from "./types";

type ImageGenerationDescriptorContext = {
	language: LanguageTag | null;
	prompt?: string;
};

const emptyContext: ImageGenerationDescriptorContext = {
	language: defaultSettingsDraftLanguage,
};

const imageGenerationFieldDescriptors = [
	{
		key: "imageGenerationModel",
		inputKey: "model",
		defaultValue: "",
		format: (settings) => settings.imageGeneration?.model,
		parse: (value) => nullableTextInput(value),
		changed: (draftValue, savedValue) => draftValue.trim() !== savedValue,
	},
	{
		key: "imageGenerationPrompt",
		inputKey: "prompt",
		defaultValue: "",
		format: (settings) => textValue(settings.imageGeneration?.prompt),
		parse: (value, _draft, context) => localizedOptionalDraft(context.prompt ?? value, context.language),
		changed: (draftValue, savedValue) => draftValue.trim() !== savedValue,
	},
	{
		key: "imageGenerationProviderRouting",
		inputKey: "providerRouting",
		defaultValue: "",
		format: (settings) => providerRoutingDraftValue(settings.imageGeneration?.providerRouting),
		parse: (value) => providerRoutingInputFromDraft(value),
		changed: (draftValue, _savedValue, settings) =>
			providerRoutingDraftChanged(draftValue, settings.imageGeneration?.providerRouting),
	},
	{
		key: "imageGenerationAspectRatio",
		inputKey: "aspectRatio",
		defaultValue: "",
		format: (settings) => settings.imageGeneration?.aspectRatio?.trim(),
		parse: (value) => nullableTextInput(value),
		changed: (draftValue, _savedValue, settings) =>
			draftValue.trim() !== (settings.imageGeneration?.aspectRatio ?? ""),
	},
	{
		key: "imageGenerationImageSize",
		inputKey: "imageSize",
		defaultValue: "",
		format: (settings) => settings.imageGeneration?.imageSize?.trim(),
		parse: (value) => nullableTextInput(value),
		changed: (draftValue, _savedValue, settings) =>
			draftValue.trim() !== (settings.imageGeneration?.imageSize ?? ""),
	},
	...imageGenerationNumberFieldDescriptors([
		["imageGenerationTemperature", "temperature"],
		["imageGenerationTopK", "topK"],
		["imageGenerationTopP", "topP"],
		["imageGenerationMinP", "minP"],
		["imageGenerationFrequencyPenalty", "frequencyPenalty"],
		["imageGenerationPresencePenalty", "presencePenalty"],
		["imageGenerationRepetitionPenalty", "repetitionPenalty"],
	]),
] satisfies readonly DraftFieldDescriptor<
	ImageGenerationDraft,
	BotInferenceSettings,
	BotImageGenerationSettingsInput,
	ImageGenerationDescriptorContext
>[];

function imageGenerationNumberFieldDescriptors(
	fields: readonly (readonly [
		keyof Pick<
			ImageGenerationDraft,
			| "imageGenerationTemperature"
			| "imageGenerationTopK"
			| "imageGenerationTopP"
			| "imageGenerationMinP"
			| "imageGenerationFrequencyPenalty"
			| "imageGenerationPresencePenalty"
			| "imageGenerationRepetitionPenalty"
		>,
		keyof Pick<
			BotImageGenerationSettingsInput,
			"temperature" | "topK" | "topP" | "minP" | "frequencyPenalty" | "presencePenalty" | "repetitionPenalty"
		>,
	])[],
): DraftFieldDescriptor<
	ImageGenerationDraft,
	BotInferenceSettings,
	BotImageGenerationSettingsInput,
	ImageGenerationDescriptorContext
>[] {
	return fields.map(([key, inputKey]) => ({
		key,
		inputKey,
		defaultValue: "",
		format: (settings) => numericDraftValue(settings.imageGeneration?.[inputKey]),
		parse: (value) => nullableNumberInput(value),
		changed: (draftValue, savedValue) => draftValue.trim() !== savedValue,
	})) as DraftFieldDescriptor<
		ImageGenerationDraft,
		BotInferenceSettings,
		BotImageGenerationSettingsInput,
		ImageGenerationDescriptorContext
	>[];
}

export function imageGenerationDraftFromSettings(settings: BotInferenceSettings): ImageGenerationDraft {
	return draftFromFieldDescriptors(imageGenerationFieldDescriptors, settings, emptyContext) as ImageGenerationDraft;
}

export function imageGenerationInputFromDraft(
	draft: ImageGenerationDraft,
	prompt = draft.imageGenerationPrompt,
	language: LanguageTag | null = defaultSettingsDraftLanguage,
): BotImageGenerationSettingsInput {
	return inputFromFieldDescriptors(imageGenerationFieldDescriptors, draft, { language, prompt });
}

export function imageGenerationDraftChanged(
	draft: ImageGenerationDraft,
	settings: BotInferenceSettings,
): boolean {
	return draftChangedByFieldDescriptors(imageGenerationFieldDescriptors, draft, settings, emptyContext);
}

export { imageGenerationFieldDescriptors };
