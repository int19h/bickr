// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { prepareSvg } from "./svg-policy";
const drawing = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
describe("inline SVG policy", () => {
	it("preserves paths, text and local gradients with isolated IDs", () => {
		const source = drawing('<title id="label">Chart</title><defs><linearGradient id="paint"><stop offset="0%" stop-color="red"/></linearGradient></defs><path d="M0 0L100 100" stroke="url(#paint)"/><text x="10" y="20">hello</text>');
		const result = prepareSvg(source, "first"); expect(result.kind).toBe("ready");
		if (result.kind !== "ready") return;
		expect(result.fragment.querySelector("linearGradient")?.id).toBe("first-paint");
		expect(result.fragment.querySelector("path")?.getAttribute("stroke")).toBe("url(#first-paint)");
		expect(result.fragment.querySelector("svg")?.getAttribute("width")).toBe("100%");
	});
	it("accepts an SVG root without xmlns", () => { expect(prepareSvg('<svg viewBox="0 0 10 10"><circle r="5"/></svg>', "x").kind).toBe("ready"); });
	it("rejects active markup, CSS, foreign resources and malformed roots", () => {
		for (const body of ['<script>alert(1)</script>', '<rect onload="alert(1)"/>', '<foreignObject><div>html</div></foreignObject>', '<style>body{display:none}</style>', '<path style="fill:red"/>', '<image href="https://example.com/x"/>', '<use href="https://example.com/x#y"/>', '<a href="https://example.com">x</a>', '<animate attributeName="x"/>', '<path fill="url(https://example.com/x)"/>', '<path fill="var(--secret)"/>']) expect(prepareSvg(drawing(body), "x").kind, body).toBe("rejected");
		for (const source of ['<svg>', '<html/>', '<!DOCTYPE svg><svg/>', '<svg/><svg/>']) expect(prepareSvg(source, "x").kind).toBe("rejected");
	});
	it("rejects duplicate IDs, missing targets, incorrect targets and reference cycles", () => {
		for (const body of ['<g id="a"/><g id="a"/>', '<use href="#missing"/>', '<path id="a"/><path fill="url(#a)"/>', '<g id="a"><use href="#a"/></g>', '<defs><linearGradient id="a" href="#b"/><linearGradient id="b" href="#a"/></defs>']) expect(prepareSvg(drawing(body), "x").kind, body).toBe("rejected");
	});
	it("bounds repeated path geometry even below the expanded element limit", () => {
		const path = 'M0 0' + 'L1 1'.repeat(3000);
		const body = `<defs><path id="p" d="${path}"/></defs>` + '<use href="#p"/>'.repeat(30);
		expect(prepareSvg(drawing(body), "x")).toMatchObject({ kind: "rejected", reason: expect.stringContaining("expansion") });
	});
});
