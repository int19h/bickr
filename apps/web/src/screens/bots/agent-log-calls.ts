import type { AgentLogEntry, BotLoopMessage } from '@bickr/shared/model';
import type { LoopToolCall, LoopToolCallContext } from '../../readable/loop-message-readable';
import { loopToolCallsById } from '../../readable/loop-message-values';
import { storedResponseMessage } from './agent-log-content';

type Call = { number: number; call: LoopToolCall; context?: LoopToolCallContext; row?: BotLoopMessage };

export function indexAgentLogCalls(ordered: AgentLogEntry[]) {
	const calls = new Map<AgentLogEntry, Call[]>();
	const results = new Map<AgentLogEntry, Call>();
	const pending = new Map<string, Call>();
	let number = 0;
	for (const entry of ordered) {
		if (entry.kind !== 'message' && entry.kind !== 'live') continue;
		const message = entry.kind === 'message' ? entry.message.message : storedResponseMessage(entry.response ?? entry.partialResponse);
		const runId = entry.kind === 'message' ? entry.message.runId : entry.runId;
		const row = entry.kind === 'message' ? entry.message : undefined;
		if (message.tool_call_id) {
			const link = pending.get(JSON.stringify([runId, message.tool_call_id]));
			if (link) {
				results.set(entry, link);
				link.context = loopToolCallsById([...(link.row ? [link.row] : []), ...(row ? [row] : [])]).get(message.tool_call_id);
			}
		}
		const links = (message.tool_calls ?? []).map((call) => {
			const link: Call = { number: ++number, call, row, context: row ? loopToolCallsById([row]).get(call.id) : undefined };
			// Providers can reuse call IDs. Bind each result to the preceding call in its visit.
			pending.set(JSON.stringify([runId, call.id]), link);
			return link;
		});
		calls.set(entry, links);
	}
	return { calls, results };
}
