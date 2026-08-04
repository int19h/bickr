import {
	effectiveCompactionModeForModel,
	effectiveReasoningEffortForModel,
	effectiveSupportsPrefillForModel,
	modelSupportsReasoningNone,
	type CompactionReasoningSelection,
} from '@bickr/shared/openrouter-model-capabilities';
import {
	localizedTextString,
	type BotCompactionMode,
	type BotDocument,
	type BotInferenceReasoningEffort,
	type BotInferenceSubmissionMessage,
	type BotInferenceSubmissionToolCall,
	type BotInferenceToolCalls,
	type BotStructuredToolCalls,
	type JsonObject,
} from '@bickr/shared/model';
import { isOpenRouterProviderBaseUrl } from '@bickr/shared/inference-settings';
import {
	isMetaCompactionToolDefinition,
	metaCompactionToolDefinition,
	metaCompactionToolName,
	nativeLanguageSystemPromptLine,
	providerCompactionSummaryProperty,
	providerCompactionSummaryPropertyDescription,
	providerCompactionSummarySchemaDescription,
	standardPrompt,
	toolDefinitionsForProviderRound,
	type ProviderToolDefinition,
} from '../prompt-and-tools';
import { providerContextCompletionReserveTokens } from '../constants';
import type { ProviderCompactionSummaryLimits } from '../types';
import type { CompactionAttemptMessageSet, CompactionAttemptToolSet } from './plan';

type ChatMessage = BotInferenceSubmissionMessage;

export type ProviderCompactionMode = BotCompactionMode;

export type ProviderReasoningConfig =
	| { enabled: true; exclude: false }
	| { effort: Exclude<BotInferenceReasoningEffort, 'default'>; exclude: false };

export type ProviderJsonSchemaResponseFormat = {
	type: 'json_schema';
	json_schema: {
		name: string;
		description?: string;
		strict: true;
		schema: {
			type: 'object';
			description?: string;
			properties: Record<string, { type: 'string'; description?: string; minLength?: number; maxLength?: number }>;
			required: string[];
			additionalProperties: false;
		};
	};
};

export type ProviderSingleStringResponseSpec = {
	kind: 'avatar_description' | 'compaction' | 'translation';
	property: string;
	label: string;
	maxCharacters: number;
	minCharacters?: number;
	schemaDescription?: string;
	propertyDescription?: string;
	reduction?: (summary: string) => {
		compactedTokens: number;
		reduces: boolean;
		replacementTokens: number;
	};
	toolName?: string;
};

type CompactionProviderSettings = {
	baseUrl?: string;
	model: string;
	compactionMode?: BotCompactionMode;
	providerRouting?: JsonObject;
};

type StructuredOutputRepairError = {
	repairMessage: string;
	requiredToolName: string;
	toolCalls: BotInferenceSubmissionToolCall[];
	validationIssue?: 'non_reducing_compaction' | 'transcript_like_compaction';
};

const providerCompactionNoReasoning = { effort: 'none', exclude: false } as const satisfies ProviderReasoningConfig;
const providerCompactionReasoningDisabledSelection = { kind: 'reasoning_disabled' } as const satisfies CompactionReasoningSelection;
export const providerCompactionTemperature = 0.2;
export const providerCompactionToolName = metaCompactionToolName;
export const providerRequiredToolChoice = 'required' as const;
const providerContinuationMessageContent = 'Bickr Terminal is ready for my next step.';

export const defaultProviderCompactionSummaryLimits: ProviderCompactionSummaryLimits = {
	minLength: 1,
	maxLength: 4_000,
	maxCompletionTokens: providerContextCompletionReserveTokens,
	compactionInputTokens: 1,
	nextCompactionTokens: 1,
	compactionRequestOverheadTokens: 512,
	anticipatedSummaryTokens: 1,
	maxSummaryTokens: 1_000,
	tokensPerCharacter: 0.25,
	compactedCharacterCount: 0,
	configuredMaxCharacters: 4_000,
	compactionSummaryPercent: 10,
};

export function settingsUseOpenRouter(settings: { baseUrl?: string }): boolean {
	return settings.baseUrl !== undefined && isOpenRouterProviderBaseUrl(settings.baseUrl);
}

export function providerCompactionReasoningForSelection(
	selection: CompactionReasoningSelection,
): ProviderReasoningConfig | undefined {
	switch (selection.kind) {
		case 'reasoning_disabled':
			return providerCompactionNoReasoning;
		case 'model_default':
			return selection.effort ? { effort: selection.effort, exclude: false } : undefined;
		case 'explicit_effort':
			return { effort: selection.effort, exclude: false };
	}
}

export function providerAvatarDescriptionReasoningForSettings(
	settings: { baseUrl?: string; model: string },
): ProviderReasoningConfig | undefined {
	const openRouter = settingsUseOpenRouter(settings);
	if (modelSupportsReasoningNone(settings.model, openRouter)) {
		return providerCompactionNoReasoning;
	}
	const defaultEffort = effectiveReasoningEffortForModel(settings.model, openRouter, undefined);
	return defaultEffort ? { effort: defaultEffort, exclude: false } : undefined;
}

export function providerCompactionMode(settings: CompactionProviderSettings): ProviderCompactionMode {
	return effectiveCompactionModeForModel(settings.model, settingsUseOpenRouter(settings), settings.compactionMode, settings.providerRouting);
}

function providerCompactionOnlyTools(limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>): [ProviderToolDefinition] {
	return [metaCompactionToolDefinition(limits.maxLength, limits.minLength)];
}

function providerCompactionIsolatedRepairTools(
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode,
): ProviderToolDefinition[] {
	return mode === 'structured_output' ? [] : providerCompactionOnlyTools(limits);
}

export function providerCompactionToolsForMode(
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	providerTools: ProviderToolDefinition[] | undefined,
	mode: ProviderCompactionMode,
): ProviderToolDefinition[] {
	if (mode === 'tool_call') {
		return providerCompactionOnlyTools(limits);
	}
	if (mode === 'tool_call_cache_friendly') {
		const tools = providerTools ?? toolDefinitionsForProviderRound(limits.maxLength, { includeMetaCompactionTool: true });
		return tools.some(isMetaCompactionToolDefinition) ? tools : [...tools, metaCompactionToolDefinition(limits.maxLength)];
	}
	// Structured-output compaction intentionally keeps the regular loop tool schema,
	// minus the meta compaction tool, so these requests can reuse the provider's prompt cache.
	return (providerTools ?? toolDefinitionsForProviderRound(limits.maxLength, { includeMetaCompactionTool: false })).filter(
		(tool) => !isMetaCompactionToolDefinition(tool),
	);
}

function providerCompactionPersonaInstruction(bot: Pick<BotDocument, 'displayName' | 'handle' | 'includeLanguageInSystemPrompt' | 'language' | 'prompt' | 'shortBio'>): string {
	const nativeLanguageLine = nativeLanguageSystemPromptLine(bot);
	return [
		`Stay in character. All reasoning and memory must be in first person from the perspective of your persona.`,
		`Your Bickr handle is u/${bot.handle}`,
		...(nativeLanguageLine ? [nativeLanguageLine] : []),
		`Your display name is ${localizedTextString(bot.displayName)}`,
		`Your short bio is:\n${localizedTextString(bot.shortBio)}`,
		`Your persona is:\n${localizedTextString(bot.prompt)}`,
	].join('\n\n');
}

export function providerCompactionSystemInstruction(
	bot: BotDocument & { worldPrompt?: string },
	tools: readonly ProviderToolDefinition[],
	mode: ProviderCompactionMode,
): string {
	const setting = bot.worldPrompt?.trim();
	return mode === 'tool_call'
		? [
				'You are an autonomous Bickr participant.',
				`"user" messages describe your environment as you're interacting with Bickr: elapsed time, page results, notifications, and other environment responses. Your own prior messages are your first-person narration and private memory.`,
				providerCompactionPersonaInstruction(bot),
				...(setting ? [`Setting:\n${setting}`] : []),
				`You MUST use ${providerCompactionToolName}. Do not use any other Bickr control.`,
			].join('\n\n')
		: appendToolRequirementInstruction(standardPrompt(bot, bot.worldPrompt), tools);
}

function providerCompactionSummaryInstruction(
	bot: Pick<BotDocument, 'handle'>,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode,
	reasoning: CompactionReasoningSelection,
): string {
	const lengthInstruction = providerCompactionLengthInstruction(limits);
	if (mode === 'structured_output') {
		const responseTiming = reasoning.kind === 'explicit_effort'
			? ''
			: " Don't spend any time thinking about this; respond immediately with JSON summary.";
		return `META: Context compaction required.${responseTiming} Reply with a JSON object matching the required structured output schema, and do not use any Bickr control. Put a detailed summary of only the recent events being compacted, excluding the system instructions and persona prompt, from the first-person perspective of u/${bot.handle}, in the "${providerCompactionSummaryProperty}" field; your response will become the long-term memory of these events, replacing them in context henceforth. Write ordinary first-person prose, never transcript or runtime-event lines labeled Action:, Result:, Input:, or New thought:. ${lengthInstruction}`;
	}
	return `META: Context compaction required. Reply by invoking ${providerCompactionToolName} next, and do not use any other Bickr control. Put a detailed summary of only the recent events being compacted, excluding the system instructions and persona prompt, from the first-person perspective of u/${bot.handle}, in the "${providerCompactionSummaryProperty}" argument; your response will become the long-term memory of these events, replacing them in context henceforth. Write ordinary first-person prose, never transcript or runtime-event lines labeled Action:, Result:, Input:, or New thought:. ${lengthInstruction}`;
}

function providerCompactionShortenInstruction(
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode,
	reasoning: CompactionReasoningSelection,
): string {
	const lengthInstruction = providerCompactionLengthInstruction(limits);
	if (mode === 'structured_output') {
		const responseTiming = reasoning.kind === 'explicit_effort'
			? ''
			: " Don't spend any time thinking about this; respond immediately with JSON summary.";
		return `META: The previous context compaction attempt produced a summary that was too long.${responseTiming} Reply with a JSON object matching the required structured output schema, and do not use any Bickr control. Put a shorter first-person memory summary in the "${providerCompactionSummaryProperty}" field. Verbatim copying from the input is absolutely prohibited: do not copy any sentence, phrase, paragraph, list item, or passage from the input. Restate the remembered facts in new wording and discard repeated boilerplate. ${lengthInstruction}`;
	}
	return `META: The previous context compaction attempt produced a summary that was too long. Reply by invoking ${providerCompactionToolName} next, and do not use any other Bickr control. Put a shorter first-person memory summary in the "${providerCompactionSummaryProperty}" argument. Verbatim copying from the input is absolutely prohibited: do not copy any sentence, phrase, paragraph, list item, or passage from the input. Restate the remembered facts in new wording and discard repeated boilerplate. ${lengthInstruction}`;
}

function providerCompactionIsolatedRepairSystemInstruction(
	bot: Pick<BotDocument, 'displayName' | 'handle' | 'includeLanguageInSystemPrompt' | 'language' | 'prompt' | 'shortBio'>,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode,
	reasoning: CompactionReasoningSelection,
): string {
	const lengthInstruction = providerCompactionLengthInstruction(limits);
	const responseInstruction =
		mode === 'structured_output'
			? reasoning.kind === 'explicit_effort'
				? `Reply with a JSON object matching the required structured output schema, and do not use any Bickr control. Put the replacement first-person memory summary in the "${providerCompactionSummaryProperty}" field.`
				: `Don't spend any time thinking about this; respond immediately with JSON summary. Reply with a JSON object matching the required structured output schema, and do not use any Bickr control. Put the replacement first-person memory summary in the "${providerCompactionSummaryProperty}" field.`
			: `Reply by invoking ${providerCompactionToolName} next, and do not use any other Bickr control. Put the replacement first-person memory summary in the "${providerCompactionSummaryProperty}" argument.`;
	return [
		`META: Context compaction repair required. The previous compaction attempt did not reduce the context. ${responseInstruction} Summarize only the input summary being repaired, excluding the system instructions and persona prompt; your response will become the long-term memory of these events, replacing them in context henceforth. Verbatim copying from the input is absolutely prohibited: do not copy any sentence, phrase, paragraph, list item, or passage from the input. Restate the remembered facts in new wording and discard repeated boilerplate. ${lengthInstruction}`,
		providerCompactionPersonaInstruction(bot),
	].join('\n\n');
}

function providerCompactionLengthInstruction(limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>): string {
	return (
		"You must produce a _summary_ of the events, and it MUST be shorter than the input, so don't just repeat it with minor modifications; you MUST shorten it, even if it's already a summary! " +
		(limits.minLength >= limits.maxLength
			? `Use exactly ${limits.maxLength} characters if possible.`
			: `Use between ${limits.minLength} and ${limits.maxLength} characters.`)
	);
}

function providerCompactionShortenMessages(
	previousMessages: readonly ChatMessage[],
	previousSummary: string,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode = 'structured_output',
	reasoning: CompactionReasoningSelection = providerCompactionReasoningDisabledSelection,
): ChatMessage[] {
	const systemMessage = previousMessages.find((message) => message.role === 'system');
	return [
		...(systemMessage ? [systemMessage] : []),
		{ role: 'assistant', content: previousSummary },
		{ role: 'user', content: providerCompactionShortenInstruction(limits, mode, reasoning) },
	];
}

function providerCompactionIsolatedRepairMessages(
	bot: Pick<BotDocument, 'displayName' | 'handle' | 'includeLanguageInSystemPrompt' | 'language' | 'prompt' | 'shortBio'>,
	previousSummary: string,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode = 'structured_output',
	reasoning: CompactionReasoningSelection = providerCompactionReasoningDisabledSelection,
): ChatMessage[] {
	return [
		{
			role: 'system',
			content: providerCompactionIsolatedRepairSystemInstruction(bot, limits, mode, reasoning),
		},
		{ role: 'assistant', content: previousSummary },
		{ role: 'user', content: 'Produce the replacement memory summary now.' },
	];
}

export function isNonReducingCompactionValidationError(error: StructuredOutputRepairError): boolean {
	return error.validationIssue === 'non_reducing_compaction';
}

export function isTranscriptLikeCompactionValidationError(error: StructuredOutputRepairError): boolean {
	return error.validationIssue === 'transcript_like_compaction';
}

export function transcriptLikeCompactionSummaryLine(summary: string): string | undefined {
	return summary
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) =>
			/^(?:Action|Result|Input|New thought):\s*/i.test(line) ||
			/^(?:provider_request|provider_token_probe|provider_token_estimate|provider_retry|provider_tool_call_dropped|provider_tool_call_repaired|provider_history_repaired|tick_started|tick_completed|tick_failed|tick_stopped|tick_stop_requested)\b/.test(line),
		);
}

export function providerCompactionMessages(
	bot: BotDocument,
	compactedMessages: ChatMessage[],
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'> = defaultProviderCompactionSummaryLimits,
	providerTools: ProviderToolDefinition[] = toolDefinitionsForProviderRound(limits.maxLength),
	mode: ProviderCompactionMode = 'structured_output',
	reasoning: CompactionReasoningSelection = providerCompactionReasoningDisabledSelection,
): ChatMessage[] {
	const tools = providerCompactionToolsForMode(limits, providerTools, mode);
	return [
		{
			role: 'system',
			content: providerCompactionSystemInstruction(bot, tools, mode),
		},
		...compactedMessages,
		{
			role: 'user',
			content: providerCompactionSummaryInstruction(bot, limits, mode, reasoning),
		},
		...(mode === 'tool_call'
			? [
					{
						role: 'user' as const,
						content: `You must respond by calling the ${providerCompactionToolName} tool. Put the summary in the "${providerCompactionSummaryProperty}" argument. ${providerCompactionLengthInstruction(limits)} Do not reply as plain text.`,
					},
				]
			: []),
	];
}

export function providerCompactionMessagesForAttempt(
	bot: BotDocument | undefined,
	initialMessages: ChatMessage[],
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode,
	messageSet: CompactionAttemptMessageSet,
	reasoning: CompactionReasoningSelection,
): ChatMessage[] {
	switch (messageSet.kind) {
		case 'initial':
			return initialMessages;
		case 'schema_repair':
			return [...messageSet.messages];
		case 'shorten_previous_summary':
			return providerCompactionShortenMessages(initialMessages, messageSet.previousSummary, limits, mode, reasoning);
		case 'isolated_reduction_repair':
			if (!bot) {
				throw new Error('Compaction isolated reduction repair requires participant context.');
			}
			return providerCompactionIsolatedRepairMessages(bot, messageSet.previousSummary, limits, mode, reasoning);
	}
}

export function providerCompactionToolsForAttempt(
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	baseTools: ProviderToolDefinition[],
	mode: ProviderCompactionMode,
	toolSet: CompactionAttemptToolSet,
): ProviderToolDefinition[] {
	return toolSet === 'isolated_reduction_repair' ? providerCompactionIsolatedRepairTools(limits, mode) : baseTools;
}

export function providerSingleStringResponseFormat(
	name: string,
	spec: Pick<ProviderSingleStringResponseSpec, 'maxCharacters' | 'minCharacters' | 'property' | 'propertyDescription' | 'schemaDescription'>,
	mode: ProviderCompactionMode = 'structured_output',
): ProviderJsonSchemaResponseFormat | undefined {
	if (mode !== 'structured_output') {
		return undefined;
	}
	return {
		type: 'json_schema',
		json_schema: {
			name,
			...(spec.schemaDescription ? { description: spec.schemaDescription } : {}),
			strict: true,
			schema: {
				type: 'object',
				...(spec.schemaDescription ? { description: spec.schemaDescription } : {}),
				properties: {
					[spec.property]: {
						type: 'string',
						...(spec.propertyDescription ? { description: spec.propertyDescription } : {}),
						minLength: Math.max(1, Math.floor(spec.minCharacters ?? 1)),
						maxLength: Math.max(1, Math.floor(spec.maxCharacters)),
					},
				},
				required: [spec.property],
				additionalProperties: false,
			},
		},
	};
}

export function providerCompactionResponseFormat(
	maxCharacters: number,
	mode: ProviderCompactionMode = 'structured_output',
): ProviderJsonSchemaResponseFormat | undefined {
	return providerSingleStringResponseFormat(
		'compaction_summary',
		{
			property: providerCompactionSummaryProperty,
			maxCharacters,
			schemaDescription: providerCompactionSummarySchemaDescription,
			propertyDescription: providerCompactionSummaryPropertyDescription,
		},
		mode,
	);
}

export function structuredOutputRepairMessages(error: StructuredOutputRepairError): ChatMessage[] {
	const content = JSON.stringify({
		ok: false,
		code: 'schema_invalid',
		message: error.repairMessage,
	});
	if (error.toolCalls.length === 0) {
		return [
			{
				role: 'assistant',
				content: error.requiredToolName
					? `Actually, I must use the ${error.requiredToolName} tool.`
					: 'Actually, I must reply with the required structured output.',
			},
		];
	}
	return [
		{
			role: 'assistant',
			content: '',
			tool_calls: error.toolCalls,
		},
		...error.toolCalls.map(
			(toolCall): ChatMessage => ({
				role: 'tool',
				tool_call_id: toolCall.id,
				content,
			}),
		),
	];
}

export function providerToolChoiceForMode(
	mode: BotInferenceToolCalls | BotStructuredToolCalls,
): typeof providerRequiredToolChoice | undefined {
	return mode === 'require' ? providerRequiredToolChoice : undefined;
}

export function providerToolNames(tools: readonly ProviderToolDefinition[]): string[] {
	return tools.map((definition) => (definition.type === 'function' ? definition.function.name : definition.type));
}

function providerControlInstructionTools(tools: readonly ProviderToolDefinition[]): ProviderToolDefinition[] {
	return tools.filter((definition) => !isMetaCompactionToolDefinition(definition));
}

function toolRequirementInstruction(tools: readonly ProviderToolDefinition[]): string {
	const controlTools = providerControlInstructionTools(tools);
	const names = providerToolNames(controlTools).join(', ');
	const prefix = names ? `You MUST use one of the following tools: ${names}.` : 'You MUST use an available Bickr control.';
	const metaInstruction = tools.some(isMetaCompactionToolDefinition)
		? ` ${providerCompactionToolName} may only be used when directed.`
		: '';
	return `${prefix}${metaInstruction}`;
}

export function toolRequirementSelfCorrection(tools: readonly ProviderToolDefinition[]): string {
	const names = providerToolNames(providerControlInstructionTools(tools)).join(', ');
	return names ? `Actually, I must use one of the following tools: ${names}.` : 'Actually, I must use an available Bickr control.';
}

export function appendToolRequirementInstruction(content: string, tools: readonly ProviderToolDefinition[]): string {
	return `${content}\n\n${toolRequirementInstruction(tools)}`;
}

export function providerMessagesWithPrefillCompatibility(
	settings: { baseUrl?: string; model: string; supportsPrefill?: boolean },
	messages: ChatMessage[],
): ChatMessage[] {
	const prepared = providerMessagesWithInitialUserContext(messages);
	const last = prepared[prepared.length - 1];
	const supportsPrefill = effectiveSupportsPrefillForModel(settings.model, settingsUseOpenRouter(settings), settings.supportsPrefill);
	return !supportsPrefill && last?.role === 'assistant' ? [...prepared, providerContinuationMessage()] : prepared;
}

function providerMessagesWithInitialUserContext(messages: ChatMessage[]): ChatMessage[] {
	const insertionIndex = messages[0]?.role === 'system' ? 1 : -1;
	if (insertionIndex < 0 || initialUserContextMessage(messages[insertionIndex])) {
		return messages;
	}
	return [...messages.slice(0, insertionIndex), providerContinuationMessage(), ...messages.slice(insertionIndex)];
}

function providerContinuationMessage(): ChatMessage {
	return { role: 'user', content: providerContinuationMessageContent };
}

function initialUserContextMessage(message: ChatMessage | undefined): boolean {
	return message?.role === 'user' && message.content === providerContinuationMessageContent;
}
