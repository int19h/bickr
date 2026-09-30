import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotNotesPanel } from './notes';

let root: Root;
let container: HTMLDivElement;
let requests: Array<{ path: string; body: Record<string, unknown> | null }>;
let noteContent: string;

function button(label: string): HTMLButtonElement {
	const found = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
	expect(found, `Missing ${label} button`).toBeDefined();
	return found as HTMLButtonElement;
}

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
	element.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	requests = [];
	noteContent = 'First draft';
	vi.stubGlobal('fetch', async (input: string, options?: RequestInit) => {
		const path = String(input);
		const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : null;
		requests.push({ path, body });
		const note = { id: 'draft', content: noteContent, createdAt: '', updatedAt: '', revision: 0, links: [] };
		const data = path.endsWith('/notes') ? { ids: ['draft'] }
			: path.endsWith('/read') ? { note }
			: path.endsWith('/create') ? { note: { ...note, id: 'new note', content: 'A poem' } }
			: path.endsWith('/edit') ? { note: { ...note, id: 'renamed', content: 'Second draft', revision: 1 } }
			: {};
		return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
	});
	container = document.createElement('div');
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe('owner note editor', () => {
	it('uses the shared controls and refreshes the list and selected note through the page refresh action', async () => {
		let refresh: (() => Promise<void>) | null = null;
		await act(async () => root.render(<BotNotesPanel botId="bot-one" enabled onReference={() => undefined} onRegisterRefresh={(_botId, registered) => { refresh = registered; }} worldHandle="main" />));
		expect(button('Add note').className).toContain('btn primary');
		expect(container.textContent).not.toContain('Loading notes');
		expect([...container.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Refresh')).toBe(false);

		await act(async () => button('draft').click());
		expect(button('Edit note').className).toContain('btn');
		noteContent = 'Revised draft';
		await act(async () => { await refresh?.(); });
		expect(container.textContent).toContain('Revised draft');
		expect(requests.filter((request) => request.path.endsWith('/notes'))).toHaveLength(2);
		expect(requests.filter((request) => request.path.endsWith('/read'))).toHaveLength(2);

		await act(async () => button('Edit note').click());
		expect(button('Cancel').className).toContain('btn ghost');
		expect(button('Save note').className).toContain('btn primary');
		expect(container.querySelector('.modal textarea')?.className).toBe('textarea');
	});

	it('uses one modal for create and revision-guarded title and content edits', async () => {
		await act(async () => root.render(<BotNotesPanel botId="bot-one" enabled onReference={() => undefined} worldHandle="main" />));
		await act(async () => button('Add note').click());
		const fields = container.querySelectorAll('.modal input, .modal textarea');
		await act(async () => { type(fields[0] as HTMLInputElement, 'New Note'); type(fields[1] as HTMLTextAreaElement, 'A poem'); });
		await act(async () => button('Save note').click());
		expect(requests.find((request) => request.path.endsWith('/create'))?.body).toEqual({ id: 'New Note', content: 'A poem' });

		await act(async () => button('draft').click());
		await act(async () => button('Edit note').click());
		const editFields = container.querySelectorAll('.modal input, .modal textarea');
		await act(async () => { type(editFields[0] as HTMLInputElement, 'Renamed'); type(editFields[1] as HTMLTextAreaElement, 'Second draft'); });
		await act(async () => button('Save note').click());
		expect(requests.find((request) => request.path.endsWith('/edit'))?.body).toEqual({
			id: 'draft', nextId: 'Renamed', content: 'Second draft', expectedRevision: 0,
		});
	});

	it('clears its busy state when a selected note disappears during refresh', async () => {
		let listCount = 0;
		let finishRead: (response: Response) => void = () => undefined;
		const pendingRead = new Promise<Response>((resolve) => { finishRead = resolve; });
		vi.stubGlobal('fetch', async (input: string) => {
			const path = String(input);
			if (path.endsWith('/read')) return pendingRead;
			const data = { ids: listCount++ === 0 ? ['draft'] : [] };
			return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
		});
		let refresh: (() => Promise<void>) | null = null;
		await act(async () => root.render(<BotNotesPanel botId="bot-one" enabled onReference={() => undefined} onRegisterRefresh={(_botId, registered) => { refresh = registered; }} worldHandle="main" />));
		await act(async () => button('draft').click());
		expect(container.querySelector('[role="tabpanel"]')?.getAttribute('aria-busy')).toBe('true');
		await act(async () => { await refresh?.(); });
		expect(container.textContent).toContain('No notes yet.');
		expect(container.querySelector('[role="tabpanel"]')?.getAttribute('aria-busy')).toBe('false');
		await act(async () => finishRead(new Response(JSON.stringify({ ok: true, data: { note: {
			id: 'draft', content: 'Old content', createdAt: '', updatedAt: '', revision: 0, links: [],
		} } }), { status: 200, headers: { 'content-type': 'application/json' } })));
		expect(container.querySelector('[role="tabpanel"]')?.getAttribute('aria-busy')).toBe('false');
	});
});
