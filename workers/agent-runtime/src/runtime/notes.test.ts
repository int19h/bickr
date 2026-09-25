import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractCanonicalEntityReferences } from '@bickr/shared/mentions';
import { BotNotesStore, maxNotesPerBot, normalizeNoteId, noteContent, noteFilterReferences } from './notes';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';

describe('private bot notes', () => {
	let storage: RuntimeTestStorage;
	let notes: BotNotesStore;

	beforeEach(() => {
		storage = createRuntimeTestStorage();
		storage.database.exec(`
			CREATE TABLE notes (note_id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
			CREATE TABLE note_links (note_id TEXT NOT NULL, entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, handle TEXT NOT NULL,
				PRIMARY KEY (note_id, entity_kind, entity_id));
			CREATE INDEX note_links_entity ON note_links (entity_kind, entity_id, note_id);
		`);
		notes = new BotNotesStore(storage);
	});

	afterEach(() => storage.database.close());

	it('keeps replacement and deletion consistent with entity links', () => {
		const alice = { kind: 'participant' as const, entityId: 'bot-alice', handle: 'alice' };
		const forum = { kind: 'forum' as const, entityId: 'forum-news', handle: 'news' };
		expect(notes.write('meeting', 'Saw u/alice in f/news', [alice, forum]).kind).toBe('created');
		expect(notes.idsForEntity('participant', alice.entityId)).toEqual({ ids: ['meeting'], total: 1 });
		expect(notes.list(null, 50, [forum]).ids).toEqual(['meeting']);

		expect(notes.write('meeting', 'A new subject', []).kind).toBe('replaced');
		expect(notes.read('meeting')?.links).toEqual([]);
		expect(notes.idsForEntity('participant', alice.entityId)).toEqual({ ids: [], total: 0 });
		expect(notes.list(null, 50, [forum]).ids).toEqual([]);

		notes.delete('meeting');
		expect(notes.read('meeting')).toBeNull();
		expect(notes.allIds()).toEqual([]);
	});

	it('uses keyset pagination and returns every associated ID', () => {
		const alice = { kind: 'participant' as const, entityId: 'bot-alice', handle: 'alice' };
		for (let index = 0; index < 25; index += 1) notes.write(`note-${String(index).padStart(2, '0')}`, 'u/alice', [alice]);
		const first = notes.list(null, 10);
		expect(first).toMatchObject({ total: 25, nextCursor: 'note-09' });
		expect(notes.list(first.nextCursor, 10).ids).toEqual(Array.from({ length: 10 }, (_, index) => `note-${index + 10}`));
		expect(notes.idsForEntity('participant', alice.entityId).ids).toHaveLength(25);
	});

	it('enforces the write limit without changing existing notes', () => {
		for (let index = 0; index < maxNotesPerBot; index += 1) notes.write(`n-${index}`, 'initial', []);
		expect(() => notes.write('extra', 'content', [])).toThrow(`at most ${maxNotesPerBot} notes`);
		expect(notes.write('n-0', 'replacement', []).kind).toBe('replaced');
		expect(notes.allIds()).toHaveLength(maxNotesPerBot);
	});

	it('accepts note IDs longer than profile handles and validates note content', () => {
		expect(normalizeNoteId('A'.repeat(64))).toBe('a'.repeat(64));
		expect(() => normalizeNoteId('a'.repeat(65))).toThrow();
		expect(() => noteContent('')).toThrow();
		expect(() => notes.write('valid', '', [])).toThrow();
	});

	it('finds canonical references without treating a URL or an at-mention as a link', () => {
		expect(extractCanonicalEntityReferences('u/Alice, f/news, @bob and https://site.test/u/carol')).toEqual([
			{ kind: 'participant', handle: 'alice' },
			{ kind: 'forum', handle: 'news' },
		]);
		expect(noteFilterReferences(['u/Alice', 'f/news'])).toEqual([
			{ kind: 'participant', handle: 'alice' },
			{ kind: 'forum', handle: 'news' },
		]);
		expect(() => noteFilterReferences(['@alice'])).toThrow();
	});
});
