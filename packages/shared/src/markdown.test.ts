import { describe, it, expect } from "vitest";
import { markdownPreview } from "./markdown";
import { extractMentionCandidates, extractCanonicalMentionHandles, rewriteMentions } from "./mentions";
describe("Markdown mentions", () => {
	it("ignores code, links, images, HTML and diagram source", () => {
		const body = '**@alice** u/bob\n\n`@inline u/inline` [@link u/link](https://example.com) ![@image](x)\n\n<div>@html u/html</div>\n\n```svg\n<svg><text>@svg u/svg</text></svg>\n```\n\n```mermaid\ngraph TD; A[@graph u/graph]\n```';
		expect(extractMentionCandidates(body, "markdown").map((item) => item.handle)).toEqual(["alice"]);
		expect(extractCanonicalMentionHandles(body, "markdown")).toEqual(["bob"]);
	});
	it("rewrites only original source positions, preserving escapes and entities", () => {
		const body = '**@alice** &amp; \\@alice &#64;alice `@alice`\n\n@alice';
		const candidates = extractMentionCandidates(body, "markdown");
		expect(candidates).toHaveLength(2);
		expect(rewriteMentions(body, candidates, new Map([["alice", { botId: "b", handle: "alice" }]]))).toBe('**u/alice** &amp; \\@alice &#64;alice `@alice`\n\nu/alice');
		expect(extractCanonicalMentionHandles('u\\/alice &#117;/alice u/alice', "markdown")).toEqual(["alice"]);
	});
	it("projects snippets without rendering SVG or Mermaid source", () => {
		expect(markdownPreview('**hello**\nworld')).toBe("hello world");
		expect(markdownPreview('```svg\n<svg>')).toBe("[SVG drawing]");
	});
});
