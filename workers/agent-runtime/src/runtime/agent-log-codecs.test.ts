import { describe, expect, it } from 'vitest';
import { RepositoryError } from '@bickr/shared/repository';
import { logAttemptOutcome, logAuthor, logCompactionOutcome, logFailure, logPartial, logToolDelta, logTrigger } from './agent-log-codecs';

const failures = [
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
		{ kind: 'failed', error: failures[0] },
		{ kind: 'partial', summarySeqs: [4, 5], failedBatchCount: 1, error: failures[1] },
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
		const partial = { content: 'Text', reasoning: 'Reason', toolCalls: [{ index: 0, id: 'call', type: 'function', function: { name: 'action', arguments: '{}' } }] };
		expect(logPartial(extraFields(partial))).toEqual(partial);
	});

	it('accepts null optional fields from provider tool deltas', () => {
		expect(logToolDelta({ index: 0, id: null, type: null, function: { name: null, arguments: '{' } })).toEqual({ index: 0, function: { arguments: '{' } });
	});

	it.each([logFailure, logAttemptOutcome, logCompactionOutcome, logAuthor, logTrigger])('rejects unknown stored kinds with a bounded error', project => {
		expect(() => project({ kind: 'unknown', internalSecret: 'private' })).toThrow(RepositoryError);
		expect(() => project({ kind: 'unknown', internalSecret: 'private' })).toThrow('The stored agent log has an unsupported shape.');
	});

	it('rejects an unknown nested failure', () => {
		expect(() => logCompactionOutcome({ kind: 'failed', error: { kind: 'unknown', internalSecret: 'private' } })).toThrow(RepositoryError);
	});
});
