import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { dispatchDueBots } from './scheduler';
import type { Env } from '../types';

function fixture(count: number) {
	const db = new DatabaseSync(':memory:');
	db.exec(`CREATE TABLE maintenance_control (id INTEGER, enabled INTEGER, message TEXT, activated_at TEXT, updated_at TEXT);
		INSERT INTO maintenance_control VALUES (1,0,'Maintenance',NULL,'2026-10-02');
		CREATE TABLE bots_index (bot_id TEXT PRIMARY KEY, deleted_at TEXT, lifecycle_state TEXT);
		CREATE TABLE bot_runtime_index (bot_id TEXT PRIMARY KEY, enabled INTEGER, next_due_at TEXT, lease_expires_at TEXT);`);
	for (let index = 0; index < count; index++) {
		const id = `bot-${String(index).padStart(3, '0')}`;
		db.prepare("INSERT INTO bots_index VALUES (?,NULL,'active')").run(id);
		db.prepare("INSERT INTO bot_runtime_index VALUES (?,1,'2026-10-01',NULL)").run(id);
	}
	const attempts: string[] = [];
	const fetch = vi.fn(async (id: string) => {
		attempts.push(id);
		return new Response(null, { status: 503 });
	});
	const env = {
		INTERNAL_SERVICE_SECRET: 'test',
		BICKR_D1: { prepare(query: string) {
			return { bind(...params: (string | number | null)[]) {
				return { first: async () => db.prepare(query).get(...params), all: async () => ({ results: db.prepare(query).all(...params) }) };
			} };
		} },
		BOT_RUNTIME: { idFromName: (id: string) => id, get: (id: string) => ({ fetch: () => fetch(id) }) },
	} as unknown as Env;
	return { db, env, attempts, fetch };
}

describe('fair due-bot dispatch', () => {
	it('passes a full failed page and attempts each selected bot only once', async () => {
		const f = fixture(21);
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = await dispatchDueBots(f.env, Date.parse('2026-10-02'), { batchSize: 20, maxDispatches: 2000 });
			expect(result).toEqual({ dispatched: 21, budgetExhausted: false });
			expect(new Set(f.attempts).size).toBe(21);
			expect(f.attempts.at(-1)).toBe('bot-020');
		} finally { f.db.close(); warning.mockRestore(); }
	});
	it('keeps the selected cursor if successful dispatch changes its due time', async () => {
		const f = fixture(5);
		f.fetch.mockImplementation(async id => {
			f.attempts.push(id);
			f.db.prepare("UPDATE bot_runtime_index SET next_due_at = '2026-11-01' WHERE bot_id = ?").run(id);
			return new Response(null, { status: 204 });
		});
		try {
			expect(await dispatchDueBots(f.env, Date.parse('2026-10-02'), { batchSize: 2, maxDispatches: 10 })).toEqual({ dispatched: 5, budgetExhausted: false });
			expect(new Set(f.attempts).size).toBe(5);
		} finally { f.db.close(); }
	});
	it('honors the work budget even when every selected visit fails', async () => {
		const f = fixture(7);
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(await dispatchDueBots(f.env, Date.parse('2026-10-02'), { batchSize: 2, maxDispatches: 3 })).toEqual({ dispatched: 3, budgetExhausted: true });
			expect(f.attempts).toEqual(['bot-000', 'bot-001', 'bot-002']);
		} finally { f.db.close(); warning.mockRestore(); }
	});
});
