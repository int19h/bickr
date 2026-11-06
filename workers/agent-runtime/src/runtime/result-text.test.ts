import { describe, expect, it } from 'vitest';
import { instructionLocales } from '@bickr/shared/instruction-language';
import { botText } from '../localization';
import { renderResultText, type ResultText } from './result-text';

describe('stored history messages', () => {
	it('renders a stored search-rebuilding result in every locale', () => {
		const recipe: ResultText = { kind: 'message', key: 'issue.service.searchRebuilding', parameters: {} };
		for (const locale of instructionLocales) {
			expect(renderResultText(recipe, botText(locale)).length, locale).toBeGreaterThan(0);
		}
	});
});
