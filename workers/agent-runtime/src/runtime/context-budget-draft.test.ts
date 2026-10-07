import { describe, expect, it } from 'vitest';
import type { EffectiveBotDocument } from '@bickr/shared/model';
import { parseLanguageTag } from '@bickr/shared/validation';
import { contextBudgetDraft } from './context-budget-draft';
const current = { instructionLocale: 'en', language: 'en', includeLanguageInSystemPrompt: true, prompt: { lang: 'en', text: 'Original' } } as EffectiveBotDocument;

describe('context budget draft', () => {
	it('uses the edited language both for language instructions and edited text', () => {
		expect(contextBudgetDraft(current, { language: parseLanguageTag('jbo'), prompt: 'coi' })).toMatchObject({ language: 'jbo', prompt: { lang: 'jbo', text: 'coi' } });
		expect(current.language).toBe('en');
	});
	it('preserves an explicit unspecified language', () => {
		expect(contextBudgetDraft(current, { language: null, prompt: 'Hello' })).toMatchObject({ language: null, prompt: { lang: null, text: 'Hello' } });
	});
	it('inherits the stored language only when the editor omits it', () => {
		expect(contextBudgetDraft(current, { prompt: 'Hello' })).toMatchObject({ language: 'en', prompt: { lang: 'en', text: 'Hello' } });
	});
});
