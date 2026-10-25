import type { AgentLogEntry, BotLoopMessagePage, BotLoopMessagesResponse, BotRuntimeStatus, BotSummary, BotTokenUsageStats } from '@bickr/shared/model';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Avatar, Icon, Modal, textValue } from '../../ui';
import { loopPagePagerItems } from '../../loop-page-pager';
import { setLoopChatPage } from './use-loop-chat-mode';

export type LoopChatViewProps = {
	bot: BotSummary;
	status: BotRuntimeStatus | null;
	connected: boolean;
	enabled: boolean;
	starting: boolean;
	busy: boolean;
	context?: BotTokenUsageStats['contextWindow'];
	startedAt?: string;
	entries: AgentLogEntry[];
	page: BotLoopMessagePage | null;
	injection: string;
	injecting: boolean;
	archiveRefreshKey?: number;
	setInjection: (value: string) => void;
	onInject: () => Promise<boolean>;
	onRun: () => void;
	onStop: () => void;
	onPause: () => void;
	onCompact: () => void;
	canCompact: boolean;
	onRefresh: () => void;
	onExit: () => void;
	onPage: (page: number, notice?: boolean) => void;
	loadPage: (page: number, source?: number) => Promise<BotLoopMessagesResponse | null>;
	renderPage: (entries: AgentLogEntry[], page: BotLoopMessagePage | null) => ReactNode;
	logRef: RefObject<HTMLDivElement | null>;
	pinned: RefObject<boolean>;
	onScroll: () => void;
	message: string;
	deletedSeqs: ReadonlySet<number>;
	navigationKey?: number;
};

export function chatPageNumber(page: BotLoopMessagePage, apiPage: number) {
	return page.pageCount + 1 - apiPage;
}

export function formatChatWait(milliseconds: number): string {
	const minutes = Math.max(0, Math.ceil(milliseconds / 60000));
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) return `in ${days} d${hours % 24 ? ` ${hours % 24} h` : ''}`;
	if (hours > 0) return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
	return `in ${minutes} min`;
}

export function LoopChatView(props: LoopChatViewProps) {
	const { bot, page, logRef, pinned } = props;
	const root = useRef<HTMLDivElement>(null);
	const field = useRef<HTMLTextAreaElement>(null);
	const [overlay, setOverlay] = useState<'pages' | 'more' | null>(null);
	const [older, setOlder] = useState<BotLoopMessagesResponse[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState('');
	const [visiblePage, setVisiblePage] = useState(page?.currentPage ?? 1);
	const visibleSection = useRef('main');
	const [newMessages, setNewMessages] = useState(false);
	const [now, setNow] = useState(Date.now());
	const generation = useRef(0);
	const anchor = useRef<{ element: Element; top: number } | null>(null);
	const restoringAnchor = useRef(false);
	const anchorFrame = useRef(0);
	const resizing = useRef(false);
	const signature = useMemo(() => JSON.stringify(props.entries), [props.entries]);
	const previousSignature = useRef(signature);
	const hadEntries = useRef(props.entries.length > 0);
	const overlayRef = useRef(overlay);
	overlayRef.current = overlay;
	const archive = visiblePage !== 1;
	const mainSource = page?.pages.find(item => item.page === page.currentPage)?.sourceCompactionSeq ?? null;
	const pageMapIdentity = JSON.stringify(page?.compactionPageBySeq);
	const retainedOlder = useMemo(() => older.filter(snapshot => {
		const source = snapshot.page.pages.find(item => item.page === snapshot.page.currentPage)?.sourceCompactionSeq;
		return source != null && page?.compactionPageBySeq[String(source)] !== undefined;
	}), [older, page]);
	useLayoutEffect(() => {
		// A fresh page map also removes archives after a missed reset frame.
		if (retainedOlder.length !== older.length) setOlder(retainedOlder);
	}, [retainedOlder, older.length]);
	useLayoutEffect(() => {
		setOlder([]); setNewMessages(false); setVisiblePage(page?.currentPage ?? 1); visibleSection.current = 'main'; anchor.current = null;
	}, [props.navigationKey, bot.id]);
	useEffect(() => {
		generation.current++; setLoading(false);
	}, [mainSource, page?.currentPage, pageMapIdentity, props.navigationKey]);
	const olderRef = useRef(retainedOlder);
	olderRef.current = retainedOlder;
	useEffect(() => {
		const cached = olderRef.current;
		if (!page || cached.length === 0) return;
		const requestGeneration = ++generation.current;
		setLoading(true);
		const sources = cached.flatMap(snapshot => {
			const source = snapshot.page.pages.find(item => item.page === snapshot.page.currentPage)?.sourceCompactionSeq;
			const number = source == null ? undefined : page.compactionPageBySeq[String(source)];
			return source != null && number !== undefined ? [{ source, number }] : [];
		});
		void Promise.all(sources.map(async ({ source, number }) => props.loadPage(number, source))).then(snapshots => {
			if (requestGeneration !== generation.current) return;
			setLoading(false);
			const element = logRef.current?.querySelector('[data-chat-page] .agent-log-card');
			if (element) anchor.current = { element, top: element.getBoundingClientRect().top };
			// Failed archive reads invalidate the cache instead of retaining stale content.
			setOlder(snapshots.filter((snapshot): snapshot is BotLoopMessagesResponse => snapshot !== null));
		});
	}, [props.archiveRefreshKey, pageMapIdentity]);

	useEffect(() => {
		if (!page) return;
		const selected = visibleSection.current === 'main' ? page.currentPage : page.compactionPageBySeq[visibleSection.current] ?? page.currentPage;
		setVisiblePage(selected);
		setLoopChatPage(selected);
	}, [page]);
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	useLayoutEffect(() => {
		const textarea = field.current;
		if (!textarea) return;
		textarea.style.height = '40px';
		textarea.style.height = `${Math.min(112, Math.max(40, textarea.scrollHeight))}px`;
	}, [props.injection]);
	useEffect(() => {
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		document.body.classList.add('loop-chat-open');
		// Keep the app chrome out of the focus order while modals stay available.
		const hidden: Array<{ node: HTMLElement; inert: boolean }> = [];
		for (let branch: HTMLElement | null = root.current; branch?.parentElement && branch !== document.body; branch = branch.parentElement) {
			for (const node of branch.parentElement.children) {
				if (node !== branch && node instanceof HTMLElement && !node.matches('.modal-veil, script, style')) {
					hidden.push({ node, inert: node.inert }); node.inert = true;
				}
			}
		}
		root.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
		const viewport = window.visualViewport;
		let frame = 0;
		const resize = () => {
			resizing.current = true;
			anchor.current = null;
			if (viewport && root.current) {
				root.current.style.height = `${viewport.height}px`;
				root.current.style.transform = `translateY(${viewport.offsetTop}px)`;
			}
			if (pinned.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => { resizing.current = false; });
		};
		resize(); viewport?.addEventListener('resize', resize); viewport?.addEventListener('scroll', resize);
		const key = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || document.querySelector('.modal-veil')) return;
			event.preventDefault();
			if (overlayRef.current) setOverlay(null);
			else if (document.activeElement === field.current && field.current?.value) field.current.blur();
			else props.onExit();
		};
		window.addEventListener('keydown', key);
		return () => {
			generation.current++;
			cancelAnimationFrame(frame);
			cancelAnimationFrame(anchorFrame.current);
			viewport?.removeEventListener('resize', resize); viewport?.removeEventListener('scroll', resize);
			window.removeEventListener('keydown', key);
			document.body.style.overflow = previousOverflow;
			document.body.classList.remove('loop-chat-open');
			for (const item of hidden) item.node.inert = item.inert;
		};
	}, []);
	useLayoutEffect(() => {
		if (hadEntries.current && previousSignature.current !== signature && !pinned.current) setNewMessages(true);
		previousSignature.current = signature;
		hadEntries.current = props.entries.length > 0;
	}, [signature, pinned]);
	function restoreAnchor() {
		const saved = anchor.current;
		if (!saved || !logRef.current || !saved.element.isConnected) return;
		const shift = saved.element.getBoundingClientRect().top - saved.top;
		if (Math.abs(shift) < 0.5) return;
		restoringAnchor.current = true;
		logRef.current.scrollTop += shift;
		cancelAnimationFrame(anchorFrame.current);
		anchorFrame.current = requestAnimationFrame(() => { restoringAnchor.current = false; });
	}
	useLayoutEffect(restoreAnchor, [older, logRef]);
	useEffect(() => {
		const column = logRef.current?.firstElementChild;
		if (!column || typeof ResizeObserver === 'undefined') return;
		// Markdown and clamp controls can change height after the first render.
		const observer = new ResizeObserver(() => { if (!resizing.current) restoreAnchor(); });
		observer.observe(column);
		return () => observer.disconnect();
	}, [logRef]);
	useEffect(() => {
		if (!logRef.current || typeof ResizeObserver === 'undefined') return;
		const heights = new WeakMap<Element, number>();
		const observer = new ResizeObserver(records => {
			for (const record of records) {
				const next = record.target.getBoundingClientRect().height;
				if (next > (heights.get(record.target) ?? next) && !resizing.current && !pinned.current) setNewMessages(true);
				heights.set(record.target, next);
			}
		});
		for (const live of logRef.current.querySelectorAll('.is-live')) { heights.set(live, live.getBoundingClientRect().height); observer.observe(live); }
		return () => observer.disconnect();
	}, [logRef, pinned, props.entries]);
	function scroll() {
		if (resizing.current || restoringAnchor.current) return;
		anchor.current = null;
		props.onScroll();
		if (pinned.current) setNewMessages(false);
		const log = logRef.current;
		if (!log) return;
		const top = log.getBoundingClientRect().top;
		const sections = [...log.querySelectorAll<HTMLElement>('[data-chat-page]')];
		const section = sections.find(item => item.getBoundingClientRect().bottom > top + 1);
		if (section) {
			const selected = Number(section.dataset.chatPage);
			setVisiblePage(selected);
			visibleSection.current = section.dataset.chatSource ?? 'main';
			setLoopChatPage(selected);
		}
	}
	function bottom() {
		pinned.current = true;
		setNewMessages(false);
		if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
	}
	const oldestSnapshot = retainedOlder[0];
	const oldestSource = oldestSnapshot?.page.pages.find(item => item.page === oldestSnapshot.page.currentPage)?.sourceCompactionSeq;
	const oldest = oldestSource == null ? page?.currentPage ?? 1 : page?.compactionPageBySeq[String(oldestSource)] ?? page?.currentPage ?? 1;
	async function loadOlder() {
		if (loading) return;
		const requestGeneration = generation.current;
		const target = oldest + 1;
		const expectedSource = page?.pages.find(item => item.page === target)?.sourceCompactionSeq ?? null;
		setLoading(true); setLoadError('');
		const result = await props.loadPage(oldest + 1);
		if (requestGeneration !== generation.current) return;
		setLoading(false);
		if (!result) { setLoadError('Failed to load the older page. Try again.'); return; }
		const source = result.page.pages.find(item => item.page === result.page.currentPage)?.sourceCompactionSeq ?? null;
		if (source !== expectedSource || result.page.currentPage !== target || result.page.pageCount !== page?.pageCount) {
			setLoadError('The archive pages changed. Refresh the log before trying again.'); props.onRefresh(); return;
		}
		const element = logRef.current?.querySelector('[data-chat-page] .agent-log-card') ?? logRef.current?.querySelector('[data-chat-page]');
		if (element) anchor.current = { element, top: element.getBoundingClientRect().top };
		pinned.current = false;
		setOlder(current => [result, ...current]);
	}
	const running = props.status?.status === 'running';
	const elapsed = props.startedAt ? Math.max(0, Math.floor((now - Date.parse(props.startedAt)) / 1000)) : null;
	const statusText = running ? `visit running${elapsed === null ? '' : ` · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`}`
		: !props.enabled ? 'paused' : !props.connected || !props.status?.nextDueAt ? 'polling'
			: `next tick ${formatChatWait(Date.parse(props.status.nextDueAt) - now)}`;
	const percent = props.context ? props.context.promptTokens / props.context.contextWindowTokens * 100 : null;
	const pageLabel = page ? `Page ${chatPageNumber(page, visiblePage)} · ${archive ? 'archive' : 'newest'}` : 'Loading page';
	const fullscreen = document.fullscreenEnabled === true;
	const leaveTestUrl = document.querySelector<HTMLAnchorElement>('.test-environment-banner a')?.href;
	async function browserFullscreen() {
		try { await document.documentElement.requestFullscreen(); setOverlay(null); }
		catch { setLoadError('Browser fullscreen is not available.'); }
	}
	function selectPage(target: number, notice = false) { setOverlay(null); props.onPage(target, notice); }
	const hideDeleted = (entries: AgentLogEntry[]) => entries.filter(entry => entry.kind !== 'message' || !props.deletedSeqs.has(entry.message.seq));
	return <div className="loop-chat" ref={root} aria-label="Loop chat view"
		onPointerDownCapture={() => { anchor.current = null; }} onWheelCapture={() => { anchor.current = null; }}
		onKeyDownCapture={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Enter'].includes(event.key)) anchor.current = null; }}
		onClickCapture={event => {
			const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#"]') : null;
			let id = link?.hash.slice(1) ?? '';
			try { id = decodeURIComponent(id); } catch { /* Keep malformed URL fragments as literal IDs. */ }
			const target = id ? document.getElementById(id) : null;
			// Local jumps must not add history entries between chat and its return page.
			if (target) { event.preventDefault(); target.scrollIntoView({ block: 'center' }); }
		}}>
		{document.body.classList.contains('bickr-test-environment') && <div className="loop-chat-test"><span>TEST ENVIRONMENT · Changes do not affect bickr.social.</span>{leaveTestUrl && <a href={leaveTestUrl}>Leave test</a>}</div>}
		<header className="loop-chat-bar">
			<button className="btn ghost chat-icon" aria-label="Exit chat view" onClick={props.onExit}><Icon name="collapse" /></button>
			<Avatar name={bot.displayName} imageUrl={bot.avatarUrl} crop={bot.avatarCrop} size="sm" displayPixels={28} />
			<div className="loop-chat-identity"><div><strong>{textValue(bot.displayName)}</strong><span className="chat-desktop">u/{bot.handle}</span></div><small><i className={`live-dot ${props.connected ? 'on' : ''}`} />{statusText}</small></div>
			<button className={`btn chat-page-chip ${archive ? 'archive' : ''}`} onClick={() => setOverlay('pages')} aria-haspopup="dialog">{pageLabel}</button>
			{fullscreen && <button className="btn ghost chat-desktop" onClick={() => void browserFullscreen()}>Browser fullscreen</button>}
			<button className="btn ghost chat-icon" aria-label="More" aria-haspopup="dialog" onClick={() => setOverlay('more')}><Icon name="more" /></button>
		</header>
		<div className="loop-chat-context" role="progressbar" aria-label="Context window" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.min(100, Math.round(percent))} title={percent === null ? 'No context estimate yet' : `${Math.round(percent)}% of context window`}><span style={{ width: `${Math.min(100, percent ?? 0)}%` }} /></div>
		<div className="loop-chat-log agent-log-scroll" ref={logRef} onScroll={scroll} tabIndex={0} aria-label="Visit chat">
			<div className="loop-chat-column">
				{page && oldest < page.pageCount && <div className="loop-chat-load"><button className="btn" onClick={() => void loadOlder()} disabled={loading}>{loading ? 'Loading…' : `Load page ${chatPageNumber(page, oldest + 1)}`}</button></div>}
				{retainedOlder.map(snapshot => {
					const source = snapshot.page.pages.find(item => item.page === snapshot.page.currentPage)?.sourceCompactionSeq;
					const number = source == null ? snapshot.page.currentPage : page?.compactionPageBySeq[String(source)] ?? snapshot.page.currentPage;
					const metadata = page ? { ...page, currentPage: number, olderPage: number < page.pageCount ? number + 1 : undefined, newerPage: number > 1 ? number - 1 : undefined } : snapshot.page;
					return <section data-chat-page={number} data-chat-source={source} key={source ?? number}>{props.renderPage(hideDeleted(snapshot.entries), metadata)}</section>;
				})}
				<section data-chat-page={page?.currentPage ?? 1} data-chat-source="main">{props.renderPage(props.entries, page)}</section>
			</div>
		</div>
		<div className="loop-chat-composer-wrap">
			{newMessages && <button className="loop-chat-new" onClick={bottom}>New messages <Icon name="arrowDown" size={14} /></button>}
			{(props.message || loadError) && <div className="loop-chat-feedback" role="status">{loadError || props.message}</div>}
			<div className="loop-chat-composer-column">
				{archive && <div className="loop-chat-archive-hint">Injects into the newest page</div>}
				<form className="loop-chat-composer" onSubmit={event => { event.preventDefault(); if (props.injecting || !props.injection.trim()) return; void props.onInject().then(sent => { if (sent) bottom(); }); }}>
					<textarea className="input" ref={field} aria-label="Inject a thought or focus" placeholder={window.matchMedia('(max-width: 600px), (pointer: coarse)').matches ? 'Inject a thought or focus' : 'Inject a thought or focus · Enter to send, Shift+Enter for a new line'} value={props.injection} onChange={event => props.setInjection(event.target.value)} onKeyDown={event => {
						if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !window.matchMedia('(max-width: 600px), (pointer: coarse)').matches) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
					}} />
					<button className="btn primary chat-inject" type="submit" aria-label="Inject" disabled={props.injecting || !props.injection.trim()}><Icon name="send" /></button>
					<button className={`btn chat-run ${running ? 'running' : ''}`} type="button" disabled={props.starting || props.busy || (!running && !props.enabled) || (running && Boolean(props.status?.stopState))} title={!running && !props.enabled ? 'Unpause before starting a visit' : undefined} onClick={running ? props.onStop : props.onRun}>
						{props.starting ? <span className="chat-spinner" aria-label="Starting visit" /> : <Icon name={running ? 'stop' : 'play'} />}{running ? <><span className="chat-phone">Stop</span><span className="chat-desktop">Stop visit</span></> : 'Run'}
					</button>
				</form>
			</div>
		</div>
		<Modal open={overlay !== null} onClose={() => setOverlay(null)} title={overlay === 'pages' ? 'Loop pages' : 'More'} className="loop-chat-sheet">
			{overlay === 'pages' ? <>
				<nav className="loop-chat-pages" aria-label="Loop history pages">{page && (page.pageCount === 1 ? [{ kind: 'page' as const, page: 1 }] : loopPagePagerItems({ ...page, currentPage: visiblePage })).map(item => <button className={`btn ${item.page === visiblePage ? 'primary' : ''}`} key={item.page} onClick={() => selectPage(item.page)} aria-current={item.page === visiblePage ? 'page' : undefined}>{item.kind === 'ellipsis' ? '…' : `Page ${chatPageNumber(page, item.page)}`}</button>)}</nav>
				{page?.pages.find(item => item.page === visiblePage)?.sourceCompactionSeq != null && <button className="btn ghost" onClick={() => selectPage(visiblePage, true)}>Open the compaction notice for page {chatPageNumber(page, visiblePage)}</button>}
				<button className="btn ghost" onClick={() => { setOverlay(null); if (page?.currentPage === 1) bottom(); else selectPage(1); }}>Jump to the newest message</button>
			</> : <>
				<button className="btn ghost" disabled={archive || !props.canCompact} onClick={() => { setOverlay(null); props.onCompact(); }}>Compact chat</button>
				<button className="btn ghost" onClick={() => { setOverlay(null); props.onRefresh(); }}>Refresh log</button>
				<button className="btn ghost" disabled={props.busy} onClick={() => { setOverlay(null); props.onPause(); }}>{props.enabled ? 'Pause loop' : 'Unpause loop'}</button>
				{fullscreen && <button className="btn ghost" onClick={() => void browserFullscreen()}>Browser fullscreen</button>}
				<button className="btn ghost" onClick={() => { void navigator.clipboard.writeText(window.location.href).then(() => { setOverlay(null); setLoadError('Chat link copied.'); }, () => setLoadError('Failed to copy the chat link.')); }}>Copy link to chat view</button>
				<button className="btn ghost" onClick={props.onExit}>Open full Loop page</button>
			</>}
		</Modal>
	</div>;
}
