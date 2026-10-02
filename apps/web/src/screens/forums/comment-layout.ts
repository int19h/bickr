import type { CommentDocument } from "@bickr/shared/model";

export type CommentTreeNode = CommentDocument & { replies: CommentTreeNode[] };
export type CommentRail = { depth: number; kind: "through" | "end" | "start" };
export type CommentLayoutRow = {
	comment: CommentTreeNode;
	depth: number;
	displayedParentId: string | null;
	connector: "none" | "solid" | "ellipsis";
	rails: CommentRail[];
	zeroIndent: boolean;
};

export function commentIndentLimit(treeWidth: number, viewportWidth: number, gutter: number, bodyCap: number): number {
	const floor = Math.max(300, viewportWidth / 2);
	if (gutter <= 0 || bodyCap < floor) {
		return 0;
	}
	return Math.max(0, Math.floor((treeWidth - gutter - floor) / gutter));
}

/** Display ancestry is separate from the actual parent IDs used by navigation and Spotlight. */
export function layoutCommentTree(roots: CommentTreeNode[], limit: number): CommentLayoutRow[] {
	type Node = Omit<CommentLayoutRow, "rails"> & { children: number[] };
	const nodes: Node[] = [];
	const rootIndexes: number[] = [];
	const pending = roots.map((comment) => ({ comment, realDepth: 0, parent: -1, anchor: -1 })).reverse();
	while (pending.length > 0) {
		const { comment, realDepth, parent, anchor } = pending.pop()!;
		const index = nodes.length;
		const displayedParent = realDepth === 0 ? -1 : realDepth <= limit ? parent : anchor;
		const displayedParentId = displayedParent < 0 ? null : nodes[displayedParent]!.comment.id;
		nodes.push({
			comment,
			depth: Math.min(realDepth, limit),
			displayedParentId,
			connector: displayedParentId === null ? "none" : displayedParentId === comment.parentCommentId ? "solid" : "ellipsis",
			children: [],
			zeroIndent: limit === 0,
		});
		if (displayedParent < 0) {
			rootIndexes.push(index);
		} else {
			nodes[displayedParent]!.children.push(index);
		}
		// At the limit, deeper descendants become displayed children of this anchor.
		const nextAnchor = realDepth === Math.max(0, limit - 1) ? index : anchor;
		for (let child = comment.replies.length - 1; child >= 0; child--) {
			pending.push({ comment: comment.replies[child]!, realDepth: realDepth + 1, parent: index, anchor: nextAnchor });
		}
	}

	const rows: CommentLayoutRow[] = [];
	const displayPending = rootIndexes.map((index) => ({ index, continuing: [] as number[], last: true })).reverse();
	while (displayPending.length > 0) {
		const { index, continuing, last } = displayPending.pop()!;
		const { children, ...node } = nodes[index]!;
		const rails: CommentRail[] = continuing.map((depth) => ({ depth, kind: "through" }));
		if (node.displayedParentId !== null) {
			rails.push({ depth: limit === 0 ? 0 : node.depth - 1, kind: last ? "end" : "through" });
		}
		if (children.length > 0) {
			rails.push({ depth: node.depth, kind: "start" });
		}
		rows.push({ ...node, rails });
		const childContinuing = node.displayedParentId !== null && !last && limit > 0 ?
			[...continuing, node.depth - 1] : continuing;
		for (let child = children.length - 1; child >= 0; child--) {
			displayPending.push({ index: children[child]!, continuing: childContinuing, last: child === children.length - 1 });
		}
	}
	return rows;
}
