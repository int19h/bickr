import { describe, expect, it } from 'vitest';
import { approximateTextTokens, textTokenWeight } from './text-token-estimate';

describe('language-sensitive token estimates', () => {
	it('keeps calibrated estimates for ASCII and raises the allowance for non-Latin content', () => {
		const english = 'a'.repeat(100);
		expect(textTokenWeight(english, 0.1)).toBeCloseTo(10);
		expect(textTokenWeight('日'.repeat(100), 0.1)).toBe(150);
		expect(textTokenWeight('あ'.repeat(100), 0.1)).toBe(150);
		expect(textTokenWeight('ệ', 0.1)).toBe(1.5);
		expect(textTokenWeight('я'.repeat(100), 0.1)).toBe(100);
		expect(textTokenWeight('ع'.repeat(100), 0.1)).toBe(100);
	});
	it('counts supplementary code points once while retaining a higher measured calibration', () => {
		expect(textTokenWeight('😀', 0.25)).toBe(2);
		expect(textTokenWeight('😀', 2)).toBe(4);
		expect(textTokenWeight('日', 2)).toBe(2);
	});
	it('adds mixed-language content without changing authored text', () => {
		const text = 'a日я😀';
		expect(textTokenWeight(text)).toBe(4.75);
		expect(approximateTextTokens(text)).toBe(5);
		expect(approximateTextTokens('')).toBe(1);
		expect(text).toBe('a日я😀');
	});
});
