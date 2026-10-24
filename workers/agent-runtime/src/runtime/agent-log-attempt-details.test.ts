import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { botText } from '../localization';
import { BotRuntime, runtimeSchema } from './bot-runtime';
import { AgentLogStore } from './agent-log-store';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
import { testResultContext } from './result-render-context.test-support';
import { RuntimeMessageStore } from './message-store';

let storage: RuntimeTestStorage;
let store: AgentLogStore;
const body = JSON.stringify({ messages: [{ role: 'system', content: 'aaaa' }, { role: 'user', content: 'bbbb' }] });
const usageInput = {
	contextWindowTokens: 1000, createdAt: '2026-10-24', requestSeq: 1, runId: 'run',
	settings: { text: botText('en'), model: 'test', baseUrl: 'https://provider.test', temperature: 0.2 },
	usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25, cachedTokens: 4, reasoningTokens: 0, cost: 0.006,
		raw: { cost_details: { upstream_inference_prompt_cost: 0.003, upstream_inference_completions_cost: 0.003, internal: 'hidden' } } },
};
function runtime() {
	return Object.assign(Object.create(BotRuntime.prototype), { state: { storage }, agentLogs: store, providerUsageProviderName: async () => 'Provider' });
}
function start() {
	const id = store.begin({ runId: 'run', eventSeq: 1, purpose: 'loop' });
	return { id, attemptId: store.startAttempt(id, body) };
}
beforeEach(() => { storage = createRuntimeTestStorage(); storage.database.exec(runtimeSchema); store = new AgentLogStore(storage); });
afterEach(() => { storage.database.close(); vi.restoreAllMocks(); });

describe('attempt details', () => {
	it('returns usage and cache chips from the exact linked usage row', async () => {
		const { id, attemptId } = start();
		await runtime().recordProviderUsage({ ...usageInput, attemptId });
		const attempt = store.request(id).attempts[0]!;
		expect(attempt.body).toBe(body);
		expect(attempt.usage).toEqual({ promptTokens: 20, cachedInputTokens: 4, uncachedInputTokens: 16, outputTokens: 5, totalTokens: 25, cachedInputCost: expect.closeTo(0.0006, 8), uncachedInputCost: expect.closeTo(0.0024, 8), outputCost: 0.003, totalCost: 0.006, estimatedCostSplit: true });
		expect(attempt.messages.map(item => ({ position: item.position, cacheStatus: item.cacheStatus }))).toEqual([{ position: 1, cacheStatus: 'cached' }, { position: 2, cacheStatus: 'partially_cached' }]);
		const row = new RuntimeMessageStore(storage).appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Response' }, 'provider_response', 'complete', { streamSeq: 1 });
		expect(store.requestForMessage(row.seq)?.attempts[0]?.messages).toEqual(attempt.messages);
	});

	it('does not give a failed attempt the successful attempt usage on the same event sequence', async () => {
		const { id, attemptId: failed } = start();
		store.settle(failed, { kind: 'provider_error', status: 429, errorType: null, message: 'Retry' });
		const succeeded = store.startAttempt(id, body);
		store.settle(succeeded, { kind: 'success', response: 'Reply' });
		await runtime().recordProviderUsage({ ...usageInput, attemptId: succeeded });
		const attempts = store.request(id).attempts;
		expect(attempts[0]?.usage).toBeNull();
		expect(attempts[0]?.messages.every(item => !('cacheStatus' in item))).toBe(true);
		expect(attempts[1]?.usage?.cachedInputTokens).toBe(4);
		expect(() => store.linkUsage(failed, storage.sql.exec<{ id: number }>('SELECT id FROM provider_usage LIMIT 1').one().id)).toThrow('does not belong');
	});

	it('returns messages without cache chips before usage exists and for old unlinked attempts', async () => {
		const { id } = start();
		await runtime().recordProviderUsage(usageInput);
		const attempt = store.request(id).attempts[0]!;
		expect(attempt.usage).toBeNull();
		expect(attempt.attribution).toBeNull();
		expect(attempt.messages).toEqual([{ position: 1, message: { role: 'system', content: 'aaaa' } }, { position: 2, message: { role: 'user', content: 'bbbb' } }]);
	});

	it('keeps usage but returns no messages when the body is not retained', async () => {
		const { id, attemptId } = start();
		await runtime().recordProviderUsage({ ...usageInput, attemptId });
		vi.spyOn(store, 'body').mockReturnValue(null);
		expect(store.request(id).attempts[0]).toMatchObject({ body: null, messages: [], usage: { cachedInputTokens: 4 } });
	});

	it('returns null usage and no cache chips after its usage row expires', async () => {
		const { id, attemptId } = start();
		await runtime().recordProviderUsage({ ...usageInput, attemptId });
		storage.sql.exec('DELETE FROM provider_usage');
		expect(store.request(id).attempts[0]?.usage).toBeNull();
		expect(store.request(id).attempts[0]?.messages.every(item => !('cacheStatus' in item))).toBe(true);
	});

	it.each(['invalid JSON', '{}', '{"messages":[{"role":"future","content":"text"}]}', '{"messages":[{"role":"assistant","tool_calls":[{"type":"future"}]}]}'])('keeps an unreadable body intact and returns no messages: %s', value => {
		const { id } = start();
		store.startAttempt(id, value);
		expect(store.request(id).attempts.at(-1)).toMatchObject({ body: value, messages: [] });
	});

	it('builds messages and attribution with explicit nested field lists', () => {
		const { id, attemptId } = start();
		const exact = JSON.stringify({ messages: [{ role: 'assistant', content: 'Text', internal: 'hidden', tool_calls: [{ id: 'call', type: 'function', internal: 'hidden', function: { name: 'read', arguments: '{}', internal: 'hidden' } }], reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque', signature: 'signed', internal: 'hidden' }] }] });
		store.startAttempt(id, exact);
		const latest = store.latestAttempt(id)!;
		const internalAttribution = { model: 'test', parameters: { temperature: 0.3, internal: 'hidden', provider: { order: ['Provider'], internal: 'hidden' } }, source: { botId: 'participant', worldHandle: 'world', botHandle: 'profile', runId: 'run', requestSeq: 1, internal: 'hidden' } };
		store.recordAttribution(latest, internalAttribution);
		expect(storage.sql.exec<{ attribution_json: string }>('SELECT attribution_json FROM inference_attempts WHERE id = ?', latest).one().attribution_json).not.toContain('hidden');
		storage.sql.exec('UPDATE inference_attempts SET attribution_json = ? WHERE id = ?', JSON.stringify(internalAttribution), latest);
		const attempt = store.request(id).attempts.at(-1)!;
		expect(attempt.body).toBe(exact);
		expect(JSON.stringify(attempt.messages)).not.toContain('hidden');
		expect(attempt.messages[0]?.message.reasoning_details).toEqual([{ type: 'reasoning.encrypted', data: 'opaque', signature: 'signed' }]);
		expect(attempt.attribution).toEqual({ model: 'test', parameters: { temperature: 0.3, provider: { order: ['Provider'] } }, source: { botId: 'participant', worldHandle: 'world', botHandle: 'profile', runId: 'run', requestSeq: 1 } });
		expect(store.request(id).attempts.find(item => item.id === attemptId)?.attribution).toBeNull();
	});

	it('rolls back usage insertion if the attempt reference cannot be proved', async () => {
		const { attemptId } = start();
		await expect(runtime().recordProviderUsage({ ...usageInput, attemptId, requestSeq: 999 })).rejects.toMatchObject({ status: 409 });
		expect(storage.sql.exec('SELECT id FROM provider_usage').toArray()).toEqual([]);
	});

	it('keeps the captured attempt reference across the provider-name wait', async () => {
		const { id, attemptId } = start();
		store.settle(attemptId, { kind: 'success', response: 'Reply' });
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const instance = runtime();
		instance.providerUsageProviderName = async () => { await gate; return 'Provider'; };
		const pending = instance.recordProviderUsage({ ...usageInput, attemptId, settings: { ...usageInput.settings, baseUrl: 'https://openrouter.ai/api/v1' } });
		expect(store.request(id).attempts[0]?.usage?.cachedInputTokens).toBe(4);
		const later = store.startAttempt(id, body);
		store.settle(later, { kind: 'timeout' });
		release();
		await pending;
		const attempts = store.request(id).attempts;
		expect(attempts[0]?.usage?.cachedInputTokens).toBe(4);
		expect(attempts[1]?.usage).toBeNull();
	});

	it('does not assign a delayed provider name to a replacement row after storage erasure', async () => {
		const instance = runtime();
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		instance.providerUsageProviderName = async () => { await gate; return 'Old Provider'; };
		const input = { ...usageInput, settings: { ...usageInput.settings, baseUrl: 'https://openrouter.ai/api/v1' } };
		const pending = instance.recordProviderUsage(input);
		const oldId = storage.sql.exec<{ id: number }>('SELECT id FROM provider_usage LIMIT 1').one().id;
		storage.sql.exec('DELETE FROM provider_usage');
		storage.sql.exec("DELETE FROM sqlite_sequence WHERE name = 'provider_usage'");
		instance.providerUsageProviderName = async () => null;
		await instance.recordProviderUsage({ ...input, runId: 'replacement' });
		expect(storage.sql.exec<{ id: number }>('SELECT id FROM provider_usage LIMIT 1').one().id).toBe(oldId);
		release();
		await pending;
		expect(storage.sql.exec<{ provider_name: string | null }>('SELECT provider_name FROM provider_usage LIMIT 1').one().provider_name).toBeNull();
	});

	it('rolls back usage and completion together when publication fails', async () => {
		const { id, attemptId } = start();
		await expect(runtime().recordProviderUsage({ ...usageInput, attemptId }, () => {
			store.finish(id, 'succeeded');
			throw new Error('Publication failed.');
		})).rejects.toThrow('Publication failed.');
		expect(store.request(id)).toMatchObject({ state: 'pending', attempts: [{ usage: null }] });
		expect(storage.sql.exec('SELECT id FROM provider_usage').toArray()).toEqual([]);
	});

	it('rejects usage linkage after a request reaches a final state', async () => {
		const { id, attemptId } = start();
		store.finish(id, 'succeeded');
		await expect(runtime().recordProviderUsage({ ...usageInput, attemptId })).rejects.toMatchObject({ status: 409 });
		expect(store.request(id).attempts[0]?.usage).toBeNull();
		expect(storage.sql.exec('SELECT id FROM provider_usage').toArray()).toEqual([]);
	});

	it('rejects attribution for another request and bounds malformed stored metadata', () => {
		const { id, attemptId } = start();
		const attribution = { model: 'test', parameters: {}, source: { botId: 'participant', worldHandle: 'world', botHandle: 'profile', runId: 'other', requestSeq: 1 } };
		expect(() => store.recordAttribution(attemptId, attribution)).toThrow('does not belong');
		storage.sql.exec('UPDATE inference_attempts SET attribution_json = ? WHERE id = ?', '{"source":{}}', attemptId);
		expect(() => store.request(id)).toThrow('unsupported shape');
	});

	it('upgrades old attempt columns once without guessing usage or attribution', () => {
		storage.sql.exec('DROP INDEX inference_attempts_usage');
		storage.sql.exec('ALTER TABLE inference_attempts DROP COLUMN usage_id');
		storage.sql.exec('ALTER TABLE inference_attempts DROP COLUMN attribution_json');
		store.initialize();
		store.initialize();
		const { id } = start();
		expect(store.request(id).attempts[0]).toMatchObject({ usage: null, attribution: null });
	});
});
