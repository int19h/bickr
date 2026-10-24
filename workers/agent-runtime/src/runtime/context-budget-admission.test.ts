import { afterEach, expect, it, vi } from 'vitest';
import { contextWindowTokensMin, localizedText } from '@bickr/shared/model';
import { defaultTickSettings } from '@bickr/shared/repository';
import { parseLanguageTag } from '@bickr/shared/validation';
import { BotRuntime, providerFunctionToolsForBot, runtimeSchema } from './bot-runtime';
import { RuntimeMessageStore } from './message-store';
import { createRuntimeTestStorage } from './sqlite-test-helper';
import { testResultContext } from './result-render-context.test-support';
import { botText } from '../localization';
import { providerContextCompletionReserveTokens } from '../constants';
import { providerCompactionSummaryProperty } from '../prompt-and-tools';
import type { RuntimeBotDocument } from '../types';

vi.mock('./result-render-context', async original => ({ ...await original<object>(), buildResultRenderContext: async () => testResultContext }));
afterEach(() => vi.unstubAllGlobals());

it('compacts long history at the minimum with the real system prompt and tools, then continues inference', async () => {
	const storage = createRuntimeTestStorage();
	storage.database.exec(runtimeSchema);
	try {
		const text = botText('en');
		const en = parseLanguageTag('en');
		const bot: RuntimeBotDocument = {
			id: 'participant', type: 'bot', schemaVersion: 2, revision: 1, ownerUserId: 'owner',
			homeWorldId: 'world', homeWorldHandle: 'home', handle: 'participant', language: en, instructionLocale: 'en', text,
			displayName: localizedText('Participant', en), shortBio: localizedText('A participant.', en), prompt: localizedText('Keep useful memories.', en),
			includeLanguageInSystemPrompt: true, inferenceSettings: {}, toolSettings: { bickrNotes: { enabled: true } },
			tickSettings: { ...defaultTickSettings, contextWindowTokens: contextWindowTokensMin },
			createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z',
		};
		const settings = { text, model: 'test', baseUrl: 'https://provider.test/v1', apiKey: 'test', toolCalls: 'at_will' as const, compactionMode: 'structured_output' as const };
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage }, env: { BICKR_SIMULATION_MODE: 'provider' }, liveness: { progress: vi.fn(), stream: vi.fn() }, ephemeralStreamSeq: 0,
			renewProgressLease: vi.fn(), throwIfStopped: vi.fn(), broadcast: vi.fn(), broadcastControl: vi.fn(),
		});
		const messages = new RuntimeMessageStore(storage);
		const tools = providerFunctionToolsForBot(bot, settings);
		expect(tools.length).toBeGreaterThan(10);
		expect(tools.some(tool => tool.type === 'function' && tool.function.name === 'write_note')).toBe(true);
		const cutoff = contextWindowTokensMin - providerContextCompletionReserveTokens;
		const requestMessages = () => runtime.activeProviderRequestMessages(testResultContext, bot, tools, 'at_will');
		const estimate = () => runtime.estimateProviderPromptTokens(settings, requestMessages(), tools).promptTokens as number;
		expect(requestMessages()[0].content.length).toBeGreaterThan(5000);
		// The fixed prompt and tools must leave room for a summary. This is the
		// condition that the previous minimum could not meet in issue #321.
		expect(estimate() + 1000).toBeLessThan(cutoff);
		let rowCount = 0;
		while (estimate() <= cutoff + 2000 && rowCount < 40) {
			messages.appendLoopMessage(testResultContext, 'old', { role: 'assistant', content: `Memory ${rowCount}: ${'I reviewed the feed and kept useful notes. '.repeat(50)}` }, 'provider_response');
			rowCount++;
		}
		expect(estimate()).toBeGreaterThan(cutoff);
		expect(rowCount).toBeGreaterThan(1);
		const summary = 'I remember the profiles that I reviewed and the notes that I kept. '.repeat(65).slice(0, 4000);
		const requests: Array<{ stream?: boolean; messages: { content?: string }[]; tools: unknown[] }> = [];
		vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body));
			requests.push(request);
			if (!request.stream) return Response.json({ choices: [{ message: { content: JSON.stringify({ [providerCompactionSummaryProperty]: summary }) } }] });
			expect(storage.sql.exec("SELECT seq FROM loop_messages WHERE origin = 'compaction'").toArray().length).toBeGreaterThan(0);
			expect(estimate()).toBeLessThan(cutoff);
			return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'I can continue with the retained summary.' } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
		}));
		await runtime.runProviderLoop(bot, settings, 'run', [], { mode: 'normal', signal: new AbortController().signal });
		expect(requests.some(request => !request.stream)).toBe(true);
		expect(requests.at(-1)?.stream).toBe(true);
		expect(requests.at(-1)?.tools).toHaveLength(tools.length);
		expect(storage.sql.exec<{ origin: string; message_json: string }>("SELECT origin, message_json FROM loop_messages WHERE compacted_by IS NULL ORDER BY position").toArray()).toEqual(expect.arrayContaining([
			expect.objectContaining({ origin: 'compaction', message_json: expect.stringContaining(summary) }),
			expect.objectContaining({ origin: 'provider_response', message_json: expect.stringContaining('I can continue with the retained summary.') }),
		]));
		const estimates = storage.sql.exec<{ payload_json: string }>("SELECT payload_json FROM events WHERE type = 'provider_token_estimate' ORDER BY seq").toArray().map(row => JSON.parse(row.payload_json));
		expect(estimates[0].promptTokens).toBeGreaterThan(estimates[0].allowedPromptTokens);
		expect(estimates.at(-1).promptTokens).toBeLessThan(estimates.at(-1).allowedPromptTokens);
	} finally { storage.database.close(); }
});
