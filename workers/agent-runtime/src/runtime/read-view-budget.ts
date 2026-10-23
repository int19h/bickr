import type { CommentView, ReadThreadView, ReadCommentView } from './tool-result-views';

/** Preserve the old depth order and body cutoff on the typed view. */
export function pruneReadView(view: ReadThreadView | ReadCommentView, budget: number, estimate: () => number): { omittedReplyCount: number; trimmedBodyCount: number } {
	const parents = new Set<string>();
	const bodies = new Set<string>();
	const visit = (items: CommentView[], top: boolean): void => {
		for (const item of items) {
			if (top || item.focused || item.ancestorOnly) parents.add(item.id);
			if (top || item.focused) bodies.add(item.id);
			if (Array.isArray(item.replies)) visit(item.replies, false);
		}
	};
	visit(view.content, true);
	const deepest = (items: CommentView[], depth = 0): number | null => {
		let result: number | null = null;
		for (const item of items) {
			if (!Array.isArray(item.replies) || item.replies.length === 0) continue;
			if (depth >= 1 && !parents.has(item.id)) result = Math.max(result ?? 0, depth + 1);
			const child = deepest(item.replies, depth + 1);
			if (child !== null) result = Math.max(result ?? 0, child);
		}
		return result;
	};
	const collapse = (items: CommentView[], target: number, depth = 0): void => {
		for (const item of items) {
			if (!Array.isArray(item.replies) || item.replies.length === 0) continue;
			if (depth >= 1 && depth + 1 === target && !parents.has(item.id)) item.replies = item.replies.length;
			else collapse(item.replies, target, depth + 1);
		}
	};
	let tokens = estimate();
	while (tokens > budget) {
		const depth = deepest(view.content);
		if (depth === null) break;
		collapse(view.content, depth);
		const next = estimate();
		if (next >= tokens) { tokens = next; break; }
		tokens = next;
	}
	let trimmedBodyCount = 0;
	if (tokens > budget) {
		const candidates: { index: number; original: string; points: string[] }[] = [];
		const collect = (items: CommentView[]): void => {
			for (const item of items) {
				const body = item.body === undefined ? undefined : view.facets[item.body]?.value;
				if (item.body !== undefined && body && !bodies.has(item.id) && Array.from(body).length > 1) candidates.push({ index: item.body, original: body, points: Array.from(body) });
				if (Array.isArray(item.replies)) collect(item.replies);
			}
		};
		collect(view.content);
		const apply = (cutoff: number): number => {
			let changed = 0;
			for (const candidate of candidates) {
				const value = candidate.points.length > cutoff ? `${candidate.points.slice(0, cutoff).join('').trimEnd()}…` : candidate.original;
				view.facets[candidate.index] = { ...view.facets[candidate.index]!, value };
				if (value !== candidate.original) changed += 1;
			}
			return changed;
		};
		if (candidates.length > 0) {
			let low = 0, high = Math.max(0, Math.max(...candidates.map(item => item.points.length)) - 2), accepted: number | null = null;
			while (low <= high) {
				const cutoff = Math.floor((low + high) / 2);
				apply(cutoff);
				if (estimate() <= budget) { accepted = cutoff; low = cutoff + 1; }
				else high = cutoff - 1;
			}
			trimmedBodyCount = apply(accepted ?? 0);
		}
	}
	const count = (items: CommentView[]): number => items.reduce((sum, item) => sum + (typeof item.replies === 'number' ? item.replies : count(item.replies)), 0);
	return { omittedReplyCount: count(view.content), trimmedBodyCount };
}
