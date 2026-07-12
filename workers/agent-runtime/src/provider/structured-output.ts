import type { BotInferenceSubmissionToolCall } from '@bickr/shared/model';
import {
	defaultProviderCompactionSummaryLimits,
	providerCompactionToolName,
	transcriptLikeCompactionSummaryLine,
	type ProviderCompactionMode,
	type ProviderSingleStringResponseSpec,
} from '../compaction/engine';
import {
	estimateChatMessageTokens,
	maxCalibratedTokensPerCharacter,
	minCalibratedTokensPerCharacter,
} from '../compaction/limits';
import { providerTranslationMaxCompletionTokens, providerTranslationToolName } from '../constants';
import { ProviderStructuredOutputValidationError } from '../errors';
import {
	providerCompactionSummaryProperty,
	providerCompactionSummaryPropertyDescription,
	providerCompactionSummarySchemaDescription,
} from '../prompt-and-tools';
import { providerMessageTextContent } from '../provider-requests';
import type {
	ProviderCompactionSummaryLimits,
	ProviderCompactionValidationLimits,
} from '../types';

export type ProviderStructuredOutputRuntime = {
	clampNumber(value: number, min: number, max: number): number;
	runtimeRecord(value: unknown): Record<string, unknown>;
	storedCompactionSummary(summary: string): string;
	stringValue(value: unknown): string | undefined;
};

type ProviderCompactionReductionCheck = (summary: string) => {
	compactedTokens: number;
	reduces: boolean;
	replacementTokens: number;
};

export function createProviderStructuredOutput(runtime: ProviderStructuredOutputRuntime) {
	const { clampNumber, runtimeRecord, storedCompactionSummary, stringValue } = runtime;

	function providerCompactionSummarySpec(
		limits: Pick<ProviderCompactionSummaryLimits, 'maxLength'> &
			Partial<Pick<ProviderCompactionSummaryLimits, 'compactedCharacterCount' | 'tokensPerCharacter'>>,
	): ProviderSingleStringResponseSpec {
		return {
			kind: 'compaction',
			property: providerCompactionSummaryProperty,
			label: providerCompactionSummaryProperty,
			maxCharacters: limits.maxLength,
			schemaDescription: providerCompactionSummarySchemaDescription,
			propertyDescription: providerCompactionSummaryPropertyDescription,
			reduction: providerCompactionReductionCheck(limits),
			toolName: providerCompactionToolName,
		};
	}

	function providerCompactionSummaryFromResponseMessage(
		message: unknown,
		rawResponse: string,
		limits: ProviderCompactionValidationLimits = defaultProviderCompactionSummaryLimits,
		mode: ProviderCompactionMode = 'structured_output',
	): string {
		return providerSingleStringResponseFromMessage(message, providerCompactionSummarySpec(limits), rawResponse, mode);
	}

	function providerTranslationFromToolMessage(message: unknown, rawResponse: string): string {
		return providerSingleStringResponseFromMessage(
			message,
			{
				kind: 'translation',
				property: 'translation',
				label: 'translation',
				maxCharacters: providerTranslationMaxCompletionTokens * 8,
				toolName: providerTranslationToolName,
			},
			rawResponse,
			'tool_call',
		).trim();
	}

	function providerSingleStringResponseFromMessage(
		message: unknown,
		spec: ProviderSingleStringResponseSpec,
		rawResponse: string,
		mode: ProviderCompactionMode,
	): string {
		if (mode === 'structured_output') {
			return providerStructuredOutputFromMessageContent(message, spec, rawResponse);
		}
		if (!spec.toolName) {
			throw new Error(`Provider single-string response ${spec.kind} requires a tool name for tool-call mode.`);
		}
		return providerStructuredOutputFromToolMessage(message, spec as ProviderSingleStringResponseSpec & { toolName: string }, rawResponse);
	}

	function providerStructuredOutputFromMessageContent(
		messageValue: unknown,
		spec: ProviderSingleStringResponseSpec,
		rawResponse: string,
	): string {
		const message = runtimeRecord(messageValue);
		const toolCalls = Array.isArray(message.tool_calls)
			? message.tool_calls.map(providerToolCallFromValue).filter((toolCall): toolCall is BotInferenceSubmissionToolCall => Boolean(toolCall))
			: [];
		if (toolCalls.length > 0) {
			const repairMessage =
				spec.kind === 'compaction'
					? "META: don't make any tool calls. You must reply with the structured detailed first-person summary strictly following the required JSON schema."
					: `Do not use a Bickr control for this response. Reply with the required JSON object containing only ${spec.property}.`;
			throw new ProviderStructuredOutputValidationError(spec.kind, repairMessage, {
				rawResponse,
				outputText: providerMessageTextContent(message.content),
				toolCalls,
			});
		}
		const content = providerMessageTextContent(message.content);
		if (!content) {
			throw new ProviderStructuredOutputValidationError(spec.kind, `The ${spec.label} response was empty.`, { rawResponse });
		}
		const parsed = parseProviderStructuredMessageContent(content, spec, rawResponse);
		return providerStructuredOutputPropertyFromRecord(parsed, spec, rawResponse, []);
	}

	function parseProviderStructuredMessageContent(
		content: string,
		spec: Pick<ProviderSingleStringResponseSpec, 'kind' | 'label' | 'property'>,
		rawResponse: string,
	): unknown {
		const repairCandidates = new Set<string>();
		try {
			return JSON.parse(content) as unknown;
		} catch {
			const firstBrace = content.indexOf('{');
			const lastBrace = content.lastIndexOf('}');
			if (firstBrace >= 0 && lastBrace > firstBrace) {
				const candidate = content.slice(firstBrace, lastBrace + 1);
				try {
					return JSON.parse(candidate) as unknown;
				} catch {
					repairCandidates.add(candidate);
				}
			}
			repairCandidates.add(content);
			for (const candidate of repairCandidates) {
				const repaired = repairSingleStringStructuredJsonObject(candidate, spec.property);
				if (repaired) {
					return repaired;
				}
			}
		}
		throw new ProviderStructuredOutputValidationError(spec.kind, `The ${spec.label} response must be a JSON object.`, {
			rawResponse,
			...(spec.kind === 'compaction' ? {} : { outputText: content }),
		});
	}

	function repairSingleStringStructuredJsonObject(source: string, property: string): Record<string, string> | null {
		const text = source.trim();
		let index = 0;
		if (text[index] !== '{') {
			return null;
		}
		index = skipJsonWhitespace(text, index + 1);
		const key = readJsonStringToken(text, index);
		if (!key || key.value !== property) {
			return null;
		}
		index = skipJsonWhitespace(text, key.end);
		if (text[index] !== ':') {
			return null;
		}
		index = skipJsonWhitespace(text, index + 1);
		if (text[index] !== '"') {
			return null;
		}
		const valueStart = index + 1;
		const objectEnd = lastNonWhitespaceIndex(text);
		if (objectEnd <= valueStart || text[objectEnd] !== '}') {
			return null;
		}
		let closingQuote = objectEnd - 1;
		while (closingQuote >= valueStart && isJsonWhitespace(text[closingQuote] ?? '')) {
			closingQuote -= 1;
		}
		if (closingQuote < valueStart || text[closingQuote] !== '"' || isEscapedJsonStringQuote(text, closingQuote)) {
			return null;
		}
		if (text.slice(closingQuote + 1, objectEnd).trim()) {
			return null;
		}
		const rawValue = text.slice(valueStart, closingQuote);
		if (looksLikeAdditionalJsonMember(rawValue)) {
			return null;
		}
		return { [property]: decodeLooseJsonStringContent(rawValue) };
	}

	function readJsonStringToken(text: string, start: number): { value: string; end: number } | null {
		if (text[start] !== '"') {
			return null;
		}
		for (let index = start + 1; index < text.length; index += 1) {
			if (text[index] === '"' && !isEscapedJsonStringQuote(text, index)) {
				try {
					const value = JSON.parse(text.slice(start, index + 1)) as unknown;
					return typeof value === 'string' ? { value, end: index + 1 } : null;
				} catch {
					return null;
				}
			}
		}
		return null;
	}

	function decodeLooseJsonStringContent(value: string): string {
		let decoded = '';
		for (let index = 0; index < value.length; ) {
			const char = value[index];
			if (char !== '\\') {
				decoded += char ?? '';
				index += 1;
				continue;
			}
			const escaped = value[index + 1];
			if (escaped === undefined) {
				decoded += '\\';
				index += 1;
				continue;
			}
			switch (escaped) {
				case '"':
				case '\\':
				case '/':
					decoded += escaped;
					index += 2;
					break;
				case 'b':
					decoded += '\b';
					index += 2;
					break;
				case 'f':
					decoded += '\f';
					index += 2;
					break;
				case 'n':
					decoded += '\n';
					index += 2;
					break;
				case 'r':
					decoded += '\r';
					index += 2;
					break;
				case 't':
					decoded += '\t';
					index += 2;
					break;
				case 'u': {
					const hex = value.slice(index + 2, index + 6);
					if (/^[0-9a-fA-F]{4}$/.test(hex)) {
						decoded += String.fromCharCode(Number.parseInt(hex, 16));
						index += 6;
					} else {
						decoded += '\\u';
						index += 2;
					}
					break;
				}
				default:
					decoded += `\\${escaped}`;
					index += 2;
					break;
			}
		}
		return decoded;
	}

	function looksLikeAdditionalJsonMember(rawValue: string): boolean {
		for (let index = 0; index < rawValue.length; index += 1) {
			if (rawValue[index] !== '"' || isEscapedJsonStringQuote(rawValue, index)) {
				continue;
			}
			let next = skipJsonWhitespace(rawValue, index + 1);
			if (rawValue[next] === ',') {
				next = skipJsonWhitespace(rawValue, next + 1);
			}
			const key = readJsonStringToken(rawValue, next);
			if (!key) {
				continue;
			}
			const afterKey = skipJsonWhitespace(rawValue, key.end);
			if (rawValue[afterKey] === ':') {
				return true;
			}
		}
		return false;
	}

	function skipJsonWhitespace(text: string, index: number): number {
		while (index < text.length && isJsonWhitespace(text[index] ?? '')) {
			index += 1;
		}
		return index;
	}

	function lastNonWhitespaceIndex(text: string): number {
		for (let index = text.length - 1; index >= 0; index -= 1) {
			if (!isJsonWhitespace(text[index] ?? '')) {
				return index;
			}
		}
		return -1;
	}

	function isJsonWhitespace(char: string): boolean {
		return char === ' ' || char === '\n' || char === '\r' || char === '\t';
	}

	function isEscapedJsonStringQuote(text: string, quoteIndex: number): boolean {
		let slashCount = 0;
		for (let index = quoteIndex - 1; index >= 0 && text[index] === '\\'; index -= 1) {
			slashCount += 1;
		}
		return slashCount % 2 === 1;
	}

	function providerStructuredOutputFromToolMessage(
		messageValue: unknown,
		spec: ProviderSingleStringResponseSpec & { toolName: string },
		rawResponse: string,
	): string {
		const message = runtimeRecord(messageValue);
		const toolCalls = Array.isArray(message.tool_calls)
			? message.tool_calls.map(providerToolCallFromValue).filter((toolCall): toolCall is BotInferenceSubmissionToolCall => Boolean(toolCall))
			: [];
		const errorOptions = { rawResponse, requiredToolName: spec.toolName, toolCalls };
		if (toolCalls.length === 0) {
			throw new ProviderStructuredOutputValidationError(spec.kind, `No ${spec.toolName} tool call was returned.`, errorOptions);
		}
		const wrongToolCall = toolCalls.find((toolCall) => toolCall.function.name !== spec.toolName);
		if (wrongToolCall) {
			throw new ProviderStructuredOutputValidationError(
				spec.kind,
				`Only ${spec.toolName} may be used for this request; ${wrongToolCall.function.name || 'unknown'} cannot be used here.`,
				{
					rawResponse,
					requiredToolName: spec.toolName,
					toolCalls,
				},
			);
		}
		if (toolCalls.length !== 1) {
			throw new ProviderStructuredOutputValidationError(
				spec.kind,
				`Expected exactly one ${spec.toolName} tool call, but received ${toolCalls.length}.`,
				{
					rawResponse,
					requiredToolName: spec.toolName,
					toolCalls,
				},
			);
		}
		const [toolCall] = toolCalls;
		if (toolCall.function.name !== spec.toolName) {
			throw new ProviderStructuredOutputValidationError(
				spec.kind,
				`Expected tool ${spec.toolName}, but received ${toolCall.function.name || 'unknown'}.`,
				{
					rawResponse,
					requiredToolName: spec.toolName,
					toolCalls,
				},
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(toolCall.function.arguments);
		} catch {
			throw new ProviderStructuredOutputValidationError(spec.kind, `The ${spec.toolName} arguments were not valid JSON.`, {
				rawResponse,
				requiredToolName: spec.toolName,
				toolCalls,
			});
		}
		return providerStructuredOutputPropertyFromRecord(parsed, spec, rawResponse, toolCalls);
	}

	function providerStructuredOutputPropertyFromRecord(
		parsed: unknown,
		spec: ProviderSingleStringResponseSpec,
		rawResponse: string,
		toolCalls: BotInferenceSubmissionToolCall[],
	): string {
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new ProviderStructuredOutputValidationError(
				spec.kind,
				spec.toolName ? `The ${spec.toolName} arguments must be a JSON object.` : 'The structured output must be a JSON object.',
				{
					rawResponse,
					requiredToolName: spec.toolName,
					toolCalls,
				},
			);
		}
		const record = runtimeRecord(parsed);
		const keys = Object.keys(record);
		const extraKeys = keys.filter((key) => key !== spec.property);
		if (extraKeys.length > 0) {
			throw new ProviderStructuredOutputValidationError(
				spec.kind,
				`Unexpected ${spec.toolName ? 'argument' : 'field'} ${extraKeys.join(', ')}; only ${spec.property} is allowed.`,
				{
					rawResponse,
					requiredToolName: spec.toolName,
					toolCalls,
				},
			);
		}
		const value = record[spec.property];
		if (typeof value !== 'string' || value.trim().length === 0) {
			throw new ProviderStructuredOutputValidationError(spec.kind, `The ${spec.label} argument must be a non-empty string.`, {
				rawResponse,
				requiredToolName: spec.toolName,
				toolCalls,
			});
		}
		if (spec.kind === 'compaction') {
			const transcriptLine = transcriptLikeCompactionSummaryLine(value);
			if (transcriptLine) {
				throw new ProviderStructuredOutputValidationError(
					spec.kind,
					`The ${spec.label} argument must be ordinary first-person prose, not a transcript or runtime-event line (${JSON.stringify(transcriptLine)}). Regenerate the summary without labeled Action:, Result:, Input:, or New thought: lines.`,
					{
						rawResponse,
						requiredToolName: spec.toolName,
						toolCalls,
						outputText: value,
						validationIssue: 'transcript_like_compaction',
					},
				);
			}
		}
		const minCharacters = Math.max(0, Math.floor(spec.minCharacters ?? 0));
		if (value.length < minCharacters) {
			throw new ProviderStructuredOutputValidationError(
				spec.kind,
				`The ${spec.label} argument must be at least ${minCharacters} characters.`,
				{
					rawResponse,
					requiredToolName: spec.toolName,
					toolCalls,
				},
			);
		}
		const reduction = spec.reduction?.(value);
		if (reduction && !reduction.reduces) {
			throw new ProviderStructuredOutputValidationError(
				spec.kind,
				`The ${spec.label} argument did not reduce the compacted context (${reduction.replacementTokens} estimated replacement tokens vs ${reduction.compactedTokens} compacted tokens).`,
				{
					rawResponse,
					requiredToolName: spec.toolName,
					toolCalls,
					outputText: value,
					validationIssue: 'non_reducing_compaction',
				},
			);
		}
		if (value.length > spec.maxCharacters && !reduction) {
			throw new ProviderStructuredOutputValidationError(
				spec.kind,
				`The ${spec.label} argument must be at most ${spec.maxCharacters} characters.`,
				{
					rawResponse,
					requiredToolName: spec.toolName,
					toolCalls,
					outputText: value,
				},
			);
		}
		return value;
	}

	function providerCompactionReductionCheck(
		limits: Partial<Pick<ProviderCompactionSummaryLimits, 'compactedCharacterCount' | 'tokensPerCharacter'>>,
	): ProviderCompactionReductionCheck | undefined {
		const compactedCharacters = Number(limits.compactedCharacterCount);
		const tokensPerCharacter = Number(limits.tokensPerCharacter);
		if (
			!Number.isFinite(compactedCharacters) ||
			compactedCharacters <= 0 ||
			!Number.isFinite(tokensPerCharacter) ||
			tokensPerCharacter <= 0
		) {
			return undefined;
		}
		const calibration = {
			tokensPerCharacter: clampNumber(tokensPerCharacter, minCalibratedTokensPerCharacter, maxCalibratedTokensPerCharacter),
			sampleCount: 0,
		};
		const compactedTokens = Math.max(1, Math.ceil(Math.floor(compactedCharacters) * calibration.tokensPerCharacter));
		return (summary: string) => {
			const replacementTokens = estimateChatMessageTokens({ role: 'assistant', content: storedCompactionSummary(summary) }, calibration);
			return {
				compactedTokens,
				replacementTokens,
				reduces: replacementTokens < compactedTokens,
			};
		};
	}

	function providerToolCallFromValue(value: unknown, index = 0): BotInferenceSubmissionToolCall | null {
		const record = runtimeRecord(value);
		const fn = runtimeRecord(record.function);
		const name = stringValue(fn.name);
		const args = stringValue(fn.arguments);
		if (!name || args === undefined) {
			return null;
		}
		return {
			id: stringValue(record.id) ?? `call_recovered_${index}`,
			type: 'function',
			function: {
				name,
				arguments: args,
			},
		};
	}

	return {
		providerCompactionSummaryFromResponseMessage,
		providerCompactionSummarySpec,
		providerSingleStringResponseFromMessage,
		providerTranslationFromToolMessage,
	};
}
