import type {
	BotImageGenerationSettings,
	BotImageGenerationSettingsInput,
	BotInferenceReasoningEffort,
	BotInferenceSettings,
	BotInferenceSettingsInput,
	BotTranslationSettings,
	BotTranslationSettingsInput,
	JsonObject,
} from "./model";
import type {
	InferenceConfigurationOverrides,
	InferenceConfigurationOverridePatch,
	InferenceConfigurationField,
	InferenceReasoningRequest,
	StoredInferenceOverride,
} from "./inference-configuration";

export type LegacyInferenceCompatibilityFieldMask = {
	fields: InferenceConfigurationField[];
	translationFields: InferenceConfigurationField[];
	credential: boolean;
};

/**
 * Version-1 compatibility adapter. It preserves only provable raw intent and
 * deliberately excludes prompt/toggle/bot-loop fields owned by documents.
 */
export function inferenceOverridesFromLegacySettings(
	settings: Partial<BotInferenceSettings> | BotInferenceSettingsInput | null | undefined,
): InferenceConfigurationOverrides {
	if (!settings) return {};
	return {
		...(settings.baseUrl != null ? { baseUrl: value(settings.baseUrl) } : {}),
		...(settings.model != null ? { model: value(settings.model) } : {}),
		...(settings.providerRouting != null ? { providerRouting: legacyTextProviderRouting(settings.providerRouting) } : {}),
		...(settings.reasoningEffort != null ? { reasoning: value(legacyReasoning(settings.reasoningEffort)) } : {}),
		...(settings.toolCalls != null ? { toolCalls: value({ kind: "strategy" as const, strategy: settings.toolCalls }) } : {}),
		...(settings.compactionMode != null ? { compactionMode: value({ kind: "mode" as const, mode: settings.compactionMode }) } : {}),
		...(settings.promptCacheMode != null ? { promptCacheMode: value({ kind: "mode" as const, mode: settings.promptCacheMode }) } : {}),
		...(settings.supportsPrefill != null ? { supportsPrefill: value(settings.supportsPrefill) } : {}),
		...(settings.temperature != null ? { temperature: value(settings.temperature) } : {}),
		...(settings.topK != null ? { topK: value(settings.topK) } : {}),
		...(settings.topP != null ? { topP: value(settings.topP) } : {}),
		...(settings.minP != null ? { minP: value(settings.minP) } : {}),
		...(settings.frequencyPenalty != null ? { frequencyPenalty: value(settings.frequencyPenalty) } : {}),
		...(settings.presencePenalty != null ? { presencePenalty: value(settings.presencePenalty) } : {}),
		...(settings.repetitionPenalty != null ? { repetitionPenalty: value(settings.repetitionPenalty) } : {}),
		...inferenceOverridesFromLegacyImageSettings(settings.imageGeneration),
	};
}

export function inferenceOverridesFromLegacyTranslationSettings(
	translation: BotTranslationSettings,
): InferenceConfigurationOverrides {
	if (!translation.model?.trim()) return {};
	return {
		model: { kind: "value", value: translation.model.trim() },
		reasoning: { kind: "value", value: translation.reasoningEffort === undefined || translation.reasoningEffort === "default"
			? { kind: "bickr_automatic" }
			: translation.reasoningEffort === "none"
				? { kind: "reasoning_disabled" }
				: { kind: "explicit_effort", effort: translation.reasoningEffort } },
		toolCalls: { kind: "value", value: translation.toolCalls
			? { kind: "strategy", strategy: translation.toolCalls }
			: { kind: "bickr_automatic" } },
		temperature: { kind: "value", value: translation.temperature ?? 0 },
		providerRouting: legacyTextProviderRouting(translation.providerRouting),
		topK: translation.topK === undefined ? { kind: "explicit_none" } : { kind: "value", value: translation.topK },
		topP: translation.topP === undefined ? { kind: "explicit_none" } : { kind: "value", value: translation.topP },
		minP: translation.minP === undefined ? { kind: "explicit_none" } : { kind: "value", value: translation.minP },
		frequencyPenalty: translation.frequencyPenalty === undefined ? { kind: "explicit_none" } : { kind: "value", value: translation.frequencyPenalty },
		presencePenalty: translation.presencePenalty === undefined ? { kind: "explicit_none" } : { kind: "value", value: translation.presencePenalty },
		repetitionPenalty: translation.repetitionPenalty === undefined ? { kind: "explicit_none" } : { kind: "value", value: translation.repetitionPenalty },
	};
}

export function inferenceOverridesFromLegacyImageSettings(
	settings: Partial<BotImageGenerationSettings> | BotImageGenerationSettingsInput | null | undefined,
): InferenceConfigurationOverrides {
	if (!settings) return {};
	return {
		...(settings.model != null ? { imageModel: value(settings.model) } : {}),
		...(settings.providerRouting != null ? { imageProviderRouting: value(settings.providerRouting) } : {}),
		...(settings.aspectRatio != null ? { imageAspectRatio: value(settings.aspectRatio) } : {}),
		...(settings.imageSize != null ? { imageSize: value(settings.imageSize) } : {}),
		...(settings.temperature != null ? { imageTemperature: value(settings.temperature) } : {}),
		...(settings.topK != null ? { imageTopK: value(settings.topK) } : {}),
		...(settings.topP != null ? { imageTopP: value(settings.topP) } : {}),
		...(settings.minP != null ? { imageMinP: value(settings.minP) } : {}),
		...(settings.frequencyPenalty != null ? { imageFrequencyPenalty: value(settings.frequencyPenalty) } : {}),
		...(settings.presencePenalty != null ? { imagePresencePenalty: value(settings.presencePenalty) } : {}),
		...(settings.repetitionPenalty != null ? { imageRepetitionPenalty: value(settings.repetitionPenalty) } : {}),
	};
}

const legacyLoopAndImageFields = [
	"baseUrl", "model", "providerRouting", "reasoning", "toolCalls", "compactionMode",
	"promptCacheMode", "supportsPrefill", "temperature", "topK", "topP", "minP",
	"frequencyPenalty", "presencePenalty", "repetitionPenalty", "imageModel",
	"imageProviderRouting", "imageAspectRatio", "imageSize", "imageTemperature",
	"imageTopK", "imageTopP", "imageMinP", "imageFrequencyPenalty",
	"imagePresencePenalty", "imageRepetitionPenalty",
] as const satisfies readonly InferenceConfigurationField[];

const legacyImageFields = [
	"imageModel", "imageProviderRouting", "imageAspectRatio", "imageSize",
	"imageTemperature", "imageTopK", "imageTopP", "imageMinP",
	"imageFrequencyPenalty", "imagePresencePenalty", "imageRepetitionPenalty",
] as const satisfies readonly InferenceConfigurationField[];

const legacyTranslationFields = [
	"model", "reasoning", "toolCalls", "temperature", "providerRouting", "topK",
	"topP", "minP", "frequencyPenalty", "presencePenalty", "repetitionPenalty",
] as const satisfies readonly InferenceConfigurationField[];

const legacyInferenceFieldSet = new Set<InferenceConfigurationField>(legacyLoopAndImageFields);
const legacyTranslationFieldSet = new Set<InferenceConfigurationField>(legacyTranslationFields);

/**
 * Captures reusable fields explicitly present in a legacy request before its
 * entity writer merges that request into the stored document. The mask is
 * secret-free and can therefore be persisted in convergence state so a retry
 * reloads current values without treating unrelated merged fields as intent.
 */
export function legacyInferenceCompatibilityFieldMask(
	settings: BotInferenceSettingsInput,
): LegacyInferenceCompatibilityFieldMask {
	const fields = new Set<InferenceConfigurationField>();
	addPresentTopLevelFields(fields, settings);
	if (hasOwn(settings, "imageGeneration")) {
		addPresentImageFields(fields, settings.imageGeneration);
	}
	const translationFields = new Set<InferenceConfigurationField>();
	if (hasOwn(settings, "translation")) {
		addPresentTranslationFields(translationFields, settings.translation);
	}
	return orderedLegacyFieldMask(fields, translationFields, hasOwn(settings, "openRouterApiKey"));
}

export function legacyImageCompatibilityFieldMask(
	settings: BotImageGenerationSettingsInput | null,
): LegacyInferenceCompatibilityFieldMask {
	const fields = new Set<InferenceConfigurationField>();
	addPresentImageFields(fields, settings);
	return orderedLegacyFieldMask(fields, new Set(), false);
}

export function parseLegacyInferenceCompatibilityFieldMask(
	value: unknown,
): LegacyInferenceCompatibilityFieldMask {
	if (!isRecord(value) || Object.keys(value).some((key) =>
		key !== "fields" && key !== "translationFields" && key !== "credential") ||
		!Array.isArray(value.fields) || !Array.isArray(value.translationFields) || typeof value.credential !== "boolean") {
		throw new Error("Stored inference compatibility field mask is invalid.");
	}
	const fields = value.fields;
	const translationFields = value.translationFields;
	if (fields.some((field) => typeof field !== "string" || !legacyInferenceFieldSet.has(field as InferenceConfigurationField)) ||
		new Set(fields).size !== fields.length ||
		translationFields.some((field) => typeof field !== "string" || !legacyTranslationFieldSet.has(field as InferenceConfigurationField)) ||
		new Set(translationFields).size !== translationFields.length) {
		throw new Error("Stored inference compatibility field mask is invalid.");
	}
	return orderedLegacyFieldMask(
		new Set(fields as InferenceConfigurationField[]),
		new Set(translationFields as InferenceConfigurationField[]),
		value.credential,
	);
}

export function legacyInferenceCompatibilityFieldMaskIsEmpty(
	mask: LegacyInferenceCompatibilityFieldMask,
): boolean {
	return mask.fields.length === 0 && mask.translationFields.length === 0 && !mask.credential;
}

/**
 * Whole legacy documents replace only fields that the legacy writer can
 * represent. Graph-only fields such as compactionReasoning survive unchanged.
 */
export function inferenceOverridePatchFromLegacySettings(
	settings: Partial<BotInferenceSettings> | BotInferenceSettingsInput | null | undefined,
): InferenceConfigurationOverridePatch {
	return replacementPatch(legacyLoopAndImageFields, inferenceOverridesFromLegacySettings(settings));
}

export function inferenceOverridePatchFromLegacySettingsMask(
	settings: Partial<BotInferenceSettings> | BotInferenceSettingsInput | null | undefined,
	mask: LegacyInferenceCompatibilityFieldMask,
): InferenceConfigurationOverridePatch {
	return replacementPatch(mask.fields, inferenceOverridesFromLegacySettings(settings));
}

/**
 * A linked clone's provider bundle was model-gated as one unit: a local model
 * stopped the clone from consulting its source for base URL and credential, and
 * clearing that model made the whole local bundle dormant again. A legacy
 * request that carries the model field therefore states intent for the whole
 * bundle even when it names neither URL nor key, so both barriers must move
 * with it. Requests that leave the model field out say nothing about the
 * bundle and must not disturb either barrier.
 */
export function legacyModelCouplesLinkedCloneProvider(
	mask: LegacyInferenceCompatibilityFieldMask,
	context: { linkedClone: boolean },
): boolean {
	return context.linkedClone && mask.fields.includes("model");
}

/**
 * Participant variant of the masked patch. Under the coupling above an active
 * local model means "explicit local URL, else resume at Account default" rather
 * than "continue through the source", and a cleared model returns the field to
 * the source path the dormant clone read again. This mirrors the credential
 * intent the same write stores and the barrier the migration applies to the
 * whole local bundle.
 */
export function inferenceOverridePatchFromLegacyBotSettingsMask(
	settings: Partial<BotInferenceSettings> | BotInferenceSettingsInput | null | undefined,
	mask: LegacyInferenceCompatibilityFieldMask,
	context: { linkedClone: boolean },
): InferenceConfigurationOverridePatch {
	const patch = inferenceOverridePatchFromLegacySettingsMask(settings, mask);
	if (!legacyModelCouplesLinkedCloneProvider(mask, context)) return patch;
	if (!settings?.model?.trim()) return { ...patch, baseUrl: { kind: "inherit" } };
	return settings.baseUrl?.trim()
		? { ...patch, baseUrl: { kind: "value", value: settings.baseUrl } }
		: { ...patch, baseUrl: { kind: "account_default" } };
}

export function inferenceOverridePatchFromLegacyImageSettings(
	settings: Partial<BotImageGenerationSettings> | BotImageGenerationSettingsInput | null | undefined,
): InferenceConfigurationOverridePatch {
	return replacementPatch(legacyImageFields, inferenceOverridesFromLegacyImageSettings(settings));
}

export function inferenceOverridePatchFromLegacyImageSettingsMask(
	settings: Partial<BotImageGenerationSettings> | BotImageGenerationSettingsInput | null | undefined,
	mask: LegacyInferenceCompatibilityFieldMask,
): InferenceConfigurationOverridePatch {
	return replacementPatch(mask.fields, inferenceOverridesFromLegacyImageSettings(settings));
}

export function inferenceOverridePatchFromLegacyTranslationSettings(
	translation: BotTranslationSettings,
): InferenceConfigurationOverridePatch {
	return replacementPatch(legacyTranslationFields, inferenceOverridesFromLegacyTranslationSettings(translation));
}

export function inferenceOverridePatchFromLegacyTranslationSettingsMask(
	translation: BotTranslationSettings,
	mask: LegacyInferenceCompatibilityFieldMask,
): InferenceConfigurationOverridePatch {
	return replacementPatch(mask.translationFields, inferenceOverridesFromLegacyTranslationSettings(translation));
}

function replacementPatch(
	fields: readonly InferenceConfigurationField[],
	overrides: InferenceConfigurationOverrides,
): InferenceConfigurationOverridePatch {
	const patch: Record<string, unknown> = {};
	for (const field of fields) patch[field] = { kind: "inherit" };
	for (const [field, override] of Object.entries(overrides)) patch[field] = override;
	return patch as InferenceConfigurationOverridePatch;
}

function addPresentTopLevelFields(
	fields: Set<InferenceConfigurationField>,
	settings: BotInferenceSettingsInput,
): void {
	const mappings = [
		["baseUrl", "baseUrl"],
		["model", "model"],
		["providerRouting", "providerRouting"],
		["reasoningEffort", "reasoning"],
		["toolCalls", "toolCalls"],
		["compactionMode", "compactionMode"],
		["promptCacheMode", "promptCacheMode"],
		["supportsPrefill", "supportsPrefill"],
		["temperature", "temperature"],
		["topK", "topK"],
		["topP", "topP"],
		["minP", "minP"],
		["frequencyPenalty", "frequencyPenalty"],
		["presencePenalty", "presencePenalty"],
		["repetitionPenalty", "repetitionPenalty"],
	] as const satisfies readonly (readonly [keyof BotInferenceSettingsInput, InferenceConfigurationField])[];
	for (const [legacyField, graphField] of mappings) {
		if (hasOwn(settings, legacyField)) fields.add(graphField);
	}
}

function addPresentImageFields(
	fields: Set<InferenceConfigurationField>,
	settings: BotImageGenerationSettingsInput | null | undefined,
): void {
	const mappings = [
		["model", "imageModel"],
		["providerRouting", "imageProviderRouting"],
		["aspectRatio", "imageAspectRatio"],
		["imageSize", "imageSize"],
		["temperature", "imageTemperature"],
		["topK", "imageTopK"],
		["topP", "imageTopP"],
		["minP", "imageMinP"],
		["frequencyPenalty", "imageFrequencyPenalty"],
		["presencePenalty", "imagePresencePenalty"],
		["repetitionPenalty", "imageRepetitionPenalty"],
	] as const satisfies readonly (readonly [keyof BotImageGenerationSettingsInput, InferenceConfigurationField])[];
	if (settings === null) {
		for (const [, graphField] of mappings) fields.add(graphField);
		return;
	}
	if (!settings) return;
	for (const [legacyField, graphField] of mappings) {
		if (hasOwn(settings, legacyField)) fields.add(graphField);
	}
}

function addPresentTranslationFields(
	fields: Set<InferenceConfigurationField>,
	settings: BotTranslationSettingsInput | null | undefined,
): void {
	const mappings = [
		["model", "model"],
		["providerRouting", "providerRouting"],
		["reasoningEffort", "reasoning"],
		["toolCalls", "toolCalls"],
		["temperature", "temperature"],
		["topK", "topK"],
		["topP", "topP"],
		["minP", "minP"],
		["frequencyPenalty", "frequencyPenalty"],
		["presencePenalty", "presencePenalty"],
		["repetitionPenalty", "repetitionPenalty"],
	] as const satisfies readonly (readonly [keyof BotTranslationSettingsInput, InferenceConfigurationField])[];
	if (settings === null) {
		for (const [, graphField] of mappings) fields.add(graphField);
		return;
	}
	if (!settings) return;
	for (const [legacyField, graphField] of mappings) {
		if (hasOwn(settings, legacyField)) fields.add(graphField);
	}
}

function orderedLegacyFieldMask(
	fields: Set<InferenceConfigurationField>,
	translationFields: Set<InferenceConfigurationField>,
	credential: boolean,
): LegacyInferenceCompatibilityFieldMask {
	return {
		fields: legacyLoopAndImageFields.filter((field) => fields.has(field)),
		translationFields: legacyTranslationFields.filter((field) => translationFields.has(field)),
		credential,
	};
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function legacyReasoning(reasoning: BotInferenceReasoningEffort): InferenceReasoningRequest {
	switch (reasoning) {
		case "default": return { kind: "bickr_automatic" };
		case "none": return { kind: "reasoning_disabled" };
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return { kind: "explicit_effort", effort: reasoning };
	}
}

function legacyTextProviderRouting(
	providerRouting: JsonObject | undefined,
): StoredInferenceOverride<"providerRouting"> {
	return providerRouting === undefined || Object.keys(providerRouting).length === 0
		? { kind: "explicit_none" }
		: value(providerRouting);
}

function value<T>(input: T): { kind: "value"; value: T } {
	return { kind: "value", value: input };
}
