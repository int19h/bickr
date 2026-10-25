import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotLoopMessagePage, BotLoopMessagesResponse, BotSummary } from '@bickr/shared/model';
import { LoopChatView, type LoopChatViewProps } from './loop-chat-view';
import { useLoopChatMode } from './use-loop-chat-mode';
import { AgentLogView } from './agent-log-view';
import { messageFixture } from './agent-log.fixtures';

let root: Root, container: HTMLDivElement, props: LoopChatViewProps;
let phone = false;
const page: BotLoopMessagePage = {
	currentPage: 1, pageCount: 3, olderPage: 2, compactionPageBySeq: { '10': 2, '5': 3 },
	pages: [
		{ page: 1, isNewest: true, messageCount: 1, sourceCompactionSeq: undefined },
		{ page: 2, isNewest: false, messageCount: 1, sourceCompactionSeq: 10 },
		{ page: 3, isNewest: false, messageCount: 1, sourceCompactionSeq: 5 },
	],
};
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('600') && phone }));
	phone = false;
	vi.spyOn(Date, 'now').mockReturnValue(1803420000000);
	container = document.createElement('div'); document.body.append(container); root = createRoot(container);
	props = {
		bot: { id: 'chat-participant', handle: 'reader', displayName: { lang: 'en', text: 'Reader' } } as BotSummary,
		status: { botId: 'chat-participant', status: 'idle', enabled: true, nextDueAt: new Date(Date.now() + 600000).toISOString() },
		connected: true, enabled: true, busy: false, starting: false,
		entries: [messageFixture(20)], page, injection: '', setInjection: vi.fn(), onInject: vi.fn(async () => true),
		onRun: vi.fn(), onStop: vi.fn(), onPause: vi.fn(), onCompact: vi.fn(), canCompact: true,
		onRefresh: vi.fn(), onExit: vi.fn(), onPage: vi.fn(), loadPage: vi.fn(async () => null),
		renderPage: (entries, metadata) => <AgentLogView entries={entries} page={metadata} participantName="Reader" onDelete={() => {}} onLogs={() => {}} onRequest={() => {}} onSession={() => {}} onPage={() => {}} />,
		logRef: { current: null }, pinned: { current: true }, onScroll: vi.fn(), message: '', deletedSeqs: new Set(),
	};
});
afterEach(() => { act(() => root.unmount()); container.remove(); window.history.replaceState({}, '', '/'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function render() { act(() => root.render(<LoopChatView {...props} />)); }
function button(label: string) { const node = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label); if (!node) throw Error(`Missing button: ${label}`); return node; }
function click(label: string) { act(() => button(label).click()); }
function escape() { act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); }

it('supports empty, idle, starting, running, and paused composer states', () => {
	render(); expect(button('Inject').disabled).toBe(true);
	click('Run'); expect(props.onRun).toHaveBeenCalledOnce();
	props = { ...props, starting: true }; render(); expect(button('Run').disabled).toBe(true); expect(container.querySelector('[aria-label="Starting visit"]')).not.toBeNull();
	props = { ...props, starting: false, status: { ...props.status!, status: 'running' }, startedAt: new Date(Date.now() - 42000).toISOString() }; render();
	expect(container.textContent).toContain('visit running · 0:42'); click('StopStop visit'); expect(props.onStop).toHaveBeenCalledOnce();
	props = { ...props, enabled: false, status: { ...props.status!, status: 'idle' } }; render();
	expect(button('Run').disabled).toBe(true); expect(button('Run').title).toBe('Unpause before starting a visit');
	click('More'); expect(button('Unpause loop')).not.toBeNull(); click('Unpause loop'); expect(props.onPause).toHaveBeenCalledOnce();
});
it('sends with desktop Enter, keeps Shift+Enter, and keeps phone Enter', () => {
	props = { ...props, injection: 'A thought' }; render();
	const field = container.querySelector('textarea')!;
	const enter = (shiftKey = false) => act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true })));
	enter(true); expect(props.onInject).not.toHaveBeenCalled();
	enter(); expect(props.onInject).toHaveBeenCalledOnce();
	phone = true; enter(); expect(props.onInject).toHaveBeenCalledOnce();
});
it('closes the sheet, then blurs a draft, then exits on Escape', () => {
	props = { ...props, injection: 'Draft' }; render(); click('More'); escape();
	expect(container.querySelector('.modal')).toBeNull(); expect(props.onExit).not.toHaveBeenCalled();
	container.querySelector('textarea')!.focus(); escape(); expect(document.activeElement).not.toBe(container.querySelector('textarea')); expect(props.onExit).not.toHaveBeenCalled();
	escape(); expect(props.onExit).toHaveBeenCalledOnce();
});
it('lets an information modal close before chat view', () => {
	render(); const veil = document.createElement('div'); veil.className = 'modal-veil'; document.body.append(veil);
	escape(); expect(props.onExit).not.toHaveBeenCalled(); veil.remove();
});
it('shows the archive hint and disables compaction, with chronological page chips', () => {
	props = { ...props, page: { ...page, currentPage: 2, olderPage: 3, newerPage: 1 } }; render();
	expect(container.textContent).toContain('Injects into the newest page'); expect(button('Page 2 · archive')).not.toBeNull();
	click('More'); expect(button('Compact chat').disabled).toBe(true); escape(); click('Page 2 · archive');
	click('Open the compaction notice for page 2'); expect(props.onPage).toHaveBeenCalledWith(2, true);
});
it('shows new messages only when unpinned, then pins on request', () => {
	render(); props.pinned.current = false;
	props = { ...props, entries: [...props.entries, messageFixture(21)] }; render();
	expect(button('New messages ')).not.toBeNull(); click('New messages '); expect(props.pinned.current).toBe(true);
	expect(container.querySelector('.loop-chat-new')).toBeNull();
});
it('loads an older page once, prepends it, and keeps the first watched card in place', async () => {
	let resolve!: (value: BotLoopMessagesResponse) => void;
	props.loadPage = vi.fn(() => new Promise<BotLoopMessagesResponse>(done => { resolve = done; })); render();
	const watched = container.querySelector<HTMLElement>('.agent-log-card')!;
	vi.spyOn(watched, 'getBoundingClientRect').mockReturnValueOnce({ top: 100 } as DOMRect).mockImplementation(() => ({ top: 380 - props.logRef.current!.scrollTop } as DOMRect));
	props.logRef.current!.scrollTop = 80;
	click('Load page 2'); expect(props.loadPage).toHaveBeenCalledWith(2);
	expect(container.querySelectorAll('[data-chat-page]')).toHaveLength(1);
	await act(async () => resolve({ messages: [], entries: [messageFixture(1)], page: { ...page, currentPage: 2, olderPage: 3, newerPage: 1 } }));
	expect([...container.querySelectorAll('[data-chat-page]')].map(node => node.getAttribute('data-chat-page'))).toEqual(['2', '1']);
	expect(props.logRef.current!.scrollTop).toBe(280); expect(props.pinned.current).toBe(false);
	expect(container.textContent).toContain('Load page 1');
});
it('keeps the pin state through viewport resize and restores body scrolling', () => {
	const viewport = new EventTarget(); Object.assign(viewport, { height: 430, offsetTop: 32 }); vi.stubGlobal('visualViewport', viewport);
	props.pinned.current = false; render(); act(() => viewport.dispatchEvent(new Event('resize')));
	expect(container.querySelector<HTMLElement>('.loop-chat')!.style.height).toBe('430px');
	expect(container.querySelector<HTMLElement>('.loop-chat')!.style.transform).toBe('translateY(32px)');
	expect(props.pinned.current).toBe(false); expect(document.body.style.overflow).toBe('hidden');
	act(() => root.render(null)); expect(document.body.style.overflow).toBe('');
});
it('keeps optional browser fullscreen out of unsupported browsers', () => {
	render(); click('More');
	expect(container.textContent).not.toContain('Browser fullscreen');
});
function ModeHarness() {
	const mode = useLoopChatMode(); const ref = useRef<HTMLDivElement>(null); const [ticks] = useState(1);
	return <div ref={ref}>{mode.open ? 'Chat mode' : 'Loop mode'} {ticks}<button onClick={() => mode.enter(2)}>Enter</button><button onClick={mode.exit}>Exit</button></div>;
}
it('pushes chat mode into history, restores it on back, and preserves other parameters', () => {
	window.history.replaceState({}, '', '/w/local/u/reader/loop?page=2&inference=7');
	act(() => root.render(<ModeHarness />)); click('Enter'); expect(new URLSearchParams(location.search).get('view')).toBe('chat');
	expect(new URLSearchParams(location.search).get('inference')).toBe('7');
	const back = vi.spyOn(history, 'back').mockImplementation(() => {}); click('Exit'); expect(back).toHaveBeenCalledOnce();
	act(() => { history.replaceState({}, '', '/w/local/u/reader/loop?page=2'); window.dispatchEvent(new PopStateEvent('popstate')); });
	expect(container.textContent).toContain('Loop mode');
});
it('opens a pasted chat link and replaces it on exit without a return entry', () => {
	window.history.replaceState({}, '', '/w/local/u/reader/loop?page=2&view=chat');
	act(() => root.render(<ModeHarness />)); expect(container.textContent).toContain('Chat mode'); click('Exit');
	expect(location.search).toBe('?page=2'); expect(container.textContent).toContain('Loop mode');
});

it('offers browser fullscreen where supported and keeps chat open after leaving it', async () => {
	Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
	const request = vi.fn(async () => {});
	Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: request });
	render();
	await act(async () => button('Browser fullscreen').click()); expect(request).toHaveBeenCalledOnce();
	act(() => document.dispatchEvent(new Event('fullscreenchange'))); expect(container.querySelector('.loop-chat')).not.toBeNull();
	delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
	delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
});
it('updates the page chip and archive hint from the top visible page', async () => {
	props.loadPage = vi.fn(async () => ({ messages: [], entries: [messageFixture(1)], page: { ...page, currentPage: 2, olderPage: 3, newerPage: 1 } })); render();
	await act(async () => button('Load page 2').click());
	const log = props.logRef.current!;
	vi.spyOn(log, 'getBoundingClientRect').mockReturnValue({ top: 50 } as DOMRect);
	for (const section of log.querySelectorAll('[data-chat-page]')) vi.spyOn(section, 'getBoundingClientRect').mockReturnValue({ bottom: 200 } as DOMRect);
	await act(async () => { await new Promise(done => requestAnimationFrame(done)); log.dispatchEvent(new Event('scroll')); });
	expect(container.textContent).toContain('Page 2 · archive'); expect(container.textContent).toContain('Injects into the newest page');
	expect(new URLSearchParams(location.search).get('page')).toBe('2');
});
it('ignores an unchanged authoritative snapshot while unpinned', () => {
	render(); props.pinned.current = false;
	props = { ...props, entries: structuredClone(props.entries) }; render();
	expect(container.querySelector('.loop-chat-new')).toBeNull();
});
it('rejects an older-page response from a different compaction generation', async () => {
	props.loadPage = vi.fn(async () => ({ messages: [], entries: [messageFixture(1)], page: { ...page, currentPage: 2, pages: page.pages.map(item => item.page === 2 ? { ...item, sourceCompactionSeq: 15 } : item) } })); render();
	await act(async () => button('Load page 2').click());
	expect(container.querySelectorAll('[data-chat-page]')).toHaveLength(1);
	expect(props.onRefresh).toHaveBeenCalledOnce(); expect(container.textContent).toContain('The archive pages changed.');
});
it('exits browser fullscreen when Back leaves chat mode', () => {
	history.replaceState({}, '', '/w/local/u/reader/loop?view=chat');
	const exit = vi.fn(async () => {});
	Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.documentElement });
	Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
	act(() => root.render(<ModeHarness />));
	act(() => { history.replaceState({}, '', '/w/local/u/reader/loop'); window.dispatchEvent(new PopStateEvent('popstate')); });
	expect(exit).toHaveBeenCalledOnce();
	delete (document as { fullscreenElement?: Element }).fullscreenElement;
	delete (document as { exitFullscreen?: unknown }).exitFullscreen;
});
it('keeps local card links out of browser history', () => {
	props.renderPage = () => <><a href="#card-target">Result</a><div id="card-target">Target</div></>;
	const scroll = vi.spyOn(Element.prototype, 'scrollIntoView'); render();
	const length = history.length;
	act(() => container.querySelector<HTMLAnchorElement>('a')!.click());
	expect(location.hash).toBe(''); expect(history.length).toBe(length); expect(scroll).toHaveBeenCalledOnce();
});
it('keeps loaded archive content when compaction moves the main page', async () => {
	props.loadPage = vi.fn(async () => ({ messages: [], entries: [messageFixture(1, { kind: 'model' }, 'Older retained content')], page: { ...page, currentPage: 2 } })); render();
	await act(async () => button('Load page 2').click());
	props = { ...props, page: { ...page, pageCount: 4, currentPage: 2, compactionPageBySeq: { '20': 2, '10': 3, '5': 4 }, pages: [
		{ page: 1, messageCount: 1 }, { page: 2, messageCount: 1, sourceCompactionSeq: 20 },
		{ page: 3, messageCount: 1, sourceCompactionSeq: 10 }, { page: 4, messageCount: 1, sourceCompactionSeq: 5 },
	] } }; render();
	expect([...container.querySelectorAll('[data-chat-page]')].map(node => node.getAttribute('data-chat-page'))).toEqual(['3', '2']);
	expect(container.textContent).toContain('Older retained content');
});
it('keeps the prepend anchor through delayed layout changes, then releases it on user input', async () => {
	let resized = () => {};
	vi.stubGlobal('ResizeObserver', class {
		callback: ResizeObserverCallback;
		constructor(callback: ResizeObserverCallback) { this.callback = callback; }
		observe(element: Element) { if (element.classList.contains('loop-chat-column')) resized = () => this.callback([], this as unknown as ResizeObserver); }
		unobserve() {} disconnect() {}
	});
	props.loadPage = vi.fn(async () => ({ messages: [], entries: [messageFixture(1)], page: { ...page, currentPage: 2 } })); render();
	const watched = container.querySelector('.agent-log-card')!;
	let extraHeight = 0;
	vi.spyOn(watched, 'getBoundingClientRect').mockImplementation(() => ({ top: 100 + extraHeight - props.logRef.current!.scrollTop } as DOMRect));
	await act(async () => button('Load page 2').click());
	extraHeight = 54;
	act(() => resized()); expect(props.logRef.current!.scrollTop).toBe(54); expect(watched.getBoundingClientRect().top).toBe(100);
	act(() => props.logRef.current!.dispatchEvent(new WheelEvent('wheel', { bubbles: true })));
	extraHeight = 84;
	act(() => resized()); expect(props.logRef.current!.scrollTop).toBe(54);
});
it('loads the next distinct archive after compaction renumbers loaded pages', async () => {
	props.loadPage = vi.fn(async target => ({ messages: [], entries: [messageFixture(target)], page: { ...props.page!, currentPage: target } })); render();
	await act(async () => button('Load page 2').click());
	props = { ...props, page: { ...page, pageCount: 4, currentPage: 2, compactionPageBySeq: { '20': 2, '10': 3, '5': 4 }, pages: [
		{ page: 1, messageCount: 1 }, { page: 2, messageCount: 1, sourceCompactionSeq: 20 },
		{ page: 3, messageCount: 1, sourceCompactionSeq: 10 }, { page: 4, messageCount: 1, sourceCompactionSeq: 5 },
	] } }; render();
	await act(async () => button('Load page 1').click());
	expect(props.loadPage).toHaveBeenLastCalledWith(4);
	expect([...container.querySelectorAll('[data-chat-page]')].map(node => node.getAttribute('data-chat-page'))).toEqual(['4', '3', '2']);
});
it('keeps the test banner and its exit link above the chat bar', () => {
	const banner = document.createElement('aside'); banner.className = 'test-environment-banner';
	const link = document.createElement('a'); link.href = '/leave-test'; link.textContent = 'Leave test'; banner.append(link); document.body.prepend(banner);
	document.body.classList.add('bickr-test-environment');
	try { render(); expect(container.querySelector('.loop-chat-test a')?.getAttribute('href')).toBe(link.href); }
	finally { banner.remove(); document.body.classList.remove('bickr-test-environment'); }
});
it('drops cached archives when an authoritative map reveals a missed reset', async () => {
	props.loadPage = vi.fn(async () => ({ messages: [], entries: [messageFixture(1, { kind: 'model' }, 'Deleted archive content')], page: { ...page, currentPage: 2 } })); render();
	await act(async () => button('Load page 2').click()); expect(container.textContent).toContain('Deleted archive content');
	props = { ...props, page: { currentPage: 1, pageCount: 1, pages: [{ page: 1, messageCount: 0 }], compactionPageBySeq: {} }, entries: [] }; render();
	expect(container.textContent).not.toContain('Deleted archive content'); expect(container.querySelectorAll('[data-chat-page]')).toHaveLength(1);
	props = { ...props, page }; render();
	expect(container.textContent).not.toContain('Deleted archive content');
});
