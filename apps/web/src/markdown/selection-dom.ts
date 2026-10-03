import { selectedMarkdown, type SourceInterval } from './selection-source';
import { sourceTextUnits } from './source-text';

type VisibleText = (node: Node) => string;
function visible(node: Node): boolean {
	return !(node instanceof Element ? node : node.parentElement)?.closest('[data-selection-exclude="true"],[hidden]');
}
function positive(range: Range, node: Node): boolean {
	const own = node.ownerDocument!.createRange();
	own.selectNodeContents(node);
	if (node.nodeType !== Node.TEXT_NODE && !node.hasChildNodes()) own.selectNode(node);
	return range.compareBoundaryPoints(Range.END_TO_START, own) < 0 && range.compareBoundaryPoints(Range.START_TO_END, own) > 0;
}
function edges(node: Node): Node[] {
	if (!visible(node)) return [];
	if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ? [node] : [];
	if (node instanceof Element && ['svg', 'iframe', 'br', 'img'].includes(node.tagName.toLowerCase())) return [node];
	return Array.from(node.childNodes).flatMap(edges);
}
function fullyCovered(range: Range, node: Node): boolean {
	const content = edges(node);
	if (!content.length) return false;
	const first = node.ownerDocument!.createRange(),
		last = node.ownerDocument!.createRange();
	const a = content[0]!,
		b = content.at(-1)!;
	if (a.nodeType === Node.TEXT_NODE) first.selectNodeContents(a);
	else first.selectNode(a);
	if (b.nodeType === Node.TEXT_NODE) last.selectNodeContents(b);
	else last.selectNode(b);
	return range.compareBoundaryPoints(Range.START_TO_START, first) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, last) >= 0;
}
/** Read source positions from the original DOM. Cloned fragments lose boundaries. */
export function markdownWithinSelection(range: Range, body: Element, serializeVisible: VisibleText): string | null {
	const root = body.matches('[data-markdown-source]') ? body : body.querySelector('[data-markdown-source]');
	if (!root) return null;
	const source = root.getAttribute('data-markdown-source')!;
	const intervals: SourceInterval[] = [];
	function walk(node: Node): void {
		if (!visible(node) || !positive(range, node)) return;
		if (node instanceof Element) {
			const start = Number(node.getAttribute('data-md-start')),
				end = Number(node.getAttribute('data-md-end'));
			const mapped = node.hasAttribute('data-md-start') && node.hasAttribute('data-md-end');
			if (mapped && (node.getAttribute('data-md-atomic') === 'true' || fullyCovered(range, node))) {
				if (edges(node).some((n) => positive(range, n))) intervals.push({ start, end });
				return;
			}
			if (mapped && node.getAttribute('data-md-leaf') === 'true') {
				const own = node.ownerDocument.createRange();
				own.selectNodeContents(node);
				const clipped = range.cloneRange();
				if (range.compareBoundaryPoints(Range.START_TO_START, own) < 0) clipped.setStart(own.startContainer, own.startOffset);
				if (range.compareBoundaryPoints(Range.END_TO_END, own) > 0) clipped.setEnd(own.endContainer, own.endOffset);
				const before = own.cloneRange();
				before.setEnd(clipped.startContainer, clipped.startOffset);
				const from = serializeVisible(before.cloneContents()).length,
					to = from + serializeVisible(clipped.cloneContents()).length;
				const contentStart = Number(node.getAttribute('data-md-content-start') ?? start);
				const contentEnd = Number(node.getAttribute('data-md-content-end') ?? end);
				const raw = source.slice(contentStart, contentEnd),
					value = node.getAttribute('data-md-value') ?? serializeVisible(node);
				const units = sourceTextUnits(raw, value, node.getAttribute('data-md-literal') === 'true');
				if (!units) {
					intervals.push({ start, end });
					return;
				}
				for (const unit of units.slice(from, to)) intervals.push({ start: contentStart + unit.start, end: contentStart + unit.end });
				return;
			}
		}
		node.childNodes.forEach(walk);
	}
	if (fullyCovered(range, root)) intervals.push({ start: 0, end: source.length });
	else walk(root);
	intervals.sort((a, b) => a.start - b.start);
	const merged: SourceInterval[] = [];
	for (const interval of intervals) {
		const last = merged.at(-1);
		if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
		else merged.push({ ...interval });
	}
	return selectedMarkdown(source, merged);
}
