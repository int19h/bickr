// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, it, expect, vi } from 'vitest';
import { selectedMarkdown } from './selection-source';
import { MarkdownBody } from './markdown-body';
import { readDocumentSelection } from '../screens/forums/spotlight-selection-dom';
vi.mock('./math-service', () => ({ mathService: { render: () => () => {} } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => {
	window.getSelection()?.removeAllRanges();
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
});
async function render(source: string) {
	container = document.createElement('div');
	container.dataset.commentBody = 'comment';
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root!.render(
			<MarkdownBody
				text={source}
				referencePattern={/\bu\/\w+/g}
				renderPlain={(text) => text}
				renderText={(text) => <a>{text.toUpperCase()}</a>}
			/>,
		),
	);
}
function selected(range: Range) {
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	const observation = readDocumentSelection();
	return observation.kind === 'selected' ? observation.captures[0]?.text : '';
}
function textRange(needle: string, start = 0, end = needle.length) {
	const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
	let node: Node | null;
	while ((node = walker.nextNode()))
		if (node.nodeValue === needle) {
			const range = document.createRange();
			range.setStart(node, start);
			range.setEnd(node, end);
			return range;
		}
	throw Error('Missing text ' + needle);
}
it('preserves original formatting, escapes, entities, and partial UTF-16 text', async () => {
	await render('**before** and *a &amp; b* and __😀word__');
	expect(selected(textRange('before', 3, 5))).toBe('**or**');
	expect(selected(textRange('a & b'))).toBe('*a &amp; b*');
	expect(selected(textRange('😀word', 0, 2))).toBe('__😀__');
});
it('preserves math delimiters and excludes zero-width boundary contacts', async () => {
	await render('first $x^2$ last');
	const range = document.createRange();
	range.selectNodeContents(container.querySelector('.math-expression')!);
	expect(selected(range)).toBe('$x^2$');
	expect(selected(textRange('first '))).toBe('first');
});
it('quotes normalized references as their original atomic tokens', async () => {
	await render('ask u/Alice now');
	expect(selected(textRange('U/ALICE', 2, 4))).toBe('u/Alice');
});
it('retains link and footnote definitions once', async () => {
	await render('[label][ref] and note[^a]\n\n[ref]: https://example.com\n\n[^a]: A footnote');
	expect(selected(textRange('label', 1, 4))).toBe('[abe][ref]\n\n[ref]: https://example.com');
	const range = document.createRange();
	range.selectNodeContents(container.querySelector('p')!);
	const result = selected(range)!;
	expect(result).toContain('note[^a]');
	expect(result.match(/\[\^a\]:/g)).toHaveLength(1);
});
it('keeps selected list and quote content without unrelated lines', async () => {
	await render('> first\n> **second**\n\n- parent\n  - *nested*\n\n- [x] task');
	expect(selected(textRange('second', 0, 3))).toBe('> **sec**');
	const nested = selected(textRange('nested', 0, 4))!;
	expect(nested).toContain('*nest*');
	expect(nested).not.toContain('parent');
	expect(selected(textRange('task'))).toContain('[x] task');
});
it('keeps table headers and positions while selecting a partial cell', async () => {
	await render('| Name | Value |\n| :--- | ---: |\n| Alpha | Beta |\n| Other | Hidden |');
	const result = selected(textRange('Beta', 0, 2))!;
	expect(result).toContain('Name');
	expect(result).toContain('Value');
	expect(result).toContain('Be');
	expect(result).not.toContain('Alpha');
	expect(result).not.toContain('Hidden');
});
it('uses the rendered source after a language or source change', async () => {
	await render('*translated* $y$');
	expect(selected(textRange('translated'))).toBe('*translated*');
});

it('preserves partial inline code delimiters', async () => {
	await render('before ``a`bc`` after');
	expect(selected(textRange('a`bc', 2, 4))).toBe('``bc``');
});

it('keeps full-body source and formula fences byte-for-byte', async () => {
	const source = '# Heading\n\n**bold** $x$\n\n```math\na^2\n```\n\n[ref]: https://example.com';
	await render(source);
	const range = document.createRange();
	range.selectNodeContents(container.querySelector('.markdown-body')!);
	expect(selected(range)).toBe(source);
});
it('maps escaped text and CRLF continuation lines', async () => {
	await render('> first\r\n> a \\*b\\* &amp; c');
	expect(selected(textRange('first\na *b* & c', 6, 13))).toBe('> a \\*b\\* &amp;');
});

it('retains reference and footnote definitions from table headers', async () => {
	await render(
		'| [Head][ref] and note[^a] | Value |\n| --- | --- |\n| A | Beta |\n\n[ref]: https://example.com\n\n[^a]: [Foot][f]\n\n[f]: https://foot.example',
	);
	const result = selected(textRange('Beta', 0, 2))!;
	expect(result).toContain('[ref]: https://example.com');
	expect(result).toContain('[^a]: [Foot][f]');
	expect(result).toContain('[f]: https://foot.example');
});
it('keeps the complete referenced definition when a disjoint range selects only part of it', () => {
	const source = 'note[^a]\n\n[^a]: first second';
	const start = source.indexOf('second');
	const result = selectedMarkdown(source, [
		{ start: 0, end: 8 },
		{ start, end: start + 6 },
	]);
	expect(result).toContain('[^a]: first second');
	expect(result.match(/\[\^a\]:/g)).toHaveLength(1);
});
it('resolves duplicate references to the first definition', async () => {
	await render('[label][r]\n\n[r]: https://first.example\n[r]: https://second.example');
	const result = selected(textRange('label', 1, 4))!;
	expect(result).toContain('https://first.example');
	expect(result).not.toContain('https://second.example');
});

it('resolves duplicate footnotes to the first rendered definition', async () => {
	await render('note[^a]\n\n[^a]: First body\n\n[^a]: Second body');
	expect(container.querySelector('section[data-footnotes]')?.textContent).toContain('First body');
	const range = document.createRange();
	range.selectNodeContents(container.querySelector('p')!);
	const result = selected(range)!;
	expect(result).toContain('[^a]: First body');
	expect(result).not.toContain('Second body');
});

it('retains nested reference and footnote definitions as standalone context', async () => {
	await render('[label][r] and note[^a]\n\n> [r]: https://example.com\n> [^a]: First body');
	const range = document.createRange();
	range.selectNodeContents(container.querySelector('p')!);
	const result = selected(range)!;
	expect(result).toContain('[r]: https://example.com');
	expect(result).toContain('[^a]: First body');
	expect(result).not.toContain('> [r]:');
	expect(result).not.toContain('> [^a]:');
});
it('retains definitions inside lists and resolves them in document order', () => {
	const source = '[label][r]\n\n- [r]: https://first.example\n\n[r]: https://second.example';
	const result = selectedMarkdown(source, [{ start: 1, end: 4 }]);
	expect(result).toContain('[r]: https://first.example');
	expect(result).not.toContain('second.example');
});
