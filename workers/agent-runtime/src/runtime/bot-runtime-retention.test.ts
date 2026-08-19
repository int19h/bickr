/// <reference types="node" />

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addInternalServiceAuthHeader, internalServiceUrl } from '@bickr/shared/internal-service';
import type { BotDocument, UserDocument } from '@bickr/shared/model';
import { kvKeys, type KVNamespaceLike } from '@bickr/shared/storage';
import { loopMessageRetentionBatchSize, sweepRetentionTimeBudgetMs } from '../constants';
import type { RuntimeStorageRetentionResult } from '../types';
import { BotRuntime } from './bot-runtime';

/**
 * The retention routes over a real Durable Object: the constructor's own schema
 * and migration block build the storage, so these also cover the added column
 * and index arriving on an object that predates them.
 */
const internalServiceSecret = 'test-internal-service-secret';

describe('BotRuntime storage retention', () => {
	const botId = 'bot-retention';
	const now = new Date('2026-08-17T00:00:00.000Z');
	const daysAgo = (days: number): string => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

	let database: DatabaseSync;
	let sockets: FakeSocket[];

	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		sockets = [];
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		database.close();
	});

	function construct(options: { onOwnerLookup?: () => Promise<void> } = {}): BotRuntime {
		return new BotRuntime(runtimeState(database, sockets), runtimeEnv(botId, options) as never);
	}

	async function maintenanceRequest(runtime: BotRuntime, method: 'POST' | 'DELETE', path: string, internal = true): Promise<Response> {
		const headers = new Headers(internal ? { 'x-bickr-scheduler': '1' } : { 'x-bickr-user-id': 'usr-owner' });
		addInternalServiceAuthHeader(headers, internalServiceSecret);
		return await runtime.fetch(new Request(internalServiceUrl(`/bots/${botId}/${path}`), { method, headers }));
	}

	async function ownerInjection(runtime: BotRuntime, text: string): Promise<Response> {
		const headers = new Headers({ 'x-bickr-user-id': 'usr-owner', 'content-type': 'application/json' });
		addInternalServiceAuthHeader(headers, internalServiceSecret);
		return await runtime.fetch(new Request(internalServiceUrl(`/bots/${botId}/inject`), {
			method: 'POST',
			headers,
			body: JSON.stringify({ text }),
		}));
	}

	async function ownerContextBudget(runtime: BotRuntime, prompt: string): Promise<Response> {
		const headers = new Headers({ 'x-bickr-user-id': 'usr-owner', 'content-type': 'application/json' });
		addInternalServiceAuthHeader(headers, internalServiceSecret);
		return await runtime.fetch(new Request(internalServiceUrl(`/bots/${botId}/context-budget`), {
			method: 'POST',
			headers,
			body: JSON.stringify({ prompt }),
		}));
	}

	/** Answers the three prompt token probes an exact context budget costs. */
	function stubTokenProbes(options: { onProbe?: () => Promise<void> } = {}): () => number {
		let probes = 0;
		vi.stubGlobal('fetch', async (): Promise<Response> => {
			probes += 1;
			await options.onProbe?.();
			return Response.json({ usage: { prompt_tokens: 120, completion_tokens: 0, total_tokens: 120 } });
		});
		return () => probes;
	}

	it('adds the ledger column and the retention index to storage that predates them', () => {
		database.exec(`
			CREATE TABLE loop_messages (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				position INTEGER NOT NULL,
				run_id TEXT NOT NULL,
				role TEXT NOT NULL,
				message_json TEXT NOT NULL,
				origin TEXT NOT NULL,
				status TEXT,
				token_estimate INTEGER NOT NULL,
				compacted_by INTEGER,
				created_at TEXT NOT NULL
			);
		`);

		construct();

		expect(columnNames('loop_messages')).toContain('ledger_pruned_at');
		expect(indexNames('loop_messages')).toContain('loop_messages_retention');
	});

	it('prunes expired loop history and injections through the internal retention route', async () => {
		const runtime = construct();
		insertMessage(1, { createdAt: daysAgo(20), compactedBy: 10 });
		insertMessage(10, { createdAt: daysAgo(20), origin: 'compaction' });
		insertMessage(11, { createdAt: daysAgo(400) });
		insertInjection('stale-spotlight', { kind: 'spotlight', createdAt: daysAgo(20) });
		insertInjection('fresh-manual', { kind: 'manual', createdAt: daysAgo(20) });

		const response = await maintenanceRequest(runtime, 'POST', 'retention');

		expect(response.status).toBe(200);
		const retention = ((await response.json()) as { data: { retention: RuntimeStorageRetentionResult } }).data.retention;
		expect(retention).toMatchObject({
			loopMessages: { deletedMessages: 1, stampedSummaries: 1, pendingMore: false },
			injections: { deletedInjections: 1, droppedQueueEntries: 0 },
		});
		// A drained backlog is bounded by neither the allowance nor the clock, so the
		// budget indicator stays absent.
		expect(retention).not.toHaveProperty('timeBudgetExhausted');
		// The 400-day-old row is still active context, so retention leaves it.
		expect(rows<{ seq: number }>(`SELECT seq FROM loop_messages ORDER BY seq ASC`).map((row) => row.seq)).toEqual([10, 11]);
		expect(rows<{ id: string }>(`SELECT id FROM injections`).map((row) => row.id)).toEqual(['fresh-manual']);
	});

	it('answers a sweep visit its time budget stopped with the batches it completed', async () => {
		// Two batches' worth of budget, and four batches' worth of expired history:
		// the visit has to return what it deleted rather than run to the caller's
		// dispatch timeout with a transaction still open.
		const clock = batchYieldClock(sweepRetentionTimeBudgetMs / 2);
		const runtime = construct();
		for (const seq of range(1, 4 * loopMessageRetentionBatchSize)) {
			insertMessage(seq, { createdAt: daysAgo(200), deletedAt: daysAgo(190) });
		}

		const response = await maintenanceRequest(runtime, 'POST', 'retention');

		expect(response.status).toBe(200);
		expect(((await response.json()) as { data: { retention: RuntimeStorageRetentionResult } }).data.retention).toMatchObject({
			loopMessages: { deletedMessages: 2 * loopMessageRetentionBatchSize, pendingMore: true },
			timeBudgetExhausted: true,
		});
		// Two yields, because the third batch is the one whose clock reading is past
		// the budget: the deployed runtime advances the clock nowhere else.
		expect(clock.yields()).toBe(2);
		// The completed batches committed: a truncated visit is partial progress the
		// next cycle continues, not work the sweep has to redo.
		expect(rows<{ count: number }>(`SELECT COUNT(*) AS count FROM loop_messages`)[0]?.count)
			.toBe(2 * loopMessageRetentionBatchSize);
	});

	it('stops a sweep visit that a full clear lands in the middle of', async () => {
		// The batches yield to each other, so a clear really can arrive mid-visit.
		// It sets the tombstone before its first await, which is why checking it at
		// the batch boundary is enough to keep the pass off erased storage.
		const runtime = construct();
		const clock = batchYieldClock(0, () => {
			if (clock.yields() === 2) {
				(runtime as unknown as { runtimeStorageClearedAt: string | null }).runtimeStorageClearedAt = now.toISOString();
			}
		});
		for (const seq of range(1, 4 * loopMessageRetentionBatchSize)) {
			insertMessage(seq, { createdAt: daysAgo(200), deletedAt: daysAgo(190) });
		}

		const response = await maintenanceRequest(runtime, 'POST', 'retention');

		expect(response.status).toBe(200);
		expect(((await response.json()) as { data: { retention: RuntimeStorageRetentionResult } }).data.retention).toMatchObject({
			loopMessages: { deletedMessages: 2 * loopMessageRetentionBatchSize, pendingMore: true },
		});
		// The pass stopped at the boundary rather than running its allowance out
		// against storage that is about to be dropped, and kept what it committed.
		expect(clock.yields()).toBe(2);
		expect(rows<{ count: number }>(`SELECT COUNT(*) AS count FROM loop_messages`)[0]?.count)
			.toBe(2 * loopMessageRetentionBatchSize);
	});

	it('resumes the next visit where the budget stopped the scan, and deletes what was behind the prefix', async () => {
		// The prefix is 500 expired summaries their live children hold in place, which
		// is two full batches of candidates the pass cannot delete — more than one
		// budget can traverse. Selection is deterministic, so without a position that
		// outlives the pass every nightly visit would re-walk exactly this prefix and
		// the 100 deletable rows behind it would never be reached at all.
		const clock = batchYieldClock(sweepRetentionTimeBudgetMs / 2);
		const runtime = construct();
		for (const seq of range(1, 2 * loopMessageRetentionBatchSize)) {
			insertMessage(seq, { createdAt: daysAgo(200), compactedBy: 9_000, origin: 'compaction' });
			insertMessage(10_000 + seq, { createdAt: daysAgo(1), compactedBy: seq });
		}
		for (const seq of range(5_001, 5_100)) {
			insertMessage(seq, { createdAt: daysAgo(150), deletedAt: daysAgo(150) });
		}

		const truncated = await retentionVisit(runtime);

		expect(truncated).toMatchObject({
			loopMessages: { deletedMessages: 0, pendingMore: true },
			timeBudgetExhausted: true,
		});
		expect(clock.yields()).toBe(2);
		// The position the two batches reached, persisted outside their transactions.
		expect(scanCursorState()).toEqual({ createdAt: daysAgo(200), seq: 2 * loopMessageRetentionBatchSize });

		// A fresh instance over the same storage: the next nightly visit, which the
		// object has been evicted between.
		const resumed = await retentionVisit(construct());

		// Same clock, same budget, and the prefix has not changed — the only reason
		// this visit reaches the rows behind it is the cursor it started from.
		expect(resumed).toMatchObject({ loopMessages: { deletedMessages: 100 } });
		expect(resumed).not.toHaveProperty('timeBudgetExhausted');
		// The prefix and its children stand; only the rows behind them are gone.
		expect(liveSeqs().filter((seq) => seq >= 5_001 && seq <= 5_100)).toEqual([]);
		expect(liveSeqs()).toHaveLength(4 * loopMessageRetentionBatchSize);
		// Its scan ran to the end of the range, so the position is dropped: the visit
		// after this one goes back to the bottom and re-examines the withheld prefix
		// against children that may have aged out by then.
		expect(scanCursorState()).toBeUndefined();
	});

	it('drops the persisted position when a pass finishes its scan, so the visit after it wraps', async () => {
		const runtime = construct();
		// The position a previous night's truncated pass left behind.
		database.prepare(`INSERT INTO runtime_state (key, value_json) VALUES ('sweep_retention_scan_cursor', ?)`)
			.run(JSON.stringify({ createdAt: daysAgo(200), seq: 500 }));
		// One expired row below that position — the shape of a row that became
		// deletable after the cursor had already moved past it — and ten above.
		insertMessage(1, { createdAt: daysAgo(300), deletedAt: daysAgo(300) });
		for (const seq of range(5_001, 5_010)) {
			insertMessage(seq, { createdAt: daysAgo(150), deletedAt: daysAgo(150) });
		}

		const resumed = await retentionVisit(runtime);

		// The pass started at the cursor, so the row below it is untouched and the ten
		// above it are gone.
		expect(resumed).toMatchObject({ loopMessages: { deletedMessages: 10, pendingMore: false } });
		expect(liveSeqs()).toEqual([1]);
		expect(scanCursorState()).toBeUndefined();

		const wrapped = await retentionVisit(construct());

		// With nothing persisted the scan is back at the bottom, which is the only
		// thing that ever reaches a row below a cursor. Same accepted semantics as
		// the fleet sweep's own walk: below-cursor work waits for the wrap.
		expect(wrapped).toMatchObject({ loopMessages: { deletedMessages: 1 } });
		expect(liveSeqs()).toEqual([]);
	});

	it('keeps the post-visit pass at a single batch with no budget of its own', () => {
		const runtime = construct();
		for (const seq of range(1, 4 * loopMessageRetentionBatchSize)) {
			insertMessage(seq, { createdAt: daysAgo(200), deletedAt: daysAgo(190) });
		}

		const pruned = (runtime as unknown as {
			pruneRuntimeStorageAfterTick(activeRunId: string, now?: Date): RuntimeStorageRetentionResult;
		}).pruneRuntimeStorageAfterTick('run-1');

		// The visit path runs after every completed run, so it stays one batch with
		// the rest left pending: spending a whole allowance is the sweep's job.
		expect(pruned.loopMessages).toMatchObject({ deletedMessages: loopMessageRetentionBatchSize, pendingMore: true });
		expect(pruned).not.toHaveProperty('timeBudgetExhausted');
		expect(rows<{ count: number }>(`SELECT COUNT(*) AS count FROM loop_messages`)[0]?.count)
			.toBe(3 * loopMessageRetentionBatchSize);
	});

	it('clears every table the runtime schema declares', async () => {
		const runtime = construct();
		insertMessage(1, { createdAt: daysAgo(1) });
		insertInjection('pending', { kind: 'manual', createdAt: daysAgo(1) });
		database.prepare(
			`INSERT INTO events (run_id, type, payload_json, token_estimate, compacted_by, created_at)
			 VALUES ('run-1', 'input', '{}', 1, NULL, ?)`,
		).run(daysAgo(1));
		database.prepare(`INSERT INTO runtime_state (key, value_json) VALUES ('last_log_off_seq', '1')`).run();
		database.prepare(
			`INSERT INTO provider_usage (
				run_id, request_seq, requested_model, model, context_window_tokens, provider_base_url,
				prompt_tokens, completion_tokens, total_tokens, usage_json, created_at
			) VALUES ('run-1', 1, 'model', 'model', 1000, 'https://provider.invalid', 1, 1, 2, '{}', ?)`,
		).run(daysAgo(1));
		database.prepare(
			`INSERT INTO inference_submissions (
				id, event_seq, run_id, purpose, model, provider_base_url, message_count, messages_json, created_at
			) VALUES ('sub-1', 1, 'run-1', 'loop', 'model', 'https://provider.invalid', 1, '[]', ?)`,
		).run(daysAgo(1));
		database.prepare(
			`INSERT INTO provider_token_calibration_samples (
				run_id, request_seq, attempt, purpose, requested_model, provider_base_url,
				prompt_tokens, request_characters, created_at
			) VALUES ('run-1', 1, 1, 'loop', 'model', 'https://provider.invalid', 10, 40, ?)`,
		).run(daysAgo(1));

		const response = await maintenanceRequest(runtime, 'DELETE', 'storage');

		expect(response.status).toBe(200);
		const body = await response.json() as {
			data: { cleared: { deletedRowsByTable: Record<string, number>; deletedRows: number; clearedAt: string } };
		};
		// The clear is derived from the schema, so it must account for every table
		// the schema created — a table added later cannot be left behind.
		expect(Object.keys(body.data.cleared.deletedRowsByTable).sort()).toEqual(tableNames().sort());
		expect(body.data.cleared.deletedRows).toBeGreaterThan(0);
		for (const table of tableNames()) {
			// The cleared tombstone is the one row the rebuilt storage keeps: it is
			// what the object itself remembers about the clear.
			expect(rows<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)[0]?.count).toBe(table === 'runtime_state' ? 1 : 0);
		}
		expect(rows<{ key: string; value_json: string }>(`SELECT key, value_json FROM runtime_state`)).toEqual([
			{ key: 'runtime_storage_cleared_at', value_json: JSON.stringify(body.data.cleared.clearedAt) },
		]);
		// The clear drops the database itself, so the empty schema — columns and
		// indexes — has to come back for this instance to keep working.
		expect(columnNames('loop_messages')).toContain('ledger_pruned_at');
		expect(indexNames('loop_messages')).toContain('loop_messages_retention');
		expect(indexNames('injections')).toContain('injections_spotlight');
	});

	it('refuses an injection that was already in flight when the clear ran', async () => {
		// The real race: the request passed its ownership guard before the clear and
		// resumes after it, with `bot_runtime_index.runtime_storage_cleared_at`
		// already stamped. Anything it writes now recreates storage no later sweep
		// will ever look at again. The ownership lookup is the await it parks on.
		const reachedOwnerLookup = deferred<void>();
		const releaseOwnerLookup = deferred<void>();
		const runtime = construct({
			onOwnerLookup: async () => {
				reachedOwnerLookup.resolve();
				await releaseOwnerLookup.promise;
			},
		});

		const injection = ownerInjection(runtime, 'thought from before the clear');
		await reachedOwnerLookup.promise;
		const clear = await maintenanceRequest(runtime, 'DELETE', 'storage');
		expect(clear.status).toBe(200);
		releaseOwnerLookup.resolve();

		const response = await injection;

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			ok: false,
			error: 'conflict',
			details: { runtimeStorageCause: 'storage_cleared' },
		});
		expect(rows<{ count: number }>(`SELECT COUNT(*) AS count FROM injections`)[0]?.count).toBe(0);
		expect(rows<{ count: number }>(`SELECT COUNT(*) AS count FROM events`)[0]?.count).toBe(0);
		expect(clearedTombstones()).toHaveLength(1);
	});

	it('refuses an injection from a monitor socket opened before the clear, and closes it', async () => {
		const runtime = construct();
		const socket = fakeSocket();
		sockets.push(socket);

		expect((await maintenanceRequest(runtime, 'DELETE', 'storage')).status).toBe(200);

		// The clear tells the client before the refusal ever has to: the socket is
		// notified and closed rather than left holding a writable-looking handle.
		expect(socket.sent.map((message) => (JSON.parse(message) as { type: string }).type)).toEqual(['history_cleared']);
		expect(socket.closes).toEqual([{ code: 1001, reason: 'Runtime storage was erased.' }]);

		// A frame already in flight still arrives on a socket the close has not
		// reached yet, so the refusal — not the close — is what protects storage.
		socket.sent.length = 0;
		await runtime.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: 'inject', text: 'late thought' }));

		expect(socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>)).toEqual([
			expect.objectContaining({ type: 'error', code: 'conflict', runtimeStorageCause: 'storage_cleared' }),
		]);
		expect(rows<{ count: number }>(`SELECT COUNT(*) AS count FROM injections`)[0]?.count).toBe(0);
		expect(clearedTombstones()).toHaveLength(1);
	});

	it('caches the probed token counts while storage is live', async () => {
		const probeCount = stubTokenProbes();

		const response = await ownerContextBudget(construct(), 'Persona under test');

		expect(response.status).toBe(200);
		expect(probeCount()).toBe(3);
		// The counted probes are what the cache row is for, and its presence here is
		// what makes its absence after a clear meaningful.
		expect(rows<{ key: string }>(`SELECT key FROM runtime_state`).map((row) => row.key)).toContainEqual(
			expect.stringMatching(/^context_budget:/),
		);
	});

	it('refuses a context-budget computation that was in flight when the clear ran', async () => {
		// Unlike the injection above, this request parks on the provider itself:
		// three token probes, each a network round trip, between its own guards and
		// the write that caches their counts. The cache lives in `runtime_state`, so
		// writing it after the clear recreates storage the sweep will never revisit.
		const reachedProbe = deferred<void>();
		const releaseProbe = deferred<void>();
		const probeCount = stubTokenProbes({
			onProbe: async () => {
				reachedProbe.resolve();
				await releaseProbe.promise;
			},
		});
		const runtime = construct();

		const budget = ownerContextBudget(runtime, 'Persona from before the clear');
		await reachedProbe.promise;
		expect((await maintenanceRequest(runtime, 'DELETE', 'storage')).status).toBe(200);
		releaseProbe.resolve();

		const response = await budget;

		// The probes did run: the refusal comes from the check at the write, which is
		// the only one the clear can land behind.
		expect(probeCount()).toBeGreaterThan(0);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			ok: false,
			error: 'conflict',
			details: { runtimeStorageCause: 'storage_cleared' },
		});
		expect(rows<{ key: string }>(`SELECT key FROM runtime_state`).map((row) => row.key)).toEqual(['runtime_storage_cleared_at']);
	});

	it('refuses a context-budget computation after the clear without paying for probes', async () => {
		const runtime = construct();
		expect((await maintenanceRequest(runtime, 'DELETE', 'storage')).status).toBe(200);
		const probeCount = stubTokenProbes();

		const response = await ownerContextBudget(runtime, 'Persona after the clear');

		expect(response.status).toBe(409);
		expect(probeCount()).toBe(0);
	});

	it('runs an empty retention pass on cleared storage instead of stamping its marker', async () => {
		const runtime = construct();
		expect((await maintenanceRequest(runtime, 'DELETE', 'storage')).status).toBe(200);

		// The sweep can still reach a participant cleared after its chunk was picked,
		// so the pass answers rather than conflicts — but the log-off sequence it
		// memoizes on first use would be a repopulating write of its own.
		const response = await maintenanceRequest(runtime, 'POST', 'retention');

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { retention: { events: 0, providerUsage: 0, loopMessages: { deletedMessages: 0 }, injections: { deletedInjections: 0 } } },
		});
		expect(rows<{ key: string }>(`SELECT key FROM runtime_state`).map((row) => row.key)).toEqual(['runtime_storage_cleared_at']);
	});

	it('refuses a visit and a deferred spotlight after the clear', async () => {
		const runtime = construct();
		expect((await maintenanceRequest(runtime, 'DELETE', 'storage')).status).toBe(200);

		for (const body of [{}, { mode: 'spotlight', deferred: true, spotlightId: 'spot-1', injectionIds: ['inj-1'] }]) {
			const headers = new Headers({ 'x-bickr-scheduler': '1', 'content-type': 'application/json' });
			addInternalServiceAuthHeader(headers, internalServiceSecret);
			const response = await runtime.fetch(new Request(internalServiceUrl(`/bots/${botId}/tick`), {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			}));
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ error: 'conflict', details: { runtimeStorageCause: 'storage_cleared' } });
		}
		// The spotlight queue lives in runtime_state, so a queued visit would be a
		// repopulating write of its own.
		expect(rows<{ key: string }>(`SELECT key FROM runtime_state`).map((row) => row.key)).toEqual(['runtime_storage_cleared_at']);
	});

	it('survives a restart of the object: the tombstone outlives the instance', async () => {
		expect((await maintenanceRequest(construct(), 'DELETE', 'storage')).status).toBe(200);

		// A fresh instance rebuilds from the same storage, which is what a real
		// eviction between the clear and a late write looks like.
		const response = await ownerInjection(construct(), 'thought after a restart');

		expect(response.status).toBe(409);
		expect(rows<{ count: number }>(`SELECT COUNT(*) AS count FROM injections`)[0]?.count).toBe(0);
		// The rebuild runs the startup migrations again, and each one stamps a "done"
		// marker even when it migrates nothing. On erased storage that is one more
		// way to write rows back, for data that cannot exist any more.
		expect(rows<{ key: string }>(`SELECT key FROM runtime_state`).map((row) => row.key)).toEqual(['runtime_storage_cleared_at']);
	});

	it('still accepts a repeated clear so the sweep can retry one it could not confirm', async () => {
		const runtime = construct();
		expect((await maintenanceRequest(runtime, 'DELETE', 'storage')).status).toBe(200);

		const repeated = await maintenanceRequest(runtime, 'DELETE', 'storage');

		expect(repeated.status).toBe(200);
		expect(await repeated.json()).toMatchObject({ data: { cleared: { deletedRows: 1 } } });
		expect(clearedTombstones()).toHaveLength(1);
	});

	it('refuses the maintenance routes for a request made on an owner’s behalf', async () => {
		const runtime = construct();
		insertMessage(1, { createdAt: daysAgo(20), compactedBy: 10 });

		for (const [method, path] of [['POST', 'retention'], ['DELETE', 'storage']] as const) {
			const response = await maintenanceRequest(runtime, method, path, false);
			expect(response.status).toBe(403);
		}
		expect(rows<{ count: number }>(`SELECT COUNT(*) AS count FROM loop_messages`)[0]?.count).toBe(1);
	});

	function insertMessage(
		seq: number,
		options: { createdAt: string; compactedBy?: number; origin?: string; deletedAt?: string },
	): void {
		database.prepare(
			`INSERT INTO loop_messages (
				seq, position, run_id, role, message_json, origin, status, token_estimate,
				stream_seq, display_event_seq, compacted_by, deleted_at, ledger_pruned_at, created_at
			) VALUES (?, ?, 'run-1', 'user', ?, ?, 'complete', 1, NULL, NULL, ?, ?, NULL, ?)`,
		).run(
			seq,
			seq,
			JSON.stringify({ role: 'user', content: `message ${seq}` }),
			options.origin ?? 'input',
			options.compactedBy ?? null,
			options.deletedAt ?? null,
			options.createdAt,
		);
	}

	/** The sweep's retention route, unwrapped to the result it reports. */
	async function retentionVisit(runtime: BotRuntime): Promise<RuntimeStorageRetentionResult> {
		const response = await maintenanceRequest(runtime, 'POST', 'retention');
		expect(response.status).toBe(200);
		return ((await response.json()) as { data: { retention: RuntimeStorageRetentionResult } }).data.retention;
	}

	function scanCursorState(): unknown {
		const row = rows<{ value_json: string }>(`SELECT value_json FROM runtime_state WHERE key = 'sweep_retention_scan_cursor'`)[0];
		return row === undefined ? undefined : JSON.parse(row.value_json);
	}

	function liveSeqs(): number[] {
		return rows<{ seq: number }>(`SELECT seq FROM loop_messages ORDER BY seq ASC`).map((row) => row.seq);
	}

	function insertInjection(id: string, options: { kind: string; createdAt: string }): void {
		database.prepare(
			`INSERT INTO injections (id, text, kind, source_id, spotlight_id, created_at, consumed_at)
			 VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
		).run(id, `thought ${id}`, options.kind, options.kind === 'spotlight' ? `spot-${id}` : null, options.createdAt);
	}

	function range(start: number, end: number): number[] {
		return Array.from({ length: end - start + 1 }, (_, index) => start + index);
	}

	/**
	 * A clock that only moves where the deployed runtime's does.
	 *
	 * Workers reports the time of the last I/O, so inside the retention pass the
	 * only thing that advances `Date.now()` is the timer the batch loop yields on.
	 * Driving the fake clock from that same timer is what keeps this test about a
	 * mechanism production has rather than one only a mock can exhibit.
	 */
	function batchYieldClock(perBatchMs: number, onYield?: () => void): { yields: () => number } {
		let yields = 0;
		let elapsedMs = 0;
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(Date, 'now').mockImplementation(() => now.getTime() + elapsedMs);
		vi.stubGlobal('setTimeout', function stubbedSetTimeout(this: unknown, ...args: unknown[]): unknown {
			// Only the batch loop's own zero-delay yield: anything else scheduled
			// while the request is in flight is not an I/O this pass performed.
			if (args[1] === 0) {
				yields += 1;
				elapsedMs += perBatchMs;
				onYield?.();
			}
			return (realSetTimeout as unknown as (...passed: unknown[]) => unknown).apply(this, args);
		} as unknown as typeof setTimeout);
		return { yields: () => yields };
	}

	function rows<T>(sql: string, ...bindings: SQLInputValue[]): T[] {
		return database.prepare(sql).all(...bindings) as T[];
	}

	function clearedTombstones(): Array<{ value_json: string }> {
		return rows<{ value_json: string }>(`SELECT value_json FROM runtime_state WHERE key = 'runtime_storage_cleared_at'`);
	}

	function tableNames(): string[] {
		return rows<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
			.map((row) => row.name);
	}

	function columnNames(table: string): string[] {
		return rows<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name);
	}

	function indexNames(table: string): string[] {
		return rows<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`, table)
			.map((row) => row.name);
	}
});

type FakeSocket = {
	readyState: number;
	sent: string[];
	closes: Array<{ code: number; reason: string }>;
	send(data: string): void;
	close(code: number, reason: string): void;
};

function fakeSocket(): FakeSocket {
	const socket: FakeSocket = {
		readyState: 1,
		sent: [],
		closes: [],
		send(data: string): void {
			socket.sent.push(data);
		},
		close(code: number, reason: string): void {
			socket.closes.push({ code, reason });
			socket.readyState = 3;
		},
	};
	return socket;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function runtimeState(database: DatabaseSync, sockets: FakeSocket[] = []) {
	const sql = {
		exec<T>(query: string, ...bindings: unknown[]) {
			const statement = database.prepare(query);
			const results = statement.all(...(bindings as SQLInputValue[])) as T[];
			return {
				one: (): T => {
					if (results.length !== 1) {
						throw new Error(`Expected exactly one SQLite row, received ${results.length}.`);
					}
					return results[0] as T;
				},
				toArray: (): T[] => results,
			};
		},
	};
	return {
		storage: {
			sql,
			transactionSync<T>(closure: () => T): T {
				database.exec('BEGIN');
				try {
					const result = closure();
					database.exec('COMMIT');
					return result;
				} catch (error) {
					database.exec('ROLLBACK');
					throw error;
				}
			},
			// Stands in for the real deleteAll, which drops the object's private
			// SQLite database outright — tables included, not just their rows.
			async deleteAll(): Promise<void> {
				const objects = database
					.prepare(`SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
					.all() as Array<{ type: string; name: string }>;
				for (const object of objects.filter((candidate) => candidate.type === 'index')) {
					database.exec(`DROP INDEX IF EXISTS ${object.name}`);
				}
				for (const object of objects.filter((candidate) => candidate.type === 'table')) {
					database.exec(`DROP TABLE IF EXISTS ${object.name}`);
				}
			},
		},
		async blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T> {
			return await closure();
		},
		getWebSockets(): FakeSocket[] {
			return sockets;
		},
		waitUntil(): void {},
	} as unknown as DurableObjectState;
}

function runtimeEnv(botId: string, options: { onOwnerLookup?: () => Promise<void> } = {}) {
	return {
		INTERNAL_SERVICE_SECRET: internalServiceSecret,
		// A custom provider base URL, so the context-budget routes reach their token
		// probes — which the tests that need them answer with a stubbed fetch.
		OPENROUTER_BASE_URL: 'https://provider.test/v1',
		OPENROUTER_API_KEY: 'test-provider-key',
		OPENROUTER_MODEL: 'test/model',
		BICKR_KV: runtimeKv(botId),
		BICKR_D1: {
			prepare(query: string) {
				const statement = {
					bind: () => statement,
					async first<T>() {
						if (query.includes('FROM maintenance_control')) {
							return {
								enabled: 0,
								message: 'Bickr is briefly offline for maintenance.',
								activatedAt: null,
								updatedAt: '2026-08-17T00:00:00.000Z',
							} as T;
						}
						if (query.includes('FROM bots_index')) {
							// The owner check is the last await before an injection writes,
							// which makes it the point a racing request parks on.
							await options.onOwnerLookup?.();
							return { ownerUserId: 'usr-owner' } as T;
						}
						// No runtime index row: the object is idle, which is what the
						// maintenance gate needs to admit a clear.
						return null as T;
					},
					async all<T>() {
						return { success: true, results: [] as T[] };
					},
					async run() {
						return { success: true };
					},
				};
				return statement;
			},
		},
	};
}

/** The participant and its owner, which the context-budget routes load per call. */
function runtimeKv(botId: string): KVNamespaceLike {
	const owner: UserDocument = {
		id: 'usr-owner',
		type: 'user',
		schemaVersion: 1,
		revision: 1,
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-01T00:00:00.000Z',
		handle: 'owner',
		language: null,
		displayName: { lang: null, text: 'Owner' },
		inferenceSettings: {},
	};
	const bot: BotDocument = {
		id: botId,
		type: 'bot',
		schemaVersion: 1,
		revision: 1,
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-01T00:00:00.000Z',
		homeWorldId: 'wld-retention',
		homeWorldHandle: 'retention-world',
		ownerUserId: owner.id,
		handle: 'participant',
		language: null,
		includeLanguageInSystemPrompt: false,
		displayName: { lang: null, text: 'Participant' },
		shortBio: { lang: null, text: 'Short bio' },
		prompt: { lang: null, text: 'Persona' },
		inferenceSettings: {},
		toolSettings: {},
		tickSettings: { enabled: true, intervalSeconds: 60, allowEarlyLogOff: true, compactionThreshold: 0.75 },
	};
	const documents = new Map<string, unknown>([
		[kvKeys.bot(bot.id), bot],
		[kvKeys.user(owner.id), owner],
	]);
	return {
		async get(key: string): Promise<unknown> {
			return documents.get(key) ?? null;
		},
		async put(): Promise<void> {},
		async delete(): Promise<void> {},
	};
}
