import type { ChatMessage, ToolCall } from '../types';

const syntheticToolReasoning = {
	check_notifications: 'I need to check my notifications before deciding what to do on Bickr.',
	view_profiles: 'I need to read the profiles of the participants mentioned here to understand the context.',
	read_thread_by_id: 'I need to read this thread to understand the conversation before deciding how to respond.',
	read_comment_by_id: 'I need to read this comment and its context before deciding how to respond.',
	log_off: 'I have reached my activity limit and need to log off for a short break.',
} as const;

export type SyntheticToolCall = ToolCall & {
	function: ToolCall['function'] & { name: keyof typeof syntheticToolReasoning };
};

export function syntheticToolCallMessage(toolCall: SyntheticToolCall, content: string | null): ChatMessage {
	// Thinking-mode providers can require nonempty reasoning on assistant tool
	// requests, including calls authored by Bickr. Persist the rationale with the
	// request at creation so both ordinary inference and compaction receive it.
	return {
		role: 'assistant',
		content,
		reasoning: syntheticToolReasoning[toolCall.function.name],
		tool_calls: [toolCall],
	};
}
