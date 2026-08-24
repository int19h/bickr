import type { BotLoopMessage, BotSummary } from '@bickr/shared/model';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotRuntimePanel } from './runtime';

type PendingMessages = (messages: BotLoopMessage[]) => void;

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

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	pendingMessages = [];
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
			return Promise.resolve(json({ ok: true, data: { events: [] } }));
		}
		if (path.endsWith('/runtime/token-usage')) {
			return Promise.resolve(json({ ok: false, error: 'unavailable', message: 'usage unavailable' }, 503));
		}
		if (path.includes('/runtime/messages')) {
			return new Promise<Response>((resolve) => {
				pendingMessages.push((messages) => resolve(json({
					ok: true,
					data: {
						messages,
						page: {
							currentPage: 1,
							pageCount: 1,
							pages: [{ page: 1, messageCount: messages.length }],
							compactionPageBySeq: {},
						},
					},
				})));
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
});

async function answerMessages(index: number, messages: BotLoopMessage[]): Promise<void> {
	await act(async () => pendingMessages[index]?.(messages));
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
