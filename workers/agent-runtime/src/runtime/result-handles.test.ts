import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1PreparedStatementLike, KVNamespaceLike } from '@bickr/shared/storage';
import { backfillDeletedReferenceHandles, backfillOwnedDeletedReferenceHandle } from '@bickr/shared/deleted-reference-handles';
import { currentResultHandles, resultHandleKey } from './result-handles';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach(database => database.close()));
function fixture() {
	const database = new DatabaseSync(':memory:'); databases.push(database);
	database.exec('CREATE TABLE bots_index (bot_id TEXT PRIMARY KEY, handle TEXT, handle_at_deletion TEXT, deleted_at TEXT); CREATE TABLE forums_index (forum_id TEXT PRIMARY KEY, handle TEXT, handle_at_deletion TEXT, deleted_at TEXT);');
	const calls: { query: string; values: unknown[] }[] = [];
	const statement = (query: string, values: unknown[] = []): D1PreparedStatementLike => ({
		bind: (...values) => statement(query, values),
		async first<T>() { return database.prepare(query).get(...values as SQLInputValue[]) as T ?? null; },
		async all<T>() { calls.push({ query, values }); return { success: true, results: database.prepare(query).all(...values as SQLInputValue[]) as T[] }; },
		async run() { const result = database.prepare(query).run(...values as SQLInputValue[]); return { success: true, meta: { changes: Number(result.changes) } }; },
	});
	const db: D1DatabaseLike = { prepare: query => statement(query), batch: statements => Promise.all(statements.map(statement => statement.run())) };
	return { database, db, calls };
}
describe('current handles for result views', () => {
	it('uses one JSON binding per table for more than 100 IDs and re-reads renames', async () => {
		const f = fixture();
		const refs = Array.from({ length: 250 }, (_, index) => ({ kind: 'participant' as const, entityId: `bot_${index}`, handle: `before${index}` }));
		for (const ref of refs) f.database.prepare('INSERT INTO bots_index VALUES (?,?,NULL,NULL)').run(ref.entityId, ref.handle);
		f.database.prepare("INSERT INTO forums_index VALUES ('forum','general',NULL,NULL)").run();
		const all = [...refs, { kind: 'forum' as const, entityId: 'forum', handle: 'general' }];
		const first = await currentResultHandles(f.db, all);
		expect(f.calls).toHaveLength(2);
		expect(f.calls.every(call => call.values.length === 1 && call.query.includes('json_each(?)'))).toBe(true);
		f.database.prepare("UPDATE bots_index SET handle='after' WHERE bot_id='bot_0'").run();
		const second = await currentResultHandles(f.db, all);
		expect(first.get(resultHandleKey(refs[0]!))?.handle).toBe('before0');
		expect(second.get(resultHandleKey(refs[0]!))?.handle).toBe('after');
	});
	it('uses the deletion handle and falls back to the view when a backfill is still missing', async () => {
		const f = fixture();
		f.database.prepare("INSERT INTO bots_index VALUES ('one','deleted-one','alice','2026-10-23'),('two','deleted-two',NULL,'2026-10-23')").run();
		const one = { kind: 'participant' as const, entityId: 'one', handle: 'alice' };
		const two = { kind: 'participant' as const, entityId: 'two', handle: 'bob' };
		const handles = await currentResultHandles(f.db, [one, two]);
		expect(handles.get(resultHandleKey(one))).toEqual({ handle: 'alice', deleted: true });
		expect(handles.get(resultHandleKey(two))).toEqual({ deleted: true });
	});
});
describe('deletion handle backfill', () => {
	it('uses bounded pages, preserves writer data, and reports missing KV documents', async () => {
		const f = fixture();
		f.database.prepare("INSERT INTO bots_index VALUES ('one','deleted-one',NULL,'now'),('two','deleted-two',NULL,'now'),('three','deleted-three','writer-value','now')").run();
		f.database.prepare("INSERT INTO forums_index VALUES ('forum','deleted-forum',NULL,'now')").run();
		const documents = new Map<string, unknown>([['v1:bot:one', { type: 'bot', id: 'one', deletedAt: 'now', handleAtDeletion: 'alice' }], ['v1:forum:forum', { type: 'forum', id: 'forum', deletedAt: 'now', handleAtDeletion: 'general' }]]);
		const kv: KVNamespaceLike = { get: async key => documents.get(key) ?? null, put: async () => { throw new Error('The backfill must not write KV.'); }, delete: async () => { throw new Error('The backfill must not delete KV.'); } };
		const repair = (request: import('@bickr/shared/index-repair').OwnedObjectIndexRepairRequest) => backfillOwnedDeletedReferenceHandle(kv, f.db, request);
		const first = await backfillDeletedReferenceHandles(f.db, repair, undefined, 1);
		expect(first).toEqual({ updated: 1, missingIds: [], nextCursor: { kind: 'participant', afterId: 'one' } });
		const second = await backfillDeletedReferenceHandles(f.db, repair, first.nextCursor!, 1);
		expect(second).toEqual({ updated: 0, missingIds: ['two'], nextCursor: { kind: 'participant', afterId: 'two' } });
		const third = await backfillDeletedReferenceHandles(f.db, repair, second.nextCursor!, 1);
		const fourth = await backfillDeletedReferenceHandles(f.db, repair, third.nextCursor!, 1);
		expect(fourth.updated).toBe(1);
		expect(f.database.prepare("SELECT handle_at_deletion FROM bots_index WHERE bot_id='three'").get()).toEqual({ handle_at_deletion: 'writer-value' });
	});
});
