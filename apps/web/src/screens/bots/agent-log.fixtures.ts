import type { AgentLogAuthor, AgentLogCompactionSession, AgentLogEntry, AgentLogRequest, BotLoopMessagePage } from '@bickr/shared/model';

export function messageFixture(
	seq: number,
	author: AgentLogAuthor = { kind: 'model' },
	content = 'I will read the new replies before I respond.',
): Extract<AgentLogEntry, { kind: 'message' }> {
	const role = author.kind === 'tool_result' ? 'tool' : author.kind === 'bickr_report' ? 'user' : 'assistant';
	return {
		kind: 'message',
		position: seq,
		author,
		requestId: author.kind === 'model' ? 'request-example' : null,
		sessionId: null,
		attempts: null,
		message: {
			seq,
			position: seq,
			runId: 'visit-example',
			role,
			message: { role, content },
			contentFormat: 'markdown',
			origin: 'provider_response',
			tokenEstimate: 28,
			createdAt: '2026-10-24T12:00:00Z',
			status: 'complete',
			hasLogs: false,
		},
	};
}

export const requestFixture: AgentLogRequest = {
	id: 'request-example',
	runId: 'visit-example',
	purpose: 'loop',
	state: 'succeeded',
	createdAt: '2026-10-24T12:00:00Z',
	messageSeq: 3,
	sessionId: null,
	attempts: [
		{
			id: 1,
			startedAt: '2026-10-24T12:00:00Z',
			body: JSON.stringify({
				messages: [
					{ role: 'system', content: 'Read the page before you respond.' },
					{ role: 'user', content: 'Two new replies arrived.' },
				],
			}),
			partialResponse: null,
			outcome: { kind: 'provider_error', status: 503, errorType: 'unavailable', message: 'The provider was unavailable.' },
		},
		{
			id: 2,
			startedAt: '2026-10-24T12:00:02Z',
			body: JSON.stringify({
				messages: [
					{ role: 'system', content: 'Read the page before you respond.' },
					{ role: 'user', content: 'Two new replies arrived.' },
				],
			}),
			partialResponse: null,
			outcome: {
				kind: 'dropped_invalid_output',
				droppedCalls: [{ id: 'invalid-call', name: 'read_thread', reason: 'Missing thread reference', argumentsPreview: '{}' }],
			},
		},
		{
			id: 3,
			startedAt: '2026-10-24T12:00:04Z',
			body: JSON.stringify({
				messages: [
					{ role: 'system', content: 'Read the page before you respond.' },
					{ role: 'assistant', content: 'I must include the thread reference.' },
					{ role: 'user', content: 'Two new replies arrived.' },
				],
			}),
			partialResponse: null,
			outcome: {
				kind: 'success',
				response: JSON.stringify({ message: { role: 'assistant', content: 'I will read the new replies before I respond.' } }),
			},
		},
	],
};

export const sessionFixture: AgentLogCompactionSession = {
	id: 'session-example',
	position: 9,
	trigger: { kind: 'manual' },
	createdAt: '2026-10-24T12:05:00Z',
	outcome: {
		kind: 'partial',
		summarySeqs: [10],
		failedBatchCount: 1,
		error: { kind: 'validation', issue: 'summary_not_shorter', message: 'The second batch did not produce a shorter summary.' },
	},
	requests: [
		{
			...requestFixture,
			id: 'summary-request',
			purpose: 'compaction',
			sessionId: 'session-example',
			attempts: [requestFixture.attempts[2]!],
		},
		{
			...requestFixture,
			id: 'failed-summary-request',
			purpose: 'compaction',
			sessionId: 'session-example',
			state: 'failed',
			attempts: [{ ...requestFixture.attempts[0]!, outcome: { kind: 'timeout' } }],
		},
	],
};

export function pageFixture(archive = false): BotLoopMessagePage {
	return {
		currentPage: archive ? 2 : 1,
		pageCount: 2,
		pages: [
			{ page: 1, isNewest: true, messageCount: 5, sourceCompactionSeq: 10, compactionSessionId: 'session-example' },
			{ page: 2, isNewest: false, messageCount: 8 },
		],
		compactionPageBySeq: { '10': 1 },
		...(archive ? { newerPage: 1 } : { olderPage: 2 }),
	};
}

export function entriesFixture(): AgentLogEntry[] {
	const response = messageFixture(3);
	response.attempts = {
		count: 3,
		failures: requestFixture.attempts
			.slice(0, 2)
			.map((attempt) => ({
				attemptId: attempt.id,
				outcome: attempt.outcome as Exclude<NonNullable<typeof attempt.outcome>, { kind: 'success' }>,
			})),
	};
	response.message.message.reasoning =
		'The discussion contains two different proposals. I need the latest replies to see which details changed.\n\nI will compare the examples before I choose a response.';
	response.message.message.tool_calls = [
		{
			id: 'call-example',
			type: 'function',
			function: { name: 'read_thread', arguments: JSON.stringify({ threadRef: 't/example-thread' }) },
		},
	];
	const result = messageFixture(
		4,
		{ kind: 'tool_result', synthetic: false },
		'### New replies\n\nTwo participants added examples.\n\n| Proposal | State |\n| --- | --- |\n| Shared schedule | Ready for review |\n| Weekly digest | Needs examples |\n\n> Keep the first trial small.',
	);
	result.message.message.tool_call_id = 'call-example';
	return [
		messageFixture(1, { kind: 'bickr_report' }, 'Your visit began. Two new replies arrived in the discussion.'),
		messageFixture(2, { kind: 'spotlight_focus' }, 'Look at the examples in the planning discussion.'),
		response,
		result,
		messageFixture(5, { kind: 'owner_injection' }, 'Consider a shorter trial before you suggest a wider change.'),
	];
}
