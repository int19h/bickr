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
import {
	loopMessageLogChunkLength,
	loopMessageLogRetentionCount,
	loopMessagePageIndexLimit,
} from '../constants';
import type {
	ChatMessage,
	LoopMessageGroupEntry,
	LoopMessageLogChunkRow,
	LoopMessageLogRow,
	LoopMessagePageDescriptor,
	LoopMessagePageIndex,
	LoopMessageRow,
} from '../types';

export type RuntimeStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

export class RuntimeMessageStore {
	private readonly storage: RuntimeStorage;
	private readonly broadcastLoopMessage: (message: BotLoopMessage) => void;

	constructor(
		storage: RuntimeStorage,
		broadcastLoopMessage: (message: BotLoopMessage) => void = () => {},
	) {
		this.storage = storage;
		this.broadcastLoopMessage = broadcastLoopMessage;
	}

	appendLoopMessage(
		runId: string,
		message: ChatMessage,
		origin: LoopMessageGroupEntry['origin'],
		status: BotLoopMessageStatus = 'complete',
		options: { streamSeq?: number; displayEventSeq?: number } = {},
	): BotLoopMessage {
		const inserted = this.insertLoopMessage({
			runId,
			message,
			origin,
			status,
			streamSeq: options.streamSeq,
			displayEventSeq: options.displayEventSeq,
			broadcast: true,
		});
		this.recordLoopMessageLog(inserted.seq, 'message', JSON.stringify(message));
		return inserted;
	}

	appendLoopMessageGroup(entries: LoopMessageGroupEntry[]): BotLoopMessage[] {
		if (typeof this.storage.transactionSync !== 'function') {
			// Constructor-free unit harnesses can provide only the SQL surface;
			// production Durable Object storage always takes the transaction path.
			return entries.map((entry) => {
				const inserted = this.appendLoopMessage(entry.runId, entry.message, entry.origin, entry.status, entry.options);
				for (const log of entry.extraLogs ?? []) {
					this.recordLoopMessageLog(inserted.seq, log.kind, log.text);
				}
				return inserted;
			});
		}
		const inserted: BotLoopMessage[] = [];
		this.storage.transactionSync(() => {
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
		});
		for (const loopMessage of inserted) {
			this.broadcastLoopMessage(loopMessage);
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
				        display.payload_json AS display_event_payload_json, m.compacted_by, m.deleted_at, m.created_at,
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
