import { ReferenceDataContext } from '../components/content';
import { NavigationContext } from '../components/navigation';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { localizedText, type BotLoopMessage } from '@bickr/shared/model';
import { LoopMessageRow, RawInferenceSubmissionMessageView } from '../screens/bots/loop-messages';
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
		const view = render(<LoopMessageRow message={row} deleting={false} loadingLogs={false} onDelete={() => {}} onViewLogs={() => {}} toolCallsById={new Map()} />);
		try {
			expect(view.container.querySelector('h3')?.textContent).toBe('Note PLAN');
			expect(view.container.querySelector('li')?.textContent).toBe('keep PLAN up-to-date');
			expect(view.container.querySelector('pre')).toBeNull();
			expect(view.container.textContent).not.toContain('\\n');
		} finally { view.close(); }
	});

	it('renders reports, tables, quotes, separators, and references as Markdown', () => {
		const content = '### Report\n\n> A body\n\n---\n\n| Ref | Status |\n| --- | --- |\n| t/abc | Ready |\n\nu/alice f/general c/abc';
		const view = render(<LoopMessageReadableView contentFormat="markdown" message={{ role: 'user', content }} />);
		try {
			for (const selector of ['h4', 'blockquote', 'hr', '.markdown-table table']) expect(view.container.querySelector(selector)).not.toBeNull();
			expect(view.container.textContent).toContain('u/alice');
			expect(view.container.textContent).toContain('f/general');
			expect(view.container.querySelector('pre')).toBeNull();
		} finally { view.close(); }
	});

	it('uses Markdown for opaque and note results while it keeps conversation cards', () => {
		const base = { kind: 'tool_result' as const, eventSeq: 1, name: 'read_note', args: {}, result: {} };
		const view = render(<>
			<LoopMessageReadableView contentFormat="markdown" message={row.message} display={{ ...base, envelope: { kind: 'opaque', value: note } }} />
			<LoopMessageReadableView contentFormat="markdown" message={row.message} display={{ ...base, envelope: { kind: 'note_read', id: 'PLAN', content: note, links: [] } }} />
			<LoopMessageReadableView contentFormat="markdown" message={{ role: 'tool', content: 'Fallback source' }} display={{ ...base, name: 'read_thread', envelope: { kind: 'content_read', items: [{ kind: 'thread', id: 'thr_one', title: localizedText('A conversation', null), body: localizedText('### Body heading\n\n> Quoted body', null) }] } }} />
		</>);
		try {
			expect(view.container.querySelectorAll('h3')).toHaveLength(2);
			expect(view.container.querySelector('.readable-thread-card h4')?.textContent).toBe('Body heading');
			expect(view.container.querySelector('pre')).toBeNull();
			expect(view.container.textContent).not.toContain('Fallback source');
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
