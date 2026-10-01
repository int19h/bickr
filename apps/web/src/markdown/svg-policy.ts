import DOMPurify from "dompurify";

const svgNamespace = "http://www.w3.org/2000/svg";
const xlinkNamespace = "http://www.w3.org/1999/xlink";
export const svgLimits = { sourceBytes: 65_536, elements: 1500, depth: 32, expandedElements: 5000, geometryBytes: 65_536, expandedGeometryBytes: 262_144 } as const;
const tags = new Set(["svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "use"]);
const numeric = new Set("x y x1 y1 x2 y2 cx cy r rx ry width height dx dy stroke-width stroke-miterlimit stroke-dashoffset opacity fill-opacity stroke-opacity stop-opacity offset font-size textLength pathLength".split(" "));
const enums: Record<string, readonly string[]> = {
	"fill-rule": ["nonzero", "evenodd"], "clip-rule": ["nonzero", "evenodd"], "stroke-linecap": ["butt", "round", "square"], "stroke-linejoin": ["miter", "round", "bevel"],
	"text-anchor": ["start", "middle", "end"], "dominant-baseline": ["auto", "middle", "central", "hanging", "alphabetic", "text-before-edge", "text-after-edge"],
	"font-style": ["normal", "italic", "oblique"], "font-weight": ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"],
	"gradientUnits": ["userSpaceOnUse", "objectBoundingBox"], "spreadMethod": ["pad", "reflect", "repeat"], "clipPathUnits": ["userSpaceOnUse", "objectBoundingBox"], "maskUnits": ["userSpaceOnUse", "objectBoundingBox"], "maskContentUnits": ["userSpaceOnUse", "objectBoundingBox"], "lengthAdjust": ["spacing", "spacingAndGlyphs"],
};
const references = new Set(["fill", "stroke", "clip-path", "mask", "href", "xlink:href", "aria-labelledby", "aria-describedby"]);
const allowedAttrs = ["xmlns", "xmlns:xlink", "id", ...numeric, ...Object.keys(enums), ...references, "stop-color", "color", "d", "points", "viewBox", "preserveAspectRatio", "transform", "gradientTransform", "stroke-dasharray", "font-family", "role", "aria-label"];

export type SvgResult = { kind: "ready"; fragment: DocumentFragment } | { kind: "rejected"; reason: string };
class SvgPolicyError extends Error {}
function reject(reason: string): never { throw new SvgPolicyError(reason); }
const numberSource = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const singleNumber = new RegExp(`^${numberSource}(?:px|%)?$`);
const numberTokens = new RegExp(numberSource, "g");
function boundedNumbers(value: string): boolean {
	const tokens = value.match(numberTokens);
	return Boolean(tokens?.length && tokens.every((token) => Number.isFinite(Number(token)) && Math.abs(Number(token)) <= 1_000_000));
}
function numberList(value: string): boolean { return /^[\d\s.,eE+\-]+$/.test(value) && boundedNumbers(value); }
function textBytes(element: Element): number {
	return Array.from(element.childNodes).filter((node) => node.nodeType === 3 || node.nodeType === 4).reduce((sum, node) => sum + new TextEncoder().encode(node.textContent ?? "").length, 0);
}
function paint(value: string): boolean {
	return /^(?:[a-z]+|#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-]+\))$/i.test(value);
}
function referenceIds(name: string, value: string): string[] | null {
	if (name === "aria-labelledby" || name === "aria-describedby") return /^[A-Za-z_][\w.-]*(?:\s+[A-Za-z_][\w.-]*)*$/.test(value) ? value.split(/\s+/) : null;
	if (name === "href" || name === "xlink:href") return /^#[A-Za-z_][\w.-]*$/.test(value) ? [value.slice(1)] : null;
	const match = /^url\(#([A-Za-z_][\w.-]*)\)$/.exec(value);
	return match ? [match[1]!] : null;
}
function permittedTarget(name: string, owner: Element, target: Element): boolean {
	const tag = target.localName;
	if (name === "aria-labelledby" || name === "aria-describedby") return tag === "title" || tag === "desc" || tag === "text";
	if (name === "fill" || name === "stroke") return tag === "linearGradient" || tag === "radialGradient";
	if (name === "clip-path") return tag === "clipPath";
	if (name === "mask") return tag === "mask";
	if (owner.localName === "use") return ["g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text"].includes(tag);
	return ["linearGradient", "radialGradient"].includes(owner.localName) && ["linearGradient", "radialGradient"].includes(tag);
}

/** DOMPurify is the final boundary. This policy additionally forbids CSS and
 * all resource requests, which an XSS sanitizer alone does not prevent. */
export function prepareSvg(source: string, prefix: string): SvgResult {
	try {
		if (new TextEncoder().encode(source).length > svgLimits.sourceBytes) reject("SVG source exceeds 64 KiB.");
		if (/<!DOCTYPE|<!ENTITY|<\?/i.test(source)) reject("SVG document declarations are not supported.");
		const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
		if (parsed.querySelector("parsererror")) reject("SVG source is not well formed.");
		let root: Element = parsed.documentElement;
		// Inspect the inert XML tree before any node enters the page document.
		if (root.localName !== "svg" || (root.namespaceURI && root.namespaceURI !== svgNamespace)) reject("The block must contain one SVG root.");
		const omittedNamespace = !root.namespaceURI;
		const elements: Element[] = [];
		function collect(element: Element, depth: number): void {
			if (depth > svgLimits.depth || elements.length >= svgLimits.elements) reject("SVG structure exceeds the rendering limit.");
			if ((element.namespaceURI !== svgNamespace && !(omittedNamespace && !element.namespaceURI)) || !tags.has(element.localName)) reject(`SVG element ${element.localName} is not supported.`);
			if (element !== root && element.localName === "svg") reject("Nested SVG roots are not supported.");
			elements.push(element);
			for (const child of element.children) collect(child, depth + 1);
		}
		collect(root, 1);
		const ids = new Map<string, Element>();
		for (const element of elements) {
			const id = element.getAttribute("id");
			if (id) {
				if (!/^[A-Za-z_][\w.-]*$/.test(id) || ids.has(id)) reject("SVG IDs must be unique simple names.");
				ids.set(id, element);
			}
		}
		const edges = new Map<Element, Element[]>(elements.map((element) => [element, Array.from(element.children)]));
		let geometryBytes = 0;
		for (const element of elements) for (const attr of Array.from(element.attributes)) {
			const { name, value } = attr;
			if (!allowedAttrs.includes(name) || (attr.namespaceURI && !["http://www.w3.org/2000/xmlns/", xlinkNamespace].includes(attr.namespaceURI))) reject(`SVG attribute ${name} is not supported.`);
			if (value.length > 65_536) reject("SVG attribute exceeds the rendering limit.");
			if (name === "xmlns" || name === "xmlns:xlink") {
				if (value !== (name === "xmlns" ? svgNamespace : xlinkNamespace)) reject("SVG namespace is not supported.");
			} else if (name === "id") {
				element.setAttribute(name, `${prefix}-${value}`);
			} else if (references.has(name)) {
				if (["fill", "stroke"].includes(name) && paint(value)) continue;
				if (!["href", "xlink:href", "aria-labelledby", "aria-describedby"].includes(name) && value === "none") continue;
				const names = referenceIds(name, value);
				if (!names) reject("SVG resources must use local fragment references.");
				for (const id of names) {
					const target = ids.get(id);
					if (!target || !permittedTarget(name, element, target)) reject("SVG reference target is missing or unsupported.");
					// Accessibility labels do not instantiate drawing geometry.
					if (!name.startsWith("aria-")) edges.get(element)!.push(target);
				}
				const rewritten = names.map((id) => `${prefix}-${id}`);
				const result = name.startsWith("aria-") ? rewritten.join(" ") : name === "href" || name === "xlink:href" ? `#${rewritten[0]}` : `url(#${rewritten[0]})`;
				if (attr.namespaceURI === xlinkNamespace) element.setAttributeNS(xlinkNamespace, name, result); else element.setAttribute(name, result);
			} else if (numeric.has(name)) {
				if (!singleNumber.test(value) || !boundedNumbers(value)) reject(`SVG ${name} must be a bounded number.`);
			} else if (enums[name]) {
				if (!enums[name]!.includes(value)) reject(`SVG ${name} value is not supported.`);
			} else if (["color", "stop-color"].includes(name)) {
				if (!paint(value)) reject("SVG color value is not supported.");
			} else if (name === "d") {
				geometryBytes += value.length;
				if (!/^[MmZzLlHhVvCcSsQqTtAa\d\s.,eE+\-]*$/.test(value) || (value && !boundedNumbers(value))) reject("SVG path data is not supported.");
			} else if (["points", "viewBox", "stroke-dasharray"].includes(name)) {
				if (name === "points") geometryBytes += value.length;
				if (!(name === "stroke-dasharray" && value === "none") && !numberList(value)) reject(`SVG ${name} must contain bounded numbers.`);
			} else if (["transform", "gradientTransform"].includes(name)) {
				if (!/^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([\d\s.,eE+\-]+\)\s*)+$/.test(value) || !boundedNumbers(value)) reject("SVG transform is not supported.");
			} else if (name === "font-family") {
				if (!/^[\p{Letter}\p{Number}\s,'"_-]{1,150}$/u.test(value)) reject("SVG font family is not supported.");
			} else if (name === "preserveAspectRatio") {
				if (!/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)$/.test(value)) reject("SVG aspect ratio is not supported.");
			} else if (name === "role" && value !== "img") reject("SVG role must be img.");
			else if (name === "aria-label" && value.length > 1000) reject("SVG label exceeds the rendering limit.");
		}
		geometryBytes += elements.reduce((sum, element) => sum + textBytes(element), 0);
		if (geometryBytes > svgLimits.geometryBytes) reject("SVG geometry data exceeds 64 KiB.");
		const active = new Set<Element>();
		const weights = new Map<Element, { elements: number; geometryBytes: number }>();
		function weight(element: Element): { elements: number; geometryBytes: number } {
			const memo = weights.get(element); if (memo) return memo;
			if (active.has(element)) reject("SVG references must not form cycles.");
			active.add(element);
			const result = { elements: 1, geometryBytes: (element.getAttribute("d")?.length ?? 0) + (element.getAttribute("points")?.length ?? 0) + textBytes(element) };
			for (const target of edges.get(element)!) {
				const child = weight(target); result.elements += child.elements; result.geometryBytes += child.geometryBytes;
				if (result.elements > svgLimits.expandedElements || result.geometryBytes > svgLimits.expandedGeometryBytes) reject("SVG reference expansion exceeds the rendering limit.");
			}
			active.delete(element); weights.set(element, result); return result;
		}
		weight(root);
		let viewBox = root.getAttribute("viewBox");
		if (!viewBox) {
			const width = Number(root.getAttribute("width")?.replace(/px$/, "") ?? 300);
			const height = Number(root.getAttribute("height")?.replace(/px$/, "") ?? 150);
			if (!(width > 0 && height > 0 && width <= 10_000 && height <= 10_000)) reject("SVG needs a valid viewBox or finite dimensions.");
			viewBox = `0 0 ${width} ${height}`; root.setAttribute("viewBox", viewBox);
		}
		const coordinates = viewBox.trim().split(/[\s,]+/).map(Number);
		if (coordinates.length !== 4 || !(coordinates[2]! > 0 && coordinates[3]! > 0)) reject("SVG viewBox must contain four numbers with positive dimensions.");
		root.setAttribute("width", "100%"); root.setAttribute("height", "100%"); root.setAttribute("role", "img");
		if (!root.hasAttribute("aria-label") && !root.hasAttribute("aria-labelledby")) root.setAttribute("aria-label", root.querySelector("title")?.textContent ?? "SVG drawing");
		// Create page-document nodes only after the complete tree passes policy.
		// XMLSerializer namespace repair differs across browser engines.
		if (!root.namespaceURI) {
			let copied = 0;
			function namespaceCopy(element: Element, depth: number): Element {
				if (++copied > svgLimits.elements || depth > svgLimits.depth) reject("SVG structure exceeds the rendering limit.");
				const copy = document.createElementNS(element.namespaceURI || svgNamespace, element.localName);
				for (const attr of Array.from(element.attributes)) copy.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
				for (const child of element.childNodes) copy.appendChild(child.nodeType === 1 ? namespaceCopy(child as Element, depth + 1) : child.cloneNode(true));
				return copy;
			}
			root = namespaceCopy(root, 1);
		}
		const fragment = DOMPurify.sanitize(root, { ALLOWED_TAGS: [...tags], ALLOWED_ATTR: [...allowedAttrs], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true });
		if (fragment.childElementCount !== 1 || fragment.firstElementChild?.localName !== "svg") reject("SVG could not be rendered safely.");
		return { kind: "ready", fragment };
	} catch (error) {
		return { kind: "rejected", reason: error instanceof SvgPolicyError ? error.message : "SVG could not be rendered safely." };
	}
}
