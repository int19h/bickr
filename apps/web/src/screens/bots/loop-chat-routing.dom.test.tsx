// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalizeCurrentPath, parseBrowserRoute } from '../../app-routing';
import { setLoopChatPage, useLoopChatMode } from './use-loop-chat-mode';

let root: Root, container: HTMLDivElement;
function RouterHarness() {
	const mode = useLoopChatMode();
	useEffect(() => {
		const normalize = () => canonicalizeCurrentPath(parseBrowserRoute());
		normalize(); window.addEventListener('popstate', normalize);
		return () => window.removeEventListener('popstate', normalize);
	}, []);
	useEffect(() => { if (mode.open) setLoopChatPage(1); }, [mode.open]);
	return mode.open ? <button onClick={mode.exit}>Exit</button> : <button onClick={() => mode.enter(1)}>Enter</button>;
}
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	history.replaceState({}, '', '/w/local/u/reader/loop');
	container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function travel(action: () => void) {
	await act(async () => new Promise<void>(resolve => {
		window.addEventListener('popstate', () => resolve(), { once: true });
		action();
	}));
}
it('keeps the return entry through router Back, Forward, and exit on page 1', async () => {
	act(() => root.render(<RouterHarness />)); act(() => container.querySelector('button')!.click());
	expect(location.search).toBe('?view=chat');
	const returnTo = history.state.loopChatReturn;
	await travel(() => history.back()); expect(container.textContent).toBe('Enter');
	await travel(() => history.forward()); expect(container.textContent).toBe('Exit');
	expect(location.search).toBe('?view=chat'); expect(history.state.loopChatReturn).toBe(returnTo);
	await travel(() => container.querySelector('button')!.click());
	expect(location.search).toBe(''); expect(container.textContent).toBe('Enter');
});
it('preserves the return marker when reload normalizes a chat URL', () => {
	const returnTo = new URL('/w/local/u/reader/loop', location.href).href;
	history.pushState({ loopChatReturn: returnTo }, '', '/w/local/u/reader/loop?view=chat&page=1');
	act(() => root.render(<RouterHarness />));
	expect(location.search).toBe('?view=chat'); expect(history.state.loopChatReturn).toBe(returnTo);
	act(() => root.unmount()); root = createRoot(container);
	act(() => root.render(<RouterHarness />));
	expect(history.state.loopChatReturn).toBe(returnTo);
	const back = vi.spyOn(history, 'back').mockImplementation(() => {});
	act(() => container.querySelector('button')!.click()); expect(back).toHaveBeenCalledOnce();
});
