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
			return { ...index, kind: 'summary', text: reasoningSummaryTextForDisplay(record.summary) ?? '' };
		case 'reasoning.encrypted':
			return { kind: 'encrypted' };
		default:
			return { kind: 'unknown' };
	}
}

export function reasoningDetailsForDisplay(details: unknown[]) {
	const parts = details.map(reasoningDetailForDisplay);
	const readable: Array<Extract<ReasoningDetailDisplay, { text: string }>> = [];
	for (const part of parts) {
		if (part.kind !== 'text' && part.kind !== 'summary') continue;
		const previous = readable.at(-1);
		// Stream fragments share an index. Join them before separating distinct parts.
		if (part.index !== undefined && previous?.kind === part.kind && previous.index === part.index) previous.text += part.text;
		else readable.push({ ...part });
	}
	return {
		text: readable.map(part => normalizeReadableText(part.text)).filter(Boolean).join('\n\n'),
		hasText: parts.some(part => part.kind === 'text' && part.text.length > 0),
		hasSummary: parts.some(part => part.kind === 'summary' && part.text.length > 0),
		encryptedParts: parts.filter(part => part.kind === 'encrypted').length,
		opaqueParts: parts.filter(part => part.kind === 'encrypted' || part.kind === 'unknown').length,
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
