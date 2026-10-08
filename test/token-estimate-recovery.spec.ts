import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi, testEnv, fakeBotDocument } from './helpers/index-harness';
import { providerCompactionSummaryLimitsForChat, estimateChatMessagesTokens, chatMessagesCharacterCount } from '../workers/agent-runtime/src/compaction/limits';
import type { LocalizedProviderSettings } from '../workers/agent-runtime/src/provider-requests';
import type { RuntimeBotDocument } from '../workers/agent-runtime/src/types';
import type { ChatMessage } from '../workers/agent-runtime/src/types';
import { PromptContextBudgetExceededError } from '../workers/agent-runtime/src/errors';
import { botText } from '../workers/agent-runtime/src/localization';
import { providerCompactionSummaryProperty } from '../workers/agent-runtime/src/prompt-and-tools';

type Estimate = { promptTokens: number; source: string; calibrationSampleCount: number; baselinePromptTokens?: number };
type InspectRuntime = {
	recordInferenceSubmission(input: unknown): void;
	recordProviderTokenCalibrationSample(input: unknown): void;
	estimateProviderPromptTokens(settings: LocalizedProviderSettings, messages: ChatMessage[], tools: []): Estimate;
	compactionCandidateEstimates(calibration: { tokensPerCharacter: number; sampleCount: number }): Array<{ tokens: number }>;
	ensureProviderPromptWithinBudget(bot: RuntimeBotDocument, settings: LocalizedProviderSettings, runId: string, signal: AbortSignal, tools: []): Promise<unknown>;
	throwIfStopped(runId: string, signal: AbortSignal): void;
	renewProgressLease(...args: unknown[]): Promise<void>;
	botWithCurrentRuntimeBudget(bot: RuntimeBotDocument): Promise<RuntimeBotDocument>;
	callProviderForCompaction(settings: LocalizedProviderSettings, messages: ChatMessage[], runId: string, signal: AbortSignal,
		limits: { minLength: number; maxLength: number; maxCompletionTokens: number; compactedCharacterCount: number; tokensPerCharacter: number },
		tools: [], mode: 'structured_output', requestSeq: number): Promise<unknown>;
};

describe('token estimates in a constructed SQLite Durable Object', () => {
	it.each(['schema', 'non_reducing', 'output_limit'] as const)('uses reported counts after rejecting a %s compaction response', async (failure) => {
		const text = botText('en');
		const settings: LocalizedProviderSettings = { text, baseUrl: 'https://provider.test/v1', model: 'test/rejected', toolCalls: 'at_will', temperature: 0.2 };
		const messages: ChatMessage[] = [{ role: 'system', content: 'я'.repeat(41_207) }, { role: 'assistant', content: 'я'.repeat(1_000) }];
		const stub = testEnv.BOT_RUNTIME.get(testEnv.BOT_RUNTIME.idFromName(`token-rejected-${failure}`));
		await runInDurableObject(stub, async (instance, state) => {
			const runtime = instance as unknown as InspectRuntime;
			const stop = vi.spyOn(runtime, 'throwIfStopped').mockImplementation(() => {});
			const counts: number[] = [];
			const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
				const request = JSON.parse(String(init.body));
				const promptTokens = Math.floor((chatMessagesCharacterCount(request.messages) + JSON.stringify(request.tools ?? []).length + JSON.stringify(request.response_format ?? {}).length) / 10);
				counts.push(promptTokens);
				return Response.json({ model: 'response/model', choices: [{ finish_reason: failure === 'output_limit' ? 'length' : 'stop',
					message: { content: JSON.stringify(failure === 'schema' ? { wrong: 'Invalid schema.' } : { [providerCompactionSummaryProperty]: 'я'.repeat(500) }) } }],
					usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 } });
			});
			vi.stubGlobal('fetch', fetch);
			try {
				const attempt = runtime.callProviderForCompaction(settings, messages, 'rejected', new AbortController().signal,
					{ minLength: 1, maxLength: 1_000, maxCompletionTokens: 1_000, compactedCharacterCount: 100, tokensPerCharacter: 0.25 }, [], 'structured_output', 1);
				if (failure === 'non_reducing') await expect(attempt).rejects.toMatchObject({ name: 'ProviderCompactionRequestError', originalError: { validationIssue: 'non_reducing_compaction' } });
				else await expect(attempt).rejects.toThrow();
				const samples = state.storage.sql.exec<{ prompt_tokens: number; requested_model: string; response_model: string }>(
					'SELECT prompt_tokens, requested_model, response_model FROM provider_token_calibration_samples ORDER BY id').toArray();
				expect(samples.map(sample => sample.prompt_tokens)).toEqual(counts);
				expect(samples.length).toBeGreaterThan(0);
				expect(samples.every(sample => sample.requested_model === settings.model && sample.response_model === 'response/model')).toBe(true);
				const next = runtime.estimateProviderPromptTokens(settings, messages, []);
				expect(next).toMatchObject({ source: 'full_estimate', calibrationSampleCount: counts.length });
				expect(next.promptTokens).toBeLessThan(5_000);
			} finally { stop.mockRestore(); vi.unstubAllGlobals(); }
		});
	});

	it.each(['ru', 'ar', 'ja', 'hi'] as const)('retains measured %s calibration after history is replaced', async (locale) => {
		const text = botText(locale);
		const settings: LocalizedProviderSettings = { text, baseUrl: 'https://provider.test/v1', model: 'test/calibrated', toolCalls: 'at_will', temperature: 0.2 };
		const letter = { ru: 'я', ar: 'ع', ja: '日', hi: 'अ' }[locale];
		const persona = letter.repeat(41_207);
		const original: ChatMessage[] = [{ role: 'system', content: persona }, { role: 'assistant', content: letter.repeat(80_000) }];
		const compacted: ChatMessage[] = [{ role: 'system', content: persona }, { role: 'assistant', content: letter.repeat(1_000) }];
		const stub = testEnv.BOT_RUNTIME.get(testEnv.BOT_RUNTIME.idFromName(`token-estimate-${locale}`));
		await runInDurableObject(stub, (instance, state) => {
			const runtime = instance as unknown as InspectRuntime;
			const createdAt = new Date().toISOString();
			const uncalibrated = runtime.estimateProviderPromptTokens(settings, compacted, []);
			expect(uncalibrated.calibrationSampleCount).toBe(0);
			expect(uncalibrated.promptTokens).toBeLessThan(12_000);
			runtime.recordInferenceSubmission({ seq: 1, runId: 'measured', purpose: 'loop', settings, messages: original, createdAt });
			runtime.recordProviderTokenCalibrationSample({ attempt: 1, createdAt, purpose: 'loop', request: { messages: original, tools: [] }, requestSeq: 1,
				runId: 'measured', settings, usage: { promptTokens: 12_123, completionTokens: 1, totalTokens: 12_124 } });
			state.storage.sql.exec(`INSERT INTO provider_usage (run_id, request_seq, requested_model, model, context_window_tokens, provider_base_url,
				prompt_tokens, completion_tokens, total_tokens, usage_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				'measured', 1, settings.model, settings.model, 60_000, settings.baseUrl, 12_123, 1, 12_124, '{}', createdAt);
			const same = runtime.estimateProviderPromptTokens(settings, original, []);
			expect(same).toMatchObject({ source: 'baseline_plus_delta', baselinePromptTokens: 12_123, calibrationSampleCount: 1 });
			const after = runtime.estimateProviderPromptTokens(settings, compacted, []);
			expect(after).toMatchObject({ source: 'full_estimate', calibrationSampleCount: 1 });
			expect(after.promptTokens).toBeLessThan(5_000);
			expect(after.promptTokens).toBeLessThan(uncalibrated.promptTokens / 2);
			// Old rows remain stored, but their former byte-floor estimates cannot drive compaction.
			state.storage.sql.exec(`INSERT INTO loop_messages (position, run_id, role, message_json, origin, token_estimate, created_at)
				VALUES (1, 'old', 'assistant', ?, 'provider_response', 999999, ?)`, JSON.stringify(compacted[1]), createdAt);
			expect(runtime.compactionCandidateEstimates({ tokensPerCharacter: 0.1, sampleCount: 1 })[0]?.tokens).toBeLessThan(110);
		});
	});

	it('does not compact a long Russian persona that fits the rough budget', async () => {
		const bot = { ...fakeBotDocument({ contextWindowTokens: 60_000 }), language: 'ru', prompt: { lang: 'ru', text: 'я'.repeat(41_207) } } as RuntimeBotDocument;
		const settings: LocalizedProviderSettings = { text: bot.text, baseUrl: 'https://provider.test/v1', model: 'test/long-prompt', toolCalls: 'at_will', temperature: 0.2 };
		const stub = testEnv.BOT_RUNTIME.get(testEnv.BOT_RUNTIME.idFromName('token-long-persona'));
		await runInDurableObject(stub, async (instance) => {
			const runtime = instance as unknown as InspectRuntime;
			const lease = vi.spyOn(runtime, 'renewProgressLease').mockResolvedValue();
			const lookup = vi.spyOn(runtime, 'botWithCurrentRuntimeBudget').mockResolvedValue(bot);
			try {
				await expect(runtime.ensureProviderPromptWithinBudget(bot, settings, 'long', new AbortController().signal, [])).resolves.toMatchObject({ promptTokens: expect.any(Number) });
				const oversized = { ...bot, prompt: { ...bot.prompt, text: 'я'.repeat(300_000) } };
				lookup.mockResolvedValue(oversized);
				await expect(runtime.ensureProviderPromptWithinBudget(oversized, settings, 'oversized', new AbortController().signal, [])).rejects.toBeInstanceOf(PromptContextBudgetExceededError);
			} finally { lease.mockRestore(); lookup.mockRestore(); }
		});
	});

	it.each(['ru', 'ar', 'ja', 'hi'] as const)('sizes future %s summaries from provider calibration', (locale) => {
		const bot = { ...fakeBotDocument({ contextWindowTokens: 60_000, compactionMaxCharacters: 20_000, compactionSummaryPercent: 50 }), text: botText(locale), language: locale } as RuntimeBotDocument;
		const messages: ChatMessage[] = [{ role: 'assistant', content: 'я日عअ'.repeat(10_000) }];
		const low = providerCompactionSummaryLimitsForChat(bot, messages, { tokensPerCharacter: 0.1, sampleCount: 50 });
		const high = providerCompactionSummaryLimitsForChat(bot, messages, { tokensPerCharacter: 0.9, sampleCount: 50 });
		expect(low.maxSummaryTokens).toBe(2_000);
		expect(high.maxSummaryTokens).toBe(18_000);
		expect(low.nextCompactionTokens).toBeGreaterThan(high.nextCompactionTokens);
		expect(estimateChatMessagesTokens(messages, { tokensPerCharacter: 0.1, sampleCount: 50 })).toBeLessThan(4_010);
	});
});
