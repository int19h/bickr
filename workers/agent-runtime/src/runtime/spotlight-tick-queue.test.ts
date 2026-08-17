import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pendingSpotlightTicksStateKey } from '../constants';
import { RuntimeSpotlightTickQueue } from './spotlight-tick-queue';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';

describe('RuntimeSpotlightTickQueue', () => {
	const now = new Date('2026-08-17T00:00:00.000Z');
	const daysAgo = (days: number): string => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

	let storage: RuntimeTestStorage;
	let queue: RuntimeSpotlightTickQueue;

	beforeEach(() => {
		storage = createRuntimeTestStorage();
		queue = new RuntimeSpotlightTickQueue(storage);
	});

	afterEach(() => storage.database.close());

	it('takes one spotlight at a time and drops entries whose injection was consumed elsewhere', () => {
		insertInjection(storage, { id: 'inj-1', spotlightId: 'spot-1', createdAt: daysAgo(0) });
		insertInjection(storage, { id: 'inj-2', spotlightId: 'spot-1', createdAt: daysAgo(0) });
		insertInjection(storage, { id: 'inj-3', spotlightId: 'spot-2', createdAt: daysAgo(0), consumedAt: daysAgo(0) });
		queue.append('spot-1', ['inj-1', 'inj-2'], daysAgo(0));
		queue.append('spot-2', ['inj-3'], daysAgo(0));

		const taken = queue.takeNext();

		expect(taken).toMatchObject({ spotlightId: 'spot-1', injectionIds: ['inj-1', 'inj-2'] });
		// spot-2's only injection was already consumed, so nothing remains to run.
		expect(queue.takeNext()).toBeNull();
		expect(queueEntries(storage)).toEqual([]);
	});

	it('does not queue a replayed batch twice', () => {
		insertInjection(storage, { id: 'inj-1', spotlightId: 'spot-1', createdAt: daysAgo(0) });

		expect(queue.append('spot-1', ['inj-1'], daysAgo(0))).toHaveLength(1);
		expect(queue.append('spot-1', ['inj-1'], daysAgo(0))).toEqual([]);
		expect(queueEntries(storage)).toHaveLength(1);
	});

	it('deletes expired spotlight and consumed injections and rewrites the queue in the same pass', () => {
		insertInjection(storage, { id: 'stale-queued', spotlightId: 'spot-old', createdAt: daysAgo(20) });
		insertInjection(storage, { id: 'stale-unqueued', spotlightId: 'spot-crashed', createdAt: daysAgo(20) });
		insertInjection(storage, { id: 'fresh-spotlight', spotlightId: 'spot-new', createdAt: daysAgo(2) });
		insertInjection(storage, { id: 'old-consumed', kind: 'manual', createdAt: daysAgo(30), consumedAt: daysAgo(29) });
		insertInjection(storage, { id: 'old-manual', kind: 'manual', createdAt: daysAgo(30) });
		queue.append('spot-old', ['stale-queued'], daysAgo(20));
		queue.append('spot-new', ['fresh-spotlight'], daysAgo(2));
		// A crash between injecting and queueing leaves an entry with no row at all.
		queue.append('spot-lost', ['never-existed'], daysAgo(1));

		const result = queue.pruneExpiredInjections({ now });

		expect(result).toEqual({ deletedInjections: 3, droppedQueueEntries: 2 });
		expect(injectionIds(storage)).toEqual(['fresh-spotlight', 'old-manual']);
		// Unconsumed manual input survives; the queue keeps only live pairings.
		expect(queueEntries(storage).map((entry) => entry.injectionId)).toEqual(['fresh-spotlight']);
	});

	it('clears the queue row entirely when nothing survives', () => {
		insertInjection(storage, { id: 'stale', spotlightId: 'spot-old', createdAt: daysAgo(20) });
		queue.append('spot-old', ['stale'], daysAgo(20));

		queue.pruneExpiredInjections({ now });

		expect(storage.database.prepare(`SELECT COUNT(*) AS count FROM runtime_state WHERE key = ?`)
			.get(pendingSpotlightTicksStateKey)?.count).toBe(0);
	});

	it('discards an unreadable queue value instead of failing the pass', () => {
		storage.database.prepare(`INSERT INTO runtime_state (key, value_json) VALUES (?, 'not json')`)
			.run(pendingSpotlightTicksStateKey);

		expect(queue.entries()).toEqual([]);
		expect(queue.pruneExpiredInjections({ now })).toEqual({ deletedInjections: 0, droppedQueueEntries: 0 });
	});
});

function insertInjection(
	storage: RuntimeTestStorage,
	input: { id: string; createdAt: string; kind?: string; spotlightId?: string; consumedAt?: string },
): void {
	storage.database.prepare(
		`INSERT INTO injections (id, text, kind, source_id, spotlight_id, created_at, consumed_at)
		 VALUES (?, ?, ?, NULL, ?, ?, ?)`,
	).run(
		input.id,
		`thought ${input.id}`,
		input.kind ?? (input.spotlightId ? 'spotlight' : 'manual'),
		input.spotlightId ?? null,
		input.createdAt,
		input.consumedAt ?? null,
	);
}

function injectionIds(storage: RuntimeTestStorage): string[] {
	return storage.database.prepare(`SELECT id FROM injections ORDER BY id ASC`).all().map((row) => row.id as string);
}

function queueEntries(storage: RuntimeTestStorage): Array<{ injectionId: string; spotlightId: string }> {
	const row = storage.database.prepare(`SELECT value_json FROM runtime_state WHERE key = ?`)
		.get(pendingSpotlightTicksStateKey) as { value_json?: string } | undefined;
	return row?.value_json ? (JSON.parse(row.value_json) as { entries: Array<{ injectionId: string; spotlightId: string }> }).entries : [];
}
