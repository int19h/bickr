import type { BotRuntimeEvent, BotRuntimeEventType } from '@bickr/shared/model';
import { dayMs, runtimeEventRetentionDays } from '../constants';
import type { RuntimeRow } from '../types';

export type RuntimeEventsStorage = Pick<DurableObjectStorage, 'sql'>;

export class RuntimeEventsStore {
	private readonly storage: RuntimeEventsStorage;
	private readonly broadcast: (event: BotRuntimeEvent) => void;

	constructor(
		storage: RuntimeEventsStorage,
		broadcast: (event: BotRuntimeEvent) => void = () => {},
	) {
		this.storage = storage;
		this.broadcast = broadcast;
	}

	appendEvent(runId: string, type: BotRuntimeEventType, payload: unknown): BotRuntimeEvent {
		const now = new Date().toISOString();
		const payloadJson = JSON.stringify(payload);
		const tokenEstimate = estimateTextTokens(payloadJson);
		this.storage.sql.exec(
			`INSERT INTO events (run_id, type, payload_json, token_estimate, compacted_by, created_at)
			 VALUES (?, ?, ?, ?, NULL, ?)`,
			runId,
			type,
			payloadJson,
			tokenEstimate,
			now,
		);
		const row = this.storage.sql.exec<{ seq: number }>(`SELECT last_insert_rowid() AS seq`).one();
		const event: BotRuntimeEvent = {
			seq: row.seq,
			runId,
			type,
			payload,
			tokenEstimate,
			createdAt: now,
		};
		this.broadcast(event);
		return event;
	}

	replaceEventPayload(event: BotRuntimeEvent, payload: unknown): BotRuntimeEvent {
		const payloadJson = JSON.stringify(payload);
		const tokenEstimate = estimateTextTokens(payloadJson);
		this.storage.sql.exec(
			`UPDATE events
			 SET payload_json = ?, token_estimate = ?
			 WHERE seq = ?`,
			payloadJson,
			tokenEstimate,
			event.seq,
		);
		const updated = { ...event, payload, tokenEstimate };
		this.broadcast(updated);
		return updated;
	}

	eventsAfter(afterSeq: number, initialLimit?: number): BotRuntimeEvent[] {
		const limit = positiveInteger(initialLimit) ?? 240;
		const rows =
			afterSeq > 0
				? this.storage.sql
						.exec<RuntimeRow>(
							`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
							 FROM events
							 WHERE seq > ?
							   AND type != 'provider_delta'
							 ORDER BY seq ASC
							 LIMIT 2000`,
							afterSeq,
						)
						.toArray()
				: this.storage.sql
						.exec<RuntimeRow>(
							`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
							 FROM (
								SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
								FROM events
								WHERE type != 'provider_delta'
								ORDER BY seq DESC
								LIMIT ?
							 )
							 ORDER BY seq ASC`,
							limit,
						)
						.toArray();
		return rows.map(eventFromRow);
	}

	latestCompactionSummary(summaryFromPayload: (payload: unknown) => string): string {
		const rows = this.storage.sql
			.exec<{ payload_json: string }>(
				`SELECT payload_json
				 FROM events
				 WHERE type = 'compaction'
				 ORDER BY seq DESC`,
			)
			.toArray();
		for (const row of rows) {
			const summary = summaryFromPayload(JSON.parse(row.payload_json) as unknown);
			if (summary) {
				return summary;
			}
		}
		return '';
	}

	markPendingCompactionEventsFailed(runId: string, error: string): void {
		for (const event of this.pendingCompactionEvents(runId)) {
			this.replaceEventPayload(event, { ...runtimeRecord(event.payload), status: 'failed', error });
		}
	}

	pendingCompactionEvents(runId: string): BotRuntimeEvent[] {
		const rows = this.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE run_id = ?
				   AND type = 'compaction'
				 ORDER BY seq ASC`,
				runId,
			)
			.toArray();
		const events: BotRuntimeEvent[] = [];
		for (const row of rows) {
			let payload: Record<string, unknown>;
			try {
				payload = runtimeRecord(JSON.parse(row.payload_json) as unknown);
			} catch {
				continue;
			}
			if (payload.status !== 'pending') {
				continue;
			}
			events.push({ ...eventFromRow(row), payload });
		}
		return events;
	}

	pruneEventsAfterTick(activeRunId: string, lastLogOffSeq: number, now = new Date()): number {
		const eventCutoff = new Date(now.getTime() - runtimeEventRetentionDays * dayMs).toISOString();
		this.storage.sql.exec(
			`DELETE FROM events
			 WHERE created_at < ?
			   AND run_id != ?
			   AND seq < ?`,
			eventCutoff,
			activeRunId,
			lastLogOffSeq,
		);
		return this.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
	}
}

function eventFromRow(row: RuntimeRow): BotRuntimeEvent {
	return {
		seq: row.seq,
		runId: row.run_id,
		type: row.type,
		payload: JSON.parse(row.payload_json) as unknown,
		tokenEstimate: row.token_estimate,
		createdAt: row.created_at,
		...(row.compacted_by ? { compactedBy: row.compacted_by } : {}),
	};
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
