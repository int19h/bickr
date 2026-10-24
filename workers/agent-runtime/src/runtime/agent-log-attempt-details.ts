import { RepositoryError } from '@bickr/shared/repository';
import type { BotLoopMessageRequestUsage, BotLoopMessageRequestLogMessage, BotInferenceSubmissionMessage, InferenceAttribution } from '@bickr/shared/model';
import { parseInferenceAttribution } from '@bickr/shared/inference-attribution';
import { estimateChatMessageTokens, fallbackTokensPerCharacter } from '../compaction/limits';

export type AttemptUsageRow = { prompt_tokens: number; cached_tokens: number; completion_tokens: number; total_tokens: number; cost: number | null; usage_json: string };
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }

export function attemptUsage(row: AttemptUsageRow): BotLoopMessageRequestUsage {
	let raw: Record<string, unknown> = {};
	try {
		raw = record(JSON.parse(row.usage_json));
	} catch {
		raw = {};
	}
	const costDetails = record(raw.cost_details);
	const totalCost = row.cost ?? numberValue(raw.cost) ?? null;
	let promptCost = numberValue(costDetails.upstream_inference_prompt_cost) ?? null;
	let outputCost = numberValue(costDetails.upstream_inference_completions_cost) ?? null;
	if (promptCost === null && totalCost !== null && outputCost !== null) {
		promptCost = Math.max(0, totalCost - outputCost);
	}
	if (outputCost === null && totalCost !== null && promptCost !== null) {
		outputCost = Math.max(0, totalCost - promptCost);
	}
	const cachedInputTokens = Math.min(row.prompt_tokens, Math.max(0, row.cached_tokens));
	const uncachedInputTokens = Math.max(0, row.prompt_tokens - cachedInputTokens);
	const cachedInputCost = promptCost === null ? null : row.prompt_tokens > 0 ? promptCost * (cachedInputTokens / row.prompt_tokens) : 0;
	const uncachedInputCost =
		promptCost === null ? null : row.prompt_tokens > 0 ? promptCost * (uncachedInputTokens / row.prompt_tokens) : 0;
	return {
		promptTokens: row.prompt_tokens,
		cachedInputTokens,
		uncachedInputTokens,
		outputTokens: row.completion_tokens,
		totalTokens: row.total_tokens,
		cachedInputCost,
		uncachedInputCost,
		outputCost,
		totalCost,
		estimatedCostSplit: promptCost !== null && cachedInputTokens > 0 && uncachedInputTokens > 0,
	};
}

function string(value: unknown): string {
	if (typeof value !== 'string') throw new Error('The request message has an unsupported shape.');
	return value;
}

function requestMessage(value: unknown): BotInferenceSubmissionMessage {
	const item = record(value);
	const role = item.role;
	if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') throw new Error('The request message role is unsupported.');
	return {
		role,
		...(item.content === undefined ? {} : { content: item.content === null ? null : string(item.content) }),
		...(item.tool_call_id === undefined ? {} : { tool_call_id: string(item.tool_call_id) }),
		...(item.reasoning === undefined ? {} : { reasoning: string(item.reasoning) }),
		...(item.reasoning_content === undefined ? {} : { reasoning_content: string(item.reasoning_content) }),
		...(item.tool_calls === undefined ? {} : { tool_calls: list(item.tool_calls).map(value => {
			const call = record(value);
			if (call.type !== 'function') throw new Error('The request tool call type is unsupported.');
			const fn = record(call.function);
			return { id: string(call.id), type: 'function' as const, function: { name: string(fn.name), arguments: string(fn.arguments) } };
		}) }),
		...(item.reasoning_details === undefined ? {} : { reasoning_details: list(item.reasoning_details).map(value => {
			const detail = record(value);
			if (detail.type !== 'reasoning.text' && detail.type !== 'reasoning.summary' && detail.type !== 'reasoning.encrypted') throw new Error('The request reasoning type is unsupported.');
			return {
				type: detail.type,
				...(detail.id === undefined ? {} : { id: detail.id === null ? null : string(detail.id) }),
				...(detail.format === undefined ? {} : { format: string(detail.format) }),
				...(detail.index === undefined ? {} : { index: finiteNumber(detail.index) }),
				...(detail.text === undefined ? {} : { text: string(detail.text) }),
				...(detail.summary === undefined ? {} : { summary: string(detail.summary) }),
				...(detail.data === undefined ? {} : { data: string(detail.data) }),
				...(detail.signature === undefined ? {} : { signature: string(detail.signature) }),
			};
		}) }),
	};
}

function list(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error('The request message list is unsupported.');
	return value;
}
function finiteNumber(value: unknown): number {
	const number = numberValue(value);
	if (number === undefined) throw new Error('The request reasoning index is unsupported.');
	return number;
}

export function attemptMessages(body: string | null, usage: BotLoopMessageRequestUsage | null): BotLoopMessageRequestLogMessage[] {
	if (body === null) return [];
	try {
		const source = list(record(JSON.parse(body)).messages);
		const messages = source.map(requestMessage);
		let consumed = 0;
		return messages.map((message, index) => {
			const start = consumed;
			// Count opaque reasoning fields from the sent body, even when the API does not expose them.
			const details = record(source[index]).reasoning_details;
			const counted = details === undefined ? message : { ...message, reasoning_details: list(details) };
			consumed += estimateChatMessageTokens(counted, { tokensPerCharacter: fallbackTokensPerCharacter, sampleCount: 0 });
			const cached = usage?.cachedInputTokens ?? 0;
			const cacheStatus = cached <= start ? undefined : cached >= consumed ? 'cached' : 'partially_cached';
			return { message, position: index + 1, ...(cacheStatus ? { cacheStatus } : {}) };
		});
	} catch { return []; }
}

export function attemptAttribution(value: unknown): InferenceAttribution | null {
	if (value === null || value === undefined) return null;
	try {
		const source = record(record(value).source);
		const attribution = parseInferenceAttribution(value, string(source.botId));
		if (!attribution) return null;
		return { model: attribution.model, parameters: attribution.parameters, source: { botId: attribution.source.botId, worldHandle: attribution.source.worldHandle, botHandle: attribution.source.botHandle, runId: attribution.source.runId, requestSeq: attribution.source.requestSeq } };
	} catch { throw new RepositoryError('conflict', 'The stored inference attribution has an unsupported shape.', 409); }
}
