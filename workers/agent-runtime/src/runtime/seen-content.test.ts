/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { markBotSeenContent, type SeenContentItem } from '@bickr/shared/social';
import type { D1DatabaseLike, D1PreparedStatementLike } from '@bickr/shared/storage';

function database() {
	const sql = new DatabaseSync(':memory:');
	sql.exec(`CREATE TABLE bot_seen_content (bot_id TEXT, object_type TEXT, object_id TEXT, seen_via TEXT, first_seen_at TEXT, last_seen_at TEXT, source_id TEXT, PRIMARY KEY(bot_id, object_type, object_id))`);
	const calls: unknown[][] = [];
	const db: D1DatabaseLike = {
		batch: (statements) => Promise.all(statements.map((statement) => statement.run())),
		prepare(query) {
			let values: SQLInputValue[] = [];
			const statement: D1PreparedStatementLike = {
				bind(...input) { values = input as SQLInputValue[]; return statement; },
				async run() { calls.push(values); sql.prepare(query).run(...values); return { success: true }; },
				async first<T>() { return sql.prepare(query).get(...values) as T ?? null; },
				async all<T>() { return { success: true, results: sql.prepare(query).all(...values) as T[] }; },
			};
			return statement;
		},
	};
	return { sql, db, calls };
}
const items = (count: number): SeenContentItem[] => Array.from({ length: count }, (_, i) => ({ type: 'comment', id: `comment-${i}` }));

describe('set-oriented seen writes in real SQLite', () => {
	it('writes more than 14 items once and preserves first seen, source and dedupe semantics on upsert', async () => {
		const { sql, db, calls } = database();
		await markBotSeenContent(db, 'bot', [...items(40), ...items(20)], 'read', 'first', '2026-01-01');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toHaveLength(5);
		expect(sql.prepare('SELECT count(*) AS count FROM bot_seen_content').get()).toMatchObject({ count: 40 });
		await markBotSeenContent(db, 'bot', items(20), 'reply', undefined, '2026-01-02');
		expect(sql.prepare("SELECT * FROM bot_seen_content WHERE object_id = 'comment-1'").get()).toMatchObject({ first_seen_at: '2026-01-01', last_seen_at: '2026-01-02', seen_via: 'reply', source_id: null });
		expect(sql.prepare("SELECT * FROM bot_seen_content WHERE object_id = 'comment-30'").get()).toMatchObject({ last_seen_at: '2026-01-01', source_id: 'first' });
		sql.close();
	});
	it('does no work for empty input and splits at the row bound without dropping rows', async () => {
		const { sql, db, calls } = database();
		await markBotSeenContent(db, 'bot', [], 'read');
		expect(calls).toHaveLength(0);
		await markBotSeenContent(db, 'bot', items(1001), 'read');
		expect(calls).toHaveLength(2);
		expect(sql.prepare('SELECT count(*) AS count FROM bot_seen_content').get()).toMatchObject({ count: 1001 });
		sql.close();
	});
	it('bounds encoded bytes including Unicode and rejects an oversized single item', async () => {
		const { sql, db, calls } = database();
		await markBotSeenContent(db, 'bot', items(30).map((item) => ({ ...item, id: item.id + '🦊'.repeat(3000) })), 'read');
		expect(calls.length).toBeGreaterThan(1);
		for (const call of calls) expect(new TextEncoder().encode(String(call[4])).length).toBeLessThanOrEqual(256 * 1024);
		await expect(markBotSeenContent(db, 'bot', [{ type: 'comment', id: 'x'.repeat(256 * 1024) }], 'read')).rejects.toBeInstanceOf(RangeError);
		sql.close();
	});
});

it('preserves newest provenance and earliest first-seen when a timed-out older write finishes late', async () => {
 const { sql, db } = database();
 await markBotSeenContent(db, 'bot', items(1), 'reply', 'newer', '2026-01-02');
 await markBotSeenContent(db, 'bot', items(1), 'read', 'older', '2026-01-01');
 expect(sql.prepare('SELECT * FROM bot_seen_content').get()).toMatchObject({ first_seen_at: '2026-01-01', last_seen_at: '2026-01-02', seen_via: 'reply', source_id: 'newer' });
 sql.close();
});
