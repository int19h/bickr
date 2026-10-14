import { describe, expect, it } from 'vitest';
import { botText } from '../workers/agent-runtime/src/localization';
import { providerChatCompletionRequest, providerCompactionRequest, providerTokenProbeRequest, providerTranslationRequest } from '../workers/agent-runtime/src/runtime/bot-runtime';

describe('provider request affinity across text operations', () => {
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
