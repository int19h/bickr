import type {
	BotInferenceSettings,
	BotInferenceSettingsInput,
	BotPromptCacheMode,
	LanguageTag,
} from "@bickr/shared/model";
import { isOpenRouterProviderBaseUrl } from "@bickr/shared/inference-settings";
import {
	effectiveCompactionModeForModel,
	effectiveReasoningEffortForModel,
	effectiveSupportsPrefillForModel,
	effectiveToolCallsForModel,
	modelSupportsPromptCacheControl,
	providerModelPolicy,
} from "@bickr/shared/openrouter-model-capabilities";
import {
	defaultSettingsDraftLanguage,
	effectiveInferenceDraftBaseUrl,
	effectiveInferenceDraftModel,
	effectiveInferenceDraftProviderRouting,
	effectiveInferenceSettingsBaseUrl,
	effectiveInferenceSettingsModel,
	effectiveInferenceSettingsProviderRouting,
	inferenceCapabilityContextForDraft,
	inferenceFallbackContextForDraft,
	localizedOptionalDraft,
	nullableNumberInput,
	nullableNumberInputMatchingInherited,
	nullableTextInput,
	nullableTextInputMatchingInherited,
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
import {
	imageGenerationDraftChanged,
	imageGenerationDraftFromSettings,
	imageGenerationInputFromDraft,
} from "./image-generation-draft";
import {
	translationDraftChanged,
	translationDraftFromSettings,
	translationInputFromDraft,
} from "./translation-draft";
import type { InferenceDraft, InferenceModelUnlockContext } from "./types";

export type InferenceDraftOptions = {
	includeReasoningPrefill?: boolean;
	includeImageGeneration?: boolean;
	includeTranslation?: boolean;
};

type InferenceDescriptorContext = InferenceDraftOptions & {
	inherited?: InferenceModelUnlockContext;
	language: LanguageTag | null;
};

type InferenceFieldDescriptor = DraftFieldDescriptor<
	InferenceDraft,
	BotInferenceSettings,
	BotInferenceSettingsInput,
	InferenceDescriptorContext
> & { section: "core" | "sampling" };

function inferenceContext(
	inherited?: InferenceModelUnlockContext,
	options: InferenceDraftOptions = {},
	language: LanguageTag | null = defaultSettingsDraftLanguage,
): InferenceDescriptorContext {
	return { ...options, inherited, language };
}

export function normalizeInferenceDraftForCapabilities(
	draft: InferenceDraft,
	inherited?: BotInferenceSettings | null,
): InferenceDraft {
	const fallback = inferenceFallbackContextForDraft(draft, inherited);
	const context = inferenceCapabilityContextForDraft(draft, inherited);
	const providerRouting = effectiveInferenceDraftProviderRouting(draft, fallback);
	const policy = providerModelPolicy(context.model, context.openRouter, providerRouting);
	return {
		...draft,
		compactionMode:
			draft.compactionMode === "structured_output" && !context.supportsStructuredCompaction ?
				policy.defaultCompactionMode
			:	draft.compactionMode,
		reasoningEffort: draft.reasoningEffort === "none" && !context.supportsReasoningNone ? "minimal" : draft.reasoningEffort,
		promptCacheMode: context.supportsPromptCacheControl ? draft.promptCacheMode : "off",
		supportsPrefill: context.supportsPrefill ? draft.supportsPrefill : false,
		toolCalls: draft.toolCalls === "require" && !context.supportsRequiredToolCalls ? "railroad" : draft.toolCalls,
	};
}

export function inferenceDefaultsForSettings(
	settings: BotInferenceSettings,
	inherited?: InferenceModelUnlockContext,
): Pick<InferenceDraft, "compactionMode" | "promptCacheMode" | "supportsPrefill" | "reasoningEffort" | "toolCalls"> {
	const model = effectiveInferenceSettingsModel(settings, inherited);
	const baseUrl = effectiveInferenceSettingsBaseUrl(settings, inherited);
	const openRouter = isOpenRouterProviderBaseUrl(baseUrl);
	const providerRouting = effectiveInferenceSettingsProviderRouting(settings, inherited);
	const reasoningEffort = effectiveReasoningEffortForModel(
		model,
		openRouter,
		settings.reasoningEffort ?? inherited?.reasoningEffort,
		providerRouting,
	);
	const promptCacheMode = settings.promptCacheMode ?? inherited?.promptCacheMode ?? "off";
	return {
		compactionMode: effectiveCompactionModeForModel(model, openRouter, settings.compactionMode ?? inherited?.compactionMode, providerRouting),
		promptCacheMode: modelSupportsPromptCacheControl(model, openRouter) ? promptCacheMode : "off",
		supportsPrefill: effectiveSupportsPrefillForModel(model, openRouter, settings.supportsPrefill ?? inherited?.supportsPrefill, providerRouting),
		reasoningEffort: reasoningEffort ?? "default",
		toolCalls: effectiveToolCallsForModel(model, openRouter, settings.toolCalls ?? inherited?.toolCalls, providerRouting),
	};
}

export function inferenceDefaultsForDraft(
	draft: InferenceDraft,
	inherited?: InferenceModelUnlockContext,
): Pick<InferenceDraft, "compactionMode" | "promptCacheMode" | "supportsPrefill" | "reasoningEffort" | "toolCalls"> {
	const fallback = inferenceFallbackContextForDraft(draft, inherited);
	const model = effectiveInferenceDraftModel(draft, fallback);
	const baseUrl = effectiveInferenceDraftBaseUrl(draft, fallback);
	const openRouter = isOpenRouterProviderBaseUrl(baseUrl);
	const providerRouting = effectiveInferenceDraftProviderRouting(draft, fallback);
	const reasoningEffort = effectiveReasoningEffortForModel(model, openRouter, fallback?.reasoningEffort, providerRouting);
	const promptCacheMode = fallback?.promptCacheMode ?? "off";
	return {
		compactionMode: effectiveCompactionModeForModel(model, openRouter, fallback?.compactionMode, providerRouting),
		promptCacheMode: modelSupportsPromptCacheControl(model, openRouter) ? promptCacheMode : "off",
		supportsPrefill: effectiveSupportsPrefillForModel(model, openRouter, fallback?.supportsPrefill, providerRouting),
		reasoningEffort: reasoningEffort ?? "default",
		toolCalls: effectiveToolCallsForModel(model, openRouter, fallback?.toolCalls, providerRouting),
	};
}

const inferenceFieldDescriptors = [
	{
		section: "core",
		key: "baseUrl",
		inputKey: "baseUrl",
		defaultValue: "",
		format: (settings) => settings.baseUrl,
		parse: (value, _draft, context) => nullableTextInputMatchingInherited(value, context.inherited?.baseUrl),
		changed: (draftValue, savedValue) => draftValue.trim() !== savedValue,
	},
	{
		section: "core",
		key: "model",
		inputKey: "model",
		defaultValue: "",
		format: (settings) => settings.model,
		parse: (value, _draft, context) => nullableTextInputMatchingInherited(value, context.inherited?.model),
		changed: (draftValue, savedValue) => draftValue.trim() !== savedValue,
	},
	{
		section: "core",
		key: "compactionMode",
		inputKey: "compactionMode",
		defaultValue: "tool_call",
		format: (settings, context) => inferenceDefaultsForSettings(settings, context.inherited).compactionMode,
		parse: (value, draft, context) => value === inferenceDefaultsForDraft(draft, context.inherited).compactionMode ? null : value,
		changed: (draftValue, savedValue) => draftValue !== savedValue,
	},
	{
		section: "core",
		key: "promptCacheMode",
		inputKey: "promptCacheMode",
		defaultValue: "off",
		format: (settings, context) => inferenceDefaultsForSettings(settings, context.inherited).promptCacheMode,
		parse: (value, draft, context) =>
			value === inferenceDefaultsForDraft(draft, context.inherited).promptCacheMode ? null : nullablePromptCacheModeInput(value),
		changed: (draftValue, savedValue) => draftValue !== savedValue,
	},
	{
		section: "core",
		key: "recurringPromptEnabled",
		inputKey: "recurringPromptEnabled",
		defaultValue: true,
		format: (settings) => settings.recurringPromptEnabled !== false,
		parse: (value) => value ? null : false,
		changed: (draftValue, savedValue, _settings, context) =>
			Boolean(context.includeReasoningPrefill) && draftValue !== savedValue,
	},
	{
		section: "core",
		key: "recurringPrompt",
		inputKey: "recurringPrompt",
		defaultValue: "",
		format: (settings) => textValue(settings.recurringPrompt ?? ""),
		parse: (value, _draft, context) => localizedOptionalDraft(value, context.language),
		changed: (draftValue, savedValue, _settings, context) =>
			Boolean(context.includeReasoningPrefill) && draftValue !== savedValue,
	},
	{
		section: "core",
		key: "supportsPrefill",
		inputKey: "supportsPrefill",
		defaultValue: false,
		format: (settings, context) => inferenceDefaultsForSettings(settings, context.inherited).supportsPrefill,
		parse: (value, draft, context) => value === inferenceDefaultsForDraft(draft, context.inherited).supportsPrefill ? null : value,
		changed: (draftValue, savedValue) => draftValue !== savedValue,
	},
	{
		section: "core",
		key: "reasoningEffort",
		inputKey: "reasoningEffort",
		defaultValue: "default",
		format: (settings, context) => inferenceDefaultsForSettings(settings, context.inherited).reasoningEffort,
		parse: (value, draft, context) =>
			value === inferenceDefaultsForDraft(draft, context.inherited).reasoningEffort ? null : nullableReasoningEffortInput(value),
		changed: (draftValue, savedValue) => draftValue !== savedValue,
	},
	{
		section: "core",
		key: "toolCalls",
		inputKey: "toolCalls",
		defaultValue: "railroad",
		format: (settings, context) => inferenceDefaultsForSettings(settings, context.inherited).toolCalls,
		parse: (value, draft, context) =>
			value === inferenceDefaultsForDraft(draft, context.inherited).toolCalls ? null : nullableToolCallsInput(value),
		changed: (draftValue, savedValue) => draftValue !== savedValue,
	},
	{
		section: "core",
		key: "providerRouting",
		inputKey: "providerRouting",
		defaultValue: "",
		format: (settings) => providerRoutingDraftValue(settings.providerRouting),
		parse: (value) => providerRoutingInputFromDraft(value),
		changed: (draftValue, _savedValue, settings) => providerRoutingDraftChanged(draftValue, settings.providerRouting),
	},
	...inferenceNumberFieldDescriptors([
		["temperature", "temperature"],
		["topK", "topK"],
		["topP", "topP"],
		["minP", "minP"],
		["frequencyPenalty", "frequencyPenalty"],
		["presencePenalty", "presencePenalty"],
		["repetitionPenalty", "repetitionPenalty"],
	]),
] satisfies readonly InferenceFieldDescriptor[];

function inferenceNumberFieldDescriptors(
	fields: readonly (readonly [
		keyof Pick<InferenceDraft, "temperature" | "topK" | "topP" | "minP" | "frequencyPenalty" | "presencePenalty" | "repetitionPenalty">,
		keyof Pick<BotInferenceSettingsInput, "temperature" | "topK" | "topP" | "minP" | "frequencyPenalty" | "presencePenalty" | "repetitionPenalty">,
	])[],
): InferenceFieldDescriptor[] {
	return fields.map(([key, inputKey]) => ({
		section: "sampling" as const,
		key,
		inputKey,
		defaultValue: "",
		format: (settings: BotInferenceSettings) => numericDraftValue(settings[inputKey]),
		parse: (value: string, _draft: InferenceDraft, context: InferenceDescriptorContext) =>
			nullableNumberInputMatchingInherited(value, context.inherited?.[inputKey]),
		changed: (draftValue: string, savedValue: string) => draftValue.trim() !== savedValue,
	})) as InferenceFieldDescriptor[];
}

function descriptorsInSection(section: InferenceFieldDescriptor["section"]): InferenceFieldDescriptor[] {
	return inferenceFieldDescriptors.filter((descriptor) => descriptor.section === section);
}

function inputDescriptors(context: InferenceDescriptorContext, section: InferenceFieldDescriptor["section"]): InferenceFieldDescriptor[] {
	return descriptorsInSection(section).filter((descriptor) =>
		context.includeReasoningPrefill || (descriptor.key !== "recurringPrompt" && descriptor.key !== "recurringPromptEnabled")
	);
}

export function inferenceDraftFromSettings(
	settings: BotInferenceSettings,
	inherited?: InferenceModelUnlockContext,
): InferenceDraft {
	const context = inferenceContext(inherited);
	return {
		openRouterApiKey: "",
		clearOpenRouterApiKey: false,
		openRouterApiKeySet: Boolean(settings.openRouterApiKeySet),
		...draftFromFieldDescriptors(descriptorsInSection("core"), settings, context),
		...translationDraftFromSettings(settings, inherited),
		...imageGenerationDraftFromSettings(settings),
		...draftFromFieldDescriptors(descriptorsInSection("sampling"), settings, context),
	} as InferenceDraft;
}

export function inferenceDraftChanged(
	draft: InferenceDraft,
	settings: BotInferenceSettings,
	options: InferenceDraftOptions & { inherited?: InferenceModelUnlockContext } = {},
): boolean {
	const context = inferenceContext(options.inherited, options);
	const normalizedDraft = normalizeInferenceDraftForCapabilities(draft, options.inherited);
	return (
		Boolean(normalizedDraft.openRouterApiKey.trim()) ||
		normalizedDraft.clearOpenRouterApiKey ||
		draftChangedByFieldDescriptors(inferenceFieldDescriptors, normalizedDraft, settings, context) ||
		(Boolean(options.includeImageGeneration) && imageGenerationDraftChanged(normalizedDraft, settings)) ||
		(Boolean(options.includeTranslation) && translationDraftChanged(normalizedDraft, settings, options.inherited))
	);
}

export function inferenceInputFromDraft(
	draft: InferenceDraft,
	inherited?: InferenceModelUnlockContext,
	options: InferenceDraftOptions = {},
	language: LanguageTag | null = defaultSettingsDraftLanguage,
): BotInferenceSettingsInput {
	const normalized = normalizeInferenceDraftForCapabilities(draft, inherited);
	const context = inferenceContext(inherited, options, language);
	return {
		...(normalized.openRouterApiKey.trim() ? { openRouterApiKey: normalized.openRouterApiKey.trim() }
		: normalized.clearOpenRouterApiKey ? { openRouterApiKey: null }
		: {}),
		...inputFromFieldDescriptors(inputDescriptors(context, "core"), normalized, context),
		...(options.includeImageGeneration ? { imageGeneration: imageGenerationInputFromDraft(normalized, undefined, language) } : {}),
		...(options.includeTranslation ? { translation: translationInputFromDraft(normalized, inherited, language) } : {}),
		...inputFromFieldDescriptors(inputDescriptors(context, "sampling"), normalized, context),
	};
}

export function promptFillSettingsInputFromDraft(draft: InferenceDraft): BotInferenceSettingsInput {
	const normalized = normalizeInferenceDraftForCapabilities(draft);
	return {
		baseUrl: nullableTextInput(normalized.baseUrl),
		model: nullableTextInput(normalized.model),
		reasoningEffort: nullableReasoningEffortInput(normalized.reasoningEffort),
		providerRouting: providerRoutingInputFromDraft(normalized.providerRouting),
		temperature: nullableNumberInput(normalized.temperature),
		topK: nullableNumberInput(normalized.topK),
		topP: nullableNumberInput(normalized.topP),
		minP: nullableNumberInput(normalized.minP),
		frequencyPenalty: nullableNumberInput(normalized.frequencyPenalty),
		presencePenalty: nullableNumberInput(normalized.presencePenalty),
		repetitionPenalty: nullableNumberInput(normalized.repetitionPenalty),
	};
}

function nullableReasoningEffortInput(value: string): BotInferenceSettings["reasoningEffort"] | null {
	return value && value !== "default" ? value as BotInferenceSettings["reasoningEffort"] : null;
}

function nullableToolCallsInput(value: string): BotInferenceSettings["toolCalls"] | null {
	return value ? value as BotInferenceSettings["toolCalls"] : null;
}

function nullablePromptCacheModeInput(value: BotPromptCacheMode): BotInferenceSettings["promptCacheMode"] | null {
	return value === "off" ? null : value;
}

export { inferenceFieldDescriptors };
export type { InferenceDraft, InferenceModelUnlockContext } from "./types";
