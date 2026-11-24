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
	it("rejects foreign elements before namespace repair and disallows markers", () => {
		for (const source of ['<svg viewBox="0 0 10 10"><img xmlns="http://www.w3.org/1999/xhtml" src="https://example.com/pixel"/></svg>', drawing('<marker id="m"><circle r="2"/></marker>'), drawing('<path d="M0 0L1 1" marker-mid="url(#m)"/>')]) expect(prepareSvg(source, "x").kind).toBe("rejected");
	});
	it("bounds expansion of polygon and text data", () => {
		for (const geometry of ['<polyline points="' + '0,0 '.repeat(3000) + '"/>', '<text>' + 'x'.repeat(12000) + '</text>']) {
			const source = drawing('<defs><g id="g">' + geometry + '</g></defs>' + '<use href="#g"/>'.repeat(30));
			expect(prepareSvg(source, "x")).toMatchObject({ kind: "rejected", reason: expect.stringContaining("expansion") });
		}
	});
	it("counts UTF-8 text bytes in reference expansion", () => {
		const source = drawing('<defs><text id="t">' + '字'.repeat(4000) + '</text></defs>' + '<use href="#t"/>'.repeat(30));
		expect(prepareSvg(source, "x")).toMatchObject({ kind: "rejected", reason: expect.stringContaining("expansion") });
	});
});

describe("inline SVG attribute values", () => {
	const ready = (body: string) => prepareSvg(drawing(body), "x");
	const accepts = (bodies: string[]) => { for (const body of bodies) expect(ready(body).kind, body).toBe("ready"); };
	const rejects = (bodies: string[]) => { for (const body of bodies) expect(ready(body).kind, body).toBe("rejected"); };
	/** Asserts that sanitizing kept every attribute of every element, not only that the drawing passed. */
	const retains = (bodies: string[]) => {
		for (const body of bodies) {
			const result = ready(body); expect(result.kind, body).toBe("ready");
			if (result.kind !== "ready") continue;
			const input = new DOMParser().parseFromString(drawing(body), "image/svg+xml").querySelectorAll("svg *");
			const output = result.fragment.querySelectorAll("svg *");
			expect(output.length, body).toBe(input.length);
			input.forEach((element, index) => {
				for (const attr of Array.from(element.attributes)) if (attr.name !== "id" && !/url\(#|^#/.test(attr.value)) expect(output[index]!.getAttributeNS(attr.namespaceURI, attr.localName), `${body} ${attr.name}`).toBe(attr.value);
			});
		}
	};

	it("keeps letter and word spacing on text, spans and groups", () => {
		// The shape of a published drawing that failed only on letter-spacing.
		const result = ready('<text x="600" y="55" font-family="monospace" font-size="23" font-weight="bold" text-anchor="middle" letter-spacing="2">LABEL</text>');
		expect(result.kind).toBe("ready");
		if (result.kind === "ready") expect(result.fragment.querySelector("text")?.getAttribute("letter-spacing")).toBe("2");
		retains(['<g letter-spacing="-1.5"><text>a<tspan letter-spacing="normal">b</tspan></text></g>', '<text letter-spacing="2px" word-spacing=".1em">a b</text>', '<text word-spacing="normal">a</text>']);
		rejects(['<text letter-spacing="2%">a</text>', '<text letter-spacing="2pt">a</text>', '<text letter-spacing="2 3">a</text>', '<text letter-spacing="calc(1px)">a</text>', '<text word-spacing="inherit">a</text>']);
	});

	it("accepts and keeps the static text, paint and gradient keywords", () => {
		retains([
			'<text text-decoration="underline" direction="rtl" writing-mode="vertical-rl" dominant-baseline="ideographic">a</text>',
			'<text alignment-baseline="middle">a<tspan baseline-shift="super">2</tspan><tspan baseline-shift="-3">3</tspan></text>',
			'<text rotate="0 15 -30">abc</text>', '<text xml:space="preserve">a  b</text>',
			'<path d="M0 0L1 1" paint-order="stroke fill" shape-rendering="crispEdges" vector-effect="non-scaling-stroke" stroke-linejoin="bevel"/>',
			'<defs><radialGradient id="g" fx="30%" fy="-5" fr="0" color-interpolation="linearRGB"><stop offset="1"/></radialGradient></defs><rect width="5" height="5" fill="url(#g)"/>',
		]);
		rejects(['<text text-decoration="underline red">a</text>', '<text writing-mode="sideways">a</text>', '<path paint-order="stroke stroke"/>', '<path paint-order="normal fill"/>', '<path vector-effect="fixed-position"/>', '<text xml:space="keep">a</text>', '<text xml:lang="en">a</text>', '<text lang="en">a</text>', '<g visibility="hidden"/>', '<g display="none"/>']);
	});

	it("keeps the XML namespace of xml:space through sanitizing", () => {
		for (const source of [drawing('<text xml:space="preserve">a  b</text>'), '<svg viewBox="0 0 10 10"><text xml:space="preserve">a  b</text></svg>']) {
			const result = prepareSvg(source, "x"); expect(result.kind).toBe("ready");
			if (result.kind === "ready") expect(result.fragment.querySelector("text")?.getAttributeNS("http://www.w3.org/XML/1998/namespace", "space")).toBe("preserve");
		}
	});

	it("parses colors instead of accepting any word or function", () => {
		accepts(['<path fill="currentColor" stroke="inherit" color="RebeccaPurple"/>', '<path fill="#abc" stroke="#abcd"/>', '<path fill="#a1b2c3" stroke="#a1b2c3d4"/>', '<path fill="rgb(1, 2, 3)" stroke="rgba(10%, 20%, 30%, .5)"/>', '<path fill="rgb(1 2 3 / 50%)" stroke="hsl(120deg 50% 50%)"/>', '<path fill="hsla(120, 50%, 50%, 0.3)" stroke="transparent"/>', '<stop stop-color="red" offset="0"/>']);
		rejects(['<path fill="#12345"/>', '<path fill="bogus"/>', '<path fill="unset"/>', '<path fill="rgb(1, 2)"/>', '<path fill="rgb(1 2 3 4)"/>', '<path fill="rgb(1, 2 3)"/>', '<path fill="rgb(var(--x))"/>', '<path fill="url(#g) red"/>', '<stop stop-color="none"/>']);
	});

	it("applies each length grammar with its own units", () => {
		accepts(['<path opacity="50%" fill-opacity=".5" stroke-dasharray="2px 3px"/>', '<path stroke-dasharray="none"/>', '<path stroke-dasharray="1, 2 ,3"/>', '<text font-size="1.2em">a<tspan font-size="120%">b</tspan></text>', '<text x="10 20 30" y="5" dy="1.2em">abc</text>', '<rect rx="auto" width="1" height="1"/>']);
		rejects(['<path opacity="1px"/>', '<stop offset="3px"/>', '<path stroke-dasharray="2,,3"/>', '<path stroke-dasharray="' + '1 '.repeat(65) + '"/>', '<text font-size="1e7em">a</text>', '<path stroke-linejoin="arcs"/>', '<rect x="10 20" width="1" height="1"/>', '<rect width="2em" height="1"/>', '<path stroke-width="1e7"/>']);
	});

	it("parses viewBox, points and transform lists", () => {
		for (const viewBox of ["e 0 10 10", "0,,0 10 10", "0 0 -1 10", "0 0 10", "0-1 10 10", "0 0 1e-50 5", "0 0 5 1e-50"]) expect(prepareSvg(`<svg viewBox="${viewBox}"><rect width="1" height="1"/></svg>`, "x").kind, viewBox).toBe("rejected");
		expect(prepareSvg('<svg viewBox=" 0,0 10 10 "><rect width="1" height="1"/></svg>', "x").kind).toBe("ready");
		accepts(['<polygon points="0,0 1,1 2,0"/>', '<g transform="translate(1,2),scale(2)"/>', '<g transform="rotate(10 5 5) translate(1)matrix(1 0 0 1 0 0)"/>', '<g transform="skewX(5) skewY(-5)"/>']);
		rejects(['<polygon points="0,0 1"/>', '<g transform="rotate(1 2)"/>', '<g transform="matrix(1 0 0 1 0)"/>', '<g transform="rotate(1),"/>', '<g transform="rotate(1),,scale(2)"/>', '<g transform="perspective(1)"/>']);
		expect(prepareSvg(drawing('<rect width="1" height="1" preserveAspectRatio="xMidYMid  slice"/>'), "x").kind).toBe("ready");
	});

	it("counts text position lists in the expansion budget", () => {
		const positions = Array.from({ length: 1000 }, (_, index) => index).join(" ");
		const source = drawing(`<defs><g id="g">${`<text x="${positions}">a</text>`.repeat(4)}</g></defs>` + '<use href="#g"/>'.repeat(30));
		expect(prepareSvg(source, "x")).toMatchObject({ kind: "rejected", reason: expect.stringContaining("expansion") });
		expect(ready(`<text x="${positions} 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25"/>`).kind).toBe("rejected");
	});
	it("matches CSS keywords without regard to case and SVG keywords exactly", () => {
		retains(['<path fill="NONE" stroke="InHerit" stroke-linecap="ROUND" paint-order="Stroke"/>', '<stop stop-color="INHERIT" offset="0"/>', '<text font-weight="BOLD" letter-spacing="Normal" dominant-baseline="Central">a</text>']);
		// U+212A KELVIN SIGN folds to k only under Unicode rules, which CSS does not use.
		rejects(['<path fill="blac\u212A"/>', '<path paint-order="stro\u212Ae"/>', '<linearGradient gradientUnits="userspaceonuse"/>', '<text xml:space="PRESERVE">a</text>', '<rect width="1" height="1" preserveAspectRatio="xmidymid"/>']);
	});

	it("uses the CSS number form for presentation values and channel rules for colors", () => {
		rejects(['<text letter-spacing="1.px">a</text>', '<path fill="rgb(1. 2 3)"/>', '<path fill="rgb(10%, 20, 30)"/>', '<path fill="hsl(120, 50, 50)"/>', '<path opacity="1."/>', '<text font-weight="400.">a</text>', '<path fill="CanvasText"/>']);
		retains(['<path fill="rgb(10% 20 30)" stroke="hsl(120 50 50 / .5)"/>', '<path fill="hsl(0.5turn, 50%, 50%)" stroke="rgb(1, 2, 3, 50%)"/>']);
		// Browsers ignore a trailing decimal point in every attribute except path data.
		rejects(['<rect x="1." width="2" height="3"/>', '<rect width="2." height="3"/>', '<circle r="1.px"/>', '<text x="1 2.">ab</text>', '<g transform="translate(1.)"/>', '<polyline points="1. 2 3 4"/>']);
		accepts(['<path d="M1. 2L3 4"/>']);
	});

	it("keeps separate keyword sets for the two baseline properties", () => {
		retains(['<text alignment-baseline="baseline">a</text>', '<text alignment-baseline="before-edge">a<tspan alignment-baseline="after-edge">b</tspan></text>', '<text alignment-baseline="auto" dominant-baseline="text-before-edge">a</text>']);
		rejects(['<text dominant-baseline="baseline">a</text>', '<text dominant-baseline="before-edge">a</text>', '<text dominant-baseline="use-script">a</text>']);
	});

	it("reads compact coordinate pairs and transform arguments", () => {
		retains(['<polyline points="10-5 20-10"/>', '<polygon points="1,-5,2e1 -3"/>', '<g transform="translate(10-5)rotate(1.5.5.5)"/>']);
		// Firefox reads no other compact point spelling.
		rejects(['<polyline points="10-5 20"/>', '<polyline points="1,,2 3 4"/>', '<polyline points="1 2,"/>', '<polygon points="1.5.5 2e1-3"/>', '<polyline points="10+5 20+10"/>', '<polyline points="10-5-20-10"/>']);
	});

	it("keeps the path rule of the earlier policy", () => {
		rejects(['<path d="M"/>', '<path d="  "/>', '<path d="M1e7 0"/>']);
		accepts(['<path d=""/>', '<path d="M0 0L1 1z"/>']);
	});

	it("parses root dimensions with the length grammar", () => {
		for (const [width, height] of [["10PX", "20"], ["10px ", " 20px"], ["10", "20"]]) {
			const result = prepareSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="1" height="1"/></svg>`, "x");
			expect(result.kind, width).toBe("ready");
			if (result.kind === "ready") expect(result.fragment.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 10 20");
		}
		for (const width of ["100%", "10em", "0", "20000", "1.", "1e-50"]) expect(prepareSvg(`<svg width="${width}" height="10"><rect width="1" height="1"/></svg>`, "x").kind, width).toBe("rejected");
	});

	it("rejects standalone CSS-wide keywords as font families", () => {
		rejects(['<text font-family="revert">a</text>', '<text font-family="Unset">a</text>', '<text font-family="revert-rule">a</text>', '<text font-family="revert, serif">a</text>', '<text font-family="inherit, serif">a</text>', '<text font-family="serif,">a</text>', '<text font-family="\u00a0Arial\u00a0">a</text>']);
		retains(['<text font-family="\'Revert Sans\', serif">a</text>', '<text font-family="inherit">a</text>', '<text font-family="\'revert\'">a</text>']);
	});

	it("parses long whitespace runs in linear time", () => {
		// Each fixture stays under the source limit, so its own value parser runs.
		const gap = " ".repeat(30_000);
		const started = performance.now();
		for (const [body, reason] of [
			[`<path fill="rgb(1,${gap}2,${gap}x)"/>`, "SVG fill must be a color or a local gradient."],
			[`<path stroke-dasharray="1${gap}x"/>`, "SVG stroke-dasharray must contain bounded numbers."],
			[`<path opacity="${gap}1${gap}x"/>`, "SVG opacity must be a bounded number."],
			[`<polyline points="1${gap}2${gap}x"/>`, "SVG points must contain coordinate pairs."],
			[`<g transform="rotate(1${gap}x)"/>`, "SVG transform must be a list of transform functions."],
		]) expect(prepareSvg(drawing(body!), "x")).toEqual({ kind: "rejected", reason });
		for (const body of [`<path fill="rgb(1,${gap}2,${gap}3)"/>`, `<path opacity="${gap}1${gap}"/>`]) expect(prepareSvg(drawing(body), "x").kind).toBe("ready");
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
