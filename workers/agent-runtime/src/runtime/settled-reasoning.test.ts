import { chatMessagesCharacterCount } from '../compaction/limits';
import { approximateTextTokens } from '@bickr/shared/text-token-estimate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readableReasoningFormat, type AgentLogStreamDelta, type BotInferenceSubmissionMessage } from '@bickr/shared/model';
import { ProviderResponseInterruptedError } from '../errors';
import type { ProviderResponse } from '../types';
import { createProviderSanitize } from '../provider/sanitize';
import { botText } from '../localization';
import { AgentLogStore } from './agent-log-store';
import { BotRuntime, providerChatCompletionRequest, runtimeSchema } from './bot-runtime';
import { RuntimeMessageStore } from './message-store';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
import { testResultContext } from './result-render-context.test-support';

function unused(): never { throw new Error('This test does not use tool arguments.'); }
const { providerResponseMessageForHistory } = createProviderSanitize({
	canonicalToolName: unused, followToolArgsWithTargets: unused, followToolTargetsForProviderDedupe: unused,
	parseToolArgs: unused, parseToolArgsWithDiagnostics: unused, providerToolArgs: unused,
	runtimeRecord: value => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {},
	safeContextText: unused, stringValue: unused,
});
const encrypted = { type: 'reasoning.encrypted', index: 1, data: 'OPAQUE', signature: 'EXACT_SIGNATURE' };
const cases = [
	{ name: 'plain and encrypted', plain: 'Readable plain thought.', details: [encrypted], expected: 'Readable plain thought.' },
	{ name: 'plain and summary', plain: 'Readable plain thought.', details: [{ type: 'reasoning.summary', index: 0, summary: 'Readable summary.' }], expected: 'Readable plain thought.Readable summary.' },
	{ name: 'only encrypted', plain: '', details: [encrypted], expected: '' },
	{ name: 'no reasoning', plain: '', details: [], expected: '' },
	{ name: 'only plain', plain: 'Readable plain thought.', details: [], expected: 'Readable plain thought.' },
];
let storage: RuntimeTestStorage;
beforeEach(() => { storage = createRuntimeTestStorage(); storage.database.exec(runtimeSchema); });
afterEach(() => storage.database.close());

describe.each([true, false])('settled reasoning when completed=%s', completed => {
	it.each(cases)('preserves $name for the owner and keeps provider replay unchanged', async ({ plain, details, expected }) => {
		const messages = new RuntimeMessageStore(storage);
		const logs = new AgentLogStore(storage);
		const requestId = logs.begin({ runId: 'run', eventSeq: 1, purpose: 'loop' });
		const attemptId = logs.startAttempt(requestId, '{}');
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage }, agentLogs: logs, runtimeMessageStore: () => messages,
			throwIfStopped: () => {}, requireOwnerOrInternal: async () => {},
			resultRenderContextForRows: async () => testResultContext,
			broadcastProviderDelta: (runId: string, seq: number, delta: AgentLogStreamDelta) => { logs.partial(runId, seq, delta); },
		});
		const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Reply', reasoning: plain, reasoning_details: details } }] })}\n\n`;
		const stream = new ReadableStream<Uint8Array>({ start(controller) {
			controller.enqueue(new TextEncoder().encode(frame + (completed ? 'data: [DONE]\n\n' : '')));
			controller.close();
		} });
		let response: ProviderResponse;
		try {
			response = await runtime.consumeProviderResponse('run', 1, stream, new AbortController().signal);
			expect(completed).toBe(true);
		} catch (error) {
			expect(completed).toBe(false);
			expect(error).toBeInstanceOf(ProviderResponseInterruptedError);
			response = (error as ProviderResponseInterruptedError).response;
		}
		expect(response.reasoningFormat).toBe(readableReasoningFormat);
		expect(response.reasoning).toBe(expected);
		const history = providerResponseMessageForHistory(response)!;
		expect(history.reasoning).toBe(expected);
		expect(history.reasoning_format).toBe('readable_v1');
		const row = messages.appendLoopMessage(testResultContext, 'run', history, 'provider_response', completed ? 'complete' : 'interrupted', { streamSeq: 1 });
		const stored = storage.sql.exec<{ message_json: string }>('SELECT message_json FROM loop_messages WHERE seq = ?', row.seq).one();
		expect(JSON.parse(stored.message_json)).toMatchObject({ reasoning: expected, reasoning_format: 'readable_v1' });
		logs.settle(attemptId, { kind: completed ? 'success' : 'interrupted', response: JSON.stringify({ message: history }) });
		logs.finish(requestId, completed ? 'succeeded' : 'failed');
		const url = new URL('https://internal/bots/participant/messages?page=1');
		const page = await runtime.handleRuntimeReadRequest(new Request(url), url, 'participant');
		const api = (await page.json()).data;
		expect(api.messages[0].message).toEqual(history);
		expect(api.entries[0].message.message.reasoning_format).toBe('readable_v1');
		expect(api.messages[0].status).toBe(completed ? 'complete' : 'interrupted');
		const replay = providerChatCompletionRequest({ text: botText('en'), model: 'test', temperature: 0.5, baseUrl: 'https://provider.test/v1' }, [api.messages[0].message], []);
		expect(replay.messages[0]).toEqual({ role: 'assistant', content: 'Reply', ...(details.length ? { reasoning_details: details } : plain ? { reasoning: plain } : {}) });
		expect(JSON.stringify(replay.messages)).not.toContain('reasoning_format');
		expect(chatMessagesCharacterCount([history])).toBe(chatMessagesCharacterCount([replay.messages[0]!]));
		expect(row.tokenEstimate).toBe(approximateTextTokens(JSON.stringify(replay.messages[0])));
		if (details.length) expect(history.reasoning_details).toEqual(details);
	});
});

it.each([undefined, 'future_format'])('keeps unproven stored reasoning legacy with marker %s', marker => {
	const messages = new RuntimeMessageStore(storage);
	const original = { role: 'assistant', content: 'Reply', reasoning: 'OPAQUE_LEGACY', reasoning_details: [encrypted], ...(marker === undefined ? {} : { reasoning_format: marker }), internalSecret: 'PRIVATE' };
	const row = messages.appendLoopMessage(testResultContext, 'run', original as BotInferenceSubmissionMessage, 'provider_response');
	const before = storage.sql.exec<{ message_json: string }>('SELECT message_json FROM loop_messages WHERE seq = ?', row.seq).one().message_json;
	const api = messages.loopMessagesPage(testResultContext, { page: 1 }).messages[0]!.message;
	expect(api.reasoning_format).toBeUndefined();
	expect(api.reasoning).toBe('OPAQUE_LEGACY');
	expect(JSON.stringify(api)).not.toContain('PRIVATE');
	expect(storage.sql.exec<{ message_json: string }>('SELECT message_json FROM loop_messages WHERE seq = ?', row.seq).one().message_json).toBe(before);
});

it('does not certify a legacy outcome during interrupted publication recovery', () => {
	const messages = new RuntimeMessageStore(storage);
	const logs = new AgentLogStore(storage);
	const requestId = logs.begin({ runId: 'run', eventSeq: 1, purpose: 'loop' });
	const attemptId = logs.startAttempt(requestId, '{}');
	logs.settle(attemptId, { kind: 'success', response: JSON.stringify({ message: { role: 'assistant', content: 'Reply', reasoning: 'OPAQUE_LEGACY', reasoning_details: [encrypted] } }) });
	logs.stageResponsePublication({ kind: 'provider_response', runId: 'run', requestId, eventSeq: 1, attemptId, assistantSeq: null, pendingCallIds: [] });
	const runtime = Object.assign(Object.create(BotRuntime.prototype), { agentLogs: logs, runtimeMessageStore: () => messages, clearPendingTool: () => {} });
	runtime.settleResponsePublication(testResultContext, 'run', null);
	const history = messages.loopMessagesAfter(testResultContext, 0)[0]!.message;
	expect(history.reasoning_format).toBeUndefined();
	expect(history.reasoning).toBeUndefined();
	expect(history.reasoning_details).toEqual([encrypted]);
});

it('selects each nested field at the Loop API and provider boundary', () => {
	const messages = new RuntimeMessageStore(storage);
	messages.appendLoopMessage(testResultContext, 'run', {
		role: 'assistant', content: 'Reply', reasoning: 'Readable', reasoning_format: readableReasoningFormat,
		internalSecret: 'PRIVATE', tool_calls: [{ id: 'original', type: 'function', internalSecret: 'PRIVATE', function: { name: 'read_note', arguments: '{}', internalSecret: 'PRIVATE' } }],
	} as unknown as BotInferenceSubmissionMessage, 'provider_response');
	const api = messages.loopMessagesPage(testResultContext, { page: 1 }).messages[0]!.message;
	expect(api).toEqual({ role: 'assistant', content: 'Reply', reasoning: 'Readable', reasoning_format: 'readable_v1', tool_calls: [{ id: 'original', type: 'function', function: { name: 'read_note', arguments: '{}' } }] });
	const replay = providerChatCompletionRequest({ text: botText('en'), model: 'test', temperature: 0.5, baseUrl: 'https://provider.test/v1' }, [api], []);
	expect(replay.messages[0]).toEqual({ role: 'assistant', content: 'Reply', reasoning: 'Readable', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_note', arguments: '{}' } }] });
});
