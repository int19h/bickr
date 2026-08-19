import type {
	BotInferenceSubmissionMessage,
	BotLoopMessage,
	BotLoopMessageDisplay,
	BotLoopMessageLog,
	BotLoopMessageLogEncoding,
	BotLoopMessageLogKind,
	BotLoopMessageLogsResponse,
	BotLoopMessagePageSummary,
	BotLoopMessagesResponse,
	BotLoopMessageStatus,
	BotRuntimeEventType,
} from '@bickr/shared/model';
import { RepositoryError } from '@bickr/shared/repository';
import { chunks as chunked } from '@bickr/shared/storage';
import {
	compactedLoopMessageRetentionDays,
	compactionSummaryLoopMessageRetentionDays,
	dayMs,
	deletedLoopMessageRetentionDays,
	loopMessageLogChunkLength,
	loopMessageLogRetentionCount,
	loopMessagePageIndexLimit,
	loopMessageRetentionBatchSize,
	runtimeDiagnosticLoopMessageOrigins,
	runtimeDiagnosticLoopMessageRetentionCount,
	type RuntimeDiagnosticLoopMessageOrigin,
} from '../constants';
import type {
	ChatMessage,
	LoopMessageGroupEntry,
	LoopMessageLogChunkRow,
	LoopMessageLogRow,
	LoopMessagePageDescriptor,
	LoopMessagePageIndex,
	LoopMessageRetentionResult,
	LoopMessageRow,
	SweepLoopMessageRetentionResult,
} from '../types';

/**
 * Deletes are chunked into statements of this many bound sequence numbers. The
 * batch allowance is a retention decision; this is only a SQL statement width.
 */
const loopMessageDeleteStatementWidth = 100;

type ExpiredLoopMessageRow = {
	seq: number;
	compactedBy: number | null;
	origin: LoopMessageRow['origin'];
};

/** A retention candidate, carrying the scan order's key so a batch can resume after it. */
type ExpiredLoopMessageScanRow = ExpiredLoopMessageRow & { createdAt: string };

/**
 * Keyset position in the retention scan's `(created_at, seq)` order.
 *
 * The scan is deterministic, so a batch that could delete none of what it
 * selected would otherwise be re-selected forever. Resuming strictly after the
 * last row it looked at is what lets a multi-batch pass step past candidates it
 * had to withhold and reach the deletable rows behind them.
 */
type LoopMessageRetentionCursor = { createdAt: string; seq: number };

type LoopMessageRetentionBatch = LoopMessageRetentionResult & {
	/** Rows the batch selected, whether it went on to delete them or withheld them. */
	selected: number;
	/** Where the next batch resumes, or null when this one selected nothing. */
	after: LoopMessageRetentionCursor | null;
};

export type RuntimeStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

export class RuntimeMessageStore {
	private readonly storage: RuntimeStorage;
	private readonly broadcastLoopMessage: (message: BotLoopMessage) => void;
	private readonly broadcastLoopMessagesReset: () => void;

	constructor(
		storage: RuntimeStorage,
		broadcastLoopMessage: (message: BotLoopMessage) => void = () => {},
		broadcastLoopMessagesReset: () => void = () => {},
	) {
		this.storage = storage;
		this.broadcastLoopMessage = broadcastLoopMessage;
		this.broadcastLoopMessagesReset = broadcastLoopMessagesReset;
	}

	appendLoopMessage(
		runId: string,
		message: ChatMessage,
		origin: LoopMessageGroupEntry['origin'],
		status: BotLoopMessageStatus = 'complete',
		options: { streamSeq?: number; displayEventSeq?: number } = {},
	): BotLoopMessage {
		const inserted = this.appendLoopMessageGroup([{
			runId,
			message,
			origin,
			status,
			options,
		}])[0];
		if (!inserted) {
			throw new Error('Loop message append did not insert its required row.');
		}
		return inserted;
	}

	appendLoopMessageGroup(entries: LoopMessageGroupEntry[]): BotLoopMessage[] {
		const inserted: BotLoopMessage[] = [];
		let prunedDiagnosticCount = 0;
		const appendEntries = (): void => {
			for (const entry of entries) {
				const loopMessage = this.insertLoopMessage({
					runId: entry.runId,
					message: entry.message,
					origin: entry.origin,
					status: entry.status,
					streamSeq: entry.options?.streamSeq,
					displayEventSeq: entry.options?.displayEventSeq,
					broadcast: false,
				});
				this.recordLoopMessageLog(loopMessage.seq, 'message', JSON.stringify(entry.message));
				for (const log of entry.extraLogs ?? []) {
					this.recordLoopMessageLog(loopMessage.seq, log.kind, log.text);
				}
				inserted.push(loopMessage);
			}
			if (entries.some((entry) => isRuntimeDiagnosticLoopMessageOrigin(entry.origin))) {
				prunedDiagnosticCount = this.pruneRuntimeDiagnosticLoopMessages();
			}
		};
		if (typeof this.storage.transactionSync === 'function') {
			this.storage.transactionSync(appendEntries);
		} else {
			// Constructor-free unit harnesses can provide only the SQL surface;
			// production Durable Object storage always takes the transaction path.
			appendEntries();
		}
		for (const loopMessage of inserted) {
			this.broadcastLoopMessage(loopMessage);
		}
		if (prunedDiagnosticCount > 0) {
			this.broadcastLoopMessagesReset();
		}
		return inserted;
	}

	insertLoopMessage(input: {
		runId: string;
		message: ChatMessage;
		origin: LoopMessageGroupEntry['origin'];
		status?: BotLoopMessageStatus;
		streamSeq?: number;
		displayEventSeq?: number;
		position?: number;
		createdAt?: string;
		broadcast: boolean;
	}): BotLoopMessage {
		const now = input.createdAt ?? new Date().toISOString();
		const messageJson = JSON.stringify(input.message);
		const tokenEstimate = estimateTextTokens(messageJson);
		const position = input.position ?? this.nextLoopMessagePosition();
		const displayEvent = this.loopMessageDisplayEventRow(input.displayEventSeq);
		this.storage.sql.exec(
			`INSERT INTO loop_messages (position, run_id, role, message_json, origin, status, token_estimate, stream_seq, display_event_seq, compacted_by, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			position,
			input.runId,
			input.message.role,
			messageJson,
			input.origin,
			input.status ?? null,
			tokenEstimate,
			input.streamSeq ?? null,
			displayEvent.display_event_seq,
			now,
		);
		const seq = this.storage.sql.exec<{ seq: number }>(`SELECT last_insert_rowid() AS seq`).one().seq;
		const message = loopMessageFromRow({
			seq,
			position,
			run_id: input.runId,
			role: input.message.role,
			message_json: messageJson,
			origin: input.origin,
			status: input.status ?? null,
			token_estimate: tokenEstimate,
			stream_seq: input.streamSeq ?? null,
			display_event_seq: displayEvent.display_event_seq,
			display_event_type: displayEvent.display_event_type,
			display_event_payload_json: displayEvent.display_event_payload_json,
			compacted_by: null,
			deleted_at: null,
			created_at: now,
			has_logs: 0,
		});
		if (input.broadcast) {
			this.broadcastLoopMessage(message);
		}
		return message;
	}

	activeLoopMessageRows(): LoopMessageRow[] {
		return this.storage.sql
			.exec<LoopMessageRow>(
				`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
				        m.token_estimate, m.stream_seq, m.compacted_by, m.deleted_at, m.created_at,
				        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
				 FROM loop_messages m
				 WHERE m.compacted_by IS NULL
				   AND m.deleted_at IS NULL
				 ORDER BY m.position ASC, m.seq ASC`,
			)
			.toArray();
	}

	softDeleteLoopMessage(seq: number, deletedAt = new Date().toISOString()): { row: LoopMessageRow; deletedAt: string } | null {
		let result: { row: LoopMessageRow; deletedAt: string } | null = null;
		const deleteMessage = (): void => {
			const row = this.loopMessageRow(seq);
			if (!row) {
				return;
			}
			const effectiveDeletedAt = row.deleted_at ?? deletedAt;
			if (!row.deleted_at) {
				if (row.origin === 'compaction' && row.ledger_pruned_at) {
					// Deleting a summary restores its absorbed children so the history
					// stays reachable. Retention has physically deleted some of this
					// summary's children, so there is nothing left to restore: the
					// summary's own text is now the only record of that stretch of
					// history, and removing it would drop the history instead of
					// un-compacting it. Reactivating a stamped summary stays allowed —
					// its text legitimately stands in for the rows that are gone.
					throw new RepositoryError(
						'conflict',
						'Retention has already deleted the messages this summary absorbed, so the summary cannot be deleted without losing that history. Erase the chat history instead.',
						409,
					);
				}
				if (row.origin === 'compaction') {
					// Compaction summaries are page-index anchors. Restore their children
					// so deleting an anchor cannot make otherwise-live history unreachable.
					this.storage.sql.exec(`UPDATE loop_messages SET compacted_by = NULL WHERE compacted_by = ?`, seq);
				}
				this.storage.sql.exec(
					`UPDATE loop_messages
					 SET deleted_at = ?
					 WHERE seq = ?
					   AND deleted_at IS NULL`,
					effectiveDeletedAt,
					seq,
				);
			}
			result = { row, deletedAt: effectiveDeletedAt };
		};
		if (typeof this.storage.transactionSync === 'function') {
			this.storage.transactionSync(deleteMessage);
		} else {
			deleteMessage();
		}
		return result;
	}

	updateActiveLoopMessagePositions(seqOrder: readonly number[]): void {
		if (seqOrder.length === 0) {
			return;
		}
		const minPosition = this.storage.sql
			.exec<{ position: number }>(
				`SELECT COALESCE(MIN(position), 1) AS position
				 FROM loop_messages
				 WHERE compacted_by IS NULL
				   AND deleted_at IS NULL`,
			)
			.one().position;
		for (let index = 0; index < seqOrder.length; index += 1) {
			this.storage.sql.exec(
				`UPDATE loop_messages
				 SET position = ?
				 WHERE seq = ?
				   AND compacted_by IS NULL
				   AND deleted_at IS NULL`,
				minPosition + index,
				seqOrder[index],
			);
		}
	}

	loopMessagesAfter(afterSeq: number, initialLimit?: number): BotLoopMessage[] {
		return this.loopMessageRowsForPage(null, Math.max(0, Math.floor(afterSeq)), initialLimit).map(loopMessageFromRow);
	}

	loopMessagesPage(input: { page: number; after?: number }): BotLoopMessagesResponse {
		const pageIndex = this.loopMessagePageIndex();
		const requestedPage = Math.max(1, Math.floor(input.page));
		const currentDescriptor = pageIndex.descriptors.find((descriptor) => descriptor.page === requestedPage) ??
			pageIndex.descriptors[pageIndex.descriptors.length - 1] ?? { page: 1, sourceCompactionSeq: null };
		const after = currentDescriptor.page === 1 ? Math.max(0, Math.floor(input.after ?? 0)) : 0;
		const rows = this.loopMessageRowsForPage(currentDescriptor.sourceCompactionSeq, after);
		const summaries = this.loopMessagePageSummaries(pageIndex);
		const currentSummary = summaries.find((summary) => summary.page === currentDescriptor.page);
		return {
			messages: rows.map(loopMessageFromRow),
			page: {
				currentPage: currentDescriptor.page,
				pageCount: pageIndex.descriptors.length,
				pages: summaries,
				compactionPageBySeq: Object.fromEntries([...pageIndex.compactionPageBySeq.entries()].map(([seq, page]) => [String(seq), page])),
				...(currentDescriptor.newerPage ? { newerPage: currentDescriptor.newerPage } : {}),
				...(currentSummary?.olderPage ? { olderPage: currentSummary.olderPage } : {}),
			},
		};
	}

	loopMessagePageIndex(): LoopMessagePageIndex {
		const descriptors: LoopMessagePageDescriptor[] = [];
		const compactionPageBySeq = new Map<number, number>();
		const visitedSources = new Set<string>();
		const appendPage = (sourceCompactionSeq: number | null, newerPage?: number): void => {
			if (descriptors.length >= loopMessagePageIndexLimit) {
				return;
			}
			const sourceKey = sourceCompactionSeq === null ? 'active' : String(sourceCompactionSeq);
			if (visitedSources.has(sourceKey)) {
				return;
			}
			visitedSources.add(sourceKey);
			const descriptor: LoopMessagePageDescriptor = {
				page: descriptors.length + 1,
				sourceCompactionSeq,
				...(newerPage ? { newerPage } : {}),
			};
			descriptors.push(descriptor);
			for (const seq of this.loopMessageCompactionSeqsWithChildren(sourceCompactionSeq)) {
				if (descriptors.length >= loopMessagePageIndexLimit) {
					break;
				}
				if (compactionPageBySeq.has(seq)) {
					continue;
				}
				compactionPageBySeq.set(seq, descriptors.length + 1);
				appendPage(seq, descriptor.page);
			}
		};
		appendPage(null);
		return { descriptors, compactionPageBySeq };
	}

	loopMessageRowsForPage(sourceCompactionSeq: number | null, afterSeq: number, initialLimit?: number): LoopMessageRow[] {
		if (sourceCompactionSeq === null) {
			const filters = ['m.compacted_by IS NULL', 'm.deleted_at IS NULL', ...(afterSeq > 0 ? ['m.seq > ?'] : [])];
			const params = [...(afterSeq > 0 ? [afterSeq] : [])];
			const limit = afterSeq > 0 ? undefined : positiveInteger(initialLimit);
			if (limit !== undefined) {
				return this.storage.sql
					.exec<LoopMessageRow>(
						`SELECT *
						 FROM (
							SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
							       m.token_estimate, m.stream_seq, m.display_event_seq, display.type AS display_event_type,
							       display.payload_json AS display_event_payload_json, m.compacted_by, m.deleted_at, m.created_at,
							       CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
							FROM loop_messages m
							LEFT JOIN events display ON display.seq = m.display_event_seq
							WHERE ${filters.join('\n\t\t\t\t\t\t\t   AND ')}
							ORDER BY m.position DESC, m.seq DESC
							LIMIT ?
						 )
						 ORDER BY position ASC, seq ASC`,
						...params,
						limit,
					)
					.toArray();
			}
			return this.storage.sql
				.exec<LoopMessageRow>(
					`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
					        m.token_estimate, m.stream_seq, m.display_event_seq, display.type AS display_event_type,
					        display.payload_json AS display_event_payload_json, m.compacted_by, m.deleted_at, m.created_at,
					        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
					 FROM loop_messages m
					 LEFT JOIN events display ON display.seq = m.display_event_seq
					 WHERE ${filters.join('\n\t\t\t\t\t   AND ')}
					 ORDER BY m.position ASC, m.seq ASC
					 ${afterSeq > 0 ? 'LIMIT 2000' : ''}`,
					...params,
				)
				.toArray();
		}
		return this.storage.sql
			.exec<LoopMessageRow>(
				`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
				        m.token_estimate, m.stream_seq, m.display_event_seq, display.type AS display_event_type,
				        display.payload_json AS display_event_payload_json, m.compacted_by, m.deleted_at, m.created_at,
				        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
				 FROM loop_messages m
				 LEFT JOIN events display ON display.seq = m.display_event_seq
				 WHERE m.compacted_by = ?
				   AND m.deleted_at IS NULL
				 ORDER BY m.position ASC, m.seq ASC`,
				sourceCompactionSeq,
			)
			.toArray();
	}

	latestActiveLoopCompactionBoundary(): { messageSeq: number; requestSeq: number; created_at: string } | null {
		const row = this.storage.sql
			.exec<{ message_seq: number; request_seq: number | null; created_at: string }>(
				`SELECT m.seq AS message_seq, m.stream_seq AS request_seq, m.created_at
				 FROM loop_messages m
				 WHERE m.compacted_by IS NULL
				   AND m.deleted_at IS NULL
				   AND m.origin = 'compaction'
				   AND EXISTS (
					SELECT 1
					FROM loop_messages child
					WHERE child.compacted_by = m.seq
					  AND child.deleted_at IS NULL
				   )
				 ORDER BY m.seq DESC
				 LIMIT 1`,
			)
			.toArray()[0];
		if (!row || typeof row.message_seq !== 'number' || typeof row.created_at !== 'string') {
			return null;
		}
		const requestSeq = typeof row.request_seq === 'number' ? row.request_seq : row.message_seq;
		return { messageSeq: row.message_seq, requestSeq, created_at: row.created_at };
	}

	loopMessageLogsForSeq(seq: number): BotLoopMessageLogsResponse {
		if (!Number.isInteger(seq) || seq <= 0) {
			throw new RepositoryError('bad_request', 'Loop message sequence is invalid.', 400);
		}
		const row = this.loopMessageRow(seq);
		if (!row) {
			throw new RepositoryError('not_found', 'Loop message was not found.', 404);
		}
		const logs = this.storage.sql
			.exec<LoopMessageLogRow>(
				`SELECT id, message_seq, kind, encoding, base_log_id, prefix_length, text_length, chunk_count, created_at
				 FROM loop_message_logs
				 WHERE message_seq = ?
				 ORDER BY id ASC`,
				seq,
			)
			.toArray()
			.map((log) => loopMessageLogFromRow(log, this.reconstructLoopMessageLogText(log.id)));
		return { message: loopMessageFromRow(row), logs };
	}

	loopMessageRow(seq: number): LoopMessageRow | undefined {
		return this.storage.sql
			.exec<LoopMessageRow>(
				`SELECT m.seq, m.position, m.run_id, m.role, m.message_json, m.origin, m.status,
				        m.token_estimate, m.stream_seq, m.display_event_seq, display.type AS display_event_type,
				        display.payload_json AS display_event_payload_json, m.compacted_by, m.deleted_at,
				        m.ledger_pruned_at, m.created_at,
				        CASE WHEN EXISTS (SELECT 1 FROM loop_message_logs l WHERE l.message_seq = m.seq) THEN 1 ELSE 0 END AS has_logs
				 FROM loop_messages m
				 LEFT JOIN events display ON display.seq = m.display_event_seq
				 WHERE m.seq = ?
				 LIMIT 1`,
				seq,
			)
			.toArray()[0];
	}

	recordLoopMessageLog(messageSeq: number, kind: BotLoopMessageLogKind, text: string): void {
		const base = this.latestLoopMessageLogBase(kind);
		const encoded = base ? encodeLoopMessageLog(text, base.text, base.id) : { encoding: 'full' as const, text };
		const now = new Date().toISOString();
		const chunks = chunkText(encoded.text, loopMessageLogChunkLength);
		this.storage.sql.exec(
			`INSERT INTO loop_message_logs (message_seq, kind, encoding, base_log_id, prefix_length, text_length, chunk_count, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			messageSeq,
			kind,
			encoded.encoding,
			encoded.baseLogId ?? null,
			encoded.prefixLength ?? null,
			text.length,
			chunks.length,
			now,
		);
		const logId = this.storage.sql.exec<{ id: number }>(`SELECT last_insert_rowid() AS id`).one().id;
		for (let index = 0; index < chunks.length; index += 1) {
			this.storage.sql.exec(
				`INSERT INTO loop_message_log_chunks (log_id, chunk_index, text) VALUES (?, ?, ?)`,
				logId,
				index,
				chunks[index] ?? '',
			);
		}
		this.pruneLoopMessageLogs();
	}

	reconstructLoopMessageLogText(logId: number, seen = new Set<number>()): string {
		if (seen.has(logId)) {
			throw new RepositoryError('server_error', 'Loop message log chain is cyclic.', 500);
		}
		seen.add(logId);
		const row = this.storage.sql
			.exec<LoopMessageLogRow>(
				`SELECT id, message_seq, kind, encoding, base_log_id, prefix_length, text_length, chunk_count, created_at
				 FROM loop_message_logs
				 WHERE id = ?
				 LIMIT 1`,
				logId,
			)
			.toArray()[0];
		if (!row) {
			throw new RepositoryError('not_found', 'Loop message log was not found.', 404);
		}
		const encoded = this.storage.sql
			.exec<LoopMessageLogChunkRow>(
				`SELECT log_id, chunk_index, text
				 FROM loop_message_log_chunks
				 WHERE log_id = ?
				 ORDER BY chunk_index ASC`,
				logId,
			)
			.toArray()
			.map((chunk) => chunk.text)
			.join('');
		if (row.encoding === 'full') {
			return encoded;
		}
		if (!row.base_log_id) {
			throw new RepositoryError('server_error', 'Delta log is missing its base.', 500);
		}
		const base = this.reconstructLoopMessageLogText(row.base_log_id, seen);
		if (row.encoding === 'append') {
			return `${base}${encoded}`;
		}
		return `${base.slice(0, row.prefix_length ?? 0)}${encoded}`;
	}

	private loopMessageDisplayEventRow(
		displayEventSeq: number | undefined,
	): Pick<LoopMessageRow, 'display_event_seq' | 'display_event_type' | 'display_event_payload_json'> {
		if (typeof displayEventSeq !== 'number' || !Number.isInteger(displayEventSeq) || displayEventSeq <= 0) {
			return { display_event_seq: null, display_event_type: null, display_event_payload_json: null };
		}
		const row = this.storage.sql
			.exec<{ seq: number; type: BotRuntimeEventType; payload_json: string }>(
				`SELECT seq, type, payload_json FROM events WHERE seq = ? LIMIT 1`,
				displayEventSeq,
			)
			.toArray()[0];
		if (!row || row.type !== 'tool_result') {
			return { display_event_seq: null, display_event_type: null, display_event_payload_json: null };
		}
		return {
			display_event_seq: row.seq,
			display_event_type: row.type,
			display_event_payload_json: row.payload_json,
		};
	}

	nextLoopMessagePosition(): number {
		return this.storage.sql
			.exec<{ position: number }>(`SELECT COALESCE(MAX(position), 0) + 1 AS position FROM loop_messages`)
			.one().position;
	}

	private loopMessagePageSummaries(pageIndex: LoopMessagePageIndex): BotLoopMessagePageSummary[] {
		return pageIndex.descriptors.map((descriptor) => {
			const summary = this.loopMessagePageCount(descriptor.sourceCompactionSeq);
			const olderPage = pageIndex.descriptors.find((item) => item.newerPage === descriptor.page)?.page;
			return {
				page: descriptor.page,
				messageCount: summary.messageCount,
				...(summary.fromSeq !== null ? { fromSeq: summary.fromSeq } : {}),
				...(summary.toSeq !== null ? { toSeq: summary.toSeq } : {}),
				...(descriptor.sourceCompactionSeq !== null ? { sourceCompactionSeq: descriptor.sourceCompactionSeq } : {}),
				...(descriptor.newerPage ? { newerPage: descriptor.newerPage } : {}),
				...(olderPage ? { olderPage } : {}),
			};
		});
	}

	private loopMessageCompactionSeqsWithChildren(sourceCompactionSeq: number | null): number[] {
		return this.storage.sql
			.exec<{ seq: number }>(
				`SELECT m.seq
				 FROM loop_messages m
				 WHERE m.compacted_by ${sourceCompactionSeq === null ? 'IS NULL' : '= ?'}
				   AND m.deleted_at IS NULL
				   AND m.origin = 'compaction'
				   AND EXISTS (
					SELECT 1 FROM loop_messages child
					WHERE child.compacted_by = m.seq AND child.deleted_at IS NULL
				   )
				 ORDER BY m.position DESC, m.seq DESC`,
				...(sourceCompactionSeq === null ? [] : [sourceCompactionSeq]),
			)
			.toArray()
			.map((row) => row.seq)
			.filter((seq) => Number.isInteger(seq));
	}

	private loopMessagePageCount(sourceCompactionSeq: number | null): { messageCount: number; fromSeq: number | null; toSeq: number | null } {
		const rows = this.loopMessageRowsForPage(sourceCompactionSeq, 0);
		const seqs = rows.map((row) => row.seq);
		return {
			messageCount: rows.length,
			fromSeq: seqs.length > 0 ? Math.min(...seqs) : null,
			toSeq: seqs.length > 0 ? Math.max(...seqs) : null,
		};
	}

	private latestLoopMessageLogBase(kind: BotLoopMessageLogKind): { id: number; text: string } | null {
		const row = this.storage.sql
			.exec<{ id: number }>(`SELECT id FROM loop_message_logs WHERE kind = ? ORDER BY id DESC LIMIT 1`, kind)
			.toArray()[0];
		return row ? { id: row.id, text: this.reconstructLoopMessageLogText(row.id) } : null;
	}

	private pruneLoopMessageLogs(): void {
		const retainedMessageSeqs = new Set(
			this.storage.sql
				.exec<{ seq: number }>(
					`SELECT seq FROM loop_messages WHERE compacted_by IS NULL ORDER BY position DESC, seq DESC LIMIT ?`,
					loopMessageLogRetentionCount,
				)
				.toArray()
				.map((row) => row.seq),
		);
		if (retainedMessageSeqs.size === 0) {
			this.storage.sql.exec(`DELETE FROM loop_message_log_chunks`);
			this.storage.sql.exec(`DELETE FROM loop_message_logs`);
			return;
		}
		const retainedLogRows = this.storage.sql
			.exec<LoopMessageLogRow>(
				`SELECT id, message_seq, kind, encoding, base_log_id, prefix_length, text_length, chunk_count, created_at
				 FROM loop_message_logs ORDER BY id ASC`,
			)
			.toArray();
		const deleteIds = new Set(retainedLogRows.filter((row) => !retainedMessageSeqs.has(row.message_seq)).map((row) => row.id));
		for (const row of retainedLogRows) {
			if (!retainedMessageSeqs.has(row.message_seq) || !row.base_log_id || !deleteIds.has(row.base_log_id)) {
				continue;
			}
			this.materializeLoopMessageLog(row.id);
		}
		for (const id of deleteIds) {
			this.storage.sql.exec(`DELETE FROM loop_message_log_chunks WHERE log_id = ?`, id);
			this.storage.sql.exec(`DELETE FROM loop_message_logs WHERE id = ?`, id);
		}
	}

	/**
	 * Physically delete history that retention has released (design §2.4).
	 *
	 * The active context — `compacted_by IS NULL AND deleted_at IS NULL` — can
	 * never match any of these predicates, so a live provider window is never
	 * touched no matter how old it is. Bounded by `limit`: `pendingMore` reports
	 * that expired rows remain for the next pass.
	 */
	pruneExpiredLoopMessages(options: { now?: Date; limit?: number } = {}): LoopMessageRetentionResult {
		const batch = this.pruneExpiredLoopMessageBatch(options);
		// A single-batch caller has no continuation to resume from, so the scan
		// bookkeeping stays inside this module.
		return {
			deletedMessages: batch.deletedMessages,
			deletedLogs: batch.deletedLogs,
			stampedSummaries: batch.stampedSummaries,
			pendingMore: batch.pendingMore,
		};
	}

	private pruneExpiredLoopMessageBatch(
		options: { now?: Date; limit?: number; after?: LoopMessageRetentionCursor },
	): LoopMessageRetentionBatch {
		const now = options.now ?? new Date();
		const limit = positiveInteger(options.limit) ?? loopMessageRetentionBatchSize;
		const compactedCutoff = new Date(now.getTime() - compactedLoopMessageRetentionDays * dayMs).toISOString();
		const summaryCutoff = new Date(now.getTime() - compactionSummaryLoopMessageRetentionDays * dayMs).toISOString();
		const deletedCutoff = new Date(now.getTime() - deletedLoopMessageRetentionDays * dayMs).toISOString();
		// The widest of the three cutoffs bounds the range scan. Each branch still
		// carries its own cutoff, so this stays a pure index bound and no branch can
		// widen when the retention constants change independently.
		const widestCutoff = [compactedCutoff, summaryCutoff, deletedCutoff].reduce(
			(widest, cutoff) => (cutoff > widest ? cutoff : widest),
		);
		// No continuation means starting at the bottom of the index. The empty
		// string sorts below every ISO timestamp, so the sentinel needs no separate
		// branch in the statement.
		const afterCreatedAt = options.after?.createdAt ?? '';
		const afterSeq = options.after?.seq ?? 0;
		const selected = this.storage.sql
			.exec<ExpiredLoopMessageScanRow>(
				// Bounding the whole predicate by the widest cutoff lets
				// loop_messages_retention answer it as one created_at range scan in
				// index order, stopping at the limit, instead of a full table scan.
				// The continuation is the same index's lower bound: the `>=` keeps the
				// scan a range, and the tuple comparison makes it strict.
				`SELECT seq, compacted_by AS compactedBy, origin, created_at AS createdAt
				 FROM loop_messages
				 WHERE created_at < ?
				   AND created_at >= ?
				   AND (created_at > ? OR (created_at = ? AND seq > ?))
				   AND (
					(compacted_by IS NOT NULL AND origin != 'compaction' AND created_at < ?)
					OR (compacted_by IS NOT NULL AND origin = 'compaction' AND created_at < ?)
					OR (deleted_at IS NOT NULL AND created_at < ?)
				   )
				 ORDER BY created_at ASC, seq ASC
				 LIMIT ?`,
				widestCutoff,
				afterCreatedAt,
				afterCreatedAt,
				afterCreatedAt,
				afterSeq,
				compactedCutoff,
				summaryCutoff,
				deletedCutoff,
				limit,
			)
			.toArray();
		// Read in scan order, before the re-sort below reorders it: the continuation
		// has to be the last row the index reached, not the highest sequence number.
		const last = selected.at(-1);
		const after = last ? { createdAt: last.createdAt, seq: last.seq } : null;
		// The withholding guard below reads children before their summary, which
		// is sequence order rather than the index order this batch arrived in.
		const expired = selected.sort((left, right) => left.seq - right.seq);
		if (expired.length === 0) {
			return { deletedMessages: 0, deletedLogs: 0, stampedSummaries: 0, pendingMore: false, selected: 0, after };
		}
		const prune = (): Omit<LoopMessageRetentionResult, 'pendingMore'> =>
			this.physicallyDeleteLoopMessages(expired, now.toISOString());
		const deleted = typeof this.storage.transactionSync === 'function' ? this.storage.transactionSync(prune) : prune();
		return { ...deleted, pendingMore: expired.length >= limit, selected: expired.length, after };
	}

	/**
	 * Spend a whole sweep allowance in batches (design §2.4).
	 *
	 * The sweep is the only path that prunes more than one batch, and it visits
	 * participants whose backlog predates retention entirely. Spending the
	 * allowance in one call would put thousands of rows under a single input-gate
	 * hold; spending it batch by batch keeps every transaction short, and the
	 * wall-clock budget keeps the visit itself short enough for its caller to
	 * still be listening. Whichever bound stops the loop, the batches already
	 * committed stand and `pendingMore` carries the remainder to the next cycle.
	 *
	 * Yielding between batches is what makes both of those true, and it is why
	 * this is async. The Workers runtime freezes the clock for the length of a
	 * synchronous stretch — `Date.now()` reports the time of the last I/O — so a
	 * loop that never awaited would read the same instant on every batch and
	 * could never reach its budget; and the object's input gate would stay shut
	 * for all forty batches, which is precisely the long hold the batching is
	 * meant to avoid.
	 *
	 * Yielding also means other events reach the object mid-pass, so every batch
	 * re-selects against current storage:
	 *
	 * - A tick that starts mid-pass writes rows stamped now, which are days
	 *   inside every cutoff and cannot be selected by a later batch. Rows it
	 *   compacts or soft-deletes become candidates only once their own cutoff
	 *   passes, well after this visit ends.
	 * - A full storage clear that lands mid-pass is caught by `shouldContinue`,
	 *   which the caller backs with the tombstone the clear sets before its first
	 *   await. That ordering matters: it means the loop can only ever resume
	 *   either before the clear started or after the tombstone is visible, never
	 *   in the window where the tables have been dropped and not yet rebuilt.
	 *   Even without the guard a later batch would select nothing from the
	 *   rebuilt empty tables and so write nothing — the post-clear repopulation
	 *   invariant holds either way — but stopping is the honest answer.
	 */
	async pruneExpiredLoopMessagesWithinBudget(
		options: {
			now?: Date;
			rowAllowance: number;
			timeBudgetMs: number;
			nowMs?: () => number;
			/** Checked after each yield; false ends the pass with what it has. */
			shouldContinue?: () => boolean;
		},
	): Promise<SweepLoopMessageRetentionResult> {
		const now = options.now ?? new Date();
		const nowMs = options.nowMs ?? Date.now;
		const startedAtMs = nowMs();
		const totals = { deletedMessages: 0, deletedLogs: 0, stampedSummaries: 0, pendingMore: false };
		// An allowance that is not a positive row count is nothing to do rather
		// than a batch's worth of work: the batch size is this loop's step, never
		// its floor. The zero-row answer claims nothing about what is left, because
		// a pass that never looked has not learned anything to report.
		const rowAllowance = positiveInteger(options.rowAllowance) ?? 0;
		let timeBudgetExhausted = false;
		let after: LoopMessageRetentionCursor | undefined;
		// Rows a batch selected but could not delete are still expired rows this
		// object holds, so they keep `pendingMore` true even once the cursor has
		// stepped past them.
		let withheldAny = false;
		let remaining = rowAllowance;
		while (remaining > 0) {
			const batch = this.pruneExpiredLoopMessageBatch({
				now,
				// Never ask for more than the allowance still covers: the last batch
				// of a pass is as short as what is left of it.
				limit: Math.min(loopMessageRetentionBatchSize, remaining),
				...(after ? { after } : {}),
			});
			totals.deletedMessages += batch.deletedMessages;
			totals.deletedLogs += batch.deletedLogs;
			totals.stampedSummaries += batch.stampedSummaries;
			withheldAny ||= batch.selected > batch.deletedMessages;
			totals.pendingMore = batch.pendingMore || withheldAny;
			remaining = rowAllowance - totals.deletedMessages;
			if (!batch.pendingMore || batch.after === null || remaining <= 0) {
				break;
			}
			// Advance past everything this batch looked at, deleted or not. A head
			// batch that could only withhold summaries whose children survive would
			// otherwise be re-selected by every batch and every later visit, leaving
			// the deletable rows behind it unreachable until those children expire.
			// The cursor is strictly increasing over a finite table, so the loop
			// terminates on its own even before the allowance and the clock.
			after = batch.after;
			await yieldBetweenLoopMessageRetentionBatches();
			if (nowMs() - startedAtMs >= options.timeBudgetMs) {
				timeBudgetExhausted = true;
				break;
			}
			if (options.shouldContinue?.() === false) {
				break;
			}
		}
		return { loopMessages: totals, timeBudgetExhausted };
	}

	private pruneRuntimeDiagnosticLoopMessages(): number {
		let deletedCount = 0;
		for (const origin of runtimeDiagnosticLoopMessageOrigins) {
			deletedCount += this.physicallyDeleteExpiredRuntimeDiagnosticLoopMessages(origin);
		}
		return deletedCount;
	}

	private physicallyDeleteExpiredRuntimeDiagnosticLoopMessages(origin: RuntimeDiagnosticLoopMessageOrigin): number {
		const expired = this.storage.sql
			.exec<ExpiredLoopMessageRow>(
				`SELECT seq, compacted_by AS compactedBy, origin
				 FROM loop_messages
				 WHERE origin = ?
				 ORDER BY seq DESC
				 LIMIT -1 OFFSET ?`,
				origin,
				runtimeDiagnosticLoopMessageRetentionCount,
			)
			.toArray()
			.sort((left, right) => left.seq - right.seq);
		if (expired.length === 0) {
			return 0;
		}
		// Compaction deliberately absorbs diagnostic rows that never contributed to
		// provider history, so an expired diagnostic row can belong to a ledger.
		// This path therefore stamps its summaries exactly like the retention pass;
		// the shared deletion applies both invariants in one place.
		return this.physicallyDeleteLoopMessages(expired, new Date().toISOString()).deletedMessages;
	}

	/**
	 * Delete loop messages together with their logs, inside the caller's
	 * transaction, preserving two stored invariants:
	 *
	 * - Delta logs chain across message ownership, so every surviving log whose
	 *   base is about to disappear is materialized first.
	 * - A compaction summary that keeps a child must record that some of its
	 *   children are gone, so `ledger_pruned_at` is stamped in the same
	 *   transaction as the deletion that pruned them.
	 */
	private physicallyDeleteLoopMessages(
		expired: readonly ExpiredLoopMessageRow[],
		prunedAt: string,
	): Omit<LoopMessageRetentionResult, 'pendingMore'> {
		const deletable = this.loopMessagesWithoutSurvivingChildren(expired);
		if (deletable.length === 0) {
			return { deletedMessages: 0, deletedLogs: 0, stampedSummaries: 0 };
		}
		const deletedSeqs = deletable.map((row) => row.seq);
		const stampedSummaries = this.stampPrunedCompactionLedgers(deletable, prunedAt);
		const deletedLogs = this.deleteLoopMessageLogs(deletedSeqs);
		for (const chunk of chunked(deletedSeqs, loopMessageDeleteStatementWidth)) {
			this.storage.sql.exec(`DELETE FROM loop_messages WHERE seq IN (${sqlPlaceholders(chunk.length)})`, ...chunk);
		}
		return { deletedMessages: deletedSeqs.length, deletedLogs, stampedSummaries };
	}

	/**
	 * Withhold any summary in the batch that would leave a child behind. Children
	 * always expire before the summary that absorbed them, so this only bites at
	 * a batch boundary or when a child was resurrected — but deleting a summary
	 * whose child survives would make that child unreachable from the page index
	 * instead of deleting it.
	 */
	private loopMessagesWithoutSurvivingChildren(expired: readonly ExpiredLoopMessageRow[]): ExpiredLoopMessageRow[] {
		const expiredChildrenByParent = new Map<number, number[]>();
		for (const row of expired) {
			if (row.compactedBy === null) {
				continue;
			}
			expiredChildrenByParent.set(row.compactedBy, [...(expiredChildrenByParent.get(row.compactedBy) ?? []), row.seq]);
		}
		const summaries = expired.filter((row) => row.origin === 'compaction').map((row) => row.seq);
		const childCountByParent = new Map<number, number>();
		for (const chunk of chunked(summaries, loopMessageDeleteStatementWidth)) {
			for (const row of this.storage.sql
				.exec<{ parentSeq: number; childCount: number }>(
					`SELECT compacted_by AS parentSeq, COUNT(*) AS childCount
					 FROM loop_messages
					 WHERE compacted_by IN (${sqlPlaceholders(chunk.length)})
					 GROUP BY compacted_by`,
					...chunk,
				)
				.toArray()) {
				childCountByParent.set(row.parentSeq, row.childCount);
			}
		}
		// In ascending sequence order a child is always decided before the summary
		// that absorbed it, so withholding cascades up a summary chain in one pass.
		const withheld = new Set<number>();
		for (const row of expired) {
			const childCount = childCountByParent.get(row.seq) ?? 0;
			if (childCount === 0) {
				continue;
			}
			const expiring = (expiredChildrenByParent.get(row.seq) ?? []).filter((seq) => !withheld.has(seq)).length;
			if (childCount > expiring) {
				withheld.add(row.seq);
			}
		}
		return withheld.size === 0 ? [...expired] : expired.filter((row) => !withheld.has(row.seq));
	}

	private stampPrunedCompactionLedgers(deletable: readonly ExpiredLoopMessageRow[], prunedAt: string): number {
		const deletedSeqs = new Set(deletable.map((row) => row.seq));
		const summarySeqs = [
			...new Set(
				deletable
					.map((row) => row.compactedBy)
					.filter((seq): seq is number => seq !== null && !deletedSeqs.has(seq)),
			),
		];
		let stamped = 0;
		for (const chunk of chunked(summarySeqs, loopMessageDeleteStatementWidth)) {
			// Keep the first prune's timestamp: it is the moment the summary stopped
			// being a complete record, and later prunes do not make it less true.
			this.storage.sql.exec(
				`UPDATE loop_messages
				 SET ledger_pruned_at = ?
				 WHERE seq IN (${sqlPlaceholders(chunk.length)})
				   AND ledger_pruned_at IS NULL`,
				prunedAt,
				...chunk,
			);
			stamped += this.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
		}
		return stamped;
	}

	/**
	 * Whether any log belongs to these messages, answered from
	 * `loop_message_logs_message` rather than by materializing the table.
	 *
	 * A false here is exactly the case where the full pass would find no ids to
	 * delete, and so would materialize nothing: the delta-chain invariant only
	 * has work to do when some log is about to disappear.
	 */
	private hasLoopMessageLogsFor(deletedSeqs: readonly number[]): boolean {
		for (const chunk of chunked(deletedSeqs, loopMessageDeleteStatementWidth)) {
			const found = this.storage.sql
				.exec<{ found: number }>(
					`SELECT EXISTS (
						SELECT 1 FROM loop_message_logs WHERE message_seq IN (${sqlPlaceholders(chunk.length)})
					 ) AS found`,
					...chunk,
				)
				.one().found;
			if (found) {
				return true;
			}
		}
		return false;
	}

	private deleteLoopMessageLogs(deletedSeqs: readonly number[]): number {
		// The materialization pass below has to read every log row, because a
		// surviving delta can be based on any log that came before it. That whole
		// scan is wasted when this batch's messages own no logs at all, which is the
		// common case for a text-only backlog — and a sweep visit runs it once per
		// batch, up to the full allowance, against a table that only grows.
		if (!this.hasLoopMessageLogsFor(deletedSeqs)) {
			return 0;
		}
		const deleting = new Set(deletedSeqs);
		const logRows = this.storage.sql
			.exec<LoopMessageLogRow>(
				`SELECT id, message_seq, kind, encoding, base_log_id, prefix_length, text_length, chunk_count, created_at
				 FROM loop_message_logs ORDER BY id ASC`,
			)
			.toArray();
		const deleteIds = new Set(logRows.filter((row) => deleting.has(row.message_seq)).map((row) => row.id));
		for (const row of logRows) {
			// Delta logs may cross message ownership. Materialize every surviving
			// direct dependent before its expired base and chunks are removed. Log id
			// order guarantees a base is materialized before anything built on it.
			if (deleteIds.has(row.id) || !row.base_log_id || !deleteIds.has(row.base_log_id)) {
				continue;
			}
			this.materializeLoopMessageLog(row.id);
		}
		const ids = [...deleteIds];
		for (const chunk of chunked(ids, loopMessageDeleteStatementWidth)) {
			const placeholders = sqlPlaceholders(chunk.length);
			this.storage.sql.exec(`DELETE FROM loop_message_log_chunks WHERE log_id IN (${placeholders})`, ...chunk);
			this.storage.sql.exec(`DELETE FROM loop_message_logs WHERE id IN (${placeholders})`, ...chunk);
		}
		return ids.length;
	}

	private materializeLoopMessageLog(logId: number): void {
		const text = this.reconstructLoopMessageLogText(logId);
		const chunks = chunkText(text, loopMessageLogChunkLength);
		this.storage.sql.exec(
			`UPDATE loop_message_logs
			 SET encoding = 'full', base_log_id = NULL, prefix_length = NULL, text_length = ?, chunk_count = ?
			 WHERE id = ?`,
			text.length,
			chunks.length,
			logId,
		);
		this.storage.sql.exec(`DELETE FROM loop_message_log_chunks WHERE log_id = ?`, logId);
		for (let index = 0; index < chunks.length; index += 1) {
			this.storage.sql.exec(
				`INSERT INTO loop_message_log_chunks (log_id, chunk_index, text) VALUES (?, ?, ?)`,
				logId,
				index,
				chunks[index] ?? '',
			);
		}
	}
}

function isRuntimeDiagnosticLoopMessageOrigin(
	origin: LoopMessageGroupEntry['origin'],
): origin is RuntimeDiagnosticLoopMessageOrigin {
	return runtimeDiagnosticLoopMessageOrigins.some((diagnosticOrigin) => diagnosticOrigin === origin);
}

export function loopMessageFromRow(row: LoopMessageRow): BotLoopMessage {
	const display = loopMessageDisplayFromRow(row);
	return {
		seq: row.seq,
		position: row.position,
		runId: row.run_id,
		role: row.role,
		message: loopMessageChatMessageFromRow(row),
		...(display ? { display } : {}),
		origin: row.origin,
		tokenEstimate: row.token_estimate,
		createdAt: row.created_at,
		...(row.status ? { status: row.status } : {}),
		...(row.stream_seq !== null ? { streamSeq: row.stream_seq } : {}),
		...(row.compacted_by ? { compactedBy: row.compacted_by } : {}),
		...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
		...(row.has_logs ? { hasLogs: true } : {}),
	};
}

export function encodeLoopMessageLog(
	text: string,
	baseText: string,
	baseLogId: number,
): { encoding: BotLoopMessageLogEncoding; text: string; baseLogId?: number; prefixLength?: number } {
	if (text.startsWith(baseText) && text.length > baseText.length) {
		const suffix = text.slice(baseText.length);
		if (suffix.length < text.length * 0.9) {
			return { encoding: 'append', text: suffix, baseLogId };
		}
	}
	const prefixLength = commonPrefixLength(text, baseText);
	if (prefixLength >= 256 && prefixLength >= text.length * 0.4) {
		return { encoding: 'replace_tail', text: text.slice(prefixLength), baseLogId, prefixLength };
	}
	return { encoding: 'full', text };
}

function loopMessageDisplayFromRow(row: LoopMessageRow): BotLoopMessageDisplay | undefined {
	const eventSeq = row.display_event_seq;
	const payloadJson = row.display_event_payload_json;
	if (typeof eventSeq !== 'number' || !Number.isInteger(eventSeq) || !payloadJson || row.display_event_type !== 'tool_result') {
		return undefined;
	}
	try {
		const payload = runtimeRecord(JSON.parse(payloadJson) as unknown);
		const name = stringValue(payload.name);
		if (!name || !Object.hasOwn(payload, 'result')) {
			return undefined;
		}
		const context = runtimeRecord(payload.displayContext);
		const worldHandle = stringValue(context.worldHandle);
		return {
			kind: 'tool_result',
			eventSeq,
			name,
			args: payload.args,
			result: payload.result,
			...(payload.envelope ? { envelope: payload.envelope as BotLoopMessageDisplay["envelope"] } : {}),
			...(worldHandle ? { context: { worldHandle } } : {}),
		};
	} catch {
		return undefined;
	}
}

function loopMessageLogFromRow(row: LoopMessageLogRow, text: string): BotLoopMessageLog {
	return {
		id: row.id,
		messageSeq: row.message_seq,
		kind: row.kind,
		encoding: row.encoding,
		textLength: row.text_length,
		text,
		createdAt: row.created_at,
		...(row.base_log_id ? { baseLogId: row.base_log_id } : {}),
		...(row.prefix_length !== null ? { prefixLength: row.prefix_length } : {}),
	};
}

function loopMessageChatMessageFromRow(row: LoopMessageRow): BotInferenceSubmissionMessage {
	return JSON.parse(row.message_json) as BotInferenceSubmissionMessage;
}

function commonPrefixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) {
		index += 1;
	}
	return index;
}

function chunkText(text: string, chunkLength: number): string[] {
	if (!text) {
		return [''];
	}
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += chunkLength) {
		chunks.push(text.slice(index, index + chunkLength));
	}
	return chunks;
}

function sqlPlaceholders(count: number): string {
	return new Array(count).fill('?').join(', ');
}

/**
 * Hand the runtime a turn between retention batches.
 *
 * A real timer rather than a resolved promise: only I/O advances the Workers
 * clock, and only a macrotask lets the object's input gate deliver anything
 * else. A microtask would leave the batch loop both blind to its own budget and
 * indistinguishable from one long hold.
 */
function yieldBetweenLoopMessageRetentionBatches(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

function positiveInteger(value: number | undefined): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function estimateTextTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) {
		return value.trim();
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const text = (value as { text?: unknown }).text;
		if (typeof text === 'string' && text.trim()) {
			return text.trim();
		}
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return undefined;
}
