import DOMPurify from "dompurify";

import { svgLimits } from "@bickr/shared/content-limits";
import { absoluteLength, attributeGeometryBytes, attributeSpec, checkAttribute, svgAttributeNames, svgNamespace } from "./svg-attributes";
export { svgLimits } from "@bickr/shared/content-limits";
const tags = new Set(["svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "use"]);

export type SvgResult = { kind: "ready"; fragment: DocumentFragment } | { kind: "rejected"; reason: string };
class SvgPolicyError extends Error {}
function reject(reason: string): never { throw new SvgPolicyError(reason); }
/** Geometry bytes of one element: its text and its geometry attributes. */
function elementGeometryBytes(element: Element): number {
	const text = Array.from(element.childNodes).filter((node) => node.nodeType === 3 || node.nodeType === 4).reduce((sum, node) => sum + new TextEncoder().encode(node.textContent ?? "").length, 0);
	return text + attributeGeometryBytes(element);
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
			if (id !== null) {
				if (!/^[A-Za-z_][\w.-]*$/.test(id) || ids.has(id)) reject("SVG IDs must be unique simple names.");
				ids.set(id, element);
			}
		}
		const edges = new Map<Element, Element[]>(elements.map((element) => [element, Array.from(element.children)]));
		let geometryBytes = 0;
		for (const element of elements) for (const attr of Array.from(element.attributes)) {
			const { name, value } = attr;
			const found = attributeSpec(attr);
			if (!found) reject(`SVG attribute ${name} is not supported.`);
			if (value.length > 65_536) reject("SVG attribute exceeds the rendering limit.");
			const result = checkAttribute(found, element, value);
			if (result.kind === "invalid") reject(`SVG ${name} ${result.reason}.`);
			if (name === "id") element.setAttribute(name, `${prefix}-${value}`);
			else if (result.kind === "reference") {
				for (const id of result.ids) {
					const target = ids.get(id);
					if (!target || !permittedTarget(name, element, target)) reject("SVG reference target is missing or unsupported.");
					// Accessibility labels do not instantiate drawing geometry.
					if (result.drawsTarget) edges.get(element)!.push(target);
				}
				element.setAttributeNS(attr.namespaceURI, name, result.rewrite(result.ids.map((id) => `${prefix}-${id}`)));
			}
		}
		geometryBytes += elements.reduce((sum, element) => sum + elementGeometryBytes(element), 0);
		if (geometryBytes > svgLimits.geometryBytes) reject("SVG geometry data exceeds 64 KiB.");
		const active = new Set<Element>();
		const weights = new Map<Element, { elements: number; geometryBytes: number }>();
		function weight(element: Element): { elements: number; geometryBytes: number } {
			const memo = weights.get(element); if (memo) return memo;
			if (active.has(element)) reject("SVG references must not form cycles.");
			active.add(element);
			const result = { elements: 1, geometryBytes: elementGeometryBytes(element) };
			for (const target of edges.get(element)!) {
				const child = weight(target); result.elements += child.elements; result.geometryBytes += child.geometryBytes;
				if (result.elements > svgLimits.expandedElements || result.geometryBytes > svgLimits.expandedGeometryBytes) reject("SVG reference expansion exceeds the rendering limit.");
			}
			active.delete(element); weights.set(element, result); return result;
		}
		weight(root);
		// The attribute loop already parsed an explicit viewBox.
		if (!root.hasAttribute("viewBox")) {
			const dimension = (name: string, fallback: number) => { const value = root.getAttribute(name); return value === null ? fallback : absoluteLength(value); };
			const width = dimension("width", 300); const height = dimension("height", 150);
			if (width === null || height === null || !(width > 0 && height > 0 && width <= 10_000 && height <= 10_000)) reject("SVG needs a valid viewBox or finite dimensions.");
			root.setAttribute("viewBox", `0 0 ${width} ${height}`);
		}
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
		const fragment = DOMPurify.sanitize(root, { ALLOWED_TAGS: [...tags], ALLOWED_ATTR: [...svgAttributeNames], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true });
		if (fragment.childElementCount !== 1 || fragment.firstElementChild?.localName !== "svg") reject("SVG could not be rendered safely.");
		return { kind: "ready", fragment };
	} catch (error) {
		return { kind: "rejected", reason: error instanceof SvgPolicyError ? error.message : "SVG could not be rendered safely." };
	}
}
