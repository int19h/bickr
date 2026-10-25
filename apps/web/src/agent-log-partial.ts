import { agentLogReasoningDetailKey, type AgentLogPartialResponse, type AgentLogReasoningDetail, type AgentLogReasoningPart, type AgentLogStreamDelta } from '@bickr/shared/model';

export function emptyAgentLogPartial(): AgentLogPartialResponse {
	return { content: '', reasoning: '', reasoningParts: [], toolCalls: [] };
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function classifiedReasoningPart(value: unknown): AgentLogReasoningPart {
	const part = record(value);
	if (part.kind === 'text') return { kind: 'text', text: typeof part.text === 'string' ? part.text : '' };
	const type = typeof part.type === 'string' ? part.type : null;
	const identity = {
		...(typeof part.index === 'number' && Number.isSafeInteger(part.index) ? { index: part.index } : {}),
		...(typeof part.id === 'string' ? { id: part.id } : {}),
	};
	if (part.kind === 'readable' && (type === 'reasoning.text' || type === 'reasoning.summary')) {
		return { kind: 'readable', type, text: typeof part.text === 'string' ? part.text : '', ...identity };
	}
	return { kind: 'opaque', type, ...identity };
}

export function parseAgentLogPartial(text: string | null): AgentLogPartialResponse {
	if (!text) return emptyAgentLogPartial();
	let value: unknown;
	try { value = JSON.parse(text); } catch { return { ...emptyAgentLogPartial(), content: text }; }
	const item = record(value);
	// Old partials have no proven readable source. The runtime retires this shape at schema version 2.
	const reasoningParts = Array.isArray(item.reasoningParts) ? item.reasoningParts.map(classifiedReasoningPart)
		: typeof item.reasoning === 'string' && item.reasoning ? [{ kind: 'opaque' as const, type: null }] : [];
	return {
		content: typeof item.content === 'string' ? item.content : '',
		reasoning: reasoningParts.map(part => part.kind === 'opaque' ? '' : part.text).join(''),
		reasoningParts,
		toolCalls: Array.isArray(item.toolCalls) ? item.toolCalls.map(value => {
			const part = record(value), fn = record(part.function);
			return {
				...(typeof part.index === 'number' ? { index: part.index } : {}),
				...(typeof part.id === 'string' ? { id: part.id } : {}),
				...(typeof part.type === 'string' ? { type: part.type } : {}),
				function: { ...(typeof fn.name === 'string' ? { name: fn.name } : {}), ...(typeof fn.arguments === 'string' ? { arguments: fn.arguments } : {}) },
			};
		}) : [],
	};
}

export function appendAgentLogDelta(partial: AgentLogPartialResponse, delta: AgentLogStreamDelta): AgentLogPartialResponse {
	switch (delta.kind) {
		case 'content': return { ...partial, content: partial.content + delta.text };
		case 'tool_call': return { ...partial, toolCalls: [...partial.toolCalls, delta.part] };
		case 'reasoning': {
			const part = classifiedReasoningPart(delta.source === 'plain' ? { kind: 'text', text: delta.text } : delta.part);
			const parts = [...partial.reasoningParts];
			const key = part.kind === 'text' ? null : agentLogReasoningDetailKey(part);
			const last = parts.at(-1);
			if (part.kind === 'text' && last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + part.text };
			else if (part.kind === 'readable' && last?.kind === 'readable' && key !== null && key === agentLogReasoningDetailKey(last)) {
				parts[parts.length - 1] = { ...last, ...part, text: last.text + part.text };
			} else if (part.kind !== 'opaque' || key === null || !parts.some(existing => existing.kind === 'opaque' && agentLogReasoningDetailKey(existing) === key)) parts.push(part);
			return { ...partial, reasoningParts: parts, reasoning: partial.reasoning + (part.kind === 'opaque' ? '' : part.text) };
		}
	}
}

export function readablePartIdentity(part: AgentLogReasoningDetail): string {
	return agentLogReasoningDetailKey(part) ?? JSON.stringify([part.type, 'default']);
}
