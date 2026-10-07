import { participantListLimits } from '@bickr/shared/content-limits';
import { agentIssue } from '../localization/issues';
import { AgentInputError, AgentRepositoryError } from '../errors';
import type { FactoryText } from '@bickr/shared/localization';
import type { InferenceAttribution } from '@bickr/shared/model';
import { extractCanonicalEntityReferences, type CanonicalEntityReference } from '@bickr/shared/mentions';
import { RepositoryError } from '@bickr/shared/repository';
import { d1SafeBoundParameters, type D1DatabaseLike } from '@bickr/shared/storage';
import { InputError, normalizeHandleText } from '@bickr/shared/validation';
import { planNoteId } from '@bickr/shared/note-settings';

export const minNoteTitleLength = 1;
export const maxNoteTitleLength = 64;
export const maxNotesPerBot = 500;
export const maxNoteContentLength = 4_000;
export const maxNoteLinks = 50;
export const maxNoteListPage = 50;
export const maxNoteFilters = participantListLimits.maximumNoteFilters;
export { planNoteId };
// Historical bytes identify untouched revision-zero defaults in the one-time migration.
const legacyDefaultPlanContent = '- Keep PLAN current with write_note.';
export const factoryPlanMigrationKey = 'notes_factory_plan_v1';

// Old releases update PLAN content without its provenance column. These triggers
// treat that write as authored text in the same transaction. Factory rows remain
// empty after each statement, including writes from a rollback release.
export const factoryPlanTriggers = `
CREATE TRIGGER IF NOT EXISTS notes_factory_content_insert
AFTER INSERT ON notes WHEN NEW.content_source = 'factory' AND NEW.content <> ''
BEGIN UPDATE notes SET content_source = 'authored' WHERE note_id = NEW.note_id; END;
CREATE TRIGGER IF NOT EXISTS notes_factory_content_update
AFTER UPDATE OF content, content_source ON notes WHEN NEW.content_source = 'factory' AND NEW.content <> ''
BEGIN UPDATE notes SET content_source = 'authored' WHERE note_id = NEW.note_id; END;
`;

// ZWJ is excluded with other format controls. This also rejects ZWJ emoji titles.
const allowedNoteIdCharacter = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;

export type NoteEntityKind = 'participant' | 'forum';
export type NoteLink = { kind: NoteEntityKind; entityId: string; handle: string };
export type NoteLinkView = NoteLink & { deleted: boolean };
export type BotNote = { inferenceAttribution?: InferenceAttribution; id: string; content: string; createdAt: string; updatedAt: string; revision: number; links: NoteLink[] };
type StoredNote = (BotNote & { source: 'authored' }) |
	(Omit<BotNote, 'id' | 'content'> & { source: 'factory'; id: typeof planNoteId; content: '' });
export type BotNoteView = Omit<BotNote, 'links'> & { links: NoteLinkView[] };
export type NoteListPage = { ids: string[]; nextCursor: string | null; total: number; unknownFilters: string[] };

export function normalizeNoteId(value: unknown): string {
	return normalizeNoteTitle(value, 'id');
}

export function normalizeNoteCursor(value: unknown): string | null {
	// Some providers fill optional strings with an empty value. Keep this fallback
	// out of the tool schema so that participants use returned cursors normally.
	if (value === undefined || value === null || value === '') return null;
	return normalizeNoteTitle(value, 'cursor');
}

function normalizeNoteTitle(value: unknown, field: 'id' | 'cursor'): string {
	if (typeof value !== 'string') throw new AgentInputError(agentIssue(`issue.note.${field}.type`, {}));
	const id = value.normalize('NFKC').toLowerCase().replace(/\p{Zs}+/gu, ' ').trim();
	if ([...id].length < minNoteTitleLength || [...id].length > maxNoteTitleLength) {
		throw new AgentInputError(agentIssue(`issue.note.${field}.length`, { minimum: minNoteTitleLength, maximum: maxNoteTitleLength }));
	}
	if (!allowedNoteIdCharacter.test(id)) {
		throw new AgentInputError(agentIssue(`issue.note.${field}.characters`, {}));
	}
	return id === 'plan' ? planNoteId : id;
}

export function noteReferences(id: string, content: string): CanonicalEntityReference[] {
	return extractCanonicalEntityReferences(`${id}\n${content}`);
}

export function noteContent(value: unknown): string {
	if (typeof value !== 'string') throw new AgentInputError(agentIssue('issue.note.content', { max: maxNoteContentLength }));
	const length = [...value].length;
	if (length < 1 || length > maxNoteContentLength) {
		throw new AgentInputError(agentIssue('issue.note.content', { max: maxNoteContentLength }));
	}
	return value;
}

export function noteFilterReferences(value: unknown): CanonicalEntityReference[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > maxNoteFilters || value.some((entry) => typeof entry !== 'string')) {
		throw new AgentInputError(agentIssue('issue.note.entities.array', { max: maxNoteFilters }));
	}
	const references = value.flatMap((entry) => {
		const found = extractCanonicalEntityReferences(entry);
		return found.length === 1 && normalizeHandleText(entry) === `${found[0]!.kind === 'forum' ? 'f' : 'u'}/${found[0]!.handle}` ? found : [];
	});
	if (references.length !== value.length) throw new AgentInputError(agentIssue('issue.note.entities.entry', {}));
	return references;
}

export async function resolveNoteLinks(
	db: D1DatabaseLike,
	worldId: string,
	references: readonly CanonicalEntityReference[],
): Promise<{ links: NoteLink[]; unknown: string[] }> {
	const unique = new Map(references.map((reference) => [`${reference.kind}:${reference.handle}`, reference]));
	if (unique.size > maxNoteLinks) throw new AgentInputError(agentIssue('issue.note.references', { max: maxNoteLinks }));
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

	ensurePlan(): void {
		const now = new Date().toISOString();
		this.storage.sql.exec(
			"INSERT INTO notes (note_id, content, content_source, created_at, updated_at, revision) VALUES (?, '', 'factory', ?, ?, 0) ON CONFLICT(note_id) DO NOTHING",
			planNoteId, now, now,
		);
	}

	/** Run once at startup, after the lowercase PLAN migration and before ensurePlan.
	 * Retire after the fleet sweep stamps this version and rollback no longer
	 * includes releases that store an English factory body. The stamp is one row.
	 */
	migrateFactoryPlan(): void {
		this.storage.transactionSync(() => {
			const done = this.storage.sql.exec<{ key: string }>('SELECT key FROM runtime_state WHERE key = ? LIMIT 1', factoryPlanMigrationKey).toArray()[0];
			if (done) return;
			this.storage.sql.exec(
				"UPDATE notes SET content = '', content_source = 'factory' WHERE note_id = ? AND revision = 0 AND content = ? AND content_source = 'authored'",
				planNoteId, legacyDefaultPlanContent,
			);
			this.storage.sql.exec('INSERT INTO runtime_state (key, value_json) VALUES (?, ?)', factoryPlanMigrationKey, '1');
		});
	}

	/** Base 9df9001 can write lowercase plan on rollback. Remove this check after that base is no longer a rollback target. */
	migrateLegacyPlan(): void {
		this.storage.transactionSync(() => {
			const old = this.storage.sql.exec<{ note_id: string }>('SELECT note_id FROM notes WHERE note_id = ? LIMIT 1', 'plan').toArray()[0];
			if (!old) return;
			const current = this.storage.sql.exec<{ note_id: string }>('SELECT note_id FROM notes WHERE note_id = ? LIMIT 1', planNoteId).toArray()[0];
			let target = planNoteId;
			if (current) {
				// Preserve both notes if an old release wrote plan after PLAN was created.
				for (let suffix = 1; suffix <= maxNotesPerBot + 1; suffix++) {
					const candidate = suffix === 1 ? 'legacy-plan' : `legacy-plan-${suffix}`;
					const occupied = this.storage.sql.exec<{ note_id: string }>('SELECT note_id FROM notes WHERE note_id = ? LIMIT 1', candidate).toArray()[0];
					if (!occupied) { target = candidate; break; }
				}
			}
			if (target === planNoteId && current) throw new RepositoryError('conflict', 'No free title for the old plan note.', 409, { noteCause: 'title_conflict' });
			this.storage.sql.exec('UPDATE notes SET note_id = ? WHERE note_id = ?', target, old.note_id);
			this.storage.sql.exec('UPDATE note_links SET note_id = ? WHERE note_id = ?', target, old.note_id);
		});
	}

	allIds(): string[] {
		return this.storage.sql.exec<{ note_id: string }>(
			'SELECT note_id FROM notes ORDER BY note_id LIMIT ?', maxNotesPerBot + 1,
		).toArray().map((row) => row.note_id);
	}

	list(cursor: string | null, limit: number, links: readonly NoteLink[] = [], unknownFilters: string[] = [], includePlan = true): NoteListPage {
		const size = Math.max(1, Math.min(maxNoteListPage, Math.floor(limit)));
		const filter = links.length > 0 || unknownFilters.length > 0;
		if (filter && links.length === 0) return { ids: [], nextCursor: null, total: 0, unknownFilters };
		const linkWhere = links.map(() => '(l.entity_kind = ? AND l.entity_id = ?)').join(' OR ');
		const predicate = `${includePlan ? '' : ' AND n.note_id <> ?'}${filter ? ` AND EXISTS (SELECT 1 FROM note_links l WHERE l.note_id = n.note_id AND (${linkWhere}))` : ''}`;
		const visibilityArgs = includePlan ? [] : [planNoteId];
		const linkArgs = links.flatMap((link) => [link.kind, link.entityId]);
		const total = this.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM notes n WHERE 1=1${predicate}`, ...visibilityArgs, ...linkArgs).one().count;
		const rows = this.storage.sql.exec<{ note_id: string }>(
			`SELECT n.note_id FROM notes n WHERE n.note_id > ?${predicate} ORDER BY n.note_id LIMIT ?`,
			cursor ?? '', ...visibilityArgs, ...linkArgs, size + 1,
		).toArray();
		const ids = rows.slice(0, size).map((row) => row.note_id);
		return { ids, nextCursor: rows.length > size ? ids.at(-1) ?? null : null, total, unknownFilters };
	}

	read(text: FactoryText, id: string): BotNote | null {
		const stored = this.storedNote(id);
		if (!stored) return null;
		const { source, ...note } = stored;
		return { ...note, content: source === 'factory' ? text.format('factory.plan') : note.content };
	}

	private storedNote(id: string): StoredNote | null {
		const row = this.storage.sql.exec<{ note_id: string; content: string; created_at: string; updated_at: string; revision: number; inference_attribution_json: string | null; content_source: 'authored' | 'factory' }>(
			'SELECT note_id, content, created_at, updated_at, revision, inference_attribution_json, content_source FROM notes WHERE note_id = ? LIMIT 1', id,
		).toArray()[0];
		if (!row) return null;
		const links = this.storage.sql.exec<{ entity_kind: NoteEntityKind; entity_id: string; handle: string }>(
			'SELECT entity_kind, entity_id, handle FROM note_links WHERE note_id = ? ORDER BY entity_kind, handle LIMIT ?', id, maxNoteLinks,
		).toArray().map((link) => ({ kind: link.entity_kind, entityId: link.entity_id, handle: link.handle }));
		const metadata = { createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision, links,
			...(row.inference_attribution_json ? { inferenceAttribution: JSON.parse(row.inference_attribution_json) as InferenceAttribution } : {}) };
		if (row.content_source === 'factory') {
			if (row.note_id !== planNoteId || row.content !== '') throw new Error('Invalid stored factory note.');
			return { ...metadata, source: 'factory', id: planNoteId, content: '' };
		}
		return { ...metadata, source: 'authored', id: row.note_id, content: row.content };
	}

	write(id: string, content: string, links: readonly NoteLink[], inferenceAttribution?: InferenceAttribution): { kind: 'created' | 'replaced'; note: BotNote } {
		return this.writeRecord(id, content, links, 'upsert', inferenceAttribution);
	}

	create(id: string, content: string, links: readonly NoteLink[]): BotNote {
		return this.writeRecord(id, content, links, 'create_only').note;
	}

	private writeRecord(id: string, content: string, links: readonly NoteLink[], mode: 'upsert' | 'create_only', inferenceAttribution?: InferenceAttribution): { kind: 'created' | 'replaced'; note: BotNote } {
		id = normalizeNoteId(id);
		content = noteContent(content);
		if (links.length > maxNoteLinks) throw new AgentInputError(agentIssue('issue.note.references', { max: maxNoteLinks }));
		return this.storage.transactionSync(() => {
			const existing = this.storage.sql.exec<{ created_at: string; revision: number }>('SELECT created_at, revision FROM notes WHERE note_id = ? LIMIT 1', id).toArray()[0];
			if (existing && mode === 'create_only') throw new RepositoryError('conflict', 'A note with this title already exists.', 409, { noteCause: 'title_conflict' });
			if (!existing) {
				const count = this.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM notes WHERE note_id <> ?', planNoteId).one().count;
				if (id !== planNoteId && count >= maxNotesPerBot) throw new AgentRepositoryError('conflict', agentIssue('issue.note.capacity', { max: maxNotesPerBot }), 409);
			}
			const now = new Date().toISOString();
			this.storage.sql.exec(
				"INSERT INTO notes (note_id, content, content_source, created_at, updated_at, revision, inference_attribution_json) VALUES (?, ?, 'authored', ?, ?, 0, ?) ON CONFLICT(note_id) DO UPDATE SET content = excluded.content, content_source = 'authored', updated_at = excluded.updated_at, revision = notes.revision + 1, inference_attribution_json = excluded.inference_attribution_json",
				id, content, now, now, inferenceAttribution ? JSON.stringify(inferenceAttribution) : null,
			);
			this.storage.sql.exec('DELETE FROM note_links WHERE note_id = ?', id);
			for (const link of links) this.storage.sql.exec(
				'INSERT INTO note_links (note_id, entity_kind, entity_id, handle) VALUES (?, ?, ?, ?)', id, link.kind, link.entityId, link.handle,
			);
			return { kind: existing ? 'replaced' as const : 'created' as const, note: { id, content, createdAt: existing?.created_at ?? now, updatedAt: now, revision: existing ? existing.revision + 1 : 0, links: [...links], ...(inferenceAttribution ? { inferenceAttribution } : {}) } };
		});
	}

	edit(id: string, nextId: string, content: string, links: readonly NoteLink[], expectedRevision: number): BotNote {
		id = normalizeNoteId(id);
		nextId = normalizeNoteId(nextId);
		content = noteContent(content);
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new InputError('Note revision must be a nonnegative integer.');
		if (links.length > maxNoteLinks) throw new AgentInputError(agentIssue('issue.note.references', { max: maxNoteLinks }));
		return this.storage.transactionSync(() => {
			const existing = this.storedNote(id);
			if (!existing) throw new RepositoryError('not_found', 'Note not found.', 404);
			if (existing.revision !== expectedRevision) throw new RepositoryError('conflict', 'This note changed. Reload it before saving.', 409, { noteCause: 'stale_revision' });
			if ((id === planNoteId) !== (nextId === planNoteId)) throw new RepositoryError('conflict', 'The PLAN title is reserved.', 409, { noteCause: 'reserved_title' });
			if (nextId !== id && this.storedNote(nextId)) throw new RepositoryError('conflict', 'A note with this title already exists.', 409, { noteCause: 'title_conflict' });
			const now = new Date().toISOString();
			this.storage.sql.exec('DELETE FROM note_links WHERE note_id = ?', id);
			this.storage.sql.exec("UPDATE notes SET note_id = ?, content = ?, content_source = 'authored', updated_at = ?, revision = revision + 1, inference_attribution_json = NULL WHERE note_id = ?", nextId, content, now, id);
			for (const link of links) this.storage.sql.exec(
				'INSERT INTO note_links (note_id, entity_kind, entity_id, handle) VALUES (?, ?, ?, ?)', nextId, link.kind, link.entityId, link.handle,
			);
			return { id: nextId, content, createdAt: existing.createdAt, updatedAt: now, revision: existing.revision + 1, links: [...links] };
		});
	}

	delete(text: FactoryText, id: string): { kind: 'deleted' | 'not_found' } | { kind: 'reset'; note: BotNote } {
		return this.storage.transactionSync(() => {
			const exists = this.storedNote(id);
			if (!exists) return { kind: 'not_found' };
			this.storage.sql.exec('DELETE FROM note_links WHERE note_id = ?', id);
			if (id === planNoteId) {
				const now = new Date().toISOString();
				this.storage.sql.exec("UPDATE notes SET content = '', content_source = 'factory', updated_at = ?, revision = revision + 1, inference_attribution_json = NULL WHERE note_id = ?", now, id);
				const { inferenceAttribution: _attribution, source: _source, ...manualNote } = exists;
				return { kind: 'reset', note: { ...manualNote, content: text.format('factory.plan'), updatedAt: now, revision: exists.revision + 1, links: [] } };
			}
			this.storage.sql.exec('DELETE FROM notes WHERE note_id = ?', id);
			return { kind: 'deleted' };
		});
	}

	idsForEntity(kind: NoteEntityKind, entityId: string, includePlan = true): { ids: string[]; total: number } {
		const predicate = includePlan ? '' : ' AND note_id <> ?';
		const visibilityArgs = includePlan ? [] : [planNoteId];
		const total = this.storage.sql.exec<{ count: number }>(
			`SELECT COUNT(*) AS count FROM note_links WHERE entity_kind = ? AND entity_id = ?${predicate}`, kind, entityId, ...visibilityArgs,
		).one().count;
		const ids = this.storage.sql.exec<{ note_id: string }>(
			`SELECT l.note_id FROM note_links l JOIN notes n ON n.note_id = l.note_id
			 WHERE l.entity_kind = ? AND l.entity_id = ?${includePlan ? '' : ' AND l.note_id <> ?'} ORDER BY n.updated_at DESC, l.note_id LIMIT ?`, kind, entityId, ...visibilityArgs, maxNotesPerBot + 1,
		).toArray().map((row) => row.note_id);
		return { ids, total };
	}
}
