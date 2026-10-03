// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect, vi } from "vitest";
import { MarkdownBody } from "./markdown-body";
import type { MathResult } from "./math-protocol";
const { jobs } = vi.hoisted(() => ({ jobs: [] as Array<{ source: string; display: boolean; complete: (result: MathResult) => void; cancel: ReturnType<typeof vi.fn> }> }));
vi.mock('./math-service', () => ({ mathService: { render(source: string, display: boolean, complete: (result: MathResult) => void) { const cancel = vi.fn(); jobs.push({ source, display, complete, cancel }); return cancel; } } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined; let container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); jobs.length = 0; vi.unstubAllGlobals(); });
const markup = '<svg xmlns="http://www.w3.org/2000/svg" width="2ex" height="2ex" viewBox="0 -500 1000 1000"><path d="M0 0L10 10"/></svg>';
async function render(text: string) {
	if (!root) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); }
	await act(async () => root!.render(<MarkdownBody text={text} referencePattern={/never/g} renderText={text => text} renderPlain={text => text} />));
}
describe('Markdown math rendering', () => {
	it('dispatches all GitHub forms with correct display state', async () => {
		await render('$a$ and $`b`$\n\n$$c$$\n\n$$\nd\n$$\n\n```math\ne\n```');
		expect(jobs.map(({ source, display }) => [source, display])).toEqual([['a',false],['b',false],['c',true],['d',true],['e',true]]);
		expect(container.querySelector('p div, p pre')).toBeNull();
	});
	it('keeps SVG and text selection across unchanged parent renders', async () => {
		const text = 'Selectable verse\n\n$x$'; await render(text);
		await act(async () => jobs[0]!.complete({ kind:'rendered', svg:markup })); const svg = container.querySelector('svg'); expect(svg).not.toBeNull();
		const node = container.querySelector('[data-md-leaf]')!.firstChild!; const range = document.createRange(); range.setStart(node,0);range.setEnd(node,10);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
		await render(text); expect(jobs).toHaveLength(1);expect(container.querySelector('svg')).toBe(svg);expect(selection.toString()).toBe('Selectable');
	});
	it('resets changed source, cancels old work, and retains rejected source', async () => {
		await render('$x$'); const old = jobs[0]!; await render('$y$'); expect(old.cancel).toHaveBeenCalledOnce();
		await act(async () => old.complete({ kind:'rendered',svg:markup }));expect(container.querySelector('svg')).toBeNull();
		await act(async () => jobs[1]!.complete({kind:'rejected'})); expect(container.querySelector('.math-fallback')?.textContent).toBe('y');
	});
	it('omits source buttons for formulas', async () => { await render('$x$'); expect(container.querySelector('button')).toBeNull(); });
	it('moves validated inline baseline offsets to the scroll wrapper and leaves display offsets intact', async () => {
		await render('$x_0$ and $y$\n\n$$z$$');
		const shifted = markup.replace('<svg ', '<svg style="vertical-align: -0.25ex;" ');
		for (const [index, job] of jobs.entries()) {
			await act(async () => job.complete({ kind: 'rendered', svg: index === 1 ? markup : shifted }));
		}
		const outputs = container.querySelectorAll<HTMLElement>('.math-output');
		expect(outputs[0]!.style.verticalAlign).toBe('-0.25ex');
		expect(outputs[0]!.querySelector('svg')!.style.verticalAlign).toBe('');
		expect(outputs[1]!.style.verticalAlign).toBe('');
		expect(outputs[2]!.style.verticalAlign).toBe('');
		expect(outputs[2]!.querySelector('svg')!.style.verticalAlign).toBe('-0.25ex');
	});

	it('renders formulas in direct and reference links without source buttons', async () => {
		const text = '[label $x$](https://example.com) and [other $`y`$][ref]\n\n[ref]: https://example.org'; await render(text);
		expect(jobs.map(job => job.source)).toEqual(['x','y']);
		for (const job of jobs) await act(async () => job.complete({kind:'rendered',svg:markup}));
		expect(container.querySelectorAll('a svg')).toHaveLength(2);
		expect(container.querySelector('a button')).toBeNull();
		expect(container.querySelectorAll('button')).toHaveLength(0);
		const svg = container.querySelector('a svg');await render(text);expect(jobs).toHaveLength(2);expect(container.querySelector('a svg')).toBe(svg);
	});

});
