import { describe, expect, it } from 'vitest';
import { contextWindowTokensMin, maxGeneratedTokensPerRequestMax, maxGeneratedTokensPerRequestMin } from './model';
import { assertContextWindowTokens, assertTickTokenBudget, defaultTickSettings, effectiveTickSettings, mergeTickSettings } from './repository';
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
	it.each([parseUpdateBotInput, parseBotContextBudgetInput])('bounds the per-request output limit in saved settings and probe drafts', parse => {
		for (const value of [maxGeneratedTokensPerRequestMin - 1, maxGeneratedTokensPerRequestMax + 1, 1.5]) {
			expect(() => parse({ language: 'en', prompt: 'Prompt', tickSettings: { maxGeneratedTokensPerRequest: value } })).toThrow();
		}
		for (const value of [maxGeneratedTokensPerRequestMin, 16_000, null]) {
			expect(parse({ language: 'en', prompt: 'Prompt', tickSettings: { maxGeneratedTokensPerRequest: value } }).tickSettings).toMatchObject({ maxGeneratedTokensPerRequest: value });
		}
	});
	it('keeps the per-request output limit within half of the context window', () => {
		const settings = (patch: Parameters<typeof mergeTickSettings>[1]) => mergeTickSettings(undefined, patch);
		expect(defaultTickSettings.maxGeneratedTokensPerRequest).toBe(5_000);
		expect(() => assertTickTokenBudget(settings({}))).not.toThrow();
		expect(() => assertTickTokenBudget(settings({ maxGeneratedTokensPerRequest: 20_000 }))).not.toThrow();
		expect(() => assertTickTokenBudget(settings({ maxGeneratedTokensPerRequest: 20_001 }))).toThrow('at most half of the context window (20000 tokens)');
		expect(() => assertTickTokenBudget(settings({ contextWindowTokens: contextWindowTokensMin, maxGeneratedTokensPerRequest: 10_001 }))).toThrow();
		expect(() => assertTickTokenBudget(settings({ contextWindowTokens: 200_000, maxGeneratedTokensPerRequest: 100_000 }))).not.toThrow();
		// Clearing the window override checks the limit against the default window.
		const large = settings({ contextWindowTokens: 200_000, maxGeneratedTokensPerRequest: 50_000 });
		expect(() => assertTickTokenBudget(mergeTickSettings(large, { contextWindowTokens: null }))).toThrow();
	});
	it('does not repair a legacy override during a read', () => {
		const stored = { ...mergeTickSettings(undefined), contextWindowTokens: contextWindowTokensMin - 1 };
		expect(effectiveTickSettings(stored).contextWindowTokens).toBe(stored.contextWindowTokens);
	});
});
