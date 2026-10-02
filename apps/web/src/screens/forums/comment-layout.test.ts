import { describe, expect, it } from "vitest";
import { localizedText, type LanguageTag } from "@bickr/shared/model";
import { commentIndentLimit, layoutCommentTree, type CommentTreeNode } from "./comment-layout";

function node(id: string, parentCommentId?: string, replies: CommentTreeNode[] = []): CommentTreeNode {
	return {
		id, parentCommentId, replies, threadId: "thr_test", worldId: "wld_test", forumId: "frm_test",
		authorBotId: "bot_test", authorHandle: "tester", authorDisplayName: localizedText("Tester", "en" as LanguageTag),
		body: localizedText(id, "en" as LanguageTag), voteScore: 0, createdAt: "2026-10-02", updatedAt: "2026-10-02",
	};
}

const tree = [node("r", undefined, [node("a", "r", [node("b", "a", [node("c", "b")]), node("d", "a")]), node("e", "r")])];

describe("comment indentation budget", () => {
	it.each([[320, 0], [360, 0], [375, 0], [390, 1], [393, 1], [402, 1], [412, 2], [414, 2], [430, 3], [440, 3]])("fits body text at viewport %i", (width, expected) => {
		expect(commentIndentLimit(width - 32, width, 24, 1200)).toBe(expected);
	});
	it("allows a body exactly at the floor and rejects the next indent", () => {
		expect(commentIndentLimit(348, 380, 24, 1200)).toBe(1);
		expect(commentIndentLimit(347.99, 379.99, 24, 1200)).toBe(0);
	});
	it("uses half the viewport above 600px and the desktop gutter", () => {
		expect(commentIndentLimit(768, 800, 26, 1200)).toBe(13);
	});
	it("uses spare container width before shrinking a capped body", () => {
		expect(commentIndentLimit(1500, 1600, 26, 1000)).toBe(25);
	});
	it("stops indentation if the font-dependent body cap is below the floor", () => {
		expect(commentIndentLimit(1500, 1600, 26, 799)).toBe(0);
		expect(commentIndentLimit(2000, 2400, 26, 1100)).toBe(0);
	});
});

describe("display comment relationships", () => {
	it("keeps preorder and flattens only the display ancestry", () => {
		const rows = layoutCommentTree(tree, 2);
		expect(rows.map((row) => [row.comment.id, row.depth, row.displayedParentId, row.connector])).toEqual([
			["r", 0, null, "none"], ["a", 1, "r", "solid"], ["b", 2, "a", "solid"],
			["c", 2, "a", "ellipsis"], ["d", 2, "a", "solid"], ["e", 1, "r", "solid"],
		]);
		expect(rows[3]!.comment.parentCommentId).toBe("b");
	});
	it("ends rails at the last displayed sibling and skips flattened child rails", () => {
		const rows = layoutCommentTree(tree, 2);
		expect(rows[2]!.rails).toEqual([{ depth: 0, kind: "through" }, { depth: 1, kind: "through" }]);
		expect(rows[4]!.rails).toEqual([{ depth: 0, kind: "through" }, { depth: 1, kind: "end" }]);
		expect(rows[5]!.rails).toEqual([{ depth: 0, kind: "end" }]);
	});
	it("preserves true nesting when it fits", () => {
		const rows = layoutCommentTree(tree, 20);
		expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 3, 2, 1]);
		expect(rows.every((row) => row.connector !== "ellipsis")).toBe(true);
	});
	it("retains a shared root rail and actual-root solid connectors at zero indents", () => {
		const rows = layoutCommentTree(tree, 0);
		expect(rows.map((row) => row.depth)).toEqual([0, 0, 0, 0, 0, 0]);
		expect(rows.map((row) => row.connector)).toEqual(["none", "solid", "ellipsis", "ellipsis", "ellipsis", "solid"]);
		expect(rows[5]!.rails).toEqual([{ depth: 0, kind: "end" }]);
	});
	it("retains separate roots and missing-parent comments", () => {
		const rows = layoutCommentTree([...tree, node("orphan", "missing", [node("reply", "orphan")])], 1);
		expect(rows.slice(-2).map((row) => [row.comment.id, row.displayedParentId])).toEqual([["orphan", null], ["reply", "orphan"]]);
	});
	it("walks deep reply chains without recursive traversal", () => {
		let root = node("last");
		for (let depth = 10000; depth > 0; depth--) root = node(`depth${depth}`, undefined, [root]);
		expect(layoutCommentTree([root], 2)).toHaveLength(10001);
	});
});
