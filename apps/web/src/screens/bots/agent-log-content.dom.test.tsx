import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AgentLogReasoning, storedResponseMessage, storedPartialMessage } from './agent-log-content';
import { AgentLogCard, AgentLogBody, AgentLogExpandControl } from './agent-log-card';
import { AgentLogRequestModal } from './agent-log-details';
import { requestFixture } from './agent-log.fixtures';
import { LoopMarkdown } from '../../readable/loop-markdown';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement('div');
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it.each([
	[[{ type: 'reasoning.encrypted', data: 'hidden bytes' }], 'Reasoningencrypted by the provider'],
	[[{ type: 'reasoning.encrypted', data: 'hidden bytes' }, { type: 'reasoning.encrypted', data: 'hidden bytes' }], 'encrypted by the provider · 2 parts'],
	[[{ type: 'future', text: 'hidden bytes' }], 'recorded, not readable'],
	[[], 'recorded, not readable'],
])('renders opaque details without their bytes', (details, label) => {
	act(() => root.render(<AgentLogReasoning message={{ role: 'assistant', reasoning_details: details }} />));
	expect(container.textContent).toContain(label);
	expect(container.textContent).not.toContain('hidden bytes');
	expect(container.querySelector('.opaque-only')?.getAttribute('title')).toBe('The provider returned reasoning only as encrypted data. The exact payload is in the (i) modal.');
	expect(container.querySelector('button')).toBeNull();
	expect(container.querySelector('.opaque-only svg')).not.toBeNull();
});
it.each([
	[[{ type: 'reasoning.text', text: 'Visible thought' }], 'Reasoning', false],
	[[{ type: 'reasoning.summary', summary: 'Visible summary' }], 'Reasoning summary', false],
	[[{ type: 'reasoning.text', text: 'Visible thought' }, { type: 'reasoning.summary', summary: 'Visible summary' }], 'Reasoning', false],
	[[{ type: 'reasoning.text', text: 'Visible thought' }, { type: 'reasoning.encrypted', data: 'hidden bytes' }], 'Reasoning', true],
])('renders readable details and a separate opaque tail', (details, label, tail) => {
	act(() => root.render(<AgentLogReasoning message={{ role: 'assistant', reasoning_details: details }} />));
	expect(container.querySelector('.agent-log-reasoning-label')?.textContent?.trim()).toBe(label);
	expect(container.querySelector('.agent-log-reasoning-tail') !== null).toBe(tail);
	expect(container.textContent).not.toContain('hidden bytes');
});
it('clamps readable reasoning and preserves the opaque tail when expanded', () => {
	vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);
	act(() => root.render(<AgentLogReasoning message={{ role: 'assistant', reasoning: 'A long thought', reasoning_details: [{ type: 'reasoning.text', text: 'A long thought' }, { type: 'reasoning.encrypted', data: 'hidden bytes' }] }} />));
	const button = container.querySelector('button')!;
	expect(button.textContent).toBe('more');
	act(() => button.click());
	expect(button.getAttribute('aria-expanded')).toBe('true');
	expect(container.querySelector('.agent-log-reasoning-clamp')).toBeNull();
	expect(container.querySelector('.agent-log-reasoning-tail')?.textContent).toContain('1 more part is encrypted');
});
function Result({ text }: { text: string }) {
	return <AgentLogCard expandable className="tint-tool"><AgentLogBody><LoopMarkdown text={text} /></AgentLogBody><div className="agent-log-foot"><AgentLogExpandControl /></div></AgentLogCard>;
}
it('expands each long card independently and collapses it again', () => {
	vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(301);
	act(() => root.render(<><Result text="First result" /><Result text="Second result" /></>));
	const buttons = container.querySelectorAll<HTMLButtonElement>('.agent-log-expand');
	expect(buttons).toHaveLength(2);
	expect(buttons[0]!.textContent).toContain('Show all');
	act(() => buttons[0]!.click());
	expect(buttons[0]!.textContent).toContain('Collapse');
	expect(buttons[0]!.getAttribute('aria-expanded')).toBe('true');
	expect(buttons[1]!.getAttribute('aria-expanded')).toBe('false');
	act(() => buttons[0]!.click());
	expect(buttons[0]!.textContent).toContain('Show all');
});
it('does not add a control to a short card', () => {
	vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(299);
	act(() => root.render(<Result text="Short result" />));
	expect(container.querySelector('.agent-log-expand')).toBeNull();
});
it.each(['c/abcdefgh [timestamp: 1d0h0m]', 'c/abcdefgh\nTimestamp: 1d0h0m'])('keeps heading structure for %s', heading => {
	act(() => root.render(<LoopMarkdown text={'## Any localized title\n\nMetadata\n\n---\n\n### '+heading+'\n\nu/reader\n\n> A quote with https://example.org and f/lobby.\n\n| Link |\n| --- |\n| [Example](https://example.org) and t/abcdefgh |'} worldHandle="sample" />));
	expect(container.querySelector('hr + h3')).not.toBeNull();
	expect(container.querySelector('.ref-comment')).not.toBeNull();
	expect(container.querySelector('.ref-bot')).not.toBeNull();
	expect(container.querySelector('.ref-forum')).not.toBeNull();
	expect(container.querySelector('.ref-thread')).not.toBeNull();
	expect(container.querySelectorAll('a[href="https://example.org"]')).toHaveLength(2);
	expect(container.querySelector('blockquote .ref-forum')).not.toBeNull();
	expect(container.querySelector('table .ref-thread')).not.toBeNull();
});

it('opens clipped content when a link receives keyboard focus', () => {
	vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(301);
	act(() => root.render(<Result text="[A link](https://example.org)" />));
	const body = container.querySelector<HTMLElement>('.agent-log-body')!;
	const link = container.querySelector<HTMLAnchorElement>('a')!;
	vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ bottom: 300 } as DOMRect);
	vi.spyOn(link, 'getBoundingClientRect').mockReturnValue({ bottom: 500 } as DOMRect);
	act(() => link.focus());
	expect(container.querySelector('.agent-log-expand')?.getAttribute('aria-expanded')).toBe('true');
});

it('keeps the opaque payload in the information modal', () => {
	const details = [{ type: 'reasoning.encrypted', data: 'exact opaque payload' }];
	const response = JSON.stringify({ message: { role: 'assistant', reasoning_details: details } });
	const request = { ...requestFixture, attempts: [{ ...requestFixture.attempts[0]!, outcome: { kind: 'success' as const, response } }] };
	act(() => root.render(<>
		<AgentLogReasoning message={{ role: 'assistant', reasoning_details: details }} />
		<AgentLogRequestModal request={request} errors={false} onClose={() => undefined} />
	</>));
	expect(container.querySelector('.agent-log-reasoning')?.textContent).not.toContain('exact opaque payload');
	expect(container.querySelector('.modal')?.textContent).toContain('exact opaque payload');
});

it.each(['snapshot', 'completed'])('uses classified details once in a %s response with both fields', (shape) => {
	const response = { content: null, reasoning: 'Visible summary.opaque bytes', reasoning_content: 'Visible summary.opaque bytes', reasoning_details: [
		{ type: 'reasoning.summary', summary: 'Visible summary.' },
		{ type: 'future.type', text: 'opaque bytes' },
	] };
	const message = storedResponseMessage(JSON.stringify(shape === 'completed' ? { message: response } : response));
	act(() => root.render(<AgentLogReasoning message={message} />));
	expect(container.textContent?.match(/Visible summary\./g)).toHaveLength(1);
	expect(container.textContent).not.toContain('opaque bytes');
	expect(container.querySelector('.agent-log-reasoning-label')?.textContent?.trim()).toBe('Reasoning summary');
});
it('joins unindexed summary fragments through the snapshot and display adapters', () => {
	const message = storedResponseMessage(JSON.stringify({ reasoning: 'Looking at the result.', reasoning_details: [
		{ type: 'reasoning.summary', summary: 'Look' },
		{ type: 'reasoning.summary', summary: 'ing at the result.' },
	] }));
	act(() => root.render(<AgentLogReasoning message={message} />));
	expect(container.querySelectorAll('.markdown-body p')).toHaveLength(1);
	expect(container.querySelector('.markdown-body p')?.textContent).toBe('Looking at the result.');
});

it.each(['snapshot', 'completed'])('hides an unknown detail and its plain copy in a %s response', (shape) => {
	const response = { reasoning: 'opaque bytes', reasoning_details: [{ type: 'future.type', text: 'opaque bytes' }] };
	const message = storedResponseMessage(JSON.stringify(shape === 'completed' ? { message: response } : response));
	act(() => root.render(<AgentLogReasoning message={message} />));
	expect(container.textContent).toContain('recorded, not readable');
	expect(container.textContent).not.toContain('opaque bytes');
});


it('keeps an empty typed partial hidden before reasoning arrives', () => {
	const message = storedPartialMessage(JSON.stringify({ content: '', reasoning: '', reasoningParts: [], toolCalls: [] }));
	act(() => root.render(<AgentLogReasoning message={message} />));
	expect(container.querySelector('.agent-log-reasoning')).toBeNull();
});

it.each([undefined, 'future_format'])('keeps legacy classification for an unsupported stored marker %s', marker => {
	const message = storedResponseMessage(JSON.stringify({ message: {
		reasoning_format: marker,
		reasoning: 'UNSAFE_LEGACY_TEXT',
		reasoning_details: [{ type: 'reasoning.summary', summary: 'A safe legacy summary.' }, { type: 'future.type', text: 'UNSAFE_LEGACY_TEXT' }],
	} }));
	expect(message.reasoning_format).toBeUndefined();
	act(() => root.render(<AgentLogReasoning message={message} />));
	expect(container.textContent).not.toContain('UNSAFE_LEGACY_TEXT');
	expect(container.textContent?.match(/A safe legacy summary\./g)).toHaveLength(1);
});

it('uses certified empty reasoning without falling back to other text', () => {
	const message = storedResponseMessage(JSON.stringify({ reasoning_format: 'readable_v1', reasoning: '', reasoning_content: 'UNSAFE_FALLBACK', reasoning_details: [] }));
	act(() => root.render(<AgentLogReasoning message={message} />));
	expect(message.reasoning_format).toBe('readable_v1');
	expect(container.querySelector('.agent-log-reasoning')).toBeNull();
});
