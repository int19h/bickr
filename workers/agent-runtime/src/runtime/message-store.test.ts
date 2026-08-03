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
	options: { compactedBy?: number; deletedAt?: string; origin?: BotLoopMessage['origin'] } = {},
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

function messageCompactedBy(storage: RuntimeTestStorage, seq: number): number | null {
	return storage.database.prepare(`SELECT compacted_by FROM loop_messages WHERE seq = ?`).get(seq)?.compacted_by as number | null;
}

function range(start: number, end: number): number[] {
	return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}
