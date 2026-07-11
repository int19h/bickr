import type {
	BotCompactionMode,
	BotInferenceSettings,
	BotPromptCacheMode,
	JsonObject,
} from "@bickr/shared/model";

export type ImageGenerationDraft = {
	imageGenerationModel: string;
	imageGenerationPrompt: string;
	imageGenerationProviderRouting: string;
	imageGenerationAspectRatio: string;
	imageGenerationImageSize: string;
	imageGenerationTemperature: string;
	imageGenerationTopK: string;
	imageGenerationTopP: string;
	imageGenerationMinP: string;
	imageGenerationFrequencyPenalty: string;
	imageGenerationPresencePenalty: string;
	imageGenerationRepetitionPenalty: string;
};

export type TranslationDraft = {
	translationEnabled: boolean;
	translationModel: string;
	translationPrompt: string;
	translationReasoningEffort: string;
	translationToolCalls: string;
	translationProviderRouting: string;
	translationTemperature: string;
	translationTopK: string;
	translationTopP: string;
	translationMinP: string;
	translationFrequencyPenalty: string;
	translationPresencePenalty: string;
	translationRepetitionPenalty: string;
};

export type InferenceDraft = TranslationDraft & ImageGenerationDraft & {
	openRouterApiKey: string;
	clearOpenRouterApiKey: boolean;
	openRouterApiKeySet: boolean;
	baseUrl: string;
	model: string;
	compactionMode: BotCompactionMode;
	promptCacheMode: BotPromptCacheMode;
	recurringPromptEnabled: boolean;
	recurringPrompt: string;
	supportsPrefill: boolean;
	reasoningEffort: string;
	toolCalls: string;
	providerRouting: string;
	temperature: string;
	topK: string;
	topP: string;
	minP: string;
	frequencyPenalty: string;
	presencePenalty: string;
	repetitionPenalty: string;
};

export type InferenceModelUnlockContext = {
	apiKeySet?: boolean;
	openRouterApiKey?: string;
	openRouterApiKeySet?: boolean;
	baseUrl?: string;
	model?: string;
	compactionMode?: BotCompactionMode;
	promptCacheMode?: BotPromptCacheMode;
	providerRouting?: JsonObject;
	reasoningEffort?: BotInferenceSettings["reasoningEffort"];
	supportsPrefill?: boolean;
	toolCalls?: BotInferenceSettings["toolCalls"];
	temperature?: number;
	topK?: number;
	topP?: number;
	minP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
};
