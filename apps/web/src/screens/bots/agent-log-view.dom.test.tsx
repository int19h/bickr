import type { AgentLogAuthor, AgentLogEntry, AgentLogRequest } from '@bickr/shared/model';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLogView, type AgentLogViewProps } from './agent-log-view';
import { AgentLogRequestModal, AgentLogSessionModal, attemptCause, attemptRequestMetadata } from './agent-log-details';
import { LoopMessageLogsModal } from './loop-messages';
import { storedResponseMessage } from './agent-log-content';
import { entriesFixture, messageFixture, pageFixture, requestFixture, sessionFixture } from './agent-log.fixtures';

let container: HTMLDivElement;
let root: Root;
const actions = { onDelete: vi.fn(), onLogs: vi.fn(), onRequest: vi.fn(), onSession: vi.fn(), onPage: vi.fn() };
function render(entries: AgentLogEntry[], overrides: Partial<AgentLogViewProps> = {}) {
	act(() => root.render(<AgentLogView entries={entries} page={pageFixture()} participantName="Reader" {...actions} {...overrides} />));
}
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement('div');
	document.body.append(container);
	root = createRoot(container);
	vi.clearAllMocks();
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

const authors: Array<[AgentLogAuthor, string | null, boolean]> = [
	[{ kind: 'model' }, null, false],
	[{ kind: 'owner_injection' }, 'Owner injection', false],
	[{ kind: 'reminder' }, 'Bickr reminder', false],
	[{ kind: 'self_correction' }, 'Self-correction', false],
	[{ kind: 'recurring_prompt' }, 'Recurring prompt', false],
	[{ kind: 'spotlight_focus' }, 'Spotlight focus', false],
	[{ kind: 'synthetic_tool_call' }, 'Synthetic tool call', false],
	[{ kind: 'local_simulation' }, 'Local simulation', false],
	[{ kind: 'legacy_synthetic' }, 'Synthetic', false],
	[{ kind: 'unknown' }, 'Unknown source', false],
	[{ kind: 'bickr_report' }, null, true],
	[{ kind: 'compaction_summary' }, null, false],
	[{ kind: 'legacy_summary' }, null, false],
	[{ kind: 'tool_result', synthetic: true }, null, true],
	[{ kind: 'tool_result', synthetic: false }, null, true],
];
describe('Loop cards', () => {
	it.each(authors)('keeps the content and side for %j', (author, label, right) => {
		render([messageFixture(1, author, 'Visible participant content')]);
		const card = container.querySelector('.agent-log-card')!;
		expect(card.textContent).toContain('Visible participant content');
		expect(card.classList.contains('side-right')).toBe(right);
		expect(card.querySelector('.agent-log-source')?.getAttribute('aria-label') ?? null).toBe(label);
	});
	it('keeps a future author on its role side and marks its source', () => {
		const entry = messageFixture(1, { kind: 'future' } as unknown as AgentLogAuthor);
		entry.message.role = 'user';
		entry.message.message.role = 'user';
		render([entry]);
		expect(container.querySelector('.side-right.injected')?.textContent).toContain('Unknown source');
	});
	it('places reasoning, text, and paraphrased calls in one response card', () => {
		render(entriesFixture());
		const card = container.querySelectorAll('.agent-log-card')[2]!;
		expect(card.querySelector('.agent-log-reasoning')).not.toBeNull();
		expect(card.querySelector('.agent-log-body')?.textContent).toContain('new replies');
		expect(card.querySelector('.agent-log-call')?.textContent).toContain('Reading');
		expect(card.textContent).not.toContain('"threadRef"');
		expect(container.querySelector("#loop-result-1 a[href='#loop-call-1']")?.textContent).toBe('1');
		expect(container.querySelector('#loop-result-1')?.textContent).toContain('result of call 1');
		act(() => card.querySelector('.agent-log-call')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
		expect(container.querySelectorAll('.call-highlight')).toHaveLength(2);
	});
	it('uses provider positions and counts synthetic calls on each page', () => {
		const first = messageFixture(9, { kind: 'synthetic_tool_call' });
		first.position = 1;
		first.message.message.tool_calls = [{ id: 'synthetic', type: 'function', function: { name: 'log_off', arguments: '{}' } }];
		const second = entriesFixture()[2]!;
		render([second, first]);
		expect(container.querySelector('.agent-log-card')?.classList.contains('faded')).toBe(true);
		expect(container.querySelectorAll('.agent-log-call-number')[1]?.textContent).toBe('2');
		render([second]);
		expect(container.querySelector('.agent-log-call-number')?.textContent).toBe('1');
	});
	it('numbers repeated provider call IDs separately and links each result', () => {
		const entries = entriesFixture();
		const first = entries[2] as Extract<AgentLogEntry, { kind: 'message' }>;
		const firstResult = entries[3] as Extract<AgentLogEntry, { kind: 'message' }>;
		const next = structuredClone(first);
		next.position = 5;
		next.message.seq = 5;
		next.requestId = 'another-request';
		const nextResult = structuredClone(firstResult);
		nextResult.position = 6;
		nextResult.message.seq = 6;
		render([first, firstResult, next, nextResult]);
		expect(container.querySelectorAll('.agent-log-call')).toHaveLength(2);
		expect(container.querySelector('#loop-result-1 a')?.getAttribute('href')).toBe('#loop-call-1');
		expect(container.querySelector('#loop-result-2 a')?.getAttribute('href')).toBe('#loop-call-2');
	});
	it('keeps source text when the author is unknown', () => {
		render([messageFixture(1, { kind: 'unknown' }, 'Keep every word')]);
		expect(container.textContent).toContain('Keep every word');
	});
	it('opens request details and the retry list through separate controls', () => {
		render(entriesFixture());
		act(() => container.querySelector<HTMLButtonElement>('.agent-log-info')!.click());
		expect(actions.onRequest).toHaveBeenCalledWith('request-example');
		act(() => container.querySelector<HTMLButtonElement>('.agent-log-pill.error')!.click());
		expect(actions.onRequest).toHaveBeenLastCalledWith('request-example', true);
	});
	it('follows the info rule for reports, injected cards, summaries, and tool results', () => {
		for (const author of [{ kind: 'bickr_report' }, { kind: 'owner_injection' }] as AgentLogAuthor[]) {
			const entry = messageFixture(1, author);
			render([entry]);
			expect(container.querySelector('.agent-log-info')).toBeNull();
			entry.message.hasLogs = true;
			render([entry]);
			act(() => container.querySelector<HTMLButtonElement>('.agent-log-info')!.click());
			expect(actions.onLogs).toHaveBeenCalledWith(entry.message);
		}
		const summary = messageFixture(2, { kind: 'compaction_summary' });
		summary.sessionId = 'session-example';
		render([summary]);
		act(() => container.querySelector<HTMLButtonElement>('.agent-log-info')!.click());
		expect(actions.onSession).toHaveBeenCalledWith('session-example');
		const tool = messageFixture(3, { kind: 'tool_result', synthetic: false });
		render([tool]);
		act(() => container.querySelector<HTMLButtonElement>('.agent-log-info')!.click());
		expect(actions.onLogs).toHaveBeenLastCalledWith(tool.message);
	});
	it.each([false, true])('uses the delete label and action for archive=%s', (archive) => {
		const entry = messageFixture(1);
		render([entry], { page: pageFixture(archive) });
		const button = container.querySelector<HTMLButtonElement>('.agent-log-delete')!;
		expect(button.textContent).toContain(archive ? 'Remove from archive' : 'Remove from context');
		act(() => button.click());
		expect(actions.onDelete).toHaveBeenCalledWith(entry.message);
	});
	it('shows interrupted, invalid, and unknown statuses', () => {
		const entry = messageFixture(1);
		for (const status of ['interrupted', 'invalid', 'future'] as Array<typeof entry.message.status>) {
			entry.message.status = status;
			render([entry]);
			expect(container.querySelector('.agent-log-status')?.textContent).toContain(
				status === 'interrupted' ? 'Interrupted' : status === 'invalid' ? 'Invalid' : 'Unknown status',
			);
		}
	});
	it('renders a live response and replaces it with the completed card', () => {
		const live: AgentLogEntry = {
			kind: 'live',
			position: 1,
			requestId: 'request-example',
			runId: 'visit-example',
			attempts: { count: 1, failures: [] },
			response: null,
			partialResponse: JSON.stringify({ content: 'Partial text', reasoning: 'A thought' }),
		};
		render([live]);
		expect(container.textContent).toContain('Partial text');
		expect(container.querySelector('.agent-log-delete')).toBeNull();
		const node = container.querySelector('.agent-log-card');
		act(() => container.querySelector<HTMLButtonElement>('.agent-log-info')!.click());
		expect(actions.onRequest).toHaveBeenCalledWith('request-example');
		render([messageFixture(1)]);
		expect(container.querySelector('.agent-log-card')).toBe(node);
		expect(container.textContent).not.toContain('streaming');
	});
	it('expands reasoning that exceeds six lines', () => {
		vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(150);
		render(entriesFixture());
		const reasoning = container.querySelector('.agent-log-reasoning')!;
		const more = reasoning.querySelector<HTMLButtonElement>('button')!;
		expect(more.getAttribute('aria-expanded')).toBe('false');
		act(() => more.click());
		expect(reasoning.querySelector('.agent-log-reasoning-clamp')).toBeNull();
		expect(more.textContent).toBe('less');
	});
	it('combines streamed tool fragments before rendering a call', () => {
		const message = storedResponseMessage(
			JSON.stringify({
				content: '',
				toolCalls: [
					{ index: 0, id: 'one', function: { name: 'read_', arguments: '{' } },
					{ index: 0, function: { name: 'thread', arguments: '}' } },
				],
			}),
		);
		expect(message.tool_calls).toEqual([{ id: 'one', type: 'function', function: { name: 'read_thread', arguments: '{}' } }]);
	});
	it('renders every notice and the fallback without a card or info button', () => {
		render([
			{ kind: 'notice', position: 1, notice: { kind: 'runtime_error', message: 'A runtime error', messageSeq: 1 } },
			{ kind: 'notice', position: 2, notice: { kind: 'dropped_output', message: 'Invalid content', messageSeq: 2 } },
			{ kind: 'notice', position: 3, notice: { kind: 'request_failed', requestId: 'failed', attempts: { count: 5, failures: [] } } },
			{ kind: 'notice', position: 4, notice: { kind: 'future' } } as unknown as AgentLogEntry,
			{ kind: 'future', position: 5 } as unknown as AgentLogEntry,
		]);
		expect(container.querySelector('.agent-log-card, .agent-log-info')).toBeNull();
		for (const text of [
			'A runtime error',
			'Invalid content',
			'No response after 5 attempts',
			'Unknown runtime notice.',
			'Unknown log entry.',
		])
			expect(container.textContent).toContain(text);
		act(() => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('No response'))!.click());
		expect(actions.onRequest).toHaveBeenCalledWith('failed', true);
	});
	it.each(['pending', 'succeeded', 'failed', 'partial', 'future'])('renders the compaction outcome %s', (kind) => {
		const outcome = { ...sessionFixture.outcome, kind } as typeof sessionFixture.outcome;
		const entry: AgentLogEntry = {
			kind: 'notice',
			position: 9,
			notice: { kind: 'compaction_started', sessionId: sessionFixture.id, outcome },
		};
		render([entry], { page: pageFixture(true), sessions: new Map([[sessionFixture.id, sessionFixture]]) });
		expect(container.querySelector('.agent-log-compaction')?.textContent).toContain(
			kind === 'failed'
				? 'Compaction failed after 2 attempts'
				: kind === 'partial'
					? '1 batch failed'
					: kind === 'future'
						? 'Unknown compaction outcome'
						: 'Compaction began here',
		);
		act(() => container.querySelector<HTMLButtonElement>('.agent-log-compaction')!.click());
		expect(actions.onSession).toHaveBeenCalledWith(sessionFixture.id);
	});
});

describe('Loop detail views', () => {
	it('keeps R8 metadata behind the adapter until the runtime rebase', () => {
		expect(attemptRequestMetadata(requestFixture.attempts[0])).toBeNull();
	});
	it('shows the stored request, the selected response, and earlier attempt bodies', () => {
		act(() => root.render(<AgentLogRequestModal request={requestFixture} errors={false} onClose={() => {}} />));
		expect(container.textContent).toContain('I must include the thread reference.');
		expect(container.textContent).toContain('Earlier attempts');
		const system = [...container.querySelectorAll('details')].find((node) =>
			node.querySelector('summary')?.textContent?.includes('system prompt'),
		)!;
		expect(system.open).toBe(false);
		expect(container.textContent).toContain('Read the page before you respond.');
	});
	it('labels a partial response and missing request bodies', () => {
		const request: AgentLogRequest = {
			...requestFixture,
			state: 'pending',
			attempts: [{ id: 1, startedAt: requestFixture.createdAt, body: null, partialResponse: 'partial words', outcome: null }],
		};
		act(() => root.render(<AgentLogRequestModal request={request} errors={false} onClose={() => {}} />));
		expect(container.textContent).toContain('The exact request is not retained.');
		expect(container.textContent).toContain('Partial response');
		expect(container.textContent).toContain('partial words');
	});
	it.each(['succeeded', 'failed'] as const)('ends the error list with the request state %s', (state) => {
		act(() => root.render(<AgentLogRequestModal request={{ ...requestFixture, state }} errors onClose={() => {}} />));
		expect(container.textContent).toContain('Provider error · 503 · unavailable');
		expect(container.textContent).toContain(state === 'failed' ? 'Gave up after 3 attempts' : 'Attempt 3 succeeded');
		expect(container.querySelectorAll('.agent-log-attempt')).toHaveLength(3);
	});
	it('shows every compaction call, attempt, and the final validation error', () => {
		act(() => root.render(<AgentLogSessionModal session={sessionFixture} onClose={() => {}} />));
		expect(container.querySelectorAll('.agent-log-session-call')).toHaveLength(2);
		expect(container.textContent).toContain('summary_not_shorter');
		expect(container.textContent).toContain('1 batch failed');
	});
	it('traps keyboard focus, closes with Escape, and restores the trigger', () => {
		const trigger = document.createElement('button');
		document.body.append(trigger);
		trigger.focus();
		const close = vi.fn();
		act(() => root.render(<AgentLogRequestModal request={requestFixture} errors={false} onClose={close} />));
		const dialog = container.querySelector('[role="dialog"]')!;
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		const first = container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
		expect(document.activeElement).toBe(first);
		act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
		expect(document.activeElement?.tagName).toBe('SUMMARY');
		act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
		expect(close).toHaveBeenCalledOnce();
		act(() => root.render(null));
		expect(document.activeElement).toBe(trigger);
		trigger.remove();
	});
	it('shows exact tool result text and keeps older response logs available', () => {
		const row = messageFixture(4, { kind: 'tool_result', synthetic: false }).message;
		const text = '  exact text\nwith its spacing  ';
		act(() =>
			root.render(
				<LoopMessageLogsModal
					open
					onClose={() => {}}
					payload={{
						message: row,
						logs: [
							{ id: 1, messageSeq: 4, kind: 'tool_result', text, encoding: 'full', textLength: text.length, createdAt: row.createdAt },
						],
					}}
				/>,
			),
		);
		expect(container.querySelector('pre')?.textContent).toBe(text);
		const response = messageFixture(1).message;
		act(() =>
			root.render(
				<LoopMessageLogsModal
					open
					onClose={() => {}}
					payload={{
						message: response,
						logs: [
							{
								id: 2,
								messageSeq: 1,
								kind: 'provider_response',
								text: 'old response',
								encoding: 'full',
								textLength: 12,
								createdAt: response.createdAt,
							},
						],
					}}
				/>,
			),
		);
		expect(container.textContent).toContain('The exact request is not retained.');
		expect(container.textContent).toContain('old response');
	});
	it('names every outcome and the unknown fallback', () => {
		for (const [outcome, text] of [
			[null, 'In progress'],
			[{ kind: 'success', response: 'yes' }, 'Succeeded'],
			[{ kind: 'interrupted' }, 'Interrupted'],
			[{ kind: 'timeout' }, 'Timed out'],
			[{ kind: 'validation', issue: 'shape', message: 'invalid' }, 'Validation failed · shape'],
			[{ kind: 'future' }, 'Unknown outcome'],
		] as const)
			expect(attemptCause(outcome as Parameters<typeof attemptCause>[0])).toBe(text);
	});
});
