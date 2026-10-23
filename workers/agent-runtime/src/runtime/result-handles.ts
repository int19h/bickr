import type { D1DatabaseLike } from '@bickr/shared/storage';

export type ResultEntityReference = { kind: 'participant' | 'forum'; entityId: string; handle: string };
export type CurrentResultHandle = Readonly<{ kind: 'current'; handle: string } | { kind: 'deleted'; handle?: string }>;
export type ResultHandleMap = ReadonlyMap<string, CurrentResultHandle>;

export function resultHandleKey(ref: Pick<ResultEntityReference, 'kind' | 'entityId'>): string {
	return JSON.stringify([ref.kind, ref.entityId]);
}

/** Each ID list uses one binding, independent of the size of active history. */
export async function currentResultHandles(db: D1DatabaseLike, refs: readonly ResultEntityReference[]): Promise<ResultHandleMap> {
	const participants = [...new Set(refs.filter(ref => ref.kind === 'participant').map(ref => ref.entityId))];
	const forums = [...new Set(refs.filter(ref => ref.kind === 'forum').map(ref => ref.entityId))];
	type Row = { id: string; handle: string; handle_at_deletion: string | null; deleted_at: string | null };
	const queries = await Promise.all([
		participants.length === 0 ? Promise.resolve([] as Row[]) : db.prepare(
			'SELECT bot_id AS id, handle, handle_at_deletion, deleted_at FROM bots_index WHERE bot_id IN (SELECT value FROM json_each(?))',
		).bind(JSON.stringify(participants)).all<Row>().then(result => result.results ?? []),
		forums.length === 0 ? Promise.resolve([] as Row[]) : db.prepare(
			'SELECT forum_id AS id, handle, handle_at_deletion, deleted_at FROM forums_index WHERE forum_id IN (SELECT value FROM json_each(?))',
		).bind(JSON.stringify(forums)).all<Row>().then(result => result.results ?? []),
	]);
	const handles = new Map<string, CurrentResultHandle>();
	for (const [index, rows] of queries.entries()) {
		for (const row of rows) {
			const deleted = row.deleted_at !== null;
			// Readers can run before the backfill. A missing deletion handle stays explicit.
			const handle = deleted ? row.handle_at_deletion : row.handle;
			handles.set(resultHandleKey({ kind: index === 0 ? 'participant' : 'forum', entityId: row.id }), deleted ? { kind: 'deleted', ...(handle ? { handle } : {}) } : { kind: 'current', handle: row.handle });
		}
	}
	return handles;
}

export type ResultContentIdentities = { forumsByThreadId: ReadonlyMap<string, string>; authorsByCommentId: ReadonlyMap<string, string>; forumHandlesById: ReadonlyMap<string, string>; threadCreatedAtById: ReadonlyMap<string, string>; commentCreatedAtById: ReadonlyMap<string, string> };
export async function resultContentIdentities(db: D1DatabaseLike, threadIds: readonly string[], commentIds: readonly string[]): Promise<ResultContentIdentities> {
	const [threads, comments] = await Promise.all([
		threadIds.length === 0 ? Promise.resolve([]) : db.prepare('SELECT thread_id AS id, forum_id AS entityId, forum_handle AS handle, created_at AS createdAt FROM threads_index WHERE thread_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify([...new Set(threadIds)])).all<{ id: string; entityId: string; handle: string; createdAt: string }>().then(result => result.results ?? []),
		commentIds.length === 0 ? Promise.resolve([]) : db.prepare('SELECT comment_id AS id, author_bot_id AS entityId, created_at AS createdAt FROM comments_index WHERE comment_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify([...new Set(commentIds)])).all<{ id: string; entityId: string; createdAt: string }>().then(result => result.results ?? []),
	]);
	return { forumsByThreadId: new Map(threads.map(row => [row.id, row.entityId])), authorsByCommentId: new Map(comments.map(row => [row.id, row.entityId])), forumHandlesById: new Map(threads.map(row => [row.entityId, row.handle])), threadCreatedAtById: new Map(threads.map(row => [row.id, row.createdAt])), commentCreatedAtById: new Map(comments.map(row => [row.id, row.createdAt])) };
}

/** Bootstrap messages name forums before they name a thread. */
export async function resultForumIds(db: D1DatabaseLike, worldId: string, handles: readonly string[]): Promise<ReadonlyMap<string, string>> {
	if (handles.length === 0) return new Map();
	const rows = await db.prepare('SELECT forum_id AS id, handle FROM forums_index WHERE world_id = ? AND handle IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL')
		.bind(worldId, JSON.stringify([...new Set(handles.map(handle => handle.replace(/^f\//u, '')))]))
		.all<{ id: string; handle: string }>();
	return new Map((rows.results ?? []).map(row => [`f/${row.handle}`, row.id]));
}

/** Missing rows and missing deletion handles use the handle that the view saved. */
export function resolveResultHandle(reference: ResultEntityReference, handles: ResultHandleMap): { handle: string; deleted: boolean } {
	const state = handles.get(resultHandleKey(reference));
	switch (state?.kind) {
		case 'current': return { handle: state.handle, deleted: false };
		case 'deleted': return { handle: state.handle ?? reference.handle, deleted: true };
		case undefined: return { handle: reference.handle, deleted: true };
	}
}
