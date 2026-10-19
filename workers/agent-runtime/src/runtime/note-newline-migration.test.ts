import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factoryText } from '@bickr/shared/localization';
import { BotRuntime, runtimeSchema } from './bot-runtime';
import { BotNotesStore } from './notes';
import { applyNoteNewlineMigration, inspectNoteNewlineMigration, noteNewlineMigrationKey, reviewedNoteReplacements } from './note-newline-migration';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';

const broken = ['- Read replies.', '- Write a song.', '  - Draft a verse.'].join(String.fromCharCode(92) + 'n');
const fixed = '- Read replies.\n- Write a song.\n  - Draft a verse.';
const text = factoryText('en');

describe('one-off note newline migration', () => {
	let storage: RuntimeTestStorage;
	let notes: BotNotesStore;
	beforeEach(() => {
		storage = createRuntimeTestStorage();
		storage.database.exec(runtimeSchema);
		notes = new BotNotesStore(storage);
	});
	afterEach(() => storage.database.close());
	function message(seq: number, value: object, compacted: number | null = null, deleted: string | null = null) {
		storage.sql.exec('INSERT INTO loop_messages (seq, position, run_id, role, message_json, origin, token_estimate, compacted_by, deleted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			seq, seq, 'run', 'role' in value ? value.role : 'tool', JSON.stringify(value), 'provider', 123, compacted, deleted, '2026-10-19');
	}

	it('backs up exact bytes, repairs notes and correlated active examples once, and preserves audit data', async () => {
		const attribution = { model: 'vendor/model', parameters: {}, source: { botId: 'one', worldHandle: 'primary', botHandle: 'one', runId: 'run', requestSeq: 7 } };
		notes.write('PLAN', broken, [{ kind: 'participant', entityId: 'bot-two', handle: 'two' }], attribution);
		const original = notes.read(text, 'PLAN')!;
		const assistant = { role: 'assistant', reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }], tool_calls: [
			{ id: 'w', type: 'function', function: { name: 'write_note', arguments: JSON.stringify({ id: 'PLAN', content: broken }) } },
			{ id: 'r', type: 'function', function: { name: 'read_note', arguments: '{"id":"PLAN"}' } },
		] };
		message(1, assistant);
		message(2, { role: 'tool', tool_call_id: 'r', content: JSON.stringify({ id: 'PLAN', content: broken, links: [] }) });
		message(3, { role: 'tool', tool_call_id: 'unrelated', content: JSON.stringify({ id: 'PLAN', content: broken }) });
		message(4, assistant, 90);
		message(5, assistant, null, '2026-10-19');
		storage.sql.exec('INSERT INTO events (run_id, type, payload_json, token_estimate, created_at) VALUES (?, ?, ?, ?, ?)', 'run', 'tool_call', JSON.stringify(assistant), 123, '2026-10-19');
		const preview = await inspectNoteNewlineMigration(storage);
		expect(preview.kind).toBe('ready');
		if (preview.kind !== 'ready') throw new Error('Expected plan.');
		expect(preview.notes).toMatchObject([{ id: 'PLAN', revision: 0, before: broken, after: fixed }]);
		expect(preview.messages.map((row) => row.seq)).toEqual([1, 2]);
		expect(notes.read(text, 'PLAN')).toEqual(original);
		const result = await applyNoteNewlineMigration(storage, preview.digest);
		expect(result).toMatchObject({ kind: 'applied', completion: { schemaVersion: 1, notesChanged: 1, messagesChanged: 2 } });
		expect(notes.read(text, 'PLAN')).toMatchObject({ content: fixed, revision: 1, links: original.links, inferenceAttribution: attribution, createdAt: original.createdAt });
		const rows = storage.sql.exec<{ seq: number; message_json: string }>('SELECT seq, message_json FROM loop_messages ORDER BY seq').toArray();
		expect(JSON.parse(rows[0]!.message_json).reasoning_details).toEqual(assistant.reasoning_details);
		expect(rows[2]!.message_json).toContain('unrelated');
		for (const row of rows.slice(3)) expect(row.message_json).toBe(JSON.stringify(assistant));
		expect(storage.sql.exec<{ payload_json: string }>('SELECT payload_json FROM events').one().payload_json).toBe(JSON.stringify(assistant));
		expect(await applyNoteNewlineMigration(storage, preview.digest)).toMatchObject({ kind: 'already_applied' });
		expect(notes.read(text, 'PLAN')?.revision).toBe(1);
	});

	it('rejects an edit after preview without changing notes, history, or the completion marker', async () => {
		notes.write('PLAN', broken, []);
		const preview = await inspectNoteNewlineMigration(storage);
		if (preview.kind !== 'ready') throw new Error('Expected plan.');
		notes.write('PLAN', 'New owner text.', []);
		await expect(applyNoteNewlineMigration(storage, preview.digest)).rejects.toMatchObject({ details: { noteMigrationCause: 'snapshot_changed' } });
		expect(notes.read(text, 'PLAN')?.content).toBe('New owner text.');
		expect(storage.sql.exec('SELECT key FROM runtime_state WHERE key = ?', noteNewlineMigrationKey).toArray()).toEqual([]);
	});

	it('rolls every edit back if the completion write fails', async () => {
		notes.write('PLAN', broken, []);
		const preview = await inspectNoteNewlineMigration(storage);
		if (preview.kind !== 'ready') throw new Error('Expected plan.');
		storage.database.exec(`CREATE TRIGGER reject_stamp BEFORE INSERT ON runtime_state BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
		await expect(applyNoteNewlineMigration(storage, preview.digest)).rejects.toThrow('injected failure');
		expect(notes.read(text, 'PLAN')).toMatchObject({ content: broken, revision: 0 });
	});

	it('scopes tool-result identity to its preceding assistant group and refuses duplicate IDs', async () => {
		const call = (name: string) => ({ id: 'reused', type: 'function', function: { name, arguments: '{"id":"PLAN"}' } });
		const result = { role: 'tool', tool_call_id: 'reused', content: JSON.stringify({ id: 'PLAN', content: broken }) };
		message(1, { role: 'assistant', tool_calls: [call('read_note')] });
		message(2, result);
		message(3, { role: 'assistant', tool_calls: [call('unrelated')] });
		message(4, result);
		message(5, { role: 'assistant', tool_calls: [call('read_note'), call('unrelated')] });
		message(6, result);
		const preview = await inspectNoteNewlineMigration(storage);
		if (preview.kind !== 'ready') throw new Error('Expected plan.');
		expect(preview.messages.map(row => row.seq)).toEqual([2]);
	});

	it.each(['pending_tool_v1', 'pending_tool_v2', 'pending_tool_v3'])('refuses unresolved %s', async (key) => {
		storage.sql.exec('INSERT INTO runtime_state (key, value_json) VALUES (?, ?)', key, '{}');
		await expect(inspectNoteNewlineMigration(storage)).rejects.toMatchObject({ details: { noteMigrationCause: 'pending_tool' } });
	});

	it('binds exact reviewed prose replacements to the digest and exposes uncertain text only for operator review', async () => {
		const before = ['An ordinary paragraph.', 'Another paragraph.'].join(String.fromCharCode(92) + 'n');
		const after = 'An ordinary paragraph.\nAnother paragraph.';
		notes.write('memory', before, []);
		const automatic = await inspectNoteNewlineMigration(storage);
		if (automatic.kind !== 'ready') throw new Error('Expected plan.');
		expect(automatic.ambiguousNoteContents).toEqual([{ id: 'memory', content: before }]);
		const reviewed = reviewedNoteReplacements([{ before, after }]);
		await expect(applyNoteNewlineMigration(storage, automatic.digest, reviewed)).rejects.toMatchObject({ details: { noteMigrationCause: 'snapshot_changed' } });
		const preview = await inspectNoteNewlineMigration(storage, reviewed);
		if (preview.kind !== 'ready') throw new Error('Expected plan.');
		expect(preview.notes).toMatchObject([{ id: 'memory', before, after }]);
		await applyNoteNewlineMigration(storage, preview.digest, reviewed);
		expect(notes.read(text, 'memory')?.content).toBe(after);
	});

	it('refuses arbitrary edits or duplicate replacement inputs at the operator boundary', () => {
		expect(() => reviewedNoteReplacements([{ before: 'Old prose.', after: 'Different prose.' }])).toThrow();
		expect(() => reviewedNoteReplacements([{ before: broken, after: fixed }, { before: broken, after: fixed }])).toThrow();
		expect(() => reviewedNoteReplacements({ before: broken, after: fixed })).toThrow();
		expect(reviewedNoteReplacements([{ before: broken, after: fixed }]).get(broken)).toBe(fixed);
	});

	it('reports an uncertain note even when another call in the same group is repaired', async () => {
		const uncertain = 'First paragraph.' + String.fromCharCode(92) + 'nSecond paragraph.';
		message(1, { role: 'assistant', tool_calls: [broken, uncertain].map((content, index) => ({ id: String(index), type: 'function', function: { name: 'write_note', arguments: JSON.stringify({ id: 'note-' + index, content }) } })) });
		const plan = await inspectNoteNewlineMigration(storage);
		if (plan.kind !== 'ready') throw new Error('Expected plan.');
		expect(plan.messages).toHaveLength(1);
		expect(plan.ambiguousMessages).toEqual([1]);
		expect(plan.ambiguousMessageContents).toHaveLength(1);
	});

	it('routes internal requests through the idle gate and always releases it', async () => {
		const begin = vi.fn(async () => {});
		const finish = vi.fn();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), { state: { storage }, runtimeStorageClearedAt: null,
			beginMaintenanceOperation: begin, finishMaintenanceOperation: finish });
		const request = new Request('https://internal/bots/one/notes/newlines-migration', { method: 'POST', headers: { 'x-bickr-scheduler': '1', 'content-type': 'application/json' }, body: '{"mode":"inspect"}' });
		const response = await runtime.handleRuntimeMutationRequest(request, new URL(request.url), 'one');
		expect(response.status).toBe(200);
		expect(begin).toHaveBeenCalledWith('one', 'note_newlines_migration', expect.any(String));
		expect(finish).toHaveBeenCalledWith('note_newlines_migration');
		const ownerRequest = new Request(request.url, { method: 'POST', body: '{"mode":"inspect"}' });
		await expect(runtime.handleRuntimeMutationRequest(ownerRequest, new URL(request.url), 'one')).rejects.toMatchObject({ status: 403 });
	});
});
