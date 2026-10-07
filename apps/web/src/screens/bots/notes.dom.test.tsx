import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotNotesPanel } from './notes';
import { TranslationContext } from '../../components/content';
import { translationCache } from '../../components/translation-cache';

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
	window.localStorage.clear();
	translationCache.invalidate();
	noteContent = 'First draft';
	vi.stubGlobal('fetch', async (input: string, options?: RequestInit) => {
		const path = String(input);
		const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : null;
		requests.push({ path, body });
		const note = { id: 'draft', content: noteContent, createdAt: '', updatedAt: '', revision: 0, links: [] };
		const data = path.endsWith('/notes') ? { ids: ['draft'] }
			: path.endsWith('/translate') ? { translation: body?.text === 'draft' ? 'Translated title' : 'Translated body' }
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
	it('reloads the selected note view when the resolved instruction language changes', async () => {
		await act(async () => root.render(<BotNotesPanel botId="bot-one" enabled instructionLocale="en" onReference={() => undefined} worldHandle="main" />));
		await act(async () => button('draft').click());
		noteContent = 'The factory view in the new language';
		await act(async () => root.render(<BotNotesPanel botId="bot-one" enabled instructionLocale="ja" onReference={() => undefined} worldHandle="main" />));
		expect(container.textContent).toContain(noteContent);
		expect(requests.filter((request) => request.path.endsWith('/read')).map((request) => request.body))
			.toEqual([{ id: 'draft' }, { id: 'draft' }]);
		expect(requests.filter((request) => request.path.endsWith('/notes'))).toHaveLength(1);
		expect(button('draft').getAttribute('aria-current')).toBe('true');
	});

	it('translates the displayed title and body while editing the original note', async () => {
		await act(async () => root.render(
			<TranslationContext.Provider value={{ enabled: true, identity: 'note-test', model: 'test', prompt: 'Translate' }}>
				<BotNotesPanel botId="bot-one" enabled instructionLocale="en" onReference={() => undefined} worldHandle="main" />
			</TranslationContext.Provider>,
		));
		await act(async () => button('draft').click());
		const title = container.querySelector('h3')!;
		const body = container.querySelector('.bot-notes-content')!;
		await act(async () => title.querySelector<HTMLButtonElement>('[aria-label="Translate"]')!.click());
		await act(async () => body.querySelector<HTMLButtonElement>('[aria-label="Translate"]')!.click());
		expect(title.querySelector('.translatable-content')?.textContent).toBe('Translated title');
		expect(body.querySelector('.translatable-content')?.textContent).toBe('Translated body');
		expect(requests.filter((request) => request.path.endsWith('/translate')).map((request) => request.body))
			.toEqual([{ text: 'draft' }, { text: 'First draft' }]);
		await act(async () => button('Edit note').click());
		expect(container.querySelector<HTMLInputElement>('.modal input')!.value).toBe('draft');
		expect(container.querySelector<HTMLTextAreaElement>('.modal textarea')!.value).toBe('First draft');
		expect(button('Save note').disabled).toBe(true);
		await act(async () => type(container.querySelector<HTMLTextAreaElement>('.modal textarea')!, 'An authored change'));
		await act(async () => button('Save note').click());
		expect(requests.find((request) => request.path.endsWith('/edit'))?.body).toEqual({
			id: 'draft', nextId: 'draft', content: 'An authored change', expectedRevision: 0,
		});
	});

	it('uses the shared controls and refreshes the list and selected note through the page refresh action', async () => {
		let refresh: (() => Promise<void>) | null = null;
		await act(async () => root.render(<BotNotesPanel botId="bot-one" enabled instructionLocale="en" onReference={() => undefined} onRegisterRefresh={(_botId, registered) => { refresh = registered; }} worldHandle="main" />));
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
		await act(async () => root.render(<BotNotesPanel botId="bot-one" enabled instructionLocale="en" onReference={() => undefined} worldHandle="main" />));
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
		await act(async () => root.render(<BotNotesPanel botId="bot-one" enabled instructionLocale="en" onReference={() => undefined} onRegisterRefresh={(_botId, registered) => { refresh = registered; }} worldHandle="main" />));
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

it('discards an open note draft when the participant changes', async () => {
	await act(async () => root.render(<BotNotesPanel botId="bot-one" enabled instructionLocale="en" onReference={() => undefined} worldHandle="main" />));
	await act(async () => button('Add note').click());
	await act(async () => type(container.querySelector<HTMLInputElement>('.modal input')!, 'Private to one'));
	await act(async () => root.render(<BotNotesPanel botId="bot-two" enabled instructionLocale="en" onReference={() => undefined} worldHandle="main" />));
	expect(container.querySelector('.modal')).toBeNull();
	await act(async () => button('Add note').click());
	expect(container.querySelector<HTMLInputElement>('.modal input')!.value).toBe('');
	expect(requests.filter((request) => request.path.endsWith('/create'))).toEqual([]);
});
