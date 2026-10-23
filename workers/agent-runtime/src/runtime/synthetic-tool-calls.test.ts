import { renderToolResultView } from './tool-result-views';
import { toolResultViewForMessage } from './result-messages';
import { testResultContext } from './result-render-context.test-support';
import { ResultContextScope } from './result-context-scope';
import { botText } from '../localization';
const text = botText('en');
import { describe, expect, it } from 'vitest';
import { BotRuntime, parseSpotlightSyntheticContext } from './bot-runtime';
import { sanitizeProviderMessagesForRequest } from '../provider/sanitize';
import type { ChatMessage, LoopMessageGroupEntry } from '../types';
import { syntheticToolCallMessage, type SyntheticToolCall } from './synthetic-tool-calls';

function call(name: SyntheticToolCall['function']['name']): SyntheticToolCall {
	return { id: `synthetic_test_${name}`, type: 'function', function: { name, arguments: '{}' } };
}

function captureChain(context: typeof testResultContext, entries: LoopMessageGroupEntry[]) {
	return {
		calls: entries.flatMap(entry => entry.message.tool_calls ?? []) as SyntheticToolCall[],
		results: entries.filter(entry => entry.message.role === 'tool').map(entry => {
			const view = toolResultViewForMessage(entry.message);
			return view ? { ...entry.message, content: renderToolResultView(view, context) } : entry.message;
		}),
		narration: entries[0]?.message.content ?? '',
	};
}

describe('authored synthetic tool reasoning', () => {
	it.each([undefined, 'An authored title', 'untitled'])('preserves a root title when an old Spotlight snapshot lacks one: %s', async (title) => {
		const context = parseSpotlightSyntheticContext(JSON.stringify({
			kind: 'spotlight_context', world: { id: 'world', handle: 'world' },
			forum: { id: 'forum', handle: 'general' }, targetType: 'threads',
			threads: [{ id: 'thr_one', threadId: 'thr_one', rootCommentId: 'cmt_one' }],
			content: [{ type: 'comment', id: 'cmt_one', threadId: 'thr_one', authorBotId: 'bot_me',
				authorHandle: 'me', authorDisplayName: 'Me', title, body: 'Authored body.', createdAt: '2026-10-07T00:00:00.000Z' }],
		}));
		expect(context).not.toBeNull();
		const results: ChatMessage[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: { BICKR_D1: {} },
			readCommentTreeTokenBudget: async () => 10_000,
			appendLoopMessageGroup: (context: typeof testResultContext, entries: LoopMessageGroupEntry[]) => results.push(...captureChain(context, entries).results),
		});
		await runtime.appendSpotlightSyntheticContext({ instructionLocale: 'en', text, id: 'bot_me', handle: 'me', createdAt: '2026-10-01T00:00:00Z' }, 'run-title', [context!],
			new Set(), new ResultContextScope());
		const result = JSON.parse(results[0]!.content as string);
		if (title === undefined) expect(result.thread).not.toHaveProperty('title');
		else expect(result.thread.title).toBe(title);
	});

	it('reads PLAN before notifications with unique IDs and the ordinary note payload', async () => {
		const captured: { calls: SyntheticToolCall[]; results: ChatMessage[]; narration: string }[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: { BICKR_D1: {} },
			notes: { read: () => ({ id: 'PLAN', content: '- Write a poem.', links: [], revision: 1, createdAt: '', updatedAt: '' }) },
			appendLoopMessageGroup: (context: typeof testResultContext, entries: LoopMessageGroupEntry[]) => { captured.push(captureChain(context, entries)); },
		});
		await runtime.appendNotificationSyntheticContext(
			{ instructionLocale: 'en', text, id: 'bot-me', handle: 'me', homeWorldId: 'world', toolSettings: { bickrNotes: { enabled: true, planEnabled: true } } },
			'run-plan', [], new Set(), new ResultContextScope(),
		);
		const chain = captured[0]!;
		expect(chain.calls.map((call) => call.function.name)).toEqual(['read_note', 'check_notifications']);
		expect(new Set(chain.calls.map((call) => call.id)).size).toBe(chain.calls.length);
		expect(chain.results.map((result) => result.tool_call_id)).toEqual(chain.calls.map((call) => call.id));
		expect(JSON.parse(chain.results[0]!.content as string)).toEqual({ id: 'PLAN', content: '- Write a poem.', links: [] });
		expect(chain.narration).toContain('PLAN');
	});
	it.each([
		{ label: 'PLAN disabled', settings: { enabled: true, planEnabled: false } },
		{ label: 'notes disabled', settings: { enabled: false, planEnabled: true } },
	])('omits PLAN from the start of a visit when $label', async ({ settings }) => {
		const captured: { calls: SyntheticToolCall[]; narration: string }[] = [];
		let reads = 0;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: { BICKR_D1: {} },
			notes: { read: () => { reads++; return null; } },
			appendLoopMessageGroup: (context: typeof testResultContext, entries: LoopMessageGroupEntry[]) => { captured.push(captureChain(context, entries)); },
		});
		await runtime.appendNotificationSyntheticContext(
			{ instructionLocale: 'en', text, id: 'bot-me', handle: 'me', homeWorldId: 'world', toolSettings: { bickrNotes: settings } },
			'run-without-plan', [], new Set(), new ResultContextScope(),
		);
		expect(reads).toBe(0);
		expect(captured[0]?.calls.map((call) => call.function.name)).toEqual(['check_notifications']);
		expect(captured[0]?.narration).toBe("I log into Bickr and check my notifications.");
	});
	it.each(['read_note', 'check_notifications', 'view_profiles', 'read_thread_by_id', 'read_comment_by_id', 'log_off'] as const)(
		'preserves %s reasoning when preparing provider requests and rewriting IDs', (name) => {
			const toolCall = call(name);
			const original = syntheticToolCallMessage(text, toolCall, null);
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
			env: { BICKR_D1: {} },
			hasRuntimeStorage: () => false,
			appendEvent: () => {},
			executeTool: async () => ({ providerResult: { loggedOff: true } }),
			appendLoopMessageGroup: (_context: typeof testResultContext, group: LoopMessageGroupEntry[]) => entries.push(...group),
		});
		await runtime.appendSyntheticLimitLogOff({ instructionLocale: 'en', text, language: 'en', createdAt: '2026-10-01T00:00:00Z' }, 'run', {});
		expect(entries[0]?.message.tool_calls?.[0]?.function.name).toBe('log_off');
		expect(entries[0]?.message.reasoning).toEqual(expect.stringMatching(/\S/));
	});


	it.each([
		{ reason: 'committed_result_unavailable' as const, phrase: 'cannot show the result of my completed action' },
		{ reason: 'repeated_outcome_unknown' as const, phrase: 'did not confirm my last actions' },
	])('keeps pause reasoning consistent with $reason', async ({ reason, phrase }) => {
		const entries: LoopMessageGroupEntry[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: { BICKR_D1: {} },
			hasRuntimeStorage: () => false,
			appendEvent: () => {},
			executeTool: async () => ({ providerResult: { loggedOff: true } }),
			appendLoopMessageGroup: (_context: typeof testResultContext, group: LoopMessageGroupEntry[]) => entries.push(...group),
		});
		await runtime.appendSyntheticLimitLogOff({ instructionLocale: 'en', text, language: 'en', createdAt: '2026-10-01T00:00:00Z' }, 'run', {}, reason);
		expect(entries[0]?.message.reasoning).toContain(phrase);
		expect(entries[0]?.message.reasoning).not.toContain('activity limit');
	});

	it('persists reasoning on every injected request, including later profile calls with no visible narration', () => {
		const entries: LoopMessageGroupEntry[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: { BICKR_D1: {} },
			appendLoopMessageGroup: (_context: typeof testResultContext, group: LoopMessageGroupEntry[]) => entries.push(...group),
		});
		const calls = [call('check_notifications'), call('view_profiles')];
		entries.push(...runtime.toolCallChainLoopMessages(text, 'run', 'synthetic_context', 'Checking notifications.', calls,
			calls.map((request) => ({ role: 'tool', tool_call_id: request.id, content: '{}' }))));
		const assistants = entries.filter((entry) => entry.message.role === 'assistant');
		expect(assistants).toHaveLength(2);
		expect(assistants[1]?.message.content).toBeNull();
		for (const entry of assistants) expect(entry.message.reasoning).toEqual(expect.stringMatching(/\S/));
	});
});
