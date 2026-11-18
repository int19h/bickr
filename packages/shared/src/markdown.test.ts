import { describe, it, expect } from "vitest";
import { markdownDrawings, markdownMedia, markdownPreview } from "./markdown";
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

describe("Markdown media", () => {
	it("lists images and drawings in document order and numbers the drawings", () => {
		const source = "![a](https://x.example/a.png)\n\n- item\n\n  ```mermaid\n  graph TD; A-->B\n  ```\n\n```js\nnot a drawing\n```\n\n```svg\n<svg/>\n```";
		const media = markdownMedia(source);
		expect(media.map((item) => item.kind === "image" ? `image:${item.url}` : `${item.language}:${item.index}:${item.source}`)).toEqual([
			"image:https://x.example/a.png",
			"mermaid:0:graph TD; A-->B",
			"svg:1:<svg/>",
		]);
		const drawings = markdownDrawings(source);
		expect(drawings.map((drawing) => source.slice(drawing.start!, drawing.start! + 3))).toEqual(["```", "```"]);
	});
});
