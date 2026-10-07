import { describe, expect, it, vi } from 'vitest';
import { storedNotificationEvent, type NotificationDocument } from './model';
import { instructionLocalizationSweepLimit, sweepBootstrapLocalization } from './instruction-localization-migration';
import type { D1DatabaseLike, KVNamespaceLike } from './storage';

const oldText = { lang: 'ja', text: '  {{name}}\n昔の本文をそのまま残す。  ' };
const document = { id: 'ntf_old', botId: 'bot_a', notificationType: 'bootstrap', message: oldText,
	event: { kind: 'bootstrap', type: 'bootstrap', id: 'ntf_old', createdAt: '2026-01-01', deliveryReasons: ['bootstrap'], message: oldText } } as unknown as NotificationDocument;

describe('localization adapter census', () => {
	it('preserves composed bootstrap text exactly in the single old-shape adapter', () => {
		const adapted = storedNotificationEvent(document.event);
		expect(adapted).toMatchObject({ kind: 'bootstrap', bootstrapVersion: 1, composedMessage: oldText });
		expect(document.event).not.toHaveProperty('bootstrapVersion');
		expect(storedNotificationEvent(adapted)).toEqual(adapted);
	});
	it('keeps current factory descriptors distinct from composed text', () => {
		const event = { kind: 'bootstrap', type: 'bootstrap', bootstrapVersion: 2, customMessage: null, introForum: null, world: { id: 'w', handle: 'w/world' } };
		expect(storedNotificationEvent(event)).toBe(event);
	});
	it('bounds the census, reports missing data, and never mutates notification keys', async () => {
		const bind = vi.fn();
		const rows = [{ id: 'ntf_old', botId: 'bot_a' }, { id: 'ntf_missing', botId: 'bot_b' }];
		const statement = { bind: (...args: unknown[]) => { bind(...args); return statement; }, all: async () => ({ results: rows }) };
		const db = { prepare: vi.fn(() => statement) } as unknown as D1DatabaseLike;
		const kv = { get: vi.fn(async (key: string) => key.includes('ntf_old') ? document : null), put: vi.fn(), delete: vi.fn() } as unknown as KVNamespaceLike;
		const result = await sweepBootstrapLocalization(kv, db, 'ntf_cursor');
		expect(bind).toHaveBeenCalledWith('ntf_cursor', instructionLocalizationSweepLimit);
		expect(result).toMatchObject({ done: true, nextCursor: 'ntf_missing', results: [{ kind: 'composed' }, { kind: 'deferred' }] });
		expect(kv.put).not.toHaveBeenCalled();
		expect(kv.delete).not.toHaveBeenCalled();
	});
});
