import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentLogRequest, AgentLogAttempt } from '@bickr/shared/model';
import { AgentLogRequestDetails as AgentLogRequestView } from './agent-log-details';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});
const usage = {
	promptTokens: 20,
	cachedInputTokens: 4,
	uncachedInputTokens: 16,
	outputTokens: 5,
	totalTokens: 25,
	cachedInputCost: null,
	uncachedInputCost: null,
	outputCost: null,
	totalCost: null,
	estimatedCostSplit: false,
};
const selected: AgentLogAttempt = {
	id: 2,
	startedAt: '2026-10-24',
	body: '{"messages":[]}',
	usage,
	attribution: {
		model: 'test',
		parameters: { temperature: 0.2 },
		source: { botId: 'participant', worldHandle: 'world', botHandle: 'profile', runId: 'run', requestSeq: 1 },
	},
	messages: [
		{ position: 1, cacheStatus: 'cached', message: { role: 'system', content: 'Stored system text' } },
		{ position: 2, cacheStatus: 'partially_cached', message: { role: 'user', content: 'Stored user text' } },
	],
	outcome: { kind: 'success', response: 'Stored response' },
	partialResponse: null,
};
function request(attempts: AgentLogAttempt[]): AgentLogRequest {
	return {
		id: 'request',
		runId: 'run',
		purpose: 'loop',
		state: 'succeeded',
		createdAt: '2026-10-24',
		messageSeq: 3,
		sessionId: null,
		attempts,
	};
}

it('shows the selected attempt messages, cache chips, usage, and attribution once', async () => {
	const failed: AgentLogAttempt = { ...selected, id: 1, usage: null, attribution: null, messages: [], outcome: { kind: 'timeout' } };
	await act(async () => root.render(<AgentLogRequestView request={request([failed, selected])} />));
	expect(host.textContent).toContain('Stored system text');
	expect(host.textContent).toContain('Stored user text');
	expect(host.textContent).toContain('Stored response');
	expect([...host.querySelectorAll('.cache-status')].map((item) => item.textContent)).toEqual(['cached', 'partially cached']);
	expect(host.querySelectorAll('.request-usage-line')).toHaveLength(1);
	expect(host.querySelectorAll('.inference-attribution-fields')).toHaveLength(1);
	expect([...host.querySelectorAll('input')].map((input) => input.value)).toContain('test');
});

it('shows retained messages without usage chips and explains a missing exact body', async () => {
	await act(async () =>
		root.render(<AgentLogRequestView request={request([{ ...selected, body: null, usage: null, attribution: null, messages: [] }])} />),
	);
	expect(host.textContent).toContain('The exact request is not retained.');
	expect(host.querySelector('.cache-status')).toBeNull();
	expect(host.querySelector('.request-usage-line')).toBeNull();
});

it('shows each failed attempt metadata once when every attempt failed', async () => {
	const failed: AgentLogAttempt = { ...selected, outcome: { kind: 'provider_error', status: 400, errorType: null, message: 'Refused' } };
	await act(async () => root.render(<AgentLogRequestView request={{ ...request([failed]), state: 'failed' }} />));
	expect(host.textContent).toContain('Provider error · 400');
	expect(host.textContent).toContain('Refused');
	expect(host.querySelectorAll('.request-usage-line')).toHaveLength(1);
	expect(host.querySelectorAll('.inference-attribution-fields')).toHaveLength(1);
	expect(host.querySelectorAll('.cache-status')).toHaveLength(2);
});

it('keeps the last flushed response visible inside a failed attempt', async () => {
	const failed: AgentLogAttempt = {
		...selected,
		usage: null,
		attribution: null,
		outcome: { kind: 'interrupted' },
		partialResponse: '{"content":"Last flushed reply"}',
	};
	await act(async () => root.render(<AgentLogRequestView request={{ ...request([failed]), state: 'failed' }} />));
	expect(host.querySelector('details')?.textContent).toContain('Last flushed reply');
	expect(host.textContent?.match(/Last flushed reply/g)).toHaveLength(1);
});

it('keeps failed attempt usage separate from the selected response', async () => {
	const billed: AgentLogAttempt = {
		...selected,
		id: 1,
		usage: { ...usage, cachedInputTokens: 0, uncachedInputTokens: 31, promptTokens: 31 },
		attribution: null,
		messages: [],
		outcome: { kind: 'timeout' },
	};
	const unbilled: AgentLogAttempt = { ...billed, id: 2, usage: null };
	await act(async () => root.render(<AgentLogRequestView request={request([billed, unbilled, { ...selected, id: 3 }])} />));
	const rows = host.querySelectorAll('.agent-log-attempt');
	expect(rows[0]?.querySelectorAll('.request-usage-line')).toHaveLength(1);
	expect(rows[0]?.textContent).toContain('31 uncached input tokens');
	expect(rows[1]?.querySelector('.request-usage-line')).toBeNull();
	expect(host.querySelectorAll('.request-usage-line')).toHaveLength(2);
	const system = [...host.querySelectorAll('details')].find((node) => node.querySelector('summary')?.textContent?.includes('Message 1'))!;
	expect(system.open).toBe(false);
});

it('labels a local request failure as a runtime error', async () => {
	const failed: AgentLogAttempt = { ...selected, outcome: { kind: 'runtime_error', message: 'Storage is unavailable.' } };
	await act(async () => root.render(<AgentLogRequestView request={{ ...request([failed]), state: 'failed' }} />));
	expect(host.textContent).toContain('Runtime error');
	expect(host.textContent).toContain('Storage is unavailable.');
	expect(host.textContent).not.toContain('Provider error');
});

it('shows a generic label for an unknown stored failure', async () => {
	const failed: AgentLogAttempt = { ...selected, outcome: { kind: 'unknown' } };
	await act(async () => root.render(<AgentLogRequestView request={{ ...request([failed]), state: 'failed' }} />));
	expect(host.textContent).toContain('Unknown failure');
});
