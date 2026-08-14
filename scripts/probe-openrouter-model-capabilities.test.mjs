import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openRouterFreeModel, openRouterModelCapabilities } from '../packages/shared/src/openrouter-model-capabilities.ts';
import {
	assertCatalogRemovalIsSafe,
	capabilitiesNeedProbe,
	capabilityProbeCatalogCoverage,
	capabilityProbePassKey,
	compactionReasoningCapabilitiesFromModelMetadata,
	classifyPrefillProbePair,
	classifyPrefillProbeResponse,
	classifyRequiredToolProbeAttempts,
	classifyRequiredToolProbeResponse,
	eligibleOpenRouterProviderCatalog,
	entriesForCurrentModels,
	generatedTableText,
	legacyPrefillCapabilities,
	legacyRequiredToolCapabilities,
	openRouterEndpointAvailability,
	parseArgs,
	providerPrefillControlRequest,
	providerPrefillRequest,
	providerRequiredToolCallRequest,
	providerRequiredToolControlRequest,
	projectCapabilityProbe,
	projectRequiredToolProbe,
	readCheckpoint,
	readExistingEntries,
	requiredToolProbeMatrix,
	requiredToolProbeShapes,
	remainingProbeBatch,
	resumablePrefillProgress,
	resumableRequiredToolProgress,
	validateCapabilityEntries,
} from './probe-openrouter-model-capabilities.mjs';

const baseCapabilities = {
	prefill: legacyPrefillCapabilities(true, 'legacy_boolean'),
	structuredOutputs: true,
	requiredToolCalls: legacyRequiredToolCapabilities(true, 'legacy_boolean'),
	disabledReasoning: true,
	cacheControl: false,
	compactionReasoning: {
		support: { kind: 'known', efforts: ['minimal', 'medium'] },
		modelDefault: { kind: 'explicit_effort', effort: 'medium' },
	},
	contextLength: 128_000,
};

describe('OpenRouter compaction reasoning metadata refresh', () => {
	it('keeps legacy required-tool evidence explicitly sourced during upgrade', () => {
		expect(legacyRequiredToolCapabilities(true, 'legacy_boolean')).toEqual({
			kind: 'provider_matrix',
			version: 2,
			providers: [],
			fallback: { supported: true, source: 'legacy_boolean' },
		});
	});

	it('keeps legacy prefill evidence explicitly sourced during input-only upgrade', () => {
		expect(legacyPrefillCapabilities(true, 'legacy_boolean')).toEqual({
			kind: 'provider_matrix',
			version: 2,
			providers: [],
			fallback: { supported: true, source: 'legacy_boolean' },
		});
	});

	it('keeps the generated free-route fixture equal to the runtime conservative policy', () => {
		expect(openRouterModelCapabilities(openRouterFreeModel).requiredToolCalls)
			.toEqual(legacyRequiredToolCapabilities(false, 'conservative_policy'));
		expect(openRouterModelCapabilities(openRouterFreeModel).prefill)
			.toEqual(legacyPrefillCapabilities(false, 'conservative_policy'));
	});

	it('selects unknown required-tool shapes for a bounded second pass', () => {
		const requiredToolCalls = {
			kind: 'provider_matrix',
			version: 2,
			providers: [{
				provider: 'provider/a',
				providerDefault: { status: 'supported', source: 'probe' },
				reasoningOff: { status: 'supported', source: 'probe' },
				reasoningOn: { status: 'unknown', source: 'probe', effort: 'minimal' },
			}],
			fallback: { supported: false, source: 'legacy_boolean' },
		};
		expect(capabilitiesNeedProbe({ ...baseCapabilities, requiredToolCalls }, new Set(['requiredToolCalls']), true)).toBe(true);
		requiredToolCalls.providers[0].reasoningOn = { status: 'unsupported', source: 'probe', effort: 'minimal' };
		expect(capabilitiesNeedProbe({ ...baseCapabilities, requiredToolCalls }, new Set(['requiredToolCalls']), true)).toBe(false);
		expect(capabilitiesNeedProbe(baseCapabilities, new Set(['requiredToolCalls']), true)).toBe(true);
	});

	it('keeps every possibly routable endpoint regardless of advertised tool parameters', () => {
		const catalog = eligibleOpenRouterProviderCatalog({ data: { endpoints: [
			{
				tag: 'deepseek/fp8',
				status: 0,
				supported_parameters: ['reasoning'],
				pricing: { prompt: '0.000001', completion: '0.000002', request: '0' },
			},
			{
				tag: 'decart/fp4',
				status: 0,
				supported_parameters: ['tools', 'reasoning'],
				pricing: { prompt: '0.000003', completion: '0.000004', request: '0' },
			},
			{ tag: 'deepseek/unavailable', status: -2, supported_parameters: ['tools'] },
			{ tag: 'future/provider', status: 7, supported_parameters: [] },
		] } });

		expect(catalog.map(({ provider }) => provider)).toEqual([
			'decart/fp4',
			'deepseek/fp8',
			'future/provider',
		]);
		expect(catalog).toEqual(expect.arrayContaining([
			expect.objectContaining({ provider: 'deepseek/fp8', advertisesTools: false }),
			expect.objectContaining({ provider: 'decart/fp4', advertisesTools: true }),
			expect.objectContaining({ provider: 'future/provider', hasUnknownAvailability: true }),
		]));
		expect(openRouterEndpointAvailability(-2)).toBe('unavailable');
		expect(openRouterEndpointAvailability(0)).toBe('active');
		expect(openRouterEndpointAvailability(undefined)).toBe('unknown_included');
		expect(requiredToolProbeMatrix({
			reasoning: { supported_efforts: ['high', 'low'] },
			supportedParameters: ['reasoning'],
		}, catalog).map(({ provider, key }) => `${provider}:${key}`)).toEqual([
			'decart/fp4:providerDefault',
			'decart/fp4:reasoningOff',
			'decart/fp4:reasoningOn',
			'deepseek/fp8:providerDefault',
			'deepseek/fp8:reasoningOff',
			'deepseek/fp8:reasoningOn',
			'future/provider:providerDefault',
			'future/provider:reasoningOff',
			'future/provider:reasoningOn',
		]);
		expect(projectRequiredToolProbe({
			reasoning: { supported_efforts: ['high', 'low'] },
			supportedParameters: ['reasoning'],
		}, catalog)).toMatchObject({
			providers: 3,
			providerShapes: 9,
			minimumChatRequests: 18,
			maximumChatRequests: 81,
			unknownPricedPairs: 3,
		});
	});

	it('projects every capability, retry, unknown-priced pair, and full-catalog invariant separately', () => {
		const catalog = [
			{ provider: 'known/a', promptPrice: 0.000001, completionPrice: 0.000002, requestPrice: 0 },
			{ provider: 'known/b', promptPrice: 0.000003, completionPrice: 0.000004, requestPrice: 0 },
			{ provider: 'unknown/c', promptPrice: null, completionPrice: null, requestPrice: null },
		];
		const projection = projectCapabilityProbe({
			id: 'anthropic/claude-projection-model',
			reasoning: { supported_efforts: ['high', 'low'] },
			supportedParameters: ['reasoning'],
		}, catalog, new Set([
			'prefill', 'structuredOutputs', 'requiredToolCalls', 'disabledReasoning', 'cacheControl',
			'compactionReasoning', 'contextLength',
		]));
		expect(projection).toMatchObject({
			providerCatalogEntries: 3,
			logicalProbes: 23,
			minimumActualHttpRequests: 39,
			maximumActualHttpRequests: 144,
			unknownPricedPairs: 9,
			unknownPricedModelProbes: 3,
		});
		expect(projection.knownPricedUpperSubtotalUsd).toBeGreaterThan(0);
		expect(projection.byCapability.prefill).toMatchObject({
			logicalProbes: 9,
			minimumActualHttpRequests: 18,
			maximumActualHttpRequests: 54,
		});
		expect(projection.byCapability.requiredToolCalls).toMatchObject({
			logicalProbes: 9,
			minimumActualHttpRequests: 18,
			maximumActualHttpRequests: 81,
		});
		expect(capabilityProbeCatalogCoverage([
			{ id: 'model/a' }, { id: 'model/b' }, { id: openRouterFreeModel },
		], ['model/a', 'model/b'])).toEqual({
			catalogModelCount: 3,
			projectedModelCount: 2,
			pinnedModelCount: 1,
			complete: true,
			uncoveredModelIds: [],
		});
	});

	it('classifies paired required-tool results without treating transient failures as unsupported', () => {
		expect(classifyRequiredToolProbeResponse({ ok: true, status: 200, payload: {
			choices: [{ message: { tool_calls: [{ function: { name: 'capability_probe' } }] } }],
		} })).toBe('supported');
		expect(classifyRequiredToolProbeResponse({ ok: true, status: 200, payload: { choices: [{ message: { content: 'ignored' } }] } }))
			.toBe('weak_success');
		expect(classifyRequiredToolProbeResponse({ ok: false, status: 400, payload: {} })).toBe('unsupported');
		for (const status of [0, 401, 402, 408, 409, 429, 500, 503]) {
			expect(classifyRequiredToolProbeResponse({ ok: false, status, payload: {} })).toBe('unknown');
		}
		const weak = { ok: true, status: 200, payload: { choices: [{ message: { content: 'ignored' } }] } };
		expect(classifyRequiredToolProbeAttempts(weak)).toBe('unknown');
		expect(classifyRequiredToolProbeAttempts(weak, weak)).toBe('unsupported');
		expect(classifyRequiredToolProbeAttempts(weak, { ok: false, status: 429, payload: {} })).toBe('unknown');
	});

	it('probes prefill with representative tools, provider pinning, and the active reasoning shape', () => {
		const offControl = providerPrefillControlRequest(
			'deepseek/deepseek-v4-flash-0731',
			{ effort: 'none', exclude: false },
			'deepseek/fp8',
		);
		expect(offControl).toMatchObject({
			tool_choice: 'auto',
			parallel_tool_calls: true,
			provider: { only: ['deepseek/fp8'], allow_fallbacks: false },
			reasoning: { effort: 'none', exclude: false },
		});
		expect(offControl.tools).toHaveLength(1);
		expect(providerPrefillRequest(
			'deepseek/deepseek-v4-flash-0731',
			{ effort: 'low', exclude: false },
			'deepseek/fp8',
		)).toMatchObject({
			reasoning: { effort: 'low', exclude: false },
			provider: { only: ['deepseek/fp8'], allow_fallbacks: false },
			messages: [
				{ role: 'system' },
				{ role: 'user' },
				{ role: 'assistant', content: 'I' },
			],
		});

		const successfulControl = { ok: true, status: 200, payload: {
			choices: [{ message: { tool_calls: [{ function: { name: 'capability_probe' } }] } }],
		} };
		const deepSeekPrefillFailure = { ok: false, status: 400, payload: {} };
		expect(classifyPrefillProbePair(successfulControl, deepSeekPrefillFailure)).toBe('unsupported');
		expect(classifyPrefillProbeResponse(deepSeekPrefillFailure)).toBe('unsupported');
		expect(classifyPrefillProbePair({ ok: false, status: 429, payload: {} }, deepSeekPrefillFailure)).toBe('unknown');
		expect(classifyPrefillProbePair({ ok: true, status: 200, payload: {} }, deepSeekPrefillFailure)).toBe('unknown');
	});

	it('pairs required-tool controls to the selected provider and short-circuits only metadata-prohibited shapes', () => {
		const control = providerRequiredToolControlRequest('model/a', undefined, 'provider/a');
		expect(control).toMatchObject({ provider: { only: ['provider/a'], allow_fallbacks: false } });
		expect(control).not.toHaveProperty('tool_choice');
		expect(providerRequiredToolCallRequest('model/a', undefined, 'provider/a')).toMatchObject({
			provider: { only: ['provider/a'], allow_fallbacks: false },
			tool_choice: 'required',
		});
		const mandatory = { reasoning: { mandatory: true, supported_efforts: ['low'] }, supportedParameters: ['reasoning'] };
		expect(requiredToolProbeShapes(mandatory, false)).toMatchObject([
			{ key: 'providerDefault', notApplicable: false },
			{ key: 'reasoningOff', notApplicable: true },
			{ key: 'reasoningOn', notApplicable: false, effort: 'low' },
		]);
		expect(requiredToolProbeShapes(mandatory, true)[1]).toMatchObject({ key: 'reasoningOff', notApplicable: false });
		expect(requiredToolProbeShapes({
			reasoning: { supported_efforts: ['high', 'low'] },
			supportedParameters: ['reasoning'],
		}, false)[2]).toMatchObject({ key: 'reasoningOn', notApplicable: false, effort: 'low' });
		expect(requiredToolProbeShapes({ reasoning: null, supportedParameters: [] }, false)[2])
			.toMatchObject({ key: 'reasoningOn', notApplicable: true });
	});

	it('rejects unknown CLI options, malformed generated input, and suspicious catalog shrinkage', async () => {
		expect(() => parseArgs(['--capabilty', 'required-tool-calls'])).toThrow('Unknown option');
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bickr-capabilities-'));
		const malformed = path.join(directory, 'generated.ts');
		await fs.writeFile(malformed, 'export const wrong = [];\n');
		await expect(readExistingEntries(malformed)).rejects.toThrow('malformed');
		const malformedShape = path.join(directory, 'malformed-shape.ts');
		await fs.writeFile(malformedShape, 'export const generatedOpenRouterModelCapabilityEntries = [["model",{"requiredToolCalls":{"version":1}}]];\n');
		await expect(readExistingEntries(malformedShape)).rejects.toThrow('malformed');
		const schemaTwoCheckpoint = path.join(directory, 'checkpoint-v2.json');
		await fs.writeFile(schemaTwoCheckpoint, JSON.stringify({ schemaVersion: 2, catalogFingerprint: 'catalog' }));
		await expect(readCheckpoint(schemaTwoCheckpoint, 'catalog')).rejects.toThrow('current schema/catalog');
		const schemaThreeCheckpoint = path.join(directory, 'checkpoint-v3.json');
		await fs.writeFile(schemaThreeCheckpoint, JSON.stringify({ schemaVersion: 3, catalogFingerprint: 'catalog' }));
		await expect(readCheckpoint(schemaThreeCheckpoint, 'catalog')).rejects.toThrow('current schema/catalog');
		const legacyBoolean = path.join(directory, 'legacy-boolean.ts');
		await fs.writeFile(legacyBoolean, `export const generatedOpenRouterModelCapabilityEntries = [\n${JSON.stringify([
			'model', { ...baseCapabilities, prefill: true, requiredToolCalls: true },
		])}\n];\n`);
		const upgradedLegacy = (await readExistingEntries(legacyBoolean)).get('model');
		expect(upgradedLegacy.requiredToolCalls).toEqual(
			legacyRequiredToolCapabilities(true, 'legacy_boolean'),
		);
		expect(upgradedLegacy.prefill).toEqual(legacyPrefillCapabilities(true, 'legacy_boolean'));
		expect(() => validateCapabilityEntries([['model', {
			...baseCapabilities,
			requiredToolCalls: {
				kind: 'provider_matrix',
				version: 1,
				providers: [],
				fallback: { supported: true, source: 'legacy_boolean' },
			},
		}]], 'test')).toThrow('required-tool schema version');
		expect(() => validateCapabilityEntries([['model', { ...baseCapabilities, requiredToolCalls: true }]], 'generated output'))
			.toThrow('requiredToolCalls');
		expect(() => validateCapabilityEntries([['model', { ...baseCapabilities, prefill: true }]], 'generated output'))
			.toThrow('prefill');
		const generated = generatedTableText([['model', {
			...baseCapabilities,
			requiredToolCalls: legacyRequiredToolCapabilities(true, 'legacy_boolean'),
		}]]);
		expect(generated).not.toMatch(/prefill: boolean|requiredToolCalls: boolean|version: 1/);
		const existing = new Map(Array.from({ length: 20 }, (_, index) => [`old/${index}`, baseCapabilities]));
		expect(() => assertCatalogRemovalIsSafe(existing, [], false)).toThrow('suspicious catalog shrinkage');
		expect(() => assertCatalogRemovalIsSafe(existing, [], true)).not.toThrow();
		await fs.rm(directory, { recursive: true, force: true });
	});

	it('resumes bounded model and provider-shape passes without spending twice', () => {
		const filter = new Set(['requiredToolCalls']);
		const key = capabilityProbePassKey('full', false, filter);
		expect(key).toBe(capabilityProbePassKey('full', false, new Set(['requiredToolCalls'])));
		expect(key).not.toBe(capabilityProbePassKey('new', true, filter));
		expect(remainingProbeBatch(['a', 'b', 'c', 'd'], new Set(['a', 'c']), 1)).toEqual(['b']);
		expect(remainingProbeBatch(['a', 'b', 'c'], new Set(['a']), Number.POSITIVE_INFINITY)).toEqual(['b', 'c']);
		const observation = { status: 'supported', source: 'probe' };
		const saved = { providers: ['decart/fp4', 'deepseek/fp8'], observations: new Map([['decart/fp4\nproviderDefault', observation]]) };
		expect(resumableRequiredToolProgress(saved.providers, saved)).toBe(saved);
		expect(resumableRequiredToolProgress(['decart/fp4'], saved)).toEqual({
			providers: ['decart/fp4'],
			observations: new Map(),
		});
		expect(resumablePrefillProgress(saved.providers, saved)).toBe(saved);
		expect(resumablePrefillProgress(['deepseek/fp8'], saved)).toEqual({
			providers: ['deepseek/fp8'],
			observations: new Map(),
		});
	});

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
			modelDefault: { kind: 'provider_default', relativeOrder: 'unknown' },
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
			modelDefault: { kind: 'provider_default', relativeOrder: 'above_xhigh' },
		});
	});

	it('keeps unmodelled effort observations distinct from explicit unsupported metadata', () => {
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: { supported_efforts: ['max'], default_effort: 'max' },
			supportedParameters: ['reasoning'],
		})).toEqual({
			support: { kind: 'partially_known', efforts: [] },
			modelDefault: { kind: 'provider_default', relativeOrder: 'above_xhigh' },
		});
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: { supported_efforts: ['max', 'high'], default_effort: 'max' },
			supportedParameters: ['reasoning'],
		})).toEqual({
			support: { kind: 'partially_known', efforts: ['high'] },
			modelDefault: { kind: 'provider_default', relativeOrder: 'above_xhigh' },
		});
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: { supported_efforts: [] },
			supportedParameters: ['reasoning'],
		})).toEqual({
			support: { kind: 'unsupported' },
			modelDefault: { kind: 'provider_default', relativeOrder: 'unknown' },
		});
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: { supported_efforts: [null] },
			supportedParameters: ['reasoning'],
		})).toEqual({
			support: { kind: 'unknown' },
			modelDefault: { kind: 'provider_default', relativeOrder: 'unknown' },
		});
	});

	it('preserves provider-default ordering evidence without guessing', () => {
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: { default_enabled: true, default_effort: 'none' },
			supportedParameters: ['reasoning'],
		})).toMatchObject({
			modelDefault: { kind: 'provider_default', relativeOrder: 'below_minimal' },
		});
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: { default_enabled: false },
			supportedParameters: ['reasoning'],
		})).toMatchObject({
			modelDefault: { kind: 'provider_default', relativeOrder: 'below_minimal' },
		});
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: { default_enabled: false, default_effort: 'medium' },
			supportedParameters: ['reasoning'],
		})).toMatchObject({
			modelDefault: { kind: 'provider_default', relativeOrder: 'below_minimal' },
		});
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: { default_enabled: false, default_effort: 'max' },
			supportedParameters: ['reasoning'],
		})).toMatchObject({
			modelDefault: { kind: 'provider_default', relativeOrder: 'below_minimal' },
		});
	});

	it('distinguishes an absent or malformed support observation from an explicit empty list', () => {
		expect(compactionReasoningCapabilitiesFromModelMetadata({ reasoning: null })).toEqual({
			support: { kind: 'unknown' },
			modelDefault: { kind: 'absent' },
		});
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: null,
			supportedParameters: 'reasoning',
		})).toEqual({
			support: { kind: 'unknown' },
			modelDefault: { kind: 'absent' },
		});
		expect(compactionReasoningCapabilitiesFromModelMetadata({
			reasoning: null,
			supportedParameters: [],
		})).toEqual({
			support: { kind: 'unsupported' },
			modelDefault: { kind: 'absent' },
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
			['z_/model', { contextLength: 1, ...baseCapabilities }],
		];

		expect(generatedTableText([...entries])).toBe(generatedTableText([...entries].reverse()));
		expect(generatedTableText([...entries])).toContain('["a/model"');
		expect(generatedTableText([...entries]).indexOf('["z/model"'))
			.toBeLessThan(generatedTableText([...entries]).indexOf('["z_/model"'));
		expect(generatedTableText([['model', {
			structuredOutputs: true,
			requiredToolCalls: legacyRequiredToolCapabilities(true, 'legacy_boolean'),
			prefill: legacyPrefillCapabilities(true, 'legacy_boolean'),
			disabledReasoning: true,
			contextLength: 1,
			compactionReasoning: baseCapabilities.compactionReasoning,
			cacheControl: false,
		}]]))
			.toContain('{"cacheControl":false,"compactionReasoning":');
	});
});
