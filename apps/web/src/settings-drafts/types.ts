import type {
	BotCompactionMode,
	BotInferenceSettings,
	BotPromptCacheMode,
	JsonObject,
} from "@bickr/shared/model";

/** Inheritance context for legacy stored-settings model display. */
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
