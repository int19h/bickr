import { unknownToolOutcomeMessage } from './tool-recovery';
import type { BotText } from '../localization';
import type { ToolBatchOutcomeItem } from '../errors';
import type { ProviderSerializationContext } from './tool-results';
import { providerToolResultPayload } from './tool-results';
import type { ToolFailurePayload } from '../types';

export type ProviderBatchOutcomeItem =
	| { kind: 'recorded'; target: string; result: unknown }
	| { kind: 'committed'; target: string; message: string }
	| { kind: 'refused'; target: string; message: string; guidance?: string }
	| { kind: 'unknown' | 'not_attempted'; target: string; message: string };

export function providerBatchOutcome(
	text: BotText, name: string, items: readonly ToolBatchOutcomeItem[], context: ProviderSerializationContext,
	failure: (args: Record<string, unknown>, error: unknown) => ToolFailurePayload,
): { kind: 'batch_outcome'; items: ProviderBatchOutcomeItem[]; guidance: string } {
	return { kind: 'batch_outcome', items: items.map((item): ProviderBatchOutcomeItem => {
		switch (item.kind) {
			case 'recorded': {
				const raw = item.envelope.kind === 'vote_set' ? item.envelope.votes : item.envelope.profiles;
				return { kind: 'recorded', target: item.target, result: providerToolResultPayload(name, raw, {}, context, {}, item.envelope) };
			}
			case 'committed': return { kind: 'committed', target: item.target, message: text.formatDescriptor(item.issue) };
			case 'refused': {
				const rendered = failure(item.args, item.error);
				return { kind: 'refused', target: item.target, message: rendered.message, ...(rendered.guidance ? { guidance: rendered.guidance } : {}) };
			}
			case 'unknown': return { kind: 'unknown', target: item.target, message: unknownToolOutcomeMessage(text, name) };
			case 'not_attempted': return { kind: 'not_attempted', target: item.target, message: text.format('recovery.batch.notAttempted') };
		}
	}), guidance: text.format('recovery.batch.guidance') };
}
