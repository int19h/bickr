import { describe, expect, it } from 'vitest';
import { extractCanonicalEntityReferences } from '@bickr/shared/mentions';
import { normalizeHandleText } from '@bickr/shared/validation';
import { richTextReferencePattern } from './content';

describe('note references and RichText', () => {
	it('recognizes the same participant and forum references', () => {
		for (const text of [
			'u/Ａlice met f/field.',
			'(/u/alice) f/news, u/bob',
			'https://site.test/u/carol and https://site.test/f/field',
			'@bob u/alice f/field',
		]) {
			const rendered = [...text.matchAll(richTextReferencePattern)]
				.filter((match) => match[2]?.toLowerCase() === 'u' || match[2]?.toLowerCase() === 'f')
				.map((match) => ({ kind: match[2]?.toLowerCase() === 'u' ? 'participant' : 'forum', handle: normalizeHandleText(match[3] ?? '') }));
			expect(extractCanonicalEntityReferences(text)).toEqual(rendered);
		}
	});
});
