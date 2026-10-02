import type { RuntimeStorage } from './message-store';

// One scalar survives event/history retention and is removed by a full clear.
const committedInputKey = 'last_committed_input_seq_v1';

export class RuntimeInputHistory {
	private readonly storage: Pick<RuntimeStorage, 'sql'>;
	constructor(storage: Pick<RuntimeStorage, 'sql'>) { this.storage = storage; }

	startedAfter(eventSeq: number): boolean {
		const row = this.storage.sql.exec<{ value_json: string }>(
			'SELECT value_json FROM runtime_state WHERE key = ?', committedInputKey,
		).toArray()[0];
		return row !== undefined && Number(row.value_json) > eventSeq;
	}

	/** Caller must include this write in the input history transaction. */
	commit(eventSeq: number): void {
		this.storage.sql.exec(`INSERT INTO runtime_state (key, value_json) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, committedInputKey, String(eventSeq));
	}

	/**
	 * One-time startup conversion for runtimes written before commit markers.
	 * An audit input alone is not evidence: retained input history must exist.
	 * Retire after a runtime schema sweep has initialized this versioned key on
	 * every non-erased object, then remove this converter in the next schema version.
	 */
	initializeLegacy(afterLogOffSeq: number): void {
		if (this.storage.sql.exec('SELECT value_json FROM runtime_state WHERE key = ?', committedInputKey).toArray().length) return;
		const input = this.storage.sql.exec<{ seq: number }>(`SELECT events.seq FROM events
			WHERE events.seq > ? AND events.type = 'input'
			  AND EXISTS (SELECT 1 FROM loop_messages WHERE loop_messages.run_id = events.run_id
			    AND origin IN ('input', 'synthetic_context', 'injection', 'reminder'))
			ORDER BY events.seq DESC LIMIT 1`, afterLogOffSeq).toArray()[0];
		this.commit(input?.seq ?? 0);
	}
}
