import {
	effectiveCompactionModeForModel,
	effectiveReasoningEffortForModel,
	effectiveSupportsPrefillForModel,
	effectiveToolCallsForModel,
	modelSupportsPromptCacheControl,
} from "./openrouter-model-capabilities";
import {
	defaultProviderModel,
	defaultTextGenerationTemperature,
	legacyDefaultTextGenerationTemperature,
	type BotCompactionMode,
	type BotDocument,
	type BotInferenceReasoningEffort,
	type BotInferenceSettings,
	type BotInferenceToolCalls,
	type BotPromptCacheMode,
	type JsonObject,
	type UserDocument,
} from "./model";

export const defaultProviderBaseUrl = "https://openrouter.ai/api/v1";

export type ProviderEnvironmentSettings = {
	OPENROUTER_API_KEY?: string;
	OPENROUTER_BASE_URL?: string;
	OPENROUTER_MODEL?: string;
};

export type ProviderSettings = {
	apiKey?: string;
	baseUrl: string;
	model: string;
	compactionMode?: BotCompactionMode;
	promptCacheMode?: BotPromptCacheMode;
	providerRouting?: JsonObject;
	reasoningEffort?: Exclude<BotInferenceReasoningEffort, "default">;
	supportsPrefill?: boolean;
	toolCalls?: BotInferenceToolCalls;
	temperature: number;
	usesCustomBaseUrl?: boolean;
	topK?: number;
	topP?: number;
	minP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
};

export type BotProviderSettingSource = "bot" | "source_bot" | "profile" | "bickr_default";

export type ResolvedBotProviderSetting<T> = {
	effective: T;
	source: BotProviderSettingSource;
};

export type ResolvedBotProviderSettings = {
	openRouterApiKeySet?: ResolvedBotProviderSetting<boolean>;
	baseUrl: ResolvedBotProviderSetting<string>;
	model: ResolvedBotProviderSetting<string>;
	compactionMode: ResolvedBotProviderSetting<BotCompactionMode>;
	promptCacheMode: ResolvedBotProviderSetting<BotPromptCacheMode>;
	providerRouting?: ResolvedBotProviderSetting<JsonObject>;
	reasoningEffort?: ResolvedBotProviderSetting<Exclude<BotInferenceReasoningEffort, "default">>;
	supportsPrefill: ResolvedBotProviderSetting<boolean>;
	toolCalls: ResolvedBotProviderSetting<BotInferenceToolCalls>;
	temperature: ResolvedBotProviderSetting<number>;
	topK?: ResolvedBotProviderSetting<number>;
	topP?: ResolvedBotProviderSetting<number>;
	minP?: ResolvedBotProviderSetting<number>;
	frequencyPenalty?: ResolvedBotProviderSetting<number>;
	presencePenalty?: ResolvedBotProviderSetting<number>;
	repetitionPenalty?: ResolvedBotProviderSetting<number>;
};

export type BotProviderSettingsResolution = {
	settings: ProviderSettings;
	resolved: ResolvedBotProviderSettings;
};

export function resolveBotProviderSettings(
	bot: Pick<BotDocument, "inferenceSettings">,
	owner: Pick<UserDocument, "inferenceSettings">,
	env: ProviderEnvironmentSettings = {},
	options: { botSource?: Extract<BotProviderSettingSource, "bot" | "source_bot"> } = {},
): BotProviderSettingsResolution {
	const botSource = options.botSource ?? "bot";
	const botSettings = bot.inferenceSettings;
	const profileSettings = owner.inferenceSettings ?? {};
	const envModel = trimmed(env.OPENROUTER_MODEL);
	const envBaseUrl = trimmed(env.OPENROUTER_BASE_URL);
	const envApiKey = trimmed(env.OPENROUTER_API_KEY);
	const profileModel = trimmed(profileSettings.model);
	const botModel = trimmed(botSettings.model);
	const profileBaseUrl = trimmed(profileSettings.baseUrl);
	const botBaseUrl = trimmed(botSettings.baseUrl);
	const profileApiKey = trimmed(profileSettings.openRouterApiKey);
	const botApiKey = trimmed(botSettings.openRouterApiKey);
	const profileApiKeySet = Boolean(profileApiKey || profileSettings.openRouterApiKeySet);
	const botApiKeySet = Boolean(botApiKey || botSettings.openRouterApiKeySet);
	const botTemperatureIsLegacyDefault = botSettings.temperature === legacyDefaultTextGenerationTemperature;
	const hasProfileProvider = profileApiKeySet || Boolean(profileBaseUrl);
	const hasBotOrInheritedProvider = botApiKeySet || Boolean(botBaseUrl) || hasProfileProvider;
	const hasCustomBaseUrl = Boolean(botBaseUrl || profileBaseUrl);
	const inheritedDefaults: BotInferenceSettings = botModel ? {} : profileSettings;

	const model =
		botModel && hasBotOrInheritedProvider ? resolvedSetting(botModel, botSource)
		: profileModel && hasProfileProvider ? resolvedSetting(profileModel, "profile")
		: resolvedSetting(envModel ?? defaultProviderModel, "bickr_default");
	const baseUrl =
		botBaseUrl ? resolvedSetting(botBaseUrl, botSource)
		: profileBaseUrl ? resolvedSetting(profileBaseUrl, "profile")
		: resolvedSetting(envBaseUrl ?? defaultProviderBaseUrl, "bickr_default");
	const credential =
		botApiKeySet ? resolvedSetting(true, botSource)
		: profileApiKeySet ? resolvedSetting(true, "profile")
		: !hasCustomBaseUrl && envApiKey ? resolvedSetting(true, "bickr_default")
		: undefined;
	const temperature =
		botSettings.temperature !== undefined && (!botTemperatureIsLegacyDefault || profileSettings.temperature === undefined) ?
			resolvedSetting(botSettings.temperature, botSource)
		: inheritedDefaults.temperature !== undefined ?
			resolvedSetting(inheritedDefaults.temperature, "profile")
		: botSettings.temperature !== undefined ?
			resolvedSetting(botSettings.temperature, botSource)
		: resolvedSetting(defaultTextGenerationTemperature, "bickr_default");
	const providerRoutingInput = selectedOptionalSetting(
		botSettings.providerRouting,
		inheritedDefaults.providerRouting,
		botSource,
	);
	const providerRoutingValue = openRouterProviderRouting(baseUrl.effective, providerRoutingInput?.effective);
	const providerRouting = providerRoutingValue && providerRoutingInput ?
		resolvedSetting(providerRoutingValue, providerRoutingInput.source)
	: undefined;
	const openRouter = isOpenRouterProviderBaseUrl(baseUrl.effective);
	const reasoningEffortInput = selectedOptionalSetting(
		botSettings.reasoningEffort,
		inheritedDefaults.reasoningEffort,
		botSource,
	);
	const reasoningEffortValue = effectiveReasoningEffortForModel(
		model.effective,
		openRouter,
		reasoningEffortInput?.effective,
		providerRouting?.effective,
	);
	const reasoningEffort = reasoningEffortValue ?
		resolvedSetting(reasoningEffortValue, reasoningEffortInput?.source ?? "bickr_default")
	: undefined;
	const toolCallsInput = selectedOptionalSetting(botSettings.toolCalls, inheritedDefaults.toolCalls, botSource);
	const toolCalls = resolvedSetting(
		effectiveToolCallsForModel(model.effective, openRouter, toolCallsInput?.effective, providerRouting?.effective),
		toolCallsInput?.source ?? "bickr_default",
	);
	const compactionModeInput = selectedOptionalSetting(
		botSettings.compactionMode,
		inheritedDefaults.compactionMode,
		botSource,
	);
	const compactionMode = resolvedSetting(
		effectiveCompactionModeForModel(model.effective, openRouter, compactionModeInput?.effective, providerRouting?.effective),
		compactionModeInput?.source ?? "bickr_default",
	);
	const promptCacheModeInput = selectedOptionalSetting(
		botSettings.promptCacheMode,
		inheritedDefaults.promptCacheMode,
		botSource,
	);
	const promptCacheMode = resolvedSetting(
		modelSupportsPromptCacheControl(model.effective, openRouter) ? promptCacheModeInput?.effective ?? "off" : "off",
		promptCacheModeInput?.source ?? "bickr_default",
	);
	const supportsPrefillInput = selectedOptionalSetting(
		botSettings.supportsPrefill,
		inheritedDefaults.supportsPrefill,
		botSource,
	);
	const supportsPrefill = resolvedSetting(
		effectiveSupportsPrefillForModel(model.effective, openRouter, supportsPrefillInput?.effective, providerRouting?.effective),
		supportsPrefillInput?.source ?? "bickr_default",
	);
	const topK = selectedOptionalSetting(botSettings.topK, inheritedDefaults.topK, botSource);
	const topP = selectedOptionalSetting(botSettings.topP, inheritedDefaults.topP, botSource);
	const minP = selectedOptionalSetting(botSettings.minP, inheritedDefaults.minP, botSource);
	const frequencyPenalty = selectedOptionalSetting(
		botSettings.frequencyPenalty,
		inheritedDefaults.frequencyPenalty,
		botSource,
	);
	const presencePenalty = selectedOptionalSetting(
		botSettings.presencePenalty,
		inheritedDefaults.presencePenalty,
		botSource,
	);
	const repetitionPenalty = selectedOptionalSetting(
		botSettings.repetitionPenalty,
		inheritedDefaults.repetitionPenalty,
		botSource,
	);

	return {
		settings: {
			apiKey: botApiKey ?? profileApiKey ?? (hasCustomBaseUrl ? undefined : envApiKey),
			baseUrl: baseUrl.effective,
			model: model.effective,
			compactionMode: compactionMode.effective,
			...(promptCacheMode.effective !== "off" ? { promptCacheMode: promptCacheMode.effective } : {}),
			...(providerRouting ? { providerRouting: providerRouting.effective } : {}),
			...(reasoningEffort ? { reasoningEffort: reasoningEffort.effective } : {}),
			supportsPrefill: supportsPrefill.effective,
			toolCalls: toolCalls.effective,
			temperature: temperature.effective,
			...(hasCustomBaseUrl ? { usesCustomBaseUrl: true } : {}),
			...(topK ? { topK: topK.effective } : {}),
			...(topP ? { topP: topP.effective } : {}),
			...(minP ? { minP: minP.effective } : {}),
			...(frequencyPenalty ? { frequencyPenalty: frequencyPenalty.effective } : {}),
			...(presencePenalty ? { presencePenalty: presencePenalty.effective } : {}),
			...(repetitionPenalty ? { repetitionPenalty: repetitionPenalty.effective } : {}),
		},
		resolved: {
			...(credential ? { openRouterApiKeySet: credential } : {}),
			baseUrl,
			model,
			compactionMode,
			promptCacheMode,
			...(providerRouting ? { providerRouting } : {}),
			...(reasoningEffort ? { reasoningEffort } : {}),
			supportsPrefill,
			toolCalls,
			temperature,
			...(topK ? { topK } : {}),
			...(topP ? { topP } : {}),
			...(minP ? { minP } : {}),
			...(frequencyPenalty ? { frequencyPenalty } : {}),
			...(presencePenalty ? { presencePenalty } : {}),
			...(repetitionPenalty ? { repetitionPenalty } : {}),
		},
	};
}

export function isOpenRouterProviderBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== "https:" || url.hostname !== "openrouter.ai") {
			return false;
		}
		const path = url.pathname.replace(/\/+$/, "");
		return path === "/api/v1" || path === "/api/v1/chat/completions" || path === "/api/v1/images";
	} catch {
		return false;
	}
}

function resolvedSetting<T>(effective: T, source: BotProviderSettingSource): ResolvedBotProviderSetting<T> {
	return { effective, source };
}

function selectedOptionalSetting<T>(
	botValue: T | undefined,
	profileValue: T | undefined,
	botSource: Extract<BotProviderSettingSource, "bot" | "source_bot">,
): ResolvedBotProviderSetting<T> | undefined {
	if (botValue !== undefined) {
		return resolvedSetting(botValue, botSource);
	}
	return profileValue === undefined ? undefined : resolvedSetting(profileValue, "profile");
}

function openRouterProviderRouting(baseUrl: string, providerRouting: JsonObject | undefined): JsonObject | undefined {
	if (!providerRouting || Object.keys(providerRouting).length === 0 || !isOpenRouterProviderBaseUrl(baseUrl)) {
		return undefined;
	}
	return providerRouting;
}

function trimmed(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text ? text : undefined;
}
