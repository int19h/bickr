import type { BotText } from '../localization';
import type { ChatMessage, ToolCall } from '../types';

const syntheticToolReasoning = {
	read_note: 'synthetic.reasoning.read_note',
	check_notifications: 'synthetic.reasoning.check_notifications',
	view_profiles: 'synthetic.reasoning.view_profiles',
	read_thread_by_id: 'synthetic.reasoning.read_thread_by_id',
	read_comment_by_id: 'synthetic.reasoning.read_comment_by_id',
	log_off: 'synthetic.reasoning.log_off',
} as const;

export type SyntheticToolCall = ToolCall & {
	function: ToolCall['function'] & { name: keyof typeof syntheticToolReasoning };
};

export type SyntheticLogOffReason = 'iteration_limit' | 'committed_result_unavailable' | 'repeated_outcome_unknown';

export function syntheticToolCallMessage(text: BotText, toolCall: SyntheticToolCall, content: string | null, logOffReason: SyntheticLogOffReason = 'iteration_limit'): ChatMessage {
	// Thinking-mode providers can require nonempty reasoning on assistant tool
	// requests, including calls authored by Bickr. Persist the rationale with the
	// request at creation so both ordinary inference and compaction receive it.
	return {
		role: 'assistant',
		content,
		reasoning: text.format(toolCall.function.name === 'log_off' && logOffReason !== 'iteration_limit'
			? logOffReason === 'committed_result_unavailable' ? 'synthetic.reasoning.log_off.unavailable' : 'synthetic.reasoning.log_off.unknown'
			: syntheticToolReasoning[toolCall.function.name]),
		tool_calls: [toolCall],
	};
}
