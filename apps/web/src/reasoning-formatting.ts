import { normalizeReadableText } from '@bickr/shared/reasoning-formatting';
export { normalizeReadableText, reasoningPartsForDisplay } from '@bickr/shared/reasoning-formatting';

export function reasoningDetailsTextForDisplay(details: unknown[]): string {
	return normalizeReadableText(details.map(reasoningDetailTextForDisplay).join(""));
}

function reasoningDetailTextForDisplay(detail: unknown): string {
	if (typeof detail === "string") {
		return detail;
	}
	const record = recordValue(detail);
	return textValueForDisplay(record.text) ??
		textValueForDisplay(record.content) ??
		textValueForDisplay(record.reasoning) ??
		reasoningSummaryTextForDisplay(record.summary) ??
		"";
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
