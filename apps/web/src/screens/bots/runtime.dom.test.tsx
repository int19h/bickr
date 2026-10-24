import type { AgentLogEntry, BotLoopMessage, BotLoopMessagePage, BotRuntimeEvent, BotSummary } from '@bickr/shared/model';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotRuntimePanel } from './runtime';
import { requestFixture } from './agent-log.fixtures';
import * as runtimeUtils from './runtime-utils';

type PendingMessages = {
	path: string;
	resolve: (response: { messages: BotLoopMessage[]; entries: AgentLogEntry[]; page: BotLoopMessagePage }) => void;
};

type PendingEvents = {
	resolve: (events: BotRuntimeEvent[]) => void;
};

class MonitorSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: MonitorSocket[] = [];
	readyState = MonitorSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: MessageEvent<string>) => void) | null = null;
	readonly url: string;

	constructor(url: string) {
		this.url = url;
		MonitorSocket.instances.push(this);
	}

	open(): void {
		this.readyState = MonitorSocket.OPEN;
		this.onopen?.();
	}

	close(): void {
		this.readyState = MonitorSocket.CLOSED;
		this.onclose?.();
	}

	send(): void {}

	emit(payload: unknown): void {
		this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
	}
}

const bot = {
	id: 'bot_runtime_dom',
	handle: 'runtime-dom',
	displayName: { text: 'Runtime DOM', language: null },
	tickSettings: { enabled: true, intervalSeconds: 300 },
	effectiveTickSettings: { contextWindowTokens: 16_000 },
} as unknown as BotSummary;

const loopMessage = (seq: number, content: string): BotLoopMessage => ({
	seq,
	position: seq,
	runId: `run-${seq}`,
	role: 'assistant',
	message: { role: 'assistant', content },
	contentFormat: "text",
	origin: 'provider_response',
	status: 'complete',
	tokenEstimate: 2,
	createdAt: '2026-08-23T00:00:00.000Z',
});

let container: HTMLDivElement;
let root: Root;
let pendingMessages: PendingMessages[];
let pendingEvents: PendingEvents[];
let holdEventSnapshots: boolean;
let runtimeStatus: 'running' | 'idle';
let pendingInference: Array<{ path: string; resolve: (response: Response) => void }>;
let pendingRequests: Array<{ path: string; resolve: (response: Response) => void }>;
let pendingLogs: Array<{ path: string; resolve: (response: Response) => void }>;
let pendingCompactions: Array<(response: Response) => void>;

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	pendingMessages = [];
	pendingEvents = [];
	holdEventSnapshots = false;
	runtimeStatus = 'running';
	pendingInference = [];
	pendingLogs = [];
	pendingCompactions = [];
	pendingRequests = [];
	MonitorSocket.instances = [];
	vi.stubGlobal('WebSocket', MonitorSocket);
	vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
		const path = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		if (path.includes('/effective-models?')) {
			return Promise.resolve(json({ ok: true, data: { effectiveModels: { models: [{ botId: bot.id, effectiveModel: 'test/model' }] } } }));
		}
		if (path.endsWith('/runtime/status')) {
			return Promise.resolve(json({ ok: true, data: { status: { botId: bot.id, enabled: true, status: runtimeStatus } } }));
		}
		if (path.endsWith('/runtime/events')) {
			if (holdEventSnapshots) {
				return new Promise<Response>((resolve) => {
					pendingEvents.push({ resolve: (events) => resolve(json({ ok: true, data: { events } })) });
				});
			}
			return Promise.resolve(json({ ok: true, data: { events: [] } }));
		}
		if (path.endsWith('/runtime/token-usage')) {
			return Promise.resolve(json({ ok: false, error: 'unavailable', message: 'usage unavailable' }, 503));
		}
		if (path.endsWith('/runtime/compact')) return new Promise<Response>(resolve => pendingCompactions.push(resolve));
		if (path.includes('/runtime/requests/')) {
			return new Promise<Response>(resolve => pendingRequests.push({ path, resolve }));
		}
		if (path.includes('/runtime/inference-logs')) {
			return new Promise<Response>(resolve => pendingInference.push({ path, resolve }));
		}
		if (/\/runtime\/messages\/\d+\/logs$/.test(path)) {
			return new Promise<Response>(resolve => pendingLogs.push({ path, resolve }));
		}
		if (path.includes('/runtime/messages')) {
			return new Promise<Response>((resolve) => {
				pendingMessages.push({ path, resolve: ({ messages, entries, page }) => resolve(json({
					ok: true,
					data: { messages, entries, page },
				})) });
			});
		}
		throw new Error(`Unexpected fetch: ${path}`);
	});
	container = document.createElement('div');
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root.render(<BotRuntimePanel bot={bot} busy={false} onSave={async () => true} />);
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	window.history.replaceState({}, '', '/');
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('source inference navigation', () => {
	async function openSource(query = `?inference=7&sourceBot=${bot.id}&runId=run-source`): Promise<void> {
		await act(async () => root.unmount());
		pendingMessages = [];
		window.history.replaceState({}, '', `/w/primary/u/runtime-dom/loop${query}`);
		root = createRoot(container);
		await act(async () => root.render(<BotRuntimePanel bot={bot} busy={false} onSave={async () => true} />));
	}

	async function resolveSource(target: BotLoopMessage, index = 0): Promise<void> {
		await act(async () => pendingInference[index]!.resolve(json({ ok: true, data: { message: target, logs: [] } })));
	}

	async function paintScroll(): Promise<void> {
		await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())));
	}

	it('opens the compacted page, highlights and scrolls to the source, and keeps raw logs behind the info button', async () => {
		const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
		await openSource();
		const target = { ...loopMessage(12, 'Source response'), runId: 'run-source', compactedBy: 40, hasLogs: true };
		await answerMessages(0, [loopMessage(90, 'Active generation')]);
		await resolveSource(target);
		expect(pendingInference[0]?.path).toContain('requestSeq=7&runId=run-source');
		const pages = [{ page: 1, messageCount: 1 }, { page: 2, messageCount: 2, sourceCompactionSeq: 40 }];
		await answerMessages(1, [loopMessage(90, 'Active generation')], page(1, { 40: 2 }, pages));
		expect(pendingMessages[2]?.path).toContain('page=2');
		await answerMessages(2, [loopMessage(11, 'Other response'), target], page(2, { 40: 2 }, pages));
		await paintScroll();
		const row = container.querySelector('.source-message-highlight');
		expect(row?.textContent).toContain('Source response');
		expect(scroll.mock.instances).toEqual([row]);
		expect(scroll).toHaveBeenCalledWith({ block: 'center' });
		expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('2');
		expect(document.querySelector('.modal')).toBeNull();
		expect(pendingLogs).toHaveLength(0);

		const info = row!.querySelector<HTMLButtonElement>('[aria-label="Open raw logs for loop message 12"]')!;
		await act(async () => info.click());
		expect(pendingLogs).toHaveLength(1);
		await act(async () => pendingLogs[0]!.resolve(json({ ok: true, data: { message: target, logs: [] } })));
		expect(document.body.textContent).toContain('Loop Message Logs');
	});

	it('suppresses bottom scrolling on the active page and does not scroll again for live updates', async () => {
		const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
		const bottomScroll = vi.spyOn(runtimeUtils, 'scrollLogToBottom');
		await openSource();
		const target = { ...loopMessage(12, 'Active source'), runId: 'run-source' };
		await resolveSource(target);
		await answerMessages(1, [target, loopMessage(90, 'Newer response')]);
		await paintScroll();
		const callsAfterNavigation = bottomScroll.mock.calls.length;
		await act(async () => MonitorSocket.instances.at(-1)!.emit({ type: 'loop_message', loopMessage: loopMessage(91, 'Live response') }));
		await paintScroll();
		expect(scroll).toHaveBeenCalledTimes(1);
		expect(bottomScroll.mock.calls.length).toBe(callsAfterNavigation);
		expect(container.querySelector('.source-message-highlight')?.textContent).toContain('Active source');
		expect(document.querySelector('.modal')).toBeNull();
		// An initial snapshot must not overwrite the navigation response.
		await answerMessages(0, [loopMessage(1, 'Stale response')]);
		expect(container.textContent).not.toContain('Stale response');
	});

	it('shows an unavailable source error without opening a modal', async () => {
		await openSource();
		await act(async () => pendingInference[0]!.resolve(json({ ok: false, error: 'not_found', message: 'The source inference is no longer retained in this loop.' }, 404)));
		expect(container.textContent).toContain('The source inference is no longer retained in this loop.');
		expect(document.querySelector('.modal')).toBeNull();
		expect(container.querySelector('.source-message-highlight')).toBeNull();
	});

	it('finds an active source compacted between lookup and page refresh', async () => {
		const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
		await openSource();
		const target = { ...loopMessage(12, 'Source moved during navigation'), runId: 'run-source' };
		await resolveSource(target);
		const pages = [{ page: 1, messageCount: 1 }, { page: 2, messageCount: 1, sourceCompactionSeq: 40 }];
		await answerMessages(1, [loopMessage(40, 'New compaction')], page(1, { 40: 2 }, pages));
		expect(pendingInference).toHaveLength(2);
		// Live refreshes during the second lookup must not consume its retry.
		await act(async () => MonitorSocket.instances.at(-1)!.open());
		await answerMessages(2, [loopMessage(40, 'New compaction')], page(1, { 40: 2 }, pages));
		expect(container.textContent).not.toContain('no longer available on its loop page');
		await resolveSource({ ...target, compactedBy: 40 }, 1);
		await answerMessages(3, [loopMessage(40, 'New compaction')], page(1, { 40: 2 }, pages));
		expect(pendingMessages[4]?.path).toContain('page=2');
		await answerMessages(4, [{ ...target, compactedBy: 40 }], page(2, { 40: 2 }, pages));
		await paintScroll();
		expect(container.querySelector('.source-message-highlight')?.textContent).toContain('Source moved during navigation');
		expect(scroll).toHaveBeenCalledTimes(1);
		expect(pendingInference).toHaveLength(2);
		expect(document.querySelector('.modal')).toBeNull();
	});

	it('bounds source resolution if the message remains absent', async () => {
		await openSource();
		const target = { ...loopMessage(12, 'Missing source'), runId: 'run-source' };
		await resolveSource(target);
		await answerMessages(1, []);
		expect(pendingInference).toHaveLength(2);
		await resolveSource(target, 1);
		await answerMessages(2, []);
		expect(container.textContent).toContain('The source inference is no longer available on its loop page.');
		expect(pendingInference).toHaveLength(2);
		expect(pendingMessages).toHaveLength(3);
	});

	it('rejects links for a different author without requesting inference logs', async () => {
		await openSource('?inference=7&sourceBot=another-bot&runId=run-source');
		expect(pendingInference).toHaveLength(0);
		expect(container.textContent).toContain('This profile no longer identifies the author of that inference.');
	});

	it('ignores a source lookup that completes after the participant changes', async () => {
		await openSource();
		const other = { ...bot, id: 'other-bot' };
		await act(async () => root.render(<BotRuntimePanel bot={other} busy={false} onSave={async () => true} />));
		await resolveSource({ ...loopMessage(12, 'Wrong participant'), runId: 'run-source' });
		expect(pendingMessages).toHaveLength(2);
		expect(container.querySelector('.source-message-highlight')).toBeNull();
		expect(document.querySelector('.modal')).toBeNull();
	});
});

describe('runtime monitor authoritative reconciliation', () => {
	it('invalidates an older event snapshot on an ordinary socket event and converges through one trailing snapshot', async () => {
		await answerMessages(0, []);
		const observedEventSeqs: number[][] = [];
		const latestPersistentEventSeq = runtimeUtils.latestPersistentEventSeq;
		vi.spyOn(runtimeUtils, 'latestPersistentEventSeq').mockImplementation((events) => {
			observedEventSeqs.push(events.map((event) => event.seq));
			return latestPersistentEventSeq(events);
		});
		holdEventSnapshots = true;

		const refresh = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === 'Refresh log');
		await act(async () => refresh?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
		expect(pendingEvents).toHaveLength(1);
		expect(pendingMessages).toHaveLength(2);

		const socket = MonitorSocket.instances[0]!;
		await act(async () => socket.emit({
			type: 'event',
			event: runtimeEvent(9, 'run-live-event', 'provider_request'),
		}));
		expect(observedEventSeqs.at(-1)).toEqual([9]);

		// This snapshot was read before seq 9 arrived. Its generation was
		// invalidated by the socket event, so completing the whole refresh cannot
		// replace the newer component state.
		await answerEvents(0, []);
		await answerMessages(1, []);
		expect(observedEventSeqs.at(-1)).toEqual([9]);

		await waitForPendingEvents(2);
		expect(pendingEvents).toHaveLength(2);
		expect(pendingMessages).toHaveLength(3);
		await answerEvents(1, [runtimeEvent(10, 'run-authoritative-event', 'provider_request')]);
		await answerMessages(2, []);
		expect(observedEventSeqs.at(-1)).toEqual([10]);

		// The debounce is trailing and bounded: one persistent event schedules one
		// replacement, with no self-perpetuating request after it commits.
		await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
		expect(pendingEvents).toHaveLength(2);
	});

	it('keeps the newest reconnect snapshot, preserves live deltas, and ignores an invalidated stale response', async () => {
		expect(pendingMessages).toHaveLength(1);
		const socket = MonitorSocket.instances[0]!;
		await act(async () => socket.open());
		expect(pendingMessages).toHaveLength(2);

		// The reconnect replacement arrives first. The older initial request must
		// not later union its retired row back into the active generation.
		await answerMessages(1, [loopMessage(20, 'new authoritative generation')]);
		await answerMessages(0, [loopMessage(10, 'retired old generation')]);
		expect(container.textContent).toContain('new authoritative generation');
		expect(container.textContent).not.toContain('retired old generation');

		// Additive deltas do not invalidate the in-flight authoritative request.
		const refresh = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === 'Refresh log');
		await act(async () => refresh?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
		expect(pendingMessages).toHaveLength(3);
		await act(async () => {
			for (let index = 0; index < 25; index += 1) {
				socket.emit({
					type: 'stream_delta',
					event: {
						seq: 30 + index / 1000,
						runId: 'run-live',
						type: 'provider_delta',
						payload: { requestId: 'live-request', kind: 'content', text: '.', streamSeq: 7 },
						tokenEstimate: 0,
						createdAt: '2026-08-23T00:00:01.000Z',
					},
				});
			}
		});
		await answerMessages(2, [loopMessage(20, 'new authoritative generation')]);
		expect(container.textContent).toContain('running');
		expect(container.textContent).toContain('.........................');

		// A removing mutation invalidates a response already in flight, so that
		// response cannot resurrect the deleted row when it eventually arrives.
		await act(async () => refresh?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
		expect(pendingMessages).toHaveLength(4);
		await act(async () => socket.emit({ type: 'loop_message_deleted', seq: 20 }));
		expect(container.textContent).not.toContain('new authoritative generation');
		await answerMessages(3, [loopMessage(20, 'new authoritative generation')]);
		expect(container.textContent).not.toContain('new authoritative generation');
	});

	it('replaces events on reconnect so a missed deletion cannot survive in the replay cursor', async () => {
		const socket = MonitorSocket.instances[0]!;
		await act(async () => socket.emit({
			type: 'event',
			event: {
				seq: 9,
				runId: 'run-stale-event',
				type: 'compaction',
				payload: { status: 'complete', summary: 'stale event' },
				tokenEstimate: 0,
				createdAt: '2026-08-23T00:00:00.000Z',
			},
		}));
		await act(async () => socket.open());
		await answerMessages(1, [loopMessage(20, 'authoritative messages')]);
		await answerMessages(0, [loopMessage(10, 'obsolete messages')]);

		await act(async () => socket.close());
		await act(async () => new Promise((resolve) => setTimeout(resolve, 1_100)));

		expect(MonitorSocket.instances).toHaveLength(2);
		// If refresh had unioned the empty authoritative event snapshot with the
		// WebSocket row, reconnect would still request afterEvent=9 here.
		expect(MonitorSocket.instances[1]?.url).not.toContain('afterEvent=9');
	});

	it('re-resolves a nested generation across reconnect/reset and bounds mismatch fallback', async () => {
		await answerMessages(0, [loopMessage(1, 'active page')], page(1, { 40: 2 }, [
			{ page: 1, messageCount: 1 },
			{ page: 2, messageCount: 1, sourceCompactionSeq: 40 },
		]));
		const pageTwo = container.querySelector<HTMLAnchorElement>('a[title^="Open loop page 2"]');
		await act(async () => pageTwo?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
		expect(pendingMessages[1]?.path).toContain('page=2');
		await answerMessages(1, [loopMessage(40, 'nested generation forty')], page(2, { 40: 2 }, [
			{ page: 1, messageCount: 1 },
			{ page: 2, messageCount: 1, sourceCompactionSeq: 40 },
		]));
		expect(container.textContent).toContain('nested generation forty');

		const socket = MonitorSocket.instances[0]!;
		await act(async () => socket.open());
		expect(pendingMessages[2]?.path).not.toContain('page=');
		await answerMessages(2, [loopMessage(2, 'renumbered active page')], page(1, { 40: 3 }, [
			{ page: 1, messageCount: 1 },
			{ page: 2, messageCount: 1, sourceCompactionSeq: 70 },
			{ page: 3, messageCount: 1, sourceCompactionSeq: 40 },
		]));
		expect(pendingMessages[3]?.path).toContain('page=3');
		await answerMessages(3, [loopMessage(41, 'same nested generation after reconnect')], page(3, { 40: 3 }, [
			{ page: 1, messageCount: 1 },
			{ page: 2, messageCount: 1, sourceCompactionSeq: 70 },
			{ page: 3, messageCount: 1, sourceCompactionSeq: 40 },
		]));
		expect(container.textContent).toContain('same nested generation after reconnect');

		await act(async () => socket.emit({ type: 'loop_messages_reset' }));
		await waitForPendingMessages(5);
		expect(pendingMessages[4]?.path).not.toContain('page=');
		await answerMessages(4, [loopMessage(3, 'reset active page')], page(1, { 40: 2 }, [
			{ page: 1, messageCount: 1 },
			{ page: 2, messageCount: 1, sourceCompactionSeq: 40 },
		]));
		expect(pendingMessages[5]?.path).toContain('page=2');
		await answerMessages(5, [loopMessage(42, 'same nested generation after reset')], page(2, { 40: 2 }, [
			{ page: 1, messageCount: 1 },
			{ page: 2, messageCount: 1, sourceCompactionSeq: 40 },
		]));
		expect(container.textContent).toContain('same nested generation after reset');

		await act(async () => socket.emit({ type: 'loop_messages_reset' }));
		await waitForPendingMessages(7);
		await answerMessages(6, [loopMessage(4, 'fallback active one')], page(1, { 40: 2 }, [
			{ page: 1, messageCount: 1 },
			{ page: 2, messageCount: 1, sourceCompactionSeq: 40 },
		]));
		await answerMessages(7, [loopMessage(99, 'wrong nested generation one')], page(2, { 40: 2 }, [
			{ page: 1, messageCount: 1 },
			{ page: 2, messageCount: 1, sourceCompactionSeq: 99 },
		]));
		await answerMessages(8, [loopMessage(5, 'fallback active two')], page(1, { 40: 2 }, [
			{ page: 1, messageCount: 1 },
			{ page: 2, messageCount: 1, sourceCompactionSeq: 40 },
		]));
		await answerMessages(9, [loopMessage(100, 'wrong nested generation two')], page(2, { 40: 2 }, [
			{ page: 1, messageCount: 1 },
			{ page: 2, messageCount: 1, sourceCompactionSeq: 100 },
		]));
		expect(pendingMessages[10]?.path).not.toContain('page=');
		await answerMessages(10, [loopMessage(6, 'bounded page-one fallback')]);
		expect(container.textContent).toContain('bounded page-one fallback');
		expect(container.textContent).not.toContain('wrong nested generation two');
		expect(pendingMessages).toHaveLength(11);
	});
});

function liveEntry(id: string, content: string, deltaRevision = 0, attemptId?: number): Extract<AgentLogEntry, { kind: 'live' }> {
	return { kind: 'live', requestId: id, runId: `run-${id}`, position: 1, attempts: { count: 1, failures: [] }, partialResponse: JSON.stringify({ content, reasoning: '' }), response: null, deltaRevision, attemptId };
}

function streamDelta(socket: MonitorSocket, id: string, text: string, deltaRevision: number, attemptId?: number): void {
	socket.emit({ type: 'stream_delta', event: { seq: 1 + deltaRevision / 1000, runId: `run-${id}`, type: 'provider_delta', payload: { requestId: id, kind: 'content', text, deltaRevision, attemptId, streamSeq: 1 }, tokenEstimate: 0, createdAt: '2026-08-23T00:00:01.000Z' } });
}

async function refreshLog(): Promise<void> {
	const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.trim() === 'Refresh log');
	await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

it('removes stale live entries and keeps only stream updates after the snapshot starts', async () => {
	await act(async () => pendingMessages[0]?.resolve({ messages: [], entries: [liveEntry('old', 'Stale snapshot response')], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	const socket = MonitorSocket.instances[0]!;
	await act(async () => socket.open());
	await answerMessages(1, []);
	expect(container.textContent).not.toContain('Stale snapshot response');
	await act(async () => streamDelta(socket, 'old', 'Stale stream response', 1));
	await refreshLog();
	await act(async () => streamDelta(socket, 'new', 'Fresh stream response', 1));
	await answerMessages(2, [loopMessage(10, 'New page summary')], page(1, { 10: 2 }, [{ page: 1, messageCount: 1 }, { page: 2, sourceCompactionSeq: 10, messageCount: 1 }]));
	expect(container.textContent).not.toContain('Stale stream response');
	expect(container.textContent).toContain('Fresh stream response');
});

it('merges missed snapshot text and skips deltas that the snapshot already contains', async () => {
	await act(async () => pendingMessages[0]?.resolve({ messages: [], entries: [liveEntry('same', 'A', 1)], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	const socket = MonitorSocket.instances[0]!;
	await refreshLog();
	await act(async () => streamDelta(socket, 'same', 'C', 3));
	await act(async () => pendingMessages[1]?.resolve({ messages: [], entries: [liveEntry('same', 'AB', 2)], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	expect(container.textContent).toContain('ABC');
	await refreshLog();
	await act(async () => streamDelta(socket, 'same', 'D', 4));
	await act(async () => pendingMessages[2]?.resolve({ messages: [], entries: [liveEntry('same', 'ABCD', 4)], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	expect(container.textContent).toContain('ABCD');
	expect(container.textContent).not.toContain('ABCDD');
});

it('ignores delayed deltas at or below the revision in a snapshot', async () => {
	await act(async () => pendingMessages[0]?.resolve({ messages: [], entries: [liveEntry('delayed', 'AB', 2, 2)], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	const socket = MonitorSocket.instances[0]!;
	await act(async () => streamDelta(socket, 'delayed', 'B', 2, 2));
	await act(async () => streamDelta(socket, 'delayed', 'A', 1, 2));
	await act(async () => streamDelta(socket, 'delayed', 'Old attempt', 9, 1));
	expect(container.textContent).toContain('AB');
	expect(container.textContent).not.toContain('ABB');
	expect(container.textContent).not.toContain('ABA');
	expect(container.textContent).not.toContain('Old attempt');
	await act(async () => streamDelta(socket, 'delayed', 'C', 3, 2));
	expect(container.textContent).toContain('ABC');
	expect(container.textContent).not.toContain('ABCC');
});

it('keeps a completed response when a delayed delta from the same attempt arrives', async () => {
	const entry: AgentLogEntry = { ...liveEntry('completed', 'AB', 2, 2), response: '{"content":"Completed response"}' };
	await act(async () => pendingMessages[0]?.resolve({ messages: [], entries: [entry], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	const socket = MonitorSocket.instances[0]!;
	await act(async () => streamDelta(socket, 'completed', 'B', 2, 2));
	await act(async () => streamDelta(socket, 'completed', 'C', 3, 2));
	await act(async () => streamDelta(socket, 'completed', 'Old attempt', 9, 1));
	expect(container.textContent).toContain('Completed response');
	expect(container.textContent).not.toContain('ABC');
	expect(container.textContent).not.toContain('Old attempt');
	await act(async () => streamDelta(socket, 'completed', 'New attempt', 1, 3));
	expect(container.textContent).toContain('New attempt');
	expect(container.textContent).not.toContain('Completed response');
});

it('ignores a delayed delta after the response has a history row', async () => {
	const message = loopMessage(3, 'Committed response');
	const entry: AgentLogEntry = { kind: 'message', position: 1, message, author: { kind: 'model' }, requestId: 'stored', sessionId: null, attempts: { count: 1, failures: [] } };
	await act(async () => pendingMessages[0]?.resolve({ messages: [message], entries: [entry], page: page(1, {}, [{ page: 1, messageCount: 1 }]) }));
	await act(async () => streamDelta(MonitorSocket.instances[0]!, 'stored', 'Delayed text', 1, 2));
	expect(container.textContent).toContain('Committed response');
	expect(container.textContent).not.toContain('Live request');
	expect(container.textContent).not.toContain('Delayed text');
});

it('keeps rejected deltas out of the refresh buffer', async () => {
	await act(async () => pendingMessages[0]?.resolve({ messages: [], entries: [liveEntry('archived', 'AB', 2, 2)], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	await refreshLog();
	await act(async () => streamDelta(MonitorSocket.instances[0]!, 'archived', 'B', 2, 2));
	await answerMessages(1, [loopMessage(10, 'New page summary')]);
	expect(container.textContent).toContain('New page summary');
	expect(container.textContent).not.toContain('Live request');
});

it('keeps the current attempt when a snapshot contains the previous attempt', async () => {
	await act(async () => pendingMessages[0]?.resolve({ messages: [], entries: [liveEntry('retry', 'Failed attempt', 8, 1)], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	const socket = MonitorSocket.instances[0]!;
	await refreshLog();
	await act(async () => streamDelta(socket, 'retry', 'New attempt', 1, 2));
	await act(async () => pendingMessages[1]?.resolve({ messages: [], entries: [liveEntry('retry', 'Failed attempt', 8, 1)], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	expect(container.textContent).toContain('New attempt');
	expect(container.textContent).not.toContain('Failed attempt');
});

it('applies a delta once when it arrives just after the snapshot resolves', async () => {
	await act(async () => pendingMessages[0]?.resolve({ messages: [], entries: [liveEntry('ordered', 'A', 1)], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	const socket = MonitorSocket.instances[0]!;
	await refreshLog();
	await act(async () => {
		pendingMessages[1]?.resolve({ messages: [], entries: [liveEntry('ordered', 'AB', 2)], page: page(1, {}, [{ page: 1, messageCount: 0 }]) });
		await Promise.resolve();
		await Promise.resolve();
		streamDelta(socket, 'ordered', 'C', 3);
	});
	expect(container.textContent).toContain('ABC');
	expect(container.textContent).not.toContain('ABCC');
});

it('removes ended runs even when their last delta arrives after snapshot start', async () => {
	await act(async () => pendingMessages[0]?.resolve({ messages: [], entries: [liveEntry('ended', 'Old live response', 1)], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	expect(container.querySelector('.agent-log-card.is-live')?.textContent).toContain('Old live response');
	holdEventSnapshots = true;
	const socket = MonitorSocket.instances[0]!;
	await act(async () => socket.open());
	await act(async () => streamDelta(socket, 'ended', 'Late text', 2));
	await answerEvents(0, [runtimeEvent(10, 'run-ended', 'tick_completed')]);
	await act(async () => pendingMessages[1]?.resolve({ messages: [], entries: [liveEntry('ended', 'Old live response', 1)], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	expect(container.querySelector('.agent-log-card.is-live')).toBeNull();
	await act(async () => streamDelta(socket, 'ended', 'Later stale text', 3));
	expect(container.querySelector('.agent-log-card.is-live')).toBeNull();
});

it('renders an unknown entry as a plain notice', async () => {
	await act(async () => pendingMessages[0]?.resolve({ messages: [], entries: [{ kind: 'future_entry' } as unknown as AgentLogEntry], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	expect(container.textContent).toContain('Unknown log entry.');
});

it('keeps content from an unknown author visible with its source chip', async () => {
	const rows = [loopMessage(1, 'Before the unknown author'), loopMessage(2, 'Hidden unknown content'), loopMessage(3, 'After the unknown author')];
	const entries: AgentLogEntry[] = rows.map((message, index) => ({ kind: 'message', position: index + 1, message, author: { kind: index === 1 ? 'unknown' : 'model' }, requestId: null, sessionId: null, attempts: null }));
	await act(async () => pendingMessages[0]?.resolve({ messages: rows, entries, page: page(1, {}, [{ page: 1, messageCount: 3 }]) }));
	expect(container.textContent).toContain('Before the unknown author');
	expect(container.textContent).toContain('Unknown source');
	expect(container.textContent).toContain('After the unknown author');
	expect(container.textContent).toContain('Hidden unknown content');
});

it('shows the full response while a live entry waits for its first tool', async () => {
	const entry: AgentLogEntry = { kind: 'live', position: 2, requestId: 'waiting-request', runId: 'run', attempts: { count: 1, failures: [] }, partialResponse: null, response: '{"content":"The full response before the tool result"}' };
	await act(async () => pendingMessages[0]?.resolve({ messages: [], entries: [entry], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	expect(container.textContent).toContain('The full response before the tool result');
});

it('names the failed batch count for a partly successful compaction', async () => {
	const entry: AgentLogEntry = { kind: 'notice', position: 2, notice: { kind: 'compaction_started', sessionId: 'partial-session', outcome: { kind: 'partial', summarySeqs: [3], failedBatchCount: 1, error: { kind: 'timeout' } } } };
	await act(async () => pendingMessages[0]?.resolve({ messages: [], entries: [entry], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	expect(container.textContent).toContain('Compaction partly succeeded · 1 batch failed');
});

async function answerMessages(index: number, messages: BotLoopMessage[], responsePage = page(1, {}, [
	{ page: 1, messageCount: messages.length },
])): Promise<void> {
	await act(async () => pendingMessages[index]?.resolve({ messages, entries: messages.map(message => ({ kind: 'message' as const, position: message.position ?? message.seq, message, author: { kind: 'model' as const }, requestId: null, sessionId: null, attempts: null })), page: responsePage }));
}

async function answerEvents(index: number, events: BotRuntimeEvent[]): Promise<void> {
	await act(async () => pendingEvents[index]?.resolve(events));
}

function page(
	currentPage: number,
	compactionPageBySeq: Record<number, number>,
	pages: BotLoopMessagePage['pages'],
): BotLoopMessagePage {
	return { currentPage, pageCount: pages.length, pages, compactionPageBySeq };
}

async function waitForPendingMessages(count: number): Promise<void> {
	await act(async () => {
		while (pendingMessages.length < count) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});
}

async function waitForPendingEvents(count: number): Promise<void> {
	await act(async () => {
		while (pendingEvents.length < count) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});
}

function runtimeEvent(seq: number, runId: string, type: BotRuntimeEvent['type']): BotRuntimeEvent {
	return {
		seq,
		runId,
		type,
		payload: {},
		tokenEstimate: 0,
		createdAt: '2026-08-24T00:00:00.000Z',
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

it('keeps watched content when the owner starts compaction', async () => {
	const original = loopMessage(41, 'Watched before manual compaction');
	await answerMessages(0, [original]);
	runtimeStatus = 'idle';
	await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh log')!.click());
	await answerMessages(1, [original]);
	const compact = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Compact chat')!;
	await act(async () => compact.click());
	const confirm = [...document.querySelectorAll<HTMLButtonElement>('.modal button')].find(button => button.textContent === 'Compact chat')!;
	await act(async () => confirm.click());
	await act(async () => pendingCompactions[0]!(json({ ok: true, data: { compacted: { messageCount: 1, fromSeq: 41, toSeq: 41 } } })));
	const pages = [{ page: 1, isNewest: true, messageCount: 1, fromSeq: 80, toSeq: 80, olderPage: 2 }, { page: 2, isNewest: false, messageCount: 1, fromSeq: 41, toSeq: 41, sourceCompactionSeq: 80, newerPage: 1 }];
	await answerMessages(2, [loopMessage(80, 'New summary')], page(1, { 80: 2 }, pages));
	await act(async () => pendingLogs[0]!.resolve(json({ ok: true, data: { message: { ...original, compactedBy: 80 }, logs: [] } })));
	await answerMessages(3, [{ ...original, compactedBy: 80 }], page(2, { 80: 2 }, pages));
	expect(container.querySelector('.agent-log-archive')?.textContent).toContain('Watched before manual compaction');
	expect(container.textContent).toContain('Remove from archive');
	expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Compact chat')?.disabled).toBe(true);
});

it('keeps live request details current through completion', async () => {
	await act(async () => pendingMessages[0]!.resolve({ messages: [], entries: [liveEntry('streaming-modal', 'Text on the card')], page: page(1, {}, [{ page: 1, messageCount: 0 }]) }));
	await act(async () => container.querySelector<HTMLButtonElement>('.is-live .agent-log-info')!.click());
	const pending: typeof requestFixture = { ...requestFixture, state: 'pending', attempts: [{ ...requestFixture.attempts[0]!, usage: null, attribution: null, outcome: null, partialResponse: null }] };
	vi.useFakeTimers();
	try {
		await act(async () => pendingRequests[0]!.resolve(json({ ok: true, data: { request: pending } })));
		expect(container.querySelector('.modal')?.textContent).toContain('No response yet.');
		await act(async () => vi.advanceTimersByTimeAsync(500));
		await act(async () => pendingRequests[1]!.resolve(json({ ok: true, data: { request: { ...pending, attempts: [{ ...pending.attempts[0], partialResponse: JSON.stringify({ content: 'Text in the modal', reasoning: 'A partial thought' }) }] } } })));
		expect(container.querySelector('.modal')?.textContent).toContain('Partial response');
		expect(container.querySelector('.modal')?.textContent).toContain('Text in the modal');
		expect(container.querySelector('.is-live')?.textContent).toContain('Text on the card');
		await act(async () => vi.advanceTimersByTimeAsync(500));
		await act(async () => pendingRequests[2]!.resolve(json({ ok: true, data: { request: { ...pending, attempts: [{ ...pending.attempts[0], partialResponse: JSON.stringify({ content: 'Longer text in the modal' }) }] } } })));
		expect(container.querySelector('.modal')?.textContent).toContain('Longer text in the modal');
		await act(async () => vi.advanceTimersByTimeAsync(500));
		await act(async () => pendingRequests[3]!.resolve(json({ ok: true, data: { request: { ...pending, state: 'succeeded', attempts: [{ ...pending.attempts[0], outcome: { kind: 'success', response: JSON.stringify({ content: 'Completed response in the modal' }) } }] } } })));
		expect(container.querySelector('.modal')?.textContent).toContain('Completed response in the modal');
		expect(container.querySelector('.modal')?.textContent).not.toContain('Partial response');
		expect(container.querySelector('.modal')?.textContent).not.toContain('Longer text in the modal');
		await act(async () => vi.advanceTimersByTimeAsync(1000));
		expect(pendingRequests).toHaveLength(4);
	} finally { vi.useRealTimers(); }
});

it.each([2, 3])('keeps the selected archive when a monitor refresh moves it to page %s', async archivePage => {
	const pages = [
		{ page: 1, isNewest: true, messageCount: 1, fromSeq: 40, toSeq: 40, olderPage: 2 },
		{ page: 2, isNewest: false, messageCount: 1, fromSeq: 12, toSeq: 12, sourceCompactionSeq: 40, newerPage: 1 },
	];
	const active = loopMessage(40, 'Current context');
	await answerMessages(0, [active], page(1, { 40: 2 }, pages));
	const pageTwo = container.querySelector<HTMLAnchorElement>('a[title^="Open loop page 2"]')!;
	await act(async () => pageTwo.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
	expect(pendingMessages[1]?.path).toContain('page=2');
	await act(async () => MonitorSocket.instances[0]!.emit({ type: 'event', event: runtimeEvent(99, 'monitor-run', 'tick_completed') }));
	await waitForPendingMessages(3);
	const refreshedPages = archivePage === 2 ? pages : [
		{ page: 1, isNewest: true, messageCount: 1, fromSeq: 80, toSeq: 80, olderPage: 2 },
		{ page: 2, isNewest: false, messageCount: 1, fromSeq: 40, toSeq: 40, sourceCompactionSeq: 80, newerPage: 1, olderPage: 3 },
		{ page: 3, isNewest: false, messageCount: 1, fromSeq: 12, toSeq: 12, sourceCompactionSeq: 40, newerPage: 2 },
	];
	const map: Record<number, number> = archivePage === 2 ? { 40: 2 } : { 80: 2, 40: 3 };
	await answerMessages(2, [archivePage === 2 ? active : loopMessage(80, 'New context')], page(1, map, refreshedPages));
	expect(pendingMessages[3]?.path).toContain(`page=${archivePage}`);
	await answerMessages(3, [{ ...loopMessage(12, 'Selected archive'), compactedBy: 40 }], page(archivePage, map, refreshedPages));
	await answerMessages(1, [{ ...loopMessage(12, 'Stale archive response'), compactedBy: 40 }], page(2, { 40: 2 }, pages));
	expect(container.querySelector('.agent-log-archive')?.textContent).toContain('Selected archive');
	expect(container.textContent).not.toContain('Current context');
	expect(container.textContent).not.toContain('Stale archive response');
	expect(container.querySelector('[aria-current="page"]')?.textContent).toBe(String(archivePage));
	expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Compact chat')?.disabled).toBe(true);
});

it.each([false, true])('keeps the watched generation after compaction with pinned=%s', async pinned => {
	const bottom = vi.spyOn(runtimeUtils, 'scrollLogToBottom');
	const original = loopMessage(41, 'Keep the watched message');
	await answerMessages(0, [original], page(1, {}, [{ page: 1, isNewest: true, messageCount: 1, fromSeq: 41, toSeq: 41 }]));
	await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())));
	const log = container.querySelector<HTMLDivElement>('.event-log')!;
	Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 400 }, scrollTop: { configurable: true, writable: true, value: pinned ? 600 : 100 } });
	act(() => log.dispatchEvent(new Event('scroll', { bubbles: true })));
	const callsBefore = bottom.mock.calls.length;
	await act(async () => MonitorSocket.instances.at(-1)!.emit({ type: 'loop_messages_reset' }));
	await act(async () => new Promise(resolve => window.setTimeout(resolve, 120)));
	const pages = [{ page: 1, messageCount: 1, fromSeq: 80, toSeq: 80, olderPage: 2, isNewest: true }, { page: 2, messageCount: 1, fromSeq: 41, toSeq: 41, sourceCompactionSeq: 80, newerPage: 1, isNewest: false }];
	await answerMessages(1, [loopMessage(80, 'New summary')], page(1, { 80: 2 }, pages));
	expect(pendingLogs[0]?.path).toContain('/messages/41/logs');
	await act(async () => pendingLogs[0]!.resolve(json({ ok: true, data: { message: { ...original, compactedBy: 80 }, logs: [] } })));
	expect(pendingMessages[2]?.path).toContain('page=2');
	const archivedPage = { ...page(2, { 80: 2 }, pages), newerPage: 1 };
	await act(async () => pendingMessages[2]!.resolve({ messages: [{ ...original, compactedBy: 80 }], entries: [{ kind: 'message', position: 41, message: { ...original, compactedBy: 80 }, author: { kind: 'model' }, requestId: null, sessionId: null, attempts: null }, { kind: 'notice', position: 42, notice: { kind: 'compaction_started', sessionId: 'watch-session', outcome: { kind: 'succeeded', summarySeq: 80 } } }], page: archivedPage }));
	await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())));
	expect(container.querySelector('.agent-log-archive')).not.toBeNull();
	expect(container.textContent).toContain('Keep the watched message');
	expect(container.textContent).not.toContain('New summary');
	expect(container.textContent).toContain('Remove from archive');
	expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('2');
	expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Compact chat')?.disabled).toBe(true);
	expect(container.textContent).toContain('Compaction began here');
	if (pinned) expect(bottom.mock.calls.length).toBeGreaterThan(callsBefore);
	else { expect(bottom.mock.calls.length).toBe(callsBefore); expect(log.scrollTop).toBe(100); }
});


it('keeps watched content after compaction while the monitor is disconnected', async () => {
	const original = loopMessage(41, 'Watched while disconnected');
	await answerMessages(0, [original]);
	const socket = MonitorSocket.instances[0]!;
	await act(async () => socket.open());
	await answerMessages(1, [original]);
	vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
	vi.useFakeTimers();
	try {
		await act(async () => socket.close());
		await answerMessages(2, [original]);
		await act(async () => vi.advanceTimersByTimeAsync(5_000));
		expect(pendingMessages).toHaveLength(4);
		const pages = [{ page: 1, isNewest: true, messageCount: 1 }, { page: 2, isNewest: false, sourceCompactionSeq: 80, messageCount: 1 }];
		await answerMessages(3, [loopMessage(80, 'New summary')], page(1, { 80: 2 }, pages));
		expect(pendingLogs[0]?.path).toContain('/messages/41/logs');
		await act(async () => pendingLogs[0]!.resolve(json({ ok: true, data: { message: { ...original, compactedBy: 80 }, logs: [] } })));
		expect(pendingMessages[4]?.path).toContain('page=2');
		await answerMessages(4, [{ ...original, compactedBy: 80 }], page(2, { 80: 2 }, pages));
		expect(container.querySelector('.agent-log-archive')?.textContent).toContain('Watched while disconnected');
		expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Compact chat')?.disabled).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

it('refreshes the page map when the watched row moves again during lookup', async () => {
	const original = loopMessage(41, 'Watched row');
	await answerMessages(0, [original]);
	await act(async () => MonitorSocket.instances.at(-1)!.emit({ type: 'loop_messages_reset' }));
	await waitForPendingMessages(2);
	await answerMessages(1, [loopMessage(80, 'First summary')], page(1, { 80: 2 }, [
		{ page: 1, isNewest: true, messageCount: 1 },
		{ page: 2, isNewest: false, sourceCompactionSeq: 80, messageCount: 1 },
	]));
	await act(async () => pendingLogs[0]!.resolve(json({ ok: true, data: { message: { ...original, compactedBy: 90 }, logs: [] } })));
	expect(pendingMessages[2]?.path).not.toContain('page=');
	const pages = [{ page: 1, isNewest: true, messageCount: 1 }, { page: 2, isNewest: false, sourceCompactionSeq: 90, messageCount: 1 }];
	await answerMessages(2, [loopMessage(90, 'Latest summary')], page(1, { 90: 2 }, pages));
	await act(async () => pendingLogs[1]!.resolve(json({ ok: true, data: { message: { ...original, compactedBy: 90 }, logs: [] } })));
	expect(pendingMessages[3]?.path).toContain('page=2');
	await answerMessages(3, [{ ...original, compactedBy: 90 }], page(2, { 90: 2 }, pages));
	expect(container.querySelector('.agent-log-archive')?.textContent).toContain('Watched row');
});

it('ignores a watched row lookup after a newer snapshot', async () => {
	const original = loopMessage(41, 'Watched row');
	await answerMessages(0, [original]);
	await act(async () => MonitorSocket.instances.at(-1)!.emit({ type: 'loop_messages_reset' }));
	await waitForPendingMessages(2);
	await answerMessages(1, [loopMessage(80, 'New summary')], page(1, { 80: 2 }, [
		{ page: 1, isNewest: true, messageCount: 1 },
		{ page: 2, isNewest: false, sourceCompactionSeq: 80, messageCount: 1 },
	]));
	const refresh = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh log')!;
	await act(async () => refresh.click());
	await answerMessages(2, [original, loopMessage(81, 'Owner selected current context')]);
	await act(async () => pendingLogs[0]!.resolve(json({ ok: true, data: { message: { ...original, compactedBy: 80 }, logs: [] } })));
	expect(container.textContent).toContain('Owner selected current context');
	expect(pendingMessages).toHaveLength(3);
});

it('keeps the latest selected request when detail responses arrive out of order', async () => {
	const first = loopMessage(1, 'First response'); const second = loopMessage(2, 'Second response');
	await act(async () => pendingMessages[0]!.resolve({ messages: [first, second], entries: [first, second].map((message, index) => ({ kind: 'message', position: index + 1, message, author: { kind: 'model' }, requestId: `request-${index}`, sessionId: null, attempts: null })), page: page(1, {}, [{ page: 1, messageCount: 2 }]) }));
	const buttons = container.querySelectorAll<HTMLButtonElement>('.agent-log-info');
	await act(async () => { buttons[0]!.click(); buttons[1]!.click(); });
	await act(async () => pendingRequests[1]!.resolve(json({ ok: true, data: { request: { ...requestFixture, id: 'request-1' } } })));
	await act(async () => pendingRequests[0]!.resolve(json({ ok: true, data: { request: { ...requestFixture, id: 'request-0', attempts: [] } } })));
	expect(container.querySelector('.modal')?.textContent).toContain('I must include the thread reference.');
	expect(container.querySelector('.modal')?.textContent).not.toContain('The exact request is not retained.');
});
