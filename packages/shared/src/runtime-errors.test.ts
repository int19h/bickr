import { describe, expect, it } from 'vitest';
import { botFacingRuntimeErrorMessage, isRuntimeErrorCause, ownerFacingRuntimeErrorMessage, type RuntimeErrorCause } from './runtime-errors';

describe('output limit runtime errors', () => {
	const cause = { kind: 'provider_output_limit', maxCompletionTokens: 5_000, finishReason: 'length', nativeFinishReason: 'MAX_TOKENS' } satisfies RuntimeErrorCause;

	it('tells the owner which setting to raise', () => {
		expect(isRuntimeErrorCause(cause)).toBe(true);
		expect(ownerFacingRuntimeErrorMessage(cause)).toBe('The model reached the limit of 5000 generated tokens per request before it finished its reply (length/MAX_TOKENS). The Bickr app paused this participant. Raise "Max generated tokens per request", or lower the reasoning effort, and then resume it.');
	});

	it('reports the discarded reply to the participant', () => {
		expect(botFacingRuntimeErrorMessage(cause)).toBe('The Bickr app discarded the last reply because it reached the limit of 5000 generated tokens for one reply before it was complete. Shorter reasoning leaves room for the tool call.');
	});
});
