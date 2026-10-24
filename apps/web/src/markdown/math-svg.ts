import DOMPurify from "dompurify";
import { mathLimits } from "./math-protocol";
const namespace = "http://www.w3.org/2000/svg";
const tags = ["svg", "g", "path", "rect", "line", "text", "tspan"];
// The text/math font-command survey in math-svg.dom.test.tsx emits these
// generic families, italic, and bold. Normal style and weight are omitted.
const textFontAttributes = ["font-family", "font-style", "font-weight", "font-size"];
const attributes = ["xmlns", "viewBox", "width", "height", "d", "x", "y", "x1", "x2", "y1", "y2", "transform", "fill", "stroke", "stroke-width", "focusable", "role", "style", "aria-hidden", ...textFontAttributes];
export type MathSvgResult = { kind: "ready"; fragment: DocumentFragment } | { kind: "rejected" };
function boundedNumbers(value: string): boolean {
	return (value.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? []).every((part) => Number.isFinite(Number(part)) && Math.abs(Number(part)) <= mathLimits.coordinate);
}
function dimension(value: string | null, limit: number): boolean {
	return !!value && /^(?:\d+\.?\d*|\.\d+)ex$/.test(value) && parseFloat(value) > 0 && parseFloat(value) <= limit;
}
function textFontAttribute(name: string, value: string): boolean {
	switch (name) {
		case "font-family": return ["serif", "sans-serif", "monospace"].includes(value);
		case "font-style": return value === "italic";
		case "font-weight": return value === "bold";
		case "font-size": {
			const size = parseFloat(value);
			return /^(?:\d+(?:\.\d+)?|\.\d+)px$/.test(value) && Number.isFinite(size) && size > 0 && size <= mathLimits.fontSizePx;
		}
		default: return false;
	}
}
export function prepareMathSvg(markup: string): MathSvgResult {
	if (new TextEncoder().encode(markup).length > mathLimits.svgBytes || /<!|<\?/.test(markup)) return { kind: "rejected" };
	const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
	const svg = parsed.documentElement;
	if (parsed.querySelector("parsererror") || svg.localName !== "svg" || svg.namespaceURI !== namespace) return { kind: "rejected" };
	if (!dimension(svg.getAttribute("width"), mathLimits.widthEx) || !dimension(svg.getAttribute("height"), mathLimits.heightEx)) return { kind: "rejected" };
	const viewBox = svg.getAttribute("viewBox") ?? "";
	if (!/^[\d+eE.,\s-]+$/.test(viewBox) || viewBox.trim().split(/[,\s]+/).length !== 4 || !boundedNumbers(viewBox)) return { kind: "rejected" };
	const elements = [svg, ...svg.querySelectorAll("*")];
	if (elements.length > mathLimits.elements) return { kind: "rejected" };
	let pathBytes = 0;
	for (const element of elements) {
		let depth = 0;
		for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) if (++depth > 64) return { kind: "rejected" };
		if (element.namespaceURI !== namespace || !tags.includes(element.localName) || (element !== svg && element.localName === "svg")) return { kind: "rejected" };
		// MathJax fallback text contains character data only, with no tspan or
		// other nested elements. Keep the font exception on that exact shape.
		if (element.localName === "text" && Array.from(element.childNodes).some((child) => child.nodeType !== Node.TEXT_NODE)) return { kind: "rejected" };
		for (const attr of Array.from(element.attributes)) {
			const { name, value } = attr;
			// MathJax metadata does not affect rendering and never enters the page.
			if (name.startsWith("data-") || name === "aria-labelledby") { element.removeAttribute(name); continue; }
			if (!attributes.includes(name)) return { kind: "rejected" };
			if (textFontAttributes.includes(name)) {
				if (element.localName !== "text" || !textFontAttribute(name, value)) return { kind: "rejected" };
			} else if (name === "style") {
				if (element !== svg || !/^vertical-align:\s*(?:0|-?(?:\d+\.?\d*|\.\d+)ex);?$/.test(value) || Math.abs(parseFloat(value.split(":")[1]!)) > mathLimits.heightEx) return { kind: "rejected" };
			} else if (name === "fill" || name === "stroke") {
				if (!["currentColor", "none"].includes(value)) return { kind: "rejected" };
			} else if (["d", "transform", "x", "y", "x1", "x2", "y1", "y2", "stroke-width", ...(element === svg ? [] : ["width", "height"])].includes(name) && !boundedNumbers(value)) return { kind: "rejected" };
			if (name === "d") pathBytes += value.length;
		}
	}
	if (pathBytes > mathLimits.pathBytes) return { kind: "rejected" };
	svg.setAttribute("aria-hidden", "true");
	// DOMPurify normalizes its configuration arrays. Pass copies so later
	// formulas retain case-sensitive SVG attribute names such as viewBox.
	const fragment = DOMPurify.sanitize(new XMLSerializer().serializeToString(svg), { ALLOWED_TAGS: [...tags], ALLOWED_ATTR: [...attributes], ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true });
	return fragment.querySelector("svg") ? { kind: "ready", fragment } : { kind: "rejected" };
}
