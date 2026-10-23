import type { InstructionArguments, MessageDescriptor } from '@bickr/shared/instruction-template';
import type { BotText } from '../localization';
import { messageParameters } from '../localization/messages';
import { canonicalToolName } from './tool-args';

export type ResultText =
	| { kind: 'literal'; value: string }
	| { kind: 'message'; key: keyof typeof messageParameters; parameters: Record<string, string | number> }
	| { kind: 'sequence'; parts: ResultText[] };

/** A result stores the catalog key and its declared parameters. */
export function resultMessage<Key extends keyof typeof messageParameters>(key: Key, ...args: InstructionArguments<typeof messageParameters[Key]>): ResultText {
	const parameters = (args[0] ?? {}) as Record<string, string | number>;
	return { kind: 'message', key, parameters: Object.fromEntries(messageParameters[key].parameters.map(name => [name, parameters[name]!])) };
}
export function resultDescriptor(descriptor: MessageDescriptor<typeof messageParameters>): ResultText {
	return { kind: 'message', key: descriptor.key, parameters: Object.fromEntries(messageParameters[descriptor.key].parameters.map(name => [name, (descriptor.parameters as Record<string, string | number>)[name]!])) };
}
export function renderResultText(recipe: ResultText, text: BotText): string {
	switch (recipe.kind) {
		case 'literal': return recipe.value;
		case 'message': return (text.format as (key: keyof typeof messageParameters, parameters: Record<string, string | number>) => string)(recipe.key, recipe.parameters);
		case 'sequence': return recipe.parts.map(part => renderResultText(part, text)).join('');
	}
}
export function unknownOutcomeText(name: string): ResultText {
	switch (canonicalToolName(name)) {
		case 'create_thread': return resultMessage('recovery.unknown.thread');
		case 'reply_to_comment': case 'make_additional_reply_to_the_same_comment': case 'vote': return resultMessage('recovery.unknown.comment');
		case 'follow_profile': case 'unfollow_profile': return resultMessage('recovery.unknown.profile');
		case 'write_note': case 'delete_note': return resultMessage('recovery.unknown.note');
		default: return resultMessage('recovery.unknown.page');
	}
}
export function readContextText(decision: { operation: string; tokenBudget: number; omittedReplyCount: number; trimmedBodyCount: number }): ResultText {
	const collapsed = decision.omittedReplyCount > 0, trimmed = decision.trimmedBodyCount > 0;
	const base = resultMessage(collapsed && trimmed ? 'read.context.collapsed_and_trimmed' : collapsed ? 'read.context.collapsed' : trimmed ? 'read.context.trimmed' : 'read.context.basic', { operation: decision.operation, tokenBudget: decision.tokenBudget });
	if (!collapsed && !trimmed) return base;
	return { kind: 'sequence', parts: [base, resultMessage('formatting.sentenceSeparator'), resultMessage(collapsed && trimmed ? 'read.guidance.both' : collapsed ? 'read.guidance.collapsed' : 'read.guidance.trimmed', { ellipsis: '…' })] };
}
