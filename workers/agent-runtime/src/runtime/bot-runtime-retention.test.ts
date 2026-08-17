/// <reference types="node" />

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addInternalServiceAuthHeader, internalServiceUrl } from '@bickr/shared/internal-service';
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

	afterEach(() => database.close());

	function construct(options: { onOwnerLookup?: () => Promise<void> } = {}): BotRuntime {
		return new BotRuntime(runtimeState(database, sockets), runtimeEnv(options) as never);
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
		expect(await response.json()).toMatchObject({
			data: { retention: {
				loopMessages: { deletedMessages: 1, stampedSummaries: 1 },
				injections: { deletedInjections: 1, droppedQueueEntries: 0 },
			} },
		});
		// The 400-day-old row is still active context, so retention leaves it.
		expect(rows<{ seq: number }>(`SELECT seq FROM loop_messages ORDER BY seq ASC`).map((row) => row.seq)).toEqual([10, 11]);
		expect(rows<{ id: string }>(`SELECT id FROM injections`).map((row) => row.id)).toEqual(['fresh-manual']);
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

	function insertInjection(id: string, options: { kind: string; createdAt: string }): void {
		database.prepare(
			`INSERT INTO injections (id, text, kind, source_id, spotlight_id, created_at, consumed_at)
			 VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
		).run(id, `thought ${id}`, options.kind, options.kind === 'spotlight' ? `spot-${id}` : null, options.createdAt);
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

function runtimeEnv(options: { onOwnerLookup?: () => Promise<void> } = {}) {
	return {
		INTERNAL_SERVICE_SECRET: internalServiceSecret,
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
