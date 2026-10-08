import { readCatalogGroup } from '../../../../scripts/localization/catalog-source.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { instructionLocales, instructionContentLanguage } from '@bickr/shared/instruction-language';
import { factoryText } from '@bickr/shared/localization';
import { messageParameters } from './messages';
import { botText } from './index';
import { toolDefinitionsForProviderRound, providerAvatarDescriptionToolDefinitions, providerTranslationToolDefinitions } from '../prompt-and-tools';

const root = fileURLToPath(new URL('../../../../', import.meta.url).href);
type InventoryUnit = {
	id: keyof typeof messageParameters;
	definition: { file: string; line: number };
	protectedTokens: readonly string[];
	sourceTemplateHash: string;
	sinks: readonly { file: string; line: number; kind: 'direct' | 'typed_dynamic' }[];
};
const inventory = JSON.parse(readFileSync(`${root}/docs/prompt-localization/inventory/index.json`, 'utf8')) as {
	sourceUnitCount: number;
	sourceHash: string;
	catalogSourceHash: string;
	groups: readonly { group: string; file: string; units: number }[];
};
const units = inventory.groups.flatMap((group) => {
	const data = JSON.parse(readFileSync(`${root}/docs/prompt-localization/inventory/${group.file}`, 'utf8')) as { units: InventoryUnit[] };
	expect(data.units).toHaveLength(group.units);
	return data.units;
});
function catalogPart(file: string): Record<string, string | Record<string, string>> {
	const localeDirectory = file.match(/^(.*\/localization\/[a-z]{2})\//)![1]!;
	return readCatalogGroup(`${root}/${file}`, `${root}/${localeDirectory}`, messageParameters).messages;
}

function invariantToolShape(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(invariantToolShape);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description')
		.map(([key, member]) => [key, invariantToolShape(member)]));
}

function allToolShapes(locale: typeof instructionLocales[number]): unknown {
	const text = botText(locale);
	return invariantToolShape([
		...toolDefinitionsForProviderRound(text),
		...providerAvatarDescriptionToolDefinitions(text),
		...providerTranslationToolDefinitions(text),
	]);
}

function catalogSourceFingerprint(): string {
	const sourceRecords = [...units].sort((a, b) => a.id.localeCompare(b.id, 'en')).map((unit) => {
		const definition = messageParameters[unit.id];
		return {
		id: unit.id, parameters: [...definition.parameters].sort(),
		plural: definition.kind === 'plural' ? definition.count : null,
		templateHash: createHash('sha256').update(JSON.stringify(catalogPart(unit.definition.file)[unit.id])).digest('hex'),
		};
	});
	return createHash('sha256').update(JSON.stringify(sourceRecords)).digest('hex');
}

describe('reviewed instruction catalogs', () => {
	it('tracks exact English text and parameters in review fingerprints', () => {
		expect(catalogSourceFingerprint()).toBe(inventory.catalogSourceHash);
	});

	it.each(instructionLocales.filter((locale) => locale !== 'en'))('ties the %s translation reviews to the current source and catalog', (locale) => {
		const sourceHash = catalogSourceFingerprint();
		expect(sourceHash).toBe(inventory.catalogSourceHash);
		const approval = JSON.parse(readFileSync(`${root}/docs/prompt-localization/reviews/${locale}.json`, 'utf8')) as {
			sourceHash: string; catalogSourceHash: string; locale: string; status: string;
			reviewers: { opus: unknown; grok: unknown };
			groups: Record<string, {
				finalTemplateHash: string; draftHashes: Record<string, string>;
				decisions: Record<string, { finalValueHash: string; leadReason: string; candidateReason: string; opusReason: string; grokReason: string }>;
			}>;
		};
		expect(approval).toMatchObject({ sourceHash: inventory.sourceHash, catalogSourceHash: sourceHash, locale, status: 'accepted_by_lead' });
		expect(approval.reviewers.opus).toBeTruthy();
		expect(approval.reviewers.grok).toBeTruthy();
		expect(Object.keys(approval.groups).sort()).toEqual(inventory.groups.map((group) => group.group).sort());
		for (const group of inventory.groups) {
			const first = units.find((unit) => unit.definition.file.endsWith(`/en/${group.group.replace(/^shared\//, '')}.yaml`))!;
			const target = catalogPart(first.definition.file.replace('/en/', `/${locale}/`));
			expect(createHash('sha256').update(JSON.stringify(target)).digest('hex'), group.group).toBe(approval.groups[group.group]!.finalTemplateHash);
			expect(Object.keys(approval.groups[group.group]!.draftHashes).sort()).toEqual(['codex', 'gemini', 'grok', 'opus']);
			for (const value of Object.values(approval.groups[group.group]!.draftHashes)) expect(value).toMatch(/^[a-f0-9]{64}$/);
			const decisions = approval.groups[group.group]!.decisions;
			expect(Object.keys(decisions).sort()).toEqual(Object.keys(target).sort());
			for (const [id, value] of Object.entries(target)) {
				const decision = decisions[id]!;
				expect(decision.finalValueHash, id).toBe(createHash('sha256').update(JSON.stringify(value)).digest('hex'));
				for (const reason of [decision.leadReason, decision.candidateReason, decision.opusReason, decision.grokReason]) {
					expect(reason.trim().length, id).toBeGreaterThan(0);
				}
			}
		}
	});

	it.each(instructionLocales)('recognizes prior transcript headers and continuation text after switching from %s', (locale) => {
		const prior = botText(locale);
		const current = botText('en');
		for (const key of ['formatting.action', 'formatting.result', 'formatting.input', 'formatting.thought'] as const) {
			const label = prior.format(key);
			expect(current.isTranscriptHeader(`${label}: historical tool response`)).toBe(true);
			expect(current.isTranscriptHeader(`${label.toLocaleUpperCase(prior.contentLanguage)}\u202f： historical tool response`)).toBe(true);
		}
		expect(current.isContinuation(prior.format('compaction.continuation'))).toBe(true);
	});

	it.each(instructionLocales)('keeps every tool name, argument, enum, and schema constraint invariant in %s', (locale) => {
		expect(allToolShapes(locale)).toEqual(allToolShapes('en'));
	});

	it('records every definition and caller in the inventory', () => {
		expect(units).toHaveLength(inventory.sourceUnitCount);
		expect(new Set(units.map((unit) => unit.id)).size).toBe(units.length);
		expect(units.map((unit) => unit.id).sort()).toEqual(Object.keys(messageParameters).sort());
		for (const unit of units) {
			expect(unit.sinks.length, unit.id).toBeGreaterThan(0);
			const source = catalogPart(unit.definition.file)[unit.id];
			expect(createHash('sha256').update(JSON.stringify(source)).digest('hex'), unit.id).toBe(unit.sourceTemplateHash);
			const line = readFileSync(`${root}/${unit.definition.file}`, 'utf8').split('\n')[unit.definition.line - 1];
			expect(line, unit.id).toContain(`${unit.id}:`);
		}
	});

	it.each(instructionLocales)('preserves protocol syntax, parameters, and native counts in %s', (locale) => {
		const context = botText(locale);
		const shared = factoryText(locale);
		expect(context.locale).toBe(locale);
		expect(shared.locale).toBe(locale);
		const counts = [0, 1, 2, 3, 6, 7, 10, 11, 21, 100, 101, 1000000];
		const categories = new Intl.PluralRules(instructionContentLanguage(locale)).resolvedOptions().pluralCategories;
		const parts = new Map<string, ReturnType<typeof catalogPart>>();
		for (const unit of units) {
			const file = unit.definition.file.replace('/en/', `/${locale}/`);
			let part = parts.get(file);
			if (!part) {
				part = catalogPart(file);
				const expectedKeys = units.filter((entry) => entry.definition.file === unit.definition.file).map((entry) => entry.id);
				expect(Object.keys(part).sort(), file).toEqual(expectedKeys.sort());
				parts.set(file, part);
			}
			const entry = part[unit.id];
			const definition = messageParameters[unit.id];
			const variants = definition.kind === 'plural' ? Object.values(entry as Record<string, string>) : [entry as string];
			if (definition.kind === 'plural') expect(Object.keys(entry).sort(), unit.id).toEqual([...categories].sort());
			for (const template of variants) {
				for (const token of unit.protectedTokens) expect(template, `${locale}:${unit.id}:${token}`).toContain(token);
				const parameters = [...template.matchAll(/{{([^{}]+)}}/g)].map((match) => match[1]);
				expect([...new Set(parameters)].sort(), unit.id).toEqual([...definition.parameters].sort());
			}
			if (definition.kind !== 'plural') {
				const parameters = Object.fromEntries(definition.parameters.map((name) => [name, `opaque:{{${name}}}`]));
				const result = context.formatDescriptor({ key: unit.id, parameters } as Parameters<typeof context.formatDescriptor>[0]);
				expect(result, `${locale}:${unit.id}`).toBe((entry as string).replace(/{{([^{}]+)}}/g, (_match, name: string) => parameters[name]!));
				continue;
			}
			for (const count of counts) {
				const parameters = Object.fromEntries(definition.parameters.map((name) => [name, name === definition.count ? count : `opaque:{{${name}}}`]));
				const result = context.formatDescriptor({ key: unit.id, parameters } as Parameters<typeof context.formatDescriptor>[0]);
				expect(result, `${locale}:${unit.id}:${count}`).toContain(String(count));
				const category = new Intl.PluralRules(instructionContentLanguage(locale)).select(count);
				const template = (entry as Record<string, string>)[category]!;
				expect(result, `${locale}:${unit.id}:${count}`).toBe(template.replace(/{{([^{}]+)}}/g, (_match, name: string) => String(parameters[name])));
			}
		}
	});
});
