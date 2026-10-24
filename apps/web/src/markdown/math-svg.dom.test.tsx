// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderMath } from "./math-engine";
import { prepareMathSvg } from "./math-svg";
import { mathLimits } from "./math-protocol";
const svg = (body: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="10ex" height="3ex" viewBox="0 -1000 4000 1500" ${attrs}>${body}</svg>`;
describe("bounded MathJax SVG", () => {
	it("accepts real MathJax output and removes metadata", () => {
		for (const formula of ['x<0', 'a<b', '\\mathbb{R}', '\\mathfrak{g}', '\\mathbf{A}', 'E=mc^2', '\\frac{a}{b}', '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', '\\sum_{n=1}^{\\infty} n^{-2}']) {
			const rendered = renderMath(formula, true); expect(rendered.kind).toBe("rendered");
			if (rendered.kind === "rendered") { const result = prepareMathSvg(rendered.svg);; expect(result.kind, formula).toBe("ready"); if (result.kind === "ready") expect(result.fragment.querySelector('[data-latex]')).toBeNull(); }
		}
	});
	it.each([false, true])("accepts fallback glyph formulas with display=%s", (display) => {
		for (const formula of [
			'l_п', '\\sigma_э = P_э / A = 65.7', 't = 0.544\\ \\text{с}',
			'\\kappa_т = \\frac{2\\sigma_т}{Ed}', '\\text{м}^{-1}',
			'U = 34.5\\ \\text{Дж}', '\\text{漢字}', '\\textbf{пример}', '\\texttt{пример}',
		]) {
			const rendered = renderMath(formula, display);
			expect(rendered.kind, formula).toBe("rendered");
			if (rendered.kind !== "rendered") continue;
			const result = prepareMathSvg(rendered.svg);
			expect(result.kind, formula).toBe("ready");
			if (result.kind === "ready") expect(result.fragment.querySelector("text")?.textContent).toBeTruthy();
		}
	});
	it("preserves the surveyed text and math font attributes through DOMPurify", () => {
		const families = new Set<string>();
		const styles = new Set<string>();
		const weights = new Set<string>();
		const sizes = new Set<string>();
		for (const command of ['', 'text', 'textrm', 'textit', 'textbf', 'textsf', 'texttt', 'mathrm', 'mathit', 'mathbf', 'mathsf', 'mathtt']) {
			for (const glyph of ['п', 'ϡ', 'ἀ', '漢', '😀']) {
				for (const display of [false, true]) {
					const source = command ? `\\${command}{${glyph}}` : glyph;
					const rendered = renderMath(source, display);
					expect(rendered.kind, source).toBe("rendered");
					if (rendered.kind !== "rendered") continue;
					const original = new DOMParser().parseFromString(rendered.svg, "image/svg+xml");
					expect(original.querySelector("tspan"), source).toBeNull();
					const result = prepareMathSvg(rendered.svg);
					expect(result.kind, source).toBe("ready");
					if (result.kind !== "ready") continue;
					const texts = result.fragment.querySelectorAll("text");
					expect(texts).toHaveLength(1);
					const text = texts[0]!;
					expect(text.textContent).toBe(glyph);
					expect(text.childElementCount).toBe(0);
					for (const { name, value } of Array.from(original.querySelector("text")!.attributes)) {
						expect(text.getAttribute(name), `${source}: ${name}`).toBe(value);
					}
					families.add(text.getAttribute("font-family")!);
					sizes.add(text.getAttribute("font-size")!);
					if (text.hasAttribute("font-style")) styles.add(text.getAttribute("font-style")!);
					if (text.hasAttribute("font-weight")) weights.add(text.getAttribute("font-weight")!);
				}
			}
		}
		expect(families).toEqual(new Set(["serif", "sans-serif", "monospace"]));
		expect(styles).toEqual(new Set(["italic"]));
		expect(weights).toEqual(new Set(["bold"]));
		expect(sizes).toEqual(new Set(["884px"]));
	});
	it("inherits currentColor when the surrounding theme color changes", () => {
		const rendered = renderMath('l_п', false);
		expect(rendered.kind).toBe("rendered");
		if (rendered.kind !== "rendered") return;
		const result = prepareMathSvg(rendered.svg);
		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") return;
		const host = document.createElement("div");
		host.append(result.fragment);
		document.body.append(host);
		try {
			const text = host.querySelector("text")!;
			expect(text.closest("[fill]")?.getAttribute("fill")).toBe("currentColor");
			for (const color of ["rgb(24, 24, 24)", "rgb(240, 240, 240)"]) {
				host.style.color = color;
				expect(getComputedStyle(text).color).toBe(color);
			}
		} finally { host.remove(); }
	});
	it("rejects font attributes outside text elements", () => {
		for (const attribute of ['font-family="serif"', 'font-style="italic"', 'font-weight="bold"', 'font-size="884px"']) {
			for (const markup of [svg('', attribute), ...["path", "g", "rect", "line", "tspan"].map((tag) => svg(`<${tag} ${attribute}/>`))]) {
				expect(prepareMathSvg(markup).kind, markup).toBe("rejected");
			}
		}
	});
	it("rejects unlisted font families, styles, and weights", () => {
		for (const [attribute, values] of [
			["font-family", ["Comic Sans", "&quot;Comic Sans&quot;", "'serif'", "serif;x", "url(x)", "serif,sans-serif", "Serif", "inherit"]],
			["font-style", ["normal", "oblique", "ITALIC", "inherit", "italic;x"]],
			["font-weight", ["normal", "bolder", "700", "BOLD", "inherit", "bold;x"]],
		] as const) {
			for (const value of values) {
				expect(prepareMathSvg(svg(`<text ${attribute}="${value}">п</text>`)).kind, `${attribute}=${value}`).toBe("rejected");
			}
		}
	});
	it("accepts only positive finite bounded pixel font sizes", () => {
		for (const size of ["884em", "884%", "884pt", "884", "-884px", "0px", "NaNpx", "Infinitypx", "1e3px", "884.px", "884px;x", `${mathLimits.fontSizePx + 1}px`, `${'9'.repeat(400)}px`]) {
			expect(prepareMathSvg(svg(`<text font-size="${size}">п</text>`)).kind, size).toBe("rejected");
		}
		for (const size of [".5px", "884px", "884.5px", `${mathLimits.fontSizePx}px`]) {
			const result = prepareMathSvg(svg(`<text font-size="${size}">п</text>`));
			expect(result.kind, size).toBe("ready");
			if (result.kind === "ready") expect(result.fragment.querySelector("text")?.getAttribute("font-size")).toBe(size);
		}
	});
	it("rejects child elements in fallback text", () => {
		for (const child of ['<tspan>п</tspan>', '<g/>', '<path d="M0 0"/>', '<text>п</text>']) {
			expect(prepareMathSvg(svg(`<text font-family="serif" font-size="884px">${child}</text>`)).kind).toBe("rejected");
		}
	});
	it("keeps geometry bounds and the existing fill rule on text", () => {
		for (const attrs of [`x="${mathLimits.coordinate + 1}"`, `y="-${mathLimits.coordinate + 1}"`, `transform="translate(${mathLimits.coordinate + 1},0)"`, 'fill="red"', 'fill="url(x)"']) {
			expect(prepareMathSvg(svg(`<text font-size="884px" ${attrs}>п</text>`)).kind, attrs).toBe("rejected");
		}
		const result = prepareMathSvg(svg('<text font-size="884px" font-family="serif" font-style="italic" font-weight="bold" transform="scale(1,-1)" x="10" y="20" fill="currentColor">п</text>'));
		expect(result.kind).toBe("ready");
		if (result.kind === "ready") {
			const text = result.fragment.querySelector("text")!;
			expect(text.getAttribute("font-style")).toBe("italic");
			expect(text.getAttribute("font-weight")).toBe("bold");
			expect(text.getAttribute("transform")).toBe("scale(1,-1)");
			expect(text.getAttribute("x")).toBe("10");
			expect(text.getAttribute("y")).toBe("20");
			expect(text.getAttribute("fill")).toBe("currentColor");
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
