import type { InstructionText } from '@bickr/shared/instruction-template';
import type { BotText } from "../localization";
import {
	effectiveCompactionModeForModel,
	effectiveReasoningEffortForModel,
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
import { planEnabled } from '@bickr/shared/note-settings';
import {
	isMetaCompactionToolDefinition,
	metaCompactionToolDefinition,
	metaCompactionToolName,
	nativeLanguageSystemPromptLine,
	providerCompactionSummaryProperty,
	providerCompactionSummaryPropertyDescription,
	providerCompactionSummarySchemaDescription,
	providerParticipantIdentityPrompt,
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
	| { exclude: false }
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
	text: BotText;
	property: string;
	maxCharacters: number;
	minCharacters?: number;
	schemaDescription?: InstructionText;
	propertyDescription?: InstructionText;
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
	text: BotText;
	repairMessage: InstructionText;
	requiredToolName: string;
	toolCalls: BotInferenceSubmissionToolCall[];
	validationIssue?: 'non_reducing_compaction' | 'transcript_like_compaction';
};

const providerCompactionNoReasoning = { effort: 'none', exclude: false } as const satisfies ProviderReasoningConfig;
const providerCompactionReasoningDisabledSelection = { kind: 'reasoning_disabled' } as const satisfies CompactionReasoningSelection;
export const providerCompactionTemperature = 0.2;
export const providerCompactionToolName = metaCompactionToolName;
export const providerRequiredToolChoice = 'required' as const;
const legacyProviderContinuationMessageContent = 'The Bickr app is ready for my next step.';
function providerContinuationMessageContent(text: BotText): string { return text.format("compaction.continuation"); }

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
): ProviderReasoningConfig {
	switch (selection.kind) {
		case 'reasoning_disabled':
			return providerCompactionNoReasoning;
		case 'model_default':
			return selection.effort ? { effort: selection.effort, exclude: false } : { exclude: false };
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

function providerCompactionOnlyTools(text: BotText, limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>): [ProviderToolDefinition] {
	return [metaCompactionToolDefinition(text, limits.maxLength, limits.minLength)];
}

function providerCompactionIsolatedRepairTools(text: BotText,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode,
): ProviderToolDefinition[] {
	return mode === 'structured_output' ? [] : providerCompactionOnlyTools(text, limits);
}

export function providerCompactionToolsForMode(text: BotText,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	providerTools: ProviderToolDefinition[] | undefined,
	mode: ProviderCompactionMode,
): ProviderToolDefinition[] {
	if (mode === 'tool_call') {
		return providerCompactionOnlyTools(text, limits);
	}
	if (mode === 'tool_call_cache_friendly') {
		const tools = providerTools ?? toolDefinitionsForProviderRound(text, limits.maxLength, { includeMetaCompactionTool: true });
		return tools.some(isMetaCompactionToolDefinition) ? tools : [...tools, metaCompactionToolDefinition(text, limits.maxLength)];
	}
	// Structured-output compaction intentionally keeps the regular loop tool schema,
	// minus the meta compaction tool, so these requests can reuse the provider's prompt cache.
	return (providerTools ?? toolDefinitionsForProviderRound(text, limits.maxLength, { includeMetaCompactionTool: false })).filter(
		(tool) => !isMetaCompactionToolDefinition(tool),
	);
}

function providerCompactionPersonaInstruction(text: BotText, bot: Pick<BotDocument, 'displayName' | 'handle' | 'includeLanguageInSystemPrompt' | 'language' | 'prompt' | 'shortBio'>): string {
	const nativeLanguageLine = nativeLanguageSystemPromptLine(bot, text);
	return [
		text.format("compaction.persona.instruction"),
		providerParticipantIdentityPrompt(bot, text),
		...(nativeLanguageLine ? [nativeLanguageLine] : []),
		text.format("compaction.persona.display_name", { displayName: localizedTextString(bot.displayName) }),
		text.format("compaction.persona.short_bio", { shortBio: localizedTextString(bot.shortBio) }),
		text.format("compaction.persona.persona", { persona: localizedTextString(bot.prompt) }),
	].join('\n\n');
}

export function providerCompactionSystemInstruction(text: BotText,
	bot: BotDocument & { worldPrompt?: string },
	tools: readonly ProviderToolDefinition[],
	mode: ProviderCompactionMode,
): string {
	const setting = bot.worldPrompt?.trim();
	return mode === 'tool_call'
		? [
				text.format("compaction.system.autonomous"),
				text.format("compaction.system.roles"),
				providerCompactionPersonaInstruction(text, bot),
				...(setting ? [text.format("compaction.system.setting", { setting: setting })] : []),
				text.format("compaction.system.required_tool", { toolName: providerCompactionToolName }),
			].join('\n\n')
		: appendToolRequirementInstruction(text, standardPrompt(text, bot, bot.worldPrompt ?? '', {
			includeNotesTools: tools.some((tool) => 'function' in tool && tool.function.name === 'read_note'),
			includePlan: planEnabled(bot.toolSettings),
		}), tools);
}



/**
 * Only a selection that explicitly disables reasoning asks for the summary
 * without thinking. The selection also records who chose the effort — a
 * configured request, a safety or learned floor, or the model's own default —
 * and that provenance must not change the instruction. `model_default` is not
 * known to be reasoning on: it leaves the decision to the model, and this code
 * never learns which way that went. What every selection other than
 * `reasoning_disabled` does share is that nothing asked for reasoning off, so
 * none of them may carry a contradictory no-thinking instruction — that would
 * work against the compaction reasoning floor that chose the effort, or against
 * a model default this code never inspected.
 */
function compactionRequestsImmediateSummary(reasoning: CompactionReasoningSelection): boolean {
	return reasoning.kind === 'reasoning_disabled';
}

function providerCompactionSummaryInstruction(text: BotText,
	bot: Pick<BotDocument, 'handle'>,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode,
	reasoning: CompactionReasoningSelection,
): string {
	const lengthInstruction = providerCompactionLengthInstruction(text, limits);
	if (mode === 'structured_output') {
		return text.format(compactionRequestsImmediateSummary(reasoning) ? 'compaction.summary.structured.immediate' : 'compaction.summary.structured', {
			property: providerCompactionSummaryProperty, handle: bot.handle, lengthInstruction, transcriptLabels: text.transcriptLabelList,
		});
	}
	return text.format('compaction.summary.tool', { toolName: providerCompactionToolName, property: providerCompactionSummaryProperty, handle: bot.handle, lengthInstruction, transcriptLabels: text.transcriptLabelList });
}

function providerCompactionShortenInstruction(text: BotText,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode,
	reasoning: CompactionReasoningSelection,
): string {
	const lengthInstruction = providerCompactionLengthInstruction(text, limits);
	if (mode === 'structured_output') {
		return text.format(compactionRequestsImmediateSummary(reasoning) ? 'compaction.shorten.structured.immediate' : 'compaction.shorten.structured', {
			property: providerCompactionSummaryProperty, lengthInstruction,
		});
	}
	return text.format('compaction.shorten.tool', { toolName: providerCompactionToolName, property: providerCompactionSummaryProperty, lengthInstruction });
}

function providerCompactionIsolatedRepairSystemInstruction(text: BotText,
	bot: Pick<BotDocument, 'displayName' | 'handle' | 'includeLanguageInSystemPrompt' | 'language' | 'prompt' | 'shortBio'>,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode,
	reasoning: CompactionReasoningSelection,
): string {
	const lengthInstruction = providerCompactionLengthInstruction(text, limits);
	const responseInstruction = mode === 'structured_output'
		? text.format(compactionRequestsImmediateSummary(reasoning) ? 'compaction.repair.structured_response.immediate' : 'compaction.repair.structured_response', { property: providerCompactionSummaryProperty })
		: text.format('compaction.repair.tool_response', { toolName: providerCompactionToolName, property: providerCompactionSummaryProperty });
	return [text.format('compaction.repair.system', { responseInstruction, lengthInstruction }), providerCompactionPersonaInstruction(text, bot)].join('\n\n');
}

function providerCompactionLengthInstruction(text: BotText, limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>): string {
	return limits.minLength >= limits.maxLength
		? text.format('compaction.length.exact', { maxCharacters: limits.maxLength })
		: text.format('compaction.length.range', { minCharacters: limits.minLength, maxCharacters: limits.maxLength });
}

function providerCompactionShortenMessages(text: BotText,
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
		{ role: 'user', content: providerCompactionShortenInstruction(text, limits, mode, reasoning) },
	];
}

function providerCompactionIsolatedRepairMessages(text: BotText,
	bot: Pick<BotDocument, 'displayName' | 'handle' | 'includeLanguageInSystemPrompt' | 'language' | 'prompt' | 'shortBio'>,
	previousSummary: string,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	mode: ProviderCompactionMode = 'structured_output',
	reasoning: CompactionReasoningSelection = providerCompactionReasoningDisabledSelection,
): ChatMessage[] {
	return [
		{
			role: 'system',
			content: providerCompactionIsolatedRepairSystemInstruction(text, bot, limits, mode, reasoning),
		},
		{ role: 'assistant', content: previousSummary },
		{ role: 'user', content: text.format("compaction.repair.produce_summary") },
	];
}

export function isNonReducingCompactionValidationError(error: StructuredOutputRepairError): boolean {
	return error.validationIssue === 'non_reducing_compaction';
}

export function isTranscriptLikeCompactionValidationError(error: StructuredOutputRepairError): boolean {
	return error.validationIssue === 'transcript_like_compaction';
}

export function transcriptLikeCompactionSummaryLine(text: BotText, summary: string): string | undefined {
	return summary
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) =>
			text.isTranscriptHeader(line) ||
			/^(?:provider_request|provider_token_probe|provider_token_estimate|provider_retry|provider_tool_call_dropped|provider_tool_call_repaired|provider_history_repaired|tick_started|tick_completed|tick_failed|tick_stopped|tick_stop_requested)\b/.test(line),
		);
}

export function providerCompactionMessages(text: BotText,
	bot: BotDocument,
	compactedMessages: ChatMessage[],
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'> = defaultProviderCompactionSummaryLimits,
	providerTools: ProviderToolDefinition[] = toolDefinitionsForProviderRound(text, limits.maxLength),
	mode: ProviderCompactionMode = 'structured_output',
	reasoning: CompactionReasoningSelection = providerCompactionReasoningDisabledSelection,
): ChatMessage[] {
	const tools = providerCompactionToolsForMode(text, limits, providerTools, mode);
	return [
		{
			role: 'system',
			content: providerCompactionSystemInstruction(text, bot, tools, mode),
		},
		...compactedMessages,
		{
			role: 'user',
			content: providerCompactionSummaryInstruction(text, bot, limits, mode, reasoning),
		},
		...(mode === 'tool_call'
			? [
					{
						role: 'user' as const,
						content: text.format("compaction.summary.call_now", { toolName: providerCompactionToolName, property: providerCompactionSummaryProperty, lengthInstruction: providerCompactionLengthInstruction(text, limits) }),
					},
				]
			: []),
	];
}

export function providerCompactionMessagesForAttempt(text: BotText,
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
			return providerCompactionShortenMessages(text, initialMessages, messageSet.previousSummary, limits, mode, reasoning);
		case 'isolated_reduction_repair':
			if (!bot) {
				throw new Error("Compaction isolated reduction repair requires participant context.");
			}
			return providerCompactionIsolatedRepairMessages(text, bot, messageSet.previousSummary, limits, mode, reasoning);
	}
}

export function providerCompactionToolsForAttempt(text: BotText,
	limits: Pick<ProviderCompactionSummaryLimits, 'minLength' | 'maxLength'>,
	baseTools: ProviderToolDefinition[],
	mode: ProviderCompactionMode,
	toolSet: CompactionAttemptToolSet,
): ProviderToolDefinition[] {
	return toolSet === 'isolated_reduction_repair' ? providerCompactionIsolatedRepairTools(text, limits, mode) : baseTools;
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

export function providerCompactionResponseFormat(text: BotText,
	maxCharacters: number,
	mode: ProviderCompactionMode = 'structured_output',
): ProviderJsonSchemaResponseFormat | undefined {
	return providerSingleStringResponseFormat(
		'compaction_summary',
		{
			property: providerCompactionSummaryProperty,
			maxCharacters,
			schemaDescription: providerCompactionSummarySchemaDescription(text),
			propertyDescription: providerCompactionSummaryPropertyDescription(text),
		},
		mode,
	);
}

export function structuredOutputRepairMessages(error: StructuredOutputRepairError): ChatMessage[] {
	const text = error.text;
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
					? text.format("compaction.self_correction.tool", { toolName: error.requiredToolName })
					: text.format("compaction.self_correction.structured"),
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

function toolRequirementInstruction(text: BotText, tools: readonly ProviderToolDefinition[]): string {
	const controlTools = providerControlInstructionTools(tools);
	const names = providerToolNames(controlTools).join(text.format('formatting.listSeparator'));
	const prefix = names ? text.format("compaction.tools.require_one_of", { toolNames: names }) : text.format("compaction.tools.require_any");
	const metaInstruction = tools.some(isMetaCompactionToolDefinition)
		? text.format("compaction.tools.meta_only_when_directed", { toolName: providerCompactionToolName })
		: '';
	return metaInstruction ? `${prefix}${text.format("formatting.sentenceSeparator")}${metaInstruction}` : prefix;
}

export function toolRequirementSelfCorrection(text: BotText, tools: readonly ProviderToolDefinition[]): string {
	const names = providerToolNames(providerControlInstructionTools(tools)).join(text.format('formatting.listSeparator'));
	return names ? text.format("compaction.tools.self_correction_one_of", { toolNames: names }) : text.format("compaction.tools.self_correction_any");
}

export function appendToolRequirementInstruction(text: BotText, content: string, tools: readonly ProviderToolDefinition[]): string {
	return `${content}\n\n${toolRequirementInstruction(text, tools)}`;
}

export function providerMessagesWithPrefillCompatibility(text: BotText,
	settings: { baseUrl?: string; model: string; supportsPrefill?: boolean },
	messages: ChatMessage[],
): ChatMessage[] {
	const prepared = providerMessagesWithInitialUserContext(text, messages);
	const last = prepared[prepared.length - 1];
	return settings.supportsPrefill !== true && last?.role === 'assistant' ? [...prepared, providerContinuationMessage(text)] : prepared;
}

function providerMessagesWithInitialUserContext(text: BotText, messages: ChatMessage[]): ChatMessage[] {
	const insertionIndex = messages[0]?.role === 'system' ? 1 : -1;
	if (insertionIndex < 0 || initialUserContextMessage(text, messages[insertionIndex])) {
		return messages;
	}
	return [...messages.slice(0, insertionIndex), providerContinuationMessage(text), ...messages.slice(insertionIndex)];
}

function providerContinuationMessage(text: BotText): ChatMessage {
	return { role: 'user', content: providerContinuationMessageContent(text) };
}

function initialUserContextMessage(text: BotText, message: ChatMessage | undefined): boolean {
	return message?.role === 'user' && (message.content === legacyProviderContinuationMessageContent || text.isContinuation(message.content));
}
