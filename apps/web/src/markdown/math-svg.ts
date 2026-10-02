import DOMPurify from "dompurify";
import { mathLimits } from "./math-protocol";
const namespace = "http://www.w3.org/2000/svg";
const tags = ["svg", "g", "path", "rect", "line", "text", "tspan"];
const attributes = ["xmlns", "viewBox", "width", "height", "d", "x", "y", "x1", "x2", "y1", "y2", "transform", "fill", "stroke", "stroke-width", "focusable", "role", "style", "aria-hidden"];
export type MathSvgResult = { kind: "ready"; fragment: DocumentFragment } | { kind: "rejected" };
function boundedNumbers(value: string): boolean {
	return (value.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? []).every((part) => Number.isFinite(Number(part)) && Math.abs(Number(part)) <= mathLimits.coordinate);
}
function dimension(value: string | null, limit: number): boolean {
	return !!value && /^(?:\d+\.?\d*|\.\d+)ex$/.test(value) && parseFloat(value) > 0 && parseFloat(value) <= limit;
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
		for (const attr of Array.from(element.attributes)) {
			const { name, value } = attr;
			// MathJax metadata does not affect rendering and never enters the page.
			if (name.startsWith("data-") || name === "aria-labelledby") { element.removeAttribute(name); continue; }
			if (!attributes.includes(name)) return { kind: "rejected" };
			if (name === "style") {
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
