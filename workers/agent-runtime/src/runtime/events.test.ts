import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeMonitorInitialBackfillLimit } from '../constants';
import { RuntimeEventsStore } from './events';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';

describe('RuntimeEventsStore', () => {
	let storage: RuntimeTestStorage;
	let store: RuntimeEventsStore;

	beforeEach(() => {
		storage = createRuntimeTestStorage();
		store = new RuntimeEventsStore(storage);
	});

	afterEach(() => storage.database.close());

	it('appends and broadcasts events synchronously', () => {
		const broadcast = vi.fn();
		store = new RuntimeEventsStore(storage, broadcast);

		const event = store.appendEvent('run-append', 'input', { text: 'hello' });

		expect(event).toMatchObject({ seq: 1, runId: 'run-append', type: 'input', payload: { text: 'hello' } });
		expect(broadcast).toHaveBeenCalledWith(event);
	});

	it('keeps reconnect catch-up based on the requested sequence instead of the initial cap', () => {
		for (const seq of range(1, 150)) {
			insertEvent(storage, seq);
		}

		expect(store.eventsAfter(120).map((event) => event.seq)).toEqual(range(121, 150));
	});

	it('uses the monitor cap for initial event backfill without changing event order', () => {
		for (const seq of range(1, 150)) {
			insertEvent(storage, seq);
		}

		const events = store.eventsAfter(0, runtimeMonitorInitialBackfillLimit);

		expect(events).toHaveLength(runtimeMonitorInitialBackfillLimit);
		expect(events[0]?.seq).toBe(51);
		expect(events.at(-1)?.seq).toBe(150);
	});

	it('returns the newest usable compaction summary', () => {
		insertEvent(storage, 1, { type: 'compaction', payload: { status: 'complete', summary: 'older' } });
		insertEvent(storage, 2, { type: 'compaction', payload: { status: 'failed' } });
		insertEvent(storage, 3, { type: 'compaction', payload: { status: 'complete', summary: 'newer' } });

		expect(store.latestCompactionSummary((payload) => {
			const summary = (payload as { summary?: unknown }).summary;
			return typeof summary === 'string' ? summary : '';
		})).toBe('newer');
	});

	it('prunes only expired event rows below the retained log-off boundary', () => {
		insertEvent(storage, 1, { createdAt: '2026-05-01T00:00:00.000Z' });
		insertEvent(storage, 2, { createdAt: '2026-05-01T00:00:00.000Z', runId: 'active-run' });
		insertEvent(storage, 3, { createdAt: '2026-05-01T00:00:00.000Z' });
		insertEvent(storage, 4, { createdAt: '2026-07-10T00:00:00.000Z' });

		expect(store.pruneEventsAfterTick('active-run', 3, new Date('2026-07-11T00:00:00.000Z'))).toBe(1);
		expect(store.eventsAfter(0).map((event) => event.seq)).toEqual([2, 3, 4]);
	});
});

function insertEvent(
	storage: RuntimeTestStorage,
	seq: number,
	options: { createdAt?: string; payload?: unknown; runId?: string; type?: 'input' | 'compaction' } = {},
): void {
	storage.database.prepare(
		`INSERT INTO events (seq, run_id, type, payload_json, token_estimate, compacted_by, created_at)
		 VALUES (?, ?, ?, ?, 1, NULL, ?)`,
	).run(
		seq,
		options.runId ?? 'run-monitor',
		options.type ?? 'input',
		JSON.stringify(options.payload ?? { text: `event ${seq}` }),
		options.createdAt ?? '2026-07-10T00:00:00.000Z',
	);
}

function range(start: number, end: number): number[] {
	return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}
