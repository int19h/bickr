import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotDocument, BotLoopMessageLogsResponse, InferenceAttribution } from '@bickr/shared/model';
import { ProviderRequestError } from '../errors';
import type { ProviderSettings } from '../provider-requests';
import type { ChatMessage, ProviderResponse } from '../types';
import { BotRuntime, runtimeSchema } from './bot-runtime';
import { RuntimeMessageStore } from './message-store';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';

const bot = { id: 'bot-a', homeWorldHandle: 'primary', handle: 'alice', tickSettings: { enabled: true, intervalSeconds: 60, compactionThreshold: 0.8 } } as BotDocument;
let storage: RuntimeTestStorage | undefined;
afterEach(() => { storage?.database.close(); storage = undefined; vi.restoreAllMocks(); });

type Access = {
 callProvider(settings: ProviderSettings, messages: ChatMessage[], tools: [], runId: string, seq: number, signal: AbortSignal, botId: string, toolCalls: undefined, createdAt: string, maxTokens: number, cacheSession: undefined, bot: BotDocument): Promise<ProviderResponse>;
 callProviderForCompaction(settings: ProviderSettings, messages: ChatMessage[], runId: string, signal: AbortSignal, limits: undefined, tools: undefined, mode: undefined, seq: number, createdAt: string, bot: BotDocument): Promise<ProviderResponse>;
 handleRuntimeReadRequest(request: Request, url: URL, botId: string): Promise<Response>;
};

function runtime() {
 storage = createRuntimeTestStorage(); storage.database.exec(runtimeSchema);
 const store = new RuntimeMessageStore(storage);
 storage.sql.exec("INSERT INTO events (seq, run_id, type, payload_json, token_estimate, created_at) VALUES (7, 'run-a', 'provider_request', '{}', 0, '2026-10-01')");
 const runtime = Object.assign(Object.create(BotRuntime.prototype), {
  state: { storage }, env: {}, renewProgressLease: vi.fn(), throwIfStopped: vi.fn(),
  runtimeMessageStore: () => store, appendEvent: vi.fn(), requireOwnerOrInternal: vi.fn(),
  recordProviderTokenCalibrationSampleFromError: vi.fn(),
 });
 return { runtime, access: runtime as Access, store };
}

describe('originating inference metadata', () => {
 it('captures successful retry routing instead of the original settings', async () => {
  const { runtime: instance, access } = runtime();
  instance.fetchProviderResponse = vi.fn()
   .mockRejectedValueOnce(new ProviderRequestError(429, 'vendor/model', 'endpoint', 'Rate limit', { providerError: { kind: 'provider_error', status: 429, providerName: 'DeepInfra' } }))
   .mockResolvedValueOnce(new ReadableStream());
  instance.consumeProviderResponse = vi.fn().mockResolvedValue({ content: 'Result', reasoning: '', reasoningDetails: [], toolCalls: [] });
  const settings = { model: 'vendor/model', baseUrl: 'https://openrouter.ai/api/v1', temperature: 0.3, topP: 0.8, apiKey: 'secret' };
  const result = await access.callProvider(settings, [], [], 'run-a', 7, new AbortController().signal, bot.id, undefined, '2026-10-01', 1234, undefined, bot);
  expect(result.inferenceAttribution).toMatchObject({ model: 'vendor/model', parameters: { temperature: 0.3, top_p: 0.8, max_completion_tokens: 1234, provider: { ignore: ['DeepInfra'] } } });
  expect(JSON.stringify(result.inferenceAttribution)).not.toContain('secret');
  expect(settings).not.toHaveProperty('providerRouting');
  const stored = storage!.sql.exec<{ payload_json: string }>('SELECT payload_json FROM events WHERE seq = 7').one();
  expect(JSON.parse(stored.payload_json).inferenceAttribution).toEqual(result.inferenceAttribution);
 });

 it('captures compaction parameters from its own request', async () => {
  const { runtime: instance, access } = runtime();
  instance.fetchProviderCompactionResponse = vi.fn().mockResolvedValue({ content: 'Summary.' });
  const result = await access.callProviderForCompaction({ model: 'vendor/model', baseUrl: 'https://example.test/v1', temperature: 0.1 }, [], 'run-a', new AbortController().signal, undefined, undefined, undefined, 7, '2026-10-01', bot);
  const request = JSON.parse(instance.fetchProviderCompactionResponse.mock.calls[0][2]);
  expect(result.inferenceAttribution?.parameters.temperature).toBe(request.temperature);
  expect(result.inferenceAttribution?.parameters.max_completion_tokens).toBe(request.max_completion_tokens);
  expect(result.inferenceAttribution?.parameters).not.toHaveProperty('response_format');
 });

 it('opens the exact compacted source and retains attribution after its event expires', async () => {
  const { access, store } = runtime();
  const attribution: InferenceAttribution = { model: 'vendor/model', parameters: { temperature: 0.3 }, source: { botId: bot.id, worldHandle: 'primary', botHandle: bot.handle, runId: 'run-a', requestSeq: 7 } };
  const message = store.appendLoopMessage('run-a', { role: 'assistant', content: 'A post' }, 'provider_response', 'complete', { streamSeq: 7 });
  store.recordLoopMessageLog(message.seq, 'inference_attribution', JSON.stringify(attribution));
  storage!.sql.exec('UPDATE loop_messages SET compacted_by = 99 WHERE seq = ?', message.seq);
  storage!.sql.exec('DELETE FROM events');
  const url = new URL('https://internal/bots/bot-a/inference-logs?requestSeq=7&runId=run-a');
  const response = await access.handleRuntimeReadRequest(new Request(url), url, bot.id);
  const data = (await response.json() as { data: BotLoopMessageLogsResponse }).data;
  expect(data.message.seq).toBe(message.seq);
  expect(data.inferenceAttribution).toEqual(attribution);
  const other = new URL('https://internal/bots/bot-a/inference-logs?requestSeq=7&runId=run-b');
  await expect(access.handleRuntimeReadRequest(new Request(other), other, bot.id)).rejects.toThrow('no longer retained');
 });
});
