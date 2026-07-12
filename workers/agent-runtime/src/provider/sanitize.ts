import type {
	BotInferenceSubmissionMessage as ChatMessage,
	BotInferenceSubmissionToolCall,
	BotLoopMessageOrigin,
} from '@bickr/shared/model';
import { loopMessageChatMessageFromRow } from '../compaction/selection';
import { ToolCallArgumentValidationError } from '../errors';
import type {
	DroppedProviderToolCall,
	FollowToolTarget,
	LegacyProviderToolCallHistoryNormalization,
	LegacyProviderToolCallHistoryNormalizationOperation,
	LegacyProviderToolCallHistoryNormalizationOrderItem,
	LoopMessageRow,
	ProviderResponse,
	ProviderToolCallDropReason,
	ProviderToolCallSanitization,
	RepairedProviderToolCall,
	ReasoningDetail,
	ToolCall,
} from '../types';
import { hasProviderHistoryText } from './sse';

type InvalidUnicodeRepair<T> = {
	value: T;
	repairCount: number;
};

export type ProviderSanitizeRuntime = {
	canonicalToolName(name: string): string;
	followToolArgsWithTargets(args: Record<string, unknown>, targets: FollowToolTarget[]): Record<string, unknown>;
	followToolTargetsForProviderDedupe(args: Record<string, unknown>): {
		targets: FollowToolTarget[];
		removedLocalDuplicate: boolean;
	};
	parseToolArgs(toolCall: ToolCall): Record<string, unknown>;
	parseToolArgsWithDiagnostics(toolCall: ToolCall): {
		args: Record<string, unknown>;
		repairs: Array<Pick<RepairedProviderToolCall, 'field' | 'leakedArgumentKey' | 'reason' | 'removedSuffix'>>;
	};
	providerToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown>;
	runtimeRecord(value: unknown): Record<string, unknown>;
	safeContextText(text: string, limit: number): string;
	stringValue(value: unknown): string | undefined;
};

export function repairInvalidUnicodeText(text: string): string {
	let repaired = '';
	let lastCopiedIndex = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (isHighSurrogate(code)) {
			const nextCode = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
			if (isLowSurrogate(nextCode)) {
				index += 1;
				continue;
			}
			repaired += `${text.slice(lastCopiedIndex, index)}\uFFFD`;
			lastCopiedIndex = index + 1;
			continue;
		}
		if (isLowSurrogate(code)) {
			repaired += `${text.slice(lastCopiedIndex, index)}\uFFFD`;
			lastCopiedIndex = index + 1;
		}
	}
	return lastCopiedIndex === 0 ? text : repaired + text.slice(lastCopiedIndex);
}

export function repairInvalidUnicodeValue<T>(value: T): InvalidUnicodeRepair<T> {
	if (typeof value === 'string') {
		const repaired = repairInvalidUnicodeText(value);
		return {
			value: repaired as T,
			repairCount: repaired === value ? 0 : 1,
		};
	}
	if (Array.isArray(value)) {
		let repairCount = 0;
		let changed = false;
		const repaired = value.map((item) => {
			const itemRepair = repairInvalidUnicodeValue(item);
			repairCount += itemRepair.repairCount;
			if (itemRepair.repairCount > 0) {
				changed = true;
			}
			return itemRepair.value;
		});
		return {
			value: (changed ? repaired : value) as T,
			repairCount,
		};
	}
	if (value && typeof value === 'object') {
		let repairCount = 0;
		let changed = false;
		const repaired: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			const itemRepair = repairInvalidUnicodeValue(item);
			repaired[key] = itemRepair.value;
			repairCount += itemRepair.repairCount;
			if (itemRepair.repairCount > 0) {
				changed = true;
			}
		}
		return {
			value: (changed ? repaired : value) as T,
			repairCount,
		};
	}
	return { value, repairCount: 0 };
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

export function unicodeSafeSlice(text: string, end: number): string {
	const repaired = repairInvalidUnicodeText(text);
	if (repaired.length <= end) {
		return repaired;
	}
	const safeEnd = Math.max(0, end);
	const adjustedEnd = safeEnd > 0 && isHighSurrogate(repaired.charCodeAt(safeEnd - 1)) ? safeEnd - 1 : safeEnd;
	return repaired.slice(0, adjustedEnd);
}

export function sanitizeProviderMessagesForRequest(messages: readonly ChatMessage[]): ChatMessage[] {
	const sanitized = sanitizeProviderMessageSequenceForRequest(messages.map(sanitizeProviderMessageForRequest));
	assertNoInvalidUnicodeValue(sanitized, 'provider request messages');
	return sanitized;
}

function sanitizeProviderMessageForRequest(message: ChatMessage): ChatMessage {
	return flattenDeepProviderToolResultContent(ensureAssistantContentForProviderRequest(repairProviderMessageUnicode(message).value));
}

function sanitizeProviderMessageSequenceForRequest(messages: readonly ChatMessage[]): ChatMessage[] {
	const sanitized: ChatMessage[] = [];
	let nextToolCallId = 1;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]!;
		if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
			sanitized.push(message);
			continue;
		}

		const rewrittenIdsByOriginal = new Map<string, string[]>();
		const retainedToolCalls = message.tool_calls.map((toolCall) => {
			// Some providers reject long IDs that only differ late in the string. Compact
			// request-local IDs keep the cacheable prefix stable as new messages append.
			const id = providerRequestToolCallId(nextToolCallId);
			nextToolCallId += 1;
			const ids = rewrittenIdsByOriginal.get(toolCall.id) ?? [];
			ids.push(id);
			rewrittenIdsByOriginal.set(toolCall.id, ids);
			return id === toolCall.id ? toolCall : { ...cloneToolCall(toolCall), id };
		});
		const toolMessages: ChatMessage[] = [];
		let scan = index + 1;
		while (scan < messages.length) {
			const candidate = messages[scan]!;
			if (candidate.role !== 'tool') {
				break;
			}
			if (candidate.tool_call_id) {
				const rewrittenIds = rewrittenIdsByOriginal.get(candidate.tool_call_id);
				const rewrittenId = rewrittenIds?.shift();
				toolMessages.push({
					...candidate,
					tool_call_id: rewrittenId ?? candidate.tool_call_id,
				});
			} else {
				toolMessages.push(candidate);
			}
			scan += 1;
		}

		sanitized.push({ ...message, tool_calls: retainedToolCalls });
		sanitized.push(...toolMessages);
		index = scan - 1;
	}
	return sanitized;
}

function providerRequestToolCallId(index: number): string {
	return `call_${index}`;
}

const providerToolResultJsonMaxStructuredDepth = 32;

function flattenDeepProviderToolResultContent(message: ChatMessage): ChatMessage {
	if (message.role !== 'tool' || typeof message.content !== 'string') {
		return message;
	}
	const flattenedContent = providerToolResultContentForRequest(message.content);
	return flattenedContent === message.content ? message : { ...message, content: flattenedContent };
}

function providerToolResultContentForRequest(content: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content) as unknown;
	} catch {
		return content;
	}
	if (jsonStructuredDepth(parsed) <= providerToolResultJsonMaxStructuredDepth) {
		return content;
	}
	// Google-backed OpenRouter tool responses reject deeply nested function response
	// JSON with INVALID_ARGUMENT. Keep the provider-facing shape shallow while
	// preserving the exact tool result text for the participant.
	return JSON.stringify({ text: content });
}

function jsonStructuredDepth(value: unknown): number {
	let maxDepth = 0;
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	while (stack.length > 0) {
		const current = stack.pop()!;
		const item = current.value;
		if (!item || typeof item !== 'object') {
			continue;
		}
		const depth = current.depth + 1;
		maxDepth = Math.max(maxDepth, depth);
		if (Array.isArray(item)) {
			for (const child of item) {
				stack.push({ value: child, depth });
			}
			continue;
		}
		for (const child of Object.values(item)) {
			stack.push({ value: child, depth });
		}
	}
	return maxDepth;
}

function repairProviderMessageUnicode(message: ChatMessage): InvalidUnicodeRepair<ChatMessage> {
	const messageRepair = repairInvalidUnicodeValue(message);
	let repairedMessage = messageRepair.value;
	let repairCount = messageRepair.repairCount;
	if (repairedMessage.role === 'tool' && typeof repairedMessage.content === 'string') {
		const contentRepair = repairJsonStringUnicode(repairedMessage.content);
		if (contentRepair.repairCount > 0) {
			repairedMessage = { ...repairedMessage, content: contentRepair.value };
			repairCount += contentRepair.repairCount;
		}
	}
	if (Array.isArray(repairedMessage.tool_calls) && repairedMessage.tool_calls.length > 0) {
		const repairedToolCalls = repairToolCallArgumentUnicode(repairedMessage.tool_calls);
		if (repairedToolCalls.repairCount > 0) {
			repairedMessage = { ...repairedMessage, tool_calls: repairedToolCalls.toolCalls };
			repairCount += repairedToolCalls.repairCount;
		}
	}
	return { value: repairedMessage, repairCount };
}

function ensureAssistantContentForProviderRequest(message: ChatMessage): ChatMessage {
	if (message.role !== 'assistant' || typeof message.content === 'string') {
		return message;
	}
	return { ...message, content: '' };
}

function repairJsonStringUnicode(text: string): InvalidUnicodeRepair<string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return { value: text, repairCount: 0 };
	}
	const repair = repairInvalidUnicodeValue(parsed);
	if (repair.repairCount === 0) {
		return { value: text, repairCount: 0 };
	}
	return { value: JSON.stringify(repair.value), repairCount: repair.repairCount };
}

function repairToolCallArgumentUnicode(toolCalls: readonly ToolCall[]): { toolCalls: ToolCall[]; repairCount: number } {
	let repairCount = 0;
	let changed = false;
	const repairedToolCalls = toolCalls.map((toolCall) => {
		const rawArguments = toolCall.function.arguments;
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawArguments) as unknown;
		} catch {
			return toolCall;
		}
		const argumentRepair = repairInvalidUnicodeValue(parsed);
		if (argumentRepair.repairCount === 0) {
			return toolCall;
		}
		repairCount += argumentRepair.repairCount;
		changed = true;
		return toolCallWithArguments(toolCall, JSON.stringify(argumentRepair.value));
	});
	return { toolCalls: changed ? repairedToolCalls : [...toolCalls], repairCount };
}

function assertNoInvalidUnicodeValue(value: unknown, label: string): void {
	if (invalidUnicodePath(value)) {
		throw new Error(`${label} still contains invalid Unicode.`);
	}
}

export function stringifyProviderRequest(value: unknown): string {
	assertNoInvalidUnicodeValue(value, 'provider request');
	return JSON.stringify(value);
}

function invalidUnicodePath(value: unknown): boolean {
	if (typeof value === 'string') {
		return repairInvalidUnicodeText(value) !== value;
	}
	if (Array.isArray(value)) {
		return value.some(invalidUnicodePath);
	}
	if (value && typeof value === 'object') {
		return Object.values(value).some(invalidUnicodePath);
	}
	return false;
}

export function loopMessageContributesToProviderHistory(
	origin: BotLoopMessageOrigin,
	message: ChatMessage,
): boolean {
	if (origin === 'runtime_error') {
		return false;
	}
	return origin !== 'provider_response' || !isEmptyProviderAssistantMessage(message);
}

function isEmptyProviderAssistantMessage(message: ChatMessage): boolean {
	return (
		message.role === 'assistant' &&
		!hasProviderHistoryText(message.content) &&
		!hasProviderHistoryText(message.reasoning) &&
		!hasProviderHistoryText(message.reasoning_content) &&
		(!Array.isArray(message.reasoning_details) || message.reasoning_details.length === 0) &&
		(!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)
	);
}

function toolCallWithArguments(toolCall: ToolCall, args: string): ToolCall {
	return {
		id: toolCall.id,
		type: toolCall.type,
		function: {
			name: toolCall.function.name,
			arguments: args,
		},
	};
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
	return toolCallWithArguments(toolCall, toolCall.function.arguments);
}

export function createProviderSanitize(runtime: ProviderSanitizeRuntime) {
	const {
		canonicalToolName,
		followToolArgsWithTargets,
		followToolTargetsForProviderDedupe,
		parseToolArgs,
		parseToolArgsWithDiagnostics,
		providerToolArgs,
		runtimeRecord,
		safeContextText,
		stringValue,
	} = runtime;

	function providerResponseMessageForHistory(response: {
		content?: string;
		reasoning?: string;
		reasoningDetails?: Record<string, unknown>[];
		toolCalls?: BotInferenceSubmissionToolCall[];
	}): ChatMessage | null {
		const content = repairInvalidUnicodeText(response.content ?? '');
		const reasoning = repairInvalidUnicodeText(response.reasoning ?? '');
		const reasoningDetails = normalizeReasoningDetailsForProviderHistory(response.reasoningDetails ?? []);
		const toolCalls = response.toolCalls ?? [];
		if (!hasProviderHistoryText(content) && !hasProviderHistoryText(reasoning) && reasoningDetails.length === 0 && toolCalls.length === 0) {
			return null;
		}
		const message: ChatMessage = { role: 'assistant' };
		if (hasProviderHistoryText(content)) {
			message.content = content;
		} else if (toolCalls.length > 0) {
			message.content = null;
		}
		if (toolCalls.length > 0) {
			message.tool_calls = toolCalls;
		}
		if (reasoningDetails.length > 0) {
			message.reasoning_details = reasoningDetails;
		} else if (hasProviderHistoryText(reasoning)) {
			message.reasoning = reasoning;
		}
		return message;
	}

	function providerResponseToolCallMessageForHistory(
		message: ChatMessage,
		toolCall: ToolCall,
		includeResponseContext: boolean,
	): ChatMessage {
		if (!includeResponseContext) {
			return {
				role: 'assistant',
				content: null,
				tool_calls: [cloneToolCall(toolCall)],
			};
		}
		const splitMessage: ChatMessage = {
			...message,
			tool_calls: [cloneToolCall(toolCall)],
		};
		if (!hasProviderHistoryText(splitMessage.content)) {
			splitMessage.content = null;
		}
		return splitMessage;
	}

	function normalizeReasoningDetailsForProviderHistory(details: readonly unknown[]): ReasoningDetail[] {
		const normalized: ReasoningDetail[] = [];
		for (const detail of details) {
			const record = repairInvalidUnicodeValue({ ...runtimeRecord(detail) }).value;
			const last = normalized[normalized.length - 1];
			if (
				last &&
				record.type === 'reasoning.text' &&
				last.type === 'reasoning.text' &&
				typeof record.text === 'string' &&
				typeof last.text === 'string' &&
				record.index === last.index &&
				record.format === last.format
			) {
				last.text += record.text;
				continue;
			}
			normalized.push(record);
		}
		return normalized;
	}

	function reasoningDetailsEqual(left: readonly unknown[] | undefined, right: readonly unknown[]): boolean {
		if (!left || left.length !== right.length) {
			return !left && right.length === 0;
		}
		for (let index = 0; index < left.length; index += 1) {
			if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
				return false;
			}
		}
		return true;
	}

	function sanitizeProviderToolCalls(toolCalls: readonly BotInferenceSubmissionToolCall[]): ProviderToolCallSanitization {
		const sanitized: ToolCall[] = [];
		const dropped: DroppedProviderToolCall[] = [];
		const repaired: RepairedProviderToolCall[] = [];
		const seenIds = new Set<string>();
		let repairedTextCount = 0;
		for (const toolCall of toolCalls) {
			const functionRecord = runtimeRecord(toolCall.function);
			const rawId = typeof toolCall.id === 'string' && toolCall.id.length > 0 ? toolCall.id : '';
			const id = repairInvalidUnicodeText(rawId);
			if (id !== rawId) {
				repairedTextCount += 1;
			}
			const rawName = stringValue(functionRecord.name) ?? '';
			const name = repairInvalidUnicodeText(rawName);
			if (name !== rawName) {
				repairedTextCount += 1;
			}
			const rawArguments = functionRecord.arguments;
			if (!id) {
				dropped.push(droppedProviderToolCall(id, name, 'missing_tool_call_id', rawArguments));
				continue;
			}
			if (!name) {
				dropped.push(droppedProviderToolCall(id, name, 'missing_function_name', rawArguments));
				continue;
			}
			const argumentText = providerToolCallArgumentsText(rawArguments);
			const argumentTextRepair = repairInvalidUnicodeValue(argumentText);
			repairedTextCount += argumentTextRepair.repairCount;
			let parsedArguments: ReturnType<ProviderSanitizeRuntime['parseToolArgsWithDiagnostics']>;
			try {
				parsedArguments = parseToolArgsWithDiagnostics({
					id,
					type: 'function',
					function: { name, arguments: argumentTextRepair.value },
				});
			} catch (error) {
				if (error instanceof ToolCallArgumentValidationError && error.code === 'arguments_not_json_object') {
					dropped.push(droppedProviderToolCall(id, name, 'arguments_not_json_object', rawArguments));
				} else {
					dropped.push(droppedProviderToolCall(id, name, 'invalid_arguments_json', rawArguments));
				}
				continue;
			}
			const parsedRepair = repairInvalidUnicodeValue(parsedArguments.args);
			repairedTextCount += parsedRepair.repairCount;
			const argumentObject = parsedRepair.value;
			repaired.push(...parsedArguments.repairs.map((repair) => ({ id, name, ...repair })));
			if (seenIds.has(id)) {
				dropped.push(droppedProviderToolCall(id, name, 'duplicate_tool_call', rawArguments));
				continue;
			}
			seenIds.add(id);
			sanitized.push({
				id,
				type: 'function',
				function: {
					name,
					arguments: JSON.stringify(argumentObject),
				},
			});
		}
		return { toolCalls: sanitized, dropped, repaired, repairedTextCount };
	}

	function providerToolCallArgumentsText(rawArguments: unknown): string {
		if (typeof rawArguments === 'string') {
			return rawArguments;
		}
		if (rawArguments === undefined || rawArguments === null) {
			return '';
		}
		return JSON.stringify(rawArguments) ?? '';
	}

	function sanitizeProviderResponseToolCalls(response: ProviderResponse): {
		response: ProviderResponse;
		dropped: DroppedProviderToolCall[];
		repaired: RepairedProviderToolCall[];
		originalToolCallCount: number;
	} {
		const originalToolCallCount = response.toolCalls.length;
		const sanitized = sanitizeProviderToolCalls(response.toolCalls);
		const deduped = dedupeGeneratedFollowToolCalls(sanitized.toolCalls);
		const dropped = [...sanitized.dropped, ...deduped.dropped];
		if (toolCallsEqual(response.toolCalls, deduped.toolCalls)) {
			return { response, dropped, repaired: sanitized.repaired, originalToolCallCount };
		}
		return {
			response: { ...response, toolCalls: deduped.toolCalls },
			dropped,
			repaired: sanitized.repaired,
			originalToolCallCount,
		};
	}

	function dedupeGeneratedFollowToolCalls(toolCalls: readonly ToolCall[]): { toolCalls: ToolCall[]; dropped: DroppedProviderToolCall[] } {
		const deduped: ToolCall[] = [];
		const dropped: DroppedProviderToolCall[] = [];
		const seen = new Set<string>();
		for (const toolCall of toolCalls) {
			const canonical = canonicalToolName(toolCall.function.name);
			if (canonical !== 'follow_profile' && canonical !== 'unfollow_profile') {
				deduped.push(toolCall);
				continue;
			}
			let args: Record<string, unknown>;
			let parsed: { targets: FollowToolTarget[]; removedLocalDuplicate: boolean };
			try {
				args = parseToolArgs(toolCall);
				parsed = followToolTargetsForProviderDedupe(args);
			} catch {
				deduped.push(toolCall);
				continue;
			}

			const effectiveTargets: FollowToolTarget[] = [];
			for (const target of parsed.targets) {
				const key = `${canonical}:${target.username}`;
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				effectiveTargets.push(target);
			}
			if (effectiveTargets.length === 0) {
				dropped.push(droppedProviderToolCall(toolCall.id, toolCall.function.name, 'duplicate_tool_call', toolCall.function.arguments));
				continue;
			}
			if (parsed.removedLocalDuplicate || effectiveTargets.length !== parsed.targets.length) {
				deduped.push(
					toolCallWithArguments(toolCall, JSON.stringify(providerToolArgs(canonical, followToolArgsWithTargets(args, effectiveTargets)))),
				);
				continue;
			}
			deduped.push(toolCall);
		}
		return { toolCalls: deduped, dropped };
	}

	function droppedProviderToolCall(
		id: string | undefined,
		name: string | undefined,
		reason: ProviderToolCallDropReason,
		rawArguments: unknown,
	): DroppedProviderToolCall {
		return {
			id: id ?? '',
			name: name ?? '',
			reason,
			argumentsPreview: providerToolCallArgumentsPreview(rawArguments),
		};
	}

	function providerToolCallArgumentsPreview(rawArguments: unknown): string {
		const text = typeof rawArguments === 'string' ? rawArguments : rawArguments === undefined ? '' : JSON.stringify(rawArguments);
		return safeContextText(text ?? '', 500);
	}

	function toolCallsEqual(left: readonly ToolCall[], right: readonly ToolCall[]): boolean {
		if (left.length !== right.length) {
			return false;
		}
		for (let index = 0; index < left.length; index += 1) {
			const leftCall = left[index];
			const rightCall = right[index];
			if (
				!leftCall ||
				!rightCall ||
				leftCall.id !== rightCall.id ||
				leftCall.type !== rightCall.type ||
				leftCall.function.name !== rightCall.function.name ||
				leftCall.function.arguments !== rightCall.function.arguments
			) {
				return false;
			}
		}
		return true;
	}

	function normalizeLegacyProviderToolCallHistoryRows(rows: readonly LoopMessageRow[]): LegacyProviderToolCallHistoryNormalization {
		const operations: LegacyProviderToolCallHistoryNormalizationOperation[] = [];
		const order: LegacyProviderToolCallHistoryNormalizationOrderItem[] = [];
		const deletedSeqs = new Set<number>();
		const updatedSeqs = new Set<number>();
		const dropped: DroppedProviderToolCall[] = [];
		let repairedTextCount = 0;
		const repairedMessageSeqs = new Set<number>();
		const deleteRow = (seq: number): void => {
			if (deletedSeqs.has(seq)) {
				return;
			}
			deletedSeqs.add(seq);
			operations.push({ kind: 'delete', seq });
		};
		const updateRow = (seq: number, message: ChatMessage): void => {
			if (deletedSeqs.has(seq) || updatedSeqs.has(seq)) {
				return;
			}
			updatedSeqs.add(seq);
			operations.push({ kind: 'update', seq, message });
		};
		const keepExistingRow = (seq: number): void => {
			if (!deletedSeqs.has(seq)) {
				order.push({ kind: 'existing', seq });
			}
		};
		const insertAssistantBeforeTool = (sourceRow: LoopMessageRow, message: ChatMessage, pairIndex: number): void => {
			const id = `legacy-tool-call-history:${sourceRow.seq}:${pairIndex}`;
			operations.push({ kind: 'insert', id, sourceRow, message });
			order.push({ kind: 'insert', id });
		};

		for (let index = 0; index < rows.length; index += 1) {
			const row = rows[index];
			if (!row) {
				continue;
			}
			const current = { row, message: loopMessageChatMessageFromRow(row) };
			if (!loopMessageContributesToProviderHistory(row.origin, current.message)) {
				keepExistingRow(row.seq);
				continue;
			}
			if (!current) {
				continue;
			}
			let message = current.message;
			let repairedMessage: ChatMessage | null = null;
			const unicodeRepair = repairProviderMessageUnicode(message);
			if (unicodeRepair.repairCount > 0) {
				message = unicodeRepair.value;
				current.message = message;
				repairedMessage = message;
				repairedTextCount += unicodeRepair.repairCount;
				repairedMessageSeqs.add(current.row.seq);
			}
			if (message.role === 'tool') {
				deleteRow(current.row.seq);
				continue;
			}
			if (message.role !== 'assistant') {
				if (repairedMessage) {
					updateRow(current.row.seq, repairedMessage);
				}
				keepExistingRow(current.row.seq);
				continue;
			}

			const originalReasoningDetails = Array.isArray(message.reasoning_details) ? message.reasoning_details : undefined;
			if (originalReasoningDetails) {
				const normalizedReasoningDetails = normalizeReasoningDetailsForProviderHistory(originalReasoningDetails);
				if (!reasoningDetailsEqual(originalReasoningDetails, normalizedReasoningDetails)) {
					repairedMessage = { ...(repairedMessage ?? message), reasoning_details: normalizedReasoningDetails };
					message = repairedMessage;
					current.message = message;
				}
			}
			if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
				if (repairedMessage) {
					if (isEmptyProviderAssistantMessage(repairedMessage)) {
						deleteRow(current.row.seq);
					} else {
						updateRow(current.row.seq, repairedMessage);
						keepExistingRow(current.row.seq);
					}
				} else {
					keepExistingRow(current.row.seq);
				}
				continue;
			}

			const originalToolCalls = message.tool_calls;
			const sanitized = sanitizeProviderToolCalls(originalToolCalls);
			if (sanitized.repairedTextCount > 0) {
				repairedTextCount += sanitized.repairedTextCount;
				repairedMessageSeqs.add(current.row.seq);
			}
			dropped.push(...sanitized.dropped);
			const availableCallCounts = new Map<string, number>();
			for (const toolCall of sanitized.toolCalls) {
				availableCallCounts.set(toolCall.id, (availableCallCounts.get(toolCall.id) ?? 0) + 1);
			}
			const answeredRowsByCallId = new Map<string, Array<{ row: LoopMessageRow; message: ChatMessage }>>();
			let lookahead = index + 1;
			while (lookahead < rows.length) {
				const candidateRow = rows[lookahead];
				if (!candidateRow) {
					break;
				}
				const candidateMessage = loopMessageChatMessageFromRow(candidateRow);
				if (!loopMessageContributesToProviderHistory(candidateRow.origin, candidateMessage) || candidateMessage.role !== 'tool') {
					break;
				}
				let retainedToolMessage = candidateMessage;
				const candidateRepair = repairProviderMessageUnicode(candidateMessage);
				if (candidateRepair.repairCount > 0) {
					retainedToolMessage = candidateRepair.value;
					repairedTextCount += candidateRepair.repairCount;
					repairedMessageSeqs.add(candidateRow.seq);
				}
				const toolCallId = typeof retainedToolMessage.tool_call_id === 'string' ? retainedToolMessage.tool_call_id : '';
				const answeredRows = answeredRowsByCallId.get(toolCallId) ?? [];
				const availableCount = availableCallCounts.get(toolCallId) ?? 0;
				if (toolCallId && answeredRows.length < availableCount) {
					answeredRows.push({ row: candidateRow, message: retainedToolMessage });
					answeredRowsByCallId.set(toolCallId, answeredRows);
					if (candidateRepair.repairCount > 0) {
						updateRow(candidateRow.seq, retainedToolMessage);
					}
				} else {
					deleteRow(candidateRow.seq);
				}
				lookahead += 1;
			}

			const pairedToolCalls: Array<{ toolCall: ToolCall; toolRow: LoopMessageRow; toolMessage: ChatMessage }> = [];
			for (const toolCall of sanitized.toolCalls) {
				const answeredRows = answeredRowsByCallId.get(toolCall.id) ?? [];
				const answered = answeredRows.shift();
				if (answered) {
					pairedToolCalls.push({ toolCall, toolRow: answered.row, toolMessage: answered.message });
				} else {
					dropped.push(droppedProviderToolCall(toolCall.id, toolCall.function.name, 'unanswered_tool_call', toolCall.function.arguments));
				}
			}

			repairedMessage = repairedMessage ?? { ...message };
			if (pairedToolCalls.length === 0) {
				delete repairedMessage.tool_calls;
				if (isEmptyProviderAssistantMessage(repairedMessage)) {
					deleteRow(current.row.seq);
				} else {
					updateRow(current.row.seq, repairedMessage);
					keepExistingRow(current.row.seq);
				}
				index = lookahead - 1;
				continue;
			}

			for (let pairIndex = 0; pairIndex < pairedToolCalls.length; pairIndex += 1) {
				const pair = pairedToolCalls[pairIndex]!;
				const assistantMessage = providerResponseToolCallMessageForHistory(repairedMessage, pair.toolCall, pairIndex === 0);
				if (pairIndex === 0) {
					if (JSON.stringify(loopMessageChatMessageFromRow(current.row)) !== JSON.stringify(assistantMessage)) {
						updateRow(current.row.seq, assistantMessage);
					}
					keepExistingRow(current.row.seq);
				} else {
					insertAssistantBeforeTool(current.row, assistantMessage, pairIndex);
				}
				if (JSON.stringify(loopMessageChatMessageFromRow(pair.toolRow)) !== JSON.stringify(pair.toolMessage)) {
					updateRow(pair.toolRow.seq, pair.toolMessage);
				}
				keepExistingRow(pair.toolRow.seq);
			}
			index = lookahead - 1;
		}

		return { operations, order, dropped, repairedTextCount, repairedMessageSeqs: [...repairedMessageSeqs] };
	}

	function providerToolCallHistoryInvariantViolation(rows: readonly LoopMessageRow[]): string | null {
		const providerRows = rows
			.map((row) => ({ row, message: loopMessageChatMessageFromRow(row) }))
			.filter(({ row, message }) => loopMessageContributesToProviderHistory(row.origin, message));
		for (let index = 0; index < providerRows.length; index += 1) {
			const current = providerRows[index]!;
			const { message } = current;
			if (message.role === 'tool') {
				return `tool row ${current.row.seq} has no immediately preceding assistant tool call`;
			}
			if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
				continue;
			}
			if (message.tool_calls.length !== 1) {
				return `assistant row ${current.row.seq} has ${message.tool_calls.length} tool calls`;
			}
			const [toolCall] = message.tool_calls;
			const next = providerRows[index + 1];
			if (!next || next.message.role !== 'tool') {
				return `assistant row ${current.row.seq} is not followed by a tool result`;
			}
			if (next.message.tool_call_id !== toolCall.id) {
				return `assistant row ${current.row.seq} tool call ${toolCall.id} is followed by tool row ${next.row.seq} for ${next.message.tool_call_id ?? 'missing id'}`;
			}
			index += 1;
		}
		return null;
	}

	return {
		droppedProviderToolCall,
		normalizeLegacyProviderToolCallHistoryRows,
		normalizeReasoningDetailsForProviderHistory,
		providerResponseMessageForHistory,
		providerResponseToolCallMessageForHistory,
		providerToolCallHistoryInvariantViolation,
		sanitizeProviderResponseToolCalls,
		sanitizeProviderToolCalls,
		toolCallWithArguments,
	};
}
