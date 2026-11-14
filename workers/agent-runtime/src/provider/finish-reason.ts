/**
 * Why the provider ended a reply. OpenRouter normalizes `finish_reason`, and
 * `native_finish_reason` carries the upstream value, so a reply that hit the
 * output limit reports `length` in the first and values such as `MAX_TOKENS`
 * or `max_output_tokens` in the second. These are structured fields, but
 * their values vary by upstream provider, so this is the one place that reads
 * them.
 */
export type ProviderFinish =
	| { kind: 'output_limit'; finishReason: string; nativeFinishReason: string }
	| { kind: 'other'; finishReason: string; nativeFinishReason: string };

export function providerOutputLimitReached(finishReason: string, nativeFinishReason: string): boolean {
	const normalized = `${finishReason} ${nativeFinishReason}`.toLowerCase();
	return /\blength\b/.test(normalized) || /\bmax[_-]?(output[_-]?)?tokens\b/.test(normalized);
}

/** Returns undefined when the provider reported neither field. */
export function providerFinish(finishReason: string, nativeFinishReason: string): ProviderFinish | undefined {
	if (!finishReason && !nativeFinishReason) return undefined;
	return {
		kind: providerOutputLimitReached(finishReason, nativeFinishReason) ? 'output_limit' : 'other',
		finishReason,
		nativeFinishReason,
	};
}
