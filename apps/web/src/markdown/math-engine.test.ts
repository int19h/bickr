import { describe, it, expect } from "vitest";
import { renderMath } from "./math-engine";
describe("MathJax conversion", () => {
	it("renders common TeX and AMS without external font references", () => {
		for (const source of ['E=mc^2', '\\frac{a}{b}', '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', '\\sum_{n=1}^{\\infty}n^{-2}', '\\sqrt{\\$4}']) {
			const result = renderMath(source, false); expect(result.kind, source).toBe("rendered");
			if (result.kind === "rendered") { expect(result.svg).toContain('<path'); expect(result.svg).not.toMatch(/href=|<use/); }
		}
	});
	it("fails on invalid or unsafe TeX and oversized input", () => {
		for (const source of ['\\undefinedCommand', '\\frac{a}', '\\href{https://example.com}{x}', '\\require{html}', '\\style{color:red}{x}', 'x'.repeat(16385), '\\def\\a{\\a}\\a']) expect(renderMath(source, false).kind, source).toBe("rejected");
	});
	it("does not retain definitions or equation counters across expressions", () => {
		expect(renderMath('\\newcommand{\\foo}{x}\\foo', false).kind).toBe("rendered");
		expect(renderMath('\\foo', false).kind).toBe("rejected");
		expect(renderMath('\\newcommand{\\foo}{y}\\foo', false).kind).toBe("rendered");
	});
});
