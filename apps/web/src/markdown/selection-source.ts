import { parseMarkdown } from '@bickr/shared/markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfmToMarkdown } from 'mdast-util-gfm';
import type { Root, RootContent, Literal } from 'mdast';
import { sourceTextUnits } from './source-text';
interface SelectionSource extends Literal {
	type: 'selectionSource';
	value: string;
}
declare module 'mdast' {
	interface RootContentMap {
		selectionSource: SelectionSource;
	}
	interface PhrasingContentMap {
		selectionSource: SelectionSource;
	}
}
export type SourceInterval = { start: number; end: number };
const options = { extensions: [gfmToMarkdown()], handlers: { selectionSource: (node: SelectionSource) => node.value } };
const rawNode = (value: string): SelectionSource => ({ type: 'selectionSource', value });
const overlaps = (a: SourceInterval, b: SourceInterval) => a.start < b.end && a.end > b.start;
function bounds(node: RootContent): SourceInterval | null {
	const start = node.position?.start.offset,
		end = node.position?.end.offset;
	return start === undefined || end === undefined ? null : { start, end };
}
export function selectedMarkdown(source: string, intervals: readonly SourceInterval[]): string {
	if (intervals.some((i) => i.start === 0 && i.end === source.length)) return source.trimEnd();
	const tree = parseMarkdown(source);
	const dependencies = new Set<string>();
	const definitions = new Map<string, RootContent>();
	for (const node of tree.children)
		if (node.type === 'definition' || node.type === 'footnoteDefinition') definitions.set(`${node.type}:${node.identifier}`, node);
	function prune(node: RootContent, top = false): RootContent | null {
		const span = bounds(node);
		if (!span || !intervals.some((i) => overlaps(i, span))) return null;
		if (node.type === 'definition') return null;
		if (node.type === 'linkReference' || node.type === 'imageReference') dependencies.add(`definition:${node.identifier}`);
		if (node.type === 'footnoteReference') dependencies.add(`footnoteDefinition:${node.identifier}`);
		const full = intervals.some((i) => i.start <= span.start && i.end >= span.end);
		if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'html') {
			if (node.type === 'inlineCode' && full) return rawNode(source.slice(span.start, span.end));
			const spelling = source.slice(span.start, span.end);
			const delimiter = node.type === 'inlineCode' ? (spelling.match(/^`+/)?.[0] ?? '') : '';
			const raw = delimiter ? spelling.slice(delimiter.length, -delimiter.length) : spelling;
			const units = sourceTextUnits(raw, node.value, node.type !== 'text');
			if (!units) return rawNode(spelling);
			let last = -1,
				value = '';
			for (const unit of units)
				if (
					intervals.some((i) =>
						overlaps(i, { start: span.start + delimiter.length + unit.start, end: span.start + delimiter.length + unit.end }),
					) &&
					unit.start !== last
				) {
					value += raw.slice(unit.start, unit.end);
					last = unit.start;
				}
			return value ? rawNode(delimiter + value + delimiter) : null;
		}

		if ('children' in node) {
			const children = node.children.map((child) => prune(child as RootContent)).filter((child): child is RootContent => child !== null);
			if (!children.length) return null;
			if (top && full) return rawNode(source.slice(span.start, span.end));
			if (['emphasis', 'strong', 'delete', 'link', 'linkReference'].includes(node.type)) {
				const first = bounds(node.children[0] as RootContent),
					last = bounds(node.children.at(-1) as RootContent);
				if (first && last)
					return rawNode(
						source.slice(span.start, first.start) +
							children.map((c) => (c.type === 'selectionSource' ? c.value : toMarkdown(c, options).trimEnd())).join('') +
							source.slice(last.end, span.end),
					);
			}
			if (node.type === 'table') {
				const rows = node.children.slice(1).flatMap((row) => {
					if (!bounds(row) || !intervals.some((i) => overlaps(i, bounds(row)!))) return [];
					return [
						{
							...row,
							children: row.children.map((cell) => ({ ...cell, children: cell.children.map((c) => prune(c)).filter((c) => c !== null) })),
						},
					];
				});
				return {
					...node,
					children: [
						{
							...node.children[0]!,
							children: node.children[0]!.children.map((cell) => ({
								...cell,
								children: cell.children.map((child) => rawNode(source.slice(bounds(child)!.start, bounds(child)!.end))),
							})),
						},
						...rows,
					],
				} as RootContent;
			}
			return { ...node, children } as RootContent;
		}
		if (node.type === 'code') return full && top ? rawNode(source.slice(span.start, span.end)) : node;
		return rawNode(source.slice(span.start, span.end));
	}
	const children = tree.children.map((node) => prune(node, true)).filter((node): node is RootContent => node !== null);
	const appended = new Set<string>(
		tree.children
			.filter((n) => n.type === 'footnoteDefinition' && bounds(n) && intervals.some((i) => overlaps(i, bounds(n)!)))
			.map((n) => `footnoteDefinition:${'identifier' in n ? n.identifier : ''}`),
	);
	for (const key of dependencies) {
		if (appended.has(key)) continue;
		const definition = definitions.get(key);
		if (!definition) continue;
		appended.add(key);
		const scan = (node: RootContent) => {
			if (node.type === 'linkReference' || node.type === 'imageReference') dependencies.add(`definition:${node.identifier}`);
			if (node.type === 'footnoteReference') dependencies.add(`footnoteDefinition:${node.identifier}`);
			if ('children' in node) node.children.forEach((n) => scan(n as RootContent));
		};
		scan(definition);
		const span = bounds(definition)!;
		children.push(rawNode(source.slice(span.start, span.end)));
	}
	return children.length ? toMarkdown({ type: 'root', children } as Root, options).trimEnd() : '';
}
