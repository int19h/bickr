import type { BotLoopMessage, BotLoopMessagePage, BotRuntimeEvent, BotSummary } from '@bickr/shared/model';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotRuntimePanel } from './runtime';
import * as runtimeUtils from './runtime-utils';

type PendingMessages = {
	path: string;
	resolve: (response: { messages: BotLoopMessage[]; page: BotLoopMessagePage }) => void;
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

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	pendingMessages = [];
	pendingEvents = [];
	holdEventSnapshots = false;
	MonitorSocket.instances = [];
	vi.stubGlobal('WebSocket', MonitorSocket);
	vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
		const path = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		if (path.includes('/effective-models?')) {
			return Promise.resolve(json({ ok: true, data: { effectiveModels: { models: [{ botId: bot.id, effectiveModel: 'test/model' }] } } }));
		}
		if (path.endsWith('/runtime/status')) {
			return Promise.resolve(json({ ok: true, data: { status: { botId: bot.id, enabled: true, status: 'running' } } }));
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
		if (path.includes('/runtime/messages')) {
			return new Promise<Response>((resolve) => {
				pendingMessages.push({ path, resolve: ({ messages, page }) => resolve(json({
					ok: true,
					data: { messages, page },
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
	vi.unstubAllGlobals();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
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
						payload: { kind: 'content', text: '.', streamSeq: 7 },
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

async function answerMessages(index: number, messages: BotLoopMessage[], responsePage = page(1, {}, [
	{ page: 1, messageCount: messages.length },
])): Promise<void> {
	await act(async () => pendingMessages[index]?.resolve({ messages, page: responsePage }));
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
