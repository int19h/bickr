import { describe, expect, it } from 'vitest';
import { contextWindowTokensMin } from './model';
import { assertContextWindowTokens, defaultTickSettings, effectiveTickSettings, mergeTickSettings } from './repository';
import { parseBotContextBudgetInput, parseUpdateBotInput } from './validation';

describe('participant context budgets', () => {
	it.each([parseUpdateBotInput, parseBotContextBudgetInput])('uses the shared minimum for saved settings and probe drafts', parse => {
		expect(() => parse({ language: 'en', prompt: 'Prompt', tickSettings: { contextWindowTokens: contextWindowTokensMin - 1 } })).toThrow();
		for (const value of [contextWindowTokensMin, contextWindowTokensMin + 1, null]) {
			expect(parse({ language: 'en', prompt: 'Prompt', tickSettings: { contextWindowTokens: value } }).tickSettings).toMatchObject({ contextWindowTokens: value });
		}
	});
	it('enforces the minimum at the writer boundary', () => {
		expect(() => assertContextWindowTokens(contextWindowTokensMin - 1)).toThrow();
		for (const value of [contextWindowTokensMin, contextWindowTokensMin + 1, null, undefined]) expect(() => assertContextWindowTokens(value)).not.toThrow();
	});
	it('uses the new default only when no override is stored', () => {
		expect(defaultTickSettings.contextWindowTokens).toBe(contextWindowTokensMin * 2);
		expect(effectiveTickSettings(undefined).contextWindowTokens).toBe(defaultTickSettings.contextWindowTokens);
		expect(mergeTickSettings(undefined)).not.toHaveProperty('contextWindowTokens');
		expect(effectiveTickSettings({ ...mergeTickSettings(undefined), contextWindowTokens: contextWindowTokensMin }).contextWindowTokens).toBe(contextWindowTokensMin);
	});
	it('does not repair a legacy override during a read', () => {
		const stored = { ...mergeTickSettings(undefined), contextWindowTokens: contextWindowTokensMin - 1 };
		expect(effectiveTickSettings(stored).contextWindowTokens).toBe(stored.contextWindowTokens);
	});
});
