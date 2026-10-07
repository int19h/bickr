import { botText } from '../localization';
import { compactionRowsForEstimatedBudget } from '../compaction/selection';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, LoopMessageGroupEntry, ToolCall } from '../types';
import { RuntimeMessageStore } from './message-store';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
import { BotRuntime } from './bot-runtime';
import { sanitizeProviderMessagesForRequest } from '../provider/sanitize';
import { unknownToolOutcomeMessage } from './tool-recovery';

const reasoning = [{ type: 'reasoning.encrypted', data: 'opaque-signed-provider-block', format: 'anthropic-claude-v1', index: 0 }];
const call = (id: string): ToolCall => ({ id, type: 'function', function: { name: 'view_profiles', arguments: '{}' } });
function pair(id: string, failed = false): [LoopMessageGroupEntry, LoopMessageGroupEntry] {
	return [
		{ runId: 'run', origin: 'provider_response', status: 'complete', message: { role: 'assistant', content: 'I will read both profiles.', reasoning_details: reasoning, tool_calls: [call(id)] } },
		{ runId: 'run', origin: failed ? 'tool_failure' : 'tool_result', status: 'complete', message: { role: 'tool', tool_call_id: id, content: failed ? '{"error":"not found"}' : '{}' } },
	];
}

describe('provider response groups', () => {
	let storage: RuntimeTestStorage;
	let store: RuntimeMessageStore;
	beforeEach(() => { storage = createRuntimeTestStorage(); store = new RuntimeMessageStore(storage); });
	afterEach(() => storage.database.close());

	it.each([false, true])('extends one response without duplicating encrypted reasoning (first result failed=%s)', (failed) => {
		const broadcasts = vi.fn();
		store = new RuntimeMessageStore(storage, broadcasts);
		const first = store.appendProviderToolResult(...pair('first', failed), null);
		const extended = store.appendProviderToolResult(...pair('second'), first.seq);
		const messages = store.loopMessagesAfter(0).map((row) => row.message);
		expect(messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'tool']);
		expect(messages[0]?.tool_calls?.map((tool) => tool.id)).toEqual(['first', 'second']);
		expect(messages[0]?.reasoning_details).toEqual(reasoning);
		expect(sanitizeProviderMessagesForRequest(messages)[0]?.reasoning_details).toEqual(reasoning);
		expect(extended.seq).toBe(first.seq);
		expect(extended.tokenEstimate).toBeGreaterThan(first.tokenEstimate);
		expect(broadcasts.mock.calls.filter(([row]) => row.seq === first.seq)).toHaveLength(2);
		const logs = store.loopMessageLogsForSeq(first.seq);
		expect(logs.message.message.tool_calls).toHaveLength(2);
	});

	it('never separates a multi-call response from either result at a compaction budget boundary', () => {
		store.appendLoopMessage('earlier', { role: 'assistant', content: 'Older memory.' }, 'provider_response');
		const first = store.appendProviderToolResult(...pair('first'), null);
		store.appendProviderToolResult(...pair('second'), first.seq);
		store.appendLoopMessage('later', { role: 'user', content: 'New visit.' }, 'synthetic_context');
		const rows = store.loopMessagesAfter(0).map((message) => ({ row: { seq: message.seq, message_json: JSON.stringify(message.message) }, tokens: 1000 }));
		const selected = compactionRowsForEstimatedBudget(rows, 2500, { requireMinimumSelectedTokens: false });
		expect(selected.map((row) => row.seq)).toEqual([1]);
	});

	it('rejects extension across a new environmental message without changing history', () => {
		const first = store.appendProviderToolResult(...pair('first'), null);
		store.appendLoopMessage('run', { role: 'user', content: 'New context.' }, 'synthetic_context');
		const before = store.loopMessagesAfter(0);
		expect(() => store.appendProviderToolResult(...pair('second'), first.seq)).toThrow('contiguous');
		expect(store.loopMessagesAfter(0)).toEqual(before);
	});

	it('rolls back a new assistant and tool group, logs, and broadcasts on a write failure', () => {
		const broadcast = vi.fn();
		store = new RuntimeMessageStore(storage, broadcast);
		storage.database.exec("CREATE TRIGGER fail_tool BEFORE INSERT ON loop_messages WHEN NEW.role = 'tool' BEGIN SELECT RAISE(ABORT, 'tool write failed'); END");
		expect(() => store.appendLoopMessageGroup(pair('first'))).toThrow('tool write failed');
		expect(store.loopMessagesAfter(0)).toEqual([]);
		expect(storage.database.prepare('SELECT COUNT(*) AS count FROM loop_message_logs').get()).toMatchObject({ count: 0 });
		expect(broadcast).not.toHaveBeenCalled();
	});

	it('rolls back assistant expansion, logs, and pending cleanup if result persistence fails', () => {
		const first = store.appendProviderToolResult(...pair('first'), null);
		storage.database.prepare("INSERT INTO runtime_state VALUES ('pending_tool_v3', ?)").run(JSON.stringify({ runId: 'run' }));
		const original = store.insertLoopMessage.bind(store);
		vi.spyOn(store, 'insertLoopMessage').mockImplementation((input) => {
			if (input.message.tool_call_id === 'second') throw new Error('fault during result insert');
			return original(input);
		});
		const before = store.loopMessageLogsForSeq(first.seq);
		expect(() => store.appendProviderToolResult(...pair('second'), first.seq)).toThrow('fault during result insert');
		expect(store.loopMessageLogsForSeq(first.seq)).toEqual(before);
		expect(storage.database.prepare("SELECT value_json FROM runtime_state WHERE key = 'pending_tool_v3'").get()).toBeDefined();
	});

	it.each([null, 'existing'] as const)('clears the current journal with a successful result (group=%s)', (group) => {
		const first = group ? store.appendProviderToolResult(...pair('first'), null) : null;
		storage.database.prepare("INSERT INTO runtime_state VALUES ('pending_tool_v3', ?)").run(JSON.stringify({ runId: 'run' }));
		store.appendProviderToolResult(...pair('second'), first?.seq ?? null);
		expect(storage.database.prepare("SELECT value_json FROM runtime_state WHERE key = 'pending_tool_v3'").get()).toBeUndefined();
	});

	it.each([false, true])('recovers an interrupted tool with original reasoning exactly once (existing group=%s)', (existing) => {
		const first = existing ? store.appendProviderToolResult(...pair('first'), null) : null;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage, getWebSockets: () => [] }, appendEvent: vi.fn(),
		});
		const assistant: ChatMessage = { role: 'assistant', reasoning_details: reasoning, tool_calls: [call('first'), call('second')] };
		runtime.setPendingTool(botText('en'), 'run', call('second'), {}, assistant, first?.seq ?? null);
		runtime.markPendingToolDispatched('run');
		runtime.settlePendingTool('run');
		runtime.settlePendingTool('run');
		const messages = store.loopMessagesAfter(0).map((row) => row.message);
		expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
		expect(messages[0]?.reasoning_details).toEqual(reasoning);
		expect(messages.at(-1)?.tool_call_id).toBe('second');
		expect(messages.at(-1)?.content).toContain('outcome_unknown');
		expect(messages).toHaveLength(existing ? 3 : 2);
		expect(storage.database.prepare("SELECT value_json FROM runtime_state WHERE key = 'pending_tool_v3'").get()).toBeUndefined();
	});

	it('settles legacy pending calls once without inventing provider reasoning', () => {
		storage.database.prepare("INSERT INTO runtime_state VALUES ('pending_tool_v1', ?)").run(JSON.stringify({ runId: 'run', toolCall: call('legacy'), args: {} }));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), { state: { storage, getWebSockets: () => [] }, appendEvent: vi.fn() });
		runtime.settlePendingTool('run');
		runtime.settlePendingTool('run');
		const messages = store.loopMessagesAfter(0).map((row) => row.message);
		expect(messages).toHaveLength(2);
		expect(messages[0]?.reasoning).toBeUndefined();
		expect(messages[0]?.reasoning_details).toBeUndefined();
	});

	it.each(['prepared', 'dispatched'] as const)('recovers a %s call in its original language after a new runtime instance', (stage) => {
		const original = Object.assign(Object.create(BotRuntime.prototype), { state: { storage, getWebSockets: () => [] }, appendEvent: vi.fn() });
		const text = botText('ja');
		const assistant: ChatMessage = { role: 'assistant', content: 'Authored {{opaque}} reasoning.', reasoning_details: reasoning };
		original.setPendingTool(text, 'run', call('native'), {}, assistant, null);
		if (stage === 'dispatched') original.markPendingToolDispatched('run');
		// Recovery gets its language from the stored request, without loading a
		// participant configuration that can change while the object is asleep.
		const restarted = Object.assign(Object.create(BotRuntime.prototype), { state: { storage, getWebSockets: () => [] }, appendEvent: vi.fn() });
		restarted.settlePendingTool('run');
		restarted.settlePendingTool('run');
		const messages = store.loopMessagesAfter(0).map((row) => row.message);
		expect(messages).toHaveLength(2);
		expect(messages[0]?.content).toBe(assistant.content);
		expect(messages[0]?.reasoning_details).toEqual(reasoning);
		const outcome = JSON.parse(String(messages[1]?.content));
		expect(outcome).toEqual(stage === 'prepared'
			? { ok: false, code: 'not_dispatched', message: text.format('recovery.notDispatched') }
			: { kind: 'outcome_unknown', message: unknownToolOutcomeMessage(text, 'view_profiles') });
		expect(storage.database.prepare("SELECT value_json FROM runtime_state WHERE key = 'pending_tool_v3'").get()).toBeUndefined();
	});
});
