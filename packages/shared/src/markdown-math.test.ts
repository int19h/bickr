import { describe, it, expect } from "vitest";
import { parseMarkdown, markdownTextSpans, markdownPreview } from "./markdown";
import type { RootContent } from "mdast";
function formulas(source: string): Array<{ type: string; value: string }> {
	const result: Array<{ type: string; value: string }> = [];
	function walk(node: RootContent) { if (node.type === "inlineMath" || node.type === "math") result.push({ type: node.type, value: node.value }); else if ("children" in node) for (const child of node.children) walk(child); }
	for (const node of parseMarkdown(source).children) walk(node);
	return result;
}
describe("shared GitHub math syntax", () => {
	it("parses plain and protected inline TeX without Markdown interpretation", () => {
		expect(formulas('$x_1^2$ and $`\\sqrt{\\$4} + x_$y`$')).toEqual([{ type: "inlineMath", value: "x_1^2" }, { type: "inlineMath", value: '\\sqrt{\\$4} + x_$y' }]);
		expect(formulas('$a\\$b$')).toEqual([{ type: "inlineMath", value: 'a\\$b' }]);
	});
	it("keeps multiline and opening-line display source", () => {
		expect(formulas('$$\nx^2\n$$\n\nafter')).toEqual([{ type: "math", value: "x^2" }]);
		expect(formulas('$$x^2$$\n\nafter')).toEqual([{ type: "inlineMath", value: "x^2" }]);
		expect(markdownPreview('$$x^2$$\n\nafter')).toContain("after");
	});
	it("keeps escaped currency, ordinary code, and unmatched delimiters literal", () => {
		for (const source of ['\\$5 and \\$10', '`$x$`', '```text\n$x$\n```', '$unfinished', '$`unfinished', '\\$x\\$']) expect(formulas(source)).toEqual([]);
	});
	it("excludes math from notification spans and keeps source in previews", () => {
		const source = 'u/visible $u/hidden$ $`u/protected`$\n\n$$\nu/block\n$$\n\n```math\nu/fenced\n```';
		expect(markdownTextSpans(source).map(({ start, end }) => source.slice(start, end)).join("")).toBe('u/visible  ');
		expect(markdownPreview('$x_1$')).toBe('x_1');
	});
	it("supports formulas in lists, links, and escaped marker contexts", () => {
		expect(formulas('- $x$\n- $`y_$z`$')).toHaveLength(2);
		expect(formulas('[label $x$](https://example.com)')).toHaveLength(1);
	});
	it("bounds repeated unmatched protected openers without changing ordinary math", () => {
		const source = '$`a '.repeat(4000);
		const start = performance.now();
		expect(formulas(source)).toEqual([]);
		expect(performance.now() - start).toBeLessThan(1000);
		expect(formulas(source + '$z$')).toEqual([{type:'inlineMath',value:'z'}]);
		expect(formulas('$`unclosed\n\n$`x`$')).toEqual([{type:'inlineMath',value:'x'}]);
		expect(formulas('$`unclosed \\`$ still unclosed')).toEqual([]);
	});

});
