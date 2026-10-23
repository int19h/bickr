import { readCatalogGroup } from '../../../../scripts/localization/catalog-source.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { instructionLocales, instructionContentLanguage } from '@bickr/shared/instruction-language';
import type { MessageDefinition } from '@bickr/shared/instruction-template';
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
	pendingUnits?: (InventoryUnit & { status: "english_placeholder" })[];
	pendingTranslationKeys: string[];
	sourceHash: string;
	catalogSourceHash: string;
	groups: readonly { group: string; file: string; units: number }[];
};
const reviewedUnits = inventory.groups.flatMap((group) => {
	const data = JSON.parse(readFileSync(`${root}/docs/prompt-localization/inventory/${group.file}`, 'utf8')) as { units: InventoryUnit[] };
	expect(data.units).toHaveLength(group.units);
	return data.units;
});
const pendingUnits = inventory.pendingUnits ?? [];
const units = [...reviewedUnits, ...pendingUnits];

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

function messageDefinition(id: keyof typeof messageParameters): MessageDefinition {
	return messageParameters[id];
}

function catalogSourceFingerprint(): string {
	const sourceRecords = [...reviewedUnits].sort((a, b) => a.id.localeCompare(b.id, 'en')).map((unit) => {
		const definition = messageDefinition(unit.id);
		return {
		id: unit.id, parameters: [...definition.parameters].sort(),
		plural: definition.kind === 'plural' ? definition.count : null,
		...(definition.kind === 'select' ? { select: definition.select, variants: definition.variants } : {}),
		templateHash: createHash('sha256').update(JSON.stringify(catalogPart(unit.definition.file)[unit.id])).digest('hex'),
		};
	});
	return createHash('sha256').update(JSON.stringify(sourceRecords)).digest('hex');
}

type LeadTranslation = {
	provenance: 'lead_translation';
	lead: string;
	reviewerSessions: { reviewer: string; session: string }[];
	reviewedCommit: string;
	leadReason: string;
	reviewerReason: string;
};
type FourDraftDecision = {
	provenance?: 'four_draft';
	leadReason: string;
	candidateReason: string;
	opusReason: string;
	grokReason: string;
};
type ReviewDecision = { finalValueHash: string } & (LeadTranslation | FourDraftDecision);
type ReviewGroup = { finalTemplateHash: string; decisions: Record<string, ReviewDecision> } & (
	LeadTranslation | { provenance?: 'four_draft'; draftHashes: Record<string, string> }
);
type IncrementalReview = LeadTranslation & {
	sourceCommit: string;
	catalogSourceHash: string;
	units: string[];
	status: string;
	reviewedDraftCommit: string;
	reportHash: string;
	uncertainties: string[];
};

function assertLeadTranslation(record: LeadTranslation): void {
	expect(record.provenance).toBe('lead_translation');
	expect(record.lead.trim()).not.toBe('');
	expect(record.reviewedCommit).toMatch(/^[a-f0-9]{40}$/);
	expect(record.reviewerSessions.length).toBeGreaterThan(0);
	const sessions = record.reviewerSessions.map(reviewer => reviewer.session);
	expect(new Set(sessions).size).toBe(sessions.length);
	for (const reviewer of record.reviewerSessions) {
		expect(reviewer.reviewer.trim()).not.toBe('');
		expect(reviewer.session).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
		expect(reviewer.reviewer).not.toBe(record.lead);
	}
	for (const reason of [record.leadReason, record.reviewerReason]) expect(reason.trim().length).toBeGreaterThan(0);
	for (const field of ['draftHashes', 'candidateReason', 'opusReason', 'grokReason']) expect(record).not.toHaveProperty(field);
}

function assertFourDraftGroup(record: Exclude<ReviewGroup, LeadTranslation>): void {
	expect([undefined, 'four_draft']).toContain(record.provenance);
	expect(Object.keys(record.draftHashes).sort()).toEqual(['codex', 'gemini', 'grok', 'opus']);
	for (const value of Object.values(record.draftHashes)) expect(value).toMatch(/^[a-f0-9]{64}$/);
}

function assertDecision(record: ReviewDecision): void {
	if (record.provenance === 'lead_translation') {
		assertLeadTranslation(record);
	} else {
		expect([undefined, 'four_draft']).toContain(record.provenance);
		for (const reason of [record.leadReason, record.candidateReason, record.opusReason, record.grokReason]) {
			expect(reason.trim().length).toBeGreaterThan(0);
		}
	}
}

describe('reviewed instruction catalogs', () => {
	it('closes the pending state after the Markdown translation review', () => {
		expect(inventory.pendingTranslationKeys).toEqual([]);
		expect(pendingUnits).toEqual([]);
	});
	it('rejects incomplete or mixed lead-translation evidence', () => {
		const valid: LeadTranslation = {
			provenance: 'lead_translation', lead: 'claude-opus',
			reviewerSessions: [{ reviewer: 'codex', session: '01a1698f-3e28-78e0-95fe-3f5136e1da61' }],
			reviewedCommit: 'ecdf29b7baaf31b02cc2bdbf1f514b545c38143d',
			leadReason: 'The lead applied every finding.', reviewerReason: 'Codex reviewed the translation.',
		};
		assertLeadTranslation(valid);
		for (const invalid of [
			{ ...valid, reviewerSessions: [] }, { ...valid, reviewedCommit: 'unknown' },
			{ ...valid, leadReason: '' }, { ...valid, reviewerReason: '' },
			{ ...valid, draftHashes: {} }, { ...valid, opusReason: 'No review.' },
			{ ...valid, grokReason: 'No review.' }, { ...valid, provenance: 'unknown' },
		]) expect(() => assertLeadTranslation(invalid as LeadTranslation)).toThrow();
	});

	it.each(instructionLocales)('keeps deliberate prompt separators in %s', (locale) => {
		const group = catalogPart(`workers/agent-runtime/src/localization/${locale}/system.yaml`);
		expect(group['system.plan']).toMatch(/[^\n]\n\n$/);
		expect(group['system.logOffInstruction']).toMatch(/[^\n]\n$/);
		expect(group['system.setting']).toMatch(/^\n[^\n]/);
		expect(group['system.main']).toMatch(/[^\n]\n$/);
	});
	it('tracks exact English text and parameters in review fingerprints', () => {
		expect(catalogSourceFingerprint()).toBe(inventory.catalogSourceHash);
	});

	it.each(instructionLocales.filter((locale) => locale !== 'en'))('ties the %s translation reviews to the current source and catalog', (locale) => {
		const sourceHash = catalogSourceFingerprint();
		expect(sourceHash).toBe(inventory.catalogSourceHash);
		const approval = JSON.parse(readFileSync(`${root}/docs/prompt-localization/reviews/${locale}.json`, 'utf8')) as {
			sourceHash: string; catalogSourceHash: string; locale: string; status: string;
			reviewers: { opus: unknown; grok: unknown };
			groups: Record<string, ReviewGroup>;
			incrementalReviews: ({ provenance?: undefined } | IncrementalReview)[];
		};
		expect(approval).toMatchObject({ sourceHash: inventory.sourceHash, catalogSourceHash: sourceHash, locale, status: inventory.pendingTranslationKeys.length ? 'partially_pending_translation' : 'approved' });
		expect(approval.reviewers.opus).toBeTruthy();
		expect(approval.reviewers.grok).toBeTruthy();
		expect(Object.keys(approval.groups).sort()).toEqual(inventory.groups.map((group) => group.group).sort());
		for (const group of inventory.groups) {
			const groupInventory = JSON.parse(readFileSync(`${root}/docs/prompt-localization/inventory/${group.file}`, 'utf8')) as { units: InventoryUnit[] };
			const first = groupInventory.units[0]!;
			const ids = new Set(reviewedUnits.filter(unit => unit.definition.file === first.definition.file).map(unit => unit.id));
			const target = Object.fromEntries(Object.entries(catalogPart(first.definition.file.replace('/en/', `/${locale}/`))).filter(([id]) => ids.has(id as keyof typeof messageParameters)));
			expect(createHash('sha256').update(JSON.stringify(target)).digest('hex'), group.group).toBe(approval.groups[group.group]!.finalTemplateHash);
			const record = approval.groups[group.group]!;
			if (record.provenance === 'lead_translation') assertLeadTranslation(record);
			else assertFourDraftGroup(record);
			const decisions = approval.groups[group.group]!.decisions;
			expect(record).not.toHaveProperty('status');
			expect(record).not.toHaveProperty('pendingTranslationKeys');
			expect(Object.keys(decisions).sort()).toEqual(Object.keys(target).sort());
			for (const [id, value] of Object.entries(target)) {
				const decision = decisions[id]!;
				expect(decision.finalValueHash, id).toBe(createHash('sha256').update(JSON.stringify(value)).digest('hex'));
				assertDecision(decision);
				if (record.provenance === 'lead_translation') {
					expect(decision).toMatchObject({
						provenance: 'lead_translation', lead: record.lead,
						reviewerSessions: record.reviewerSessions, reviewedCommit: record.reviewedCommit,
					});
				}
				if (decision.provenance === 'lead_translation') {
					const update = approval.incrementalReviews.findLast(entry => entry.provenance === 'lead_translation'
						&& entry.reviewedCommit === decision.reviewedCommit && entry.units.includes(id)) as IncrementalReview | undefined;
					expect(update, id).toBeDefined();
					expect(decision.lead, id).toBe(update!.lead);
					expect(decision.reviewerSessions, id).toEqual(update!.reviewerSessions);
				}
			}
		}
		const update = approval.incrementalReviews.at(-1) as IncrementalReview;
		assertLeadTranslation(update);
		expect(update.catalogSourceHash).toBe(sourceHash);
		expect(update.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
		expect(update.reviewedDraftCommit).toMatch(/^[a-f0-9]{40}$/);
		expect(update.reportHash).toMatch(/^[a-f0-9]{64}$/);
		expect(update.status).toBe('accepted_by_lead');
		const leadDecisions = Object.values(approval.groups).flatMap(group => Object.entries(group.decisions))
			.filter(([, decision]) => decision.provenance === 'lead_translation').map(([id]) => id);
		expect(update.units.sort()).toEqual(leadDecisions.sort());
		if (locale === 'ga') {
			expect(update.uncertainties.join(' ')).toContain('best effort');
			expect(update.uncertainties.join(' ')).toContain('tócain téacs');
		}
	});

	it.each(instructionLocales)('keeps pending English placeholders outside translation approvals for %s', locale => {
		for (const unit of pendingUnits) {
			expect(unit.status).toBe('english_placeholder');
			const source = catalogPart(unit.definition.file)[unit.id];
			const target = catalogPart(unit.definition.file.replace('/en/', `/${locale}/`))[unit.id];
			if (messageDefinition(unit.id).kind === 'plural') {
				for (const [category, value] of Object.entries(target)) expect(value).toBe((source as Record<string, string>)[category] ?? (source as Record<string, string>).other);
			} else expect(target).toEqual(source);
			expect(reviewedUnits.some(reviewed => reviewed.id === unit.id)).toBe(false);
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
			const definition = messageDefinition(unit.id);
			const variants = definition.kind !== 'text' ? Object.values(entry as Record<string, string>) : [entry as string];
			if (definition.kind === 'plural') expect(Object.keys(entry).sort(), unit.id).toEqual([...categories].sort());
			if (definition.kind === 'select') expect(Object.keys(entry).sort(), unit.id).toEqual([...definition.variants].sort());
			for (const template of variants) {
				for (const token of unit.protectedTokens) expect(template, `${locale}:${unit.id}:${token}`).toContain(token);
				const parameters = [...template.matchAll(/{{([^{}]+)}}/g)].map((match) => match[1]);
				const required = definition.parameters.filter((name) => definition.kind !== 'select' || name !== definition.select || parameters.includes(name));
				expect([...new Set(parameters)].sort(), unit.id).toEqual([...required].sort());
			}
			if (definition.kind === 'select') {
				for (const variant of definition.variants) {
					const parameters = Object.fromEntries(definition.parameters.map((name) => [name, name === definition.select ? variant : `opaque:{{${name}}}`]));
					const result = context.formatDescriptor({ key: unit.id, parameters } as Parameters<typeof context.formatDescriptor>[0]);
					const template = (entry as Record<string, string>)[variant]!;
					expect(result, `${locale}:${unit.id}:${variant}`).toBe(template.replace(/{{([^{}]+)}}/g, (_match, name: string) => parameters[name]!));
				}
				continue;
			}
			if (definition.kind === 'text') {
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


describe('Markdown result catalog document', () => {
	it('lists each result key with its catalog and callers', () => {
		const document = readFileSync(`${root}/docs/tool-result-markdown-catalog.md`, 'utf8');
		for (const unit of units.filter(unit => unit.id.startsWith('result.'))) {
			const row = document.split('\n').find(line => line.startsWith(`| \`${unit.id}\` |`));
			expect(row, unit.id).toBeDefined();
			expect(row).toContain(unit.definition.file.replace('workers/agent-runtime/src/localization/en/', ''));
			for (const sink of unit.sinks) expect(row).toContain(sink.file.replace('workers/agent-runtime/src/', ''));
		}
	});
});
