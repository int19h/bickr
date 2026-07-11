import {
	defaultTranslationPrompt,
	localizedText,
	type BotInferenceSettings,
	type BotTranslationSettingsInput,
	type LanguageTag,
} from "@bickr/shared/model";
import {
	effectiveReasoningEffortForModel,
	effectiveStructuredToolCallsForModel,
} from "@bickr/shared/openrouter-model-capabilities";
import {
	defaultSettingsDraftLanguage,
	effectiveInferenceDraftBaseUrl,
	effectiveInferenceDraftModel,
	effectiveInferenceSettingsBaseUrl,
	effectiveInferenceSettingsModel,
	inferenceCapabilityContext,
	isOpenRouterProviderBaseUrl,
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
import type { InferenceDraft, InferenceModelUnlockContext, TranslationDraft } from "./types";

type TranslationDescriptorContext = {
	inherited?: InferenceModelUnlockContext | null;
	language: LanguageTag | null;
};

function translationContext(
	inherited?: InferenceModelUnlockContext | null,
	language: LanguageTag | null = defaultSettingsDraftLanguage,
): TranslationDescriptorContext {
	return { inherited, language };
}

export function normalizeTranslationDraftForCapabilities(
	draft: InferenceDraft,
	inherited?: InferenceModelUnlockContext | null,
): InferenceDraft {
	const model = draft.translationModel.trim() || effectiveInferenceDraftModel(draft, inherited);
	const baseUrl = effectiveInferenceDraftBaseUrl(draft, inherited);
	const context = inferenceCapabilityContext(model, baseUrl);
	return {
		...draft,
		translationReasoningEffort:
			draft.translationReasoningEffort === "none" && !context.supportsReasoningNone ? "minimal" : draft.translationReasoningEffort,
		translationToolCalls:
			draft.translationToolCalls === "require" && !context.supportsRequiredToolCalls ? "railroad" : draft.translationToolCalls,
	};
}

export function translationDefaultsForSettings(
	settings: BotInferenceSettings,
	inherited?: InferenceModelUnlockContext | null,
): Pick<TranslationDraft, "translationReasoningEffort" | "translationToolCalls"> {
	const translation = settings.translation;
	const model = translation?.model?.trim() || effectiveInferenceSettingsModel(settings, inherited);
	const baseUrl = effectiveInferenceSettingsBaseUrl(settings, inherited);
	const openRouter = isOpenRouterProviderBaseUrl(baseUrl);
	const reasoningEffort = effectiveReasoningEffortForModel(model, openRouter, translation?.reasoningEffort);
	return {
		translationReasoningEffort: reasoningEffort ?? "default",
		translationToolCalls: effectiveStructuredToolCallsForModel(model, openRouter, translation?.toolCalls),
	};
}

export function translationDefaultsForDraft(
	draft: InferenceDraft,
	inherited?: InferenceModelUnlockContext | null,
): Pick<TranslationDraft, "translationReasoningEffort" | "translationToolCalls"> {
	const model = draft.translationModel.trim() || effectiveInferenceDraftModel(draft, inherited);
	const baseUrl = effectiveInferenceDraftBaseUrl(draft, inherited);
	const openRouter = isOpenRouterProviderBaseUrl(baseUrl);
	const reasoningEffort = effectiveReasoningEffortForModel(model, openRouter, undefined);
	return {
		translationReasoningEffort: reasoningEffort ?? "default",
		translationToolCalls: effectiveStructuredToolCallsForModel(model, openRouter, undefined),
	};
}

const translationFieldDescriptors = [
	{
		key: "translationEnabled",
		inputKey: "enabled",
		defaultValue: false,
		format: (settings) => Boolean(settings.translation?.enabled),
		parse: (value) => value,
		changed: (draftValue, savedValue) => draftValue !== savedValue,
	},
	{
		key: "translationModel",
		inputKey: "model",
		defaultValue: "",
		format: (settings) => settings.translation?.model,
		parse: (value) => nullableTextInput(value),
		changed: (draftValue, savedValue) => draftValue.trim() !== savedValue,
	},
	{
		key: "translationPrompt",
		inputKey: "prompt",
		defaultValue: defaultTranslationPrompt,
		format: (settings) => textValue(settings.translation?.prompt) || defaultTranslationPrompt,
		parse: (value, _draft, context) => localizedText(value.trim() || defaultTranslationPrompt, context.language),
		changed: (draftValue, savedValue) => draftValue.trim() !== savedValue,
	},
	{
		key: "translationReasoningEffort",
		inputKey: "reasoningEffort",
		defaultValue: "default",
		format: (settings, context) => translationDefaultsForSettings(settings, context.inherited).translationReasoningEffort,
		parse: (value, draft, context) => {
			const defaultValue = translationDefaultsForDraft(draft as InferenceDraft, context.inherited).translationReasoningEffort;
			return value === defaultValue ? null : nullableReasoningEffortInput(value);
		},
		changed: (draftValue, savedValue) => draftValue !== savedValue,
	},
	{
		key: "translationToolCalls",
		inputKey: "toolCalls",
		defaultValue: "railroad",
		format: (settings, context) => translationDefaultsForSettings(settings, context.inherited).translationToolCalls,
		parse: (value, draft, context) => {
			const defaultValue = translationDefaultsForDraft(draft as InferenceDraft, context.inherited).translationToolCalls;
			return value === defaultValue ? null : nullableStructuredToolCallsInput(value);
		},
		changed: (draftValue, savedValue) => draftValue !== savedValue,
	},
	{
		key: "translationProviderRouting",
		inputKey: "providerRouting",
		defaultValue: "",
		format: (settings) => providerRoutingDraftValue(settings.translation?.providerRouting),
		parse: (value) => providerRoutingInputFromDraft(value),
		changed: (draftValue, _savedValue, settings) =>
			providerRoutingDraftChanged(draftValue, settings.translation?.providerRouting),
	},
	...translationNumberFieldDescriptors([
		["translationTemperature", "temperature"],
		["translationTopK", "topK"],
		["translationTopP", "topP"],
		["translationMinP", "minP"],
		["translationFrequencyPenalty", "frequencyPenalty"],
		["translationPresencePenalty", "presencePenalty"],
		["translationRepetitionPenalty", "repetitionPenalty"],
	]),
] satisfies readonly DraftFieldDescriptor<
	TranslationDraft,
	BotInferenceSettings,
	BotTranslationSettingsInput,
	TranslationDescriptorContext
>[];

function translationNumberFieldDescriptors(
	fields: readonly (readonly [
		keyof Pick<
			TranslationDraft,
			| "translationTemperature"
			| "translationTopK"
			| "translationTopP"
			| "translationMinP"
			| "translationFrequencyPenalty"
			| "translationPresencePenalty"
			| "translationRepetitionPenalty"
		>,
		keyof Pick<
			BotTranslationSettingsInput,
			"temperature" | "topK" | "topP" | "minP" | "frequencyPenalty" | "presencePenalty" | "repetitionPenalty"
		>,
	])[],
): DraftFieldDescriptor<TranslationDraft, BotInferenceSettings, BotTranslationSettingsInput, TranslationDescriptorContext>[] {
	return fields.map(([key, inputKey]) => ({
		key,
		inputKey,
		defaultValue: "",
		format: (settings) => numericDraftValue(settings.translation?.[inputKey]),
		parse: (value) => nullableNumberInput(value),
		changed: (draftValue, savedValue) => draftValue.trim() !== savedValue,
	})) as DraftFieldDescriptor<TranslationDraft, BotInferenceSettings, BotTranslationSettingsInput, TranslationDescriptorContext>[];
}

function nullableReasoningEffortInput(value: string): BotInferenceSettings["reasoningEffort"] | null {
	return value && value !== "default" ? value as BotInferenceSettings["reasoningEffort"] : null;
}

function nullableStructuredToolCallsInput(value: string): BotTranslationSettingsInput["toolCalls"] {
	return value === "require" || value === "railroad" ? value : null;
}

export function translationDraftFromSettings(
	settings: BotInferenceSettings,
	inherited?: InferenceModelUnlockContext | null,
): TranslationDraft {
	return draftFromFieldDescriptors(translationFieldDescriptors, settings, translationContext(inherited)) as TranslationDraft;
}

export function translationInputFromDraft(
	draft: InferenceDraft,
	inherited?: InferenceModelUnlockContext | null,
	language: LanguageTag | null = defaultSettingsDraftLanguage,
): BotTranslationSettingsInput {
	const normalized = normalizeTranslationDraftForCapabilities(draft, inherited);
	return inputFromFieldDescriptors(translationFieldDescriptors, normalized, translationContext(inherited, language));
}

export function translationDraftChanged(
	draft: InferenceDraft,
	settings: BotInferenceSettings,
	inherited?: InferenceModelUnlockContext | null,
): boolean {
	const normalized = normalizeTranslationDraftForCapabilities(draft, inherited);
	return draftChangedByFieldDescriptors(translationFieldDescriptors, normalized, settings, translationContext(inherited));
}

export { translationFieldDescriptors };
