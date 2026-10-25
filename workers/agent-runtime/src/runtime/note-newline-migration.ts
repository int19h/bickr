import { RepositoryError } from '@bickr/shared/repository';
import { estimateLoopMessageTokens } from './loop-message-tokens';
import { InputError } from '@bickr/shared/validation';
import type { ChatMessage } from '../types';
import { maxNotesPerBot } from './notes';
import { repairNoteMessage, repairNoteNewlines } from './note-newline-repair';

type Storage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;
type NoteRow = { note_id: string; content: string; revision: number };
type MessageRow = { seq: number; message_json: string; token_estimate: number };
type NoteChange = { id: string; revision: number; before: string; after: string; replacements: number };
type MessageChange = { seq: number; before: string; after: string; tokenEstimateBefore: number; replacements: number };

// Retention: one completion record per runtime. Remove this module, route and
// marker after the fleet census completes and this release leaves rollback use.
export const noteNewlineMigrationKey = 'note_newlines_migration_v1';
const maximumActiveMessages = 2_000;
const maximumSnapshotBytes = 8_000_000;

export type NoteNewlineMigrationPlan = {
	kind: 'ready'; schemaVersion: 1; digest: string;
	notesExamined: number; activeMessagesExamined: number;
	ambiguousNotes: string[]; ambiguousMessages: number[];
	ambiguousNoteContents: { id: string; content: string }[];
	ambiguousMessageContents: { seq: number; message: ChatMessage; toolName?: string }[];
	notes: NoteChange[]; messages: MessageChange[];
};
type Completion = { schemaVersion: 1; appliedAt: string; notesChanged: number; messagesChanged: number };
type AlreadyApplied = { kind: 'already_applied'; completion: Completion };

/** Exact operator-reviewed exceptions, never a general string-unescape API. */
export function reviewedNoteReplacements(value: unknown): ReadonlyMap<string, string> {
	if (value === undefined) return new Map();
	if (!Array.isArray(value) || value.length > maxNotesPerBot + 1) throw new InputError('Reviewed note replacements must be a bounded array.');
	const result = new Map<string, string>();
	let bytes = 0;
	for (const item of value) {
		if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.before !== 'string' || typeof item.after !== 'string' ||
			item.before === item.after || item.after !== item.before.replace(/(?<!\\)\\n/g, '\n') || result.has(item.before)) {
			throw new InputError('A reviewed replacement can change only literal line breaks in one exact note.');
		}
		bytes += new TextEncoder().encode(item.before).byteLength + new TextEncoder().encode(item.after).byteLength;
		if (bytes > maximumSnapshotBytes / 2) throw new InputError('Reviewed note replacements exceed the size limit.');
		result.set(item.before, item.after);
	}
	return result;
}

function digestInput(serialized: string, reviewed: ReadonlyMap<string, string>): string {
	return JSON.stringify([serialized, [...reviewed].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)]);
}

function completion(storage: Storage): Completion | undefined {
	const row = storage.sql.exec<{ value_json: string }>('SELECT value_json FROM runtime_state WHERE key = ? LIMIT 1', noteNewlineMigrationKey).toArray()[0];
	return row ? JSON.parse(row.value_json) as Completion : undefined;
}

function snapshot(storage: Storage) {
	if (storage.sql.exec<{ key: string }>("SELECT key FROM runtime_state WHERE key IN ('pending_tool_v1', 'pending_tool_v2', 'pending_tool_v3') LIMIT 1").toArray().length) {
		throw new RepositoryError('conflict', 'Resolve the pending tool before repairing notes.', 409, { noteMigrationCause: 'pending_tool' });
	}
	const notes = storage.sql.exec<NoteRow>('SELECT note_id, content, revision FROM notes ORDER BY note_id LIMIT ?', maxNotesPerBot + 2).toArray();
	const messages = storage.sql.exec<MessageRow>(
		'SELECT seq, message_json, token_estimate FROM loop_messages WHERE compacted_by IS NULL AND deleted_at IS NULL ORDER BY position, seq LIMIT ?', maximumActiveMessages + 1,
	).toArray();
	if (notes.length > maxNotesPerBot + 1 || messages.length > maximumActiveMessages) {
		throw new RepositoryError('conflict', 'The note repair exceeds its row limit.', 409, { noteMigrationCause: 'row_limit' });
	}
	const serialized = JSON.stringify({ notes, messages });
	if (new TextEncoder().encode(serialized).byteLength > maximumSnapshotBytes) {
		throw new RepositoryError('conflict', 'The note repair exceeds its size limit.', 409, { noteMigrationCause: 'size_limit' });
	}
	return { notes, messages, serialized };
}

async function digest(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function planChanges(current: ReturnType<typeof snapshot>, reviewed: ReadonlyMap<string, string>): Omit<NoteNewlineMigrationPlan, 'digest'> {
	const notes: NoteChange[] = [];
	const messages: MessageChange[] = [];
	const ambiguousNotes: string[] = [];
	const ambiguousMessages: number[] = [];
	const ambiguousNoteContents: NoteNewlineMigrationPlan['ambiguousNoteContents'] = [];
	const ambiguousMessageContents: NoteNewlineMigrationPlan['ambiguousMessageContents'] = [];
	for (const row of current.notes) {
		const result = repairNoteNewlines(row.content, reviewed);
		if (result.kind === 'ambiguous') { ambiguousNotes.push(row.note_id); ambiguousNoteContents.push({ id: row.note_id, content: row.content }); }
		if (result.kind === 'repaired') notes.push({ id: row.note_id, revision: row.revision, before: row.content, after: result.content, replacements: result.replacements });
	}
	// Tool IDs belong to one assistant group. Reuse in a later group must not
	// turn an unrelated result with id/content fields into a note result.
	const parsed = current.messages.map((row) => ({ row, message: JSON.parse(row.message_json) as ChatMessage }));
	const calls = new Map<string, string>();
	for (const { row, message } of parsed) {
		if (message.role === 'assistant') {
			calls.clear();
			const duplicates = new Set<string>();
			for (const call of message.tool_calls ?? []) {
				if (calls.has(call.id)) duplicates.add(call.id);
				calls.set(call.id, call.function.name);
			}
			for (const id of duplicates) calls.delete(id);
		} else if (message.role !== 'tool') calls.clear();
		const toolName = message.role === 'tool' && message.tool_call_id ? calls.get(message.tool_call_id) : undefined;
		const result = repairNoteMessage(message, toolName, reviewed);
		if (message.role === 'tool' && message.tool_call_id) calls.delete(message.tool_call_id);
		// A group can contain both a repaired note and an uncertain note.
		const remainder = result.kind === 'repaired' ? repairNoteMessage(result.message, toolName, reviewed) : result;
		if (remainder.kind === 'ambiguous') { ambiguousMessages.push(row.seq); ambiguousMessageContents.push({ seq: row.seq, message, ...(toolName ? { toolName } : {}) }); }
		if (result.kind === 'repaired') messages.push({ seq: row.seq, before: row.message_json, after: JSON.stringify(result.message), tokenEstimateBefore: row.token_estimate, replacements: result.replacements });
	}
	return { kind: 'ready', schemaVersion: 1, notesExamined: current.notes.length, activeMessagesExamined: current.messages.length, notes, messages, ambiguousNotes, ambiguousMessages, ambiguousNoteContents, ambiguousMessageContents };
}

/** Internal operator output includes before/after text for a private backup. */
export async function inspectNoteNewlineMigration(storage: Storage, reviewed: ReadonlyMap<string, string> = new Map()): Promise<NoteNewlineMigrationPlan | AlreadyApplied> {
	const done = completion(storage);
	if (done) return { kind: 'already_applied', completion: done };
	const current = snapshot(storage);
	return { ...planChanges(current, reviewed), digest: await digest(digestInput(current.serialized, reviewed)) };
}

/** Call only while the runtime's maintenance gate excludes active inference. */
export async function applyNoteNewlineMigration(storage: Storage, expectedDigest: string, reviewed: ReadonlyMap<string, string> = new Map()) {
	const done = completion(storage);
	if (done) return { kind: 'already_applied' as const, completion: done };
	const current = snapshot(storage);
	if (await digest(digestInput(current.serialized, reviewed)) !== expectedDigest) {
		throw new RepositoryError('conflict', 'The notes changed after inspection. Inspect them again.', 409, { noteMigrationCause: 'snapshot_changed' });
	}
	const plan = planChanges(current, reviewed);
	return storage.transactionSync(() => {
		// Owner edits can arrive across the hash await even with inference gated.
		// Compare the whole snapshot before any write, without an intervening await.
		if (snapshot(storage).serialized !== current.serialized || completion(storage)) {
			throw new RepositoryError('conflict', 'The notes changed after inspection. Inspect them again.', 409, { noteMigrationCause: 'snapshot_changed' });
		}
		const appliedAt = new Date().toISOString();
		for (const note of plan.notes) storage.sql.exec('UPDATE notes SET content = ?, revision = revision + 1, updated_at = ? WHERE note_id = ?', note.after, appliedAt, note.id);
		for (const message of plan.messages) storage.sql.exec('UPDATE loop_messages SET message_json = ?, token_estimate = ? WHERE seq = ?', message.after, estimateLoopMessageTokens(JSON.parse(message.after) as ChatMessage), message.seq);
		const result: Completion = { schemaVersion: 1, appliedAt, notesChanged: plan.notes.length, messagesChanged: plan.messages.length };
		storage.sql.exec('INSERT INTO runtime_state (key, value_json) VALUES (?, ?)', noteNewlineMigrationKey, JSON.stringify(result));
		return { kind: 'applied' as const, completion: result, ambiguousNotes: plan.ambiguousNotes, ambiguousMessages: plan.ambiguousMessages };
	});
}
