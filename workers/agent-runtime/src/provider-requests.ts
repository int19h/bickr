import type {
	BotCompactionMode,
	BotInferenceReasoningEffort,
	BotInferenceToolCalls,
	BotPromptCacheMode,
	JsonObject,
} from '@bickr/shared/model';

export type ProviderSettings = {
	apiKey?: string;
	baseUrl: string;
	model: string;
	compactionMode?: BotCompactionMode;
	promptCacheMode?: BotPromptCacheMode;
	providerRouting?: JsonObject;
	reasoningEffort?: Exclude<BotInferenceReasoningEffort, 'default'>;
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

export function providerMessageTextContent(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value.trim() || undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}
	const text = value
		.map((item) => {
			const record = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
			return typeof record.text === 'string' ? record.text : '';
		})
		.join('\n')
		.trim();
	return text || undefined;
}
