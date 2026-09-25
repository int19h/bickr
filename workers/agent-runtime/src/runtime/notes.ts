import { extractCanonicalEntityReferences, type CanonicalEntityReference } from '@bickr/shared/mentions';
import { RepositoryError } from '@bickr/shared/repository';
import { d1SafeBoundParameters, type D1DatabaseLike } from '@bickr/shared/storage';
import { InputError, normalizeHandleText } from '@bickr/shared/validation';

export const maxNotesPerBot = 500;
export const maxNoteContentLength = 4_000;
export const maxNoteLinks = 50;
export const maxNoteListPage = 50;
export const maxNoteFilters = 10;

const noteIdPattern = /^[\p{Letter}\p{Number}_-][\p{Letter}\p{Number}\p{Mark}_-]{0,63}$/u;

export type NoteEntityKind = 'participant' | 'forum';
export type NoteLink = { kind: NoteEntityKind; entityId: string; handle: string };
export type NoteLinkView = NoteLink & { deleted: boolean };
export type BotNote = { id: string; content: string; createdAt: string; updatedAt: string; links: NoteLink[] };
export type BotNoteView = Omit<BotNote, 'links'> & { links: NoteLinkView[] };
export type NoteListPage = { ids: string[]; nextCursor: string | null; total: number; unknownFilters: string[] };

export function normalizeNoteId(value: unknown): string {
	if (typeof value !== 'string') throw new InputError('Note ID must be text.');
	const id = normalizeHandleText(value);
	if (!noteIdPattern.test(id)) {
		throw new InputError('Note ID must be 1-64 letters, numbers, hyphens, or underscores.');
	}
	return id;
}

export function noteContent(value: unknown): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > maxNoteContentLength) {
		throw new InputError(`Note content must be 1-${maxNoteContentLength} characters.`);
	}
	return value;
}

export function noteFilterReferences(value: unknown): CanonicalEntityReference[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > maxNoteFilters || value.some((entry) => typeof entry !== 'string')) {
		throw new InputError(`Note filters must be a list of at most ${maxNoteFilters} f/ or u/ handles.`);
	}
	const references = value.flatMap((entry) => {
		const found = extractCanonicalEntityReferences(entry);
		return found.length === 1 && entry.toLowerCase() === `${found[0]!.kind === 'forum' ? 'f' : 'u'}/${found[0]!.handle}` ? found : [];
	});
	if (references.length !== value.length) throw new InputError('Each note filter must be one f/ or u/ handle.');
	return references;
}

export async function resolveNoteLinks(
	db: D1DatabaseLike,
	worldId: string,
	references: readonly CanonicalEntityReference[],
): Promise<{ links: NoteLink[]; unknown: string[] }> {
	const unique = new Map(references.map((reference) => [`${reference.kind}:${reference.handle}`, reference]));
	if (unique.size > maxNoteLinks) throw new InputError(`A note can refer to at most ${maxNoteLinks} distinct profiles and forums.`);
	const links: NoteLink[] = [];
	const found = new Set<string>();
	for (const kind of ['participant', 'forum'] as const) {
		const handles = [...unique.values()].filter((reference) => reference.kind === kind).map((reference) => reference.handle);
		for (let start = 0; start < handles.length; start += d1SafeBoundParameters - 1) {
			const chunk = handles.slice(start, start + d1SafeBoundParameters - 1);
			if (chunk.length === 0) continue;
			const placeholders = chunk.map(() => '?').join(', ');
			const query = kind === 'participant'
				? `SELECT bot_id AS entityId, handle FROM bots_index WHERE home_world_id = ? AND handle IN (${placeholders}) AND deleted_at IS NULL AND lifecycle_state = 'active'`
				: `SELECT forum_id AS entityId, handle FROM forums_index WHERE world_id = ? AND handle IN (${placeholders}) AND deleted_at IS NULL`;
			const rows = await db.prepare(query).bind(worldId, ...chunk).all<{ entityId: string; handle: string }>();
			for (const row of rows.results ?? []) {
				links.push({ kind, entityId: row.entityId, handle: row.handle });
				found.add(`${kind}:${row.handle}`);
			}
		}
	}
	return {
		links,
		unknown: [...unique.values()].filter((reference) => !found.has(`${reference.kind}:${reference.handle}`))
			.map((reference) => `${reference.kind === 'forum' ? 'f' : 'u'}/${reference.handle}`),
	};
}

export async function noteLinkViews(db: D1DatabaseLike, worldId: string, links: readonly NoteLink[]): Promise<NoteLinkView[]> {
	const current = new Map<string, string>();
	for (const kind of ['participant', 'forum'] as const) {
		const ids = links.filter((link) => link.kind === kind).map((link) => link.entityId);
		for (let start = 0; start < ids.length; start += d1SafeBoundParameters - 1) {
			const chunk = ids.slice(start, start + d1SafeBoundParameters - 1);
			if (chunk.length === 0) continue;
			const placeholders = chunk.map(() => '?').join(', ');
			const query = kind === 'participant'
				? `SELECT bot_id AS entityId, handle FROM bots_index WHERE home_world_id = ? AND bot_id IN (${placeholders}) AND deleted_at IS NULL AND lifecycle_state = 'active'`
				: `SELECT forum_id AS entityId, handle FROM forums_index WHERE world_id = ? AND forum_id IN (${placeholders}) AND deleted_at IS NULL`;
			const rows = await db.prepare(query).bind(worldId, ...chunk).all<{ entityId: string; handle: string }>();
			for (const row of rows.results ?? []) current.set(`${kind}:${row.entityId}`, row.handle);
		}
	}
	return links.map((link) => {
		const handle = current.get(`${link.kind}:${link.entityId}`);
		return { ...link, handle: handle ?? link.handle, deleted: handle === undefined };
	});
}

export class BotNotesStore {
	private readonly storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;
	constructor(storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>) { this.storage = storage; }

	allIds(): string[] {
		return this.storage.sql.exec<{ note_id: string }>(
			'SELECT note_id FROM notes ORDER BY note_id LIMIT ?', maxNotesPerBot,
		).toArray().map((row) => row.note_id);
	}

	list(cursor: string | null, limit: number, links: readonly NoteLink[] = [], unknownFilters: string[] = []): NoteListPage {
		const size = Math.max(1, Math.min(maxNoteListPage, Math.floor(limit)));
		const filter = links.length > 0 || unknownFilters.length > 0;
		if (filter && links.length === 0) return { ids: [], nextCursor: null, total: 0, unknownFilters };
		const linkWhere = links.map(() => '(l.entity_kind = ? AND l.entity_id = ?)').join(' OR ');
		const predicate = filter ? ` AND EXISTS (SELECT 1 FROM note_links l WHERE l.note_id = n.note_id AND (${linkWhere}))` : '';
		const linkArgs = links.flatMap((link) => [link.kind, link.entityId]);
		const total = this.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM notes n WHERE 1=1${predicate}`, ...linkArgs).one().count;
		const rows = this.storage.sql.exec<{ note_id: string }>(
			`SELECT n.note_id FROM notes n WHERE n.note_id > ?${predicate} ORDER BY n.note_id LIMIT ?`,
			cursor ?? '', ...linkArgs, size + 1,
		).toArray();
		const ids = rows.slice(0, size).map((row) => row.note_id);
		return { ids, nextCursor: rows.length > size ? ids.at(-1) ?? null : null, total, unknownFilters };
	}

	read(id: string): BotNote | null {
		const row = this.storage.sql.exec<{ note_id: string; content: string; created_at: string; updated_at: string }>(
			'SELECT note_id, content, created_at, updated_at FROM notes WHERE note_id = ? LIMIT 1', id,
		).toArray()[0];
		if (!row) return null;
		const links = this.storage.sql.exec<{ entity_kind: NoteEntityKind; entity_id: string; handle: string }>(
			'SELECT entity_kind, entity_id, handle FROM note_links WHERE note_id = ? ORDER BY entity_kind, handle LIMIT ?', id, maxNoteLinks,
		).toArray().map((link) => ({ kind: link.entity_kind, entityId: link.entity_id, handle: link.handle }));
		return { id: row.note_id, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at, links };
	}

	write(id: string, content: string, links: readonly NoteLink[]): { kind: 'created' | 'replaced'; note: BotNote } {
		id = normalizeNoteId(id);
		content = noteContent(content);
		if (links.length > maxNoteLinks) throw new InputError(`A note can refer to at most ${maxNoteLinks} distinct profiles and forums.`);
		return this.storage.transactionSync(() => {
			const existing = this.storage.sql.exec<{ created_at: string }>('SELECT created_at FROM notes WHERE note_id = ? LIMIT 1', id).toArray()[0];
			if (!existing) {
				const count = this.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM notes').one().count;
				if (count >= maxNotesPerBot) throw new RepositoryError('conflict', `A participant can keep at most ${maxNotesPerBot} notes.`, 409);
			}
			const now = new Date().toISOString();
			this.storage.sql.exec(
				'INSERT INTO notes (note_id, content, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(note_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at',
				id, content, now, now,
			);
			this.storage.sql.exec('DELETE FROM note_links WHERE note_id = ?', id);
			for (const link of links) this.storage.sql.exec(
				'INSERT INTO note_links (note_id, entity_kind, entity_id, handle) VALUES (?, ?, ?, ?)', id, link.kind, link.entityId, link.handle,
			);
			return { kind: existing ? 'replaced' as const : 'created' as const, note: { id, content, createdAt: existing?.created_at ?? now, updatedAt: now, links: [...links] } };
		});
	}

	delete(id: string): void {
		this.storage.transactionSync(() => {
			const exists = this.storage.sql.exec<{ note_id: string }>('SELECT note_id FROM notes WHERE note_id = ? LIMIT 1', id).toArray()[0];
			if (!exists) throw new RepositoryError('not_found', 'Note not found.', 404);
			this.storage.sql.exec('DELETE FROM note_links WHERE note_id = ?', id);
			this.storage.sql.exec('DELETE FROM notes WHERE note_id = ?', id);
		});
	}

	idsForEntity(kind: NoteEntityKind, entityId: string): { ids: string[]; total: number } {
		const total = this.storage.sql.exec<{ count: number }>(
			'SELECT COUNT(*) AS count FROM note_links WHERE entity_kind = ? AND entity_id = ?', kind, entityId,
		).one().count;
		const ids = this.storage.sql.exec<{ note_id: string }>(
			`SELECT l.note_id FROM note_links l JOIN notes n ON n.note_id = l.note_id
			 WHERE l.entity_kind = ? AND l.entity_id = ? ORDER BY n.updated_at DESC, l.note_id LIMIT ?`, kind, entityId, maxNotesPerBot,
		).toArray().map((row) => row.note_id);
		return { ids, total };
	}
}
