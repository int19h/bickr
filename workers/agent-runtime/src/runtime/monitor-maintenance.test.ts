import { describe, expect, it, vi } from 'vitest';
import { BotRuntime } from './bot-runtime';

function fixture(enabled: boolean, unavailable = false) {
	const injectThought = vi.fn(() => ({ event: { type: 'thought_injected' } }));
	const send = vi.fn();
	const first = vi.fn(async () => {
		if (unavailable) throw new Error('D1 unavailable');
		return { enabled: Number(enabled), message: 'Maintenance.', activatedAt: null, updatedAt: '2026-10-02' };
	});
	const runtime = Object.assign(Object.create(BotRuntime.prototype), {
		env: { BICKR_D1: { prepare: () => ({ bind: () => ({ first }) }) } }, injectThought,
	});
	return { runtime, injectThought, send, first };
}

describe('monitor writes during maintenance', () => {
	it.each([{ enabled: true, unavailable: false }, { enabled: false, unavailable: true }])('refuses socket injection when control is $enabled/$unavailable', async ({ enabled, unavailable }) => {
		const f = fixture(enabled, unavailable);
		await f.runtime.webSocketMessage({ send: f.send }, JSON.stringify({ type: 'inject', text: 'Hello' }));
		expect(f.injectThought).not.toHaveBeenCalled();
		expect(JSON.parse(f.send.mock.calls[0]![0])).toMatchObject({ type: 'error', code: 'maintenance' });
	});
	it('checks maintenance on every injection while permitting ping', async () => {
		const f = fixture(false);
		await f.runtime.webSocketMessage({ send: f.send }, '{"type":"ping"}');
		expect(f.first).not.toHaveBeenCalled();
		await f.runtime.webSocketMessage({ send: f.send }, '{"type":"inject","text":"Hello"}');
		expect(f.injectThought).toHaveBeenCalledOnce();
		f.first.mockResolvedValueOnce({ enabled: 1, message: 'Maintenance.', activatedAt: null, updatedAt: '2026-10-02' });
		await f.runtime.webSocketMessage({ send: f.send }, '{"type":"inject","text":"Again"}');
		expect(f.injectThought).toHaveBeenCalledOnce();
	});
});
