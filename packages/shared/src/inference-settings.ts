import {
	effectiveCompactionModeForModel,
	effectiveReasoningEffortForModel,
	resolvePrefillPolicyForModel,
	effectiveStructuredToolCallsForModel,
	modelSupportsPromptCacheControl,
	resolveToolCallPolicyForModel,
	type AppliedToolCallPolicy,
	type AppliedPrefillPolicy,
} from "./openrouter-model-capabilities";
import {
	defaultProviderBaseUrl,
	defaultProviderModel,
	defaultTextGenerationTemperature,
	legacyDefaultTextGenerationTemperature,
	type BotCompactionMode,
	type BotCompactionModeIntent,
	type BotCompactionReasoningRequest,
	type BotDocument,
	type BotInferenceReasoningEffort,
	type BotInferenceReasoningIntent,
	type BotInferenceReasoningRequest,
	type BotInferenceSettings,
	type BotInferenceToolCalls,
	type BotInferenceToolCallIntent,
	type BotInferenceToolCallRequest,
	type BotPromptCacheMode,
	type BotPromptCacheIntent,
	type JsonObject,
	type UserDocument,
} from "./model";

export type ProviderEnvironmentSettings = {
	apiKey?: string;
	apiKeySet?: boolean;
	baseUrl?: string;
	model?: string;
};

export type ProviderEnvironmentBindings = {
	OPENROUTER_API_KEY?: string;
	OPENROUTER_BASE_URL?: string;
	OPENROUTER_MODEL?: string;
};

export function providerEnvironmentSettingsFromBindings(
	bindings: ProviderEnvironmentBindings,
	options: { includeApiKey?: boolean } = {},
): ProviderEnvironmentSettings {
	const apiKey = trimmed(bindings.OPENROUTER_API_KEY);
	const baseUrl = trimmed(bindings.OPENROUTER_BASE_URL);
	const model = trimmed(bindings.OPENROUTER_MODEL);
	return {
		...(options.includeApiKey === false || !apiKey ? {} : { apiKey }),
		apiKeySet: Boolean(apiKey),
		...(baseUrl ? { baseUrl } : {}),
		...(model ? { model } : {}),
	};
}

export type ProviderSettings = {
	apiKey?: string;
	baseUrl: string;
	model: string;
	compactionMode?: BotCompactionMode;
	compactionModeRequest?: BotCompactionModeIntent;
	// This request is intentionally separate from reasoningEffort. Legacy
	// settings leave it absent so the established compaction policy still owns
	// the default until a configuration resolver supplies an explicit request.
	compactionReasoning?: BotCompactionReasoningRequest;
	promptCacheMode?: BotPromptCacheMode;
	promptCacheRequest?: BotPromptCacheIntent;
	providerRouting?: JsonObject;
	reasoningEffort?: Exclude<BotInferenceReasoningEffort, "default">;
	reasoningRequest?: BotInferenceReasoningIntent;
	supportsPrefill?: boolean;
	prefillPolicy?: AppliedPrefillPolicy;
	toolCalls?: BotInferenceToolCalls;
	toolCallRequest?: BotInferenceToolCallIntent;
	/** Applied only to the autonomous ordinary loop; structured operations resolve their own reasoning shape. */
	ordinaryLoopToolCalls?: AppliedToolCallPolicy;
	temperature: number;
	usesCustomBaseUrl?: boolean;
	topK?: number;
	topP?: number;
	minP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
};

export type LegacyTranslationProviderSettings = Omit<ProviderSettings, "toolCalls"> & {
	toolCalls: Exclude<BotInferenceToolCalls, "at_will">;
};

export type BotProviderSettingSource =
	| "bot"
	| "source_bot"
	| "profile"
	| "bickr_default"
	| "model_capability";

type BotOrSourceSettingSource = Extract<BotProviderSettingSource, "bot" | "source_bot">;

export type BotProviderSettingsResolutionOptions = {
	assumeBotProviderAvailable?: boolean;
	botSource?: BotOrSourceSettingSource;
};

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
	options: BotProviderSettingsResolutionOptions = {},
): BotProviderSettingsResolution {
	const botSource = options.botSource ?? "bot";
	const botSettings = bot.inferenceSettings;
	const profileSettings = owner.inferenceSettings ?? {};
	const envModel = trimmed(env.model);
	const envBaseUrl = trimmed(env.baseUrl);
	const envApiKey = trimmed(env.apiKey);
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
	const hasBotOrInheritedProvider =
		botApiKeySet || Boolean(botBaseUrl) || hasProfileProvider || options.assumeBotProviderAvailable === true;
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
		: !hasCustomBaseUrl && (envApiKey || env.apiKeySet) ? resolvedSetting(true, "bickr_default")
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
		capabilityResolvedSetting(reasoningEffortInput, reasoningEffortValue)
	: undefined;
	const reasoningRequest = providerReasoningRequestFromLegacyEffort(reasoningEffortInput?.effective);
	const toolCallsInput = selectedOptionalSetting(botSettings.toolCalls, inheritedDefaults.toolCalls, botSource);
	const toolCallRequest: BotInferenceToolCallRequest = toolCallsInput
		? { kind: "strategy", strategy: toolCallsInput.effective }
		: { kind: "bickr_automatic" };
	const ordinaryLoopToolCalls = resolveToolCallPolicyForModel(
		model.effective,
		openRouter,
		toolCallRequest,
		providerRouting?.effective,
		reasoningRequest.kind === "provider_default" || reasoningEffort?.effective === undefined ? "provider_default"
			: reasoningEffort?.effective === "none" ? "reasoning_off" : "reasoning_on",
	);
	const toolCalls = capabilityResolvedSetting(
		toolCallsInput,
		ordinaryLoopToolCalls.appliedStrategy,
	);
	const compactionModeInput = selectedOptionalSetting(
		botSettings.compactionMode,
		inheritedDefaults.compactionMode,
		botSource,
	);
	const compactionMode = capabilityResolvedSetting(
		compactionModeInput,
		effectiveCompactionModeForModel(model.effective, openRouter, compactionModeInput?.effective, providerRouting?.effective),
	);
	const promptCacheModeInput = selectedOptionalSetting(
		botSettings.promptCacheMode,
		inheritedDefaults.promptCacheMode,
		botSource,
	);
	const promptCacheMode = capabilityResolvedSetting(
		promptCacheModeInput,
		modelSupportsPromptCacheControl(model.effective, openRouter) ? promptCacheModeInput?.effective ?? "off" : "off",
	);
	const supportsPrefillInput = selectedOptionalSetting(
		botSettings.supportsPrefill,
		inheritedDefaults.supportsPrefill,
		botSource,
	);
	const prefillPolicy = resolvePrefillPolicyForModel(
		model.effective,
		openRouter,
		supportsPrefillInput?.effective,
		providerRouting?.effective,
		reasoningRequest.kind === "provider_default" || reasoningEffort?.effective === undefined ? "provider_default"
			: reasoningEffort.effective === "none" ? "reasoning_off" : "reasoning_on",
	);
	const supportsPrefill = capabilityResolvedSetting(supportsPrefillInput, prefillPolicy.applied);
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
			reasoningRequest,
			supportsPrefill: supportsPrefill.effective,
			prefillPolicy,
			toolCalls: toolCalls.effective,
			toolCallRequest,
			ordinaryLoopToolCalls,
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

/** Legacy translation request normalization used only for migration parity and
 * the version-0 compatibility reader. Prompt/enabled remain document-owned. */
export function resolveLegacyTranslationProviderSettings(
	user: Pick<UserDocument, "inferenceSettings">,
	env: ProviderEnvironmentSettings = {},
): LegacyTranslationProviderSettings | null {
	const userSettings = user.inferenceSettings ?? {};
	const translation = userSettings.translation;
	if (!translation?.enabled) return null;
	const translationModel = trimmed(translation.model);
	const userModel = trimmed(userSettings.model);
	const userBaseUrl = trimmed(userSettings.baseUrl);
	const userApiKey = trimmed(userSettings.openRouterApiKey);
	const hasCustomBaseUrl = Boolean(userBaseUrl);
	const baseUrl = userBaseUrl ?? trimmed(env.baseUrl) ?? defaultProviderBaseUrl;
	const model = translationModel ?? userModel ?? trimmed(env.model) ?? defaultProviderModel;
	const usingLoopSettings = !translationModel;
	const openRouter = isOpenRouterProviderBaseUrl(baseUrl);
	const providerRouting = openRouterProviderRouting(
		baseUrl,
		usingLoopSettings ? userSettings.providerRouting : translation.providerRouting,
	);
	const requestedReasoning = usingLoopSettings ? userSettings.reasoningEffort : translation.reasoningEffort;
	const reasoningEffort = effectiveReasoningEffortForModel(
		model,
		openRouter,
		requestedReasoning,
		providerRouting,
	);
	const reasoningRequest = !usingLoopSettings && (requestedReasoning === undefined || requestedReasoning === "default")
		? { kind: "provider_default" as const }
		: providerReasoningRequestFromLegacyEffort(requestedReasoning);
	const reasoningShape = reasoningRequest.kind === "provider_default" || reasoningEffort === undefined ? "provider_default"
		: reasoningEffort === "none" ? "reasoning_off" : "reasoning_on";
	const requestedToolCalls = usingLoopSettings ? userSettings.toolCalls : translation.toolCalls;
	const toolCallRequest = requestedToolCalls !== undefined
		? { kind: "strategy" as const, strategy: requestedToolCalls }
		: usingLoopSettings ? { kind: "bickr_automatic" as const } : { kind: "provider_default" as const };
	const toolCalls = effectiveStructuredToolCallsForModel(
		model,
		openRouter,
		toolCallRequest.kind === "strategy" ? toolCallRequest.strategy
			: toolCallRequest.kind === "provider_default" ? "at_will" : undefined,
		providerRouting,
		reasoningShape,
	);
	return {
		apiKey: userApiKey ?? (hasCustomBaseUrl ? undefined : trimmed(env.apiKey)),
		baseUrl,
		model,
		...(providerRouting ? { providerRouting } : {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
		reasoningRequest,
		toolCalls,
		toolCallRequest,
		temperature: usingLoopSettings
			? userSettings.temperature ?? defaultTextGenerationTemperature
			: translation.temperature ?? 0,
		...(usingLoopSettings
			? optionalSamplingFields(userSettings)
			: optionalSamplingFields(translation)),
	};
}

export function providerReasoningRequestFromLegacyEffort(
	value: BotInferenceReasoningEffort | undefined,
): BotInferenceReasoningRequest {
	switch (value) {
		case undefined:
		case "default": return { kind: "bickr_automatic" };
		case "none": return { kind: "reasoning_disabled" };
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh": return { kind: "explicit_effort", effort: value };
	}
}

function optionalSamplingFields(settings: Pick<BotInferenceSettings,
	"topK" | "topP" | "minP" | "frequencyPenalty" | "presencePenalty" | "repetitionPenalty">):
	Pick<ProviderSettings, "topK" | "topP" | "minP" | "frequencyPenalty" | "presencePenalty" | "repetitionPenalty"> {
	return {
		...(settings.topK !== undefined ? { topK: settings.topK } : {}),
		...(settings.topP !== undefined ? { topP: settings.topP } : {}),
		...(settings.minP !== undefined ? { minP: settings.minP } : {}),
		...(settings.frequencyPenalty !== undefined ? { frequencyPenalty: settings.frequencyPenalty } : {}),
		...(settings.presencePenalty !== undefined ? { presencePenalty: settings.presencePenalty } : {}),
		...(settings.repetitionPenalty !== undefined ? { repetitionPenalty: settings.repetitionPenalty } : {}),
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

function capabilityResolvedSetting<TInput, TEffective>(
	input: ResolvedBotProviderSetting<TInput> | undefined,
	effective: TEffective,
): ResolvedBotProviderSetting<TEffective> {
	return resolvedSetting(
		effective,
		input && !Object.is(input.effective, effective) ? "model_capability" : input?.source ?? "bickr_default",
	);
}

function selectedOptionalSetting<T>(
	botValue: T | undefined,
	profileValue: T | undefined,
	botSource: BotOrSourceSettingSource,
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
