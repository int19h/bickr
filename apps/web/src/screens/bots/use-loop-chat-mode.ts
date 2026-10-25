import { useEffect, useRef, useState } from 'react';

export function loopPageFromUrl(): number {
	const value = Number(new URLSearchParams(window.location.search).get('page'));
	return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function useLoopChatMode() {
	const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get('view') === 'chat');
	const normalScroll = useRef(0);
	const wasChatOpen = useRef(open);
	const pathname = window.location.pathname;
	useEffect(() => { setOpen(new URLSearchParams(window.location.search).get('view') === 'chat'); }, [pathname]);
	useEffect(() => {
		const changed = () => setOpen(new URLSearchParams(window.location.search).get('view') === 'chat');
		window.addEventListener('popstate', changed);
		return () => window.removeEventListener('popstate', changed);
	}, []);
	useEffect(() => {
		if (wasChatOpen.current && !open && document.fullscreenElement) void document.exitFullscreen();
		wasChatOpen.current = open;
	}, [open]);
	useEffect(() => () => { if (wasChatOpen.current && document.fullscreenElement) void document.exitFullscreen(); }, []);
	function enter(page: number) {
		const url = new URL(window.location.href);
		url.searchParams.set('view', 'chat');
		if (page > 1) url.searchParams.set('page', String(page));
		window.history.pushState({ ...window.history.state, loopChatReturn: window.location.href }, '', url);
		setOpen(true);
	}
	function exit() {
		const previous = window.history.state?.loopChatReturn;
		if (typeof previous === 'string' && new URL(previous).pathname === window.location.pathname) {
			window.history.back();
		} else {
			const url = new URL(window.location.href);
			url.searchParams.delete('view');
			window.history.replaceState(window.history.state, '', url);
			setOpen(false);
		}
	}
	return { open, enter, exit, normalScroll };
}
