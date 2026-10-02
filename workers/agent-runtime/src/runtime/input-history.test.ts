import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeInputHistory } from './input-history';
import { RuntimeMessageStore } from './message-store';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';

let storage: RuntimeTestStorage;
beforeEach(() => { storage = createRuntimeTestStorage(); });
afterEach(() => storage.database.close());

function input(runId: string): number {
	return storage.sql.exec<{ seq: number }>("INSERT INTO events (run_id,type,payload_json,token_estimate,created_at) VALUES (?, 'input', '{}', 0, '2026-10-02') RETURNING seq", runId).toArray()[0]!.seq;
}

describe('committed input history marker', () => {
	it('retains iteration state after event and message retention, until a later logoff', () => {
		const history = new RuntimeInputHistory(storage);
		const seq = input('run');
		history.commit(seq);
		storage.database.exec('DELETE FROM events; DELETE FROM loop_messages');
		expect(history.startedAfter(0)).toBe(true);
		expect(history.startedAfter(seq)).toBe(false);
	});
	it('initializes once without accepting an uncommitted audit input', () => {
		input('failed');
		const history = new RuntimeInputHistory(storage);
		history.initializeLegacy(0);
		expect(history.startedAfter(0)).toBe(false);
		new RuntimeMessageStore(storage).appendLoopMessageGroup([{ runId: 'failed', origin: 'injection', message: { role: 'assistant', content: 'old fragment' } }]);
		history.initializeLegacy(0);
		expect(history.startedAfter(0)).toBe(false);
	});
	it('converts retained legacy history and ignores later input-only failures', () => {
		const committed = input('success');
		new RuntimeMessageStore(storage).appendLoopMessageGroup([{ runId: 'success', origin: 'synthetic_context', message: { role: 'user', content: 'Opening context' } }]);
		input('failed');
		const history = new RuntimeInputHistory(storage);
		history.initializeLegacy(0);
		expect(history.startedAfter(0)).toBe(true);
		expect(history.startedAfter(committed)).toBe(false);
	});
});
