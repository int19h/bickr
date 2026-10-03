import {
	cloneElement,
	isValidElement,
	createContext,
	useContext,
	useId,
	useState,
	type ComponentProps,
	type ReactElement,
	type ReactNode,
} from 'react';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { decodeString } from 'micromark-util-decode-string';
import { markdownMarkerIsEscaped, remarkBickrMath } from '@bickr/shared/markdown';
import type { Element, Root as HastRoot } from 'hast';
import type { Root, RootContent, Literal } from 'mdast';

interface BickrText extends Literal {
	type: 'bickrText';
	value: string;
}
declare module 'mdast' {
	interface PhrasingContentMap {
		bickrText: BickrText;
	}
	interface RootContentMap {
		bickrText: BickrText;
	}
}
import type { Plugin } from 'unified';
import { findBickrContentUrlMatches } from '../content-links';
import { SpaLink } from '../components/navigation';
import { MathExpression } from './math-expression';
import { sourceTextUnits } from './source-text';
import { DrawingBlock } from './drawing-block';

// Keep raw spelling beside each ordinary text leaf. Links and code stay opaque.
// This makes escaped/entity-spelled references agree with notification rules.
const markText: Plugin<[], Root> = () => (tree, file) => {
	const source = String(file);
	function annotateMath(node: Root | RootContent): void {
		if (node.type === 'math' || node.type === 'inlineMath') {
			const raw = source.slice(node.position?.start.offset, node.position?.end.offset);
			node.data = {
				hName: 'span',
				hProperties: {
					'data-math-source': node.value,
					'data-math-display': node.type === 'math' || raw.startsWith('$$'),
				},
				hChildren: [],
			};
			return;
		}
		if ('children' in node) for (const child of node.children) annotateMath(child);
	}
	annotateMath(tree);
	function walk(node: Root | RootContent): void {
		if (
			['link', 'linkReference', 'image', 'imageReference', 'html', 'code', 'inlineCode', 'definition'].includes(node.type) ||
			!('children' in node)
		)
			return;
		for (let index = 0; index < node.children.length; index += 1) {
			const child = node.children[index]!;
			if (child.type === 'text') {
				const raw = source.slice(child.position?.start.offset, child.position?.end.offset);
				const value = child.value.replace(/\r\n?/g, '\n');
				const replacement: BickrText = {
					type: 'bickrText',
					value,
					position: child.position,
					data: {
						hName: 'span',
						hProperties: { 'data-bickr-source': raw, 'data-bickr-value': value },
						hChildren: [{ type: 'text', value }],
					},
				};
				// Ordinary text renders its own preserved line breaks. remark-breaks
				// handles other text without destroying reference source positions.
				(node.children as RootContent[])[index] = replacement;
			} else walk(child);
		}
	}
	walk(tree);
};

interface MarkdownContextValue {
	bodyId: string;
	referencePattern: RegExp;
	renderText: (text: string) => ReactNode;
	renderPlain: (text: string) => ReactNode;
}
const MarkdownContext = createContext<MarkdownContextValue | null>(null);
function useMarkdownContext(): MarkdownContextValue {
	const value = useContext(MarkdownContext);
	if (!value) throw new Error('Markdown components require their context provider');
	return value;
}
export function MarkdownBody({ text, ...callbacks }: Omit<MarkdownContextValue, 'bodyId'> & { text: string }) {
	const bodyId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
	return (
		<MarkdownContext.Provider value={{ bodyId, ...callbacks }}>
			<div className="markdown-body" data-markdown-source={text}>
				<Markdown
					remarkPlugins={[remarkGfm, remarkBickrMath, markText, remarkBreaks]}
					remarkRehypeOptions={{ clobberPrefix: `bickr-md-${bodyId}-` }}
					rehypePlugins={[markSource]}
					components={markdownComponents}
				>
					{text}
				</Markdown>
			</div>
		</MarkdownContext.Provider>
	);
}
function ordinaryText(
	raw: string,
	value: string,
	base: number,
	{ referencePattern, renderPlain, renderText }: MarkdownContextValue,
): ReactNode {
	const parts: ReactNode[] = [];
	const units = sourceTextUnits(raw, value);
	const renderedOffset = (offset: number) => units?.findIndex((unit) => unit.start >= offset) ?? -1;
	const plain = (start: number, end: number) => (
		<span
			data-md-start={base + start}
			data-md-end={base + end}
			data-md-leaf="true"
			data-md-value={
				units
					? value.slice(start === 0 ? 0 : renderedOffset(start), end === raw.length ? value.length : renderedOffset(end))
					: decodeString(raw.slice(start, end))
			}
		>
			{renderPlain(
				units
					? value.slice(start === 0 ? 0 : renderedOffset(start), end === raw.length ? value.length : renderedOffset(end))
					: decodeString(raw.slice(start, end)),
			)}
		</span>
	);
	let cursor = 0;
	for (const match of raw.matchAll(referencePattern)) {
		const start = (match.index ?? 0) + (match[1]?.length ?? 0);
		const end = (match.index ?? 0) + match[0].length;
		// A backslash only escapes punctuation, not the u/f/w prefix letters.
		if (markdownMarkerIsEscaped(raw, start) && /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(raw.slice(start))) continue;
		if (start > cursor) parts.push(<span key={`plain-${cursor}`}>{plain(cursor, start)}</span>);
		parts.push(
			<span key={`ref-${start}`} data-md-start={base + start} data-md-end={base + end} data-md-atomic="true">
				{renderText(raw.slice(start, end))}
			</span>,
		);
		cursor = end;
	}
	if (cursor < raw.length) parts.push(<span key={`plain-${cursor}`}>{plain(cursor, raw.length)}</span>);
	return parts;
}
// Stable component types preserve text selections, drawing frames, and image state.
// Context supplies current callbacks without replacing those component types.
const baseComponents: Components = {
	span: ({ node, children }) => {
		const context = useMarkdownContext();
		const mathSource = node?.properties['dataMathSource'] ?? node?.properties['data-math-source'];
		if (typeof mathSource === 'string')
			return (
				<MathExpression
					source={mathSource}
					display={node?.properties['dataMathDisplay'] === true || node?.properties['data-math-display'] === true}
				/>
			);
		const raw = node?.properties['dataBickrSource'] ?? node?.properties['data-bickr-source'];
		return (
			<span>
				{typeof raw === 'string'
					? ordinaryText(
							raw,
							String(node?.properties['data-bickr-value'] ?? node?.properties['dataBickrValue'] ?? decodeString(raw)),
							node?.position?.start.offset ?? 0,
							context,
						)
					: children}
			</span>
		);
	},
	p: ({ children }) => (
		<p dir="auto" data-markdown-block="true">
			{children}
		</p>
	),
	h1: ({ children, id, className }) => {
		const { bodyId } = useMarkdownContext();
		return (
			<h2
				id={id === 'footnote-label' ? `bickr-md-${bodyId}-footnote-label` : id}
				className={className}
				dir="auto"
				data-markdown-block="true"
			>
				{children}
			</h2>
		);
	},
	h2: ({ children, id, className }) => {
		const { bodyId } = useMarkdownContext();
		return (
			<h3
				id={id === 'footnote-label' ? `bickr-md-${bodyId}-footnote-label` : id}
				className={className}
				dir="auto"
				data-markdown-block="true"
			>
				{children}
			</h3>
		);
	},
	h3: ({ children, id, className }) => {
		const { bodyId } = useMarkdownContext();
		return (
			<h4
				id={id === 'footnote-label' ? `bickr-md-${bodyId}-footnote-label` : id}
				className={className}
				dir="auto"
				data-markdown-block="true"
			>
				{children}
			</h4>
		);
	},
	h4: ({ children, id, className }) => {
		const { bodyId } = useMarkdownContext();
		return (
			<h5
				id={id === 'footnote-label' ? `bickr-md-${bodyId}-footnote-label` : id}
				className={className}
				dir="auto"
				data-markdown-block="true"
			>
				{children}
			</h5>
		);
	},
	h5: ({ children, id, className }) => {
		const { bodyId } = useMarkdownContext();
		return (
			<h6
				id={id === 'footnote-label' ? `bickr-md-${bodyId}-footnote-label` : id}
				className={className}
				dir="auto"
				data-markdown-block="true"
			>
				{children}
			</h6>
		);
	},
	h6: ({ children, id, className }) => {
		const { bodyId } = useMarkdownContext();
		return (
			<h6
				id={id === 'footnote-label' ? `bickr-md-${bodyId}-footnote-label` : id}
				className={className}
				dir="auto"
				data-markdown-block="true"
			>
				{children}
			</h6>
		);
	},
	li: MarkdownListItem,
	table: ({ children }) => (
		<div className="markdown-table">
			<table>{children}</table>
		</div>
	),
	th: ({ children, style }) => (
		<th style={style} dir="auto" data-markdown-cell="true">
			{children}
		</th>
	),
	td: ({ children, style }) => (
		<td style={style} dir="auto" data-markdown-cell="true">
			{children}
		</td>
	),
	pre: MarkdownPre,
	a: ({ node, href, children, ...props }) => {
		const { bodyId } = useMarkdownContext();
		const match = href ? findBickrContentUrlMatches(href).find((candidate) => candidate.text === href) : undefined;
		if (match) return <SpaLink to={match.route}>{children}</SpaLink>;
		return (
			<a
				{...props}
				aria-describedby={props['aria-describedby'] === 'footnote-label' ? `bickr-md-${bodyId}-footnote-label` : props['aria-describedby']}
				href={href}
				rel="noopener noreferrer"
			>
				{children}
			</a>
		);
	},
	img: ({ src, alt }) => <MarkdownImage key={src} src={src} alt={alt ?? 'Image'} />,
}; // Stable component types keep drawings mounted when a Markdown parent renders
// again, including code fences inside list items.
function MarkdownListItem({ children, className, id }: ComponentProps<'li'>) {
	return (
		<li id={id} className={className} dir="auto" data-markdown-block="true">
			{children}
		</li>
	);
}

function MarkdownPre({ node, children }: ComponentProps<'pre'> & ExtraProps) {
	const code = node?.children[0];
	if (code?.type === 'element' && code.tagName === 'code') {
		const classes = code.properties.className;
		const language = Array.isArray(classes) ? classes.find((value) => value === 'language-svg' || value === 'language-mermaid') : undefined;
		const source = code.children
			.map((child) => (child.type === 'text' ? child.value : ''))
			.join('')
			.replace(/\n$/, '');
		if (Array.isArray(classes) && classes.includes('language-math')) return <MathExpression source={source} display />;
		if (language) return <DrawingBlock language={language === 'language-svg' ? 'svg' : 'mermaid'} source={source} />;
	}
	return <pre data-markdown-block="true">{children}</pre>;
}
function MarkdownImage({ src, alt }: { src?: string; alt: string }) {
	const [loaded, setLoaded] = useState(false);
	if (!src) return <span>{alt}</span>;
	return loaded ? (
		<img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" />
	) : (
		<button type="button" className="markdown-image-load" data-selection-exclude="true" onClick={() => setLoaded(true)}>
			Load image: {alt}
		</button>
	);
}

// Source positions belong to rendered content, never to popup or generated UI.
const markSource: Plugin<[], HastRoot> = () => (tree, file) => {
	function walk(node: HastRoot | Element): void {
		for (let i = 0; i < node.children.length; i++) {
			const child = node.children[i]!;
			if ((child.type === 'text' || child.type === 'raw') && child.position)
				node.children[i] = {
					type: 'element',
					tagName: 'span',
					position: child.position,
					properties: {
						'data-md-start': child.position.start.offset,
						'data-md-end': child.position.end.offset,
						'data-md-leaf': 'true',
						'data-md-literal': child.type === 'raw' ? 'true' : undefined,
						'data-md-value': child.value,
					},
					children: [{ type: 'text', value: child.value }],
				};
			else if (child.type === 'element') {
				if (child.position) {
					child.properties['data-md-start'] = child.position.start.offset;
					child.properties['data-md-end'] = child.position.end.offset;
				}
				if (child.tagName === 'input' || 'dataFootnoteBackref' in child.properties || 'data-footnote-backref' in child.properties)
					child.properties['data-selection-exclude'] = 'true';
				if (child.tagName === 'code' && node.type === 'element' && node.tagName !== 'pre' && child.position) {
					const spelling = String(file).slice(child.position.start.offset, child.position.end.offset);
					const delimiter = spelling.match(/^`+/)?.[0].length ?? 0;
					child.properties['data-md-leaf'] = 'true';
					child.properties['data-md-literal'] = 'true';
					child.properties['data-md-value'] = child.children.map((n) => (n.type === 'text' ? n.value : '')).join('');
					child.properties['data-md-content-start'] = (child.position.start.offset ?? 0) + delimiter;
					child.properties['data-md-content-end'] = (child.position.end.offset ?? 0) - delimiter;
				} else if (
					child.tagName === 'pre' ||
					child.properties['data-math-source'] !== undefined ||
					child.properties.dataMathSource !== undefined
				)
					child.properties['data-md-atomic'] = 'true';

				walk(child);
			}
		}
	}
	walk(tree);
};
const markdownComponents = Object.fromEntries(
	Object.entries(baseComponents).map(([tag, Component]) => [
		tag,
		function SourceComponent(props: Record<string, unknown> & ExtraProps) {
			const output = (Component as (props: Record<string, unknown>) => ReactNode)(props);
			if (!isValidElement(output)) return output;
			const properties = props.node?.properties ?? {};
			const attributes = Object.fromEntries(Object.entries(properties).filter(([key]) => key.startsWith('data-md-')));
			return cloneElement(output as ReactElement<Record<string, unknown>>, attributes);
		},
	]),
) as Components;
