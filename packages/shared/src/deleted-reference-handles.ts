import type { BotDocument, ForumDocument } from './model';
import { kvKeys, readJson, type D1DatabaseLike, type KVNamespaceLike } from './storage';
import type { OwnedObjectIndexRepairRequest, OwnedObjectIndexRepairResult } from './index-repair';

export type DeletedHandleBackfillCursor = { kind: 'participant' | 'forum'; afterId: string };
export type DeletedHandleBackfillPage = { updated: number; missingIds: string[]; nextCursor: DeletedHandleBackfillCursor | null };

/**
 * The caller must hold the queue of the owning coordinator. After both index
 * censuses reach zero, advance the view schema version and delete this function.
 */
export async function backfillOwnedDeletedReferenceHandle(kv: KVNamespaceLike, db: D1DatabaseLike, request: OwnedObjectIndexRepairRequest): Promise<OwnedObjectIndexRepairResult> {
	if (request.entityType !== 'bot' && request.entityType !== 'forum') return { kind: 'missing' };
	const participant = request.entityType === 'bot';
	const table = participant ? 'bots_index' : 'forums_index', key = participant ? 'bot_id' : 'forum_id';
	const row = await db.prepare(`SELECT deleted_at AS deletedAt, handle_at_deletion AS handleAtDeletion FROM ${table} WHERE ${key} = ?`).bind(request.id).first<{ deletedAt: string | null; handleAtDeletion: string | null }>();
	if (!row?.deletedAt) return { kind: 'missing' };
	if (row.handleAtDeletion) return { kind: 'unchanged' };
	const document = participant ? await readJson<BotDocument>(kv, kvKeys.bot(request.id)) : await readJson<ForumDocument>(kv, kvKeys.forum(request.id));
	if (!document || document.id !== request.id || document.type !== request.entityType || !document.deletedAt || !document.handleAtDeletion) return { kind: 'missing' };
	const result = await db.prepare(`UPDATE ${table} SET handle_at_deletion = ? WHERE ${key} = ? AND deleted_at = ? AND handle_at_deletion IS NULL`).bind(document.handleAtDeletion, request.id, row.deletedAt).run();
	return (result.meta?.changes ?? 0) > 0 ? { kind: 'repaired', document } : { kind: 'unchanged' };
}

/**
 * Read one bounded page and send each ID to its owning coordinator. The job
 * stores no cursor. It retires with the owned backfill function above.
 */
export async function backfillDeletedReferenceHandles(db: D1DatabaseLike, repair: (request: OwnedObjectIndexRepairRequest) => Promise<OwnedObjectIndexRepairResult>, cursor: DeletedHandleBackfillCursor = { kind: 'participant', afterId: '' }, limit = 25): Promise<DeletedHandleBackfillPage> {
	const count = Number.isFinite(limit) ? Math.max(1, Math.min(25, Math.floor(limit))) : 25;
	const participant = cursor.kind === 'participant';
	const table = participant ? 'bots_index' : 'forums_index', key = participant ? 'bot_id' : 'forum_id';
	const rows = await db.prepare(`SELECT ${key} AS id FROM ${table} WHERE deleted_at IS NOT NULL AND handle_at_deletion IS NULL AND ${key} > ? ORDER BY ${key} LIMIT ?`).bind(cursor.afterId, count).all<{ id: string }>();
	const ids = rows.results ?? [], missingIds: string[] = [];
	let updated = 0;
	for (const { id } of ids) {
		const result = await repair({ entityType: participant ? 'bot' : 'forum', id, deletedReferenceHandle: true });
		if (result.kind === 'repaired') updated += 1;
		if (result.kind === 'missing') missingIds.push(id);
	}
	return { updated, missingIds, nextCursor: ids.length === count ? { kind: cursor.kind, afterId: ids.at(-1)!.id } : participant ? { kind: 'forum', afterId: '' } : null };
}
