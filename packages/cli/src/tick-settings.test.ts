import { expect, it } from 'vitest';
import { contextWindowTokensMin, maxGeneratedTokensPerRequestMax, maxGeneratedTokensPerRequestMin } from '@bickr/shared/model';
import { tickSettingsFromFlags, tickSettingsHelp } from './tick-settings.ts';

it('uses the shared context minimum in flags and help', () => {
	const parse = (value: string) => tickSettingsFromFlags(new Map([['tick-context-window-tokens', value]]));
	expect(() => parse(String(contextWindowTokensMin - 1))).toThrow();
	for (const value of [contextWindowTokensMin, contextWindowTokensMin + 1]) expect(parse(String(value))).toEqual({ contextWindowTokens: value });
	expect(parse('null')).toEqual({ contextWindowTokens: null });
	expect(tickSettingsHelp).toContain(`--tick-context-window-tokens ${contextWindowTokensMin}..`);
});

it('bounds the per-request output limit flag', () => {
	const parse = (value: string) => tickSettingsFromFlags(new Map([['tick-max-generated-tokens-per-request', value]]));
	expect(() => parse(String(maxGeneratedTokensPerRequestMin - 1))).toThrow();
	expect(() => parse(String(maxGeneratedTokensPerRequestMax + 1))).toThrow();
	expect(parse('16000')).toEqual({ maxGeneratedTokensPerRequest: 16_000 });
	expect(parse('null')).toEqual({ maxGeneratedTokensPerRequest: null });
});
