import {
	localizedText,
	localizedTextString,
	type BotInferenceSettings,
	type JsonObject,
	type LanguageTag,
} from "@bickr/shared/model";
import {
	isOpenRouterProviderBaseUrl,
	resolveBotProviderSettings,
} from "@bickr/shared/inference-settings";
import {
	modelSupportsPrefill,
	modelSupportsPromptCacheControl,
	modelSupportsReasoningNone,
	modelSupportsRequiredToolCalls,
	modelSupportsStructuredCompaction,
} from "@bickr/shared/openrouter-model-capabilities";
import { maxProviderRoutingJsonLength } from "@bickr/shared/validation";
import type { InferenceDraft, InferenceModelUnlockContext } from "./types";

export const defaultSettingsDraftLanguage = "en" as LanguageTag;

export type InferenceCapabilityContext = {
	model: string;
	baseUrl: string;
	openRouter: boolean;
	supportsPrefill: boolean;
	supportsPromptCacheControl: boolean;
	supportsReasoningNone: boolean;
	supportsRequiredToolCalls: boolean;
	supportsStructuredCompaction: boolean;
};

export function inferenceCapabilityContextForDraft(
	draft: InferenceDraft,
	inherited?: BotInferenceSettings | null,
): InferenceCapabilityContext {
	const fallback = inferenceFallbackContextForDraft(draft, inherited);
	const baseUrl = effectiveInferenceDraftBaseUrl(draft, fallback);
	const model = effectiveInferenceDraftModel(draft, fallback);
	const providerRouting = effectiveInferenceDraftProviderRouting(draft, fallback);
	return inferenceCapabilityContext(model, baseUrl, providerRouting);
}

export function inferenceCapabilityContext(
	model: string,
	baseUrl: string,
	providerRouting?: JsonObject,
): InferenceCapabilityContext {
	const openRouter = isOpenRouterProviderBaseUrl(baseUrl);
	return {
		model,
		baseUrl,
		openRouter,
		supportsPrefill: modelSupportsPrefill(model, openRouter, providerRouting),
		supportsPromptCacheControl: modelSupportsPromptCacheControl(model, openRouter),
		supportsReasoningNone: modelSupportsReasoningNone(model, openRouter, providerRouting),
		supportsRequiredToolCalls: modelSupportsRequiredToolCalls(model, openRouter, providerRouting),
		supportsStructuredCompaction: modelSupportsStructuredCompaction(model, openRouter, providerRouting),
	};
}

export { isOpenRouterProviderBaseUrl };

export function effectiveInferenceDraftModel(
	draft: InferenceDraft,
	inherited?: InferenceModelUnlockContext | null,
): string {
	return resolveBotProviderSettings(
		{ inferenceSettings: inferenceSettingsFromDraftConnection(draft) },
		{ inferenceSettings: inferenceSettingsFromUnlockContext(inherited) },
	).settings.model;
}

export function effectiveInferenceSettingsModel(
	settings: BotInferenceSettings,
	inherited?: InferenceModelUnlockContext | null,
): string {
	return resolveBotProviderSettings(
		{ inferenceSettings: settings },
		{ inferenceSettings: inferenceSettingsFromUnlockContext(inherited) },
	).settings.model;
}

export function effectiveInferenceDraftBaseUrl(
	draft: InferenceDraft,
	inherited?: InferenceModelUnlockContext | null,
): string {
	return resolveBotProviderSettings(
		{ inferenceSettings: inferenceSettingsFromDraftConnection(draft) },
		{ inferenceSettings: inferenceSettingsFromUnlockContext(inherited) },
	).settings.baseUrl;
}

export function effectiveInferenceSettingsBaseUrl(
	settings: BotInferenceSettings,
	inherited?: InferenceModelUnlockContext | null,
): string {
	return resolveBotProviderSettings(
		{ inferenceSettings: settings },
		{ inferenceSettings: inferenceSettingsFromUnlockContext(inherited) },
	).settings.baseUrl;
}

function inferenceSettingsFromDraftConnection(draft: InferenceDraft): BotInferenceSettings {
	return {
		...(!draft.clearOpenRouterApiKey && draft.openRouterApiKey.trim() ? { openRouterApiKey: draft.openRouterApiKey.trim() } : {}),
		...(!draft.clearOpenRouterApiKey && draft.openRouterApiKeySet ? { openRouterApiKeySet: true } : {}),
		...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
		...(draft.model.trim() ? { model: draft.model.trim() } : {}),
	};
}

function inferenceSettingsFromUnlockContext(
	inherited?: InferenceModelUnlockContext | null,
): BotInferenceSettings | undefined {
	if (!inherited) {
		return undefined;
	}
	const { apiKeySet, ...settings } = inherited;
	return {
		...settings,
		...(apiKeySet || settings.openRouterApiKeySet ? { openRouterApiKeySet: true } : {}),
	};
}

export function effectiveInferenceDraftProviderRouting(
	draft: Pick<InferenceDraft, "providerRouting">,
	inherited?: InferenceModelUnlockContext | null,
): JsonObject | undefined {
	try {
		return providerRoutingInputFromDraft(draft.providerRouting) ?? inherited?.providerRouting;
	} catch {
		return inherited?.providerRouting;
	}
}

export function effectiveInferenceSettingsProviderRouting(
	settings: BotInferenceSettings,
	inherited?: InferenceModelUnlockContext | null,
): JsonObject | undefined {
	return settings.providerRouting ?? inherited?.providerRouting;
}

export function inferenceInheritanceContext(
	settings?: BotInferenceSettings | null,
): InferenceModelUnlockContext | undefined {
	if (!settings) {
		return undefined;
	}
	return {
		...settings,
		apiKeySet: Boolean(settings.openRouterApiKeySet),
	};
}

export function inferenceFallbackContextForSettings(
	settings: Pick<BotInferenceSettings, "model">,
	inherited?: BotInferenceSettings | null,
): InferenceModelUnlockContext | undefined {
	return settings.model?.trim() ? providerConnectionInheritanceContext(inherited) : inferenceInheritanceContext(inherited);
}

export function inferenceFallbackContextForDraft(
	draft: Pick<InferenceDraft, "model">,
	inherited?: BotInferenceSettings | null,
): InferenceModelUnlockContext | undefined {
	return draft.model.trim() ? providerConnectionInheritanceContext(inherited) : inferenceInheritanceContext(inherited);
}

export function providerConnectionInheritanceContext(
	settings?: BotInferenceSettings | null,
): InferenceModelUnlockContext | undefined {
	if (!settings) {
		return undefined;
	}
	return {
		apiKeySet: Boolean(settings.openRouterApiKeySet),
		openRouterApiKey: settings.openRouterApiKey,
		openRouterApiKeySet: settings.openRouterApiKeySet,
		baseUrl: settings.baseUrl,
	};
}

export function textValue(value: Parameters<typeof localizedTextString>[0]): string {
	return localizedTextString(value);
}

export function localizedOptionalDraft(text: string, language: LanguageTag | null) {
	return text.trim() ? localizedText(text, language) : null;
}

export function numericDraftValue(value: number | undefined): string {
	return value === undefined ? "" : String(value);
}

export function nullableTextInput(value: string): string | null {
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

export function nullableTextInputMatchingInherited(value: string, inherited: string | undefined): string | null {
	const trimmed = value.trim();
	const inheritedTrimmed = inherited?.trim();
	if (!trimmed || (inheritedTrimmed && trimmed === inheritedTrimmed)) {
		return null;
	}
	return trimmed;
}

export function nullableNumberInput(value: string): number | null {
	const trimmed = value.trim();
	return trimmed ? Number(trimmed) : null;
}

export function nullableNumberInputMatchingInherited(value: string, inherited: number | undefined): number | null {
	const parsed = nullableNumberInput(value);
	return parsed !== null && inherited !== undefined && parsed === inherited ? null : parsed;
}

export function providerRoutingDraftValue(value: JsonObject | undefined): string {
	return value === undefined ? "" : JSON.stringify(value, null, 2);
}

export function providerRoutingDraftError(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}
	if (trimmed.length > maxProviderRoutingJsonLength) {
		return `Provider routing must be ${maxProviderRoutingJsonLength} characters or fewer.`;
	}
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return "Provider routing must be a JSON object.";
		}
		const encoded = JSON.stringify(parsed);
		if (encoded.length > maxProviderRoutingJsonLength) {
			return `Provider routing must be ${maxProviderRoutingJsonLength} characters or fewer.`;
		}
		return "";
	} catch {
		return "Provider routing must be valid JSON.";
	}
}

export function providerRoutingInputFromDraft(value: string): JsonObject | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	if (trimmed.length > maxProviderRoutingJsonLength) {
		throw new Error(`Provider routing must be ${maxProviderRoutingJsonLength} characters or fewer.`);
	}
	const parsed = JSON.parse(trimmed) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Provider routing must be a JSON object.");
	}
	const encoded = JSON.stringify(parsed);
	if (encoded.length > maxProviderRoutingJsonLength) {
		throw new Error(`Provider routing must be ${maxProviderRoutingJsonLength} characters or fewer.`);
	}
	return parsed as JsonObject;
}

export function providerRoutingDraftChanged(draftValue: string, settingsValue: JsonObject | undefined): boolean {
	try {
		const draftRouting = providerRoutingInputFromDraft(draftValue);
		if (draftRouting === null) {
			return settingsValue !== undefined;
		}
		return settingsValue === undefined || canonicalJsonString(draftRouting) !== canonicalJsonString(settingsValue);
	} catch {
		return draftValue.trim() !== providerRoutingDraftValue(settingsValue).trim();
	}
}

export function providerRoutingDraftFingerprintValue(value: string, inherited?: JsonObject): string | null {
	try {
		const routing = providerRoutingInputFromDraft(value);
		return routing === null ? (inherited ? canonicalJsonString(inherited) : null) : canonicalJsonString(routing);
	} catch {
		return value.trim();
	}
}

function canonicalJsonString(value: JsonObject): string {
	return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalJsonValue);
	}
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalJsonValue(object[key])]));
	}
	return value;
}
