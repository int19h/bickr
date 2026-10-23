import { parseCommentRef, parseThreadRef } from '@bickr/shared/ids';
import { facetFingerprint, type ResultFacetValue } from './result-context-scope';

/**
 * This adapter reads body values from rows without views. After the active-row
 * census and WI-F forced compaction, advance the schema version and delete it.
 */
export async function legacyResultFacets(content: unknown): Promise<ResultFacetValue[]> {
	let parsed = content;
	if (typeof content === 'string') { try { parsed = JSON.parse(content); } catch { return []; } }
	const result: ResultFacetValue[] = [];
	const visit = async (item: unknown): Promise<void> => {
		if (Array.isArray(item)) { for (const child of item) await visit(child); return; }
		if (!item || typeof item !== 'object') return;
		const record = item as Record<string, unknown>;
		const raw = typeof record.body === 'string' ? record.body : typeof record.text === 'string' ? record.text : undefined;
		const body = raw?.trim();
		const commentId = typeof record.commentRef === 'string' ? parseCommentRef(record.commentRef) : typeof record.commentId === 'string' ? record.commentId : record.type === 'comment' && typeof record.id === 'string' ? record.id : undefined;
		const threadId = typeof record.threadRef === 'string' ? parseThreadRef(record.threadRef) : record.type === 'thread' && typeof record.id === 'string' ? record.id : undefined;
		if (body && (commentId || threadId)) result.push({ entityId: commentId ?? threadId!, facet: commentId ? 'comment_body' : 'thread_body', state: 'shown', fingerprint: await facetFingerprint(body), value: body });
		for (const child of Object.values(record)) await visit(child);
	};
	await visit(parsed);
	return result;
}
