import { describe, expect, it } from 'vitest';
import { approximateTextTokens } from './text-token-estimate';

describe('provider-calibrated text estimates', () => {
	it.each(['a', 'я', 'ع', '日', 'अ', 'ệ', '😀', 'a日я😀'])('lets measurements lower estimates for %s', (text) => {
		const prompt = text.repeat(42_000);
		expect(approximateTextTokens(prompt)).toBe(Math.ceil(prompt.length / 4));
		expect(approximateTextTokens(prompt, 0.1)).toBe(Math.ceil(prompt.length / 10));
		expect(approximateTextTokens(prompt, 2)).toBe(prompt.length * 2);
	});
	it('keeps the original empty-text minimum and fractional rounding', () => {
		expect(approximateTextTokens('')).toBe(1);
		expect(approximateTextTokens('я日ع', 0.5)).toBe(2);
	});
});
