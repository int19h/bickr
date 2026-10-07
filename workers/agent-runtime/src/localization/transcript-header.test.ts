import { describe, expect, it } from 'vitest';
import { transcriptHeaderMatcher } from './transcript-header';

describe('translated transcript headers', () => {
	const matches = transcriptHeaderMatcher([
		{ label: 'Action', language: 'en' },
		{ label: 'Girdi', language: 'tr' },
		{ label: 'Résultat', language: 'fr' },
		{ label: '入力', language: 'ja' },
	]);
	it('recognizes native case, canonically equivalent accents, and full-width colons', () => {
		expect(matches('GİRDİ: a tool response')).toBe(true);
		expect(matches('RE\u0301SULTAT\u202f: a tool response')).toBe(true);
		expect(matches('入力：a tool response')).toBe(true);
		expect(matches('ACTION: a tool response')).toBe(true);
	});
	it('does not treat an ordinary sentence or a longer word as a transcript header', () => {
		expect(matches('Actions: a tool response')).toBe(false);
		expect(matches('Action became necessary: I replied.')).toBe(false);
		expect(matches('My input: a comment')).toBe(false);
		expect(matches('GIRDI: an English case fold changes Turkish letters')).toBe(false);
	});
});
