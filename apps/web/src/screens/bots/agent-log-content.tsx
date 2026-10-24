import type { BotInferenceSubmissionMessage } from '@bickr/shared/model';
import { useLayoutEffect, useRef, useState } from 'react';
import { reasoningDetailsTextForDisplay } from '../../reasoning-formatting';
import { LoopMarkdown } from '../../readable/loop-markdown';
import { ReadableToolCall, type LoopToolCallContext } from '../../readable/loop-message-readable';
import { Icon } from '../../ui';

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

export function AgentLogReasoning({ message }: { message: BotInferenceSubmissionMessage }) {
	const text = [
		message.reasoning,
		message.reasoning_content,
		message.reasoning_details
			? reasoningDetailsTextForDisplay(message.reasoning_details) || JSON.stringify(message.reasoning_details)
			: null,
	]
		.filter(Boolean)
		.join('\n\n');
	const ref = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState(false);
	const [long, setLong] = useState(false);
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		const measure = () => setLong(node.scrollHeight > 126);
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [text]);
	if (!text) return null;
	return (
		<section className="agent-log-reasoning">
			<div className="agent-log-reasoning-label">
				<Icon name="think" size={13} /> Reasoning
			</div>
			<div className={expanded ? '' : 'agent-log-reasoning-clamp'} ref={ref}>
				<LoopMarkdown text={text} />
			</div>
			{long && (
				<button aria-expanded={expanded} onClick={() => setExpanded(!expanded)} type="button">
					{expanded ? 'less' : 'more'}
				</button>
			)}
		</section>
	);
}

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
