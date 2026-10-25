import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { AgentLogView } from './agent-log-view';
import { reasoningRuntimeOutput } from './agent-log-runtime-output.test-support.mjs';
import { pageFixture } from './agent-log.fixtures';
import { appendAgentLogDelta, emptyAgentLogPartial, parseAgentLogPartial } from '../../agent-log-partial';
import type { AgentLogEntry, AgentLogStreamPayload } from '@bickr/shared/model';

it.each([true, false])('renders actual runtime reasoning during streaming and settlement when completed=%s', async completed => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const output = await reasoningRuntimeOutput(completed);
	const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
	const show = (entries: AgentLogEntry[]) => act(() => root.render(<AgentLogView entries={entries} page={pageFixture()} participantName="Reader" onDelete={() => {}} onLogs={() => {}} onRequest={() => {}} onSession={() => {}} onPage={() => {}} />));
	const safe = () => {
		expect(container.textContent).not.toContain('PRIVATE_ENCRYPTED_BYTES');
		expect(container.textContent).not.toContain('PRIVATE_FUTURE_TEXT');
	};
	try {
		let partial = emptyAgentLogPartial();
		for (const [index, event] of output.events.entries()) {
			partial = appendAgentLogDelta(partial, event.payload as AgentLogStreamPayload);
			const snapshot = output.snapshots[index]!;
			const live = snapshot.find(entry => entry.kind === 'live');
			expect(live?.kind === 'live' ? parseAgentLogPartial(live.partialResponse) : null).toEqual(partial);
			show(snapshot); safe();
		}
		for (const entries of [output.snapshots.at(-1)!, output.settled, output.history]) {
			show(entries); safe();
			expect(container.querySelector('.agent-log-reasoning')?.textContent).toContain('Readable thought.');
			expect(container.querySelector('.agent-log-reasoning')?.textContent).toContain('Looking at the result.');
			expect(container.querySelector('.agent-log-reasoning')?.textContent?.match(/Looking at the result\./g)).toHaveLength(1);
			expect(container.textContent).toContain('2 more parts are encrypted by the provider');
		}
	} finally { act(() => root.unmount()); container.remove(); }
});

it.each([true, false])('keeps proven plain reasoning after opaque runtime details when completed=%s', async completed => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const output = await reasoningRuntimeOutput(completed, 'plain-opaque');
	const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
	try {
		for (const entries of [...output.snapshots, output.settled, output.history]) {
			act(() => root.render(<AgentLogView entries={entries} page={pageFixture()} participantName="Reader" onDelete={() => {}} onLogs={() => {}} onRequest={() => {}} onSession={() => {}} onPage={() => {}} />));
			expect(container.querySelector('.agent-log-reasoning')?.textContent).toContain('Readable plain thought.');
			expect(container.textContent).not.toContain('PRIVATE_ENCRYPTED_BYTES');
		}
		expect(container.textContent).toContain('1 more part is encrypted by the provider');
	} finally { act(() => root.unmount()); container.remove(); }
});
it.each([true, false])('keeps interleaved runtime details in the same order live and saved when completed=%s', async completed => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const output = await reasoningRuntimeOutput(completed, 'interleaved');
	const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
	try {
		for (const entries of [output.snapshots.at(-1)!, output.settled, output.history]) {
			act(() => root.render(<AgentLogView entries={entries} page={pageFixture()} participantName="Reader" onDelete={() => {}} onLogs={() => {}} onRequest={() => {}} onSession={() => {}} onPage={() => {}} />));
			expect([...container.querySelectorAll('.agent-log-reasoning .markdown-body p')].map(node => node.textContent).join('')).toBe('First.Second.Third.');
		}
	} finally { act(() => root.unmount()); container.remove(); }
});

it.each([true, false])('renders certified runtime text once in finished requests and history when completed=%s', async completed => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
	try {
		for (const scenario of ['plain-opaque', 'plain-summary', 'opaque-only'] as const) {
			const output = await reasoningRuntimeOutput(completed, scenario);
			const outcome = output.request.attempts.at(-1)!.outcome!;
			expect(outcome.kind).toBe(completed ? 'success' : 'interrupted');
			if (outcome.kind !== 'success' && outcome.kind !== 'interrupted') throw new Error('Expected a stored response.');
			const response = JSON.parse(outcome.response!).message;
			expect(response.reasoning_format).toBe('readable_v1');
			expect(response.reasoning).toBe(scenario === 'opaque-only' ? '' : scenario === 'plain-summary' ? 'Readable plain thought.\n\nA readable summary.' : 'Readable plain thought.');
			const settled = output.settled.find(entry => entry.kind === 'live');
			expect(settled?.kind === 'live' ? settled.response : null).toBe(outcome.response);
			const history = output.history.find(entry => entry.kind === 'message');
			expect(history?.kind === 'message' ? history.message.message.reasoning_format : null).toBe('readable_v1');
			expect(history?.kind === 'message' ? history.message.message.reasoning : null).toBe(response.reasoning);
			for (const entries of [output.settled, output.history]) {
				act(() => root.render(<AgentLogView entries={entries} page={pageFixture()} participantName="Reader" onDelete={() => {}} onLogs={() => {}} onRequest={() => {}} onSession={() => {}} onPage={() => {}} />));
				const text = container.querySelector('.agent-log-reasoning')?.textContent ?? '';
				expect(text).not.toContain('PRIVATE_ENCRYPTED_BYTES');
				if (scenario === 'opaque-only') {
					expect(container.querySelector('.opaque-only')).not.toBeNull();
					expect(text).toContain('encrypted by the provider');
					expect(container.querySelector('.agent-log-reasoning .markdown-body')).toBeNull();
				} else {
					expect(text.match(/Readable plain thought\./g)).toHaveLength(1);
					if (scenario === 'plain-summary') expect(text.match(/A readable summary\./g)).toHaveLength(1);
					else expect(text).toContain('1 more part is encrypted by the provider');
				}
			}
		}
	} finally { act(() => root.unmount()); container.remove(); }
});

it.each([true, false])('keeps runtime reasoning labels through settlement and history when completed=%s', async completed => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
	try {
		for (const scenario of ['summary-only', 'plain-summary', 'text-summary'] as const) {
			const output = await reasoningRuntimeOutput(completed, scenario);
			const outcome = output.request.attempts.at(-1)!.outcome!;
			if (outcome.kind !== 'success' && outcome.kind !== 'interrupted') throw new Error('Expected a stored response.');
			const response = JSON.parse(outcome.response!).message;
			for (const entries of [output.snapshots.at(-1)!, output.settled, output.history]) {
				act(() => root.render(<AgentLogView entries={entries} page={pageFixture()} participantName="Reader" onDelete={() => {}} onLogs={() => {}} onRequest={() => {}} onSession={() => {}} onPage={() => {}} />));
				expect(container.querySelector('.agent-log-reasoning-label')?.textContent?.trim()).toBe(scenario === 'summary-only' ? 'Reasoning summary' : 'Reasoning');
			}
			// Settlement changes the label source, but the certified content stays intact.
			expect([...container.querySelectorAll('.agent-log-reasoning .markdown-body p')].map(node => node.textContent)).toEqual(response.reasoning.split('\n\n'));
		}
	} finally { act(() => root.unmount()); container.remove(); }
});
