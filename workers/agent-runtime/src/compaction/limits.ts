import { effectiveTickSettings } from '@bickr/shared/repository';
import type { BotDocument, BotInferenceSubmissionMessage } from '@bickr/shared/model';
import { providerContextCompletionReserveTokens } from '../constants';
import { toolDefinitionsForProviderRound, type ProviderToolDefinition } from '../prompt-and-tools';
import type { ProviderCompactionSummaryLimits } from '../types';
import {
	providerCompactionMessages,
	providerCompactionResponseFormat,
	providerCompactionToolsForMode,
	type ProviderCompactionMode,
	type ProviderJsonSchemaResponseFormat,
} from './engine';

type ChatMessage = BotInferenceSubmissionMessage;

export type TextTokenCalibration = {
	tokensPerCharacter: number;
	sampleCount: number;
};

export const compactionRowTokenFraction = 0.7;
export const providerPromptEstimateSafetyTokens = 512;
export const providerCompactionMaxPromptEstimateTokens = 120_000;
export const fallbackTokensPerCharacter = 0.25;
export const minCalibratedTokensPerCharacter = 1 / 12;
export const maxCalibratedTokensPerCharacter = 1;

export function providerCompactionSummaryLimitsForChat(
	bot: BotDocument,
	compactedMessages: readonly ChatMessage[],
	calibration: TextTokenCalibration,
	providerTools?: ProviderToolDefinition[],
	mode: ProviderCompactionMode = 'structured_output',
	contextWindowTokensOverride?: number,
): ProviderCompactionSummaryLimits {
	const tickSettings = effectiveTickSettings(bot.tickSettings);
	const contextWindowTokens = Math.max(
		1,
		Math.floor(contextWindowTokensOverride === undefined ? tickSettings.contextWindowTokens : contextWindowTokensOverride),
	);
	const tokensPerCharacter = Math.max(minCalibratedTokensPerCharacter, calibration.tokensPerCharacter || fallbackTokensPerCharacter);
	const configuredMaxCharacters = Math.max(1, Math.floor(tickSettings.compactionMaxCharacters));
	const compactedCharacterCount = chatMessagesCharacterCount(compactedMessages);
	const compactionSummaryPercent = Math.max(1, Math.min(50, Math.floor(tickSettings.compactionSummaryPercent)));
	let maxLength = configuredMaxCharacters;
	let minLength = Math.min(maxLength, Math.max(1, Math.ceil((compactedCharacterCount * compactionSummaryPercent) / 100)));
	let anticipatedSummaryTokens = Math.max(1, Math.ceil(minLength * tokensPerCharacter));
	let maxSummaryTokens = Math.max(1, Math.ceil(configuredMaxCharacters * tokensPerCharacter));
	let compactionRequestOverheadTokens = providerPromptEstimateSafetyTokens;
	let maxCompletionTokens = Math.max(1, contextWindowTokens - compactionRequestOverheadTokens);
	let compactionInputTokens = Math.max(1, contextWindowTokens - anticipatedSummaryTokens - compactionRequestOverheadTokens);
	let nextCompactionTokens = providerPromptCompactionCutoffTokens(contextWindowTokens, anticipatedSummaryTokens);

	for (let iteration = 0; iteration < 3; iteration += 1) {
		maxLength = configuredMaxCharacters;
		minLength = Math.min(maxLength, Math.max(1, Math.ceil((compactedCharacterCount * compactionSummaryPercent) / 100)));
		const effectiveProviderTools = providerCompactionToolsForMode({ minLength, maxLength }, providerTools, mode);
		anticipatedSummaryTokens = Math.max(1, Math.ceil(minLength * tokensPerCharacter));
		maxSummaryTokens = Math.max(1, Math.ceil(maxLength * tokensPerCharacter));
		compactionRequestOverheadTokens = providerCompactionRequestOverheadTokens(
			bot,
			{ minLength, maxLength },
			calibration,
			effectiveProviderTools,
			mode,
		);
		const messages = providerCompactionMessages(bot, [...compactedMessages], { minLength, maxLength }, effectiveProviderTools, mode);
		maxCompletionTokens = providerCompactionMaxCompletionTokensForRequest(
			contextWindowTokens,
			messages,
			effectiveProviderTools,
			calibration,
			providerCompactionResponseFormat(maxLength, mode),
		);
		compactionInputTokens = Math.max(1, contextWindowTokens - anticipatedSummaryTokens - compactionRequestOverheadTokens);
		nextCompactionTokens = providerPromptCompactionCutoffTokens(contextWindowTokens, anticipatedSummaryTokens);
	}

	return {
		minLength,
		maxLength,
		maxCompletionTokens,
		compactionInputTokens,
		nextCompactionTokens,
		compactionRequestOverheadTokens,
		anticipatedSummaryTokens,
		maxSummaryTokens,
		tokensPerCharacter,
		compactedCharacterCount,
		configuredMaxCharacters,
		compactionSummaryPercent,
	};
}

function providerPromptCompactionCutoffTokens(contextWindowTokens: number, anticipatedSummaryTokens: number): number {
	const summaryAllowanceTokens = Math.max(1, Math.ceil(anticipatedSummaryTokens));
	// The normal loop response and the future compaction summary are separate provider requests,
	// so the cutoff reserves whichever one needs more room. That keeps loop max_completion_tokens
	// at the completion reserve exactly at the cutoff boundary without prematurely summing both.
	return Math.max(
		1,
		Math.floor(contextWindowTokens) - Math.max(providerContextCompletionReserveTokens, summaryAllowanceTokens),
	);
}

function providerCompactionRequestOverheadTokens(
	bot: BotDocument,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	calibration: TextTokenCalibration,
	providerTools: ProviderToolDefinition[] = toolDefinitionsForProviderRound(limits.maxLength),
	mode: ProviderCompactionMode = 'structured_output',
): number {
	const tools = providerCompactionToolsForMode(limits, providerTools, mode);
	const overheadMessages = providerCompactionMessages(bot, [], limits, tools, mode);
	const responseFormat = providerCompactionResponseFormat(limits.maxLength, mode);
	return (
		estimateChatMessagesTokens(overheadMessages, calibration) +
		estimateTextTokensWithCalibration(JSON.stringify(tools), calibration) +
		estimateTextTokensWithCalibration(JSON.stringify(responseFormat ?? {}), calibration) +
		providerPromptEstimateSafetyTokens
	);
}

export function providerCompactionMaxCompletionTokensForRequest(
	contextWindowTokens: number,
	messages: readonly ChatMessage[],
	providerTools: readonly ProviderToolDefinition[],
	calibration: TextTokenCalibration,
	responseFormat?: ProviderJsonSchemaResponseFormat,
): number {
	return Math.max(
		1,
		Math.floor(contextWindowTokens) -
			estimateChatMessagesTokens(messages, calibration) -
			estimateTextTokensWithCalibration(JSON.stringify(providerTools), calibration) -
			estimateTextTokensWithCalibration(JSON.stringify(responseFormat ?? {}), calibration) -
			providerPromptEstimateSafetyTokens,
	);
}

export function providerCompactionRequiredCompletionTokens(limits: Pick<ProviderCompactionSummaryLimits, 'maxSummaryTokens'>): number {
	return Math.max(1, Math.ceil(limits.maxSummaryTokens + providerPromptEstimateSafetyTokens));
}

export function estimateTextTokensWithCalibration(text: string, calibration: TextTokenCalibration): number {
	return Math.max(1, Math.ceil(text.length * calibration.tokensPerCharacter));
}

export function estimateChatMessageTokens(message: ChatMessage, calibration: TextTokenCalibration): number {
	return estimateChatMessagesTokens([message], calibration);
}

export function estimateChatMessagesTokens(messages: readonly ChatMessage[], calibration: TextTokenCalibration): number {
	const characters = chatMessagesCharacterCount(messages);
	if (characters <= 0) {
		return 0;
	}
	return Math.max(1, Math.ceil(characters * calibration.tokensPerCharacter));
}

export function chatMessagesCharacterCount(messages: readonly ChatMessage[]): number {
	return messages.reduce((total, message) => {
		const toolCallCharacters = (message.tool_calls ?? []).reduce((sum, toolCall) => {
			return sum + toolCall.id.length + toolCall.function.name.length + toolCall.function.arguments.length;
		}, 0);
		return (
			total +
			message.role.length +
			textLength(message.content) +
			textLength(message.tool_call_id) +
			textLength(message.reasoning) +
			textLength(message.reasoning_content) +
			(message.reasoning_details ? JSON.stringify(message.reasoning_details).length : 0) +
			toolCallCharacters
		);
	}, 0);
}

function textLength(value: string | null | undefined): number {
	return value?.length ?? 0;
}
