import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractCanonicalEntityReferences } from '@bickr/shared/mentions';
import { BotNotesStore, maxNotesPerBot, normalizeNoteId, noteContent, noteFilterReferences } from './notes';
import { runtimeSchema } from './bot-runtime';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';

describe('private bot notes', () => {
	let storage: RuntimeTestStorage;
	let notes: BotNotesStore;

	beforeEach(() => {
		storage = createRuntimeTestStorage();
		storage.database.exec(runtimeSchema);
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

	it('combines entity filters without leaking another store', () => {
		const alice = { kind: 'participant' as const, entityId: 'bot-alice', handle: 'alice' };
		const forum = { kind: 'forum' as const, entityId: 'forum-field', handle: 'field' };
		notes.write('person', 'u/alice', [alice]);
		notes.write('place', 'f/field', [forum]);
		notes.write('unlinked', 'plain', []);
		expect(notes.list(null, 50, [alice, forum], ['u/missing'])).toMatchObject({ ids: ['person', 'place'], total: 2, unknownFilters: ['u/missing'] });
		expect(notes.list(null, 50, [], ['u/missing']).ids).toEqual([]);
		const otherStorage = createRuntimeTestStorage();
		try {
			otherStorage.database.exec(runtimeSchema);
			expect(new BotNotesStore(otherStorage).allIds()).toEqual([]);
		} finally {
			otherStorage.database.close();
		}
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
		expect(noteContent('😀'.repeat(4_000))).toBe('😀'.repeat(4_000));
		expect(() => noteContent('😀'.repeat(4_001))).toThrow();
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
		expect(noteFilterReferences(['  u/Ａlice  '])).toEqual([{ kind: 'participant', handle: 'alice' }]);
		expect(() => noteFilterReferences(['@alice'])).toThrow();
	});
});
