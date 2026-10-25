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
