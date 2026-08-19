import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotInferenceSubmissionMessage, BotLoopMessage } from '@bickr/shared/model';
import {
	runtimeDiagnosticLoopMessageRetentionCount,
	runtimeMonitorInitialBackfillLimit,
} from '../constants';
import { loopMessageContributesToProviderHistory } from '../provider/sanitize';
import type { ProviderToolCallDropReason } from '../types';
import { loopMessageFromRow, RuntimeMessageStore } from './message-store';
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

	it('restores compacted children before soft-deleting their summary', () => {
		insertMessage(storage, 1, 1, { compactedBy: 10 });
		insertMessage(storage, 2, 2, { compactedBy: 10, origin: 'compaction' });
		insertMessage(storage, 3, 3, { compactedBy: 2 });
		insertMessage(storage, 10, 10, { origin: 'compaction' });
		insertMessage(storage, 11, 11);

		const deleted = store.softDeleteLoopMessage(10, '2026-07-11T00:00:00.000Z');

		expect(deleted).toMatchObject({
			row: { seq: 10, origin: 'compaction' },
			deletedAt: '2026-07-11T00:00:00.000Z',
		});
		expect(messageCompactedBy(storage, 1)).toBeNull();
		expect(messageCompactedBy(storage, 2)).toBeNull();
		expect(store.loopMessagePageIndex().descriptors).toEqual([
			{ page: 1, sourceCompactionSeq: null },
			{ page: 2, sourceCompactionSeq: 2, newerPage: 1 },
		]);
		const reachableSeqs = store.loopMessagePageIndex().descriptors
			.flatMap((descriptor) => store.loopMessagesPage({ page: descriptor.page }).messages.map((message) => message.seq))
			.sort((left, right) => left - right);
		const liveSeqs = storage.database
			.prepare(`SELECT seq FROM loop_messages WHERE deleted_at IS NULL ORDER BY seq ASC`)
			.all()
			.map((row) => row.seq as number);
		expect(reachableSeqs).toEqual(liveSeqs);
	});

	describe('loop retention', () => {
		const now = new Date('2026-08-17T00:00:00.000Z');
		const daysAgo = (days: number): string => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

		it('leaves the active context alone however old it is', () => {
			insertMessage(storage, 1, 1, { createdAt: daysAgo(400) });
			insertMessage(storage, 2, 2, { createdAt: daysAgo(400), origin: 'compaction' });
			insertMessage(storage, 3, 3, { createdAt: daysAgo(30) });

			expect(store.pruneExpiredLoopMessages({ now })).toEqual({
				deletedMessages: 0,
				deletedLogs: 0,
				stampedSummaries: 0,
				pendingMore: false,
			});
			expect(liveSeqs(storage)).toEqual([1, 2, 3]);
		});

		it('deletes compacted rows at 14 days, their summaries only at 180, and owner-deleted rows at 14', () => {
			insertMessage(storage, 1, 1, { createdAt: daysAgo(200), compactedBy: 3 });
			insertMessage(storage, 2, 2, { createdAt: daysAgo(15), compactedBy: 30 });
			insertMessage(storage, 3, 3, { createdAt: daysAgo(190), compactedBy: 30, origin: 'compaction' });
			insertMessage(storage, 4, 4, { createdAt: daysAgo(20), compactedBy: 30, origin: 'compaction' });
			insertMessage(storage, 5, 5, { createdAt: daysAgo(13), compactedBy: 30 });
			insertMessage(storage, 6, 6, { createdAt: daysAgo(20), deletedAt: daysAgo(1) });
			insertMessage(storage, 7, 7, { createdAt: daysAgo(13), deletedAt: daysAgo(1) });
			insertMessage(storage, 30, 30, { createdAt: daysAgo(10), origin: 'compaction' });

			const result = store.pruneExpiredLoopMessages({ now });

			// 3 goes with its own child 1; 4 is a summary inside its retention window;
			// 5 and 7 are inside the 14-day window.
			expect(result).toMatchObject({ deletedMessages: 4, pendingMore: false });
			expect(liveSeqs(storage)).toEqual([4, 5, 7, 30]);
		});

		it('stamps every summary that keeps a child of a pruned batch and refuses to delete it afterwards', () => {
			insertMessage(storage, 1, 1, { createdAt: daysAgo(20), compactedBy: 10 });
			insertMessage(storage, 2, 2, { createdAt: daysAgo(20), compactedBy: 10 });
			insertMessage(storage, 10, 10, { createdAt: daysAgo(20), origin: 'compaction' });

			expect(store.pruneExpiredLoopMessages({ now })).toMatchObject({ deletedMessages: 2, stampedSummaries: 1 });
			expect(ledgerPrunedAt(storage, 10)).toBe(now.toISOString());

			expect(() => store.softDeleteLoopMessage(10)).toThrowError(/Erase the chat history instead/);
			expect(liveSeqs(storage)).toEqual([10]);
			// A stamped summary stays reactivatable: only deleting it is refused.
			storage.database.prepare(`UPDATE loop_messages SET compacted_by = 99 WHERE seq = 10`).run();
			storage.database.prepare(`UPDATE loop_messages SET compacted_by = NULL WHERE seq = 10`).run();
			expect(store.activeLoopMessageRows().map((row) => row.seq)).toEqual([10]);
		});

		it('keeps the first prune stamp and still allows deleting an intact summary', () => {
			insertMessage(storage, 1, 1, { createdAt: daysAgo(20), compactedBy: 10 });
			insertMessage(storage, 10, 10, { createdAt: daysAgo(20), origin: 'compaction', ledgerPrunedAt: daysAgo(5) });
			// Summary 20 keeps every row it absorbed, so it is still a complete record.
			insertMessage(storage, 2, 2, { createdAt: daysAgo(5), compactedBy: 20 });
			insertMessage(storage, 20, 20, { createdAt: daysAgo(4), origin: 'compaction' });

			store.pruneExpiredLoopMessages({ now });

			expect(ledgerPrunedAt(storage, 10)).toBe(daysAgo(5));
			expect(store.softDeleteLoopMessage(20, daysAgo(0))).toMatchObject({ row: { seq: 20 } });
		});

		it('withholds a summary whose child survives the batch and takes it on the next pass', () => {
			insertMessage(storage, 1, 1, { createdAt: daysAgo(200), compactedBy: 10 });
			insertMessage(storage, 10, 10, { createdAt: daysAgo(190), compactedBy: 20, origin: 'compaction' });
			// Absorbed later than the summary that holds it — a resurrected row that
			// a subsequent compaction pulled back in — so a batch can reach the
			// summary before its child.
			insertMessage(storage, 2, 2, { createdAt: daysAgo(150), compactedBy: 10 });
			insertMessage(storage, 20, 20, { createdAt: daysAgo(1), origin: 'compaction' });

			const first = store.pruneExpiredLoopMessages({ now, limit: 2 });

			// The batch stopped below the summary, so the summary is held back rather
			// than orphaning the child that is still there.
			expect(first).toMatchObject({ deletedMessages: 1, stampedSummaries: 1, pendingMore: true });
			expect(liveSeqs(storage)).toEqual([2, 10, 20]);

			expect(store.pruneExpiredLoopMessages({ now, limit: 2 })).toMatchObject({ deletedMessages: 2 });
			expect(liveSeqs(storage)).toEqual([20]);
		});

		it('materializes surviving delta logs before deleting the messages their base belongs to', () => {
			const base = store.appendLoopMessage('run-1', { role: 'assistant', content: `${'A'.repeat(400)} base tail` }, 'provider_response');
			const dependent = store.appendLoopMessage(
				'run-2',
				{ role: 'assistant', content: `${'A'.repeat(400)} dependent tail` },
				'provider_response',
			);
			const dependentLogs = logRows(storage, dependent.seq);
			expect(dependentLogs.map((log) => log.encoding)).toEqual(['replace_tail']);
			const dependentText = store.reconstructLoopMessageLogText(dependentLogs[0]!.id);
			storage.database.prepare(`UPDATE loop_messages SET compacted_by = 99, created_at = ? WHERE seq = ?`)
				.run(daysAgo(20), base.seq);

			expect(store.pruneExpiredLoopMessages({ now })).toMatchObject({ deletedMessages: 1, deletedLogs: 1 });

			expect(logRows(storage, base.seq)).toEqual([]);
			expect(logRows(storage, dependent.seq)).toEqual([
				expect.objectContaining({ encoding: 'full', base_log_id: null }),
			]);
			expect(store.reconstructLoopMessageLogText(dependentLogs[0]!.id)).toBe(dependentText);
		});

		it('stamps the summaries of diagnostic rows the append-time cap deletes', () => {
			const seeded: number[] = [];
			for (let index = 0; index < runtimeDiagnosticLoopMessageRetentionCount; index += 1) {
				seeded.push(store.appendLoopMessage(
					'run-diagnostic',
					{ role: 'user', content: `Bickr Terminal reported failure ${index}.` },
					'runtime_error',
				).seq);
			}
			const oldest = seeded[0]!;
			// Compaction deliberately absorbs diagnostics that never reached the
			// provider, so the capped row can already belong to a ledger.
			insertMessage(storage, 900, 900, { createdAt: daysAgo(1), origin: 'compaction' });
			storage.database.prepare(`UPDATE loop_messages SET compacted_by = 900 WHERE seq = ?`).run(oldest);

			store.appendLoopMessage(
				'run-diagnostic',
				{ role: 'user', content: 'Bickr Terminal reported one more failure.' },
				'runtime_error',
			);

			expect(store.loopMessageRow(oldest)).toBeUndefined();
			expect(ledgerPrunedAt(storage, 900)).not.toBeNull();
		});

		it('spends a sweep allowance one short transaction at a time and leaves the rest pending', async () => {
			insertExpiredMessages(storage, 800, daysAgo(200));
			const batched = countingStore(storage);

			const result = await batched.store.pruneExpiredLoopMessagesWithinBudget({
				now,
				rowAllowance: 500,
				timeBudgetMs: 60_000,
				nowMs: () => 0,
			});

			expect(result).toEqual({
				loopMessages: { deletedMessages: 500, deletedLogs: 0, stampedSummaries: 0, pendingMore: true },
				timeBudgetExhausted: false,
				// The allowance went entirely on real deletions, so there is no position
				// worth carrying: the next pass starts at the bottom, where the rows this
				// one deleted are gone.
				scanCursor: null,
			});
			// The allowance is what the visit spends, never what one input-gate hold
			// covers: two batches of 250, two transactions.
			expect(batched.transactions()).toBe(2);
			expect(liveSeqs(storage)).toHaveLength(300);
		});

		it('spends an allowance that is not a whole number of batches without overshooting it', async () => {
			insertExpiredMessages(storage, 800, daysAgo(200));
			const batched = countingStore(storage);

			const result = await batched.store.pruneExpiredLoopMessagesWithinBudget({
				now,
				rowAllowance: 251,
				timeBudgetMs: 60_000,
				nowMs: () => 0,
			});

			// The allowance is a row count, not a batch count: the second batch asks
			// for the single row left of it rather than another full 250.
			expect(result.loopMessages).toMatchObject({ deletedMessages: 251, pendingMore: true });
			expect(batched.transactions()).toBe(2);
			expect(liveSeqs(storage)).toHaveLength(549);
		});

		it('treats an allowance of zero as nothing to do rather than one batch', async () => {
			insertExpiredMessages(storage, 800, daysAgo(200));
			const batched = countingStore(storage);

			const result = await batched.store.pruneExpiredLoopMessagesWithinBudget({
				now,
				rowAllowance: 0,
				timeBudgetMs: 60_000,
				nowMs: () => 0,
			});

			expect(result).toEqual({
				loopMessages: { deletedMessages: 0, deletedLogs: 0, stampedSummaries: 0, pendingMore: false },
				timeBudgetExhausted: false,
				scanCursor: null,
			});
			// A pass that never looked reports nothing, and touches nothing.
			expect(batched.transactions()).toBe(0);
			expect(liveSeqs(storage)).toHaveLength(800);
		});

		it('stops at the wall-clock budget and keeps everything its completed batches deleted', async () => {
			insertExpiredMessages(storage, 800, daysAgo(200));
			const batched = countingStore(storage);

			const result = await batched.store.pruneExpiredLoopMessagesWithinBudget({
				now,
				rowAllowance: 10_000,
				timeBudgetMs: 8_000,
				// Three seconds a batch, read off the committed batch count rather than
				// off the number of times the loop happens to look: in the deployed
				// runtime the clock only moves across the yield between batches, so it
				// must not matter how often a batch reads it.
				nowMs: () => batched.transactions() * 3_000,
			});

			expect(result).toEqual({
				loopMessages: { deletedMessages: 750, deletedLogs: 0, stampedSummaries: 0, pendingMore: true },
				timeBudgetExhausted: true,
				// The scan stopped mid-range, so the position it reached is what the
				// caller persists for the next visit.
				scanCursor: { createdAt: daysAgo(200), seq: 750 },
			});
			expect(batched.transactions()).toBe(3);
			// A truncated pass is a partial success: the batches that committed stay
			// committed, and the remainder is what `pendingMore` is for.
			expect(liveSeqs(storage)).toHaveLength(50);
		});

		it('drains a backlog that fits inside both bounds and reports nothing pending', async () => {
			insertExpiredMessages(storage, 300, daysAgo(200));

			const result = await store.pruneExpiredLoopMessagesWithinBudget({
				now,
				rowAllowance: 10_000,
				timeBudgetMs: 8_000,
				nowMs: () => 0,
			});

			expect(result).toEqual({
				loopMessages: { deletedMessages: 300, deletedLogs: 0, stampedSummaries: 0, pendingMore: false },
				timeBudgetExhausted: false,
				scanCursor: null,
			});
			expect(liveSeqs(storage)).toEqual([]);
		});

		it('steps past a head batch that can only withhold summaries and deletes what is behind it', async () => {
			// The oldest 260 candidates are summaries their live children hold in
			// place, so the head batch deletes nothing. Selection is deterministic, so
			// re-selecting would jam this visit and every visit after it — the
			// continuation is what reaches the deletable rows behind them.
			for (const seq of range(1, 260)) {
				insertMessage(storage, seq, seq, { createdAt: daysAgo(200), compactedBy: 9_000, origin: 'compaction' });
				insertMessage(storage, 1_000 + seq, 1_000 + seq, { createdAt: daysAgo(1), compactedBy: seq });
			}
			for (const seq of range(2_001, 2_100)) {
				insertMessage(storage, seq, seq, { createdAt: daysAgo(150), deletedAt: daysAgo(150) });
			}
			const batched = countingStore(storage);

			const result = await batched.store.pruneExpiredLoopMessagesWithinBudget({
				now,
				rowAllowance: 10_000,
				timeBudgetMs: 8_000,
				nowMs: () => 0,
			});

			// The withheld summaries are expired rows this object still holds, so they
			// keep `pendingMore` true even though the cursor has moved past them.
			expect(result).toEqual({
				loopMessages: { deletedMessages: 100, deletedLogs: 0, stampedSummaries: 0, pendingMore: true },
				timeBudgetExhausted: false,
				// The scan itself ran out of candidates inside this pass, so the withheld
				// prefix is re-examined from the bottom next time — by then some of those
				// children may have aged out.
				scanCursor: null,
			});
			expect(liveSeqs(storage)).toHaveLength(520);
			expect(liveSeqs(storage).filter((seq) => seq >= 2_001)).toEqual([]);
		});

		it('ends the pass when the caller says its storage stopped being writable mid-visit', async () => {
			insertExpiredMessages(storage, 800, daysAgo(200));
			const batched = countingStore(storage);

			// A full clear landing between batches is the case this stands in for: the
			// pass keeps what it committed and stops rather than writing to an object
			// that is on its way to being erased. The budget runs out on the very same
			// yield, which is what makes the order of the two checks visible: a clear
			// and a truncation are not the same answer, and the clear is the true one.
			const result = await batched.store.pruneExpiredLoopMessagesWithinBudget({
				now,
				rowAllowance: 10_000,
				timeBudgetMs: 8_000,
				nowMs: () => batched.transactions() * 4_000,
				shouldContinue: () => batched.transactions() < 2,
			});

			expect(result.loopMessages).toMatchObject({ deletedMessages: 500, pendingMore: true });
			expect(result.timeBudgetExhausted).toBe(false);
			expect(batched.transactions()).toBe(2);
			// The position is still reported: it is the caller — which knows whether its
			// storage survived — that decides whether keeping it means anything.
			expect(result.scanCursor).toEqual({ createdAt: daysAgo(200), seq: 500 });
		});
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

	it('physically caps diagnostic rows and safely removes their dependent logs and chunks', () => {
		let resetCount = 0;
		const retentionStore = new RuntimeMessageStore(storage, () => {}, () => {
			resetCount += 1;
		});
		const normal = retentionStore.appendLoopMessage(
			'run-normal',
			{ role: 'assistant', content: 'Provider-visible history remains intact.' },
			'provider_response',
		);
		const invalidMessage = (index: number): BotInferenceSubmissionMessage => ({
			role: 'assistant',
			content: null,
			tool_calls: [{
				id: 'call-invalid-retention',
				type: 'function',
				function: {
					name: 'read_thread',
					arguments: `{"threadRef":"${'x'.repeat(500)}-${index}`,
				},
			}],
		});
		const appendInvalidAttempt = (index: number): BotLoopMessage => {
			const message = invalidMessage(index);
			const inserted = retentionStore.appendLoopMessageGroup([{
				runId: 'run-invalid',
				message,
				origin: 'dropped_provider_response',
				status: 'invalid',
				extraLogs: [
					{ kind: 'provider_request', text: `${'R'.repeat(500)} request ${index}` },
					{ kind: 'provider_response', text: `${'S'.repeat(500)} response ${index}` },
				],
			}])[0];
			if (!inserted) {
				throw new Error('Expected the diagnostic write sequence to insert one row.');
			}
			return inserted;
		};
		const retained: BotLoopMessage[] = [];
		for (let index = 1; index <= runtimeDiagnosticLoopMessageRetentionCount; index += 1) {
			retained.push(appendInvalidAttempt(index));
		}
		const oldest = retained[0]!;
		const nextOldest = retained[1]!;
		const oldestLogs = storage.database
			.prepare(`SELECT id, kind FROM loop_message_logs WHERE message_seq = ? ORDER BY id ASC`)
			.all(oldest.seq) as Array<{ id: number; kind: string }>;
		const nextOldestLogsBeforePrune = storage.database
			.prepare(`SELECT id, kind, encoding, base_log_id FROM loop_message_logs WHERE message_seq = ? ORDER BY id ASC`)
			.all(nextOldest.seq) as Array<{ id: number; kind: string; encoding: string; base_log_id: number | null }>;
		expect(oldestLogs.map((log) => log.kind)).toEqual(['message', 'provider_request', 'provider_response']);
		expect(nextOldestLogsBeforePrune).toEqual(oldestLogs.map((base) => expect.objectContaining({
			kind: base.kind,
			encoding: 'replace_tail',
			base_log_id: base.id,
		})));
		for (const log of oldestLogs) {
			expect(storage.database.prepare(`SELECT COUNT(*) AS count FROM loop_message_log_chunks WHERE log_id = ?`).get(log.id)?.count).toBe(1);
		}

		const newest = appendInvalidAttempt(runtimeDiagnosticLoopMessageRetentionCount + 1);

		expect(storage.database.prepare(`SELECT COUNT(*) AS count FROM loop_messages WHERE origin = 'dropped_provider_response'`).get()?.count)
			.toBe(runtimeDiagnosticLoopMessageRetentionCount);
		expect(storage.database.prepare(`SELECT seq FROM loop_messages WHERE origin = 'dropped_provider_response' ORDER BY position ASC`).all()
			.map((row) => row.seq)).toEqual([...retained.slice(1).map((message) => message.seq), newest.seq]);
		expect(storage.database.prepare(`SELECT COUNT(*) AS count FROM loop_messages WHERE seq = ?`).get(oldest.seq)?.count).toBe(0);
		expect(storage.database.prepare(`SELECT COUNT(*) AS count FROM loop_message_logs WHERE message_seq = ?`).get(oldest.seq)?.count).toBe(0);
		for (const log of oldestLogs) {
			expect(storage.database.prepare(`SELECT COUNT(*) AS count FROM loop_message_log_chunks WHERE log_id = ?`).get(log.id)?.count).toBe(0);
		}
		const nextOldestLogsAfterPrune = storage.database
			.prepare(`SELECT id, kind, encoding, base_log_id FROM loop_message_logs WHERE message_seq = ? ORDER BY id ASC`)
			.all(nextOldest.seq);
		expect(nextOldestLogsAfterPrune).toEqual(nextOldestLogsBeforePrune.map((log) => ({
			id: log.id,
			kind: log.kind,
			encoding: 'full',
			base_log_id: null,
		})));
		const nextOldestMessageLog = nextOldestLogsBeforePrune.find((log) => log.kind === 'message');
		expect(nextOldestMessageLog).toBeDefined();
		expect(retentionStore.reconstructLoopMessageLogText(nextOldestMessageLog!.id)).toBe(JSON.stringify(invalidMessage(2)));
		expect(retentionStore.loopMessageRow(normal.seq)).toBeDefined();
		expect(resetCount).toBe(1);

		for (let index = 1; index <= runtimeDiagnosticLoopMessageRetentionCount + 1; index += 1) {
			retentionStore.appendLoopMessage(
				'run-error',
				{ role: 'user', content: `Bickr Terminal reported runtime failure ${index}.` },
				'runtime_error',
			);
		}
		expect(storage.database.prepare(`SELECT COUNT(*) AS count FROM loop_messages WHERE origin = 'runtime_error'`).get()?.count)
			.toBe(runtimeDiagnosticLoopMessageRetentionCount);
		expect(storage.database.prepare(`SELECT COUNT(*) AS count FROM loop_messages WHERE origin IN ('dropped_provider_response', 'runtime_error')`).get()?.count)
			.toBe(runtimeDiagnosticLoopMessageRetentionCount * 2);
		expect(resetCount).toBe(2);
	});

	it('returns retained dropped provider responses through the real page store path', () => {
		let expiredSeq = 0;
		for (let index = 0; index < runtimeDiagnosticLoopMessageRetentionCount; index += 1) {
			const inserted = store.appendLoopMessage(
				'run-invalid-page-seed',
				{
					role: 'assistant',
					content: null,
					tool_calls: [{
						id: `call-invalid-page-seed-${index}`,
						type: 'function',
						function: { name: 'read_thread', arguments: '{"threadRef":' },
					}],
				},
				'dropped_provider_response',
				'invalid',
			);
			expiredSeq ||= inserted.seq;
		}
		const rawArguments = '{"commentRef":"c/parent","body":"unterminated';
		const retained = store.appendLoopMessage(
			'run-invalid-page',
			{
				role: 'assistant',
				content: null,
				tool_calls: [{
					id: 'call-invalid-page',
					type: 'function',
					function: { name: 'reply_to_comment', arguments: rawArguments },
				}],
			},
			'dropped_provider_response',
			'invalid',
		);

		const rows = store.loopMessageRowsForPage(null, 0);
		const page = store.loopMessagesPage({ page: 1 });

		expect(rows.map((row) => row.seq)).not.toContain(expiredSeq);
		expect(rows.map((row) => row.seq)).toContain(retained.seq);
		expect(page.messages).toHaveLength(runtimeDiagnosticLoopMessageRetentionCount);
		expect(page.messages).toContainEqual(expect.objectContaining({
			seq: retained.seq,
			origin: 'dropped_provider_response',
			status: 'invalid',
			message: expect.objectContaining({
				tool_calls: [expect.objectContaining({
					id: 'call-invalid-page',
					function: expect.objectContaining({ name: 'reply_to_comment', arguments: rawArguments }),
				})],
			}),
		}));
	});

	it.each([
		{
			label: 'missing call ID',
			toolCall: { id: '', name: 'read_thread', arguments: '{"threadRef":"t/abc"}' },
			reason: 'missing_tool_call_id',
		},
		{
			label: 'missing function name',
			toolCall: { id: 'call-missing-name', name: '', arguments: '{}' },
			reason: 'missing_function_name',
		},
	] as const)('bounds the real no-correction write sequence for a $label without adding it to retry history', ({
		reason,
		toolCall,
	}) => {
		const retentionStore = new RuntimeMessageStore(storage);
		const seededDropped: BotLoopMessage[] = [];
		const seededRuntimeErrors: BotLoopMessage[] = [];
		for (let index = 0; index < runtimeDiagnosticLoopMessageRetentionCount; index += 1) {
			seededDropped.push(retentionStore.appendLoopMessage(
				'run-seed-dropped',
				{
					role: 'assistant',
					content: null,
					tool_calls: [{
						id: `call-seed-${index}`,
						type: 'function',
						function: { name: 'read_thread', arguments: '{"threadRef":' },
					}],
				},
				'dropped_provider_response',
				'invalid',
			));
			seededRuntimeErrors.push(retentionStore.appendLoopMessage(
				'run-seed-error',
				{ role: 'user', content: `Bickr Terminal reported seeded failure ${index}.` },
				'runtime_error',
			));
		}
		const invalidMessage: BotInferenceSubmissionMessage = {
			role: 'assistant',
			content: null,
			tool_calls: [{
				id: toolCall.id,
				type: 'function',
				function: { name: toolCall.name, arguments: toolCall.arguments },
			}],
		};
		const appendDroppedAttempt = (
			message: BotInferenceSubmissionMessage,
			droppedReason: ProviderToolCallDropReason,
		): void => {
			retentionStore.appendLoopMessageGroup([{
				runId: 'run-no-correction',
				message,
				origin: 'dropped_provider_response',
				status: 'invalid',
				extraLogs: [{
					kind: 'provider_response',
					text: JSON.stringify({ status: 'invalid', droppedToolCalls: [{ reason: droppedReason }], message }),
				}],
			}]);
		};
		appendDroppedAttempt(invalidMessage, reason);
		appendDroppedAttempt({
			role: 'assistant',
			content: null,
			tool_calls: [{
				id: 'call-second-invalid',
				type: 'function',
				function: { name: 'read_thread', arguments: '[]' },
			}],
		}, 'arguments_not_json_object');
		retentionStore.appendLoopMessage(
			'run-no-correction',
			{ role: 'user', content: 'Bickr Terminal reported the failed retry.' },
			'runtime_error',
		);

		const retrySubmission = [
			{ role: 'assistant' as const, content: 'I am ready.' },
			...retentionStore.activeLoopMessageRows()
				.map(loopMessageFromRow)
				.filter(({ message, origin }) => loopMessageContributesToProviderHistory(origin, message))
				.map(({ message }) => message),
		];

		expect(retrySubmission).toEqual([{ role: 'assistant', content: 'I am ready.' }]);
		expect(retentionStore.activeLoopMessageRows().filter((row) => row.origin === 'self_correction')).toEqual([]);
		expect(retentionStore.loopMessageRow(seededDropped[0]!.seq)).toBeUndefined();
		expect(retentionStore.loopMessageRow(seededRuntimeErrors[0]!.seq)).toBeUndefined();
		expect(storage.database.prepare(`SELECT COUNT(*) AS count FROM loop_messages WHERE origin = 'dropped_provider_response'`).get()?.count)
			.toBe(runtimeDiagnosticLoopMessageRetentionCount);
		expect(storage.database.prepare(`SELECT COUNT(*) AS count FROM loop_messages WHERE origin = 'runtime_error'`).get()?.count)
			.toBe(runtimeDiagnosticLoopMessageRetentionCount);
	});
});

function insertMessage(
	storage: RuntimeTestStorage,
	seq: number,
	position: number,
	options: {
		compactedBy?: number;
		deletedAt?: string;
		origin?: BotLoopMessage['origin'];
		createdAt?: string;
		ledgerPrunedAt?: string;
	} = {},
): void {
	storage.database.prepare(
		`INSERT INTO loop_messages (
			seq, position, run_id, role, message_json, origin, status, token_estimate,
			stream_seq, display_event_seq, compacted_by, deleted_at, ledger_pruned_at, created_at
		) VALUES (?, ?, 'run-test', 'user', ?, ?, 'complete', 1, NULL, NULL, ?, ?, ?, ?)`,
	).run(
		seq,
		position,
		JSON.stringify({ role: 'user', content: `message ${seq}` }),
		options.origin ?? 'input',
		options.compactedBy ?? null,
		options.deletedAt ?? null,
		options.ledgerPrunedAt ?? null,
		options.createdAt ?? '2026-07-10T00:00:00.000Z',
	);
}

/** A sweep-sized backlog of owner-deleted rows, all expired by the same cutoff. */
function insertExpiredMessages(storage: RuntimeTestStorage, count: number, createdAt: string): void {
	for (const seq of range(1, count)) {
		insertMessage(storage, seq, seq, { createdAt, deletedAt: createdAt });
	}
}

/** A store whose transactions are counted, so a batching claim can be checked. */
function countingStore(storage: RuntimeTestStorage): { store: RuntimeMessageStore; transactions: () => number } {
	let transactions = 0;
	return {
		store: new RuntimeMessageStore({
			sql: storage.sql,
			transactionSync<T>(closure: () => T): T {
				transactions += 1;
				return storage.transactionSync(closure);
			},
		}),
		transactions: () => transactions,
	};
}

function liveSeqs(storage: RuntimeTestStorage): number[] {
	return storage.database.prepare(`SELECT seq FROM loop_messages ORDER BY seq ASC`).all().map((row) => row.seq as number);
}

function ledgerPrunedAt(storage: RuntimeTestStorage, seq: number): string | null {
	return storage.database.prepare(`SELECT ledger_pruned_at FROM loop_messages WHERE seq = ?`)
		.get(seq)?.ledger_pruned_at as string | null;
}

function logRows(storage: RuntimeTestStorage, messageSeq: number): Array<{ id: number; encoding: string; base_log_id: number | null }> {
	return storage.database
		.prepare(`SELECT id, encoding, base_log_id FROM loop_message_logs WHERE message_seq = ? ORDER BY id ASC`)
		.all(messageSeq) as Array<{ id: number; encoding: string; base_log_id: number | null }>;
}

function messagePosition(storage: RuntimeTestStorage, seq: number): number {
	return storage.database.prepare(`SELECT position FROM loop_messages WHERE seq = ?`).get(seq)?.position as number;
}

function messageCompactedBy(storage: RuntimeTestStorage, seq: number): number | null {
	return storage.database.prepare(`SELECT compacted_by FROM loop_messages WHERE seq = ?`).get(seq)?.compacted_by as number | null;
}

function range(start: number, end: number): number[] {
	return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}
