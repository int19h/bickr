import { ownerFacingRuntimeErrorMessage } from '@bickr/shared/runtime-errors';
import { describe, expect, it } from 'vitest';
import { CompactionReasoningRefusalError, RuntimeOperationTimeoutError, ToolOutcomeUnknownError, runtimeErrorCause } from './errors';

describe('compaction reasoning refusal diagnostics', () => {
	it('reports the typed refusal and contributing floors without freeform provider configuration', () => {
		const error = new CompactionReasoningRefusalError(
			{
				kind: 'no_supported_effort',
				required: { kind: 'explicit_effort', effort: 'xhigh' },
				supportedEfforts: ['minimal', 'high'],
			},
			{
				configuration: { kind: 'explicit_effort', effort: 'xhigh' },
				modelDefault: { kind: 'explicit_effort', effort: 'high' },
				safetyFloor: { kind: 'explicit_effort', effort: 'low' },
				learnedFloor: { kind: 'explicit_effort', effort: 'minimal' },
				baselineSelection: { kind: 'explicit_effort', effort: 'high' },
				support: 'known',
				policySource: 'openrouter_semantic_override',
			},
		);

		expect(runtimeErrorCause(error)).toEqual({
			kind: 'compaction_reasoning_refusal',
			refusal: {
				kind: 'no_supported_effort',
				required: { kind: 'explicit_effort', effort: 'xhigh' },
				supportedEfforts: ['minimal', 'high'],
			},
			provenance: {
				configuration: { kind: 'explicit_effort', effort: 'xhigh' },
				modelDefault: { kind: 'explicit_effort', effort: 'high' },
				safetyFloor: { kind: 'explicit_effort', effort: 'low' },
				learnedFloor: { kind: 'explicit_effort', effort: 'minimal' },
				baselineSelection: { kind: 'explicit_effort', effort: 'high' },
				support: 'known',
				policySource: 'openrouter_semantic_override',
			},
		});
		expect(JSON.stringify(runtimeErrorCause(error))).not.toMatch(/providerRouting|apiKey|prompt/i);
	});
});

it('serializes the original structured timeout for unknown website outcomes', () => {
 const cause = JSON.parse(JSON.stringify(runtimeErrorCause(new ToolOutcomeUnknownError(new RuntimeOperationTimeoutError('The Bickr page request', 30_000)))));
 expect(cause).toEqual({ kind: 'tool_outcome_unknown', cause: { kind: 'runtime_operation_timeout', operation: 'The Bickr page request', timeoutMs: 30_000 } });
 expect(ownerFacingRuntimeErrorMessage(cause)).toContain('The Bickr page request did not finish within 30 seconds.');
});
