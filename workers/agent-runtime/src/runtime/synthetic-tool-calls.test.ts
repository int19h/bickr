import { describe, expect, it } from 'vitest';
import { BotRuntime } from './bot-runtime';
import { sanitizeProviderMessagesForRequest } from '../provider/sanitize';
import type { ChatMessage, LoopMessageGroupEntry } from '../types';
import { syntheticToolCallMessage, type SyntheticToolCall } from './synthetic-tool-calls';

function call(name: SyntheticToolCall['function']['name']): SyntheticToolCall {
	return { id: `synthetic_test_${name}`, type: 'function', function: { name, arguments: '{}' } };
}

describe('authored synthetic tool reasoning', () => {
	it.each(['check_notifications', 'view_profiles', 'read_thread_by_id', 'read_comment_by_id', 'log_off'] as const)(
		'preserves %s reasoning when preparing provider requests and rewriting IDs', (name) => {
			const toolCall = call(name);
			const original = syntheticToolCallMessage(toolCall, null);
			const result: ChatMessage = { role: 'tool', tool_call_id: toolCall.id, content: '{}' };
			const [assistant, tool] = sanitizeProviderMessagesForRequest([original, result]);
			expect(assistant?.reasoning).toEqual(expect.stringMatching(/\S/));
			expect(assistant?.reasoning).toBe(original.reasoning);
			expect(assistant?.tool_calls?.[0]?.id).not.toBe(toolCall.id);
			expect(tool?.tool_call_id).toBe(assistant?.tool_calls?.[0]?.id);
			expect(original.tool_calls?.[0]?.id).toBe(toolCall.id);
		},
	);

	it('persists reasoning with the synthetic activity-limit logoff', async () => {
		const entries: LoopMessageGroupEntry[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			hasRuntimeStorage: () => false,
			appendEvent: () => {},
			executeTool: async () => ({ providerResult: { loggedOff: true } }),
			appendLoopMessageGroup: (group: LoopMessageGroupEntry[]) => entries.push(...group),
		});
		await runtime.appendSyntheticLimitLogOff({ language: 'en' }, 'run', {});
		expect(entries[0]?.message.tool_calls?.[0]?.function.name).toBe('log_off');
		expect(entries[0]?.message.reasoning).toEqual(expect.stringMatching(/\S/));
	});

	it('persists reasoning on every injected request, including later profile calls with no visible narration', () => {
		const entries: LoopMessageGroupEntry[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendLoopMessageGroup: (group: LoopMessageGroupEntry[]) => entries.push(...group),
		});
		const calls = [call('check_notifications'), call('view_profiles')];
		runtime.appendToolCallChainLoopMessages('run', 'synthetic_context', 'Checking notifications.', calls,
			calls.map((request) => ({ role: 'tool', tool_call_id: request.id, content: '{}' })));
		const assistants = entries.filter((entry) => entry.message.role === 'assistant');
		expect(assistants).toHaveLength(2);
		expect(assistants[1]?.message.content).toBeNull();
		for (const entry of assistants) expect(entry.message.reasoning).toEqual(expect.stringMatching(/\S/));
	});
});
