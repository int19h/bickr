import { describe, expect, it } from 'vitest';
import { providerFinish, providerOutputLimitReached } from './finish-reason';

describe('provider finish reasons', () => {
	it.each([
		['length', ''],
		['', 'MAX_TOKENS'],
		['', 'max_tokens'],
		['', 'max_output_tokens'],
		['length', 'max-output-tokens'],
	])('treats %s/%s as the output limit', (finishReason, nativeFinishReason) => {
		expect(providerOutputLimitReached(finishReason, nativeFinishReason)).toBe(true);
		expect(providerFinish(finishReason, nativeFinishReason)?.kind).toBe('output_limit');
	});

	it.each([
		['stop', 'STOP'],
		['tool_calls', 'end_turn'],
		['content_filter', 'SAFETY'],
	])('treats %s/%s as another finish', (finishReason, nativeFinishReason) => {
		expect(providerFinish(finishReason, nativeFinishReason)).toEqual({ kind: 'other', finishReason, nativeFinishReason });
	});

	it('reports no finish when the provider sent neither field', () => {
		expect(providerFinish('', '')).toBeUndefined();
	});
});
