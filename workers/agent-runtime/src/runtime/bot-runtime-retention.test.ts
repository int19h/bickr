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

	beforeEach(() => {
		database = new DatabaseSync(':memory:');
	});

	afterEach(() => database.close());

	function construct(): BotRuntime {
		return new BotRuntime(runtimeState(database), runtimeEnv() as never);
	}

	async function maintenanceRequest(runtime: BotRuntime, method: 'POST' | 'DELETE', path: string, internal = true): Promise<Response> {
		const headers = new Headers(internal ? { 'x-bickr-scheduler': '1' } : { 'x-bickr-user-id': 'usr-owner' });
		addInternalServiceAuthHeader(headers, internalServiceSecret);
		return await runtime.fetch(new Request(internalServiceUrl(`/bots/${botId}/${path}`), { method, headers }));
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
		const body = await response.json() as { data: { cleared: { deletedRowsByTable: Record<string, number>; deletedRows: number } } };
		// The clear is derived from the schema, so it must account for every table
		// the schema created — a table added later cannot be left behind.
		expect(Object.keys(body.data.cleared.deletedRowsByTable).sort()).toEqual(tableNames().sort());
		expect(body.data.cleared.deletedRows).toBeGreaterThan(0);
		for (const table of tableNames()) {
			expect(rows<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)[0]?.count).toBe(0);
		}
		// The clear drops the database itself, so the empty schema — columns and
		// indexes — has to come back for this instance to keep working.
		expect(columnNames('loop_messages')).toContain('ledger_pruned_at');
		expect(indexNames('loop_messages')).toContain('loop_messages_retention');
		expect(indexNames('injections')).toContain('injections_spotlight');
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

function runtimeState(database: DatabaseSync) {
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
		waitUntil(): void {},
	} as unknown as DurableObjectState;
}

function runtimeEnv() {
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
