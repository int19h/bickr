import type { AgentLogReasoningPart } from '@bickr/shared/model';
import { classifiedReasoningPart, readablePartIdentity } from './agent-log-partial';

export type ReasoningDetailDisplay =
	| { kind: 'text' | 'summary'; text: string; index?: number }
	| { kind: 'encrypted' | 'unknown' };

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

export function reasoningDetailsForDisplay(details: unknown[]) {
	const parts = details.map(reasoningDetailForDisplay);
	const streams = new Map<string, string>();
	for (const [position, part] of parts.entries()) {
		if (part.kind !== 'text' && part.kind !== 'summary') continue;
		const detail = recordValue(details[position]);
		// Missing indices identify the default stream. Keep distinct IDs and formats apart.
		const identity = JSON.stringify([part.kind, part.index ?? null, detail.id ?? null, detail.format ?? null]);
		streams.set(identity, (streams.get(identity) ?? '') + part.text);
	}
	return {
		text: [...streams.values()].map(normalizeReadableText).filter(Boolean).join('\n\n'),
		hasText: parts.some(part => part.kind === 'text' && part.text.length > 0),
		hasSummary: parts.some(part => part.kind === 'summary' && part.text.length > 0),
		encryptedParts: parts.filter(part => part.kind === 'encrypted').length,
		opaqueParts: parts.filter(part => part.kind === 'encrypted' || part.kind === 'unknown').length,
	};
}

export function reasoningPartsForDisplay(values: readonly AgentLogReasoningPart[]) {
	const classified = values.map(classifiedReasoningPart);
	// Providers can repeat detail text in plain deltas. Use the completed-card rule.
	const parts = classified.some(part => part.kind !== 'text') ? classified.filter(part => part.kind !== 'text') : classified;
	const chunks: Array<{ key: string; text: string }> = [];
	let lastKey: string | null = null;
	for (const part of parts) {
		if (part.kind === 'opaque') { lastKey = null; continue; }
		const key = part.kind === 'text' ? 'plain' : readablePartIdentity(part);
		const last = chunks.at(-1);
		if (last && key === lastKey) last.text += part.text;
		else chunks.push({ key, text: part.text });
		lastKey = key;
	}
	return {
		text: chunks.map(part => normalizeReadableText(part.text)).filter(Boolean).join('\n\n'),
		hasText: parts.some(part => part.kind === 'text' && part.text.length > 0 || part.kind === 'readable' && part.type === 'reasoning.text' && part.text.length > 0),
		hasSummary: parts.some(part => part.kind === 'readable' && part.type === 'reasoning.summary' && part.text.length > 0),
		encryptedParts: parts.filter(part => part.kind === 'opaque' && part.type === 'reasoning.encrypted').length,
		opaqueParts: parts.filter(part => part.kind === 'opaque').length,
	};
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
