import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimeMonitorInitialBackfillLimit } from '../constants';
import { RuntimeMessageStore } from './message-store';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';

describe('RuntimeMessageStore', () => {
	let storage: RuntimeTestStorage;
	let store: RuntimeMessageStore;

	beforeEach(() => {
		storage = createRuntimeTestStorage();
		store = new RuntimeMessageStore(storage);
	});

	afterEach(() => storage.database.close());

	it('returns the newest active loop messages in display order for capped initial backfill', () => {
		for (const seq of range(1, 150)) {
			insertMessage(storage, seq, seq);
		}

		const messages = store.loopMessagesAfter(0, runtimeMonitorInitialBackfillLimit);

		expect(messages).toHaveLength(runtimeMonitorInitialBackfillLimit);
		expect(messages[0]?.seq).toBe(51);
		expect(messages.at(-1)?.seq).toBe(150);
	});

	it('keeps reconnect catch-up based on the requested sequence instead of the initial cap', () => {
		for (const seq of range(1, 150)) {
			insertMessage(storage, seq, seq);
		}

		expect(store.loopMessagesAfter(120).map((message) => message.seq)).toEqual(range(121, 150));
	});

	it('constructs nested compaction pages from active history to the oldest source', () => {
		insertMessage(storage, 1, 1, { compactedBy: 10 });
		insertMessage(storage, 2, 2, { compactedBy: 10, origin: 'compaction' });
		insertMessage(storage, 3, 3, { compactedBy: 2 });
		insertMessage(storage, 10, 10, { origin: 'compaction' });
		insertMessage(storage, 11, 11);

		const pageIndex = store.loopMessagePageIndex();

		expect(pageIndex.descriptors).toEqual([
			{ page: 1, sourceCompactionSeq: null },
			{ page: 2, sourceCompactionSeq: 10, newerPage: 1 },
			{ page: 3, sourceCompactionSeq: 2, newerPage: 2 },
		]);
		expect([...pageIndex.compactionPageBySeq.entries()]).toEqual([[10, 2], [2, 3]]);
		expect(store.loopMessagesPage({ page: 2 }).messages.map((message) => message.seq)).toEqual([1, 2]);
	});

	it('repositions active rows in the requested order without moving compacted or deleted rows', () => {
		insertMessage(storage, 1, 10);
		insertMessage(storage, 2, 20);
		insertMessage(storage, 3, 30);
		insertMessage(storage, 4, 40, { compactedBy: 9 });
		insertMessage(storage, 5, 50, { deletedAt: '2026-07-01T00:00:00.000Z' });

		store.updateActiveLoopMessagePositions([3, 1, 2]);

		expect(store.activeLoopMessageRows().map((row) => [row.seq, row.position])).toEqual([[3, 10], [1, 11], [2, 12]]);
		expect(messagePosition(storage, 4)).toBe(40);
		expect(messagePosition(storage, 5)).toBe(50);
	});

	it('reconstructs retained loop message logs from full, append, and tail-replacement entries', () => {
		insertMessage(storage, 1, 1);

		const requestBase = 'short request';
		const requestAppend = `${requestBase} with appended body`;
		const responseBase = `${'A'.repeat(320)}old response tail`;
		const responseReplacement = `${'A'.repeat(320)}new response tail`;
		store.recordLoopMessageLog(1, 'provider_request', requestBase);
		store.recordLoopMessageLog(1, 'provider_request', requestAppend);
		store.recordLoopMessageLog(1, 'provider_response', responseBase);
		store.recordLoopMessageLog(1, 'provider_response', responseReplacement);

		const logs = store.loopMessageLogsForSeq(1).logs;
		expect(logs.map((log) => log.encoding)).toEqual(['full', 'append', 'full', 'replace_tail']);
		expect(logs.map((log) => log.text)).toEqual([requestBase, requestAppend, responseBase, responseReplacement]);
		expect(logs[1]?.baseLogId).toBe(logs[0]?.id);
		expect(logs[3]?.baseLogId).toBe(logs[2]?.id);
		expect(logs[3]?.prefixLength).toBe(320);
	});
});

function insertMessage(
	storage: RuntimeTestStorage,
	seq: number,
	position: number,
	options: { compactedBy?: number; deletedAt?: string; origin?: 'compaction' | 'input' } = {},
): void {
	storage.database.prepare(
		`INSERT INTO loop_messages (
			seq, position, run_id, role, message_json, origin, status, token_estimate,
			stream_seq, display_event_seq, compacted_by, deleted_at, created_at
		) VALUES (?, ?, 'run-test', 'user', ?, ?, 'complete', 1, NULL, NULL, ?, ?, '2026-07-10T00:00:00.000Z')`,
	).run(
		seq,
		position,
		JSON.stringify({ role: 'user', content: `message ${seq}` }),
		options.origin ?? 'input',
		options.compactedBy ?? null,
		options.deletedAt ?? null,
	);
}

function messagePosition(storage: RuntimeTestStorage, seq: number): number {
	return storage.database.prepare(`SELECT position FROM loop_messages WHERE seq = ?`).get(seq)?.position as number;
}

function range(start: number, end: number): number[] {
	return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}
