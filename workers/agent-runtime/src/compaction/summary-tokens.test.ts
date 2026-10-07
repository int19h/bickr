import { describe, expect, it } from 'vitest';
import { summaryLanguageTokenFloor, summaryTokenAllowance } from './summary-tokens';

describe('future summary language allowance in workerd', () => {
	it.each([
		['en', 0.25], ['fr', 0.25], ['de', 0.25], ['pt', 0.25], ['it', 0.25], ['da', 0.25], ['id', 0.25], ['tr', 0.25], ['vi', 1], ['ru', 1], ['ru-Latn', 0.25], ['sr', 1], ['sr-Latn', 0.25],
		['uk', 1], ['be', 1], ['ar', 1], ['he', 1], ['ja', 1.5], ['zh-Hant', 1.5], ['ko', 1.5],
		['hi', 1.5], ['th', 1.5], ['ka', 1.5], ['ga', 0.25], ['eo', 0.25], ['und', 0.5], ['not_a_tag', 0.5], [null, 0.5],
	] as const)('uses the script of %s', (tag, expected) => {
		expect(summaryLanguageTokenFloor(tag)).toBe(expected);
	});
	it('reserves either speaking or instruction language', () => {
		expect(summaryTokenAllowance('ru-Latn', 'ja', 0.2)).toBe(1.5);
		expect(summaryTokenAllowance('ja', 'en', 0.2)).toBe(1.5);
	});
	it('reserves either language without a speaking-language instruction', () => {
		expect(summaryTokenAllowance('ru-Latn', 'ja', 0.2)).toBe(1.5);
		expect(summaryTokenAllowance('ja', 'en', 0.2)).toBe(1.5);
	});
	it('keeps a higher measured model allowance', () => {
		expect(summaryTokenAllowance('en', 'en', 2)).toBe(2);
		expect(summaryTokenAllowance(null, 'ja', 0.2)).toBe(1.5);
	});
});
