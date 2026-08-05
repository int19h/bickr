import type { BotInferenceSettings } from "@bickr/shared/model";
import { resolveBotProviderSettings } from "@bickr/shared/inference-settings";
import type { InferenceModelUnlockContext } from "./types";

/**
 * Legacy stored-settings model display. Reusable inference is edited through
 * the inference library; this only reports what a stored public payload says,
 * for surfaces that still show a participant's last known model.
 */
export function effectiveInferenceSettingsModel(
	settings: BotInferenceSettings,
	inherited?: InferenceModelUnlockContext | null,
): string {
	return resolveBotProviderSettings(
		{ inferenceSettings: settings },
		{ inferenceSettings: inferenceSettingsFromUnlockContext(inherited) },
		{},
		// Public bot payloads intentionally omit the owner's provider credential.
		// When that private inheritance context is unavailable, the stored model has
		// already passed write-time access enforcement and remains authoritative.
		{ assumeBotProviderAvailable: inherited == null },
	).settings.model;
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

export function numericDraftValue(value: number | undefined): string {
	return value === undefined ? "" : String(value);
}
