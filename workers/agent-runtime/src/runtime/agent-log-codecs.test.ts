import { describe, expect, it } from 'vitest';
import { logStreamDelta } from './agent-log-codecs';
import { RepositoryError } from '@bickr/shared/repository';
import { readLogAttemptOutcome, readLogAttemptKind, readLogCompactionOutcome, logAttemptOutcome, logAuthor, logCompactionOutcome, logFailure, logPartial, logToolDelta, logTrigger } from './agent-log-codecs';

const failures = [
	{ kind: 'runtime_error', message: 'Storage is unavailable.' },
	{ kind: 'provider_error', status: 429, errorType: 'rate_limit', message: 'Busy.' },
	{ kind: 'validation', issue: 'invalid', message: 'Invalid.' },
	{ kind: 'dropped_invalid_output', droppedCalls: [{ id: 'call', name: 'action', reason: 'invalid', argumentsPreview: '{}' }] },
	{ kind: 'interrupted', response: 'Partial response' },
	{ kind: 'timeout' },
];

function extraFields(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(extraFields);
	if (value && typeof value === 'object') return { ...Object.fromEntries(Object.entries(value).map(([key, item]) => [key, extraFields(item)])), internalSecret: 'private' };
	return value;
}

describe('agent log API boundaries', () => {
	it.each(failures)('selects fields for $kind failures and attempt outcomes', failure => {
		expect(logFailure(extraFields(failure))).toEqual(failure);
		expect(logAttemptOutcome(extraFields(failure))).toEqual(failure);
	});

	it('selects success fields while preserving the exact response string', () => {
		const value = { kind: 'success', response: '{"exact":"response"}' };
		expect(logAttemptOutcome(extraFields(value))).toEqual(value);
	});

	it.each([
		{ kind: 'pending' },
		{ kind: 'succeeded', summarySeq: 4 },
		{ kind: 'failed', error: failures[1] },
		{ kind: 'partial', summarySeqs: [4, 5], failedBatchCount: 1, error: failures[2] },
	])('selects nested fields for $kind compaction outcomes', outcome => {
		expect(logCompactionOutcome(extraFields(outcome))).toEqual(outcome);
	});

	it.each(['visit', 'admission', 'manual', 'legacy_forced'])('selects fields for the %s trigger', kind => {
		expect(logTrigger({ kind, internalSecret: 'private' })).toEqual({ kind });
	});

	it.each(['model', 'owner_injection', 'reminder', 'self_correction', 'recurring_prompt', 'spotlight_focus', 'synthetic_tool_call', 'local_simulation', 'compaction_summary', 'legacy_summary', 'bickr_report', 'legacy_synthetic'])('selects fields for the %s author', kind => {
		expect(logAuthor({ kind, internalSecret: 'private' })).toEqual({ kind });
	});

	it('selects the synthetic flag for tool authors', () => {
		expect(logAuthor({ kind: 'tool_result', synthetic: true, internalSecret: 'private' })).toEqual({ kind: 'tool_result', synthetic: true });
	});

	it('selects every nested field of partial tool calls', () => {
		const partial = { content: 'Text', reasoning: 'Reason', reasoningParts: [{ kind: 'text', text: 'Reason' }], toolCalls: [{ index: 0, id: 'call', type: 'function', function: { name: 'action', arguments: '{}' } }] };
		expect(logPartial(extraFields(partial))).toEqual(partial);
	});

	it('accepts null optional fields from provider tool deltas', () => {
		expect(logToolDelta({ index: 0, id: null, type: null, function: { name: null, arguments: '{' } })).toEqual({ index: 0, function: { arguments: '{' } });
	});

	it.each([logFailure, logAttemptOutcome, logCompactionOutcome, logAuthor, logTrigger])('rejects unknown kinds in strict codecs', project => {
		expect(() => project({ kind: 'unknown', internalSecret: 'private' })).toThrow(RepositoryError);
		expect(() => project({ kind: 'unknown', internalSecret: 'private' })).toThrow('The stored agent log has an unsupported shape.');
	});

	it('rejects an unknown nested failure', () => {
		expect(() => logCompactionOutcome({ kind: 'failed', error: { kind: 'unknown', internalSecret: 'private' } })).toThrow(RepositoryError);
	});
});


const unsupported = [
	'{"kind":"future_failure","internalSecret":"private"}',
	'{"kind":"runtime_error","message":42}',
	'{"kind":"success","response":42}',
	'{"kind":"dropped_invalid_output","droppedCalls":[{}]}',
	'null', '[]', 'not JSON', '',
];
it.each(unsupported)('contains an unsupported stored outcome: %s', value => {
	expect(readLogAttemptOutcome(value)).toEqual({ kind: 'unknown' });
	expect(readLogCompactionOutcome(value)).toEqual({ kind: 'failed', error: { kind: 'unknown' } });
});
it.each(['{"kind":"future_failure"}', 'null', 'not JSON'])('contains unsupported attempt metadata: %s', value => {
	expect(readLogAttemptKind(value)).toBe('unknown');
});
it('keeps partial progress when its stored failure is unsupported', () => {
	expect(readLogCompactionOutcome(JSON.stringify({ kind: 'partial', summarySeqs: [1, 2], failedBatchCount: 1, error: { kind: 'future_failure', internalSecret: 'private' } }))).toEqual({ kind: 'partial', summarySeqs: [1, 2], failedBatchCount: 1, error: { kind: 'unknown' } });
});
it.each([null, { kind: 'future_failure' }, { kind: 'runtime_error', message: 42 }])('contains an invalid nested session failure: %s', error => {
	expect(readLogCompactionOutcome(JSON.stringify({ kind: 'failed', error }))).toEqual({ kind: 'failed', error: { kind: 'unknown' } });
});

it('builds compatibility text only from proven readable parts', () => {
	const readable = { kind: 'readable', type: 'reasoning.summary', text: 'Readable' };
	expect(logStreamDelta({ kind: 'reasoning', source: 'detail', text: 'PRIVATE', part: readable }))
		.toEqual({ kind: 'reasoning', source: 'detail', text: 'Readable', part: readable });
	const opaque = { kind: 'readable', type: 'future.type', text: 'OPAQUE' };
	expect(logStreamDelta({ kind: 'reasoning', source: 'detail', text: 'OPAQUE', part: opaque }))
		.toEqual({ kind: 'reasoning', source: 'detail', part: { kind: 'opaque', type: 'future.type' } });
	expect(logPartial({ content: '', reasoning: 'OPAQUE', reasoningParts: [
		{ kind: 'text', text: 'Plain' }, readable, opaque,
	], toolCalls: [] }).reasoning).toBe('PlainReadable');
});
