import { chunks } from '@bickr/shared/storage';
import { dayMs, injectionRetentionDays, pendingSpotlightTicksStateKey } from '../constants';
import type { InjectionRetentionResult, PendingSpotlightTick, QueuedSpotlightTick } from '../types';

export type SpotlightTickQueueStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

/**
 * The durable queue of spotlight visits a participant owes, and the injections
 * those entries point at.
 *
 * The two are one unit of state: a queue entry is only meaningful while its
 * injection row is still there, and nothing outside this class may write either
 * side of that pairing. Retention in particular has to delete injections and
 * rewrite the queue in the same transaction, which is why the prune lives here
 * rather than beside the other loop-history retention.
 */
export class RuntimeSpotlightTickQueue {
	private readonly storage: SpotlightTickQueueStorage;

	constructor(storage: SpotlightTickQueueStorage) {
		this.storage = storage;
	}

	entries(): QueuedSpotlightTick[] {
		const row = this.storage.sql
			.exec<{ value_json: string }>(`SELECT value_json FROM runtime_state WHERE key = ?`, pendingSpotlightTicksStateKey)
			.toArray()[0];
		if (!row) {
			return [];
		}
		try {
			const parsed = runtimeRecord(JSON.parse(row.value_json) as unknown);
			const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
			return entries
				.map((entry) => runtimeRecord(entry))
				.map((entry) => ({
					injectionId: stringValue(entry.injectionId) ?? '',
					spotlightId: stringValue(entry.spotlightId) ?? '',
					createdAt: stringValue(entry.createdAt) ?? '',
				}))
				.filter((entry) => entry.injectionId && entry.spotlightId && entry.createdAt);
		} catch {
			this.clear();
			return [];
		}
	}

	/**
	 * Queue one spotlight's injections behind whatever is already waiting.
	 * Returns the entries actually added, which is empty for a replayed batch.
	 */
	append(spotlightId: string, injectionIds: readonly string[], now: string): QueuedSpotlightTick[] {
		const existing = this.entries();
		const existingInjectionIds = new Set(existing.map((entry) => entry.injectionId));
		const additions = injectionIds
			.filter((injectionId) => !existingInjectionIds.has(injectionId))
			.map((injectionId) => ({ injectionId, spotlightId, createdAt: now }));
		if (additions.length > 0) {
			this.write([...existing, ...additions]);
		}
		return additions;
	}

	prepend(entries: readonly QueuedSpotlightTick[]): void {
		if (entries.length === 0) {
			return;
		}
		const existing = this.entries();
		const prependedInjectionIds = new Set(entries.map((entry) => entry.injectionId));
		this.write([...entries, ...existing.filter((entry) => !prependedInjectionIds.has(entry.injectionId))]);
	}

	/**
	 * Take the oldest queued spotlight's entries, dropping any whose injection has
	 * already been consumed by another visit.
	 */
	takeNext(): PendingSpotlightTick | null {
		const unconsumed = this.entries().filter((entry) => this.hasUnconsumedInjection(entry.injectionId));
		if (unconsumed.length === 0) {
			this.clear();
			return null;
		}
		const spotlightId = unconsumed[0]?.spotlightId;
		if (!spotlightId) {
			this.clear();
			return null;
		}
		const entries = unconsumed.filter((entry) => entry.spotlightId === spotlightId);
		const remaining = unconsumed.filter((entry) => entry.spotlightId !== spotlightId);
		this.write(remaining);
		return {
			spotlightId,
			injectionIds: entries.map((entry) => entry.injectionId),
			entries,
		};
	}

	hasUnconsumedInjection(injectionId: string): boolean {
		const row = this.storage.sql
			.exec<{ found: number }>(
				`SELECT 1 AS found
				 FROM injections
				 WHERE id = ? AND consumed_at IS NULL
				 LIMIT 1`,
				injectionId,
			)
			.toArray()[0];
		return Boolean(row);
	}

	/**
	 * Retention for injections and, in the same transaction, the queue that points
	 * at them (design §2.4).
	 *
	 * Expired spotlight injections go whether or not a queue entry exists: a crash
	 * between injecting and queueing leaves an injection no visit will ever read,
	 * and a crash after queueing leaves an entry whose injection may be gone. The
	 * queue is rewritten from the surviving rows either way, so the pairing is
	 * restored rather than repaired later on read. Unconsumed manual injections are
	 * kept: they are owner input waiting for a paused participant to resume.
	 */
	pruneExpiredInjections(options: { now?: Date; retentionDays?: number } = {}): InjectionRetentionResult {
		const now = options.now ?? new Date();
		const retentionDays = options.retentionDays ?? injectionRetentionDays;
		const cutoff = new Date(now.getTime() - retentionDays * dayMs).toISOString();
		const prune = (): InjectionRetentionResult => {
			// Consumed rows are pruned by creation time like everything else here:
			// their only remaining reader is spotlight injection idempotency, whose
			// retries happen within one delivery attempt, not across two weeks.
			this.storage.sql.exec(
				`DELETE FROM injections
				 WHERE created_at < ?
				   AND (consumed_at IS NOT NULL OR kind = 'spotlight')`,
				cutoff,
			);
			const deletedInjections = this.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
			const entries = this.entries();
			if (entries.length === 0) {
				return { deletedInjections, droppedQueueEntries: 0 };
			}
			const surviving = new Set(this.existingInjectionIds(entries.map((entry) => entry.injectionId)));
			const retained = entries.filter((entry) => surviving.has(entry.injectionId));
			if (retained.length !== entries.length) {
				this.write(retained);
			}
			return { deletedInjections, droppedQueueEntries: entries.length - retained.length };
		};
		return typeof this.storage.transactionSync === 'function' ? this.storage.transactionSync(prune) : prune();
	}

	private existingInjectionIds(injectionIds: readonly string[]): string[] {
		return chunks([...new Set(injectionIds)], injectionLookupStatementWidth).flatMap((chunk) =>
			this.storage.sql
				.exec<{ id: string }>(
					`SELECT id FROM injections WHERE id IN (${chunk.map(() => '?').join(', ')})`,
					...chunk,
				)
				.toArray()
				.map((row) => row.id),
		);
	}

	private write(entries: readonly QueuedSpotlightTick[]): void {
		if (entries.length === 0) {
			this.clear();
			return;
		}
		this.storage.sql.exec(
			`INSERT INTO runtime_state (key, value_json)
			 VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
			pendingSpotlightTicksStateKey,
			JSON.stringify({ entries }),
		);
	}

	private clear(): void {
		this.storage.sql.exec(`DELETE FROM runtime_state WHERE key = ?`, pendingSpotlightTicksStateKey);
	}
}

const injectionLookupStatementWidth = 100;

function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
