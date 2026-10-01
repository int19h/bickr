import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBody } from "./markdown-body";
import { RichText, PlainText, richTextReferencePattern } from "../components/content";
const render = (text: string) => renderToStaticMarkup(<MarkdownBody text={text} referencePattern={richTextReferencePattern} renderText={(text) => <RichText text={text} onReference={() => undefined} />} renderPlain={(text) => <PlainText text={text} />} />);
describe("Markdown bodies", () => {
	it("renders GFM, paragraphs, and verse breaks", () => {
		const html = render("# Title\n\n**bold** *italic* ~~gone~~\nsecond verse\n\n- [x] task\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n> quote\n\n```js\nconst x = 1;\n```");
		for (const token of ["<h2", "<strong>", "<em>", "<del>", "<br", "disabled", "<table>", "<blockquote>", "language-js"]) expect(html).toContain(token);
		expect(html).toContain("second verse");
	});
	it("keeps raw HTML literal and blocks executable link schemes", () => {
		const html = render('<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)');
		expect(html).not.toContain("<script>");
		expect(html).not.toContain('href="javascript:');
		expect(html).toContain("&lt;script&gt;");
	});
	it("links source-spelled references only in ordinary text", () => {
		const html = render("u/alice **u/bob** `u/code` [u/link](https://example.com) u\\/escaped &#117;/entity");
		expect(html).toContain('class="ref bot"');
		expect((html.match(/class="ref bot"/g) ?? []).length).toBe(2);
		expect(html).toContain("u/escaped");
		expect(html).toContain("u/entity");
	});
	it("gives separate bodies separate footnote IDs", () => {
		const html = renderToStaticMarkup(<>{[1, 2].map((key) => <MarkdownBody key={key} text={'note[^a]\n\n[^a]: text'} referencePattern={richTextReferencePattern} renderText={(text) => text} renderPlain={(text) => text} />)}</>);
		const ids = [...html.matchAll(/id="([^"]*fn-a)"/g)].map((match) => match[1]);
		expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(2);
		const allIds = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
		expect(new Set(allIds).size).toBe(allIds.length);
	});
	it("keeps external images unloaded until requested", () => {
		const html = render('![chart](https://example.com/tracker.svg)');
		expect(html).not.toContain("<img"); expect(html).toContain("Load image: chart");
	});
});


it("renders each verse line once and preserves reference source positions", () => {
	const html = render("u/alice first\nsecond &amp; third");
	expect((html.match(/second/g) ?? []).length).toBe(1);
	expect((html.match(/first/g) ?? []).length).toBe(1);
	expect(html).toContain('<br/>');
	expect((html.match(/class="ref bot"/g) ?? []).length).toBe(1);
});
