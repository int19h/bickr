import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkBickrMath } from "./markdown-math";
export { remarkBickrMath } from "./markdown-math";
import type { Root, RootContent, Text } from "mdast";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkBickrMath);
const opaqueNodes = new Set(["link", "linkReference", "image", "imageReference", "html", "code", "inlineCode", "definition", "math", "inlineMath"]);

export function parseMarkdown(source: string): Root {
	return parser.parse(source);
}

/** Both notification extraction and rendering use source-spelled references.
 * Escapes and entities never create a mention that was absent from the source. */
export function markdownTextNodes(tree: Root): Text[] {
	const texts: Text[] = [];
	function walk(node: Root | RootContent): void {
		if (opaqueNodes.has(node.type)) return;
		if (node.type === "text") texts.push(node);
		if ("children" in node) for (const child of node.children) walk(child);
	}
	walk(tree);
	return texts;
}

export function markdownTextSpans(source: string): Array<{ start: number; end: number }> {
	return markdownTextNodes(parseMarkdown(source)).flatMap((node) => {
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		return start === undefined || end === undefined ? [] : [{ start, end }];
	});
}

export function markdownMarkerIsEscaped(source: string, offset: number): boolean {
	let backslashes = 0;
	while (offset > 0 && source[--offset] === "\\") backslashes += 1;
	return backslashes % 2 === 1;
}

/** A display projection only. Stored excerpts and full source remain unchanged. */
export function markdownPreview(source: string): string {
	function text(node: Root | RootContent): string {
		if (node.type === "html" || node.type === "definition") return "";
		if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
		if (node.type === "code" && (node.lang === "svg" || node.lang === "mermaid" || node.lang === "math")) return `[${node.lang === "svg" ? "SVG drawing" : node.lang === "math" ? "Math formula" : "Mermaid diagram"}]`;
		if ("value" in node) return node.value;
		if ("children" in node) return node.children.map(text).join(node.type === "root" || node.type === "list" || node.type === "table" || node.type === "tableRow" ? " " : "");
		return "";
	}
	return text(parseMarkdown(source)).replace(/\s+/g, " ").trim();
}

export type MarkdownDrawingLanguage = "svg" | "mermaid";

/**
 * Media in a Markdown body, in document order. A drawing carries its index
 * among the drawings of the body: that index names it in viewer links and in
 * preview image URLs. The page and the server both number drawings with this
 * function, so the numbers agree. The `start` offset lets the page map a
 * rendered code fence back to its drawing.
 */
export type MarkdownMedia =
	| { kind: "image"; url: string; alt: string }
	| { kind: "drawing"; index: number; language: MarkdownDrawingLanguage; source: string; start: number | null };

export function markdownMedia(source: string): MarkdownMedia[] {
	const media: MarkdownMedia[] = [];
	let drawings = 0;
	function walk(node: Root | RootContent): void {
		if (node.type === "image") {
			media.push({ kind: "image", url: node.url, alt: node.alt ?? "" });
			return;
		}
		if (node.type === "code" && (node.lang === "svg" || node.lang === "mermaid")) {
			media.push({ kind: "drawing", index: drawings, language: node.lang, source: node.value, start: node.position?.start.offset ?? null });
			drawings += 1;
			return;
		}
		if ("children" in node) for (const child of node.children) walk(child);
	}
	walk(parseMarkdown(source));
	return media;
}

export function markdownDrawings(source: string): Extract<MarkdownMedia, { kind: "drawing" }>[] {
	return markdownMedia(source).filter((item): item is Extract<MarkdownMedia, { kind: "drawing" }> => item.kind === "drawing");
}
