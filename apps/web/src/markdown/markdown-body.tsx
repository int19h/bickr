import { useId, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { decodeString } from "micromark-util-decode-string";
import { markdownMarkerIsEscaped } from "@bickr/shared/markdown";
import type { Root, RootContent, Literal } from "mdast";

interface BickrText extends Literal { type: "bickrText"; value: string }
declare module "mdast" {
	interface PhrasingContentMap { bickrText: BickrText }
	interface RootContentMap { bickrText: BickrText }
}
import type { Plugin } from "unified";
import { findBickrContentUrlMatches } from "../content-links";
import { SpaLink } from "../components/navigation";
import { DrawingBlock } from "./drawing-block";

// Keep raw spelling beside each ordinary text leaf. Links and code stay opaque.
// This makes escaped/entity-spelled references agree with notification rules.
const markText: Plugin<[], Root> = () => (tree, file) => {
	const source = String(file);
	function walk(node: Root | RootContent): void {
		if (["link", "linkReference", "image", "imageReference", "html", "code", "inlineCode", "definition"].includes(node.type) || !("children" in node)) return;
		for (let index = 0; index < node.children.length; index += 1) {
			const child = node.children[index]!;
			if (child.type === "text") {
				const raw = source.slice(child.position?.start.offset, child.position?.end.offset);
				const replacement: BickrText = { type: "bickrText", value: child.value, position: child.position, data: { hName: "span", hProperties: { "data-bickr-source": raw }, hChildren: [{ type: "text", value: child.value }] } };
				// Ordinary text renders its own preserved line breaks. remark-breaks
				// handles other text without destroying reference source positions.
				(node.children as RootContent[])[index] = replacement;
			} else walk(child);
		}
	}
	walk(tree);
};

export function MarkdownBody({ text, referencePattern, renderText, renderPlain }: {
	text: string;
	referencePattern: RegExp;
	renderText: (text: string) => ReactNode;
	renderPlain: (text: string) => ReactNode;
}) {
	const bodyId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	function ordinaryText(raw: string): ReactNode {
		const parts: ReactNode[] = [];
		let cursor = 0;
		for (const match of raw.matchAll(referencePattern)) {
			const start = (match.index ?? 0) + (match[1]?.length ?? 0);
			const end = (match.index ?? 0) + match[0].length;
			// A backslash only escapes punctuation, not the u/f/w prefix letters.
			if (markdownMarkerIsEscaped(raw, start) && /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(raw.slice(start))) continue;
			if (start > cursor) parts.push(<span key={`plain-${cursor}`}>{renderPlain(decodeString(raw.slice(cursor, start)))}</span>);
			parts.push(<span key={`ref-${start}`}>{renderText(raw.slice(start, end))}</span>);
			cursor = end;
		}
		if (cursor < raw.length) parts.push(<span key={`plain-${cursor}`}>{renderPlain(decodeString(raw.slice(cursor)))}</span>);
		return parts;
	}
	return <div className="markdown-body">
		<Markdown remarkPlugins={[remarkGfm, markText, remarkBreaks]} remarkRehypeOptions={{ clobberPrefix: `bickr-md-${bodyId}-` }} components={{
			span: ({ node, children }) => {
				const raw = node?.properties["dataBickrSource"] ?? node?.properties["data-bickr-source"];
				return <span>{typeof raw === "string" ? ordinaryText(raw) : children}</span>;
			},
			p: ({ children }) => <p dir="auto" data-markdown-block="true">{children}</p>,
			h1: ({ children, id, className }) => <h2 id={id === "footnote-label" ? `bickr-md-${bodyId}-footnote-label` : id} className={className} dir="auto" data-markdown-block="true">{children}</h2>,
			h2: ({ children, id, className }) => <h3 id={id === "footnote-label" ? `bickr-md-${bodyId}-footnote-label` : id} className={className} dir="auto" data-markdown-block="true">{children}</h3>,
			h3: ({ children, id, className }) => <h4 id={id === "footnote-label" ? `bickr-md-${bodyId}-footnote-label` : id} className={className} dir="auto" data-markdown-block="true">{children}</h4>,
			h4: ({ children, id, className }) => <h5 id={id === "footnote-label" ? `bickr-md-${bodyId}-footnote-label` : id} className={className} dir="auto" data-markdown-block="true">{children}</h5>,
			h5: ({ children, id, className }) => <h6 id={id === "footnote-label" ? `bickr-md-${bodyId}-footnote-label` : id} className={className} dir="auto" data-markdown-block="true">{children}</h6>,
			h6: ({ children, id, className }) => <h6 id={id === "footnote-label" ? `bickr-md-${bodyId}-footnote-label` : id} className={className} dir="auto" data-markdown-block="true">{children}</h6>,
			li: ({ children, className, id }) => <li id={id === "footnote-label" ? `bickr-md-${bodyId}-footnote-label` : id} className={className} dir="auto" data-markdown-block="true">{children}</li>,
			table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
			th: ({ children, style }) => <th style={style} dir="auto" data-markdown-cell="true">{children}</th>,
			td: ({ children, style }) => <td style={style} dir="auto" data-markdown-cell="true">{children}</td>,
			pre: ({ node, children }) => {
				const code = node?.children[0];
				if (code?.type === "element" && code.tagName === "code") {
					const classes = code.properties.className;
					const language = Array.isArray(classes) ? classes.find((value) => value === "language-svg" || value === "language-mermaid") : undefined;
					const source = code.children.map((child) => child.type === "text" ? child.value : "").join("").replace(/\n$/, "");
					if (language) return <DrawingBlock language={language === "language-svg" ? "svg" : "mermaid"} source={source} />;
				}
				return <pre data-markdown-block="true">{children}</pre>;
			},
			a: ({ node: _node, href, children, ...props }) => {
				const match = href ? findBickrContentUrlMatches(href).find((candidate) => candidate.text === href) : undefined;
				if (match) return <SpaLink to={match.route}>{children}</SpaLink>;
				return <a {...props} aria-describedby={props["aria-describedby"] === "footnote-label" ? `bickr-md-${bodyId}-footnote-label` : props["aria-describedby"]} href={href} rel="noopener noreferrer">{children}</a>;
			},
			img: ({ src, alt }) => <MarkdownImage key={src} src={src} alt={alt ?? "Image"} />,
		}}>{text}</Markdown>
	</div>;
}
function MarkdownImage({ src, alt }: { src?: string; alt: string }) {
	const [loaded, setLoaded] = useState(false);
	if (!src) return <span>{alt}</span>;
	return loaded ? <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" /> : <button type="button" className="markdown-image-load" data-selection-exclude="true" onClick={() => setLoaded(true)}>Load image: {alt}</button>;
}
