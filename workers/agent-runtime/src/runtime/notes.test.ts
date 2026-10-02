import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractCanonicalEntityReferences } from '@bickr/shared/mentions';
import { BotNotesStore, defaultPlanContent, maxNotesPerBot, normalizeNoteId, noteContent, noteFilterReferences, noteReferences, planNoteId } from './notes';
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

	it('attributes the current note content and clears attribution after manual replacement, edit, and PLAN reset', () => {
		const attribution = { model: 'vendor/model', parameters: { temperature: 0.4 }, source: { botId: 'bot-a', worldHandle: 'primary', botHandle: 'alice', runId: 'run-a', requestSeq: 7 } };
		notes.write('draft', 'Generated', [], attribution);
		expect(notes.read('draft')?.inferenceAttribution).toEqual(attribution);
		notes.write('draft', 'Manual', []);
		expect(notes.read('draft')).not.toHaveProperty('inferenceAttribution');
		notes.write('draft', 'Generated again', [], attribution);
		notes.edit('draft', 'draft', 'Edited manually', [], 2);
		expect(notes.read('draft')).not.toHaveProperty('inferenceAttribution');
		notes.write(planNoteId, 'Generated PLAN', [], attribution);
		expect(notes.delete(planNoteId)).toMatchObject({ kind: 'reset' });
		expect(notes.read(planNoteId)).not.toHaveProperty('inferenceAttribution');
	});

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

		expect(notes.delete('meeting')).toEqual({ kind: 'deleted' });
		expect(notes.delete('meeting')).toEqual({ kind: 'not_found' });
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
		notes.ensurePlan();
		const alice = { kind: 'participant' as const, entityId: 'bot-alice', handle: 'alice' };
		notes.write(planNoteId, '- Ask u/alice.', [alice]);
		for (let index = 0; index < maxNotesPerBot; index += 1) notes.write(`n-${index}`, 'initial', [alice]);
		expect(() => notes.write('extra', 'content', [])).toThrow(`at most ${maxNotesPerBot} notes`);
		expect(notes.write('n-0', 'replacement', [alice]).kind).toBe('replaced');
		expect(notes.allIds()).toHaveLength(maxNotesPerBot + 1);
		expect(notes.list(null, 50).total).toBe(maxNotesPerBot + 1);
		expect(notes.idsForEntity('participant', alice.entityId).total).toBe(maxNotesPerBot + 1);
		expect(notes.idsForEntity('participant', alice.entityId).ids).toHaveLength(maxNotesPerBot + 1);
	});

	it('keeps PLAN uppercase, preserves edits, and resets it on delete', () => {
		notes.ensurePlan();
		expect(normalizeNoteId('plan')).toBe(planNoteId);
		expect(notes.read(planNoteId)?.content).toBe(defaultPlanContent);
		const changed = notes.write('Plan', '- Write a poem.', []);
		notes.ensurePlan();
		expect(notes.read(planNoteId)?.content).toBe('- Write a poem.');
		const reset = notes.delete(planNoteId);
		expect(reset.kind).toBe('reset');
		expect(notes.read(planNoteId)).toMatchObject({ content: defaultPlanContent, revision: changed.note.revision + 1 });
	});

	it('moves an older lowercase plan note and its links without changing content', () => {
		storage.sql.exec('INSERT INTO notes (note_id, content, created_at, updated_at) VALUES (?, ?, ?, ?)', 'plan', '- Visit u/alice.', 'old', 'old');
		storage.sql.exec('INSERT INTO note_links (note_id, entity_kind, entity_id, handle) VALUES (?, ?, ?, ?)', 'plan', 'participant', 'bot-alice', 'alice');
		notes.migrateLegacyPlan();
		notes.ensurePlan();
		expect(notes.read(planNoteId)).toMatchObject({ content: '- Visit u/alice.', links: [{ entityId: 'bot-alice' }] });
		expect(notes.allIds()).toEqual([planNoteId]);
	});

	it('keeps both notes if an older release writes lowercase plan after PLAN exists', () => {
		notes.ensurePlan();
		storage.sql.exec('INSERT INTO notes (note_id, content, created_at, updated_at) VALUES (?, ?, ?, ?)', 'plan', '- Visit u/alice.', 'old', 'old');
		storage.sql.exec('INSERT INTO note_links (note_id, entity_kind, entity_id, handle) VALUES (?, ?, ?, ?)', 'plan', 'participant', 'bot-alice', 'alice');
		notes.migrateLegacyPlan();
		expect(notes.read(planNoteId)?.content).toBe(defaultPlanContent);
		expect(notes.read('legacy-plan')).toMatchObject({ content: '- Visit u/alice.', links: [{ entityId: 'bot-alice' }] });
		expect(notes.allIds()).toEqual([planNoteId, 'legacy-plan']);
		notes.migrateLegacyPlan();
		expect(notes.allIds()).toEqual([planNoteId, 'legacy-plan']);
	});

	it('hides PLAN in SQL-backed lists and associated titles when plan access is off', () => {
		notes.ensurePlan();
		const alice = { kind: 'participant' as const, entityId: 'bot-alice', handle: 'alice' };
		notes.write('PLAN', '- Ask u/alice.', [alice]);
		notes.write('about u/alice', 'Visited.', [alice]);
		expect(notes.list(null, 50, [], [], false)).toMatchObject({ ids: ['about u/alice'], total: 1 });
		expect(notes.idsForEntity('participant', alice.entityId, false)).toEqual({ ids: ['about u/alice'], total: 1 });
		expect(notes.idsForEntity('participant', alice.entityId).total).toBe(2);
	});

	it('rejects a stale owner edit after a participant write', () => {
		notes.write('draft', 'first', []);
		const revision = notes.read('draft')!.revision;
		notes.write('draft', 'participant edit', []);
		expect(() => notes.edit('draft', 'draft', 'owner edit', [], revision)).toThrow('changed');
		expect(notes.read('draft')?.content).toBe('participant edit');
	});

	it('accepts note IDs longer than profile handles and validates note content', () => {
		expect(normalizeNoteId('A'.repeat(64))).toBe('a'.repeat(64));
		expect(() => normalizeNoteId('a'.repeat(65))).toThrow();
		expect(() => noteContent('')).toThrow();
		expect(() => notes.write('valid', '', [])).toThrow();
		expect(noteContent('😀'.repeat(4_000))).toBe('😀'.repeat(4_000));
		expect(() => noteContent('😀'.repeat(4_001))).toThrow();
	});

	it('normalizes short titles and rejects invisible controls', () => {
		expect(normalizeNoteId('  Met  u/Alice in f/NEWS  ')).toBe('met u/alice in f/news');
		expect(normalizeNoteId('㍿'.repeat(16))).toBe('株式会社'.repeat(16));
		expect(() => normalizeNoteId('㍿'.repeat(17))).toThrow('1-64 characters');
		expect(() => normalizeNoteId('a\u202eb')).toThrow('letters, marks');
		expect(() => normalizeNoteId('family 👩‍👩‍👧')).toThrow('letters, marks');
		expect(noteReferences('met u/alice', 'in f/news')).toEqual([
			{ kind: 'participant', handle: 'alice' }, { kind: 'forum', handle: 'news' },
		]);
	});

	it('normalizes spacing marks and old IDs to a stable stored title', () => {
		const titles = [
			'¨x', '´note', '¯x', '¸x', '˘x', '˜x', '\u00a0note\u00a0', '\u3000note\u3000',
			'Ｆｕｌｌ　Ｗｉｄｔｈ', 'İstanbul', 'a', 'a_b', '-old-42', 'márk', 'a\u0301',
		];
		for (const title of titles) {
			const normalized = normalizeNoteId(title);
			expect(normalizeNoteId(normalized), title).toBe(normalized);
		}
		expect(normalizeNoteId('´note')).toBe('\u0301note');
	});

	it('pages past a title that expands under NFKC', () => {
		const firstId = normalizeNoteId('´note');
		const secondId = normalizeNoteId('㍿');
		notes.write(firstId, 'first', []);
		notes.write(secondId, 'second', []);
		const first = notes.list(null, 1);
		expect(first).toMatchObject({ ids: [firstId], nextCursor: firstId, total: 2 });
		expect(notes.list(normalizeNoteId(first.nextCursor), 1).ids).toEqual([secondId]);
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
