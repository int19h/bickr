import type { BotInferenceSubmissionMessage } from '@bickr/shared/model';
import { ReadableToolCall, type LoopToolCallContext } from '../../readable/loop-message-readable';

// Stored responses use a provider envelope. Stream snapshots use content and toolCalls.
export function storedResponseMessage(text: string | null): BotInferenceSubmissionMessage {
	if (!text) return { role: 'assistant', content: null };
	try {
		const value = JSON.parse(text);
		const message = value?.message ?? value;
		if (
			!message ||
			typeof message !== 'object' ||
			!(
				'content' in message ||
				'reasoning' in message ||
				'reasoning_content' in message ||
				'reasoning_details' in message ||
				'tool_calls' in message ||
				'toolCalls' in message
			)
		)
			return { role: 'assistant', content: text };
		return {
			role: 'assistant',
			content: typeof message.content === 'string' ? message.content : null,
			reasoning: typeof message.reasoning === 'string' ? message.reasoning : undefined,
			reasoning_content: typeof message.reasoning_content === 'string' ? message.reasoning_content : undefined,
			reasoning_details: Array.isArray(message.reasoning_details) ? message.reasoning_details : undefined,
			tool_calls: Array.isArray(message.tool_calls)
				? message.tool_calls
				: Array.isArray(message.toolCalls)
					? streamedToolCalls(message.toolCalls)
					: undefined,
		};
	} catch {
		return { role: 'assistant', content: text };
	}
}

function streamedToolCalls(parts: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
	const calls = new Map<number, NonNullable<BotInferenceSubmissionMessage['tool_calls']>[number]>();
	for (const part of parts) {
		const index = part.index ?? 0;
		const call = calls.get(index) ?? {
			id: part.id ?? `stream-call-${index}`,
			type: 'function' as const,
			function: { name: '', arguments: '' },
		};
		if (part.id) call.id = part.id;
		call.function.name += part.function?.name ?? '';
		call.function.arguments += part.function?.arguments ?? '';
		calls.set(index, call);
	}
	return [...calls.values()];
}

export { LoopReasoning as AgentLogReasoning } from '../../readable/loop-reasoning';

export function AgentLogCall({
	number,
	call,
	context,
	active,
	onActive,
}: {
	number: number;
	call: NonNullable<BotInferenceSubmissionMessage['tool_calls']>[number];
	context?: LoopToolCallContext;
	active: boolean;
	onActive: (active: boolean) => void;
}) {
	return (
		<div
			className={`agent-log-call${active ? ' call-highlight' : ''}`}
			id={`loop-call-${number}`}
			onMouseEnter={() => onActive(true)}
			onMouseLeave={() => onActive(false)}
			onFocus={() => onActive(true)}
			onBlur={() => onActive(false)}
		>
			<a className="agent-log-call-number" href={`#loop-result-${number}`} aria-label={`Open result of call ${number}`}>
				{number}
			</a>
			<ReadableToolCall toolCall={call} context={context} />
		</div>
	);
}
