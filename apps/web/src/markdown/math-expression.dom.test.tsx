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
		const node = container.querySelector('p span span')!.firstChild!; const range = document.createRange(); range.setStart(node,0);range.setEnd(node,10);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
		await render(text); expect(jobs).toHaveLength(1);expect(container.querySelector('svg')).toBe(svg);expect(selection.toString()).toBe('Selectable');
	});
	it('resets changed source, cancels old work, and retains rejected source', async () => {
		await render('$x$'); const old = jobs[0]!; await render('$y$'); expect(old.cancel).toHaveBeenCalledOnce();
		await act(async () => old.complete({ kind:'rendered',svg:markup }));expect(container.querySelector('svg')).toBeNull();
		await act(async () => jobs[1]!.complete({kind:'rejected'})); expect(container.querySelector('.math-fallback')?.textContent).toBe('y');
	});
	it('copies the original TeX from the source view', async () => {
		const writeText=vi.fn().mockResolvedValue(undefined);vi.stubGlobal('navigator',{clipboard:{writeText}});await render('$x_1$');
		await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
		expect(container.querySelector('.math-source code')?.textContent).toBe('x_1');
		await act(async () => container.querySelector<HTMLButtonElement>('.math-source button')!.click());expect(writeText).toHaveBeenCalledWith('x_1');
	});
	it('selects source when clipboard access fails', async () => {
		vi.stubGlobal('navigator',{clipboard:{writeText:vi.fn().mockRejectedValue(new Error('denied'))}});await render('$x$');
		await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
		await act(async () => container.querySelector<HTMLButtonElement>('.math-source button')!.click());
		expect(window.getSelection()?.toString()).toBe('x');expect(container.querySelector('.math-source button')?.textContent).toBe('Source selected');
	});

	it('renders formulas in direct and reference links with controls outside anchors', async () => {
		const text = '[label $x$](https://example.com) and [other $`y`$][ref]\n\n[ref]: https://example.org'; await render(text);
		expect(jobs.map(job => job.source)).toEqual(['x','y']);
		for (const job of jobs) await act(async () => job.complete({kind:'rendered',svg:markup}));
		expect(container.querySelectorAll('a svg')).toHaveLength(2);
		expect(container.querySelector('a button')).toBeNull();
		expect(container.querySelectorAll('button[aria-label="View math source"]')).toHaveLength(2);
		const svg = container.querySelector('a svg');await render(text);expect(jobs).toHaveLength(2);expect(container.querySelector('a svg')).toBe(svg);
		const writeText=vi.fn().mockResolvedValue(undefined);vi.stubGlobal('navigator',{clipboard:{writeText}});
		await act(async () => container.querySelectorAll<HTMLButtonElement>('button[aria-label="View math source"]')[1]!.click());
		await act(async () => container.querySelector<HTMLButtonElement>('.math-source button')!.click());expect(writeText).toHaveBeenCalledWith('y');
	});

});
