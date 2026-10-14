import { describe, expect, it } from 'vitest';
import { providerChatAffinity, providerImageAffinityHeaders, providerRequestSessionId } from './provider-affinity';

describe('provider request affinity', () => {
	const openRouter = { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' };
	it('identifies every OpenRouter model independently of explicit caching', () => {
		for (const model of ['openai/gpt-5-mini', 'anthropic/claude-sonnet-4', 'vendor/unknown']) {
			expect(providerChatAffinity({ ...openRouter, model }, 'bot:one')).toEqual({ session_id: 'bot:one' });
		}
	});
	it('requests extended caching for both Meta namespaces and aliases', () => {
		for (const model of ['meta/muse-spark-1.3', 'meta/muse-spark-1.3-contributor', 'meta-llama/llama-3.3-70b-instruct', ' ~META/muse-spark-1.3:free ']) {
			expect(providerChatAffinity({ ...openRouter, model }, 'bot:one')).toEqual({
				session_id: 'bot:one', prompt_cache_key: 'bot:one', prompt_cache_retention: '24h',
			});
		}
	});
	it('only applies direct Meta cache fields to its exact chat endpoint', () => {
		for (const baseUrl of ['https://api.meta.ai/v1', 'https://api.meta.ai/v1/chat/completions/']) {
			expect(providerChatAffinity({ baseUrl, model: 'muse-spark-1.3' }, 'bot:one')).toEqual({
				prompt_cache_key: 'bot:one', prompt_cache_retention: '24h',
			});
		}
		for (const baseUrl of ['https://provider.example/v1', 'https://api.meta.ai.evil.example/v1', 'https://api.meta.ai/v2', 'http://api.meta.ai/v1', 'https://api.meta.ai/v1?other=1']) {
			expect(providerChatAffinity({ baseUrl, model: 'meta/muse-spark-1.3' }, 'bot:one')).toEqual({});
		}
	});
	it('keeps explicit entity IDs stable across purposes and changed prompts', async () => {
		expect(await providerRequestSessionId('loop', [], 'bot:one')).toBe('bot:one');
		expect(await providerRequestSessionId('compaction', [{ role: 'system', content: 'changed' }], 'bot:one')).toBe('bot:one');
	});
	it('hashes only stable instructions and separates unrelated purposes', async () => {
		const instructions = [{ role: 'system', content: 'private persona' }, { role: 'developer', content: 'rules' }];
		const first = await providerRequestSessionId('translation', [...instructions, { role: 'user', content: 'first' }]);
		const next = await providerRequestSessionId('translation', [...instructions, { role: 'user', content: 'next' }, { role: 'assistant', content: 'response' }]);
		expect(next).toBe(first);
		expect(first).not.toContain('private');
		expect(first.length).toBeLessThanOrEqual(256);
		expect(await providerRequestSessionId('avatar-description', instructions)).not.toBe(first);
		expect(await providerRequestSessionId('translation', [{ role: 'system', content: 'other persona' }])).not.toBe(first);
		expect(await providerRequestSessionId('translation', [])).not.toBe(await providerRequestSessionId('avatar-description', []));
	});
	it('bounds oversized entity IDs without losing deterministic identity', async () => {
		const id = 'bot:' + 'x'.repeat(300);
		const bounded = await providerRequestSessionId('loop', [], id);
		expect(bounded.length).toBeLessThanOrEqual(256);
		expect(await providerRequestSessionId('loop', [], id)).toBe(bounded);
	});
	it('uses headers for the image endpoint and leaves custom providers unchanged', () => {
		expect(providerImageAffinityHeaders(openRouter, 'image:one')).toEqual({ 'x-session-id': 'image:one' });
		expect(providerImageAffinityHeaders({ baseUrl: 'https://provider.example/v1', model: 'meta/image' }, 'image:one')).toEqual({});
	});
});
