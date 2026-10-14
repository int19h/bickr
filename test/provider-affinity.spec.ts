import { describe, expect, it } from 'vitest';
import { botText } from '../workers/agent-runtime/src/localization';
import { providerTranslationToolDefinitions } from '../workers/agent-runtime/src/prompt-and-tools';
import { providerChatCompletionRequest, providerCompactionRequest, providerTokenProbeRequest, providerTranslationRequest } from '../workers/agent-runtime/src/runtime/bot-runtime';

describe('provider request affinity across text operations', () => {
	it('respects the Muse probe minimum without changing other request budgets', () => {
		const messages = [{ role: 'system' as const, content: 'Stable instructions.' }, { role: 'user' as const, content: 'Count prompt tokens.' }];
		for (const model of ['meta/muse-spark-1.3', 'meta/muse-spark-1.3-contributor', '~meta/muse-spark-1.3', 'meta/muse-spark-1.3:free']) {
			const settings = { text: botText('en'), baseUrl: 'https://openrouter.ai/api/v1', model, temperature: 0.2 };
			const probe = providerTokenProbeRequest(settings, messages, [], 'bot:affinity');
			expect(probe.max_tokens).toBe(16);
			expect(probe.prompt_cache_key).toBe('bot:affinity');
			expect(probe.prompt_cache_retention).toBe('24h');
			const loop = providerChatCompletionRequest(settings, messages, [], undefined, 'railroad', 'bot:affinity', 1024);
			expect(loop.max_completion_tokens).toBe(1024);
			expect(probe.messages).toEqual(loop.messages);
		}
		for (const provider of [
			{ baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct', expected: 1 },
			{ baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini', expected: 1 },
			{ baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3', expected: 16 },
			{ baseUrl: 'https://custom.example/v1', model: 'meta/muse-spark-1.3', expected: 1 },
		]) {
			expect(providerTokenProbeRequest({ text: botText('en'), temperature: 0.2, ...provider }, messages, [], 'bot:affinity').max_tokens).toBe(provider.expected);
		}
	});
	it('removes retained loop tools when Muse cannot disable their selection', () => {
		const tools = providerTranslationToolDefinitions(botText('en'));
		const messages = [{ role: 'user' as const, content: 'Summarize the history.' }];
		for (const provider of [
			{ baseUrl: 'https://openrouter.ai/api/v1', model: 'meta/muse-spark-1.3' },
			{ baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3-contributor' },
			{ baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3' },
		]) {
			const request = providerCompactionRequest({ text: botText('en'), ...provider }, messages, undefined, tools, 'structured_output', undefined, 'bot:affinity');
			expect(request).not.toHaveProperty('tools');
			expect(request).not.toHaveProperty('tool_choice');
			expect(request).not.toHaveProperty('parallel_tool_calls');
			expect(request.response_format?.type).toBe('json_schema');
			expect(request.prompt_cache_key).toBe('bot:affinity');
		}
		const contributorFallback = providerCompactionRequest({ text: botText('en'), baseUrl: 'https://openrouter.ai/api/v1', model: 'meta/muse-spark-1.3-contributor' }, messages, undefined, tools, 'structured_output', undefined, 'bot:affinity');
		if (!contributorFallback.response_format) {
			expect(contributorFallback.tools).toEqual(tools);
			expect(contributorFallback).not.toHaveProperty('tool_choice');
		}
		for (const provider of [
			{ baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' },
			{ baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct' },
			{ baseUrl: 'https://custom.example/v1', model: 'meta/muse-spark-1.3' },
		]) {
			const request = providerCompactionRequest({ text: botText('en'), ...provider }, messages, undefined, tools, 'structured_output', undefined, 'bot:affinity');
			if (request.response_format) {
				expect(request.tools).toEqual(tools);
				expect(request.tool_choice).toBe('none');
			}
		}
	});
	it.each(['meta/muse-spark-1.3', 'meta-llama/llama-3.3-70b-instruct', 'openai/gpt-5-mini'])('carries session identity through every builder for %s', model => {
		const settings = { text: botText('en'), baseUrl: 'https://openrouter.ai/api/v1', model, temperature: 0.2 };
		const messages = [{ role: 'system' as const, content: 'Stable instructions.' }, { role: 'user' as const, content: 'Hello.' }];
		const requests = [
			providerChatCompletionRequest(settings, messages, [], undefined, 'railroad', 'bot:affinity'),
			providerCompactionRequest(settings, messages, undefined, [], 'structured_output', undefined, 'bot:affinity'),
			providerTokenProbeRequest(settings, messages, [], 'bot:affinity'),
			providerTranslationRequest({ ...settings, prompt: 'Translate.', toolCallRequest: { kind: 'provider_default' } }, 'Hello.', 'translation:affinity'),
		];
		for (const request of requests) {
			expect(request.session_id).toMatch(/^(bot|translation):affinity$/);
			if (model.startsWith('meta')) {
				expect(request.prompt_cache_key).toBe(request.session_id);
				expect(request.prompt_cache_retention).toBe('24h');
			} else {
				expect(request).not.toHaveProperty('prompt_cache_key');
				expect(request).not.toHaveProperty('prompt_cache_retention');
			}
		}
	});
});
