import { agentLogReasoningDetailKey, type AgentLogReasoningPart } from '@bickr/shared/model';
import { normalizeReadableText, orderedReasoningForDisplay, reasoningPartsForDisplay } from '@bickr/shared/reasoning-formatting';
import { readablePartIdentity } from './agent-log-partial';
export { normalizeReadableText, reasoningPartsForDisplay } from '@bickr/shared/reasoning-formatting';

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
	const parts: AgentLogReasoningPart[] = [];
	const opaqueKeys = new Set<string>();
	for (const detail of details) {
		const record = recordValue(detail);
		if (record.type === 'reasoning.text') return false;
		const identity = {
			...(typeof record.index === 'number' && Number.isSafeInteger(record.index) ? { index: record.index } : {}),
			...(typeof record.id === 'string' ? { id: record.id } : {}),
		};
		if (record.type !== 'reasoning.summary') {
			const part = { kind: 'opaque' as const, type: typeof record.type === 'string' ? record.type : null, ...identity };
			const key = agentLogReasoningDetailKey(part);
			if (key === null || !opaqueKeys.has(key)) parts.push(part);
			if (key !== null) opaqueKeys.add(key);
			continue;
		}
		const value = record.summary ?? record.text;
		const text = typeof value === 'string' ? value : Array.isArray(value) ? value.map(item => {
			if (typeof item === 'string') return item;
			const piece = recordValue(item);
			return typeof piece.text === 'string' ? piece.text : typeof piece.summary === 'string' ? piece.summary : '';
		}).join('') : '';
		parts.push({ kind: 'readable', type: 'reasoning.summary', text, ...identity });
	}
	const summaries = reasoningPartsForDisplay(parts, text => text).text;
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

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
