// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderMath } from "./math-engine";
import { prepareMathSvg } from "./math-svg";
const svg = (body: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="10ex" height="3ex" viewBox="0 -1000 4000 1500" ${attrs}>${body}</svg>`;
describe("bounded MathJax SVG", () => {
	it("accepts real MathJax output and removes metadata", () => {
		for (const formula of ['x<0', 'a<b', '\\mathbb{R}', '\\mathfrak{g}', '\\mathbf{A}', 'E=mc^2', '\\frac{a}{b}', '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', '\\sum_{n=1}^{\\infty} n^{-2}']) {
			const rendered = renderMath(formula, true); expect(rendered.kind).toBe("rendered");
			if (rendered.kind === "rendered") { const result = prepareMathSvg(rendered.svg);; expect(result.kind, formula).toBe("ready"); if (result.kind === "ready") expect(result.fragment.querySelector('[data-latex]')).toBeNull(); }
		}
	});
	it("rejects resources, scripts, unsafe style, and excessive geometry", () => {
		for (const markup of [svg('<script>alert(1)</script>'), svg('<image href="https://example.invalid/a"/>'), svg('<path d="M0 0" onclick="x()"/>'), svg('<path d="M1000000000 0"/>'), svg('', 'style="position:fixed"'), svg('', 'style="vertical-align: -100000ex;"'), svg('x'.repeat(524288))]) expect(prepareMathSvg(markup).kind).toBe("rejected");
	});
	it("rejects huge dimensions from short valid TeX", () => {
		for (const formula of ['\\rule{100000000em}{100000000em}', '\\kern1000000em x', '\\raise1000000em\\hbox{x}']) {
			const rendered = renderMath(formula, true); if (rendered.kind === "rendered") expect(prepareMathSvg(rendered.svg).kind, formula).toBe("rejected");
		}
	});
});
