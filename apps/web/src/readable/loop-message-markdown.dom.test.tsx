import { loopMarkdownFixture as fixture } from '../../../../test/fixtures/loop-markdown';
import { ReferenceDataContext } from '../components/content';
import { NavigationContext } from '../components/navigation';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { type BotLoopMessage } from '@bickr/shared/model';
import { RawInferenceSubmissionMessageView } from '../screens/bots/loop-log-formatting';
import { AgentLogView } from '../screens/bots/agent-log-view';
import { LoopMessageReadableView } from './loop-message-readable';

const note = '## Note `PLAN`\n\n- keep PLAN up-to-date';
const row: BotLoopMessage = {
	seq: 1, runId: 'run-note', role: 'tool', message: { role: 'tool', tool_call_id: 'note', content: note },
	contentFormat: 'markdown', origin: 'synthetic_context', tokenEstimate: 10, createdAt: '2026-10-23T12:00:00Z',
};

function render(element: React.ReactNode) {
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(element));
	return { container, close() { act(() => root.unmount()); container.remove(); } };
}

describe('Loop Markdown', () => {
	it('renders a synthetic note as a heading and a list in its Loop row', () => {
		const view = render(<AgentLogView entries={[{ kind: "message", position: 1, message: row, author: { kind: "tool_result", synthetic: true }, requestId: null, sessionId: null, attempts: null }]} page={null} participantName="Reader" onDelete={() => {}} onLogs={() => {}} onRequest={() => {}} onSession={() => {}} onPage={() => {}} />);
		try {
			expect(view.container.querySelector('h2')?.textContent).toBe('Note PLAN');
			expect(view.container.querySelector('li')?.textContent).toBe('keep PLAN up-to-date');
			expect(view.container.querySelector('pre')).toBeNull();
			expect(view.container.textContent).not.toContain('\\n');
		} finally { view.close(); }
	});

	it('renders reports, tables, quotes, separators, and references as Markdown', () => {
		const content = '### Report\n\n> A body\n\n---\n\n| Ref | Status |\n| --- | --- |\n| t/abc | Ready |\n\nu/alice f/general c/abc';
		const view = render(<LoopMessageReadableView contentFormat="markdown" message={{ role: 'user', content }} />);
		try {
			for (const selector of ['h3', 'blockquote', 'hr', '.markdown-table table']) expect(view.container.querySelector(selector)).not.toBeNull();
			expect(view.container.textContent).toContain('u/alice');
			expect(view.container.textContent).toContain('f/general');
			expect(view.container.querySelector('pre')).toBeNull();
		} finally { view.close(); }
	});

	it.each([
		'Timestamp: 0d0h1m\nu/reader posted:',
		'u/reader posted:\nA second line.',
	])('preserves a single newline around a reference: %s', content => {
		const view = render(<LoopMessageReadableView contentFormat="markdown" message={{ role: 'tool', content }} />);
		try {
			const paragraph = view.container.querySelector('p')!;
			expect(paragraph.querySelectorAll('br')).toHaveLength(1);
			expect(paragraph.querySelector('.ref-bot')?.textContent).toBe('u/reader');
			expect(paragraph.textContent).toBe(content.replace('\n', ''));
		} finally { view.close(); }
	});

	it('shows the stored thread pruning and shortened body instead of the full event card', () => {
		const message = { role: 'tool' as const, tool_call_id: 'read', content: fixture.providerText };
		const view = render(<LoopMessageReadableView contentFormat="markdown" message={message} display={fixture.display} />);
		try {
			expect(fixture.providerText).toContain('1 more reply');
			expect(view.container.textContent).toContain('This text is shortened.');
			expect(view.container.textContent).toContain(fixture.shortenedBody);
			expect(view.container.textContent).toContain('1 more reply to this comment is not shown.');
			expect(view.container.textContent).toContain('I read this text earlier');
			expect(view.container.textContent).not.toContain(fixture.hiddenBody);
			expect(view.container.textContent).not.toContain(fixture.fullBody.trim());
			expect(view.container.querySelector('.readable-thread-card')).toBeNull();
			expect(view.container.querySelector('.markdown-body')?.getAttribute('data-markdown-source')).toBe(message.content);
		} finally { view.close(); }
	});

	it('renders stored failures and settlements from their participant text', () => {
		for (const content of [fixture.failureText, fixture.settlementText]) {
			const message = { role: 'tool' as const, tool_call_id: 'failed', content };
			const view = render(<LoopMessageReadableView contentFormat="markdown" message={message} display={{
				kind: 'tool_result', eventSeq: 2, name: 'read_thread', args: {}, result: { error: 'refused', message: 'Full event diagnostic' },
			}} />);
			try {
				expect(view.container.querySelector('.markdown-body')?.getAttribute('data-markdown-source')).toBe(message.content);
				expect(view.container.textContent).not.toContain('Full event diagnostic');
				expect(view.container.querySelector('pre')).toBeNull();
			} finally { view.close(); }
		}
	});

	it('keeps conversation cards for legacy JSON rows', () => {
		const view = render(<LoopMessageReadableView contentFormat="json" message={{ role: 'tool', content: '{}' }} display={fixture.display} />);
		try {
			expect(view.container.querySelector('.readable-thread-card')).not.toBeNull();
			expect(view.container.textContent).toContain(fixture.fullBody.trim());
			expect(view.container.textContent).toContain(fixture.hiddenBody);
		} finally { view.close(); }
	});

	it('keeps the card for a legacy synthetic JSON tool row', () => {
		const legacy: BotLoopMessage = {
			...row, contentFormat: 'json', display: fixture.display,
			message: { role: 'tool', tool_call_id: 'old', content: JSON.stringify(fixture.display.result) },
		};
		const view = render(<AgentLogView entries={[{ kind: "message", position: 1, message: legacy, author: { kind: "tool_result", synthetic: true }, requestId: null, sessionId: null, attempts: null }]} page={null} participantName="Reader" onDelete={() => {}} onLogs={() => {}} onRequest={() => {}} onSession={() => {}} onPage={() => {}} />);
		try {
			expect(view.container.querySelector('.readable-thread-card')).not.toBeNull();
			expect(view.container.textContent).toContain('Full event data');
			expect(view.container.textContent).toContain(fixture.hiddenBody);
		} finally { view.close(); }
	});

	it('uses the JSON fallback when a newer server sends an unknown format', () => {
		const contentFormat = 'future-format' as BotLoopMessage['contentFormat'];
		const view = render(<LoopMessageReadableView contentFormat={contentFormat} message={{ role: 'tool', content: '{"unrecognized":true}' }} />);
		try {
			expect(view.container.querySelector('pre')?.textContent).toContain('"unrecognized"');
			expect(view.container.querySelector('.markdown-body')).toBeNull();
		} finally { view.close(); }
	});

	it('uses the existing reference links and navigation in Markdown text', () => {
		const destinations: unknown[] = [];
		const view = render(<NavigationContext.Provider value={{ navigate: route => { destinations.push(route); }, openContentRef: async () => {} }}><ReferenceDataContext.Provider value={{ activeWorldHandle: 'primary', bots: [], botsByWorld: {}, forumsByWorld: {}, humans: [], worlds: [] }}><LoopMessageReadableView contentFormat="markdown" message={{ role: 'user', content: 'u/alice f/general t/abcdefgh c/abcdefgh' }} /></ReferenceDataContext.Provider></NavigationContext.Provider>);
		try {
			const link = view.container.querySelector<HTMLAnchorElement>('a[href="/w/primary/u/alice"]');
			expect(link).not.toBeNull();
			act(() => link!.click());
			expect(destinations).toEqual([{ route: 'bot-profile', worldHandle: 'primary', botHandle: 'alice' }]);
			expect(view.container.querySelector('a[href="/w/primary/f/general"]')).not.toBeNull();
			expect(view.container.textContent).toContain('t/abcdefgh');
			expect(view.container.textContent).toContain('c/abcdefgh');
		} finally { view.close(); }
	});

	it('keeps legacy JSON and participant narration in their existing views', () => {
		const view = render(<><LoopMessageReadableView contentFormat="json" message={{ role: 'tool', content: '{"unrecognized":true}' }} /><LoopMessageReadableView contentFormat="text" message={{ role: 'assistant', content: note }} /></>);
		try {
			expect(view.container.querySelector('pre')?.textContent).toContain('"unrecognized"');
			expect(view.container.querySelector('.loop-readable-text')?.textContent).toBe(note);
			expect(view.container.querySelector('h3')).toBeNull();
		} finally { view.close(); }
	});

	it('keeps Markdown source in the raw view', () => {
		const view = render(<RawInferenceSubmissionMessageView message={row.message} position={1} />);
		try {
			expect(view.container.querySelector('pre')?.textContent).toBe(note);
			expect(view.container.querySelector('h3')).toBeNull();
		} finally { view.close(); }
	});
});
