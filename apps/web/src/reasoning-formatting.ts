import type { AgentLogReasoningPart } from '@bickr/shared/model';
import { classifiedReasoningPart, readablePartIdentity } from './agent-log-partial';

export type ReasoningDetailDisplay =
	| { kind: 'text'; text: string; index?: number }
	| { kind: 'summary'; text: string; index?: number }
	| { kind: 'encrypted' }
	| { kind: 'unknown' };

export function reasoningOpaqueCountsForDisplay(details: readonly unknown[]) {
	let encryptedParts = 0;
	let opaqueParts = 0;
	for (const detail of details) {
		const type = recordValue(detail).type;
		if (type === 'reasoning.text' || type === 'reasoning.summary') continue;
		opaqueParts++;
		if (type === 'reasoning.encrypted') encryptedParts++;
	}
	return { encryptedParts, opaqueParts };
}

export function settledReasoningHasOnlySummaries(reasoning: string, details: readonly unknown[]): boolean {
	let summaries = '';
	for (const detail of details) {
		const record = recordValue(detail);
		if (record.type === 'reasoning.text') return false;
		if (record.type !== 'reasoning.summary') continue;
		const value = record.summary ?? record.text;
		if (typeof value === 'string') summaries += value;
		else if (Array.isArray(value)) summaries += value.map(item => {
			if (typeof item === 'string') return item;
			const piece = recordValue(item);
			return typeof piece.text === 'string' ? piece.text : typeof piece.summary === 'string' ? piece.summary : '';
		}).join('');
	}
	// Certified text includes every readable source. Text beyond summaries needs the general label.
	return summaries.length > 0 && reasoning === summaries;
}

export function reasoningDetailForDisplay(detail: unknown): ReasoningDetailDisplay {
	const record = recordValue(detail);
	const index = typeof record.index === 'number' && Number.isSafeInteger(record.index) && record.index >= 0 ? { index: record.index } : {};
	switch (record.type) {
		case 'reasoning.text':
			return { ...index, kind: 'text', text: textValueForDisplay(record.text) ?? textValueForDisplay(record.content) ?? '' };
		case 'reasoning.summary':
			return { ...index, kind: 'summary', text: reasoningSummaryTextForDisplay(record.summary ?? record.text) ?? '' };
		case 'reasoning.encrypted':
			return { kind: 'encrypted' };
		default:
			return { kind: 'unknown' };
	}
}

type OrderedReasoningPart =
	| { kind: 'plain' | 'text' | 'summary'; text: string; identity: string }
	| { kind: 'encrypted' | 'unknown' };

function joinConsecutiveParts(parts: OrderedReasoningPart[]): OrderedReasoningPart[] {
	const joined: OrderedReasoningPart[] = [];
	for (const part of parts) {
		const last = joined.at(-1);
		if ('text' in part && last && 'text' in last && part.identity === last.identity) {
			joined[joined.length - 1] = { ...last, text: last.text + part.text };
		} else joined.push(part);
	}
	return joined;
}

function orderedReasoningForDisplay(input: OrderedReasoningPart[]) {
	const consecutive = joinConsecutiveParts(input);
	const repeatedDetails = new Set<number>();
	const unique = consecutive.filter((part, index) => {
		if (part.kind !== 'plain' || !part.text) return true;
		// Remove only a whole plain run that an adjacent readable detail repeats.
		for (const adjacent of [index + 1, index - 1]) {
			const detail = consecutive[adjacent];
			if (detail && (detail.kind === 'text' || detail.kind === 'summary') && detail.text === part.text && !repeatedDetails.has(adjacent)) {
				repeatedDetails.add(adjacent);
				return false;
			}
		}
		return true;
	});
	const parts = joinConsecutiveParts(unique);
	return {
		text: parts.flatMap(part => 'text' in part && part.text ? [normalizeReadableText(part.text)] : []).join('\n\n'),
		hasText: parts.some(part => (part.kind === 'plain' || part.kind === 'text') && part.text.length > 0),
		hasSummary: parts.some(part => part.kind === 'summary' && part.text.length > 0),
		encryptedParts: parts.filter(part => part.kind === 'encrypted').length,
		opaqueParts: parts.filter(part => part.kind === 'encrypted' || part.kind === 'unknown').length,
	};
}

export function reasoningDetailsForDisplay(details: unknown[]) {
	return orderedReasoningForDisplay(details.map(value => {
		const part = reasoningDetailForDisplay(value);
		if (part.kind !== 'text' && part.kind !== 'summary') return part;
		const detail = recordValue(value);
		const identity = readablePartIdentity({ kind: 'readable', type: part.kind === 'text' ? 'reasoning.text' : 'reasoning.summary', text: part.text,
			...(part.index !== undefined ? { index: part.index } : {}), ...(typeof detail.id === 'string' ? { id: detail.id } : {}) });
		return { ...part, identity: JSON.stringify([identity, detail.format ?? null]) };
	}));
}

export function reasoningPartsForDisplay(values: readonly AgentLogReasoningPart[]) {
	return orderedReasoningForDisplay(values.map(value => {
		const part = classifiedReasoningPart(value);
		switch (part.kind) {
			case 'text': return { kind: 'plain', text: part.text, identity: 'plain' };
			case 'readable': return { kind: part.type === 'reasoning.text' ? 'text' : 'summary', text: part.text, identity: JSON.stringify([readablePartIdentity(part), null]) };
			case 'opaque': return { kind: part.type === 'reasoning.encrypted' ? 'encrypted' : 'unknown' };
		}
	}));
}

export function reasoningDetailsTextForDisplay(details: unknown[]): string {
	return reasoningDetailsForDisplay(details).text;
}

function reasoningSummaryTextForDisplay(summary: unknown): string | undefined {
	const direct = textValueForDisplay(summary);
	if (direct !== undefined) {
		return direct;
	}
	if (!Array.isArray(summary)) {
		return undefined;
	}
	const text = summary.map((item) => {
		const itemText = textValueForDisplay(item);
		if (itemText !== undefined) {
			return itemText;
		}
		const record = recordValue(item);
		return textValueForDisplay(record.text) ?? textValueForDisplay(record.summary) ?? "";
	}).join("");
	return text.length > 0 ? normalizeReadableText(text) : undefined;
}

export function textValueForDisplay(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value.length > 0 ? normalizeReadableText(value) : undefined;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const text = (value as { text?: unknown }).text;
		if (typeof text === "string") {
			return text.length > 0 ? normalizeReadableText(text) : undefined;
		}
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

export function normalizeReadableText(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n");
	return normalized
		.split(/(\n{2,})/)
		.map((part) => part.startsWith("\n") ? part : collapseTinyLineRun(part))
		.join("");
}

function collapseTinyLineRun(text: string): string {
	const lines = text.split("\n");
	const meaningful = lines.filter((line) => line.trim().length > 0);
	if (meaningful.length < 6) {
		return text;
	}
	const lengths = meaningful.map((line) => Array.from(line.trim()).length);
	const shortCount = lengths.filter((length) => length <= 6).length;
	const veryShortCount = lengths.filter((length) => length <= 3).length;
	const averageLength = lengths.reduce((total, length) => total + length, 0) / lengths.length;
	const mostlyTiny =
		shortCount / lengths.length >= 0.75 &&
		veryShortCount >= 4 &&
		averageLength <= 6;
	const heavilyFragmented =
		meaningful.length >= 10 &&
		shortCount / lengths.length >= 0.6 &&
		averageLength <= 8;
	return mostlyTiny || heavilyFragmented ? lines.join("") : text;
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
