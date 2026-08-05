import { describe, expect, it } from 'vitest';
import {
	compactionReasoningCapabilitiesFromModelMetadata,
	entriesForCurrentModels,
	generatedTableText,
} from './probe-openrouter-model-capabilities.mjs';

const baseCapabilities = {
	prefill: true,
	structuredOutputs: true,
	requiredToolCalls: true,
	disabledReasoning: true,
	cacheControl: false,
	compactionReasoning: {
		support: { kind: 'known', efforts: ['minimal', 'medium'] },
		modelDefault: { kind: 'explicit_effort', effort: 'medium' },
	},
	contextLength: 128_000,
};

describe('OpenRouter compaction reasoning metadata refresh', () => {
	it('distinguishes known, unknown, and unsupported effort observations', () => {
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: { supported_efforts: ['medium', 'minimal', 'medium'], default_effort: 'medium' },
			supportedParameters: ['reasoning'],
		})).toEqual({
			support: { kind: 'known', efforts: ['medium', 'minimal'] },
			modelDefault: { kind: 'explicit_effort', effort: 'medium' },
		});
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: { mandatory: false },
			supportedParameters: ['reasoning'],
		})).toEqual({
			support: { kind: 'unknown' },
			modelDefault: { kind: 'provider_default' },
		});
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: null,
			supportedParameters: [],
		})).toEqual({
			support: { kind: 'unsupported' },
			modelDefault: { kind: 'absent' },
		});
		expect(compactionReasoningCapabilitiesFromModelMetadata({})).toEqual({
			support: { kind: 'unknown' },
			modelDefault: { kind: 'absent' },
		});
	});

	it('treats a null supported-efforts set as all gateway-supported phase efforts', () => {
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: { supported_efforts: null, default_effort: 'max' },
			supportedParameters: ['reasoning'],
		})).toEqual({
			support: { kind: 'known', efforts: ['high', 'low', 'medium', 'minimal', 'xhigh'] },
			modelDefault: { kind: 'provider_default' },
		});
	});

	it('removes models no longer returned by the listing workflow', () => {
		const entries = new Map([
			['current/model', baseCapabilities],
			['removed/model', baseCapabilities],
		]);

		expect(entriesForCurrentModels(entries, new Set(['current/model']))).toEqual([
			['current/model', baseCapabilities],
		]);
	});

	it('renders generated output deterministically regardless of input order', () => {
		const entries = [
			['z/model', baseCapabilities],
			['a/model', { ...baseCapabilities, contextLength: 64_000 }],
		];

		expect(generatedTableText([...entries])).toBe(generatedTableText([...entries].reverse()));
		expect(generatedTableText([...entries])).toContain('["a/model"');
	});
});
