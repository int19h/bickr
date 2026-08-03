/// <reference types="node" />

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { RuntimeEventsStorage } from './events';
import type { RuntimeStorage } from './message-store';

export type RuntimeTestStorage = RuntimeStorage & RuntimeEventsStorage & { database: DatabaseSync };

export function createRuntimeTestStorage(): RuntimeTestStorage {
	const database = new DatabaseSync(':memory:');
	database.exec(`
		CREATE TABLE events (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id TEXT NOT NULL,
			type TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			token_estimate INTEGER NOT NULL,
			compacted_by INTEGER,
			created_at TEXT NOT NULL
		);
		CREATE TABLE loop_messages (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			position INTEGER NOT NULL,
			run_id TEXT NOT NULL,
			role TEXT NOT NULL,
			message_json TEXT NOT NULL,
			origin TEXT NOT NULL,
			status TEXT,
			token_estimate INTEGER NOT NULL,
			stream_seq INTEGER,
			display_event_seq INTEGER,
			compacted_by INTEGER,
			deleted_at TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE loop_message_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			message_seq INTEGER NOT NULL,
			kind TEXT NOT NULL,
			encoding TEXT NOT NULL,
			base_log_id INTEGER,
			prefix_length INTEGER,
			text_length INTEGER NOT NULL,
			chunk_count INTEGER NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE loop_message_log_chunks (
			log_id INTEGER NOT NULL,
			chunk_index INTEGER NOT NULL,
			text TEXT NOT NULL,
			PRIMARY KEY (log_id, chunk_index)
		);
		CREATE INDEX loop_messages_diagnostic_retention
			ON loop_messages (origin, seq DESC);
	`);

	const sql = {
		exec<T>(query: string, ...bindings: unknown[]) {
			const rows = database.prepare(query).all(...(bindings as SQLInputValue[])) as T[];
			return {
				one: (): T => {
					if (rows.length !== 1) {
						throw new Error(`Expected exactly one SQLite row, received ${rows.length}.`);
					}
					return rows[0] as T;
				},
				toArray: (): T[] => rows,
			};
		},
	};

	return {
		database,
		sql: sql as RuntimeStorage['sql'],
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
	};
}
