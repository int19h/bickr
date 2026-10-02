import { describe, expect, it } from 'vitest';
import { BotRuntime } from './bot-runtime';

describe('forum mutation identity', () => {
	it('reuses one request key for a retry and separates tool invocations and bulk items', async () => {
		const keys: string[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: { INTERNAL_SERVICE_SECRET: 'test', FORUM_COORDINATOR_SERVICE: { fetch: async (request: Request) => {
				keys.push(request.headers.get('x-bickr-idempotency-key')!);
				return Response.json({ ok: true, data: { created: true } });
			} } },
		});
		const signal = new AbortController().signal;
		const dispatch = (invocation: string, body: unknown) => runtime.forumService('/threads/create', 'bot', body, signal, undefined, invocation);
		await dispatch('run:1:call', { title: 'First' });
		await dispatch('run:1:call', { title: 'First' });
		await dispatch('run:1:call', { title: 'Second' });
		await dispatch('run:2:call', { title: 'First' });
		expect(keys[0]).toMatch(/^[a-f0-9]{64}$/u);
		expect(keys[0]).toBe(keys[1]);
		expect(new Set(keys).size).toBe(3);
	});
});
