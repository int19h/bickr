import { InstructionTemplates } from '@bickr/shared/instruction-template';
import { createInlineRenderers, type RenderContext } from '../../../workers/agent-runtime/src/localization/result-template.ts';
import { messageParameters } from './result-messages.ts';

export const catalog = new InstructionTemplates('en', messageParameters, {
	label: 'Result', ref: 'Ref {{ref}}', count: { one: '{{count}} item', other: '{{count}} items' },
	person: { self: 'I posted', other: '{{author}} posted' },
	vote: { up: 'up {{state}}', down: 'down {{state}}', cleared: 'cleared {{state}}' },
});
const marks = new InstructionTemplates('en', {
	open: { kind: 'text', parameters: [] }, close: { kind: 'text', parameters: [] },
} as const, { open: '「', close: '」' });
const base = { catalog, quotationMarks: { open: marks.format('open'), close: marks.format('close') } };
export const context: RenderContext<typeof messageParameters> = { ...base, inline: createInlineRenderers(base) };
